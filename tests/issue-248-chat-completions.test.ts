import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import {
  buildOpenAiModelsData,
  ChatCompletionsRequestError,
  chatUsage,
  responseFailure,
  responseText,
  toChatCompletion,
  toChatCompletionStream,
  translateChatCompletionsRequest,
} from "../src/responses/chat-completions";
import { buildChatGptWebModelCatalog } from "../src/model-catalog";

/**
 * Issue #248 — the OpenAI-compatible surface.
 *
 * The unit half pins the translation (including every refused feature); the integration half runs the
 * REAL listener with a stub adapter, which is the only way to prove the two claims that matter: the
 * shape a stock client receives, and that nothing unsupported ever reaches the provider.
 */
const API_KEY = "issue-248-test-api-key-0123456789";
const CONTROL_TOKEN = "issue-248-test-control-token-0123456789";

const running: RunningServer[] = [];
afterEach(async () => {
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN, ...overrides };
}

/**
 * A stub provider that records exactly what it was asked to send, and answers with fixed text.
 *
 * With no `usage` argument it reports none — the state of an adapter that cannot account for the turn
 * — which is the case that used to surface as a fabricated `{0,0,0}` block.
 */
function stubAdapter(usage?: Record<string, unknown>) {
  const turns: Array<Record<string, unknown>> = [];
  return {
    turns,
    factory: () => ({
      name: "issue-248-stub",
      runTurn: async (parsed: { context?: { messages?: unknown[] } }, _incoming: unknown, emit: (event: unknown) => void) => {
        turns.push({ messages: parsed.context?.messages ?? [] });
        emit({ type: "text_delta", text: "Respuesta del proveedor", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true, ...(usage ? { usage } : {}) });
      },
    }) as never,
  };
}

function serve(adapterFactory: unknown): RunningServer {
  const server = startServer(makeConfig() as never, { adapterFactory } as never);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: RunningServer, body: unknown, path = "/v1/chat/completions") =>
  fetch(url(server, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const USER_MESSAGE = { role: "user", content: "hola" };

describe("issue #248 — the OpenAI request is translated, never re-executed", () => {
  test("a plain request becomes the internal turn, message-only", () => {
    const translation = translateChatCompletionsRequest({
      model: "chatgpt-web/luna",
      messages: [
        { role: "system", content: "You are Cline." },
        { role: "user", content: "hola" },
      ],
      temperature: 0.4,
      max_tokens: 256,
    });

    expect(translation.model).toBe("chatgpt-web/luna");
    expect(translation.stream).toBe(false);
    expect(translation.mode).toBe("stateless");
    expect(translation.droppedRoles).toEqual(["system"]);
    expect(translation.body).toEqual({
      model: "chatgpt-web/luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] }],
      stream: false,
      temperature: 0.4,
      max_output_tokens: 256,
    });
  });

  test("a session identity makes the translation carry only the current user message", () => {
    const translation = translateChatCompletionsRequest({
      model: "chatgpt-web/luna",
      user: "harness-session-1",
      messages: [
        { role: "system", content: "You are Cline. Environment: /srv/project" },
        { role: "user", content: "primer turno con contexto inyectado" },
        { role: "assistant", content: "vale" },
        { role: "user", content: "pregunta real" },
      ],
    });

    expect(translation.mode).toBe("session");
    expect(translation.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "pregunta real" }] },
    ]);
    // The harness's context never even reaches the internal body.
    expect(JSON.stringify(translation.body)).not.toContain("Contexto");
    expect(JSON.stringify(translation.body)).not.toContain("/srv/project");
  });

  test("multipart text content is joined; unknown part types are refused", () => {
    const translation = translateChatCompletionsRequest({
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
    });
    expect(translation.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "ab" }] },
    ]);

    expect(() => translateChatCompletionsRequest({
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: [{ type: "video_url", url: "x" }] }],
    })).toThrow(ChatCompletionsRequestError);
  });

  test("every unsupported feature is refused through the common layer's own vocabulary", () => {
    const base = { model: "chatgpt-web/luna", messages: [USER_MESSAGE] };
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["tools", { tools: [{ type: "function", function: { name: "f" } }] }, /tools/],
      ["tool_choice", { tool_choice: "auto" }, /toolChoice/],
      ["legacy functions", { functions: [{ name: "f" }] }, /tools/],
      ["legacy function_call", { function_call: "auto" }, /toolChoice/],
      ["n > 1", { n: 2 }, /`n` greater than 1/],
      ["logprobs", { logprobs: true }, /logprobs/],
      ["response_format json", { response_format: { type: "json_object" } }, /plain text/],
    ];
    for (const [label, extra, pattern] of cases) {
      expect(() => translateChatCompletionsRequest({ ...base, ...extra })).toThrow(pattern);
      void label;
    }

    for (const [part, pattern] of [
      [{ type: "image_url", image_url: { url: "http://x/y.png" } }, /images/],
      [{ type: "input_audio", input_audio: { data: "x" } }, /audio/],
      [{ type: "input_file", file_id: "f" }, /files/],
    ] as const) {
      expect(() => translateChatCompletionsRequest({
        model: "chatgpt-web/luna",
        messages: [{ role: "user", content: [part] }],
      })).toThrow(pattern);
    }
  });

  test("a malformed request is refused before any provider work", () => {
    expect(() => translateChatCompletionsRequest("nope")).toThrow(/JSON object/);
    expect(() => translateChatCompletionsRequest({ messages: [USER_MESSAGE] })).toThrow(/`model` is required/);
    expect(() => translateChatCompletionsRequest({ model: "m", messages: [] })).toThrow(/non-empty array/);
    expect(() => translateChatCompletionsRequest({ model: "m", messages: [{ role: "user" }] })).not.toThrow();
    expect(() => translateChatCompletionsRequest({ model: "m", messages: [{ content: "x" }] })).toThrow(/role is required/);
  });
});

