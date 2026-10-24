/**
 * Transport resource ownership (architecture §9.2, §9.3, §15.1, §15.3).
 *
 * A transport resource is a physical thing the provider must own exclusively while it works: a
 * retained browser page, a network session, or anything else a provider needs. The lease owns
 * exactly four things:
 *
 * - the resource and exclusive ownership of it;
 * - release;
 * - forced retirement;
 * - physical settlement.
 *
 * It deliberately owns none of: DSH authorization, provider conversation identity, or canonical
 * history (architecture §15.3).
 *
 * The rule that matters most is that **a resource cannot be reused while a previous operation may
 * still produce output**. Releasing a lease without a published settlement leaves it `settling`, and
 * a second acquire is refused until settlement is published — an error, a timeout or a caller's
 * `release()` are never proof that the provider stopped.
 *
 * This module has no provider knowledge: it never sees a page, a selector or an endpoint.
 */
import { webChatError } from "../core/errors";
import type { WebChatPhysicalSettlement } from "../core/exchange-state";
import {
  createConversationAdmissionGate,
  DEFAULT_TRANSPORT_ADMISSION_WAIT_MS,
  type ConversationAdmissionGate,
} from "./conversation-admission";

export { DEFAULT_TRANSPORT_ADMISSION_WAIT_MS };

/** One physical transport resource. Its `id` is opaque to the core. */
export interface WebChatTransportResource {
  readonly id: string;
  readonly conversationKey: string;
  readonly epoch: number;
}

/** How a lease currently stands. */
export type WebChatTransportLeaseState = "active" | "settling" | "settled" | "retired";

/** What an observer may ask about one lease. */
export interface WebChatTransportLeaseSnapshot {
  readonly exchangeId: string;
  readonly conversationKey: string;
  readonly state: WebChatTransportLeaseState;
  readonly settlement?: WebChatPhysicalSettlement;
  readonly retiredReason?: string;
}

/** Exclusive ownership of one transport resource for one exchange. */
export interface WebChatTransportLease {
  readonly exchangeId: string;
  readonly resource: WebChatTransportResource;
  snapshot(): WebChatTransportLeaseSnapshot;
  /**
   * Publish the physical settlement of this exchange and give the resource back.
   *
   * `fulfilled` means nothing is in flight any more; `rejected` means settlement could not be
   * proven, which retires the resource instead of trusting it again; `not_started` means the
   * exchange never started the provider operation.
   */
  settle(outcome?: WebChatPhysicalSettlement): void;
  /**
   * Logical release, without claiming anything about settlement.
   *
   * Idempotent. The resource stays unavailable (`settling`) until a settlement is published.
   */
  release(): void;
  /** Forced retirement: the resource may not be used again until an explicit reset. */
  retire(reason: string): void;
}

/** Options for {@link WebChatTransportLeaseRegistry.acquire}. */
export interface WebChatTransportLeaseAcquireOptions {
  readonly exchangeId: string;
  readonly conversationKey: string;
  /** Conversation epoch the resource belongs to; a stale epoch is refused. */
  readonly epoch: number;
  /** Create the resource when this conversation has none. Omit to refuse an unrecorded resource. */
  readonly create?: () => Promise<WebChatTransportResource>;
}

/** Options for {@link WebChatTransportLeaseRegistry.admitConversation}. */
export interface WebChatTransportAdmissionOptions {
  /** Identity of the requester, so its own re-admission is re-entrant and only it may release. */
  readonly holder: string;
  readonly conversationKey: string;
  /** Cancellation of the whole turn; a cancelled wait fails as `CANCELLED`. */
  readonly signal?: AbortSignal;
}

/** Options for {@link createWebChatTransportLeaseRegistry}. */
export interface WebChatTransportLeaseRegistryOptions {
  /**
   * Bound of one conversation admission wait. `0` (the default) keeps the historical immediate
   * refusal; a positive value serialises a transient overlap instead of failing it.
   */
  readonly admissionWaitMs?: number;
}

