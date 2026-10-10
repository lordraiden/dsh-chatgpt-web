import { describe, expect, test } from "bun:test";

import {
  chatGptWebChatExchangeStateOf,
  chatGptWebChatLeaseShapeOf,
  chatGptWebChatLogicalSettlementOf,
  chatGptWebChatPhysicalSettlementOf,
  chatGptWebChatRetryRefusalOf,
  chatGptWebChatSubmissionPhaseOf,
} from "../src/adapters/chatgpt-web/web-chat-exchange-bridge";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import type { CapabilitySnapshot } from "../src/adapters/chatgpt-web/capability-projector";
import {
  WebChatExchangeLifecycle,
  decideWebChatRetry,
  webChatRetrySafetyOf,
  webChatError,
  type WebChatExchangeEvent,
  type WebChatSubmissionPhase,
  type WebChatTurnIdentity,
} from "../src/web-chat/core";
import {
  createWebChatExchange,
  createWebChatTransportLeaseRegistry,
  type WebChatExchangeRunner,
  type WebChatTextTransport,
  type WebChatTextTransportContext,
  type WebChatTransportLeaseRegistry,
  type WebChatTransportResource,
} from "../src/web-chat/transport";

/**
 * Issue #191 — exchange lifecycle, retry authority and transport ownership.
 *
 * Pins the monotonic state machine, the submission boundary as the retry boundary, the separation of
 * logical and physical settlement, cancellation and stale-result protection, and the lease's
 * ownership rules — then holds the existing provider lifecycle against them as migration evidence.
 */

const IDENTITY: WebChatTurnIdentity = {
  bindingId: "binding-1",
  conversationKey: "conversation-key-1",
  turnId: "turn-1",
  dshSessionId: "session-1",
};

const TURN = {
  userText: "arregla el bug",
  model: "model-1",
} as const;

function lifecycle(options: { epoch?: number; maxSubmits?: number } = {}) {
  return new WebChatExchangeLifecycle({
    exchangeId: "exchange-1",
    conversationKey: "conversation-key-1",
    epoch: options.epoch ?? 1,
    ...(options.maxSubmits !== undefined ? { maxSubmits: options.maxSubmits } : {}),
  });
}

/** A transport whose every reported fact is scripted, so the core's semantics are under test. */
function scriptedTransport(script: {
  ready?: () => Promise<void>;
  phases?: WebChatSubmissionPhase[];
  events?: WebChatExchangeEvent[];
  settlement?: () => Promise<ReturnType<typeof settlementOf>>;
} = {}) {
  const calls = { ready: 0, submit: 0, stream: 0, settle: 0, abort: 0 };
  const phases = [...(script.phases ?? ["accepted"])];
  const events = script.events ?? [
    { type: "text_delta", text: "hola" },
    { type: "completed", text: "hola" },
  ];
  const transport: WebChatTextTransport = {
    id: "scripted",
    async ready(_context: WebChatTextTransportContext) {
      calls.ready += 1;
      if (script.ready) await script.ready();
    },
    async submit(_context: WebChatTextTransportContext) {
      calls.submit += 1;
      return phases.shift() ?? "accepted";
    },
    async *stream(_context: WebChatTextTransportContext) {
      calls.stream += 1;
      for (const event of events) yield event;
    },
    async settle(_context: WebChatTextTransportContext) {
      calls.settle += 1;
      return script.settlement ? await script.settlement() : "fulfilled";
    },
    async abort() {
      calls.abort += 1;
    },
  };
  return { transport, calls };
}

function settlementOf(): "not_started" | "pending" | "fulfilled" | "rejected" {
  return "fulfilled";
}

function resource(epoch = 1): WebChatTransportResource {
  return { id: "resource-1", conversationKey: "conversation-key-1", epoch };
}

async function runnerWith(
  transport: WebChatTextTransport,
  options: { leases?: WebChatTransportLeaseRegistry; maxSubmits?: number; epoch?: number } = {},
): Promise<{ exchange: WebChatExchangeRunner; leases: WebChatTransportLeaseRegistry }> {
  const leases = options.leases ?? createWebChatTransportLeaseRegistry();
  const exchange = createWebChatExchange({
    identity: IDENTITY,
    turn: TURN,
    transport,
    leases,
    createResource: async () => resource(options.epoch ?? 1),
    ...(options.maxSubmits !== undefined ? { maxSubmits: options.maxSubmits } : {}),
    ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
  });
  return { exchange, leases };
}

