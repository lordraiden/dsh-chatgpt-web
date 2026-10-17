import { describe, expect, test } from "bun:test";

import { CHATGPT_SETTLEMENT_WAIT_TIMEOUT_CODE } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  DEFAULT_SETTLEMENT_WAIT_GRACE_MS,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";

/**
 * Issue #301 — a turn must never wait forever for a previous turn's physical settlement.
 *
 * The real incident: a retained ChatGPT surface was held by a turn whose operation never published
 * a physical settlement (the page stopped answering), and the next request for that conversation
 * waited on that settlement with no bound at all — no error, no progress, no `context-budget`, for
 * hours, while `/healthz` answered `accepting_turns: true`.
 *
 * The owner tested here is the lease/await lifetime itself (`ChatGptTurnSessions`): it decides who
 * waits for whose physical settlement. Every such wait is bounded (issue #301) and a bound that
 * expires produces an explicit typed outcome and retires the wedged session — never a silent hang
 * and never a success claim.
 *
 * Browser-free and deterministic: the physical resource is a session whose settlement promise never
 * resolves, exactly the shape a dead/unresponsive retained surface presents to this layer.
 */
const SETTLEMENT_TIMEOUT_CODE = CHATGPT_SETTLEMENT_WAIT_TIMEOUT_CODE;

/** A settlement that never lands: the physical operation never proved what happened. */
const neverSettles = (): Promise<never> => new Promise<never>(() => {});

interface WedgedRuntimeOptions {
  readonly conversationKey?: string;
  readonly onCancel?: (reason?: Error) => void;
}

