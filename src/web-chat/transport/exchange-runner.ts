/**
 * The exchange runner: core lifecycle semantics over a provider transport (architecture §9).
 *
 * It composes three owners without taking any of their authority:
 *
 * - the **lifecycle** (`WebChatExchangeLifecycle`) records what the exchange is allowed to do next;
 * - the **transport** (`WebChatTextTransport`) reports semantic facts the provider established;
 * - the **lease** (`WebChatTransportLease`) owns the physical resource and its settlement.
 *
 * The runner never detects readiness, submission or completion itself, never learns the provider's
 * protocol, and never touches a page. It is deliberately outside `src/web-chat/core` because it
 * depends on the transport seam; the core never imports it.
 */
import { createHash } from "node:crypto";

import {
  WebChatExchangeLifecycle,
  webChatError,
  webChatRetrySafetyOf,
  type WebChatExchange,
  type WebChatExchangeEvent,
  type WebChatExchangeSnapshot,
  type WebChatPhysicalSettlement,
  type WebChatSubmissionPhase,
  type WebChatRetrySafety,
  type WebChatTurnIdentity,
  type WebChatTurnInput,
} from "../core";
import type { WebChatTextTransport, WebChatTextTransportContext } from "./text-transport";
import type { WebChatTransportLease, WebChatTransportLeaseRegistry } from "./transport-lease";

/** A runner exchange: the core contract plus the facts an observer needs. */
export interface WebChatExchangeRunner extends WebChatExchange {
  snapshot(): WebChatExchangeSnapshot;
  retrySafety(): WebChatRetrySafety;
  /** The last physical settlement this exchange published, when it did. */
  settlement(): WebChatPhysicalSettlement | undefined;
  /** The lease this exchange owns, once `prepare()` acquired it. */
  lease(): WebChatTransportLease | undefined;
}

