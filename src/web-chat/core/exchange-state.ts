/**
 * Provider-neutral exchange lifecycle (architecture §9).
 *
 * One text exchange follows the same high-level path whatever the provider's transport is:
 *
 * ```text
 * CREATED -> PREPARING -> TRANSPORT_READY -> SUBMITTING -> SUBMITTED -> STREAMING -> COMPLETED
 * ```
 *
 * with the terminal alternatives of architecture §9: `FAILED`, `SUBMISSION_AMBIGUOUS` and
 * `CANCELLED`, plus retirement for a stale exchange.
 *
 * Three distinctions this module exists to keep:
 *
 * - **The submit boundary is authoritative.** `WebChatSubmissionPhase` records whether the provider
 *   can still prove the text was not submitted (`prepared`), whether it *may* have accepted it
 *   (`send_activated` — ambiguous by definition), or whether acceptance is confirmed (`accepted`).
 *   Retry safety is derived from this, never from whether a response arrived.
 * - **Logical and physical settlement are separate.** A turn can be logically finished while the
 *   transport resource may still produce late output. Both are tracked, and only a published
 *   physical settlement makes a resource reusable.
 * - **Stale results are refused.** An exchange belongs to one conversation epoch; a result or a
 *   settlement from another epoch, or one arriving after cancellation/retirement, is not accepted.
 *
 * This module has no provider knowledge and no runtime dependency: it never learns how readiness,
 * submission or completion are detected.
 */
import type { WebChatContinuationOutcome } from "./continuation";
import { webChatError } from "./errors";

/** The monotonic states of one exchange (architecture §9). */
export type WebChatExchangeState =
  | "CREATED"
  | "PREPARING"
  | "TRANSPORT_READY"
  | "SUBMITTING"
  | "SUBMITTED"
  | "STREAMING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "SUBMISSION_AMBIGUOUS";

/**
 * How far submission is proven to have gone (architecture §9.1).
 *
 * `send_activated` is the provider's own admission that submission *may* have happened: it is the
 * ambiguous boundary, and it is a first-class outcome rather than an error to be retried.
 */
export type WebChatSubmissionPhase = "prepared" | "send_activated" | "accepted";

/** How the logical turn finished. */
export type WebChatLogicalSettlement = "pending" | "completed" | "failed" | "cancelled";

/**
 * Whether the physical transport resource is proven safe again (architecture §9.3).
 *
 * An error or a timeout never proves that a browser/network operation stopped, so this stays
 * `pending` until the driver reports settlement.
 */
export type WebChatPhysicalSettlement = "not_started" | "pending" | "fulfilled" | "rejected";

/** The states from which an exchange cannot move on. */
const TERMINAL_STATES: readonly WebChatExchangeState[] = [
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "SUBMISSION_AMBIGUOUS",
];

/** Allowed transitions, exactly as architecture §9 lays them out. */
const TRANSITIONS: Record<WebChatExchangeState, readonly WebChatExchangeState[]> = {
  CREATED: ["PREPARING", "FAILED", "CANCELLED"],
  PREPARING: ["TRANSPORT_READY", "FAILED", "CANCELLED"],
  TRANSPORT_READY: ["SUBMITTING", "FAILED", "CANCELLED"],
  SUBMITTING: ["SUBMITTED", "SUBMISSION_AMBIGUOUS", "FAILED", "CANCELLED"],
  SUBMITTED: ["STREAMING", "COMPLETED", "FAILED", "CANCELLED"],
  STREAMING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
  // Ambiguity is terminal for the *outcome* of this exchange, but the provider may still establish
  // how the turn ended: that resolution is the only movement out of it.
  SUBMISSION_AMBIGUOUS: ["COMPLETED", "FAILED", "CANCELLED"],
};

const RECOVERY_RANK: Record<WebChatContinuationOutcome, number> = {
  new_conversation: 0,
  exact_resume: 1,
  replay: 1,
  failed: 2,
};

