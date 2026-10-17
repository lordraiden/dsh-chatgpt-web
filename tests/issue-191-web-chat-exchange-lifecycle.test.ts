import { describe, expect, test } from "bun:test";

import {
  chatGptWebChatExchangeStateOf,
  chatGptWebChatLeaseShapeOf,
  chatGptWebChatLogicalSettlementOf,
  chatGptWebChatPhysicalSettlementOf,
  chatGptWebChatRetryRefusalOf,
  chatGptWebChatSubmissionPhaseOf,
} from "../src/adapters/chatgpt-web/web-chat-exchange-bridge";
import {
  ChatGptWebProviderCore,
  type ChatGptWebProviderCoreTurnInput,
} from "../src/adapters/chatgpt-web/provider-core";
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
    { type: "text_delta", epoch: 1, text: "hola" },
    { type: "completed", epoch: 1, text: "hola" },
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
  test("a late confirmation resolves ambiguity into the confirmed case", () => {
    const exchange = lifecycle();
    exchange.markPreparing();
    exchange.markTransportReady();
    exchange.markSubmitting();
    exchange.markSendActivated();
    expect(exchange.snapshot().state).toBe("SUBMISSION_AMBIGUOUS");
    exchange.markSubmitted();
    const snapshot = exchange.snapshot();
    expect(snapshot.state).toBe("SUBMITTED");
    expect(snapshot.phase).toBe("accepted");
    // From there an automatic duplicate submission is forbidden, as after any confirmed submission.
    expect(webChatRetrySafetyOf({ snapshot })).toBe("not_retry_safe");
    // The exchange keeps following the normal path.
    exchange.markStreaming();
    exchange.markCompleted();
    expect(exchange.snapshot().logical).toBe("completed");
  });

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
    expect(() => ambiguous.markPreparing()).toThrow(/cannot change state/);
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

  test("a pre-submission transport failure is retry-safe and frees the resource", async () => {
    const { transport, calls } = scriptedTransport({ ready: async () => { throw new Error("the surface is gone"); } });
    const { exchange, leases } = await runnerWith(transport);
    await expect(exchange.prepare()).rejects.toThrow(/surface is gone/);
    expect(exchange.snapshot().state).toBe("FAILED");
    expect(exchange.retrySafety()).toBe("retry_safe");
    // Readiness precedes submission, so this failure provably never sent anything: the resource is
    // published as `not_started` and stays reusable, without asking the provider to settle an
    // operation it never started.
    expect(exchange.settlement()).toBe("not_started");
    expect(calls.settle).toBe(0);
    expect(calls.abort).toBe(0);
    expect(leases.describe("conversation-key-1")).toEqual({ leased: false, settling: false, retired: false, creating: false });
  });

  test("a submission that fails after activation is ambiguous, never retry-safe, and never frees the resource", async () => {
    // The browser activated the send and then failed while confirming it: a throw proves nothing.
    const failing = scriptedTransport({
      phases: [],
      settlement: async () => "pending",
    });
    const failingTransport: WebChatTextTransport = {
      ...failing.transport,
      async submit() { throw new Error("the confirmation never arrived"); },
    };
    const { exchange, leases } = await runnerWith(failingTransport);
    await exchange.prepare();
    await expect(exchange.submit()).rejects.toThrow(/confirmation never arrived/);

    expect(exchange.snapshot().state).toBe("SUBMISSION_AMBIGUOUS");
    expect(exchange.snapshot().phase).toBe("send_activated");
    expect(exchange.snapshot().logical).toBe("pending");
    expect(exchange.retrySafety()).toBe("ambiguous");
    expect(decideWebChatRetry({ snapshot: exchange.snapshot() })).toMatchObject({ allowed: false, reason: "ambiguous" });
    // The resource is not declared free while the provider may still be producing output.
    expect(exchange.settlement()).toBe("pending");
    expect(leases.describe("conversation-key-1")).toEqual({ leased: false, settling: true, retired: false, creating: false });
  });

  test("a submission failure whose settlement cannot be established retires the resource", async () => {
    const transport: WebChatTextTransport = {
      id: "unsound",
      ready: async () => {},
      submit: async () => { throw new Error("send exploded"); },
      // eslint-disable-next-line require-yield
      async *stream() { /* never reached */ },
      async settle() { throw new Error("settlement unknown"); },
      async abort() {},
    };
    const { exchange, leases } = await runnerWith(transport);
    await exchange.prepare();
    await expect(exchange.submit()).rejects.toThrow(/send exploded/);
    expect(exchange.snapshot().state).toBe("SUBMISSION_AMBIGUOUS");
    expect(exchange.settlement()).toBe("rejected");
    expect(exchange.retrySafety()).toBe("not_retry_safe");
    // Only an explicit recovery brings the conversation back.
    expect(leases.isRetired("conversation-key-1")).toBe(true);
    await expect(runnerWith(scriptedTransport().transport, { leases })).resolves.toBeDefined();
    const next = createWebChatExchange({
      identity: IDENTITY,
      turn: TURN,
      transport: scriptedTransport().transport,
      leases,
    });
    await expect(next.prepare()).rejects.toThrow(/was retired/);
  });

  test("a provider that proves nothing was submitted stays retry-safe", async () => {
    const { transport } = scriptedTransport({ phases: ["prepared", "accepted"] });
    const { exchange } = await runnerWith(transport, { maxSubmits: 2 });
    await exchange.prepare();
    await exchange.submit();
    expect(exchange.snapshot().state).toBe("SUBMITTING");
    expect(exchange.retrySafety()).toBe("retry_safe");
    expect(decideWebChatRetry({ snapshot: exchange.snapshot() })).toMatchObject({ allowed: true });
    await exchange.submit();
    expect(exchange.snapshot().state).toBe("SUBMITTED");
    expect(exchange.snapshot().submits).toBe(2);
  });

  test("a provider error after submission is not retry-safe", async () => {
    const { transport } = scriptedTransport({
      events: [
        { type: "text_delta", epoch: 1, text: "parcial" },
        { type: "error", epoch: 1, error: webChatError("UPSTREAM_ERROR", "upstream exploded") },
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
      async *stream(context: WebChatTextTransportContext): AsyncIterable<WebChatExchangeEvent> {
        await gate;
        events.push({ type: "text_delta", epoch: context.epoch, text: "tarde" });
        yield { type: "text_delta", epoch: context.epoch, text: "tarde" };
        yield { type: "completed", epoch: context.epoch, text: "tarde" };
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

  test("cancellation waits for the provider abort before publishing settlement", async () => {
    let releaseAbort: () => void = () => {};
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const order: string[] = [];
    const transport: WebChatTextTransport = {
      id: "ordered",
      ready: async () => {},
      submit: async () => "accepted",
      // eslint-disable-next-line require-yield
      async *stream() { /* the exchange is cancelled before it streams */ },
      async settle() { order.push("settle"); return "fulfilled"; },
      async abort() { order.push("abort:start"); await abortGate; order.push("abort:end"); },
    };
    const { exchange } = await runnerWith(transport);
    await exchange.prepare();
    await exchange.submit();

    const aborting = exchange.abort("the caller stopped it");
    await Promise.resolve();
    await Promise.resolve();
    // The provider abort is still running: nothing may be settled or released yet.
    expect(order).toEqual(["abort:start"]);
    expect(exchange.settlement()).toBeUndefined();

    releaseAbort();
    await aborting;
    expect(order).toEqual(["abort:start", "abort:end", "settle"]);
    expect(exchange.settlement()).toBe("fulfilled");
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
    expect(leases.describe("c1")).toEqual({ leased: true, settling: false, retired: false, creating: false });

    // A second exchange cannot take a resource that may still produce output.
    await expect(leases.acquire({ exchangeId: "e2", conversationKey: "c1", epoch: 1 }))
      .rejects.toThrow(/still owns this conversation's transport resource/);

    // Releasing without settlement keeps it unavailable: an error is not proof that it stopped.
    lease.release();
    expect(leases.describe("c1")).toEqual({ leased: false, settling: true, retired: false, creating: false });
    await expect(leases.acquire({ exchangeId: "e3", conversationKey: "c1", epoch: 1 }))
      .rejects.toThrow(/still owns this conversation's transport resource/);

    // Only a published settlement makes it reusable.
    lease.settle("fulfilled");
    expect(leases.describe("c1")).toEqual({ leased: false, settling: false, retired: false, creating: false });
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

  test("two simultaneous initial acquisitions cannot both own the conversation", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    let releaseCreate: () => void = () => {};
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let creations = 0;
    const slowCreate = async (): Promise<WebChatTransportResource> => {
      creations += 1;
      await createGate;
      return { id: `resource-${creations}`, conversationKey: "c1", epoch: 1 };
    };

    // The first acquisition reserves the conversation before its asynchronous creation settles.
    const first = leases.acquire({ exchangeId: "e1", conversationKey: "c1", epoch: 1, create: slowCreate });
    await Promise.resolve();
    expect(leases.describe("c1")).toEqual({ leased: false, settling: false, retired: false, creating: true });
    expect(leases.isLeased("c1")).toBe(true);

    // A second acquisition during that window must not create a second resource.
    await expect(leases.acquire({ exchangeId: "e2", conversationKey: "c1", epoch: 1, create: slowCreate }))
      .rejects.toThrow(/is being created/);

    releaseCreate();
    const lease = await first;
    expect(lease.resource.id).toBe("resource-1");
    expect(creations).toBe(1);
    expect(leases.describe("c1")).toEqual({ leased: true, settling: false, retired: false, creating: false });
  });

  test("a failed creation releases its reservation, so the conversation is not blocked", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    let attempts = 0;
    const failingCreate = async (): Promise<WebChatTransportResource> => {
      attempts += 1;
      throw new Error("the browser refused to open a page");
    };
    await expect(leases.acquire({ exchangeId: "e1", conversationKey: "c1", epoch: 1, create: failingCreate }))
      .rejects.toThrow(/refused to open/);
    expect(leases.describe("c1")).toEqual({ leased: false, settling: false, retired: false, creating: false });

    const lease = await leases.acquire({
      exchangeId: "e2",
      conversationKey: "c1",
      epoch: 1,
      create: async () => ({ id: "resource-1", conversationKey: "c1", epoch: 1 }),
    });
    expect(lease.resource.id).toBe("resource-1");
    expect(attempts).toBe(1);
  });

  test("a lease whose settlement is not published cannot be reset away", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    const lease = await leases.acquire({ exchangeId: "e1", conversationKey: "c1", epoch: 1, create: async () => resource() });
    // Held by an operation in flight: explicit recovery cannot forget it.
    expect(() => leases.reset("c1")).toThrow(/active transport lease cannot be reset/);
    lease.release();
    // Released without a settlement: the resource may still produce output, so it stays protected.
    expect(leases.describe("c1")).toEqual({ leased: false, settling: true, retired: false, creating: false });
    expect(() => leases.reset("c1")).toThrow(/settlement has not been published/);
    // Only a published settlement (or a retirement) makes it forgettable.
    lease.settle("fulfilled");
    expect(() => leases.reset("c1")).not.toThrow();
    expect(leases.isLeased("c1")).toBe(false);
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
  test("a rejected physical settlement is the core's logical failure as well (review of #219)", async () => {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin({
      executionKey: "issue-219-physical-rejection",
      traceId: "trace-219",
      nativeTurnId: "turn-219",
      nativeThreadId: "thread-219",
      accountIdentity: "account-219",
      browserProfile: "profile-219",
      browserContext: "context-219",
      pageIdentity: "page-219",
      capabilitySnapshot: {
        snapshotId: "snapshot-219",
        sessionId: "session-219",
        agentId: "session-219",
        turnId: "turn-219",
        createdAt: Date.now(),
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    });

    // The physical side fails before the logical outcome was ever settled.
    turn.attachPhysicalSettlement(Promise.reject(new Error("the browser operation could not be proven settled")));
    await turn.waitForPhysicalSettlement().catch(() => undefined);

    const provider = turn.snapshot();
    const coreState = turn.coreSnapshot();
    expect(provider.physicalSettlementOutcome).toBe("rejected");
    expect(provider.logicalOutcome).toBe("failed");
    expect(provider.recovery).toBe("FAILED");
    // The core describes the same outcome: the provider's view is the core's.
    expect(coreState.physical).toBe("rejected");
    expect(coreState.logical).toBe("failed");
    expect(coreState.recovery).toBe("failed");
    expect(coreState.retired).toBe(true);
  });

  test("a logical failure is the core's outcome too (review of #219)", () => {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin({
      executionKey: "issue-219-logical-failure",
      traceId: "trace-219-lf",
      nativeTurnId: "turn-219-lf",
      nativeThreadId: "thread-219-lf",
      accountIdentity: "account-219",
      browserProfile: "profile-219",
      browserContext: "context-219",
      pageIdentity: "page-219",
      capabilitySnapshot: {
        snapshotId: "snapshot-219-lf",
        sessionId: "session-219",
        agentId: "session-219",
        turnId: "turn-219-lf",
        createdAt: Date.now(),
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    });

    // The physical side finished, but the turn itself failed.
    turn.markLogicalSettled("failed");
    const provider = turn.snapshot();
    const coreState = turn.coreSnapshot();
    expect(provider.logicalOutcome).toBe("failed");
    expect(provider.recovery).toBe("FAILED");
    expect(coreState.logical).toBe("failed");
    expect(coreState.recovery).toBe("failed");
  });

  test("a failure before any physical execution is the core's recovery too (review of #219)", () => {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin({
      executionKey: "issue-219-pre-physical",
      traceId: "trace-219-pp",
      nativeTurnId: "turn-219-pp",
      nativeThreadId: "thread-219-pp",
      accountIdentity: "account-219",
      browserProfile: "profile-219",
      browserContext: "context-219",
      pageIdentity: "page-219",
      capabilitySnapshot: {
        snapshotId: "snapshot-219-pp",
        sessionId: "session-219",
        agentId: "session-219",
        turnId: "turn-219-pp",
        createdAt: Date.now(),
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    });

    turn.failBeforePhysicalSettlement();
    const provider = turn.snapshot();
    const coreState = turn.coreSnapshot();
    expect(provider.physicalSettlementOutcome).toBe("not_started");
    expect(provider.logicalOutcome).toBe("failed");
    expect(provider.recovery).toBe("FAILED");
    expect(coreState.physical).toBe("not_started");
    expect(coreState.logical).toBe("failed");
    expect(coreState.recovery).toBe("failed");
  });

  test("the ChatGPT lifecycle vocabulary maps onto the core exchange", () => {
    const facts = (overrides: Partial<Parameters<typeof chatGptWebChatExchangeStateOf>[0]> = {}) => ({
      state: "PREPARING" as const,
      submission: "prepared" as const,
      logicalOutcome: "pending" as const,
      physicalOutcome: "not_started" as const,
      ...overrides,
    });
    expect(chatGptWebChatExchangeStateOf(facts({ state: "PREPARING" }))).toBe("PREPARING");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "SURFACE_READY" }))).toBe("TRANSPORT_READY");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "RUNNING", submission: "accepted" }))).toBe("STREAMING");
    // The distinction the static table could not make: submitted-and-confirmed versus only activated.
    expect(chatGptWebChatExchangeStateOf(facts({ state: "SUBMITTED", submission: "accepted" }))).toBe("SUBMITTED");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "SUBMITTED", submission: "send_activated" }))).toBe("SUBMISSION_AMBIGUOUS");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "SUBMITTED", submission: "prepared" }))).toBe("SUBMITTING");
    // The end of the turn reads from the logical outcome, not from the state name.
    expect(chatGptWebChatExchangeStateOf(facts({ state: "SETTLING", logicalOutcome: "completed" }))).toBe("COMPLETED");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "RETIRED", logicalOutcome: "cancelled" }))).toBe("CANCELLED");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "RETIRED", logicalOutcome: "failed" }))).toBe("FAILED");
    expect(chatGptWebChatExchangeStateOf(facts({ state: "RETIRED", logicalOutcome: "pending" }))).toBe("SUBMISSION_AMBIGUOUS");
    expect(chatGptWebChatSubmissionPhaseOf("prepared")).toBe("prepared");
    expect(chatGptWebChatSubmissionPhaseOf("send_activated")).toBe("send_activated");
    expect(chatGptWebChatSubmissionPhaseOf("accepted")).toBe("accepted");
    expect(chatGptWebChatLogicalSettlementOf("completed")).toBe("completed");
    expect(chatGptWebChatPhysicalSettlementOf("rejected")).toBe("rejected");
    expect(chatGptWebChatRetryRefusalOf("submitted")).toBe("submitted");
    expect(chatGptWebChatRetryRefusalOf("budget_exhausted")).toBe("budget_exhausted");
    expect(chatGptWebChatRetryRefusalOf(undefined)).toBeUndefined();
    expect(chatGptWebChatLeaseShapeOf({ present: true, busy: true, lost: false, settled: true }))
      .toEqual({ leased: true, settling: false, settled: true, retired: false });
    expect(chatGptWebChatLeaseShapeOf({ present: false, busy: false, lost: true, settled: false }))
      .toEqual({ leased: false, settling: false, settled: false, retired: true });
    // Present and free, but not settled: not reusable yet, which the previous shape could not say.
    expect(chatGptWebChatLeaseShapeOf({ present: true, busy: false, lost: false, settled: false }))
      .toEqual({ leased: false, settling: true, settled: false, retired: false });
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

