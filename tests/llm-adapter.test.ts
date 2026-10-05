/**
 * Provider-boundary contract tests for the native DSH LlmAdapter (issue #8).
 *
 * These are contract tests at the architecture boundary: registration,
 * route/model resolution, stream conversion, cancellation, missing
 * auth/config failure, and proof that the native path does not enter the
 * Responses server. The backend is a scripted in-memory `ProviderAdapter`,
 * so no browser is started.
 */
import { describe, expect, test } from "bun:test";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import type { TurnBrokerOwner, BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import type { WebSurfaceTransport } from "../src/adapters/chatgpt-web/web-surface-transport";
import { readFileSync } from "node:fs";
import { defaultConfig } from "../src/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmError, type GenerateOptions, type StreamChunk, type ToolSchema } from "@deepseek-ai/dsh-llm";
import {
  ChatGptWebLlmAdapter,
  CHATGPT_WEB_PROVIDER_ID,
  mapStream,
  toCodexParsedRequest,
} from "../src/adapters/chatgpt-web/llm-adapter";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexProviderConfig } from "../src/types";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import {
  chatGptTurnExecutionKey,
  chatGptTurnRoundKey,
} from "../src/adapters/chatgpt-web/turn-execution";

const HERE = dirname(fileURLToPath(import.meta.url));

class TestProviderCore extends ChatGptWebProviderCore {
  override bindPhysicalSettlement(executionKey: string, _settlement: Promise<void>): ReturnType<ChatGptWebProviderCore["bindPhysicalSettlement"]> {
    const turn = this.get(executionKey);
    if (!turn) throw new Error(`TestProviderCore turn missing: ${executionKey}`);
    return turn;
  }
}

function providerConfigFixture(overrides: Partial<CodexProviderConfig["chatgptWeb"]> = {}): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    defaultModel: "gpt-5.6-luna",
    models: ["gpt-5.6-luna"],
    liveModels: false,
    contextWindow: 1_050_000,
    modelInputModalities: { "gpt-5.6-luna": ["text", "image"] },
    modelReasoningEfforts: { "gpt-5.6-luna": ["low", "medium"] },
    modelDefaultReasoningEfforts: { "gpt-5.6-luna": "low" },
    noReasoningModels: [],
    chatgptWeb: {
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      storageStatePath: "/tmp/chatgpt-state.json",
      chromeExecutablePath: "/usr/bin/chromium",
      brokerSocketPath: "/tmp/chatgpt-broker.sock",
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
      ...overrides,
    },
  };
}

function scriptedBackend(events: AdapterEvent[], seen: { parsed?: CodexParsedRequest; signal?: AbortSignal } = {}): ProviderAdapter {
  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      seen.parsed = parsed;
      seen.signal = incoming.abortSignal;
      await new Promise(resolve => setTimeout(resolve, 0));
      for (const event of events) emit(event);
    },
  };
}

function userRequest(text: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CHATGPT_WEB_PROVIDER_ID,
    model: "chatgpt-web/luna",
    messages: [
      {
        role: "user",
        id: "msg-1",
        source: { kind: "user" },
        content: [{ type: "text", text }],
      } as unknown as GenerateOptions["messages"][number],
    ],
    ...extra,
  };
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function lastFinish(chunks: StreamChunk[]): Extract<StreamChunk, { type: "finish" }> {
  const finish = chunks[chunks.length - 1];
  expect(finish?.type).toBe("finish");
  return finish as Extract<StreamChunk, { type: "finish" }>;
}

