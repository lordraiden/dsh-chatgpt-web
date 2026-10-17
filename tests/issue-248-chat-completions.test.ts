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
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";

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
 * It keeps the whole parsed request, not only the messages: the proof that a dropped capability was
 * never forwarded has to look at everything the adapter could have seen, not just the transcript.
 *
 * It also records the identity the adapter resolves for the turn (`threadId`, and the conversation
 * key derived from it through the provider's own owner) so the isolation/continuity proofs assert
 * what the adapter really resolved, not what the surface claims it sent.
 *
 * With no `usage` argument it reports none — the state of an adapter that cannot account for the turn
 * — which is the case that used to surface as a fabricated `{0,0,0}` block.
 */
const TEST_NAMESPACE = "issue-248-namespace";
const TEST_AFFINITY = { providerId: "chatgpt-web", bindingId: "issue-248-binding" } as const;

interface StubTurn {
  messages: unknown[];
  request: unknown;
  identity: ReturnType<typeof extractChatGptTurnIdentity>;
  conversationKey: string | undefined;
}

function stubAdapter(usage?: Record<string, unknown>) {
  const turns: StubTurn[] = [];
  return {
    turns,
    factory: () => ({
      name: "issue-248-stub",
      runTurn: async (parsed: { context?: { messages?: unknown[] } }, _incoming: unknown, emit: (event: unknown) => void) => {
        turns.push({
          messages: parsed.context?.messages ?? [],
          request: parsed,
          identity: extractChatGptTurnIdentity(parsed as never),
          conversationKey: chatGptConversationKey(parsed as never, TEST_NAMESPACE, TEST_AFFINITY),
        });
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
    // A stateless caller's conversation identity is derived from the message content, never from the
    // request: it is stable for identical content and distinct for different content (see below).
    expect(translation.conversationIdentity).toMatch(/^dsh-chat-[0-9a-f]{16}$/);
    expect(translation.body).toEqual({
      model: "chatgpt-web/luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] }],
      stream: false,
      temperature: 0.4,
      max_output_tokens: 256,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: translation.conversationIdentity }),
      },
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
    // The caller's own identity is the conversation identity, verbatim: it is what isolates it from
    // every other caller and what gives it continuity across turns.
    expect(translation.conversationIdentity).toBe("harness-session-1");
    expect(translation.body.client_metadata).toEqual({
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "harness-session-1" }),
    });
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

  test("content features are refused through the common layer's own vocabulary", () => {
    const base = { model: "chatgpt-web/luna", messages: [USER_MESSAGE] };
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["n > 1", { n: 2 }, /`n` greater than 1/],
      ["logprobs", { logprobs: true }, /logprobs/],
      ["response_format json", { response_format: { type: "json_object" } }, /plain text/],
    ];
    for (const [label, extra, pattern] of cases) {
      expect(() => translateChatCompletionsRequest({ ...base, ...extra })).toThrow(pattern);
      void label;
    }

    // Attached content is data the model was meant to see: dropping it would be silent content loss,
    // so the refusal is the guard that stops "drop capability declarations" from becoming "drop
    // attachments". It is unchanged and unconditional.
    for (const [extra, pattern] of [
      [{ files: [{ id: "f" }] }, /files/],
      [{ images: [{ url: "x" }] }, /images/],
      [{ audio: { data: "x" } }, /audio/],
      [{ video: { url: "x" } }, /video/],
      [{ attachments: [{ id: "a" }] }, /attachments/],
    ] as const) {
      expect(() => translateChatCompletionsRequest({ ...base, ...extra })).toThrow(pattern);
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

  test("capability declarations are dropped and declared, never refused and never forwarded", () => {
    const base = { model: "chatgpt-web/luna", messages: [USER_MESSAGE] };
    const tools = [{ type: "function", function: { name: "read_file" } }];

    // The canonical vocabulary is named back to the caller; the legacy aliases fold into it.
    expect(translateChatCompletionsRequest({ ...base, tools }).droppedCapabilities).toEqual(["tools"]);
    expect(translateChatCompletionsRequest({ ...base, tools, tool_choice: "auto" }).droppedCapabilities)
      .toEqual(["tools", "toolChoice"]);
    expect(translateChatCompletionsRequest({ ...base, mcp: { servers: ["s"] } }).droppedCapabilities).toEqual(["mcp"]);
    expect(translateChatCompletionsRequest({ ...base, functions: [{ name: "f" }] }).droppedCapabilities).toEqual(["tools"]);
    expect(translateChatCompletionsRequest({ ...base, function_call: "auto" }).droppedCapabilities).toEqual(["toolChoice"]);
    // An empty slot carries nothing, so nothing is declared as dropped.
    expect(translateChatCompletionsRequest({ ...base, tools: [], mcp: {} }).droppedCapabilities).toEqual([]);

    // The internal turn is built from the projected messages only: no capability field is read, so
    // the declaration cannot travel to the provider even by accident.
    const translation = translateChatCompletionsRequest({ ...base, tools, tool_choice: "auto" });
    expect(translation.body).toEqual({
      model: "chatgpt-web/luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] }],
      stream: false,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: translation.conversationIdentity }),
      },
    });
    expect(JSON.stringify(translation.body)).not.toContain("read_file");
  });

  test("a tools-shaped content part stays a refusal: a capability policy never reaches message content", () => {
    // An unknown part type is not a capability declaration, it is content the layer cannot read.
    for (const part of [{ type: "tool_use", id: "t" }, { type: "tools", tools: [] }, { type: "mcp", server: "s" }]) {
      expect(() => translateChatCompletionsRequest({
        model: "chatgpt-web/luna",
        messages: [{ role: "user", content: [part] }],
      })).toThrow(ChatCompletionsRequestError);
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

  test("a capability declaration is dropped and declared, and the provider never sees it", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, {
      model: "chatgpt-web/luna",
      messages: [
        { role: "user", content: "hola" },
        // A harness replays its tool round: an assistant turn whose tool_calls are protocol state,
        // and the tool result the harness already used.
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file contents" },
        { role: "user", content: "y ahora?" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "auto",
    });

    // Dropping a capability is not a refusal: the turn runs as plain chat and says what it dropped.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBe("tools,toolChoice");
    const completion = await response.json() as Record<string, any>;
    expect(completion.choices[0].message.content).toBe("Respuesta del proveedor");

    // The proof that matters: nothing capability-shaped crossed to the provider — not the tool
    // declaration, not the assistant tool_calls, and not the role:"tool" message the projection drops.
    expect(stub.turns).toHaveLength(1);
    const sent = JSON.stringify(stub.turns[0]);
    expect(sent).not.toContain("read_file");
    expect(sent).not.toContain("tool_calls");
    expect(sent).not.toContain("file contents");
    expect(sent).toContain("y ahora?");

    // Nothing dropped means no declaration to make.
    const plain = await post(server, { model: "chatgpt-web/luna", messages: [USER_MESSAGE] });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-dsh-chatgpt-web-ignored-features")).toBeNull();
  });

  test("streaming declares the dropped capabilities on the SSE response too", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, {
      model: "chatgpt-web/luna",
      messages: [USER_MESSAGE],
      stream: true,
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBe("tools");
    await response.text();
    expect(stub.turns).toHaveLength(1);
    expect(JSON.stringify(stub.turns[0])).not.toContain("read_file");
  });

  test("a content feature is still a typed 400 with the exact message, and submits nothing", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }] }],
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.message).toBe("The WebChat common layer is text-only; unsupported request features: images.");
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBeNull();
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

/**
 * Slice 1 of the pre-vendor hardening programme — the caller's identity must reach the turn.
 *
 * The defect these tests pin: the surface computed the mode and the resolved session id and then built
 * the internal body from the messages only, so every caller without turn metadata collapsed onto the
 * constant `dsh-session` and shared ONE provider conversation. Two unrelated clients continued each
 * other's ChatGPT thread, and a dead surface answered `retained_surface_lost` for a client that never
 * had one.
 *
 * The proofs are behavioural, over the REAL listener with the stub adapter: what the adapter resolves
 * for the turn is the only thing that matters, not what the surface says it sent.
 */
describe("issue #248 — the caller's identity reaches the turn", () => {
  const say = (server: RunningServer, body: Record<string, unknown>) => post(server, body);

  test("no identity: different content is isolated, identical content is one continuous conversation", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    await say(server, { model: "chatgpt-web/luna", messages: [{ role: "user", content: "alpha" }] });
    await say(server, { model: "chatgpt-web/luna", messages: [{ role: "user", content: "beta" }] });
    // The same request again — a resending client, or a retry the client chose to make.
    await say(server, { model: "chatgpt-web/luna", messages: [{ role: "user", content: "alpha" }] });
    // A second, unrelated caller that happens to send content identical to the first one.
    await say(server, { model: "chatgpt-web/luna", messages: [{ role: "user", content: "alpha" }] });

    expect(stub.turns).toHaveLength(4);
    const [alpha, beta, alphaAgain, otherCaller] = stub.turns;

    // ISOLATION: different content, no identity → different conversations at the adapter.
    expect(alpha!.identity.threadId).not.toBe(beta!.identity.threadId);
    expect(alpha!.conversationKey).not.toBe(beta!.conversationKey);
    // NO PER-REQUEST MINTING: the identical request resolves to the SAME conversation, so a resending
    // client keeps continuity instead of forking a new provider conversation on every turn.
    expect(alphaAgain!.identity.threadId).toBe(alpha!.identity.threadId);
    expect(alphaAgain!.conversationKey).toBe(alpha!.conversationKey);
    // DOCUMENTED LIMIT, asserted rather than implied: with no identity and identical content the two
    // callers are indistinguishable, so they deliberately share one conversation. Nothing in the
    // request can tell them apart; a caller that must be distinct has to send `user`/`session_id`.
    expect(otherCaller!.identity.threadId).toBe(alpha!.identity.threadId);
    expect(otherCaller!.conversationKey).toBe(alpha!.conversationKey);

    // The constant that fused everyone is gone from this surface entirely.
    for (const turn of stub.turns) {
      expect(turn.identity.threadId).not.toBe("dsh-session");
      expect(turn.identity.threadId).toMatch(/^dsh-chat-[0-9a-f]{16}$/);
      expect(turn.conversationKey).toBeTruthy();
    }
  });

  test("an explicit identity is the caller's own conversation, stable across changed history", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    // First turn of a session.
    await say(server, {
      model: "chatgpt-web/luna",
      user: "harness-session-1",
      messages: [{ role: "user", content: "one" }],
    });
    // Second turn of the SAME session: the client resends a revolved history.
    await say(server, {
      model: "chatgpt-web/luna",
      user: "harness-session-1",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "uno" },
        { role: "user", content: "two" },
      ],
    });
    // A different caller, and the `session_id` extension spelling of the same field.
    await say(server, {
      model: "chatgpt-web/luna",
      session_id: "harness-session-2",
      messages: [{ role: "user", content: "one" }],
    });

    expect(stub.turns).toHaveLength(3);
    const [first, second, other] = stub.turns;

    // CONTINUITY: the caller's own identity is the conversation, across changed history.
    expect(first!.identity.threadId).toBe("harness-session-1");
    expect(second!.identity.threadId).toBe("harness-session-1");
    expect(second!.conversationKey).toBe(first!.conversationKey);
    // ISOLATION: a second caller with identical content is still a different conversation, because it
    // sent its own identity.
    expect(other!.identity.threadId).toBe("harness-session-2");
    expect(other!.conversationKey).not.toBe(first!.conversationKey);
    // An explicit identity is never the content-derived namespace.
    expect(first!.identity.threadId).not.toMatch(/^dsh-chat-/);
  });

  test("the identity never becomes provider-visible message text", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    await say(server, {
      model: "chatgpt-web/luna",
      user: "harness-session-1",
      messages: [{ role: "user", content: "hola" }],
    });
    await say(server, {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "sin identidad" }],
    });

    expect(stub.turns).toHaveLength(2);
    const [identified, stateless] = stub.turns;

    // The message-only contract still holds: the identity travels as request metadata, never as text
    // the model could read. Neither the caller's id nor the metadata field appears in a message.
    const identifiedText = JSON.stringify(identified!.messages);
    expect(identifiedText).not.toContain("harness-session-1");
    expect(identifiedText).not.toContain("x-codex-turn-metadata");
    expect(identifiedText).toContain("hola");

    const statelessText = JSON.stringify(stateless!.messages);
    expect(statelessText).not.toContain(stateless!.identity.threadId!);
    expect(statelessText).not.toContain("x-codex-turn-metadata");
    expect(statelessText).toContain("sin identidad");
  });
});