/** Everything an observer may ask about one exchange. */
export interface WebChatExchangeSnapshot {
  readonly exchangeId: string;
  readonly conversationKey: string;
  /** Conversation epoch this exchange belongs to; results from another epoch are stale. */
  readonly epoch: number;
  readonly state: WebChatExchangeState;
  readonly phase: WebChatSubmissionPhase;
  readonly logical: WebChatLogicalSettlement;
  readonly physical: WebChatPhysicalSettlement;
  readonly retired: boolean;
  readonly retiredReason?: string;
  readonly cancelRequested: boolean;
  /** How many times a submission was attempted; the retry budget counts these. */
  readonly submits: number;
  readonly maxSubmits: number;
  /** The recovery decision recorded for this exchange, when one was made. */
  readonly recovery?: WebChatContinuationOutcome;
  readonly updatedAt: number;
}

/** Construction options for {@link WebChatExchangeLifecycle}. */
export interface WebChatExchangeLifecycleOptions {
  readonly exchangeId: string;
  readonly conversationKey: string;
  /** Conversation epoch (the generation the exchange runs in). */
  readonly epoch: number;
  /** Submission attempts allowed for one logical turn. */
  readonly maxSubmits?: number;
  readonly now?: () => number;
}

/**
 * The lifecycle of one exchange.
 *
 * Every mutation is guarded: an illegal transition, a mutation of a terminal or retired exchange, a
 * submission attempt beyond the budget, a recovery that would downgrade a previous decision, or a
 * settlement claiming to come from a retired exchange all fail explicitly. Nothing here decides
 * provider behavior; it records what the exchange is allowed to do next.
 */
export class WebChatExchangeLifecycle {
  private state: WebChatExchangeState = "CREATED";
  private phase: WebChatSubmissionPhase = "prepared";
  private logical: WebChatLogicalSettlement = "pending";
  private physical: WebChatPhysicalSettlement = "not_started";
  private retired = false;
  private retiredReason: string | undefined;
  private cancelRequested = false;
  private submits = 0;
  private recovery: WebChatContinuationOutcome | undefined;
  private updatedAt: number;
  private cancelExecution?: (reason: Error) => void;

  private readonly exchangeId: string;
  private readonly conversationKey: string;
  private readonly epoch: number;
  private readonly maxSubmits: number;
  private readonly now: () => number;

  constructor(options: WebChatExchangeLifecycleOptions) {
    if (!options.exchangeId) throw new TypeError("An exchange lifecycle requires an exchange identity");
    if (!options.conversationKey) throw new TypeError("An exchange lifecycle requires a conversation key");
    if (!Number.isSafeInteger(options.epoch) || options.epoch < 1) {
      throw new TypeError("An exchange lifecycle requires a positive conversation epoch");
    }
    const maxSubmits = options.maxSubmits ?? 1;
    if (!Number.isSafeInteger(maxSubmits) || maxSubmits < 1) {
      throw new TypeError("An exchange lifecycle requires a positive submission budget");
    }
    this.exchangeId = options.exchangeId;
    this.conversationKey = options.conversationKey;
    this.epoch = options.epoch;
    this.maxSubmits = maxSubmits;
    this.now = options.now ?? (() => Date.now());
    this.updatedAt = this.now();
  }

  snapshot(): WebChatExchangeSnapshot {
    return {
      exchangeId: this.exchangeId,
      conversationKey: this.conversationKey,
      epoch: this.epoch,
      state: this.state,
      phase: this.phase,
      logical: this.logical,
      physical: this.physical,
      retired: this.retired,
      ...(this.retiredReason !== undefined ? { retiredReason: this.retiredReason } : {}),
      cancelRequested: this.cancelRequested,
      submits: this.submits,
      maxSubmits: this.maxSubmits,
      ...(this.recovery !== undefined ? { recovery: this.recovery } : {}),
      updatedAt: this.updatedAt,
    };
  }