/** Options for {@link createWebChatExchange}. */
export interface WebChatExchangeOptions {
  readonly identity: WebChatTurnIdentity;
  readonly turn: WebChatTurnInput;
  readonly transport: WebChatTextTransport;
  readonly leases: WebChatTransportLeaseRegistry;
  /** Conversation epoch this exchange runs in; results from another epoch are stale. */
  readonly epoch?: number;
  /** Submission attempts this logical turn may make. */
  readonly maxSubmits?: number;
  /** Existing lease, when the caller already acquired one. */
  readonly lease?: WebChatTransportLease;
  /** Create the transport resource when the conversation has none. */
  readonly createResource?: () => Promise<{ id: string; conversationKey: string; epoch: number }>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/** Derive a stable exchange identity for one turn. */
function exchangeIdOf(identity: WebChatTurnIdentity): string {
  const seed = `${identity.bindingId}\u0000${identity.conversationKey ?? ""}\u0000${identity.turnId}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

/**
 * Create one exchange.
 *
 * @param options - identity, turn, transport, lease registry and budget.
 * @throws {TypeError} when the identity carries no conversation key or turn identity.
 */
export function createWebChatExchange(options: WebChatExchangeOptions): WebChatExchangeRunner {
  const { identity, turn, transport, leases } = options;
  if (!identity.conversationKey) throw new TypeError("A WebChat exchange requires a conversation key");
  if (!identity.turnId) throw new TypeError("A WebChat exchange requires a turn identity");
  const exchangeId = exchangeIdOf(identity);
  const controller = new AbortController();
  const externalSignal = options.signal;
  const conversationEpoch = options.epoch ?? options.lease?.resource.epoch ?? 1;
  const lifecycle = new WebChatExchangeLifecycle({
    exchangeId,
    conversationKey: identity.conversationKey,
    epoch: conversationEpoch,
    ...(options.maxSubmits !== undefined ? { maxSubmits: options.maxSubmits } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  let lease = options.lease;
  let settlement: WebChatPhysicalSettlement | undefined;
  let partialOutputObserved = false;

  const context = (): WebChatTextTransportContext => ({
    identity,
    turn,
    epoch: lifecycle.snapshot().epoch,
    signal: controller.signal,
  });

  let settlementPromise: Promise<WebChatPhysicalSettlement> | undefined;
  const publishSettlement = (): Promise<WebChatPhysicalSettlement> => {
    // One publication per exchange, shared by every caller: the turn's end and a cancellation can
    // race, and the provider must be asked exactly once.
    if (settlement !== undefined && settlement !== "pending") return Promise.resolve(settlement);
    settlementPromise ??= (async () => {
      const reported = await transport.settle(context());
      settlement = reported;
      lifecycle.markPhysicallySettled(reported);
      // The exchange records what it saw; the lease owns what the resource may do next.
      lease?.settle(reported);
      // A `pending` settlement may still resolve later, so a later caller may ask again.
      if (reported === "pending") settlementPromise = undefined;
      return reported;
    })();
    return settlementPromise;
  };

  /**
   * Establish the physical settlement of an exchange whose provider outcome is unknown.
   *
   * The transport is the only authority on settlement (architecture §9.3). If it cannot even report
   * one, the resource is not declared free: it is retired, and only an explicit reset brings it back.
   */
  const settleUnknownOutcome = async (): Promise<void> => {
    try {
      await publishSettlement();
    } catch {
      settlement = "rejected";
      lifecycle.markPhysicallySettled("rejected");
      lease?.settle("rejected");
    }
  };

  // The listener can fire before `exchange` exists (an already-aborted signal), so it goes through a
  // reference assigned once the exchange is built: no temporal dead zone, no ReferenceError.
  let exchangeRef: WebChatExchangeRunner | undefined;
  const abortListener = (): void => {
    void exchangeRef?.abort("the caller aborted the exchange").catch(() => undefined);
  };
  const disarm = (): void => {
    if (externalSignal) externalSignal.removeEventListener("abort", abortListener);
  };

  // §9.2: the provider exchange is aborted exactly once, whatever asked for the cancellation, and
  // every caller waits for that same operation. A flag would deduplicate the call but not order it:
  // the cancellation hook fires without awaiting, so `abort()` would proceed to settle the resource
  // while the provider abort was still running.
  let abortPromise: Promise<void> | undefined;
  const issueAbort = (reason?: unknown): Promise<void> => {
    abortPromise ??= Promise.resolve()
      .then(async () => { await transport.abort?.(context(), reason); })
      .catch(() => undefined);
    return abortPromise;
  };
  // Cancelling also aborts the signal the transport was given, so a transport that races on the
  // signal sees the same cancellation as one that uses `abort()`.
  lifecycle.attachCancellation((error) => {
    void issueAbort(error);
    controller.abort(error);
  });
  const exchange: WebChatExchangeRunner = {
    identity,

    async prepare() {
      lifecycle.markPreparing();
      try {
        lease = lease ?? await leases.acquire({
          exchangeId,
          conversationKey: identity.conversationKey!,
          epoch: conversationEpoch,
          ...(options.createResource ? { create: async () => options.createResource!() } : {}),
        });
        await transport.ready(context());
        lifecycle.markTransportReady();
      } catch (error) {
        lifecycle.markFailed();
        // Readiness precedes submission, so this failure never sent anything: the resource is
        // provably unused and stays reusable without asking the provider to settle an operation it
        // never started.
        settlement = "not_started";
        lifecycle.markPhysicallySettled("not_started");
        lease?.settle("not_started");
        disarm();
        throw error;
      }
    },

    async submit() {
      const state = lifecycle.snapshot().state;
      if (state !== "TRANSPORT_READY" && state !== "SUBMITTING") {
        // A retry of the same logical turn re-submits from SUBMITTING; anything else means the
        // exchange was never prepared, and the provider must not be asked to send.
        throw webChatError(
          "CONVERSATION_STATE_MISMATCH",
          `An exchange can only submit after it is transport-ready, not from ${state}`,
        );
      }
      lifecycle.markSubmitting();
      let phase: WebChatSubmissionPhase;
      try {
        phase = await transport.submit(context());
      } catch (error) {
        // A thrown submission failure proves nothing about whether the text was sent: a browser can
        // activate the send and then fail while confirming it. Fail closed — the exchange becomes
        // ambiguous (never automatically retried), and the resource is settled through the transport
        // instead of being declared free on an unknown state. A provider that *can* prove nothing was
        // submitted returns `prepared` rather than throwing.
        lifecycle.markSendActivated();
        await settleUnknownOutcome();
        throw error;
      }
      if (phase === "accepted") lifecycle.markSubmitted();
      else if (phase === "send_activated") lifecycle.markSendActivated();
      // `prepared`: the attempt left no trace, so the exchange stays in SUBMITTING and retry-safe.
    },

    async *stream() {
      try {
        for await (const event of transport.stream(context())) {
          if (!lifecycle.acceptsResult(event.epoch)) {
            // The event itself says which conversation generation produced it: a result from another
            // epoch, from a retired exchange, or arriving after cancellation is stale.
            continue;
          }
          if (event.type === "text_delta") {
            partialOutputObserved = true;
            lifecycle.markStreaming();
          }
          if (event.type === "completed") {
            lifecycle.markCompleted();
            yield event;
            break;
          }
          if (event.type === "cancelled") {
            lifecycle.markCancelled();
            yield event;
            break;
          }
          if (event.type === "error") {
            lifecycle.markFailed();
            yield event;
            break;
          }
          yield event;
        }
        if (!lifecycle.isTerminal()) {
          // The transport owes a terminal event. A stream that ends without one is an incomplete
          // exchange: partial output is not evidence that the turn finished, and reporting it as
          // completed would present a truncated answer as the answer.
          if (lifecycle.snapshot().cancelRequested) lifecycle.markCancelled();
          else lifecycle.markFailed();
        }
      } finally {
        // A logical outcome never proves the resource is reusable: settlement is published here, and
        // the lease keeps it unavailable until the provider proves it.
        await settleUnknownOutcome();
        disarm();
      }
    },

    async abort(reason?: unknown) {
      const already = lifecycle.snapshot().cancelRequested;
      lifecycle.cancel(typeof reason === "string" ? reason : undefined);
      if (!already && !lifecycle.isTerminal() && lifecycle.snapshot().state !== "SUBMISSION_AMBIGUOUS") {
        lifecycle.markCancelled();
      }
      // §9.2 order: logical cancellation -> abort the provider exchange -> wait for or force physical
      // settlement -> release the resource. A second caller waits for those same operations instead
      // of returning while the first one is still settling.
      await issueAbort(reason);
      await settleUnknownOutcome();
      disarm();
    },

    snapshot() {
      return lifecycle.snapshot();
    },
    retrySafety() {
      return webChatRetrySafetyOf({ snapshot: lifecycle.snapshot(), partialOutputObserved });
    },
    settlement() {
      return settlement;
    },
    lease() {
      return lease;
    },
  };

  exchangeRef = exchange;
  // Wired after the exchange exists, so an already-aborted signal can cancel it immediately.
  if (externalSignal) {
    if (externalSignal.aborted) abortListener();
    else externalSignal.addEventListener("abort", abortListener);
  }
  return exchange;
}

/** Whether an exchange is still able to produce output (used by callers that queue turns). */
export function isWebChatExchangeOpen(exchange: WebChatExchangeRunner): boolean {
  const snapshot = exchange.snapshot();
  return !snapshot.retired && !snapshot.cancelRequested;
}

/** Refuse to run a second exchange on a conversation that still has an unsettled one. */
export function assertWebChatExchangeSettled(exchange: WebChatExchangeRunner): void {
  const settlement = exchange.settlement();
  if (!exchange.snapshot().retired
    && settlement !== "fulfilled" && settlement !== "rejected" && settlement !== "not_started") {
    throw webChatError(
      "TRANSPORT_UNAVAILABLE",
      "The previous exchange on this conversation has not settled its transport",
    );
  }
}
