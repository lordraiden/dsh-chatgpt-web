import assert from "node:assert/strict";
import {
  LlmError,
  type GenerateOptions,
} from "@deepseek-ai/dsh-llm";
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
  const parsed = nativeRequest({
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
  } as any);
  assert.ok(parsed.context.messages.length > 0, "tool-history projection must remain usable by the native adapter");
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