/** The registry that owns exclusivity per conversation. */
export interface WebChatTransportLeaseRegistry {
  acquire(options: WebChatTransportLeaseAcquireOptions): Promise<WebChatTransportLease>;
  /** True when the conversation is owned, settling, or being acquired right now. */
  isLeased(conversationKey: string): boolean;
  isRetired(conversationKey: string): boolean;
  /** What the registry knows about one conversation. */
  describe(conversationKey: string): {
    readonly leased: boolean;
    readonly retired: boolean;
    readonly settling: boolean;
    readonly creating: boolean;
  };
  /**
   * Take the one **admission slot** for a conversation, waiting for its current holder to release it.
   *
   * This is the serialising half of the same exclusivity rule: it is taken **before** the continuity
   * decision, so a transient overlap — this product's harness issuing its housekeeping session-title
   * call at the same moment as the user's first message, with no declared `purpose` on the wire — is
   * absorbed by waiting instead of failing the user's turn. The wait is *bounded*
   * ({@link WebChatTransportLeaseRegistryOptions.admissionWaitMs}), *cancellable* through the caller's
   * abort signal, and *event-driven*: a waiter holds nothing while it waits and is woken by the
   * release, never by polling. On expiry the refusal is exactly the one this layer already
   * publishes, so a genuine concurrency violation still fails closed.
   */
  admitConversation(options: WebChatTransportAdmissionOptions): Promise<void>;
  /** Release an admission slot this holder owns. Idempotent, and silent for another holder. */
  releaseConversation(holder: string, conversationKey: string): void;
  /** Whether a conversation currently has an admission holder. */
  isConversationAdmitted(conversationKey: string): boolean;
  /** Diagnostic: how many admissions are currently waiting. */
  admissionWaiterCount(): number;
  /** Refuse every waiter and forget every admission. Idempotent; used on shutdown. */
  close(): void;
  /**
   * Explicit recovery for a retired conversation: the only way to clear a tombstone.
   *
   * Nothing clears it implicitly; a lost resource never becomes a new one on its own.
   */
  reset(conversationKey: string): void;
}

interface RegistryEntry {
  resource?: WebChatTransportResource;
  lease?: WebChatTransportLease;
}

/** The one refusal this layer already publishes for a conversation that is still owned. */
function conversationBusyError(): Error {
  return webChatError(
    "TRANSPORT_UNAVAILABLE",
    "Another exchange still owns this conversation's transport resource",
  );
}

/** A cancelled admission wait is a cancellation, never a provider failure. */
function admissionAbortError(signal?: AbortSignal): Error {
  return webChatError(
    "CANCELLED",
    "The wait for this conversation's transport was cancelled",
    signal?.reason === undefined ? {} : { cause: signal.reason },
  );
}

/** A closed registry is a shutdown, so a waiter learns why it can never be admitted. */
function registryClosedError(): Error {
  return webChatError("SHUTDOWN", "The transport lease registry is closed");
}

/**
 * Create a lease registry.
 *
 * Exclusivity is per conversation: a second exchange on the same conversation is refused while the
 * first may still produce output. When a positive `admissionWaitMs` is configured, the serialising
 * admission ({@link WebChatTransportLeaseRegistry.admitConversation}) waits that long for a
 * transient overlap instead of refusing it; the lease acquisition itself keeps its immediate refusal,
 * so the resource is never handed to two exchanges.
 */
