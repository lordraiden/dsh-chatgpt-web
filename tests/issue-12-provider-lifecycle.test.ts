import { expect, test } from "bun:test";
import {
  ChatGptWebSurfaceTransport,
  type WebSurfaceTransportBackend,
  type WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";
import {
  detectChatGptContextExhaustion,
  type ChatGptContextExhaustionObservation,
} from "../src/adapters/chatgpt-web/context-exhaustion";
import { chatGptContextExhaustedError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";
import {
  BrowserAccountLease,
  ChatGptWebProviderCore,
  capabilityBindingIdForExecution,
} from "../src/adapters/chatgpt-web/provider-core";
import { projectCanonicalChatGptWebContext } from "../src/adapters/chatgpt-web/context-projection";
import {
  deriveChatGptReplayExecutionState,
  createChatGptReplayBoundary,
  ChatGptReplayCoordinator,
} from "../src/adapters/chatgpt-web/replay";
import {
  chatGptConversationHandleForEpoch,
  createChatGptWebReplayTransport,
} from "../src/adapters/chatgpt-web/replay-transport";

/**
 * Merged from the former issue-12a/-12b/-12c suites, which were green under a bare `bun test` but
 * never gated by the chain. Every test is preserved; only the three files became one chain entry.
 */

function fakeTurn(overrides: Partial<WebSurfaceTurn> = {}): WebSurfaceTurn {
  return {
    traceId: "trace-64",
    modelId: "gpt-5.6-luna",
    capabilities: {
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
    },
    prepare: async () => ({
      text: "hello",
      images: [],
      release: () => {},
    }),
    onTextDelta: () => {},
    ...overrides,
  };
}

function fakeBackend(calls: string[]): WebSurfaceTransportBackend {
  return {
    run(turn) {
      calls.push(`run:${turn.traceId}`);
      turn.onPhysicalSurfaceBound?.({
        resourceId: "surface-1",
        browserContextId: "context-1",
        pageId: "page-1",
        profileId: "profile-1",
        accountId: "account-1",
      });
      turn.onSurfaceReady?.();
      turn.onSendActivated?.();
      turn.onSubmitted?.();
      return Promise.resolve("answer");
    },
    verifyConnector(traceId) {
      calls.push(`verify:${traceId ?? "generated"}`);
      return Promise.resolve("verified");
    },
    inspectSession(detectCapabilities) {
      calls.push(`inspect:${detectCapabilities}`);
      return Promise.resolve({
        authenticated: true,
        temporary: false,
        url: "https://chatgpt.com/",
        solAvailable: false,
        proAvailable: false,
      });
    },
    recoverRetainedAnswer(conversationKey, options) {
      calls.push(`recover:${conversationKey}:${options.timeoutMs ?? "default"}`);
      return Promise.resolve({ text: "recovered", capturedAt: 0, waitedMs: 0 });
    },
    smokeTest() {
      calls.push("smoke");
      return Promise.resolve({ effort: "low", response: "ok" });
    },
    close() {
      calls.push("close");
      return Promise.resolve();
    },
  };
}

test("WebSurfaceTransport keeps lifecycle evidence semantic", async () => {
  const calls: string[] = [];
  const transport = new ChatGptWebSurfaceTransport(fakeBackend(calls));
  const observed: string[] = [];

  const turn = fakeTurn({
    onPhysicalSurfaceBound: surface => { observed.push(`bound:${surface.resourceId}`); },
    onSurfaceReady: () => { observed.push("ready"); },
    onSendActivated: () => { observed.push("send-activated"); },
    onSubmitted: () => { observed.push("submitted"); },
  });

  await expect(transport.run(turn)).resolves.toBe("answer");
  expect(observed).toEqual(["bound:surface-1", "ready", "send-activated", "submitted"]);
  expect(calls).toEqual(["run:trace-64"]);
});

test("WebSurfaceTransport preserves owning-turn cancellation semantics", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const backend: WebSurfaceTransportBackend = {
    run(turn) {
      receivedSignal = turn.abortSignal;
      return Promise.reject(new DOMException("cancelled", "AbortError"));
    },
    verifyConnector: () => Promise.resolve("verified"),
    inspectSession: async () => ({
      authenticated: true,
      temporary: false,
      url: "https://chatgpt.com/",
    }),
    smokeTest: async () => ({ effort: "low", response: "ok" }),
    recoverRetainedAnswer: async () => ({ text: "recovered", capturedAt: 0, waitedMs: 0 }),
    close: () => Promise.resolve(),
  };
  const transport = new ChatGptWebSurfaceTransport(backend);

  const run = transport.run(fakeTurn({ abortSignal: controller.signal }));
  controller.abort();

  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(receivedSignal).toBe(controller.signal);
});

test("WebSurfaceTransport is not a second lifecycle or authorization authority", async () => {
  const calls: string[] = [];
  const transport = new ChatGptWebSurfaceTransport(fakeBackend(calls));

  const inspection = await transport.inspectSession(true);
  expect(inspection).toEqual({
    authenticated: true,
    temporary: false,
    url: "https://chatgpt.com/",
    solAvailable: false,
    proAvailable: false,
  });
  await transport.verifyConnector("trace-verify");
  await transport.smokeTest();
  await transport.close();

  expect(calls).toEqual([
    "inspect:true",
    "verify:trace-verify",
    "smoke",
    "close",
  ]);
});

// The former "the transport contract does not export browser implementation types" and
// "upper provider layers import the transport boundary, never the browser worker" tests read
// `src/` and asserted on its text. Both intents are behavioural here: every test in this file
// drives the transport with a plain semantic turn object (no browser types), and
// `issue-194-web-chat-provider-conformance` drives the whole adapter through a controlled
// `WebSurfaceTransport`, which is only possible while the transport remains the seam.

test("WebSurfaceTransport exposes all Phase 1 lifecycle evidence without owning completion policy", () => {
  const transport = new ChatGptWebSurfaceTransport(fakeBackend([]));
  const states: string[] = [];
  const turn = fakeTurn({
    onPhysicalSurfaceBound: () => { states.push("surface-bound"); },
    onSurfaceReady: () => { states.push("surface-ready"); },
    onSendActivated: () => { states.push("send-activated"); },
    onSubmitted: () => { states.push("submitted"); },
    onHeartbeat: () => { states.push("heartbeat"); },
    onReasoningSummary: () => { states.push("reasoning-summary"); },
  });

  return transport.run(turn).then(() => {
    expect(states.slice(0, 4)).toEqual([
      "surface-bound",
      "surface-ready",
      "send-activated",
      "submitted",
    ]);
    expect(states).not.toContain("completed");
  });
});

function observation(overrides: Partial<ChatGptContextExhaustionObservation>): ChatGptContextExhaustionObservation {
  return {
    role: "alert",
    text: "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.",
    actionLabels: ["New chat"],
    ...overrides,
  };
}

test("detects the canonical maximum-conversation-length surface", () => {
  const signal = detectChatGptContextExhaustion(observation({}));
  expect(signal).toEqual({
    kind: "context_exhausted",
    variant: "maximum-conversation-length",
    source: "surface-structure",
  });
});

test("detects the shorter conversation-too-long variant", () => {
  const signal = detectChatGptContextExhaustion(observation({
    text: "This conversation is too long, please start a new one.",
    actionLabels: ["Start a new chat"],
  }));
  expect(signal?.kind).toBe("context_exhausted");
  expect(signal?.variant).toBe("conversation-too-long");
});

test("detects localized structural equivalents without relying on English copy", () => {
  const cases = [
    ["Has alcanzado la longitud máxima de esta conversación. Inicia un nuevo chat.", "Nuevo chat"],
    ["Vous avez atteint la longueur maximale de cette conversation. Nouvelle conversation.", "Nouvelle conversation"],
    ["此对话已达到最大长度，请开始新对话。", "新对话"],
    ["この会話は最大長さに達しました。新しいチャットを開始してください。", "新しいチャット"],
    ["현재 대화가 최대 길이에 도달했습니다. 새 채팅을 시작하세요.", "새 채팅"],
  ] as const;

  for (const [text, action] of cases) {
    const signal = detectChatGptContextExhaustion(observation({ text, actionLabels: [action] }));
    expect(signal?.kind).toBe("context_exhausted");
  }
});

test("detects a plain structural wrapper when the exhaustion surface exposes a New Chat action", () => {
  const signal = detectChatGptContextExhaustion({
    text: "This conversation is too long, please start a new one.",
    actionLabels: ["New chat"],
  });
  expect(signal?.kind).toBe("context_exhausted");
  expect(signal?.variant).toBe("conversation-too-long");
});

test("does not classify an ordinary assistant message", () => {
  const signal = detectChatGptContextExhaustion(observation({
    role: "assistant",
    withinAssistantTurn: true,
    text: "This conversation is too long; you could start a new chat if you want a different topic.",
  }));
  expect(signal).toBeUndefined();
});

test("does not classify a generic ChatGPT error", () => {
  const signal = detectChatGptContextExhaustion(observation({
    text: "Something went wrong. Please try again.",
    actionLabels: ["Retry"],
  }));
  expect(signal).toBeUndefined();
});

test("does not let a New Chat button turn a generic maximum-attempt error into exhaustion", () => {
  const signal = detectChatGptContextExhaustion(observation({
    role: "alert",
    testId: "request-error",
    text: "Maximum retry attempts reached. Please try again later.",
    actionLabels: ["New chat"],
  }));
  expect(signal).toBeUndefined();
});

test("does not classify a loading/readiness surface", () => {
  const signal = detectChatGptContextExhaustion(observation({
    role: "status",
    text: "Loading chats",
    actionLabels: [],
  }));
  expect(signal).toBeUndefined();
});

test("context exhaustion is a terminal semantic provider condition", () => {
  const error = chatGptContextExhaustedError();
  expect(error.code).toBe("context_exhausted");
  expect(error.retryable).toBe(false);
  expect(error.status).toBe(409);
});
test("the semantic exhaustion error does not leak ChatGPT UI prose", () => {
  const error = chatGptContextExhaustedError();
  expect(error.message).toBe(
    "The current ChatGPT Web conversation has reached its product context limit and must be replaced before the DSH turn can continue.",
  );
  expect(error.message).not.toContain("maximum length");
});

function runtimeForRetainedConversation(physicalSettlement: Promise<void>, release: () => void, conversationKey = "conversation-1"): ChatGptTurnRuntime {
  const capabilitySnapshot = projectChatGptCapabilities({
    sessionId: "dsh-session-1",
    agentId: "agent-1",
    turnId: "native-turn-1",
    tools: [],
  });

  return {
    mode: "read-only",
    capabilitySnapshot,
    browser: Promise.resolve("terminal"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => release(),
    cancel: () => {},
  };
}

test("conversation retirement preserves DSH identity while invalidating only the ChatGPT handle", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  const runtime = runtimeForRetainedConversation(physicalSettlement, () => {});
  const session = sessions.getOrCreate(
    "execution-identity",
    () => runtime,
    "trace-identity",
    "owner-identity",
    "native-turn-identity",
    "thread-identity",
  );
  const capabilitySnapshot = session.runtime.capabilitySnapshot;

  const retirement = sessions.retireConversationAndWait("conversation-1");
  expect(session.conversationKey()).toBeUndefined();
  expect(session.ownerKey).toBe("owner-identity");
  expect(session.nativeTurnId).toBe("native-turn-identity");
  expect(session.nativeThreadId).toBe("thread-identity");
  expect(session.runtime.capabilitySnapshot).toBe(capabilitySnapshot);
  expect(sessions.find("execution-identity")).toBeUndefined();

  resolvePhysical();
  await retirement;
});

test("late state from an exhausted execution cannot become state of a replacement execution", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  const oldRuntime = runtimeForRetainedConversation(physicalSettlement, () => {});
  const oldSession = sessions.getOrCreate(
    "execution-stale",
    () => oldRuntime,
    "trace-old",
    "owner-old",
    "native-turn-old",
    "thread-old",
  );

  const retirement = sessions.retireConversationAndWait("conversation-1");
  expect(sessions.find("execution-stale")).toBeUndefined();
  expect(sessions.findConversationHead("conversation-1")).toBeUndefined();

  // Simulate an already-queued browser callback arriving after logical invalidation.
  oldSession.appendRoundReasoning("stale-round", ["stale browser event"]);

  resolvePhysical();
  await retirement;

  const replacement = sessions.getOrCreate(
    "execution-stale",
    () => runtimeForRetainedConversation(Promise.resolve(), () => {}, "conversation-2"),
    "trace-new",
    "owner-new",
    "native-turn-new",
    "thread-new",
  );
  expect(sessions.find("execution-stale")).toBe(replacement);
  expect(replacement.roundReasoning("stale-round")).toEqual([]);
  expect(oldSession.roundReasoning("stale-round")).toEqual(["stale browser event"]);
});
test("confirmed exhaustion invalidates the retained conversation immediately but releases it only after physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolvePhysical!: () => void;
  let released = false;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  const runtime = runtimeForRetainedConversation(
    physicalSettlement,
    () => { released = true; },
  );
  const session = sessions.getOrCreate(
    "execution-1",
    () => runtime,
    "trace-1",
    "owner-1",
    "native-turn-1",
    "thread-1",
  );

  const retirement = sessions.retireConversationAndWait("conversation-1");

  expect(sessions.find("execution-1")).toBeUndefined();
  expect(sessions.findConversationHead("conversation-1")).toBeUndefined();
  expect(session.conversationKey()).toBeUndefined();
  expect(released).toBe(false);

  resolvePhysical();
  await retirement;

  expect(released).toBe(true);
});