async function collect(exchange: WebChatExchangeRunner): Promise<WebChatExchangeEvent[]> {
  const events: WebChatExchangeEvent[] = [];
  for await (const event of exchange.stream()) events.push(event);
  return events;
}

describe("issue #191 — the exchange state machine is monotonic and testable", () => {
  test("the architecture §9 path is accepted in order", () => {
    const exchange = lifecycle();
    expect(exchange.snapshot().state).toBe("CREATED");
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    expect(exchange.snapshot().phase).toBe("prepared");
    exchange.markSubmitted();
    expect(exchange.snapshot().phase).toBe("accepted");
    exchange.markStreaming();
    exchange.markCompleted();
    const snapshot = exchange.snapshot();
    expect(snapshot.state).toBe("COMPLETED");
    expect(snapshot.logical).toBe("completed");
    expect(snapshot.submits).toBe(1);
  });

  test("illegal transitions are refused with a typed failure", () => {
    const exchange = lifecycle();
    expect(() => exchange.markStreaming()).toThrow(/Streaming cannot start from CREATED|Invalid exchange transition/);
    exchange.markPreparing();
    exchange.markTransportReady();
    expect(() => exchange.markCompleted()).toThrow(/Invalid exchange transition: TRANSPORT_READY -> COMPLETED/);
    expect(() => exchange.markStreaming()).toThrow(webChatError("CONVERSATION_STATE_MISMATCH", "x").constructor);
  });

  test("terminal states cannot change state", () => {
    for (const settle of ["markCompleted", "markCancelled", "markFailed"] as const) {
      const exchange = lifecycle();
      exchange.markPreparing();
      exchange.markTransportReady();
      exchange.markSubmitting();
      exchange.markSubmitted();
      exchange.markStreaming();
      exchange[settle]();
      expect(exchange.isTerminal()).toBe(true);
      expect(() => exchange.markStreaming()).toThrow(/cannot change state|cannot accept lifecycle mutations|Streaming cannot start/);
      expect(() => exchange.markFailed()).toThrow(/cannot change state|cannot accept lifecycle mutations|Cannot settle|already settled logically/);
    }

    // An ambiguous exchange is terminal for its outcome, but the provider may still establish how it
    // ended: that resolution is the one legal movement left, and nothing else is.
    const ambiguous = lifecycle();
    ambiguous.markPreparing();
    ambiguous.markTransportReady();
    ambiguous.markSubmitting();
    ambiguous.markSendActivated();
    expect(ambiguous.isTerminal()).toBe(true);
    expect(() => ambiguous.markStreaming()).toThrow(/cannot change state|Streaming cannot start/);
    expect(() => ambiguous.markSubmitted()).toThrow(/cannot change state/);
    ambiguous.markFailed();
    expect(ambiguous.snapshot().state).toBe("FAILED");
  });

  test("a submission attempt beyond the budget is refused", () => {
    const exchange = lifecycle({ maxSubmits: 1 });
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    expect(exchange.snapshot().submits).toBe(1);
    expect(() => exchange.markSubmitting()).toThrow(/submission budget of this exchange is exhausted/);
  });

  test("retirement is terminal for the exchange and keeps the last physical settlement legal", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markRetired("the conversation was replaced");
    expect(exchange.snapshot().retired).toBe(true);
    expect(exchange.snapshot().retiredReason).toContain("replaced");
    expect(() => exchange.markTransportReady()).toThrow(/retired/);
    // The one mutation that stays legal: a turn can finish logically after its exchange was written off.
    exchange.markPhysicallySettled("fulfilled");
    expect(exchange.snapshot().physical).toBe("fulfilled");
    expect(exchange.isResourceReusable()).toBe(false);
  });
});

