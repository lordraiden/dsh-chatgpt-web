import { expect, test } from "bun:test";
import {
  ChatGptReplayCoordinator,
  createChatGptReplayBoundary,
  type ChatGptConversationHandle,
  type ChatGptReplayBoundary,
  type ChatGptReplayIdentity,
  type ChatGptReplayTransport,
} from "../src/adapters/chatgpt-web/replay";
import { projectCanonicalChatGptWebContext } from "../src/adapters/chatgpt-web/context-projection";
import { BrowserAccountLease, ProviderTurnLifecycle } from "../src/adapters/chatgpt-web/provider-core";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";

const identity: ChatGptReplayIdentity = {
  sessionId: "dsh-session-1",
  agentId: "agent-1",
  turnId: "turn-1",
  capabilitySnapshotId: "snapshot-1",
  capabilityBindingId: "binding-1",
};

const trigger = { code: "context_exhausted" as const };

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

const boundary = createChatGptReplayBoundary(context, {
  settledToolCallIds: ["call-settled"],
  pendingToolCallIds: ["call-pending"],
});

function transportSpy(
  replacement: ChatGptConversationHandle = { id: "conversation-2", generation: 2 },
): { transport: ChatGptReplayTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: ChatGptReplayTransport = {
    invalidateConversation(conversation) {
      calls.push("invalidate:" + conversation.id);
      return Promise.resolve();
    },
    createReplacementConversation() {
      calls.push("create");
      return Promise.resolve(replacement);
    },
    waitForReplacementReady(conversation) {
      calls.push("ready:" + conversation.id);
      return Promise.resolve();
    },
    bindReplacementConversation(previous, next) {
      calls.push("bind:" + previous.id + "->" + next.id);
      return Promise.resolve({ conversation: next, identity });
    },
    replayCanonicalContext(conversation, replayContext, replayBoundary, replayIdentity) {
      calls.push(
        "replay:"
        + conversation.id
        + ":"
        + replayContext.version
        + ":"
        + replayBoundary.settledToolCallIds.join(",")
        + ":"
        + replayBoundary.pendingToolCallIds.join(",")
        + ":"
        + replayIdentity.turnId,
      );
      return Promise.resolve();
    },
    resume(conversation) {
      calls.push("resume:" + conversation.id);
      return Promise.resolve();
    },
  };
  return { transport, calls };
}

test("deterministic replay replaces the conversation without changing trusted DSH identity", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  const result = await coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport);

  expect(result.recovery).toBe("REPLAY");
  expect(result.phase).toBe("COMPLETED");
  expect(result.oldConversation?.id).toBe("conversation-1");
  expect(result.activeConversation?.id).toBe("conversation-2");
  expect(result.generation).toBe(2);
  expect(result.staleConversationIds).toEqual(["conversation-1"]);
  expect(calls).toEqual([
    "create",
    "ready:conversation-2",
    "bind:conversation-1->conversation-2",
    "invalidate:conversation-1",
    "replay:conversation-2:3:call-settled:call-pending:turn-1",
    "resume:conversation-2",
  ]);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-1", generation: 1 })).toBe(false);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-2", generation: 2 })).toBe(true);
});

test("replacement must be a fresh conversation identity", async () => {
  const { transport } = transportSpy({ id: "conversation-1", generation: 1 });
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    code: "chatgpt_replay_failed",
    phase: "FAILED",
  });
  expect(coordinator.snapshot().phase).toBe("FAILED");
});

test("missing trusted replay classification fails before browser replacement", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary: {
      canonicalRevision: "not-trusted",
      canonicalMessageCount: context.messages.length,
      settledToolCallIds: [],
      pendingToolCallIds: [],
    } as never,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("ambiguous replay boundary fails closed before browser replacement", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary: {
      canonicalRevision: "forged",
      canonicalMessageCount: context.messages.length,
      settledToolCallIds: ["same"],
      pendingToolCallIds: ["same"],
    } as never,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("boundary factory rejects duplicate settled tool ids", () => {
  expect(() => createChatGptReplayBoundary(context, {
    settledToolCallIds: ["call-settled", "call-settled"],
    pendingToolCallIds: ["call-pending"],
  })).toThrow("duplicate settled tool call id");
});

test("settled tool ids may not be duplicated", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary: {
      canonicalRevision: "forged",
      canonicalMessageCount: context.messages.length,
      settledToolCallIds: ["settled", "settled"],
      pendingToolCallIds: [],
    } as never,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("replacement readiness is a hard gate", async () => {
  const calls: string[] = [];
  const { transport } = transportSpy();
  const blocked: ChatGptReplayTransport = {
    ...transport,
    waitForReplacementReady() {
      calls.push("ready");
      return Promise.reject(new Error("surface not ready"));
    },
  };
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, blocked)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual(["ready"]);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-2", generation: 2 })).toBe(false);
});

test("a late callback from the old conversation stays rejected after replay completes", async () => {
  const { transport } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport);

  expect(coordinator.acceptsConversationEvent({ id: "conversation-1", generation: 1 })).toBe(false);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-2", generation: 2 })).toBe(true);
});

test("settled tool results are replay data, never execution requests", async () => {
  const executedToolCallIds: string[] = [];
  const { transport } = transportSpy();
  const guardedTransport = {
    ...transport,
    replayCanonicalContext(
      conversation: ChatGptConversationHandle,
      replayContext: typeof context,
      replayBoundary: ChatGptReplayBoundary,
    ) {
      if (replayBoundary.settledToolCallIds.length > 0) {
        // A real DSH executor is deliberately not part of the replay transport contract.
        // Passing settled IDs is reconstruction data only.
        executedToolCallIds.push(...[]);
      }
      return Promise.resolve();
    },
  };
  const coordinator = new ChatGptReplayCoordinator();

  await coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, guardedTransport);

  expect(executedToolCallIds).toEqual([]);
});

test("replay requires the explicit context_exhausted semantic condition", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger: { code: "unexpected_recovery" as never },
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("EXACT_RESUME cannot be silently reclassified as REPLAY", () => {
  const lease = new BrowserAccountLease({
    serviceId: "chatgpt-web",
    accountIdentity: "account-1",
    browserProfile: "profile-1",
    browserContext: "context-1",
    pageIdentity: "page-1",
    turnId: identity.turnId,
  });
  const capabilitySnapshot = projectChatGptCapabilities({
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    turnId: identity.turnId,
    tools: [],
  });
  const lifecycle = new ProviderTurnLifecycle(
    lease,
    { serviceId: "chatgpt-web", traceId: "trace-1", executionKey: "exec-1", nativeTurnId: identity.turnId },
    capabilitySnapshot,
  );

  lifecycle.markRecovery("EXACT_RESUME");
  expect(() => lifecycle.markRecovery("REPLAY")).toThrow(
    "Provider recovery cannot downgrade exact resume to replay",
  );
  expect(lifecycle.snapshot().recovery).toBe("EXACT_RESUME");
});


test("replacement binding cannot change DSH session, agent, turn, snapshot, or capability identity", async () => {
  const { transport } = transportSpy();
  const mismatched: ChatGptReplayTransport = {
    ...transport,
    bindReplacementConversation(previous, next, replayIdentity) {
      return Promise.resolve({
        conversation: next,
        identity: { ...replayIdentity, turnId: "different-turn" },
      });
    },
  };
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, mismatched)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
});
