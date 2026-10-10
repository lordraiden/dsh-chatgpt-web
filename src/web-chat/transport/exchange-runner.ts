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
    signal: controller.signal,
  });

  const publishSettlement = async (): Promise<WebChatPhysicalSettlement> => {
    // One publication per exchange: a settlement that is already established is never asked for
    // again, while a `pending` one may still resolve.
    if (settlement !== undefined && settlement !== "pending") return settlement;
    const reported = await transport.settle(context());
    settlement = reported;
    lifecycle.markPhysicallySettled(reported);
    // The exchange records what it saw; the lease owns what the resource may do next.
    lease?.settle(reported);
    return reported;
  };

  const disarm = (): void => {
    if (externalSignal && abortListener) externalSignal.removeEventListener("abort", abortListener);
  };
  const abortListener = (): void => {
    void exchange.abort("the caller aborted the exchange").catch(() => undefined);
  };

  // §9.2: the provider exchange is aborted exactly once, whatever asked for the cancellation.
  let abortIssued = false;
  const issueAbort = async (reason?: unknown): Promise<void> => {
    if (abortIssued) return;
    abortIssued = true;
    await transport.abort?.(context(), reason).catch(() => undefined);
  };
  lifecycle.attachCancellation((error) => {
    void issueAbort(error);
  });
  if (externalSignal) {
    if (externalSignal.aborted) abortListener();
    else externalSignal.addEventListener("abort", abortListener);
  }

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
        // Nothing was submitted, so the resource was never used for output.
        await publishSettlement().catch(() => undefined);
        disarm();
        throw error;
      }
    },

    async submit() {
      lifecycle.markSubmitting();
      let phase;
      try {
        phase = await transport.submit(context());
      } catch (error) {
        // A rejected submission attempt is not proof that the provider accepted nothing, unless the
        // provider said so explicitly; the caller decides with the retry authority.
        lifecycle.markFailed();
        throw error;
      }
      if (phase === "accepted") lifecycle.markSubmitted();
      else if (phase === "send_activated") lifecycle.markSendActivated();
      // `prepared`: the attempt left no trace, so the exchange stays in SUBMITTING and retry-safe.
    },

    async *stream() {
      let sawDelta = false;
      try {
        for await (const event of transport.stream(context())) {
          if (!lifecycle.acceptsResult(lifecycle.snapshot().epoch)) {
            // A result from a retired exchange, or one arriving after cancellation, is stale.
            continue;
          }
          if (event.type === "text_delta") {
            sawDelta = true;
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
          if (lifecycle.snapshot().cancelRequested) lifecycle.markCancelled();
          else if (sawDelta) lifecycle.markCompleted();
          else lifecycle.markFailed();
        }
      } finally {
        // A logical outcome never proves the resource is reusable: settlement is published here, and
        // the lease keeps it unavailable until the provider proves it.
        await publishSettlement().catch(() => undefined);
        disarm();
      }
    },

    async abort(reason?: unknown) {
      const already = lifecycle.snapshot().cancelRequested;
      lifecycle.cancel(typeof reason === "string" ? reason : undefined);
      if (already) return;
      if (!lifecycle.isTerminal() && lifecycle.snapshot().state !== "SUBMISSION_AMBIGUOUS") {
        lifecycle.markCancelled();
      }
      // §9.2 order: logical cancellation -> abort the provider exchange -> wait for or force physical
      // settlement -> release the resource.
      await issueAbort(reason);
      await publishSettlement().catch(() => undefined);
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

  return exchange;
}

/** Whether an exchange is still able to produce output (used by callers that queue turns). */
export function isWebChatExchangeOpen(exchange: WebChatExchangeRunner): boolean {
  const snapshot = exchange.snapshot();
  return !snapshot.retired && !snapshot.cancelRequested;
}

/** Refuse to run a second exchange on a conversation that still has an unsettled one. */
export function assertWebChatExchangeSettled(exchange: WebChatExchangeRunner): void {
  if (!exchange.snapshot().retired && !exchange.settlement()) {
    throw webChatError(
      "TRANSPORT_UNAVAILABLE",
      "The previous exchange on this conversation has not settled its transport",
    );
  }
}