describe("issue #191 — the submit boundary is the retry boundary", () => {
  test("safety follows the submission phase, never whether output arrived", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markTransportReady();
    expect(webChatRetrySafetyOf({ snapshot: exchange.snapshot() })).toBe("retry_safe");

    exchange.markSubmitting();
    expect(webChatRetrySafetyOf({ snapshot: exchange.snapshot() })).toBe("retry_safe");

    exchange.markSendActivated();
    expect(exchange.snapshot().state).toBe("SUBMISSION_AMBIGUOUS");
    expect(exchange.snapshot().phase).toBe("send_activated");
    expect(webChatRetrySafetyOf({ snapshot: exchange.snapshot() })).toBe("ambiguous");

    const accepted = lifecycle();
    accepted.markPreparing();
    accepted.markTransportReady();
    accepted.markSubmitting();
    accepted.markSubmitted();
    expect(webChatRetrySafetyOf({ snapshot: accepted.snapshot() })).toBe("not_retry_safe");
  });

  test("a pre-submission failure is retry-safe", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markFailed();
    const decision = decideWebChatRetry({ snapshot: exchange.snapshot() });
    expect(decision.allowed).toBe(true);
    expect(decision.safety).toBe("retry_safe");
    expect(decision.reason).toBeUndefined();
  });

  test("a confirmed submission is never automatically retried", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    exchange.markSubmitted();
    exchange.markStreaming();
    exchange.markFailed();
    const decision = decideWebChatRetry({ snapshot: exchange.snapshot() });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("submitted");
    expect(webChatRetrySafetyOf({ snapshot: exchange.snapshot() })).toBe("not_retry_safe");
  });

  test("ambiguous submission is a first-class, never automatic outcome", () => {
    const exchange = lifecycle({ maxSubmits: 3 });
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    exchange.markSendActivated();
    expect(exchange.snapshot().logical).toBe("pending");
    expect(exchange.snapshot().physical).toBe("pending");
    const decision = decideWebChatRetry({ snapshot: exchange.snapshot() });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("ambiguous");
  });

  test("partial output is never evidence that nothing was submitted", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    const decision = decideWebChatRetry({ snapshot: exchange.snapshot(), partialOutputObserved: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("partial_output");
    expect(decision.safety).toBe("not_retry_safe");
  });

  test("the budget, retirement, cancellation and policy all refuse explicitly", () => {
    const budgeted = lifecycle({ maxSubmits: 2 });
    budgeted.markPreparing();
    budgeted.markTransportReady();
    budgeted.markSubmitting();
    budgeted.markSubmitting();
    expect(decideWebChatRetry({ snapshot: budgeted.snapshot() })).toMatchObject({ allowed: false, reason: "budget_exhausted" });

    const retired = lifecycle();
    retired.markRetired("gone");
    expect(decideWebChatRetry({ snapshot: retired.snapshot() })).toMatchObject({ allowed: false, reason: "retired" });

    const cancelled = lifecycle();
    cancelled.markPreparing();
    cancelled.cancel("the user stopped it");
    cancelled.markCancelled();
    expect(decideWebChatRetry({ snapshot: cancelled.snapshot() })).toMatchObject({ allowed: false, reason: "cancelled" });

    const sideEffectFree = lifecycle();
    sideEffectFree.markPreparing();
    sideEffectFree.markTransportReady();
    sideEffectFree.markSubmitting();
    sideEffectFree.markSendActivated();
    expect(decideWebChatRetry({ snapshot: sideEffectFree.snapshot() }, { policy: "side_effect_free" }))
      .toMatchObject({ allowed: false, reason: "ambiguous" });
    expect(() => decideWebChatRetry({ snapshot: sideEffectFree.snapshot() }, { policy: "whatever" as never }))
      .toThrow(/Unknown WebChat retry policy/);
  });
});

describe("issue #191 — logical and physical settlement are separate", () => {
  test("a finished turn leaves the resource unavailable until settlement is published", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    exchange.markSubmitted();
    exchange.markStreaming();
    exchange.markCompleted();
    expect(exchange.snapshot().logical).toBe("completed");
    expect(exchange.snapshot().physical).toBe("pending");
    expect(exchange.isResourceReusable()).toBe(false);

    exchange.markPhysicallySettled("fulfilled");
    expect(exchange.snapshot().physical).toBe("fulfilled");
    expect(exchange.isResourceReusable()).toBe(true);
  });

  test("a settlement that cannot be proven retires the exchange", () => {
    const exchange = lifecycle({ maxSubmits: 2 });
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    exchange.markPhysicallySettled("rejected");
    expect(exchange.snapshot().retired).toBe(true);
    expect(exchange.snapshot().retiredReason).toContain("physical settlement");
    expect(exchange.isResourceReusable()).toBe(false);
  });
});