describe("issue #191 — stream ends, concurrency and preparation (review of #218)", () => {
  test("a stream that ends without a terminal event is never a completed answer", async () => {
    const { transport } = scriptedTransport({ events: [{ type: "text_delta", epoch: 1, text: "parcial" }] });
    const { exchange } = await runnerWith(transport);
    await exchange.prepare();
    await exchange.submit();
    const events = await collect(exchange);
    expect(events.map(event => event.type)).toEqual(["text_delta"]);
    expect(exchange.snapshot().state).toBe("FAILED");
    expect(exchange.snapshot().logical).toBe("failed");
    // Partial output is still not evidence that nothing was sent.
    expect(exchange.retrySafety()).toBe("not_retry_safe");
  });

  test("two concurrent cancellations wait for the same abort and settle once", async () => {
    let releaseAbort: () => void = () => {};
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
    const order: string[] = [];
    let settleCalls = 0;
    const transport: WebChatTextTransport = {
      id: "gated-cancel",
      ready: async () => {},
      submit: async () => "accepted",
      // eslint-disable-next-line require-yield
      async *stream() { /* cancelled before streaming */ },
      async settle() { settleCalls += 1; order.push("settle"); return "fulfilled"; },
      async abort() { order.push("abort:start"); await abortGate; order.push("abort:end"); },
    };
    const { exchange } = await runnerWith(transport);
    await exchange.prepare();
    await exchange.submit();

    const first = exchange.abort("one");
    const second = exchange.abort("two");
    await Promise.resolve();
    await Promise.resolve();
    // Neither solver has finished: nothing may be settled yet.
    expect(order).toEqual(["abort:start"]);

    releaseAbort();
    await Promise.all([first, second]);
    expect(order).toEqual(["abort:start", "abort:end", "settle"]);
    expect(settleCalls).toBe(1);
    expect(exchange.snapshot().cancelRequested).toBe(true);
  });

  test("an event from another conversation epoch is discarded, not presented as this turn", async () => {
    const { transport } = scriptedTransport({
      events: [
        { type: "text_delta", epoch: 2, text: "de otra época" },
        { type: "text_delta", epoch: 1, text: "de esta" },
        { type: "completed", epoch: 1, text: "de esta" },
      ],
    });
    const { exchange } = await runnerWith(transport, { epoch: 1 });
    await exchange.prepare();
    await exchange.submit();
    const events = await collect(exchange);
    // The event carries the epoch it was produced for: another generation never reaches the caller.
    expect(events.map(event => (event.type === "text_delta" ? event.text : event.type))).toEqual(["de esta", "completed"]);
    expect(exchange.snapshot().state).toBe("COMPLETED");
  });

  test("a submission before the exchange is transport-ready is refused", async () => {
    const { transport, calls } = scriptedTransport();
    const { exchange } = await runnerWith(transport);
    await expect(exchange.submit()).rejects.toThrow(/transport-ready/);
    expect(calls.submit).toBe(0);
  });

  test("an already-aborted external signal cancels without a reference error", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, calls } = scriptedTransport({ events: [] });
    const exchange = createWebChatExchange({
      identity: IDENTITY,
      turn: TURN,
      transport,
      leases: createWebChatTransportLeaseRegistry(),
      createResource: async () => resource(),
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(exchange.snapshot().cancelRequested).toBe(true);
    expect(calls.abort).toBe(1);
  });
});