export function createWebChatTransportLeaseRegistry(
  options: WebChatTransportLeaseRegistryOptions = {},
): WebChatTransportLeaseRegistry {
  const admissionWaitMs = options.admissionWaitMs ?? 0;
  if (!Number.isFinite(admissionWaitMs) || admissionWaitMs < 0) {
    throw new Error("A transport lease registry admission wait must be a non-negative finite number");
  }
  const entries = new Map<string, RegistryEntry>();
  /**
   * In-flight creations, per conversation.
   *
   * Creating a resource is asynchronous, so two acquisitions that both see an empty registry would
   * both create one and both receive an active lease — breaking the exclusivity this registry exists
   * to guarantee. The reservation is taken before the first `await` and released when the creation
   * settles, either way.
   */
  const pendingAcquires = new Set<string>();
  /**
   * The admission slots are the **serialising** half of the same rule the lease enforces for the
   * resource: a slot is held from before a turn's continuity decision until the turn ends, so two
   * turns of one conversation are ordered rather than racing. The gate below is the one shared owner
   * of that mechanism (the ChatGPT provider composes it too); a registry constructed without a bound
   * keeps the historical immediate refusal.
   */
  const admission: ConversationAdmissionGate = createConversationAdmissionGate({
    admissionWaitMs,
    busyError: conversationBusyError,
    abortError: admissionAbortError,
    closedError: registryClosedError,
  });
  let closed = false;

  return {
    async acquire(options) {
      const { conversationKey, exchangeId, epoch } = options;
      if (!conversationKey) throw new TypeError("A transport lease requires a conversation key");
      if (!exchangeId) throw new TypeError("A transport lease requires an exchange identity");
      if (!Number.isSafeInteger(epoch) || epoch < 1) throw new TypeError("A transport lease requires a positive epoch");
      const entry = entries.get(conversationKey);
      if (entry?.lease && entry.lease.snapshot().state !== "settled") {
        if (entry.lease.snapshot().state === "retired") {
          throw webChatError(
            "CONVERSATION_LOST",
            `The transport resource for this conversation was retired (${entry.lease.snapshot().retiredReason ?? "continuity lost"})`,
          );
        }
        throw conversationBusyError();
      }
      if (entry?.resource && entry.resource.epoch > epoch) {
        throw webChatError(
          "CONVERSATION_STATE_MISMATCH",
          `The transport resource belongs to epoch ${entry.resource.epoch}, not ${epoch}`,
        );
      }
      let resource = entry?.resource;
      if (!resource) {
        if (!options.create) {
          throw webChatError("CONVERSATION_LOST", "No transport resource exists for this conversation");
        }
        if (pendingAcquires.has(conversationKey)) {
          throw webChatError(
            "TRANSPORT_UNAVAILABLE",
            "A transport resource for this conversation is being created",
          );
        }
        pendingAcquires.add(conversationKey);
        try {
          resource = await options.create();
        } finally {
          // Reserved until the creation settles, so a failure never leaves the reservation behind.
          pendingAcquires.delete(conversationKey);
        }
      }

      let state: WebChatTransportLeaseState = "active";
      let settlement: WebChatPhysicalSettlement | undefined;
      let retiredReason: string | undefined;
      const snapshot = (): WebChatTransportLeaseSnapshot => ({
        exchangeId,
        conversationKey,
        state,
        ...(settlement !== undefined ? { settlement } : {}),
        ...(retiredReason !== undefined ? { retiredReason } : {}),
      });
      const retire = (reason: string): void => {
        if (state === "retired") return;
        state = "retired";
        retiredReason = reason;
      };
      const lease: WebChatTransportLease = {
        exchangeId,
        resource,
        snapshot,
        settle(outcome: WebChatPhysicalSettlement = "fulfilled") {
          if (state === "settled") return;
          if (state === "retired") throw webChatError("CONVERSATION_STATE_MISMATCH", "A retired transport lease cannot settle");
          settlement = outcome;
          if (outcome === "pending") {
            state = "settling";
          } else if (outcome === "rejected") {
            retire("physical settlement could not be proven");
          } else {
            state = "settled";
          }
        },
        release() {
          if (state === "settled" || state === "retired") return;
          // No settlement was published: the resource stays unavailable until one is.
          state = "settling";
        },
        retire(reason: string) {
          retire(reason);
        },
      };
      entries.set(conversationKey, { resource, lease });
      return lease;
    },
    isLeased(conversationKey) {
      if (pendingAcquires.has(conversationKey)) return true;
      const state = entries.get(conversationKey)?.lease?.snapshot().state;
      return state === "active" || state === "settling";
    },
    isRetired(conversationKey) {
      return entries.get(conversationKey)?.lease?.snapshot().state === "retired";
    },
    describe(conversationKey) {
      const state = entries.get(conversationKey)?.lease?.snapshot().state;
      return {
        leased: state === "active",
        settling: state === "settling",
        retired: state === "retired",
        creating: pendingAcquires.has(conversationKey),
      };
    },
    reset(conversationKey) {
      const entry = entries.get(conversationKey);
      if (!entry) return;
      if (pendingAcquires.has(conversationKey)) {
        throw webChatError("CONVERSATION_STATE_MISMATCH", "A transport resource is being created and cannot be reset");
      }
      // Explicit recovery forgets a resource that is provably done with: an operation in flight
      // (`active`) or one whose settlement has not been published (`settling`) may still produce
      // output, so neither may be forgotten — only a settled or retired entry can.
      const state = entry.lease?.snapshot().state;
      if (state === "active") {
        throw webChatError("CONVERSATION_STATE_MISMATCH", "An active transport lease cannot be reset");
      }
      if (state === "settling") {
        throw webChatError(
          "CONVERSATION_STATE_MISMATCH",
          "A transport lease whose settlement has not been published cannot be reset",
        );
      }
      entries.delete(conversationKey);
    },
    admitConversation({ holder, conversationKey, signal }) {
      return admission.admit({ holder, conversationKey, ...(signal ? { signal } : {}) });
    },
    releaseConversation(holder, conversationKey) {
      admission.release(holder, conversationKey);
    },
    isConversationAdmitted(conversationKey) {
      return admission.isAdmitted(conversationKey);
    },
    admissionWaiterCount() {
      return admission.waiterCount();
    },
    close() {
      if (closed) return;
      closed = true;
      admission.close();
    },
  };
}
