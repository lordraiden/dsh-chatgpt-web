import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";

/**
 * The `usage` contract of the OpenAI-compatible surface.
 *
 * `usage` is a local estimate (tiktoken, `src/adapters/chatgpt-web/usage.ts`) that the ChatGPT Web
 * adapter attaches to the turns it can measure. The adapter-agnostic reshaping seams — `responsesUsage`
 * in `src/bridge.ts` and `chatUsage` in `src/responses/chat-completions.ts` — used to turn "the adapter
 * reported no usage" into `{input_tokens: 0, output_tokens: 0, total_tokens: 0}`. A client that bills,
 * logs or compares reads that as a measurement, and it is wrong.
 *
 * The rule pinned here, at the real listener and through the real reshaping code: a usage block exists
 * only when the turn actually produced one. When it did not, the JSON body omits the field and the SSE
 * response envelope carries `null` — never a fabricated zero block. A zero the adapter really reported
 * is a number, and it is preserved.
 */
const CONTROL_TOKEN = "usage-reporting-contract-control-token-0123456789";

let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
});

const running: RunningServer[] = [];
afterEach(async () => {
  if (previousApiKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
  else process.env.DSH_CHATGPT_WEB_API_KEY = previousApiKey;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function makeConfig() {
  return { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN };
}

/**
 * What the provider reports for the turn:
 * - `measured` — the shape the real ChatGPT Web adapter emits (`estimateChatGptWebUsage`);
 * - `unmeasured` — a clean `done` with no usage: an adapter that cannot account for the turn;
 * - `failed` — an `error` event with no usage: a turn that died before it could be measured;
 * - `eof` — no terminal event at all: the truncated `adapter_eof` path.
 */
type ProviderReport = "measured" | "unmeasured" | "failed" | "eof";

function serve(report: ProviderReport, usage?: Record<string, unknown>): RunningServer {
  const factory = () => ({
    name: `usage-contract-${report}`,
    runTurn: async (_parsed: unknown, _incoming: unknown, emit: (event: unknown) => void) => {
      emit({ type: "text_delta", text: "hola", phase: "final_answer" });
      if (report === "eof") return;
      if (report === "failed") {
        emit({ type: "error", message: "the browser stage failed", status: 502, errorType: "upstream_error" });
        return;
      }
      emit({
        type: "done", stopReason: "stop", endTurn: true,
        ...(usage ? { usage } : {}),
      });
    },
  }) as never;
  const server = startServer(makeConfig() as never, { adapterFactory: factory } as never);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;

/** The complete native Codex body the ChatGPT Web route requires (see doc/container.md §6). */
const NATIVE_BODY = {
  model: "chatgpt-web/luna",
  instructions: "You are a helpful assistant.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
};

const postResponses = (server: RunningServer, body: unknown = NATIVE_BODY) =>
  fetch(url(server, "/v1/responses"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const postChat = (server: RunningServer, body: unknown = { model: "chatgpt-web/luna", messages: [{ role: "user", content: "hola" }] }) =>
  fetch(url(server, "/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The `response` object of one named SSE frame, parsed from the raw stream bytes. */
async function sseResponse(server: RunningServer, marker: string): Promise<Record<string, unknown>> {
  const response = await postResponses(server, { ...NATIVE_BODY, stream: true });
  const text = await response.text();
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find(candidate => candidate.startsWith("data: "));
    if (!line || !frame.includes(marker)) continue;
    const event = JSON.parse(line.slice("data: ".length)) as { response?: Record<string, unknown> };
    return event.response ?? {};
  }
  throw new Error(`no ${marker} frame in the stream`);
}

describe("usage is omitted, never fabricated, when the turn reported none", () => {
  test("/v1/responses (batch) omits the key and still answers the turn", async () => {
    const server = serve("unmeasured");
    const response = await postResponses(server);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0].text).toBe("hola");
    expect("usage" in body).toBe(false);
  });

  test("/v1/responses (batch) omits the key on a failed turn, keeping the failure shape", async () => {
    const server = serve("failed");
    const response = await postResponses(server);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.status).toBe("failed");
    expect(body.error.message).toBe("the browser stage failed");
    expect("usage" in body).toBe(false);
  });

  test("/v1/responses (SSE) reports unknown usage as null, not as a zero block", async () => {
    const server = serve("unmeasured");
    const completed = await sseResponse(server, "response.completed");
    expect("usage" in completed).toBe(true);
    expect(completed.usage).toBeNull();
  });

  test("/v1/responses (SSE) keeps null on the truncated adapter_eof path", async () => {
    const server = serve("eof");
    const incomplete = await sseResponse(server, "response.incomplete");
    expect((incomplete.incomplete_details as { reason?: string }).reason).toBe("adapter_eof");
    expect(incomplete.usage).toBeNull();
  });

  test("/v1/chat/completions omits the key for the same unmeasured turn", async () => {
    const server = serve("unmeasured");
    const response = await postChat(server);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.choices[0].message.content).toBe("hola");
    expect("usage" in body).toBe(false);
  });
});

describe("a usage the turn really produced is carried through unchanged", () => {
  const REPORTED = { inputTokens: 321, outputTokens: 12, totalTokens: 333 };
  const RENAMED = { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 };

  test("/v1/chat/completions renames the reported estimate", async () => {
    const server = serve("measured", REPORTED);
    const body = await (await postChat(server)).json() as Record<string, any>;
    expect(body.usage).toEqual(RENAMED);
  });

  test("/v1/responses (batch) keeps the reported estimate", async () => {
    const server = serve("measured", REPORTED);
    const body = await (await postResponses(server)).json() as Record<string, any>;
    expect(body.usage).toEqual({ input_tokens: 321, output_tokens: 12, total_tokens: 333 });
  });

  test("/v1/responses (SSE) keeps the reported estimate on the completed frame", async () => {
    const server = serve("measured", REPORTED);
    const completed = await sseResponse(server, "response.completed");
    expect(completed.usage).toEqual({ input_tokens: 321, output_tokens: 12, total_tokens: 333 });
  });

  test("an explicit zero is a report, not an unknown: it is preserved", async () => {
    const server = serve("measured", { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const body = await (await postChat(server)).json() as Record<string, any>;
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});
