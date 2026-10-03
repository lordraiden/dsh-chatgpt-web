import { expect, test } from "bun:test";
import {
  ChatGptReplayRecoveryError,
  ChatGptWebReplayCoordinator,
  validateChatGptReplayBoundary,
  type ChatGptReplayIdentity,
  type ChatGptReplacementBinding,
  type ChatGptReplacementReady,
  type ChatGptWebRecoveryTransport,
} from "../src/adapters/chatgpt-web/replay-recovery";
import { projectCanonicalChatGptWebContext } from "../src/adapters/chatgpt-web/context-projection";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import type { CodexMessage } from "../src/types";

const identity: ChatGptReplayIdentity = Object.freeze({
  dshSessionId: "session-1",
  agentId: "agent-1",
  turnId: "turn-1",
  capabilitySnapshotId: "snapshot-1",
  capabilityBindingId: "binding-1",
});

const canonicalContext = projectCanonicalChatGptWebContext(
  ["system policy"],
  [
    { role: "developer", content: "required developer policy", timestamp: 1 },
    { role: "user", content: "Inspect the repository", timestamp: 2 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-settled",
        name: "read",
        arguments: { path: "README.md" },
      }],
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "call-settled",
      toolName: "read",
      content: "README contents",
      isError: false,
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-pending",
        name: "write",
        arguments: { path: "x.txt", content: "x" },
      }],
      timestamp: 5,
    },
  ] satisfies CodexMessage[],
);

const replayBoundary = {
  canonicalRevision: "dsh-revision-7",
  canonicalMessageCount: canonicalContext.messages.length,
  settledToolCallIds: ["call-settled"],
  pendingToolCallIds: ["call-pending"],
} as const;

function fakeTransport(
  overrides: Partial<ChatGptWebRecoveryTransport> = {},
  log: string[] = [],
): ChatGptWebRecoveryTransport {
  const replacement = {
    conversationHandle: "chatgpt-conversation-2",
    transportGeneration: "generation-2",
  };
  const ready: ChatGptReplacementReady = {
    ...replacement,
    readinessProof: "composer-ready:generation-2",
  };
  const binding: ChatGptReplacementBinding = {
    ...ready,
    identityProof: identity,
  };
  return {
    async invalidateConversation(handle) {
      log.push(`invalidate:${handle}`);
    },
    async createReplacementConversation() {
      log.push("create");
      return replacement;
    },
    async confirmReplacementReady(candidate) {
      log.push(`ready:${candidate.conversationHandle}`);
      return ready;
    },
    async bindReplacement(candidate) {
      log.push(`bind:${candidate.conversationHandle}`);
      return binding;
    },
    ...overrides,
  };
}

test("normal continuity starts as EXACT_RESUME and only explicit exhaustion enters REPLAY", () => {
  const coordinator = new ChatGptWebReplayCoordinator(identity, "chatgpt-conversation-1");

  expect(coordinator.snapshot().continuity).toBe("EXACT_RESUME");
  expect(coordinator.snapshot().phase).toBe("BOUND");
  coordinator.assertCurrentConversation("chatgpt-conversation-1");

  coordinator.reportContextExhausted("chatgpt-conversation-1");

  expect(coordinator.snapshot().continuity).toBe("REPLAY");
  expect(coordinator.snapshot().phase).toBe("CONTEXT_EXHAUSTED");
});

test("context exhaustion fences the old conversation immediately", () => {
  const coordinator = new ChatGptWebReplayCoordinator(identity, "chatgpt-conversation-1");

  coordinator.reportContextExhausted("chatgpt-conversation-1");

  expect(() => coordinator.assertCurrentConversation("chatgpt-conversation-1")).toThrowError(
    /stale or retired|retired or stale/i,
  );
  expect(coordinator.snapshot().retiredConversationHandles).toEqual(["chatgpt-conversation-1"]);
});

test("replay replaces the ChatGPT conversation while preserving DSH identity", async () => {
  const log: string[] = [];
  const coordinator = new ChatGptWebReplayCoordinator(identity, "chatgpt-conversation-1");
  coordinator.reportContextExhausted("chatgpt-conversation-1");

  const plan = await coordinator.recover(
    { canonicalContext, replayBoundary },
    fakeTransport({}, log),
  );

  expect(log).toEqual([
    "invalidate:chatgpt-conversation-1",
    "create",
    "ready:chatgpt-conversation-2",
    "bind:chatgpt-conversation-2",
  ]);
  expect(plan.identity).toEqual(identity);
  expect(plan.conversationHandle).toBe("chatgpt-conversation-2");
  expect(plan.settledToolCallIds).toEqual(["call-settled"]);
  expect(plan.pendingToolCallIds).toEqual(["call-pending"]);
  expect(plan.canonicalJson).toContain("required developer policy");
  expect(plan.canonicalJson).toContain("call-settled");
  expect(plan.canonicalJson).not.toContain("chatgpt-conversation-1");
  expect(plan.canonicalJson).not.toContain("chatgpt-conversation-2");
  expect(coordinator.snapshot().continuity).toBe("REPLAY");
  expect(coordinator.snapshot().phase).toBe("RESUMED");
  expect(coordinator.snapshot().conversationHandle).toBe("chatgpt-conversation-2");
  expect(coordinator.snapshot().identity).toEqual(identity);
  coordinator.assertResumed();
  coordinator.assertCurrentConversation("chatgpt-conversation-2");
  expect(() => coordinator.assertCurrentConversation("chatgpt-conversation-1")).toThrowError(
    /stale or retired|retired or stale/i,
  );
});