/**
 * Slice 2 of the pre-vendor hardening programme — the *other* door: `/v1/responses`.
 *
 * Slice 1 stopped `/v1/chat/completions` collapsing every metadata-less caller onto the constant
 * `dsh-session`. `/v1/responses` reaches the same `extractChatGptTurnIdentity` but never passes through
 * the chat surface's translation, so its own metadata-less fallback still produced that constant: two
 * unrelated Responses callers shared ONE provider conversation. The fallback now calls the SAME
 * content-identity owner slice 1 introduced (`contentConversationIdentity`), so the properties are the
 * same: stable for identical content, distinct for different content, never per request.
 *
 * The proofs are behavioural, over the REAL listener with the stub adapter, because the adapter's
 * resolved identity is the only thing that matters — plus one unit assertion for the native DSH path,
 * which cannot be reached over HTTP and must not change.
 */
describe("issue #248 — the Responses surface gives every caller its own conversation too", () => {
  const responsesRequest = (text: string, extra: Record<string, unknown> = {}) => ({
    model: "chatgpt-web/luna",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    ...extra,
  });
  const say = (server: RunningServer, body: Record<string, unknown>) =>
    post(server, body, "/v1/responses");

  test("no identity: different content is isolated, identical content is the same conversation", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    await say(server, responsesRequest("alpha"));
    await say(server, responsesRequest("beta"));
    // The identical request again: a resending client, or a retry the client chose to make.
    await say(server, responsesRequest("alpha"));

    expect(stub.turns).toHaveLength(3);
    const [alpha, beta, alphaAgain] = stub.turns;

    // The constant that fused every Responses caller is gone from this surface.
    expect(alpha!.identity.threadId).toMatch(/^dsh-chat-[0-9a-f]{16}$/);
    for (const turn of stub.turns) {
      expect(turn.identity.threadId).not.toBe("dsh-session");
      expect(turn.conversationKey).toBeTruthy();
    }
    // ISOLATION: different content, no identity → different provider conversations.
    expect(alpha!.identity.threadId).not.toBe(beta!.identity.threadId);
    expect(alpha!.conversationKey).not.toBe(beta!.conversationKey);
    // NO PER-REQUEST MINTING: identical content keeps its conversation, so a resend does not fork one.
    expect(alphaAgain!.identity.threadId).toBe(alpha!.identity.threadId);
    expect(alphaAgain!.conversationKey).toBe(alpha!.conversationKey);
  });

  test("a caller that provides a thread keeps it, and the native DSH thread is untouched", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    await say(server, responsesRequest("alpha", {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "client-thread-9" }) },
    }));

    expect(stub.turns).toHaveLength(1);
    // A caller-chosen thread is used verbatim: the fallback is the only thing this change moves.
    expect(stub.turns[0]!.identity.threadId).toBe("client-thread-9");
    expect(stub.turns[0]!.identity.threadId).not.toMatch(/^dsh-chat-/);

    // The native Codex / DSH path carries its own thread identity and never consults the fallback.
    const nativeDshTurn = {
      modelId: "gpt-5.6-luna",
      context: { systemPrompt: [], messages: [] },
      stream: false,
      options: {},
      _dshContext: { dshSessionId: "dsh-session-1", threadId: "native-thread-1", turnId: "turn-1" },
    } as unknown as Parameters<typeof extractChatGptTurnIdentity>[0];
    expect(extractChatGptTurnIdentity(nativeDshTurn)).toEqual({
      dshSessionId: "dsh-session-1",
      threadId: "native-thread-1",
      turnId: "turn-1",
    });
  });
});