describe("issue #191 — cancellation and stale results", () => {
  test("cancellation is idempotent and notifies the provider once", () => {
    const exchange = lifecycle();
    let cancellations = 0;
    exchange.attachCancellation(() => { cancellations += 1; });
    exchange.markPreparing();
    exchange.cancel("first");
    exchange.cancel("second");
    expect(cancellations).toBe(1);
    expect(exchange.snapshot().cancelRequested).toBe(true);

    exchange.markTransportReady();
    exchange.markSubmitting();
    exchange.markSubmitted();
    exchange.markCancelled();
    exchange.cancel("after completion");
    expect(cancellations).toBe(1);
  });

  test("a result from another epoch, or one arriving after cancel or retirement, is never accepted", () => {
    const exchange = lifecycle({ epoch: 3 });
    expect(exchange.acceptsResult(3)).toBe(true);
    expect(exchange.acceptsResult(2)).toBe(false);
    expect(exchange.acceptsResult(4)).toBe(false);

    exchange.cancel("stopped");
    expect(exchange.acceptsResult(3)).toBe(false);

    const retired = lifecycle({ epoch: 3 });
    retired.markRetired("replaced");
    expect(retired.acceptsResult(3)).toBe(false);
  });

  test("recovery is monotonic: exact resume cannot degrade into a replay", () => {
    const exchange = lifecycle();
    exchange.markRecovery("exact_resume");
    expect(() => exchange.markRecovery("replay")).toThrow(/cannot be reclassified as a replay/);
    exchange.markRecovery("failed");

    const replay = lifecycle();
    replay.markRecovery("replay");
    expect(() => replay.markRecovery("exact_resume")).toThrow(/cannot be reclassified as an exact resume/);
    expect(() => replay.markRecovery("new_conversation")).toThrow(/not a recovery of an existing exchange/);
  });
});

describe("issue #191 — the exchange runner over a provider transport", () => {
  test("the happy path drives ready, submit, stream and settlement", async () => {
    const { transport, calls } = scriptedTransport();
    const { exchange, leases } = await runnerWith(transport);
    await exchange.prepare();
    expect(exchange.snapshot().state).toBe("TRANSPORT_READY");
    await exchange.submit();
    expect(exchange.snapshot().state).toBe("SUBMITTED");
    const events = await collect(exchange);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "completed"]);
    expect(exchange.snapshot().state).toBe("COMPLETED");
    expect(exchange.retrySafety()).toBe("not_retry_safe");
    expect(exchange.settlement()).toBe("fulfilled");
    expect(calls).toEqual({ ready: 1, submit: 1, stream: 1, settle: 1, abort: 0 });
    expect(leases.isLeased("conversation-key-1")).toBe(false);
  });

  test("an ambiguous submission stops the turn without inventing an outcome", async () => {
    const { transport } = scriptedTransport({ phases: ["send_activated"], events: [] });
    const { exchange } = await runnerWith(transport);
    await exchange.prepare();
    await exchange.submit();
    expect(exchange.snapshot().state).toBe("SUBMISSION_AMBIGUOUS");
    expect(exchange.retrySafety()).toBe("ambiguous");
    expect(decideWebChatRetry({ snapshot: exchange.snapshot() })).toMatchObject({ allowed: false, reason: "ambiguous" });
    expect(exchange.snapshot().logical).toBe("pending");
  });

  test("a pre-submission transport failure is retry-safe and settles the resource", async () => {
    const { transport, calls } = scriptedTransport({ ready: async () => { throw new Error("the surface is gone"); } });
    const { exchange } = await runnerWith(transport);
    await expect(exchange.prepare()).rejects.toThrow(/surface is gone/);
    expect(exchange.snapshot().state).toBe("FAILED");
    expect(exchange.retrySafety()).toBe("retry_safe");
    expect(calls.settle).toBe(1);
    expect(calls.abort).toBe(0);
  });

  test("a provider error after submission is not retry-safe", async () => {
    const { transport } = scriptedTransport({
      events: [
        { type: "text_delta", text: "parcial" },
        { type: "error", error: webChatError("UPSTREAM_ERROR", "upstream exploded") },
      ],
    });
    const { exchange } = await runnerWith(transport);
    await exchange.prepare();
    await exchange.submit();
    const events = await collect(exchange);
    expect(events.at(-1)?.type).toBe("error");
    expect(exchange.snapshot().state).toBe("FAILED");
    expect(exchange.retrySafety()).toBe("not_retry_safe");
  });

  test("cancellation aborts once, settles the resource and discards later output", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: WebChatExchangeEvent[] = [];
    const calls = { abort: 0, settle: 0 };
    const transport: WebChatTextTransport = {
      id: "gated",
      ready: async () => {},
      submit: async () => "accepted",
      async *stream(): AsyncIterable<WebChatExchangeEvent> {
        await gate;
        events.push({ type: "text_delta", text: "tarde" });
        yield { type: "text_delta", text: "tarde" };
        yield { type: "completed", text: "tarde" };
      },
      async settle() { calls.settle += 1; return "fulfilled"; },
      async abort() { calls.abort += 1; },
    };
    const { exchange } = await runnerWith(transport);
    await exchange.prepare();
    await exchange.submit();
    const collecting = collect(exchange);
    await exchange.abort("the caller stopped it");
    await exchange.abort("again");
    release();
    const received = await collecting;
    expect(calls.abort).toBe(1);
    expect(calls.settle).toBe(1);
    expect(exchange.snapshot().cancelRequested).toBe(true);
    // The late delta arrives after cancellation: it is discarded, never presented as this turn's output.
    expect(received).toEqual([]);
    expect(events).toHaveLength(1);
  });

  test("a second exchange on the same conversation is refused while the first may still produce output", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    const first = await runnerWith(scriptedTransport({ events: [] }).transport, { leases });
    await first.exchange.prepare();
    await expect(runnerWith(scriptedTransport().transport, { leases })).resolves.toBeDefined();
    const second = createWebChatExchange({
      identity: IDENTITY,
      turn: TURN,
      transport: scriptedTransport().transport,
      leases,
    });
    await expect(second.prepare()).rejects.toThrow(/still owns this conversation's transport resource/);
  });

  test("an external abort signal cancels the exchange", async () => {
    const controller = new AbortController();
    const { transport, calls } = scriptedTransport({ events: [] });
    const leases = createWebChatTransportLeaseRegistry();
    const exchange = createWebChatExchange({
      identity: IDENTITY,
      turn: TURN,
      transport,
      leases,
      createResource: async () => resource(),
      signal: controller.signal,
    });
    await exchange.prepare();
    await exchange.submit();
    controller.abort();
    await Promise.resolve();
    expect(exchange.snapshot().cancelRequested).toBe(true);
    expect(calls.abort).toBe(1);
  });
});