test("canonical replay serialization is deterministic for identical trusted DSH state", async () => {
  const first = new ChatGptWebReplayCoordinator(identity, "old-1");
  const second = new ChatGptWebReplayCoordinator(identity, "old-2");
  first.reportContextExhausted("old-1");
  second.reportContextExhausted("old-2");

  const [a, b] = await Promise.all([
    first.recover({ canonicalContext, replayBoundary }, fakeTransport()),
    second.recover({ canonicalContext, replayBoundary }, fakeTransport()),
  ]);

  expect(a.canonicalJson).toBe(b.canonicalJson);
  expect(a.canonicalRevision).toBe("dsh-revision-7");
  expect(a.canonicalJson).not.toContain("chatgpt-conversation");
});

test("settled tool results remain data and pending tools remain the only pending execution identities", () => {
  const boundary = validateChatGptReplayBoundary(canonicalContext, replayBoundary);

  expect(boundary.settledToolCallIds).toEqual(["call-settled"]);
  expect(boundary.pendingToolCallIds).toEqual(["call-pending"]);
});

test("ambiguous replay boundaries fail closed", () => {
  expect(() => validateChatGptReplayBoundary(canonicalContext, {
    ...replayBoundary,
    pendingToolCallIds: [],
  })).toThrowError(ChatGptReplayRecoveryError);

  expect(() => validateChatGptReplayBoundary(canonicalContext, {
    ...replayBoundary,
    settledToolCallIds: ["call-settled", "call-pending"],
  })).toThrowError(ChatGptReplayRecoveryError);

  expect(() => validateChatGptReplayBoundary(canonicalContext, {
    ...replayBoundary,
    settledToolCallIds: ["call-settled", "unknown"],
  })).toThrowError(/unknown tool call|missing/i);
});

test("replacement readiness failure becomes deterministic FAILED recovery", async () => {
  const coordinator = new ChatGptWebReplayCoordinator(identity, "old");
  coordinator.reportContextExhausted("old");

  await expect(
    coordinator.recover(
      { canonicalContext, replayBoundary },
      fakeTransport({
        async confirmReplacementReady(candidate) {
          return { ...candidate, readinessProof: "" };
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "replacement_not_ready" });

  expect(coordinator.snapshot().phase).toBe("FAILED");
  expect(coordinator.snapshot().continuity).toBe("FAILED");
});

test("replacement creation failure never falls back to the exhausted conversation", async () => {
  const coordinator = new ChatGptWebReplayCoordinator(identity, "old");
  coordinator.reportContextExhausted("old");

  await expect(
    coordinator.recover(
      { canonicalContext, replayBoundary },
      fakeTransport({
        async createReplacementConversation() {
          throw new Error("cannot create replacement");
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "replacement_failed" });

  expect(coordinator.snapshot().phase).toBe("FAILED");
  expect(coordinator.snapshot().conversationHandle).toBe("old");
});

test("replacement cannot change trusted DSH identity", async () => {
  const coordinator = new ChatGptWebReplayCoordinator(identity, "old");
  coordinator.reportContextExhausted("old");

  await expect(
    coordinator.recover(
      { canonicalContext, replayBoundary },
      fakeTransport({
        async bindReplacement(candidate) {
          return {
            ...candidate,
            identityProof: { ...identity, turnId: "different-turn" },
          };
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "replacement_identity_mismatch" });

  expect(coordinator.snapshot().phase).toBe("FAILED");
  expect(coordinator.snapshot().continuity).toBe("FAILED");
});

test("same replacement handle as the exhausted conversation is rejected", async () => {
  const coordinator = new ChatGptWebReplayCoordinator(identity, "old");
  coordinator.reportContextExhausted("old");

  await expect(
    coordinator.recover(
      { canonicalContext, replayBoundary },
      fakeTransport({
        async createReplacementConversation() {
          return { conversationHandle: "old", transportGeneration: "generation-2" };
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "replacement_handle_invalid" });

  expect(coordinator.snapshot().continuity).toBe("FAILED");
});

test("ProviderCore permits only an explicit context-exhaustion transition from EXACT_RESUME to REPLAY", () => {
  const core = new ChatGptWebProviderCore();
  const turn = core.begin({
    executionKey: "execution-1",
    traceId: "trace-1",
    nativeTurnId: identity.turnId,
    nativeThreadId: "thread-1",
    accountIdentity: "account-1",
    browserProfile: "profile-1",
    browserContext: "context-1",
    pageIdentity: "page-1",
    capabilitySnapshot: {
      snapshotId: identity.capabilitySnapshotId,
      sessionId: identity.dshSessionId,
      agentId: identity.agentId,
      turnId: identity.turnId,
      createdAt: Date.now(),
      lifecycle: "active",
      tools: [],
    },
    recovery: "EXACT_RESUME",
  });

  expect(() => turn.markRecovery("REPLAY")).toThrowError(/cannot downgrade exact resume/i);
  turn.markReplayForContextExhaustion();
  expect(turn.snapshot().recovery).toBe("REPLAY");
  expect(turn.snapshot().recoveryReason).toBe("context_exhausted");
  turn.failBeforePhysicalSettlement();
});