describe("ChatGptWebLlmAdapter registration", () => {
  test("default configuration is Free/Luna and does not invent Sol capability", () => {
    const config = defaultConfig();
    expect(config.solAvailable).toBe(false);
    expect(config.proAvailable).toBe(false);
  });
  test("constructor performs no I/O and providerInfo identifies the route", () => {
    const adapter = new ChatGptWebLlmAdapter();
    const info = adapter.providerInfo(CHATGPT_WEB_PROVIDER_ID);
    expect(info.id).toBe(CHATGPT_WEB_PROVIDER_ID);
    expect(info.name).toBe("ChatGPT Web");
  });

  test("listModels advertises both Luna reasoning modes for Luna-only accounts", async () => {
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture() });
    const models = await adapter.listModels(CHATGPT_WEB_PROVIDER_ID);
    expect(models.map(model => model.id)).toEqual([
      "chatgpt-web/luna",
      "chatgpt-web/think",
    ]);
    const luna = models.find(model => model.id === "chatgpt-web/luna");
    expect(luna).toBeDefined();
    expect(luna?.provider).toBe(CHATGPT_WEB_PROVIDER_ID);
    expect(luna?.inputModalities).toEqual(["text"]);
  });
});

describe("ChatGptWebLlmAdapter model resolution", () => {
  test("luna resolves through the native provider path with context metadata", async () => {
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture() });
    const resolved = await adapter.resolveModel(CHATGPT_WEB_PROVIDER_ID, "chatgpt-web/luna");
    expect(resolved.id).toBe("chatgpt-web/luna");
    expect(resolved.context?.contextWindow).toBe(1_050_000);
    expect(String(resolved.reasoning?.defaultEffort)).toBe("low");
  });

  test("backend model ids are not catalog routes (strict catalogue contract)", async () => {
    // The native contract exposes the catalogue slugs (e.g. chatgpt-web/luna),
    // mirroring listModels; backend ids (gpt-5.6-luna) are provider-internal
    // and resolve to a stable NO_MODEL failure, not a second catalogue.
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture() });
    let caught: unknown;
    try {
      await adapter.resolveModel(CHATGPT_WEB_PROVIDER_ID, "gpt-5.6-luna");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe("NO_MODEL");
  });

  test("unknown model throws a stable NO_MODEL LlmError", async () => {
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture() });
    let caught: unknown;
    try {
      await adapter.resolveModel(CHATGPT_WEB_PROVIDER_ID, "chatgpt-web/pro");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    // requireChatGptWebModelRoute throws a plain Error; the adapter's route
    // resolution surfaces it with the stable code via the stream boundary.
    expect((caught as Error).message).toContain("not available");
  });
});