describe("issue #191 — a failure escalates a recovery already recorded (review of #219)", () => {
  function begunTurn(executionKey: string) {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin({
      executionKey,
      traceId: `${executionKey}-trace`,
      nativeTurnId: `${executionKey}-turn`,
      nativeThreadId: `${executionKey}-thread`,
      accountIdentity: "account-esc",
      browserProfile: "profile-esc",
      browserContext: "context-esc",
      pageIdentity: "page-esc",
      capabilitySnapshot: {
        snapshotId: `${executionKey}-snapshot`,
        sessionId: "session-esc",
        agentId: "session-esc",
        turnId: `${executionKey}-turn`,
        createdAt: Date.now(),
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    });
    return turn;
  }

  for (const recovery of ["EXACT_RESUME", "REPLAY"] as const) {
    test(`a logical failure escalates a turn that started with ${recovery}`, () => {
      const turn = begunTurn(`esc-logical-${recovery}`);
      turn.markRecovery(recovery);
      expect(turn.snapshot().recovery).toBe(recovery);
      expect(turn.coreSnapshot().recovery).toBe(recovery === "EXACT_RESUME" ? "exact_resume" : "replay");

      turn.markLogicalSettled("failed");
      expect(turn.snapshot().recovery).toBe("FAILED");
      // The core escalates with the same rank rule; it never keeps the recovery the turn started from.
      expect(turn.coreSnapshot().recovery).toBe("failed");
      expect(turn.coreSnapshot().logical).toBe("failed");
    });

    test(`a failure before physical execution escalates a turn that started with ${recovery}`, () => {
      const turn = begunTurn(`esc-physical-${recovery}`);
      turn.markRecovery(recovery);
      turn.failBeforePhysicalSettlement();
      expect(turn.snapshot().recovery).toBe("FAILED");
      expect(turn.snapshot().physicalSettlementOutcome).toBe("not_started");
      expect(turn.coreSnapshot().recovery).toBe("failed");
      expect(turn.coreSnapshot().logical).toBe("failed");
    });
  }
});

/**
 * Issue #287 slice 3 — logical settlement is not physical settlement.
 *
 * Restored from the deleted `scripts/test-issue-9-provider-core.ts` (the "logical vs physical
 * settlement", "rejected physical settlement remains observable", "physical-first failed logical
 * settlement", "late lifecycle callbacks fail closed except final logical settlement" and
 * "post-submit retry boundary" cases), asserted against the ProviderCore as it is now. Reporting a
 * completion is not the same fact as a physically settled resource, and a settlement that cannot be
 * established retires the turn rather than leaving its resource trusted again.
 */
describe("issue #287 slice 3 — a logical outcome is not a physical settlement", () => {
  function providerTurnInput(executionKey: string): ChatGptWebProviderCoreTurnInput {
    return {
      executionKey,
      traceId: `${executionKey}-trace`,
      nativeTurnId: `${executionKey}-native`,
      nativeThreadId: `${executionKey}-thread`,
      accountIdentity: "account-287",
      browserProfile: "profile-287",
      browserContext: "context-287",
      pageIdentity: `page-${executionKey}`,
      capabilitySnapshot: {
        snapshotId: `snapshot-${executionKey}`,
        sessionId: "session-287",
        agentId: "session-287",
        turnId: `${executionKey}-native`,
        createdAt: 1_700_000_000_000,
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    };
  }

  function boundTurn(core: ChatGptWebProviderCore, executionKey: string) {
    const turn = core.begin(providerTurnInput(executionKey));
    turn.bindPhysicalResource({
      resourceId: `surface-${executionKey}`,
      browserContextId: "context-287",
      pageId: `page-${executionKey}`,
      profileId: "profile-287",
      accountId: "chatgpt-account:account-287",
    });
    turn.markSurfaceReady();
    return turn;
  }

  test("a reported completion keeps the resource until the physical settlement is published", async () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-logical-before-physical";
    const turn = boundTurn(core, executionKey);
    turn.markSubmitted();
    turn.markRunning();

    let settle!: () => void;
    const settlement = new Promise<void>(resolve => { settle = resolve; });
    core.bindPhysicalSettlement(executionKey, settlement);

    // The client-visible outcome is known...
    turn.markLogicalSettled("completed");
    const reported = turn.snapshot();
    expect(reported.logicalSettled).toBe(true);
    expect(reported.logicalOutcome).toBe("completed");

    // ...and that is not a physical settlement: nothing is proven about the browser resource yet.
    expect(reported.physicalSettled).toBe(false);
    expect(reported.physicalSettlementOutcome).toBe("pending");
    expect(reported.state).not.toBe("RETIRED");
    // So the turn still owns the resource: no other turn may reach for it.
    expect(turn.lease.isActive()).toBe(true);
    expect(core.get(executionKey)).toBe(turn);
    // The core records the same distinction, which is what the lease's reusability is derived from.
    expect(turn.coreSnapshot().physical).toBe("pending");
    expect(turn.coreSnapshot().retired).toBe(false);

    // Only the published settlement retires the turn and hands the resource back.
    settle();
    await turn.waitForPhysicalSettlement();
    const settled = turn.snapshot();
    expect(settled.physicalSettled).toBe(true);
    expect(settled.physicalSettlementOutcome).toBe("fulfilled");
    expect(settled.state).toBe("RETIRED");
    expect(turn.lease.isActive()).toBe(false);
    expect(core.get(executionKey)).toBeUndefined();
    expect(() => turn.assertCanAct()).toThrow(/retired/i);
  });

  test("a settlement that cannot be established retires the turn instead of reusing its resource", async () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-rejected-settlement";
    const turn = core.begin(providerTurnInput(executionKey));
    turn.markSubmitted();

    const failure = new Error("launcher /turn/end could not be proven");
    core.bindPhysicalSettlement(executionKey, Promise.reject(failure));
    await turn.waitForPhysicalSettlement().catch(() => undefined);

    const settled = turn.snapshot();
    expect(settled.physicalSettlementOutcome).toBe("rejected");
    // The unprovable settlement stays observable instead of being collapsed into a generic failure.
    expect(settled.physicalSettlementError).toBe(failure.message);
    expect(settled.state).toBe("RETIRED");
    expect(turn.lease.isActive()).toBe(false);
    // The core wrote the execution off, so its resource is not offered as current again...
    expect(core.get(executionKey)).toBeUndefined();
    expect(core.wasRetired(executionKey)).toBe(true);
    // ...and a replacement for the same conversation is a declared replay, never a silent fresh start.
    const replacement = core.begin(providerTurnInput(executionKey));
    expect(replacement.snapshot().recovery).toBe("REPLAY");
    replacement.failBeforePhysicalSettlement();
  });

  test("the settlement window fails closed for every mutation except the logical outcome", async () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-settling-window";
    const turn = boundTurn(core, executionKey);
    turn.markSubmitted();
    turn.markRunning();

    // Physical settlement wins the race: the turn waits for its client-visible outcome.
    core.bindPhysicalSettlement(executionKey, Promise.resolve());
    await turn.waitForPhysicalSettlement();
    expect(turn.snapshot().state).toBe("SETTLING");
    expect(turn.snapshot().physicalSettled).toBe(true);
    expect(turn.snapshot().logicalSettled).toBe(false);

    // Every late lifecycle callback is fail-closed in this window...
    expect(() => turn.markRunning()).toThrow(/cannot accept lifecycle mutations/i);
    expect(() => turn.markCapabilityWait()).toThrow(/cannot accept lifecycle mutations/i);
    expect(() => turn.markRecovery("FAILED")).toThrow(/cannot accept lifecycle mutations/i);
    expect(() => turn.assertCanAct()).toThrow(/retired/i);

    // ...except the one fact the window exists for. (Its positive half is already pinned by issue #72.)
    expect(() => turn.markLogicalSettled("completed")).not.toThrow();
    expect(turn.snapshot().state).toBe("RETIRED");
    expect(turn.snapshot().logicalOutcome).toBe("completed");
    expect(turn.lease.isActive()).toBe(false);
  });

  test("a physical settlement attaches once, and a settled turn cannot be force-retired", () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-settlement-attached-once";
    const turn = boundTurn(core, executionKey);

    core.bindPhysicalSettlement(executionKey, new Promise<void>(() => {}));
    expect(turn.snapshot().physicalSettlementAttached).toBe(true);
    expect(turn.snapshot().physicalSettlementOutcome).toBe("pending");

    // One settlement per physical execution, and once it started the turn may not be written off
    // synchronously by whoever observes the response: the settlement owns that retirement.
    expect(() => turn.attachPhysicalSettlement(Promise.resolve())).toThrow(/only be attached once/i);
    expect(() => turn.failBeforePhysicalSettlement()).toThrow(/after physical execution has started/i);
    expect(turn.snapshot().state).toBe("SURFACE_READY");
    expect(turn.lease.isActive()).toBe(true);
  });

  test("a settled logical outcome cannot be re-settled as a different one", () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-logical-outcome-fixed";
    const turn = boundTurn(core, executionKey);
    turn.markSubmitted();
    turn.markRunning();

    turn.markLogicalSettled("completed");
    // Re-reporting the same outcome is idempotent; changing it is refused.
    expect(() => turn.markLogicalSettled("completed")).not.toThrow();
    expect(() => turn.markLogicalSettled("failed")).toThrow(/cannot change: completed -> failed/i);
    expect(turn.snapshot().logicalOutcome).toBe("completed");
  });
});