describe("issue #248 — the OpenAI shape", () => {
  test("the model catalogue gains an additive, matching data array", () => {
    const catalog = buildChatGptWebModelCatalog(defaultConfig());
    const data = buildOpenAiModelsData(catalog as Record<string, unknown>);
    const models = (catalog as { models?: Array<{ slug?: string }> }).models ?? [];

    expect(data.length).toBe(models.length);
    expect(data.map((entry) => entry.id)).toEqual(models.map((entry) => entry.slug));
    for (const entry of data) {
      expect(entry.object).toBe("model");
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.owned_by).toBe("string");
    }
    // Junk in, nothing out: never a fabricated model id.
    expect(buildOpenAiModelsData({ models: [null, { slug: 7 }, { slug: "ok" }] })).toEqual([
      { id: "ok", object: "model", created: 0, owned_by: "dsh-chatgpt-web" },
    ]);
  });

  test("an internal payload becomes a chat.completion with usage and text", () => {
    const payload = {
      id: "resp_1",
      created_at: 1_700_000_000,
      output: [{ type: "message", content: [{ type: "output_text", text: "hola " }, { type: "output_text", text: "mundo" }] }],
      usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
    };
    expect(responseText(payload)).toBe("hola mundo");
    expect(responseFailure({ error: { message: "boom", code: "x" } })).toEqual({ message: "boom", code: "x" });
    expect(responseFailure({})).toBeUndefined();

    const completion = toChatCompletion(payload, "chatgpt-web/luna");
    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("chatgpt-web/luna");
    expect(completion.created).toBe(1_700_000_000);
    expect(completion.choices).toEqual([
      { index: 0, message: { role: "assistant", content: "hola mundo" }, finish_reason: "stop" },
    ]);
    expect(completion.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
  });

  test("an absent usage is omitted, and a reported zero is kept", () => {
    // No usage at all: the field is absent from the body. A `{0,0,0}` block would claim an accounting
    // the turn never produced, which a billing/logging client cannot tell apart from a real zero.
    const noUsage = toChatCompletion({ id: "resp_2", output: [], usage: null }, "chatgpt-web/luna");
    expect("usage" in noUsage).toBe(false);
    expect(chatUsage(undefined)).toBeUndefined();
    expect(chatUsage(null)).toBeUndefined();
    expect(chatUsage({})).toBeUndefined();
    expect(chatUsage({ input_tokens: 11 })).toBeUndefined();

    // A reported zero is a number, not an unknown: the turn is kept as the provider described it.
    expect(chatUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }))
      .toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    // The internal total is only trusted when present; otherwise the pair decides.
    expect(chatUsage({ input_tokens: 11, output_tokens: 5 }))
      .toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
  });

  test("an internal SSE stream is re-shaped into chat.completion.chunk events", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of [
          { type: "response.created" },
          { type: "response.output_text.delta", delta: "Ho" },
          { type: "response.output_text.delta", delta: "la" },
          { type: "response.completed" },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });

    const text = await new Response(toChatCompletionStream(upstream, "chatgpt-web/luna")).text();
    const frames = text.split("\n\n").filter((frame) => frame.startsWith("data:"));
    const payloads = frames.map((frame) => frame.slice("data:".length).trim());

    expect(payloads.at(-1)).toBe("[DONE]");
    const events = payloads.slice(0, -1).map((payload) => JSON.parse(payload));
    for (const event of events) {
      expect(event.object).toBe("chat.completion.chunk");
      expect(event.model).toBe("chatgpt-web/luna");
    }
    expect(events[0]!.choices[0]!.delta).toEqual({ role: "assistant", content: "" });
    const deltas = events.map((event) => event.choices[0]!.delta.content).filter(Boolean).join("");
    expect(deltas).toBe("Hola");
    expect(events.at(-1)!.choices[0]!.finish_reason).toBe("stop");
  });
});

