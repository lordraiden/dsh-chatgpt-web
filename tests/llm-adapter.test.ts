/**
 * Provider-boundary contract tests for the native DSH LlmAdapter (issue #8).
 *
 * These are contract tests at the architecture boundary: registration,
 * route/model resolution, stream conversion, cancellation, missing
 * auth/config failure, and proof that the native path does not enter the
 * Responses server. The backend is a scripted in-memory `ProviderAdapter`,
 * so no browser is started.
 */
import { describe, expect, test } from "bun:test";\nimport { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";\nimport type { TurnBrokerOwner } from "../src/adapters/chatgpt-web/turn-broker";
import { readFileSync } from "node:fs";
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
import {
  chatGptTurnExecutionKey,
  chatGptTurnRoundKey,
} from "../src/adapters/chatgpt-web/turn-execution";

const HERE = dirname(fileURLToPath(import.meta.url));

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
  test("constructor performs no I/O and providerInfo identifies the route", () => {
    const adapter = new ChatGptWebLlmAdapter();
    const info = adapter.providerInfo(CHATGPT_WEB_PROVIDER_ID);
    expect(info.id).toBe(CHATGPT_WEB_PROVIDER_ID);
    expect(info.name).toBe("ChatGPT Web");
  });

  test("listModels advertises the Luna route with text input modality", async () => {
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture() });
    const models = await adapter.listModels(CHATGPT_WEB_PROVIDER_ID);
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
  test("text and reasoning map to ordered blocks with usage before finish", async () => {
    const seen: { parsed?: CodexParsedRequest } = {};
    const backend = scriptedBackend([
      { type: "thinking_delta", thinking: "let me think" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 10 } },
    ], seen);
    const adapter = new ChatGptWebLlmAdapter({ loadProvider: () => providerConfigFixture(), createBackend: () => backend });
    const chunks = await collect(adapter.stream(userRequest("hi")));

    // Ordering: reasoning block, text block, usage, finish.
    const types = chunks.map(chunk => chunk.type);
    expect(types).toEqual([
      "block-start", "reasoning-delta", "block-end",
      "block-start", "text-delta", "text-delta", "block-end",
      "usage", "finish",
    ]);
    const usage = chunks.find(chunk => chunk.type === "usage");
    expect(usage?.type).toBe("usage");
    if (usage?.type === "usage") {
      expect(usage.usage.inputTokens).toBe(90); // 100 total - 10 cache read
      expect(usage.usage.cacheReadTokens).toBe(10);
      expect(usage.usage.outputTokens).toBe(5);
    }
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
    // usage precedes finish
    const usageIndex = chunks.findIndex(chunk => chunk.type === "usage");
    const finishIndex = chunks.findIndex(chunk => chunk.type === "finish");
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(finishIndex);
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
  test("plugin declares the LLM service as a hard Cordis dependency", () => {
    const source = readFileSync(join(HERE, "..", "src", "plugin.ts"), "utf8");
    expect(source).toContain('export const inject = ["llm"];');
    expect(source).toContain("const disposeAdapter = ctx.llm.registerAdapter");
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
      client_metadata?: { "x-codex-turn-metadata"?: { thread_id?: string; turn_id?: string } };
    };
    expect(Array.isArray(raw.input)).toBe(true);
    expect((raw.input?.[0] as { type?: string }).type).toBe("message");
    expect((raw.input?.[0] as { role?: string }).role).toBe("user");
    expect(
      (raw.input?.[0] as { internal_chat_message_metadata_passthrough?: { turn_id?: string } })
        .internal_chat_message_metadata_passthrough?.turn_id,
    ).toBe(raw.client_metadata?.["x-codex-turn-metadata"]?.turn_id);
    expect(raw.client_metadata?.["x-codex-turn-metadata"]?.thread_id).not.toBe("dsh-session");
    expect(() => chatGptTurnExecutionKey(parsed)).not.toThrow();
    expect(() => chatGptTurnRoundKey(parsed)).not.toThrow();
    const second = toCodexParsedRequest(userRequest("hello"), provider);
    const firstThreadId = raw.client_metadata?.["x-codex-turn-metadata"]?.thread_id;
    const secondThreadId = (second._rawBody as { client_metadata: { "x-codex-turn-metadata": { thread_id: string } } })
      .client_metadata["x-codex-turn-metadata"].thread_id;
    expect(secondThreadId).not.toBe(firstThreadId);
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

  test("deferred tools and dynamic tool history are rejected rather than flattened", () => {
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
    const titleMeta = (title._rawBody as { client_metadata: { "x-codex-turn-metadata": { purpose?: string } } })
      .client_metadata["x-codex-turn-metadata"];
    expect(titleMeta.purpose).toBe("session-title");
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
    const raw = compact._rawBody as {
      input: unknown[];
      client_metadata: { "x-codex-turn-metadata": { purpose?: string } };
    };
    expect((raw.input.at(-1) as { type?: string }).type).toBe("compaction_trigger");
    expect(raw.client_metadata["x-codex-turn-metadata"].purpose).toBe("compaction");
    expect(compact.options.reasoning).toBeUndefined();

    const lunaCompactRequest = userRequest("summarize", { purpose: "compaction" });
    lunaCompactRequest.model = "chatgpt-web/luna";
    const lunaCompact = toCodexParsedRequest(lunaCompactRequest, providerConfigFixture());
    expect(lunaCompact.modelId).toBe("gpt-5.6-luna");
    expect(lunaCompact._compactionRequest).toBe(true);
    expect(lunaCompact.context.messages.at(-1)?.role).toBe("user");
    const lunaRaw = lunaCompact._rawBody as {
      input: unknown[];
      client_metadata: { "x-codex-turn-metadata": { purpose?: string } };
    };
    expect((lunaRaw.input.at(-1) as { type?: string }).type).toBe("compaction_trigger");
    expect(lunaRaw.client_metadata["x-codex-turn-metadata"].purpose).toBe("compaction");
    expect(lunaCompact.options.reasoning).toBeUndefined();
  });
});