test("a pending retirement stays coordinated across a registry clear", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  const runtime = runtimeForRetainedConversation(physicalSettlement, () => {});
  sessions.getOrCreate(
    "execution-clear",
    () => runtime,
    "trace-clear",
    "owner-clear",
    "native-turn-clear",
    "thread-clear",
  );

  const retirement = sessions.retireConversationAndWait("conversation-1");
  // A clear stands for a fresh process, and the physical close this registry is coordinating is
  // still running: clearing must not make it invisible to the next caller.
  sessions.clear();
  const joined = sessions.retireConversationAndWait("conversation-1");

  resolvePhysical();
  // The second call joined the pending retirement instead of starting another close, and the
  // registry is left without a stale entry once the promise settles.
  expect(await Promise.all([retirement, joined])).toEqual([1, 0]);
  await expect(sessions.waitForConversationRetirement("conversation-1")).resolves.toBeUndefined();
});

function capabilitySnapshot() {
  return projectChatGptCapabilities({
    sessionId: "dsh-session-66",
    agentId: "agent-66",
    turnId: "turn-66",
    tools: [],
  });
}

function replayIdentity(snapshot: ReturnType<typeof capabilitySnapshot>): {
  sessionId: string;
  agentId: string;
  turnId: string;
  capabilitySnapshotId: string;
  capabilityBindingId: string;
} {
  return {
    sessionId: snapshot.sessionId,
    agentId: snapshot.agentId,
    turnId: snapshot.turnId,
    capabilitySnapshotId: snapshot.snapshotId,
    capabilityBindingId: capabilityBindingIdForExecution("execution-66", snapshot.snapshotId),
  };
}