describe("issue #248 — over the real listener", () => {
  test("a stock client gets a completion, and the provider saw only the conversation", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, {
      model: "chatgpt-web/luna",
      messages: [
        { role: "system", content: "You are Cline. <environment_details>file tree</environment_details>" },
        { role: "user", content: "Escribe un test" },
      ],
    });

    expect(response.status).toBe(200);
    const completion = await response.json() as Record<string, any>;
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0].message.content).toBe("Respuesta del proveedor");
    // This adapter reports no usage, so the field is absent — not a fabricated zero block. The old
    // `usage.total_tokens >= 0` assertion could not fail: every value satisfied it.
    expect("usage" in completion).toBe(false);

    // The proof that matters: the harness's own instructions never reached the provider.
    expect(stub.turns).toHaveLength(1);
    const sent = JSON.stringify(stub.turns[0]!.messages);
    expect(sent).not.toContain("You are Cline");
    expect(sent).not.toContain("environment_details");
    expect(sent).toContain("Escribe un test");
  });

  test("the usage a provider reports is translated, never re-derived", async () => {
    const stub = stubAdapter({ inputTokens: 321, outputTokens: 12, totalTokens: 333 });
    const server = serve(stub.factory);

    const response = await post(server, { model: "chatgpt-web/luna", messages: [USER_MESSAGE] });
    expect(response.status).toBe(200);
    const completion = await response.json() as Record<string, any>;
    expect(completion.usage).toEqual({ prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 });
  });

  test("streaming answers with chat.completion.chunk frames and a terminal [DONE]", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, { model: "chatgpt-web/luna", messages: [USER_MESSAGE], stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text).toContain("Respuesta del proveedor");
  });

  test("/v1/models satisfies both consumers: the Codex catalogue and the OpenAI data array", async () => {
    const server = serve(stubAdapter().factory);
    const catalog = await (await fetch(url(server, "/v1/models"))).json() as Record<string, any>;

    expect(catalog.object).toBe("list");
    expect(Array.isArray(catalog.models)).toBe(true);
    expect(Array.isArray(catalog.data)).toBe(true);
    expect(catalog.data.map((entry: { id: string }) => entry.id)).toEqual(
      catalog.models.map((entry: { slug: string }) => entry.slug),
    );
  });

  test("an unknown model is a typed 400 naming the accepted ids, and submits nothing", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, { model: "chatgpt-web/does-not-exist", messages: [USER_MESSAGE] });
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("chatgpt-web/luna");
    expect(stub.turns).toHaveLength(0);
  });

  test("a provider failure is an HTTP error, never a silently empty completion", async () => {
    const server = serve((() => ({
      name: "issue-248-failing",
      runTurn: async (_parsed: unknown, _incoming: unknown, emit: (event: unknown) => void) => {
        emit({ type: "error", message: "browser session lost", code: "browser_unavailable", status: 503, retryable: true });
      },
    })) as never);

    const response = await post(server, { model: "chatgpt-web/luna", messages: [USER_MESSAGE] });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).toContain("browser session lost");
  });

  test("a refused feature is a typed 400 and submits nothing", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, {
      model: "chatgpt-web/luna",
      messages: [USER_MESSAGE],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("tools");
    expect(stub.turns).toHaveLength(0);
  });

  test("the phase-3 authorization guard covers the new route", async () => {
    process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
    const stub = stubAdapter();
    const server = serve(stub.factory);

    expect((await post(server, { model: "chatgpt-web/luna", messages: [USER_MESSAGE] })).status).toBe(401);

    const authorized = await fetch(url(server, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: "chatgpt-web/luna", messages: [USER_MESSAGE] }),
    });
    expect(authorized.status).toBe(200);
  });
});
