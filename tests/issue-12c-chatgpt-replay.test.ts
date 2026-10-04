import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
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
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";
import { ChatGptTextFeed, ChatGptTraceFeed, type ChatGptTurnRuntime, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

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

test("ProviderCore reuses the immutable capability snapshot after physical retirement", async () => {
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
  let resolvePhysical!: () => void;
  const physical = new Promise<void>(resolve => { resolvePhysical = resolve; });
  core.bindPhysicalSettlement("execution-66", physical);
  resolvePhysical();
  await first.waitForPhysicalSettlement();
  await Promise.resolve();

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

test("launcher helper negotiates the semantic surface lifecycle protocol explicitly", () => {
  const root = join(import.meta.dir, "..");
  const helperMain = readFileSync(join(root, "src", "adapters", "chatgpt-web", "browser-helper-main.ts"), "utf8");
  const helperClient = readFileSync(join(root, "src", "adapters", "chatgpt-web", "launcher-helper-client.ts"), "utf8");
  expect(helperMain).toContain('"surface-lifecycle"');
  expect(helperMain).toContain('event: "surface_bound"');
  expect(helperMain).toContain('event: "surface_ready"');
  expect(helperClient).toContain('"surface_ready_ack"');
  expect(helperClient).toContain("surfaceBinding");
});

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
    running: Promise.resolve(),
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
    running: Promise.resolve(),
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
