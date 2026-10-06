import assert from "node:assert/strict";
import {
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { AssistantStreamAccumulator } from "@deepseek-ai/dsh-llm/assistant-stream";
import {
  ChatGptThreadEnvironmentStore,
} from "../src/adapters/chatgpt-web/thread-environment";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
} from "../src/adapters/chatgpt-web/environment";
import {
  ChatGptWebLlmAdapter,
  mapStream,
  toCodexParsedRequest,
} from "../src/adapters/chatgpt-web/llm-adapter";
import { CHATGPT_WEB_LUNA_MODEL_ROUTE } from "../src/chatgpt-web-models";
import type { CodexParsedRequest, DshNativeTurnContext } from "../src/types";

const provider = {
  chatgptWeb: {
    solAvailable: false,
    proAvailable: false,
    browserInteractionMode: "automatic",
    experimentalBiggerContext: false,
    zeroRiskProEnabled: false,
  },
} as any;

const nativeContext: DshNativeTurnContext = {
  dshSessionId: "session-74",
  threadId: "dsh-74-thread",
  turnId: "turn-74",
  purpose: "compaction",
  environment: {
    cwd: "/workspace",
    roots: ["/workspace"],
    writableRoots: ["/workspace"],
    sandboxMode: "workspace-write",
    networkAccess: false,
  },
};

function baseOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "chatgpt-web",
    model: CHATGPT_WEB_LUNA_MODEL_ROUTE.slug,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "hello" }],
    }],
    ...overrides,
  } as GenerateOptions;
}

function nativeRequest(overrides: Partial<GenerateOptions> = {}): CodexParsedRequest {
  return toCodexParsedRequest(
    baseOptions(overrides),
    provider,
    () => nativeContext,
  );
}

{
  const auxiliaryEnvelope = "<codex_context_json>{\"messages\":[{\"role\":\"user\",\"content\":\"source user content\"}]}</codex_context_json>";
  const parsed = nativeRequest({
    purpose: "compaction",
    messages: [{
      role: "user",
      content: [{ type: "text", text: auxiliaryEnvelope }],
    }],
  });
  const contextMessages = parsed.context.messages;
  assert.equal(contextMessages[0]?.role, "user");
  assert.deepEqual(
    contextMessages[0]?.content,
    [{ type: "text", text: auxiliaryEnvelope }],
    "compaction input must bypass conversational projection",
  );
}

{
  const escapedHindsight = 'Hindsight includes "quoted text", \\slashes, and {JSON-like braces}.';
  const transportEnvelope = `<codex_context_json>${JSON.stringify({
    version: 3,
    system: ["You are a concise conversational assistant."],
    messages: [
      { role: "user", content: "prueba de contexto enviado" },
      { role: "user", content: `<hindsight_knowledge>\\n${escapedHindsight}\\n</hindsight_knowledge>` },
      { role: "user", content: "Time sampled while preparing turn 1, step 1: 2026-10-06T12:29:05+02:00[Europe/Madrid]" },
    ],
  })}</codex_context_json>`;

  const parsed = nativeRequest({
    messages: [{
      role: "user",
      content: [{ type: "text", text: transportEnvelope }],
    }],
  });
  assert.equal(parsed.context.messages.length, 1);
  assert.deepEqual(parsed.context.messages[0], {
    role: "user",
    content: [{ type: "text", text: "prueba de contexto enviado" }],
    timestamp: parsed.context.messages[0]?.timestamp,
  });
}

{
  const parsed = nativeRequest({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "prueba de contexto enviado" }],
      },
      {
        role: "user",
        content: [{
          type: "text",
          text: "<hindsight_knowledge>\nprivate memory\n</hindsight_knowledge>",
        }],
      },
      {
        role: "user",
        content: [{
          type: "text",
          text: "Time sampled while preparing turn 1, step 1: 2026-10-06T12:29:05+02:00[Europe/Madrid]\nBrowser time zone for this request: Europe/Madrid.",
        }],
      },
    ],
  });

  assert.equal(parsed.context.messages.length, 1);
  assert.deepEqual(parsed.context.messages[0]?.content, [
    { type: "text", text: "prueba de contexto enviado" },
  ]);
}

{
  const parsed = nativeRequest();
  assert.deepEqual(parsed._dshContext, nativeContext);
  const raw = parsed._rawBody as Record<string, unknown>;
  assert.equal(raw.client_metadata, undefined, "native DSH must not depend on Codex client metadata");
  assert.deepEqual(extractChatGptTurnIdentity(parsed), {
    dshSessionId: "session-74",
    threadId: "dsh-74-thread",
    turnId: "turn-74",
  });
  assert.deepEqual(extractChatGptTurnEnvironment(parsed), {
    cwd: "/workspace",
    roots: ["/workspace"],
    writableRoots: ["/workspace"],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: false,
    },
    tools: [],
  });
}

{
  assert.throws(
    () => nativeRequest({
      toolHistory: {
        tools: [],
        updates: [{
          messageId: "message-1",
          additions: [{
            toolName: "write",
            tool: {
              name: "write",
              description: "write",
              parameters: { type: "object" },
            },
          }],
        }],
      },
    } as any),
    (error: unknown) => error instanceof LlmError
      && error.code === "UNSUPPORTED_OPTION"
      && /dynamic tool history updates/i.test(error.message),
    "native DSH must reject unsupported tool-history updates instead of silently dropping them",
  );
}