describe("issue #191 — transport resource ownership", () => {
  test("exclusivity, settling, retirement and explicit reset", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    const lease = await leases.acquire({ exchangeId: "e1", conversationKey: "c1", epoch: 1, create: async () => resource() });
    expect(leases.isLeased("c1")).toBe(true);
    expect(leases.describe("c1")).toEqual({ leased: true, settling: false, retired: false });

    // A second exchange cannot take a resource that may still produce output.
    await expect(leases.acquire({ exchangeId: "e2", conversationKey: "c1", epoch: 1 }))
      .rejects.toThrow(/still owns this conversation's transport resource/);

    // Releasing without settlement keeps it unavailable: an error is not proof that it stopped.
    lease.release();
    expect(leases.describe("c1")).toEqual({ leased: false, settling: true, retired: false });
    await expect(leases.acquire({ exchangeId: "e3", conversationKey: "c1", epoch: 1 }))
      .rejects.toThrow(/still owns this conversation's transport resource/);

    // Only a published settlement makes it reusable.
    lease.settle("fulfilled");
    expect(leases.describe("c1")).toEqual({ leased: false, settling: false, retired: false });
    const reused = await leases.acquire({ exchangeId: "e4", conversationKey: "c1", epoch: 1 });
    expect(reused.resource.id).toBe("resource-1");

    // A rejected settlement retires the resource, and nothing recreates it silently.
    reused.settle("rejected");
    expect(leases.isRetired("c1")).toBe(true);
    await expect(leases.acquire({ exchangeId: "e5", conversationKey: "c1", epoch: 1 }))
      .rejects.toThrow(/was retired/);
    // The tombstone stays until an explicit recovery, and recovery starts from a new resource: the
    // retired one was never proven settled, so it is not trusted again.
    leases.reset("c1");
    expect(leases.isRetired("c1")).toBe(false);
    const afterReset = await leases.acquire({
      exchangeId: "e6",
      conversationKey: "c1",
      epoch: 1,
      create: async () => ({ id: "resource-2", conversationKey: "c1", epoch: 1 }),
    });
    expect(afterReset.resource.id).toBe("resource-2");
  });

  test("an unrecorded resource is refused unless the caller may create one", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    await expect(leases.acquire({ exchangeId: "e1", conversationKey: "missing", epoch: 1 }))
      .rejects.toThrow(/No transport resource exists/);
    expect(() => leases.reset("missing")).not.toThrow();
  });

  test("a stale conversation epoch is refused", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    const lease = await leases.acquire({ exchangeId: "e1", conversationKey: "c1", epoch: 2, create: async () => resource(2) });
    lease.settle("fulfilled");
    await expect(leases.acquire({ exchangeId: "e2", conversationKey: "c1", epoch: 1 }))
      .rejects.toThrow(/belongs to epoch 2/);
  });
});