  /** Whether this exchange is finished, whatever its outcome was. */
  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.state);
  }

  /**
   * Whether a result that arrived now belongs to this exchange.
   *
   * A result from another conversation epoch, or one arriving after cancellation or retirement, is
   * stale: it must never be presented as this turn's output.
   */
  acceptsResult(epoch: number): boolean {
    if (epoch !== this.epoch) return false;
    if (this.retired) return false;
    if (this.cancelRequested) return false;
    return true;
  }

  /**
   * Whether the physical resource may be reused.
   *
   * Only a published settlement makes that true; a logical outcome does not.
   */
  isResourceReusable(): boolean {
    if (this.retired) return false;
    // Nothing started, or settlement was published: nothing can still produce output.
    return this.physical !== "pending";
  }

  markPreparing(): void {
    this.transition("PREPARING");
    this.physical = "not_started";
  }

  markTransportReady(): void {
    this.transition("TRANSPORT_READY");
  }

  /** A submission attempt starts; it is not yet proof that the provider accepted anything. */
  markSubmitting(): void {
    this.assertMutable();
    if (this.state === "CREATED") this.transition("PREPARING");
    if (this.state === "PREPARING") this.transition("TRANSPORT_READY");
    if (this.phase === "prepared" && this.submits >= this.maxSubmits) {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `The submission budget of this exchange is exhausted (${this.submits}/${this.maxSubmits})`,
      );
    }
    if (this.state !== "SUBMITTING") this.transition("SUBMITTING");
    this.submits += 1;
    this.physical = "pending";
    this.touch();
  }

  /**
   * The provider admits submission may have happened without confirming it.
   *
   * This is the ambiguous boundary: the exchange stops being retryable, and the turn's outcome stays
   * unknown until the provider (or an explicit recovery decision) resolves it.
   */
  markSendActivated(): void {
    this.assertMutable();
    if (this.state === "SUBMITTING") {
      this.phase = "send_activated";
      this.transition("SUBMISSION_AMBIGUOUS");
      return;
    }
    // A later activation report is only meaningful while the submission is still unconfirmed.
    if (this.phase === "prepared") {
      this.phase = "send_activated";
      return;
    }
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      `Submission activation cannot be reported from ${this.state}`,
    );
  }

  /** Submission is confirmed: from here an automatic duplicate submission is forbidden. */
  markSubmitted(): void {
    this.assertMutable();
    if (this.phase === "prepared") this.phase = "send_activated";
    if (this.state === "CREATED" || this.state === "PREPARING" || this.state === "TRANSPORT_READY") {
      this.transition("SUBMITTING");
    }
    if (this.state === "SUBMITTING") this.transition("SUBMITTED");
    this.phase = "accepted";
    this.touch();
  }

  markStreaming(): void {
    this.assertMutable();
    if (this.state === "SUBMITTED") this.transition("STREAMING");
    else if (this.state !== "STREAMING") {
      throw webChatError("CONVERSATION_STATE_MISMATCH", `Streaming cannot start from ${this.state}`);
    }
    this.touch();
  }

  markCompleted(): void {
    this.markLogicallySettled("completed");
  }

  markCancelled(): void {
    this.markLogicallySettled("cancelled");
  }

  markFailed(): void {
    this.markLogicallySettled("failed");
  }

  /**
   * Publication of the ambiguous outcome, when the provider reports it explicitly.
   *
   * The logical settlement deliberately stays `pending`: the turn's outcome is unknown, not failed.
   */
  markAmbiguous(): void {
    this.assertMutable();
    this.phase = "send_activated";
    if (this.state !== "SUBMISSION_AMBIGUOUS") this.transition("SUBMISSION_AMBIGUOUS");
    this.physical = this.physical === "not_started" ? "pending" : this.physical;
    this.touch();
  }

  /**
   * Settle the logical turn.
   *
   * This is the one mutation that stays legal after retirement: a turn can finish logically after
   * its exchange was written off.
   */
  markLogicallySettled(outcome: Exclude<WebChatLogicalSettlement, "pending">): void {
    if (this.logical !== "pending") {
      // A logical outcome is reached once; a retired-but-unsettled exchange may still reach it.
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `The exchange already settled logically as ${this.logical}`,
      );
    }
    this.logical = outcome;
    const target: WebChatExchangeState = outcome === "completed"
      ? "COMPLETED"
      : outcome === "cancelled"
        ? "CANCELLED"
        : "FAILED";
    if (this.state !== target) {
      if (TERMINAL_STATES.includes(this.state) && this.state !== "SUBMISSION_AMBIGUOUS") {
        throw webChatError("CONVERSATION_STATE_MISMATCH", `Cannot settle ${this.state} as ${outcome}`);
      }
      this.transition(target);
    }
    if (this.physical === "not_started") this.physical = "pending";
    this.touch();
  }

  /**
   * Publish the provider's physical settlement.
   *
   * `fulfilled` means the operation is proven finished; `rejected` means it cannot be proven, which
   * forces the resource to be retired rather than trusted again.
   */
  markPhysicallySettled(outcome: WebChatPhysicalSettlement): void {
    this.physical = outcome;
    if (outcome === "rejected") this.retire("the transport could not prove physical settlement");
    this.touch();
  }

  /**
   * Record the recovery decision made for this exchange.
   *
   * Recovery is monotonic: an exact resume can never be downgraded to a replay, and neither can be
   * rewritten as the other.
   */
  markRecovery(value: WebChatContinuationOutcome): void {
    if (value === "new_conversation") {
      throw webChatError("CONVERSATION_STATE_MISMATCH", "A new conversation is not a recovery of an existing exchange");
    }
    const previous = this.recovery;
    if (previous !== undefined) {
      if (RECOVERY_RANK[value] < RECOVERY_RANK[previous]) {
        throw webChatError("CONVERSATION_STATE_MISMATCH", `Exchange recovery cannot downgrade: ${previous} -> ${value}`);
      }
      if (previous === "exact_resume" && value === "replay") {
        throw webChatError("CONVERSATION_STATE_MISMATCH", "An exact resume cannot be reclassified as a replay");
      }
      if (previous === "replay" && value === "exact_resume") {
        throw webChatError("CONVERSATION_STATE_MISMATCH", "A replay cannot be reclassified as an exact resume");
      }
    }
    this.recovery = value;
    this.touch();
  }

  /**
   * Write this exchange off: its resource is stale and may not be presented as current again.
   *
   * Retirement is terminal for the exchange and does not by itself settle the physical resource; the
   * lease owns that.
   */
  markRetired(reason?: string): void {
    if (this.retired) return;
    this.retire(reason ?? "the exchange was retired");
  }

  /** Attach the provider's cancel callback, invoked once on the first logical cancellation. */
  attachCancellation(cancel: (reason: Error) => void): void {
    this.cancelExecution = cancel;
  }

  /**
   * Ask for cancellation.
   *
   * Idempotent: only the first request notifies the provider, and a finished exchange is left alone.
   */
  cancel(reason?: string): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.touch();
    if (TERMINAL_STATES.includes(this.state)) return;
    const error = reason === undefined ? new Error("The exchange was cancelled") : new Error(reason);
    this.cancelExecution?.(error);
  }

  private retire(reason: string): void {
    if (this.retired) return;
    this.retired = true;
    this.retiredReason = reason;
    this.touch();
  }

  private assertMutable(): void {
    if (this.retired) {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `A retired exchange cannot accept lifecycle mutations${this.retiredReason ? ` (${this.retiredReason})` : ""}`,
      );
    }
    if (TERMINAL_STATES.includes(this.state)) {
      throw webChatError("CONVERSATION_STATE_MISMATCH", `The exchange is ${this.state.toLowerCase()} and cannot change state`);
    }
  }

  private transition(next: WebChatExchangeState): void {
    if (this.retired) {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `A retired exchange cannot change state${this.retiredReason ? ` (${this.retiredReason})` : ""}`,
      );
    }
    // The one way out of the ambiguous outcome: the provider finally established how it ended.
    const leavingAmbiguity = this.state === "SUBMISSION_AMBIGUOUS"
      && (next === "COMPLETED" || next === "FAILED" || next === "CANCELLED");
    if (TERMINAL_STATES.includes(this.state) && !leavingAmbiguity) {
      throw webChatError("CONVERSATION_STATE_MISMATCH", `The exchange is ${this.state.toLowerCase()} and cannot change state`);
    }
    const allowed = TRANSITIONS[this.state];
    if (!allowed.includes(next)) {
      throw webChatError("CONVERSATION_STATE_MISMATCH", `Invalid exchange transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    this.touch();
  }

  private touch(): void {
    this.updatedAt = this.now();
  }
}