{
  assert.throws(
    () => nativeRequest({
      tools: [{
        name: "deferred",
        description: "deferred",
        parameters: { type: "object" },
        deferLoading: true,
      }],
    } as any),
    (error: unknown) => error instanceof LlmError
      && error.code === "UNSUPPORTED_OPTION",
      "unsupported deferred loading must fail explicitly",
  );
}

{
  const adapter = new ChatGptWebLlmAdapter({
    loadProvider: () => provider,
    createBackend: () => ({ runTurn: async () => undefined, shutdown: async () => {} } as any),
    resolveNativeDshContext: () => nativeContext,
  });
  const resolved = await adapter.resolveModel("chatgpt-web", CHATGPT_WEB_LUNA_MODEL_ROUTE.slug);
  assert.deepEqual(resolved.inputModalities, ["text"]);
}

{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        type: "server_error",
        code: "server_is_overloaded",
        message: "dsh-chatgpt-web is draining for a requested service operation",
      },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const adapter = new ChatGptWebLlmAdapter({
      loadProvider: () => provider,
      resolveNativeDshTransport: () => ({
        baseUrl: "http://127.0.0.1:17841",
        controlToken: "test-token",
      }),
      resolveNativeDshContext: () => nativeContext,
    });
    const chunks = [];
    for await (const chunk of adapter.stream(baseOptions())) {
      chunks.push(chunk);
    }
    const finish = chunks.findLast((chunk) => chunk.type === "finish");
    assert.ok(finish && finish.type === "finish");
    assert.deepEqual(finish.reason, {
      kind: "error",
      failure: {
        message: "dsh-chatgpt-web is draining for a requested service operation",
        code: "server_is_overloaded",
        status: 503,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const chunks = [];
  for await (const chunk of mapStream(
    () => ({ runTurn: async () => undefined } as any),
    baseOptions(),
    () => {
      throw new LlmError("projection failure", "UNSUPPORTED_OPTION");
    },
    { usageMode: "omit" },
  )) {
    chunks.push(chunk);
  }

  const finish = chunks.findLast(chunk => chunk.type === "finish");
  assert.ok(finish && finish.type === "finish");
  assert.deepEqual(finish.reason, {
    kind: "error",
    failure: {
      message: "projection failure",
      code: "UNSUPPORTED_OPTION",
    },
  });

  const accumulator = new AssistantStreamAccumulator();
  assert.doesNotThrow(() => {
    accumulator.push({ time: 1_000, chunk: finish });
  });
}

{
  const chunks: StreamChunk[] = [];
  const malformedBackend = {
    runTurn: async (_parsed: CodexParsedRequest, _incoming: unknown, emit: (event: any) => void) => {
      emit({ type: "error", code: "BROKEN_PROVIDER" });
    },
  };
  for await (const chunk of mapStream(
    () => malformedBackend as any,
    baseOptions(),
    nativeRequest,
    { usageMode: "omit" },
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [{
    type: "finish",
    reason: {
      kind: "error",
      failure: {
        message: "ChatGPT Web sidecar emitted error without a non-empty message.",
        code: "PROTOCOL_ERROR",
      },
    },
  }]);
  const accumulator = new AssistantStreamAccumulator();
  for (const [index, chunk] of chunks.entries()) {
    assert.doesNotThrow(() => accumulator.push({ time: 2_000 + index, chunk }));
  }
}

{
  const chunks: StreamChunk[] = [];
  const malformedToolEventBackend = {
    runTurn: async (_parsed: CodexParsedRequest, _incoming: unknown, emit: (event: any) => void) => {
      emit({ type: "tool_call_start", id: "tool-1" });
    },
  };
  for await (const chunk of mapStream(
    () => malformedToolEventBackend as any,
    baseOptions(),
    nativeRequest,
    { usageMode: "omit" },
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [{
    type: "finish",
    reason: {
      kind: "error",
      failure: {
        message: "ChatGPT Web sidecar emitted tool_call_start without a non-empty name.",
        code: "PROTOCOL_ERROR",
      },
    },
  }]);
  const accumulator = new AssistantStreamAccumulator();
  assert.doesNotThrow(() => accumulator.push({ time: 3_000, chunk: chunks[0]! }));
}

{
  const backend = {
    runTurn: async (
      _parsed: CodexParsedRequest,
      _incoming: unknown,
      emit: (event: any) => void,
    ) => {
      emit({ type: "done", stopReason: "stop" });
    },
  };
  const chunks = [];
  for await (const chunk of mapStream(
    () => backend as any,
    baseOptions(),
    nativeRequest,
    { usageMode: "omit" },
  )) {
    chunks.push(chunk);
  }
  const finish = chunks.findLast((chunk) => chunk.type === "finish");
  assert.ok(finish && finish.type === "finish");
  assert.deepEqual(finish.reason, {
    kind: "error",
    failure: {
      message: "ChatGPT Web completed without any response content.",
      code: "EMPTY_RESPONSE",
    },
  });
}

{
  const parsed = nativeRequest();
  const store = new ChatGptThreadEnvironmentStore(undefined, () => 1_000_000);
  const resolved = store.resolve(parsed);
  assert.equal(resolved.cwd, "/workspace");
  assert.equal(resolved.sandboxPolicy.type, "workspaceWrite");

  const noEnvironment = {
    ...parsed,
    _dshContext: { ...nativeContext, environment: undefined },
  } as CodexParsedRequest;
  assert.throws(
    () => store.resolve(noEnvironment),
    /MissingTrustedCodexEnvironmentError|missing cwd in trusted Codex environment context/i,
  );
}