/**
 * The remainder of the deleted `scripts/test-issue-9-provider-core.ts`: the two pre-submission turn
 * guards a future provider driver walks, asserted against the ProviderCore as it is now.
 *
 * - a surface cannot become ready without the physical resource it belongs to;
 * - a turn cannot be reported as running before the provider accepted its submission.
 *
 * Neither is reachable through the controlled browser surface (`tests/support/chatgpt-web-surface.ts`):
 * its transport always binds a physical resource before `onSurfaceReady` and always confirms the
 * submission before it streams. That is exactly why the deleted contract drove them through the
 * core's own lifecycle, and why this does the same, browser-free.
 */
describe("issue #287 slice 3 — the pre-submission turn guards a driver walks", () => {
  function providerTurnInput(executionKey: string): ChatGptWebProviderCoreTurnInput {
    return {
      executionKey,
      traceId: `${executionKey}-trace`,
      nativeTurnId: `${executionKey}-native`,
      nativeThreadId: `${executionKey}-thread`,
      accountIdentity: "account-guard",
      browserProfile: "profile-guard",
      browserContext: "context-guard",
      pageIdentity: `page-${executionKey}`,
      capabilitySnapshot: {
        snapshotId: `snapshot-${executionKey}`,
        sessionId: "session-guard",
        agentId: "session-guard",
        turnId: `${executionKey}-native`,
        createdAt: 1_700_000_000_000,
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    };
  }

  function physicalResource(executionKey: string) {
    return {
      resourceId: `surface-${executionKey}`,
      browserContextId: "context-guard",
      pageId: `page-${executionKey}`,
      profileId: "profile-guard",
      accountId: "chatgpt-account:account-guard",
    };
  }

  /** Capture the synchronous refusal instead of matching it, so its exact shape is asserted. */
  function refusalOf(run: () => unknown): Error {
    try {
      run();
    } catch (error) {
      return error as Error;
    }
    throw new Error("Expected the operation to be refused, but it succeeded");
  }

  test("a surface cannot become ready before its physical browser resource is bound", () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-guard-unbound-surface";
    const turn = core.begin(providerTurnInput(executionKey));
    expect(turn.snapshot().state).toBe("LEASED");
    expect(turn.snapshot().physicalResourceBound).toBe(false);

    const refusal = refusalOf(() => turn.markSurfaceReady());
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message).toBe(
      "Provider turn surface cannot become ready before a physical browser resource is bound",
    );

    // The refusal is not a fake binding and not terminal: the turn stays leased, stays unbound, and
    // becomes ready once the physical resource really exists.
    expect(turn.snapshot().state).toBe("LEASED");
    expect(turn.snapshot().physicalResourceBound).toBe(false);
    expect(turn.snapshot().physicalResource).toBeUndefined();
    expect(turn.lease.isActive()).toBe(true);
    expect(turn.lease.physicalResourceBinding()).toBeUndefined();

    turn.bindPhysicalResource(physicalResource(executionKey));
    expect(turn.snapshot().physicalResourceBound).toBe(true);
    expect(() => turn.markSurfaceReady()).not.toThrow();
    expect(turn.snapshot().state).toBe("SURFACE_READY");
    // Readiness is a no-op once recorded, not a refusal: a repeated driver callback is harmless.
    expect(() => turn.markSurfaceReady()).not.toThrow();
    expect(turn.snapshot().state).toBe("SURFACE_READY");

    turn.failBeforePhysicalSettlement();
  });

  test("a send-activated submission cannot be reported as running", () => {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin(providerTurnInput("issue-287-guard-before-accept"));
    turn.bindPhysicalResource(physicalResource("issue-287-guard-before-accept"));
    turn.markSurfaceReady();
    turn.markSendActivated();

    // Send activation already moved the provider turn to SUBMITTED; acceptance is a later fact.
    expect(turn.snapshot().state).toBe("SUBMITTED");
    expect(turn.snapshot().submission).toBe("send_activated");

    const refusal = refusalOf(() => turn.markRunning());
    expect(refusal.message).toBe("Provider turn cannot enter RUNNING before submission is accepted");
    // Nothing moved and nothing was invented as an activity.
    expect(turn.snapshot().state).toBe("SUBMITTED");
    expect(turn.snapshot().submission).toBe("send_activated");
    expect(turn.snapshot().activity).toBe("idle");

    // Acceptance is the fact that unlocks it, and the refusal was not terminal.
    turn.markSubmitted();
    expect(turn.snapshot().submission).toBe("accepted");
    expect(() => turn.markRunning()).not.toThrow();
    expect(turn.snapshot().state).toBe("RUNNING");
    expect(turn.snapshot().activity).toBe("running");

    turn.failBeforePhysicalSettlement();
  });

  test("an accepted submission alone is not enough: RUNNING also requires the ready surface", () => {
    // The submission gate and the state gate are separate. A driver that confirms a send while its
    // surface is not ready has an accepted submission and is still refused, with the state named.
    const leaseBound = new ChatGptWebProviderCore();
    const acceptedWhileLeased = leaseBound.begin(providerTurnInput("issue-287-guard-accepted-leased"));
    acceptedWhileLeased.bindPhysicalResource(physicalResource("issue-287-guard-accepted-leased"));
    acceptedWhileLeased.markSubmitted();
    expect(acceptedWhileLeased.snapshot().state).toBe("LEASED");
    expect(acceptedWhileLeased.snapshot().submission).toBe("accepted");
    expect(refusalOf(() => acceptedWhileLeased.markRunning()).message)
      .toBe("Provider turn cannot enter RUNNING from LEASED");
    expect(acceptedWhileLeased.snapshot().state).toBe("LEASED");
    acceptedWhileLeased.failBeforePhysicalSettlement();

    // And a ready surface with no submission at all is refused by the same state gate, first.
    const core = new ChatGptWebProviderCore();
    const readyButUnsubmitted = core.begin(providerTurnInput("issue-287-guard-ready-unsubmitted"));
    readyButUnsubmitted.bindPhysicalResource(physicalResource("issue-287-guard-ready-unsubmitted"));
    readyButUnsubmitted.markSurfaceReady();
    expect(readyButUnsubmitted.snapshot().state).toBe("SURFACE_READY");
    expect(readyButUnsubmitted.snapshot().submission).toBe("prepared");
    expect(refusalOf(() => readyButUnsubmitted.markRunning()).message)
      .toBe("Provider turn cannot enter RUNNING from SURFACE_READY");
    expect(readyButUnsubmitted.snapshot().state).toBe("SURFACE_READY");
    readyButUnsubmitted.failBeforePhysicalSettlement();
  });

  test("once accepted, RUNNING is re-entrant and a capability wait returns to it", () => {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin(providerTurnInput("issue-287-guard-running-reentrant"));
    turn.bindPhysicalResource(physicalResource("issue-287-guard-running-reentrant"));
    turn.markSurfaceReady();
    turn.markSubmitted();
    turn.markRunning();
    expect(turn.snapshot().state).toBe("RUNNING");
    expect(turn.snapshot().activity).toBe("running");

    turn.markCapabilityWait();
    expect(turn.snapshot().activity).toBe("capability_wait");

    // The broker returning a tool batch reports RUNNING again: from RUNNING with an accepted
    // submission this is allowed and only restores the activity, it never re-transitions.
    expect(() => turn.markRunning()).not.toThrow();
    expect(turn.snapshot().state).toBe("RUNNING");
    expect(turn.snapshot().activity).toBe("running");
    expect(() => turn.markRunning()).not.toThrow();
    expect(turn.snapshot().state).toBe("RUNNING");

    turn.failBeforePhysicalSettlement();
  });
});