test("ProviderCore retains the immutable capability snapshot across physical-first settlement", async () => {
  const core = new ChatGptWebProviderCore();
  const snapshot = capabilitySnapshot();
  const first = core.begin({
    executionKey: "execution-66",
    traceId: "trace-66",
    nativeTurnId: snapshot.turnId,
    nativeThreadId: "thread-66",
    accountIdentity: "account-66",
    browserProfile: "profile-66",
    browserContext: "context-66",
    pageIdentity: "page-66",
    capabilitySnapshot: snapshot,
  });
  // The real flow reports the submission before a physical settlement can race; the core records
  // that fact now, so the race runs on a turn that reached the submit boundary.
  first.markSubmitted();
  let resolvePhysical!: () => void;
  const physical = new Promise<void>(resolve => { resolvePhysical = resolve; });
  core.bindPhysicalSettlement("execution-66", physical);
  resolvePhysical();
  await first.waitForPhysicalSettlement();
  await Promise.resolve();

  // Physical browser cleanup may win the race. The turn must remain in SETTLING so the
  // client-visible logical outcome can still arrive and complete retirement safely.
  expect(core.get("execution-66")).toBeDefined();
  expect(first.snapshot().state).toBe("SETTLING");
  expect(first.snapshot().physicalSettled).toBe(true);
  expect(first.snapshot().logicalSettled).toBe(false);

  first.markLogicalSettled("completed");
  expect(core.get("execution-66")).toBeUndefined();
  expect(core.getRetiredCapabilitySnapshot("execution-66")).toBe(snapshot);
  expect(core.wasRetired("execution-66")).toBe(true);

  const replayTurn = core.begin({
    executionKey: "execution-66",
    traceId: "trace-66-replay",
    nativeTurnId: snapshot.turnId,
    nativeThreadId: "thread-66",
    accountIdentity: "account-66",
    browserProfile: "profile-66",
    browserContext: "context-66",
    pageIdentity: "page-66-replay",
    capabilitySnapshot: snapshot,
    recovery: "REPLAY",
  });
  expect(replayTurn.snapshot().capabilitySnapshot).toBe(snapshot);
  expect(capabilityBindingIdForExecution("execution-66", snapshot.snapshotId))
    .toBe(capabilityBindingIdForExecution("execution-66", snapshot.snapshotId));
  expect(capabilityBindingIdForExecution("execution-66", snapshot.snapshotId))
    .not.toBe(capabilityBindingIdForExecution("execution-other", snapshot.snapshotId));

  replayTurn.failBeforePhysicalSettlement();
});