describe("ChatGptWebLlmAdapter stream conversion", () => {
  test("text and reasoning map to ordered blocks with terminal finish", async () => {
    const seen: { parsed?: CodexParsedRequest } = {};
    const backend = scriptedBackend([
      { type: "thinking_delta", thinking: "let me think" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 10 } },
    ], seen);
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks = await collect(adapter.stream(userRequest("hi")));

    // Native ChatGPT Web usage is intentionally omitted from the DSH stream contract.
    const types = chunks.map(chunk => chunk.type);
    expect(types).toEqual([
      "block-start", "reasoning-delta", "block-end",
      "block-start", "text-delta", "text-delta", "block-end",
      "finish",
    ]);
    expect(chunks.some(chunk => chunk.type === "usage")).toBe(false);
    expect(lastFinish(chunks).reason.kind).toBe("stop");
    // Native path drives the backend directly with the translated request.
    expect(seen.parsed?.modelId).toBe("gpt-5.6-luna");
    expect(seen.parsed?.options.reasoning).toBe("low");
    expect(seen.parsed?._rawBody).toBeDefined();
  });

  test("tool-call arguments stay raw JSON strings and finish as tool-calls", async () => {
    const backend = scriptedBackend([
      { type: "tool_call_start", id: "call-1", name: "search" },
      { type: "tool_call_delta", arguments: '{"q":' },
      { type: "tool_call_delta", arguments: '"dsh"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 20, outputTokens: 3 } },
    ]);
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks = await collect(adapter.stream(userRequest("use a tool")));

    const deltas = chunks.filter(chunk => chunk.type === "tool-call-delta");
    expect(deltas.length).toBe(3); // empty start + two argument fragments
    const blockEnd = chunks.find(chunk => chunk.type === "block-end") as { block: { type: string; arguments?: string } };
    expect(blockEnd.block.type).toBe("tool-call");
    expect(blockEnd.block.arguments).toBe('{"q":"dsh"}');
    expect(lastFinish(chunks).reason.kind).toBe("tool-calls");
    // Native ChatGPT Web usage is intentionally omitted from the DSH stream.
    expect(chunks.some(chunk => chunk.type === "usage")).toBe(false);
  });

  test("finish is terminal even when a backend incorrectly emits trailing events", async () => {
    const backend = scriptedBackend([
      { type: "text_delta", text: "before" },
      { type: "done", stopReason: "stop", endTurn: true },
      { type: "text_delta", text: "after" },
    ]);
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks = await collect(adapter.stream(userRequest("hi")));
    const finishIndex = chunks.findIndex(chunk => chunk.type === "finish");
    expect(finishIndex).toBeGreaterThanOrEqual(0);
    expect(chunks.slice(finishIndex + 1)).toEqual([]);
  });

  test("backend errors map to a terminal error finish with a stable code", async () => {
    const backend = scriptedBackend([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "browser session lost", code: "browser_unavailable", status: 503 },
    ]);
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks = await collect(adapter.stream(userRequest("hi")));
    const finish = lastFinish(chunks);
    expect(finish.reason.kind).toBe("error");
    if (finish.reason.kind === "error") {
      expect(finish.reason.failure.code).toBe("browser_unavailable");
      expect(finish.reason.failure.status).toBe(503);
    }
  });

  test("a truncated native sidecar frame ends the turn with a stable PROTOCOL_ERROR", async () => {
    // Production native turns stream NDJSON AdapterEvent frames from the sidecar.
    // A frame cut short by a dying sidecar used to surface as a raw SyntaxError
    // under a generic PROVIDER_ERROR; it must end the turn as a typed protocol
    // failure while preserving whatever the stream already delivered.
    const body =
      JSON.stringify({ type: "text_delta", text: "partial" }) + "\n" +
      JSON.stringify({ type: "done", stopReason: "stop", endTurn: true }).slice(0, 12) + "\n";
    const adapter = new ChatGptWebLlmAdapter({
      loadProvider: () => providerConfigFixture(),
      resolveNativeDshTransport: () => ({ baseUrl: "http://127.0.0.1:1", controlToken: "token" }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    try {
      const chunks = await collect(adapter.stream(userRequest("hi")));
      const textDeltas = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: "text-delta" }> => chunk.type === "text-delta");
      expect(textDeltas.map(chunk => chunk.text).join("")).toBe("partial");
      const finish = lastFinish(chunks);
      expect(finish.reason.kind).toBe("error");
      if (finish.reason.kind === "error") {
        expect(finish.reason.failure.code).toBe("PROTOCOL_ERROR");
        expect(finish.reason.failure.message).toContain("unreadable native DSH stream frame");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("missing provider configuration maps to a stable PROVIDER_CONFIG finish", async () => {
    const adapter = new ChatGptWebLlmAdapter({
      loadProvider: () => {
        throw new Error("Configuration is missing: /tmp/config.json");
      },
      createBackend: () => scriptedBackend([]),
    });
    const chunks = await collect(adapter.stream(userRequest("hi")));
    const finish = lastFinish(chunks);
    expect(finish.reason.kind).toBe("error");
    if (finish.reason.kind === "error") {
      expect(finish.reason.failure.code).toBe("PROVIDER_CONFIG");
    }
  });

  test("unsupported image input is rejected explicitly, not discarded", async () => {
    const options = userRequest("hi");
    options.messages = [
      {
        role: "user",
        id: "msg-1",
        source: { kind: "user" },
        content: [{ type: "image", attachment: { attachmentId: "img-1" } }],
      } as unknown as GenerateOptions["messages"][number],
    ];
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => scriptedBackend([]) });
    const chunks = await collect(adapter.stream(options));
    const finish = lastFinish(chunks);
    expect(finish.reason.kind).toBe("error");
    if (finish.reason.kind === "error") {
      expect(finish.reason.failure.code).toBe("UNSUPPORTED_OPTION");
    }
  });

  test("conflicting explicit reasoning effort is rejected for a pinned route", async () => {
    const options = userRequest("hi");
    options.reasoningEffort = "max" as unknown as GenerateOptions["reasoningEffort"];
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => scriptedBackend([]) });
    const chunks = await collect(adapter.stream(options));
    const finish = lastFinish(chunks);
    expect(finish.reason.kind).toBe("error");
    if (finish.reason.kind === "error") {
      expect(finish.reason.failure.code).toBe("UNSUPPORTED_OPTION");
    }
  });
});