describe("issue #191 — migration evidence from the existing provider lifecycle", () => {
  test("the ChatGPT lifecycle vocabulary maps onto the core exchange", () => {
    expect(chatGptWebChatExchangeStateOf("PREPARING")).toBe("PREPARING");
    expect(chatGptWebChatExchangeStateOf("SURFACE_READY")).toBe("TRANSPORT_READY");
    expect(chatGptWebChatExchangeStateOf("SUBMITTED")).toBe("SUBMITTED");
    expect(chatGptWebChatExchangeStateOf("RUNNING")).toBe("STREAMING");
    expect(chatGptWebChatSubmissionPhaseOf("prepared")).toBe("prepared");
    expect(chatGptWebChatSubmissionPhaseOf("send_activated")).toBe("send_activated");
    expect(chatGptWebChatSubmissionPhaseOf("accepted")).toBe("accepted");
    expect(chatGptWebChatLogicalSettlementOf("completed")).toBe("completed");
    expect(chatGptWebChatPhysicalSettlementOf("rejected")).toBe("rejected");
    expect(chatGptWebChatRetryRefusalOf("submitted")).toBe("submitted");
    expect(chatGptWebChatRetryRefusalOf("budget_exhausted")).toBe("budget_exhausted");
    expect(chatGptWebChatRetryRefusalOf(undefined)).toBeUndefined();
    expect(chatGptWebChatLeaseShapeOf({ present: true, busy: true, lost: false })).toEqual({ leased: true, settling: false, retired: false });
    expect(chatGptWebChatLeaseShapeOf({ present: false, busy: false, lost: true })).toEqual({ leased: false, settling: false, retired: true });
  });

  test("both lifecycles refuse an automatic retry once submission may have happened", () => {
    const capabilitySnapshot: CapabilitySnapshot = {
      snapshotId: "snapshot-191",
      sessionId: "session-191",
      agentId: "session-191",
      turnId: "turn-191",
      createdAt: Date.now(),
      lifecycle: "active",
      tools: [],
    };
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-191-parity";
    const begin = () => core.begin({
      executionKey,
      traceId: "trace-191",
      nativeTurnId: "turn-191",
      nativeThreadId: "thread-191",
      accountIdentity: "account-191",
      browserProfile: "profile-191",
      browserContext: "context-191",
      pageIdentity: "page-191",
      capabilitySnapshot,
      retryPolicy: "strict",
    });

    // Before submission both layers would allow another attempt.
    const beforeSubmit = begin();
    expect(core.retryDecision(executionKey, beforeSubmit, 1_000).allowed).toBe(true);
    const coreBefore = lifecycle();
    coreBefore.markPreparing();
    coreBefore.markTransportReady();
    expect(decideWebChatRetry({ snapshot: coreBefore.snapshot() }).allowed).toBe(true);

    // After send activation neither layer may retry automatically: the provider may have accepted it.
    const activated = begin();
    activated.markSendActivated();
    const providerDecision = core.retryDecision(executionKey, activated, 2_000);
    expect(providerDecision.allowed).toBe(false);
    expect(chatGptWebChatRetryRefusalOf(providerDecision.reason)).toBe("submitted");

    const coreActivated = lifecycle();
    coreActivated.markPreparing();
    coreActivated.markTransportReady();
    coreActivated.markSubmitting();
    coreActivated.markSendActivated();
    expect(decideWebChatRetry({ snapshot: coreActivated.snapshot() }).allowed).toBe(false);
    // The core distinguishes "may have been accepted" from "accepted"; the ChatGPT path collapses
    // both into `submitted`. Both refuse, which is the invariant that matters.
    expect(webChatRetrySafetyOf({ snapshot: coreActivated.snapshot() })).toBe("ambiguous");
  });
});