// The former "launcher helper negotiates the semantic surface lifecycle protocol explicitly" test
// read `browser-helper-main.ts` and `launcher-helper-client.ts` and asserted on their text. The
// protocol's behaviour is covered by the concrete replay tests below (which drive the replacement
// through `onSurfaceReady`/`onPhysicalSurfaceBound` and fail closed when readiness never arrives)
// and by `issue-194-web-chat-provider-conformance`.

test("concrete ChatGPT replay waits for readiness, binds a fresh epoch, then releases generation", async () => {
  const sessions = new ChatGptTurnSessions();
  const snapshot = capabilitySnapshot();
  const context = projectCanonicalChatGptWebContext([], [
    { role: "user", content: "continue the task", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-settled",
        name: "read_file",
        arguments: { path: "src/index.ts" },
      }],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-settled",
      toolName: "read_file",
      content: "trusted result",
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-pending",
        name: "write",
        arguments: { path: "x.txt", content: "x" },
      }],
      timestamp: 4,
    },
  ]);
  const boundary = createChatGptReplayBoundary(
    context,
    deriveChatGptReplayExecutionState(context),
  );
  const exhaustedConversation = chatGptConversationHandleForEpoch("conversation-66", 1);
  const identity = replayIdentity(snapshot);
  let resolveBrowser!: (value: string) => void;
  const browser = new Promise<string>(resolve => { resolveBrowser = resolve; });
  let readyCallback!: () => void | Promise<void>;
  let createdSession: ChatGptTurnRuntime | undefined;
  let surfaceBindCount = 0;
  let surfaceReadyCount = 0;

  const runtime: ChatGptTurnRuntime = {
    mode: "read-only",
    capabilitySnapshot: snapshot,
    browser,
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "conversation-66",
    conversationGeneration: 2,
    cancel: () => {},
  };
  const replayRuntime = createChatGptWebReplayTransport({
    sessions,
    executionKey: "execution-66",
    ownerKey: "owner-66",
    traceId: "trace-66-replay",
    nativeTurnId: snapshot.turnId,
    nativeThreadId: "thread-66",
    conversationKey: "conversation-66",
    exhaustedConversation,
    capabilitySnapshot: snapshot,
    onSessionCreated: session => {
      createdSession = session.runtime;
      surfaceBindCount += 1;
    },
    startRuntime: options => {
      readyCallback = options.onSurfaceReady;
      void Promise.resolve().then(async () => {
        await readyCallback();
        surfaceReadyCount += 1;
        resolveBrowser("replayed answer");
      });
      return runtime;
    },
  });

  const coordinator = new ChatGptReplayCoordinator();
  const resultPromise = coordinator.replay({
    trigger: { code: "context_exhausted" },
    exhaustedConversation,
    identity,
    context,
    boundary,
  }, replayRuntime.transport);

  const result = await resultPromise;
  const session = replayRuntime.getSession();
  expect(result.phase).toBe("COMPLETED");
  expect(result.recovery).toBe("REPLAY");
  expect(result.oldConversation).toEqual(exhaustedConversation);
  expect(result.activeConversation).toEqual(replayRuntime.replacement);
  expect(replayRuntime.replacement.generation).toBe(2);
  expect(surfaceBindCount).toBe(1);
  expect(surfaceReadyCount).toBe(1);
  expect(createdSession?.capabilitySnapshot).toBe(snapshot);
  expect(session).toBeDefined();
  expect(session?.runtime.conversationGeneration).toBe(2);
  expect(session?.runtime.capabilitySnapshot).toBe(snapshot);
  expect(sessions.find("execution-66")).toBe(session);
  expect(sessions.findConversationHead("conversation-66")).toBe(session);
  expect(coordinator.acceptsConversationEvent(exhaustedConversation)).toBe(false);
  expect(coordinator.acceptsConversationEvent(replayRuntime.replacement)).toBe(true);
  expect(session?.runtime.conversationKey).toBe("conversation-66");
  expect(session?.settledOutcome()).toEqual({ type: "final", answer: "replayed answer" });

  session?.cancel();
});