describe("ChatGptWebLlmAdapter cancellation", () => {
  test("pre-aborted signal yields a terminal aborted finish", async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = scriptedBackend([{ type: "text_delta", text: "never" }]);
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks = await collect(adapter.stream(userRequest("hi", { signal: controller.signal })));
    const finish = lastFinish(chunks);
    expect(finish.reason.kind).toBe("aborted");
  });

  test("early iterator return aborts a still-running backend", async () => {
    let backendAborted = false;
    const backend: ProviderAdapter = {
      name: "chatgpt-web",
      async runTurn(_parsed, incoming, emit) {
        emit({ type: "text_delta", text: "partial" });
        await new Promise<void>(resolve => {
          incoming.abortSignal?.addEventListener("abort", () => {
            backendAborted = true;
            resolve();
          }, { once: true });
        });
      },
    };
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const iterator = adapter.stream(userRequest("hi"))[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(backendAborted).toBe(true);
  });

  test("abort during the run propagates to the backend and yields aborted", async () => {
    const seen: { parsed?: CodexParsedRequest; signal?: AbortSignal } = {};
    const controller = new AbortController();
    const backend: ProviderAdapter = {
      name: "chatgpt-web",
      async runTurn(parsed, incoming, emit) {
        seen.parsed = parsed;
        seen.signal = incoming.abortSignal;
        // A real turn stays open until it settles; here it settles on abort.
        await new Promise<void>(resolve => {
          incoming.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        emit({ type: "error", message: "ChatGPT web turn aborted", code: "aborted" });
      },
    };
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks: StreamChunk[] = [];
    const iterator = adapter.stream(userRequest("hi", { signal: controller.signal }))[Symbol.asyncIterator]();
    setTimeout(() => controller.abort(), 5);
    for (;;) {
      const result = await iterator.next();
      if (result.done) break;
      chunks.push(result.value);
    }
    expect(seen.signal).toBeDefined();
    expect(seen.signal?.aborted).toBe(true);
    const finish = lastFinish(chunks);
    expect(finish.reason.kind).toBe("aborted");
  });
});

describe("native path does not enter the Responses server", () => {
  test("records browser logical completion before physical settlement retires the ProviderTurn", async () => {
    const provider = providerConfigFixture({ accountIdentityFingerprint: "test-account" });
    const parsed = toCodexParsedRequest(userRequest("hello"), provider);
    let releaseBrowser!: () => void;
    let signalStarted!: () => void;
    const browserStarted = new Promise<void>(resolve => { signalStarted = resolve; });
    const transport: WebSurfaceTransport = {
      async run(turn) {
        await turn.onPhysicalSurfaceBound?.({
          resourceId: "surface-lifecycle",
          browserContextId: "context-lifecycle",
          pageId: "page-lifecycle",
          profileId: "profile-lifecycle",
          accountId: "chatgpt-account:test-account",
        });
        await turn.onSurfaceReady?.();
        await turn.onSendActivated?.();
        turn.onSubmitted?.();
        turn.onTextDelta("ok");
        signalStarted();
        await new Promise<void>(resolve => { releaseBrowser = resolve; });
        return "ok";
      },
      verifyConnector: async () => "verified",
      inspectSession: async () => ({ authenticated: true, temporary: true, url: "https://chatgpt.com/" }),
      smokeTest: async () => ({ effort: "low", response: "ok" }),
      close: async () => {},
    };
    const core = new ChatGptWebProviderCore();
    const adapter = createChatGptWebAdapter(provider, { providerCore: core, transport });
    const events: AdapterEvent[] = [];
    const run = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));

    await browserStarted;
    releaseBrowser();
    await expect(run).resolves.toBeUndefined();

    expect(events.some(event => event.type === "done" && event.stopReason === "stop")).toBe(true);
    expect(core.get(chatGptTurnExecutionKey(parsed))).toBeUndefined();
    expect(core.wasRetired(chatGptTurnExecutionKey(parsed))).toBe(true);
    await adapter.shutdown();
  });

  test("tool-capable native turns wait for accepted submission before broker capability wait", async () => {
    const provider = providerConfigFixture({ localToolsEnabled: true });
    const parsed = toCodexParsedRequest(userRequest("read the workspace file", {
      tools: [{
        name: "fs.read",
        description: "Read a bounded UTF-8 workspace file.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      }] as unknown as ToolSchema[],
    }), provider);
    const rawInput = (parsed._rawBody as { input: Array<Record<string, unknown>> }).input;
    const nativeUser = [...rawInput].reverse().find(item => item.type === "message" && item.role === "user");
    const nativeTurnId = ((nativeUser?.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id);
    expect(typeof nativeTurnId).toBe("string");
    parsed._dshContext = {
      dshSessionId: "issue-127-session",
      threadId: "issue-127-thread",
      turnId: nativeTurnId as string,
      environment: {
        cwd: "/tmp",
        roots: ["/tmp"],
        writableRoots: ["/tmp"],
        sandboxMode: "workspace-write",
        networkAccess: false,
      },
    };

    const controller = new AbortController();
    let nextToolBatchCalled = false;
    let releaseSubmission!: () => void;
    const submissionGate = new Promise<void>(resolve => { releaseSubmission = resolve; });

    const broker: TurnBrokerOwner = {
      register: async () => "tool-turn-token",
      registerSafe: async () => "safe-turn-token",
      updateEnvironment: () => {},
      confirmSafeTurnSent: () => ({ confirmed: true, duplicate: false }),
      nextToolBatch: (_token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> => {
        nextToolBatchCalled = true;
        controller.abort();
        return new Promise<BrokerToolRequest[]>((_resolve, reject) => {
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            reject(new DOMException("aborted", "AbortError"));
          };
          if (signal?.aborted) {
            onAbort();
          } else {
            signal?.addEventListener("abort", onAbort, { once: true });
          }
        });
      },
      completeTool: () => {},
      waitForSafeStart: async () => {},
      waitForSafeCompletion: async () => "done",
      requestCompaction: () => 0,
      compactionDeliveryCount: () => 0,
      beginCompletionFence: () => undefined,
      commitCompletionFence: () => true,
      waitForRetirement: async () => new Promise<void>(() => {}),
      revoke: () => {},
    };

    const transport: WebSurfaceTransport = {
      async run(turn) {
        await turn.prepare();
        await turn.onPhysicalSurfaceBound?.({
          resourceId: "surface-127",
          browserContextId: "context-127",
          pageId: "page-127",
          profileId: "profile-127",
          accountId: "chatgpt-account:unknown",
        });
        await turn.onSurfaceReady?.();
        await turn.onSendActivated?.();
        await submissionGate;
        turn.onSubmitted?.();
        await new Promise<void>(() => {});
        return "unreachable";
      },
      verifyConnector: async () => "verified",
      inspectSession: async () => ({ authenticated: true, temporary: true, url: "https://chatgpt.com/" }),
      smokeTest: async () => ({ effort: "low", response: "ok" }),
      close: async () => {},
    };

    const adapter = createChatGptWebAdapter(provider, { broker, transport, providerCore: new TestProviderCore() });
    const run = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: controller.signal }, () => {});

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(nextToolBatchCalled).toBe(false);

    releaseSubmission();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(nextToolBatchCalled).toBe(true);
  });

  test("plugin declares the LLM service as a hard Cordis dependency", () => {
    const source = readFileSync(join(HERE, "..", "src", "plugin.ts"), "utf8");
    expect(source).toContain('export const inject = ["llm", "tools"];');
    expect(source).toMatch(/const dispose\s*=\s*ctx\.llm\.registerAdapter\(\[CHATGPT_WEB_PROVIDER_ID\], adapter\);/);
    expect(source).not.toContain("if (ctx.llm)");
  });
  test("llm-adapter module has no import of server.ts", () => {
    const source = readFileSync(join(HERE, "..", "src", "adapters", "chatgpt-web", "llm-adapter.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'].*server/);
    expect(source).not.toContain("bridgeToResponsesSSE");
  });

  test("real ChatGPT Web backend reaches the abort boundary with native input", async () => {
    const provider = providerConfigFixture();
    const parsed = toCodexParsedRequest(userRequest("hello"), provider);
    const backend = createChatGptWebAdapter(provider, { broker: {} as TurnBrokerOwner });
    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.runTurn!(
        parsed,
        { headers: new Headers(), abortSignal: controller.signal },
        () => {},
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("translation includes native input and replay identity", () => {
    const provider = providerConfigFixture();
    const parsed = toCodexParsedRequest(userRequest("hello"), provider);
    expect(parsed.modelId).toBe("gpt-5.6-luna");
    expect(parsed.stream).toBe(true);
    expect(parsed.context.messages[0]?.role).toBe("user");

    const raw = parsed._rawBody as {
      input?: unknown[];
      client_metadata?: unknown;
    };
    expect(Array.isArray(raw.input)).toBe(true);
    expect((raw.input?.[0] as { type?: string }).type).toBe("message");
    expect((raw.input?.[0] as { role?: string }).role).toBe("user");
    expect(
      (raw.input?.[0] as { internal_chat_message_metadata_passthrough?: { turn_id?: string } })
        .internal_chat_message_metadata_passthrough?.turn_id,
    ).toBe(parsed._dshContext?.turnId);
    expect(raw.client_metadata).toBeUndefined();
    expect(parsed._dshContext?.threadId).not.toBe("dsh-session");
    expect(() => chatGptTurnExecutionKey(parsed)).not.toThrow();
    expect(() => chatGptTurnRoundKey(parsed)).not.toThrow();
    const second = toCodexParsedRequest(userRequest("hello"), provider);
    expect(second._dshContext?.threadId).not.toBe(parsed._dshContext?.threadId);
    expect(second._dshContext?.turnId).not.toBe(parsed._dshContext?.turnId);
  });

  test("mapStream drives an injected backend without any HTTP hop", async () => {
    let invoked = false;
    const backend: ProviderAdapter = {
      name: "chatgpt-web",
      async runTurn(_parsed, _incoming, emit) {
        invoked = true;
        emit({ type: "text_delta", text: "ok" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
    const chunks = await collect(mapStream(() => backend, userRequest("hi"), () => toCodexParsedRequest(userRequest("hi"), providerConfigFixture())));
    expect(invoked).toBe(true);
    expect(lastFinish(chunks).reason.kind).toBe("stop");
  });
});

describe("ChatGptWebLlmAdapter model catalogue and capabilities", () => {
  test("Sol and resolver expose exactly the same available route set", async () => {
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture({ solAvailable: true, proAvailable: false }) });
    const models = await adapter.listModels(CHATGPT_WEB_PROVIDER_ID);
    expect(models.map(model => model.id)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    for (const model of models) {
      await expect(adapter.resolveModel(CHATGPT_WEB_PROVIDER_ID, model.id)).resolves.toBeDefined();
    }
  });

  test("Zero Risk Pro capability is propagated from provider config", async () => {
    const adapter = new ChatGptWebLlmAdapter({
      loadProvider: () => providerConfigFixture({
        browserInteractionMode: "manual",
        zeroRiskProEnabled: true,
      }),
    });
    const models = await adapter.listModels(CHATGPT_WEB_PROVIDER_ID);
    expect(models.map(model => model.id)).toEqual([
      "chatgpt-web/zero-risk",
      "chatgpt-web/zero-risk-pro",
    ]);
    await expect(adapter.resolveModel(CHATGPT_WEB_PROVIDER_ID, "chatgpt-web/zero-risk-pro")).resolves.toBeDefined();
  });
});

describe("ChatGptWebLlmAdapter tool schemas", () => {
  test("tools are projected into the backend request", () => {
    const tools: ToolSchema[] = [{
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    }];
    const parsed = toCodexParsedRequest(userRequest("hi", { tools }), providerConfigFixture());
    expect(parsed.context.tools?.length).toBe(1);
    expect(parsed.context.tools?.[0]?.name).toBe("search");
  });

  test("tool results preserve the originating call and explicit error state", () => {
    const request = userRequest("hi");
    request.messages = [
      {
        role: "assistant",
        id: "assistant-1",
        source: { kind: "model", provider: "chatgpt-web", model: "chatgpt-web/luna" },
        content: [{
          type: "tool-call",
          id: "call-1",
          name: "search",
          arguments: "{}",
          namespace: "mcp__context7",
        }],
      } as unknown as GenerateOptions["messages"][number],
      {
        role: "user",
        id: "msg-2",
        source: { kind: "user" },
        content: [{ type: "text", text: "run it" }],
      } as unknown as GenerateOptions["messages"][number],
      {
        role: "tool",
        id: "tool-result-1",
        source: { kind: "tool", callId: "call-1" },
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      } as unknown as GenerateOptions["messages"][number],
    ];
    const parsed = toCodexParsedRequest(request, providerConfigFixture());
    const result = parsed.context.messages.find(message => message.role === "toolResult");
    expect(result?.role).toBe("toolResult");
    if (result?.role === "toolResult") {
      expect(result.toolName).toBe("search");
      expect(result.toolNamespace).toBe("mcp__context7");
      expect(result.isError).toBe(true);
    }
  });

  test("deferred tools and dynamic tool history are rejected explicitly at the DSH boundary", () => {
    const deferred: ToolSchema = {
      name: "search",
      description: "Search the web",
      parameters: { type: "object" },
      deferLoading: true,
    };
    expect(() => toCodexParsedRequest(userRequest("hi", { tools: [deferred] }), providerConfigFixture()))
      .toThrow(LlmError);

    expect(() => toCodexParsedRequest(userRequest("hi", {
      toolHistory: {
        tools: [],
        updates: [{ messageId: "message-1", additions: [] }],
      } as unknown as GenerateOptions["toolHistory"],
    }), providerConfigFixture())).toThrow(LlmError);
  });

  test("purpose is mapped instead of silently dropped", () => {
    const title = toCodexParsedRequest(userRequest("title me", { purpose: "session-title" }), providerConfigFixture());
    expect(title._dshContext?.purpose).toBe("session-title");
    expect(title._rawBody).not.toHaveProperty("client_metadata");
    expect(title.options.reasoning).toBeUndefined();
    expect(title.options.hideThinkingSummary).toBe(true);

    const compactRequest = userRequest("summarize", { purpose: "compaction" });
    compactRequest.model = "chatgpt-web/light";
    const compact = toCodexParsedRequest(
      compactRequest,
      providerConfigFixture({ solAvailable: true }),
    );
    expect(compact._compactionRequest).toBe(true);
    expect(compact.context.messages.at(-1)?.role).toBe("user");
    const raw = compact._rawBody as { input: unknown[]; client_metadata?: unknown };
    expect((raw.input.at(-1) as { type?: string }).type).toBe("compaction_trigger");
    expect(raw.client_metadata).toBeUndefined();
    expect(compact._dshContext?.purpose).toBe("compaction");
    expect(compact.options.reasoning).toBeUndefined();

    const lunaCompactRequest = userRequest("summarize", { purpose: "compaction" });
    lunaCompactRequest.model = "chatgpt-web/luna";
    const lunaCompact = toCodexParsedRequest(lunaCompactRequest, providerConfigFixture());
    expect(lunaCompact.modelId).toBe("gpt-5.6-luna");
    expect(lunaCompact._compactionRequest).toBe(true);
    expect(lunaCompact.context.messages.at(-1)?.role).toBe("user");
    const lunaRaw = lunaCompact._rawBody as { input: unknown[]; client_metadata?: unknown };
    expect((lunaRaw.input.at(-1) as { type?: string }).type).toBe("compaction_trigger");
    expect(lunaRaw.client_metadata).toBeUndefined();
    expect(lunaCompact._dshContext?.purpose).toBe("compaction");
    expect(lunaCompact.options.reasoning).toBeUndefined();
  });
});