function runtime(options: WedgedRuntimeOptions = {}): ChatGptTurnRuntime {
  return {
    mode: "read-only",
    capabilitySnapshot: {
      snapshotId: "snapshot-1",
      sessionId: "session-1",
      agentId: "agent-1",
      turnId: "turn-1",
    } as never,
    browser: neverSettles(),
    physicalSettlement: neverSettles(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: (reason?: Error) => options.onCancel?.(reason),
    ...(options.conversationKey !== undefined ? { conversationKey: options.conversationKey } : {}),
  } as unknown as ChatGptTurnRuntime;
}

/** Resolve what a turn-level wait did, without letting the test itself hang. */
async function settleOrHang<T>(work: Promise<T>, budgetMs = 1_500): Promise<{ state: "settled"; value: T } | { state: "rejected"; error: unknown } | { state: "hung" }> {
  return Promise.race([
    work.then(
      value => ({ state: "settled" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    ),
    new Promise<{ state: "hung" }>(resolve => setTimeout(() => resolve({ state: "hung" }), budgetMs)),
  ]);
}

const GRACE_MS = 25;

describe("issue #301 — the wait on a previous turn's physical settlement is bounded", () => {
  test("a predecessor that never publishes a settlement cannot hold the next turn forever", async () => {
    const cancellations: Array<Error | undefined> = [];
    const sessions = new ChatGptTurnSessions(30 * 60_000, 256, GRACE_MS);
    // Turn A: owns the conversation, holds the physical resource, and never settles it.
    sessions.getOrCreate("key-a", () => runtime({ conversationKey: "conv-1", onCancel: r => cancellations.push(r) }), "trace-a", "owner-1", "turn-a", "thread-1");

    // Turn B: same owner, different execution — the sequential work the registry serializes.
    const outcome = await settleOrHang(
      sessions.getOrCreateAfterOwnerRetirement("key-b", "owner-1", () => runtime({ conversationKey: "conv-1" }), "trace-b", undefined, "turn-b", "thread-1"),
    );

    // On the unfixed tree this never settles: the test fails here (a real hang), which is the point.
    expect(outcome.state).toBe("rejected");
    if (outcome.state !== "rejected") return;
    const error = outcome.error as { code?: string; message?: string };
    expect(error.code).toBe(SETTLEMENT_TIMEOUT_CODE);
    // Explicit and actionable: the caller is told what the service did and what it can do.
    expect(error.message).toMatch(/settlement/i);
    expect(error.message).toMatch(/retr|restart|clear|previous/i);

    // The wedged session is retired, never reused: gone from the registry and its runtime cancelled
    // (the physical owner is asked to abort and publish a `rejected` settlement).
    expect(sessions.find("key-a")).toBeUndefined();
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.message).toMatch(/settlement/i);
  });

  test("a later turn is not wedged: it fails closed while the settlement is unproven, and recovers when it lands", async () => {
    const sessions = new ChatGptTurnSessions(30 * 60_000, 256, GRACE_MS);
    let proveSettlement: () => void = () => {};
    const settlement = new Promise<void>(resolve => { proveSettlement = resolve; });
    sessions.getOrCreate("key-a", () => ({
      ...runtime({ conversationKey: "conv-1" }),
      physicalSettlement: settlement,
    }) as unknown as ChatGptTurnRuntime, "trace-a", "owner-1", "turn-a", "thread-1");
    const first = await settleOrHang(
      sessions.getOrCreateAfterOwnerRetirement("key-b", "owner-1", () => runtime({ conversationKey: "conv-1" }), "trace-b", undefined, "turn-b", "thread-1"),
    );
    expect(first.state).toBe("rejected");

    // Closed, never a silent replacement conversation: while the settlement stays unproven the next
    // turn takes the same explicit bounded outcome instead of hanging.
    const second = await settleOrHang(
      sessions.getOrCreateAfterOwnerRetirement("key-c", "owner-1", () => runtime({ conversationKey: "conv-1" }), "trace-c", undefined, "turn-c", "thread-1"),
    );
    expect(second.state).toBe("rejected");

    // Legitimate recovery, with no operator action: the predecessor's physical settlement finally
    // lands, so the next turn is admitted normally.
    proveSettlement();
    const third = await settleOrHang(
      sessions.getOrCreateAfterOwnerRetirement("key-d", "owner-1", () => runtime({ conversationKey: "conv-1" }), "trace-d", undefined, "turn-d", "thread-1"),
    );
    expect(third.state).toBe("settled");
  });

  test("a settlement that does resolve is still awaited, not cut short by the bound", async () => {
    const sessions = new ChatGptTurnSessions(30 * 60_000, 256, GRACE_MS);
    let cancelled = false;
    const settling = new Promise<void>(resolve => setTimeout(resolve, 5));
    sessions.getOrCreate("key-a", () => ({
      ...runtime({ conversationKey: "conv-1", onCancel: () => { cancelled = true; } }),
      physicalSettlement: settling,
    }) as unknown as ChatGptTurnRuntime, "trace-a", "owner-1", "turn-a", "thread-1");

    const outcome = await settleOrHang(
      sessions.getOrCreateAfterOwnerRetirement("key-b", "owner-1", () => runtime({ conversationKey: "conv-1" }), "trace-b", undefined, "turn-b", "thread-1"),
    );

    // The predecessor settled well inside the grace: the wait returns the successor session.
    expect(outcome.state).toBe("settled");
    if (outcome.state !== "settled") return;
    expect(outcome.value.ownerKey).toBe("owner-1");
    // The predecessor's runtime was never cancelled: the bound did not preempt a real settlement.
    expect(cancelled).toBe(false);
  });

  test("a caller cancellation still ends the wait immediately, before the grace", async () => {
    const sessions = new ChatGptTurnSessions(30 * 60_000, 256, GRACE_MS);
    sessions.getOrCreate("key-a", () => runtime({ conversationKey: "conv-1" }), "trace-a", "owner-1", "turn-a", "thread-1");
    const controller = new AbortController();
    const waiting = sessions.getOrCreateAfterOwnerRetirement(
      "key-b", "owner-1", () => runtime({ conversationKey: "conv-1" }), "trace-b", controller.signal, "turn-b", "thread-1",
    );
    setTimeout(() => controller.abort(), 2);
    const outcome = await settleOrHang(waiting);
    expect(outcome.state).toBe("rejected");
    if (outcome.state !== "rejected") return;
    expect((outcome.error as DOMException).name).toBe("AbortError");
  });

  test("retiring a wedged conversation is bounded too", async () => {
    const sessions = new ChatGptTurnSessions(30 * 60_000, 256, GRACE_MS);
    sessions.getOrCreate("key-a", () => runtime({ conversationKey: "conv-1" }), "trace-a", "owner-1", "turn-a", "thread-1");
    const outcome = await settleOrHang(sessions.retireConversationAndWait("conv-1"));
    expect(outcome.state).toBe("rejected");
    if (outcome.state !== "rejected") return;
    expect((outcome.error as { code?: string }).code).toBe(SETTLEMENT_TIMEOUT_CODE);
  });

  test("the default grace leaves room for a legitimate launcher teardown", () => {
    // The launcher's turn-end acknowledgement alone is allowed 15s; the grace must not cut a real
    // settlement short, so it is a multiple of it.
    expect(DEFAULT_SETTLEMENT_WAIT_GRACE_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("a non-positive grace is rejected at construction", () => {
    expect(() => new ChatGptTurnSessions(30 * 60_000, 256, 0)).toThrow();
    expect(() => new ChatGptTurnSessions(30 * 60_000, 256, Number.NaN)).toThrow();
  });
});