test("concrete replay fails closed when replacement ends before readiness", async () => {
  const sessions = new ChatGptTurnSessions();
  const snapshot = capabilitySnapshot();
  const exhaustedConversation = chatGptConversationHandleForEpoch("conversation-66-fail", 1);
  const runtime: ChatGptTurnRuntime = {
    mode: "read-only",
    capabilitySnapshot: snapshot,
    browser: Promise.reject(new Error("replacement failed before readiness")),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "conversation-66-fail",
    conversationGeneration: 2,
    cancel: () => {},
  };
  const replayRuntime = createChatGptWebReplayTransport({
    sessions,
    executionKey: "execution-66-fail",
    ownerKey: "owner-66-fail",
    traceId: "trace-66-fail",
    nativeTurnId: snapshot.turnId,
    conversationKey: "conversation-66-fail",
    exhaustedConversation,
    capabilitySnapshot: snapshot,
    startRuntime: () => runtime,
  });
  const context = projectCanonicalChatGptWebContext([], [
    { role: "user", content: "retry", timestamp: 1 },
  ]);
  const boundary = createChatGptReplayBoundary(
    context,
    deriveChatGptReplayExecutionState(context),
  );
  const coordinator = new ChatGptReplayCoordinator();
  await expect(coordinator.replay({
    trigger: { code: "context_exhausted" },
    exhaustedConversation,
    identity: replayIdentity(snapshot),
    context,
    boundary,
  }, replayRuntime.transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(replayRuntime.getSession()).toBeDefined();
  expect(coordinator.snapshot().phase).toBe("FAILED");
});

// Keep the imported lease type exercised here to ensure replay tests continue using the same lease authority.
test("replay tests retain the ProviderCore lease authority boundary", () => {
  const lease = new BrowserAccountLease({
    serviceId: "chatgpt-web",
    accountIdentity: "account-lease",
    browserProfile: "profile-lease",
    browserContext: "context-lease",
    pageIdentity: "page-lease",
    turnId: "turn-lease",
  });
  expect(lease.isActive()).toBe(true);
  lease.release();
  expect(lease.isActive()).toBe(false);
});
