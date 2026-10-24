import { createHash } from "node:crypto";
import {
  WebChatExchangeLifecycle,
  decideWebChatRetry,
  type WebChatContinuationOutcome,
  type WebChatRetryRefusal,
} from "../../web-chat/core";
import {
  createConversationAdmissionGate,
  DEFAULT_TRANSPORT_ADMISSION_WAIT_MS,
  type ConversationAdmissionGate,
} from "../../web-chat/transport/conversation-admission";
import { ChatGptWebAdapterError, chatGptRetainedSurfaceBusyError } from "./adapter-error";
import type { CapabilitySnapshot } from "./capability-projector";
import { MAX_CHATGPT_BROWSER_TABS, chatGptBrowserTurnLimitError } from "./concurrency";

export const CHATGPT_WEB_PROVIDER_CORE_SERVICE = "chatgpt-web" as const;

export type ProviderTurnState =
  | "PREPARING"
  | "LEASED"
  | "SURFACE_READY"
  | "SUBMITTED"
  | "RUNNING"
  | "SETTLING"
  | "RETIRED";

export type ProviderTurnActivity = "idle" | "running" | "capability_wait";

export type ProviderRecovery = "NEW" | "EXACT_RESUME" | "REPLAY" | "FAILED";

export type SubmissionPhase = "prepared" | "send_activated" | "accepted";

export type PhysicalSettlementOutcome = "not_started" | "pending" | "fulfilled" | "rejected";

export type LogicalSettlementOutcome = "pending" | "completed" | "failed" | "cancelled";

export interface ProviderTurnPhysicalResourceBinding {
  resourceId: string;
  browserContextId: string;
  pageId: string;
  profileId: string;
  accountId: string;
}

type RetryPolicy = "strict" | "side_effect_free";

interface ProviderRetryBudget {
  attempts: number;
  lastRetryAt: number;
}

/**
 * The core's refusal vocabulary mapped onto the provider's (issue #192).
 *
 * The provider keeps its historical four reasons; the core's sharper ones (`ambiguous`,
 * `partial_output`, `cancelled`) all mean the same thing here: this turn may already have been
 * submitted, so it is not retryable.
 */
const CORE_RETRY_REASONS: Record<WebChatRetryRefusal, NonNullable<ProviderRetryDecision["reason"]>> = {
  submitted: "submitted",
  ambiguous: "submitted",
  partial_output: "submitted",
  cancelled: "submitted",
  budget_exhausted: "budget_exhausted",
  retired: "retired",
  policy: "policy",
};

export interface ProviderRetryDecision {
  readonly allowed: boolean;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason?: "submitted" | "budget_exhausted" | "retired" | "policy";
}

// Maximum automatic retries after the initial browser submission attempt.
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;
const DEFAULT_SHUTDOWN_SETTLEMENT_GRACE_MS = 5_000;

/**
 * The caller's cancellation, in the shape the rest of the turn path reports it.
 *
 * Mirrors the adapter's own `abortError`: a cancellation the caller already classified keeps its
 * category; anything else is the canonical `AbortError` the turn loop recognizes.
 */
function conversationWaitAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof ChatGptWebAdapterError
    ? signal.reason
    : new DOMException("ChatGPT web turn aborted", "AbortError");
}

const TRANSITIONS: Record<ProviderTurnState, readonly ProviderTurnState[]> = {
  PREPARING: ["LEASED", "SETTLING"],
  LEASED: ["SURFACE_READY", "SETTLING"],
  SURFACE_READY: ["SUBMITTED", "SETTLING"],
  SUBMITTED: ["RUNNING", "SETTLING"],
  RUNNING: ["SETTLING"],
  SETTLING: ["RETIRED"],
  RETIRED: [],
};

const RECOVERY_ORDER: Record<ProviderRecovery, number> = {
  NEW: 0,
  EXACT_RESUME: 1,
  REPLAY: 1,
  FAILED: 2,
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function capabilityBindingIdForExecution(
  executionKey: string,
  capabilitySnapshotId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ executionKey, capabilitySnapshotId }))
    .digest("hex");
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface BrowserAccountLeaseDescriptor {
  serviceId: string;
  accountIdentity: string;
  /**
   * Whether `accountIdentity` was recorded by a completed sign-in. Absent means recorded: a caller
   * that states a logical account identity explicitly is claiming it, and only a caller that knows the
   * value is `providerConfig`'s derived fallback says so. The binding check uses this to distinguish
   * "no identity was ever recorded" from "two recorded identities disagree" — it never relaxes the
   * refusal itself.
   */
  accountIdentityRecorded?: boolean;
  browserProfile: string;
  browserContext: string;
  pageIdentity: string;
  turnId: string;
}

/** The refusal for a browser account that disagrees with a **recorded** logical identity. */
export const CHATGPT_WEB_ACCOUNT_IDENTITY_MISMATCH_MESSAGE =
  "Browser lease physical account does not match its logical account identity";

/**
 * The refusal for a deployment that never recorded an account identity at all.
 *
 * `providerConfig` substitutes a fallback derived from the storage-state file when
 * `accountIdentityFingerprint` is absent, and that fallback is not an account identity
 * (`accountIdentityFromStorageState`), so it can never match the account the signed-in page exposes.
 * Reporting that as a "mismatch" is true but useless: the operator needs the cause and the action.
 * The check still refuses — a guess never binds.
 */
export const CHATGPT_WEB_ACCOUNT_IDENTITY_MISSING_MESSAGE =
  "ChatGPT Web has no recorded account identity for this deployment, so the browser account cannot be "
  + "verified against one: sign in again at the operator sign-in surface (/v1/control/auth/) to record it";

export class BrowserAccountLease {
  readonly leaseId: string;
  readonly acquiredAt = Date.now();
  private released = false;
  private physicalResource?: ProviderTurnPhysicalResourceBinding;

  constructor(readonly descriptor: BrowserAccountLeaseDescriptor) {
    this.leaseId = [
      descriptor.serviceId,
      fingerprint(descriptor.accountIdentity),
      fingerprint(descriptor.browserProfile),
      fingerprint(descriptor.browserContext),
      fingerprint(descriptor.pageIdentity),
      descriptor.turnId,
    ].join(":");
  }

  isActive(): boolean {
    return !this.released;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
  }

  bindPhysicalResource(binding: ProviderTurnPhysicalResourceBinding): void {
    if (!this.isActive()) throw new Error("Cannot bind a physical resource to an inactive browser lease");
    for (const [name, value] of Object.entries(binding)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Browser lease physical resource ${name} must be a non-empty string`);
      }
    }
    const expectedAccountId = `chatgpt-account:${this.descriptor.accountIdentity}`;
    if (binding.accountId !== expectedAccountId) {
      // One owner of the distinction: this is the only place the two sides are compared. A derived
      // fallback means no identity was ever recorded, which is a different failure from two recorded
      // identities disagreeing — and the operator can act on the first one. Both refuse; neither binds.
      if (this.descriptor.accountIdentityRecorded === false) {
        throw new Error(CHATGPT_WEB_ACCOUNT_IDENTITY_MISSING_MESSAGE);
      }
      // Both sides, fingerprinted: the operator needs to see *which* physical account refused, but a
      // raw account identifier never travels. `fingerprint` is this file's own sanitizer.
      throw new Error(
        `${CHATGPT_WEB_ACCOUNT_IDENTITY_MISMATCH_MESSAGE}: `
        + `expected ${fingerprint(expectedAccountId)}, actual ${fingerprint(binding.accountId)}`,
      );
    }
    if (this.physicalResource && this.physicalResource.resourceId !== binding.resourceId) {
      throw new Error(
        `Browser lease cannot move to a different physical resource: ${this.physicalResource.resourceId} -> ${binding.resourceId}`,
      );
    }
    this.physicalResource = { ...binding };
  }

  physicalResourceBinding(): ProviderTurnPhysicalResourceBinding | undefined {
    return this.physicalResource ? { ...this.physicalResource } : undefined;
  }

  provenance(): {
    serviceId: string;
    account: string;
    browserProfile: string;
    browserContext: string;
    page: string;
    turnId: string;
    leaseId: string;
    physicalResourceBound: boolean;
  } {
    return {
      serviceId: this.descriptor.serviceId,
      account: fingerprint(this.descriptor.accountIdentity),
      browserProfile: fingerprint(this.descriptor.browserProfile),
      browserContext: fingerprint(this.descriptor.browserContext),
      page: fingerprint(this.descriptor.pageIdentity),
      turnId: this.descriptor.turnId,
      leaseId: this.leaseId,
      physicalResourceBound: this.physicalResource !== undefined,
    };
  }
}

export class BrowserAccountLeaseRegistry {
  private readonly leases = new Map<string, BrowserAccountLease>();
  private readonly physicalResources = new Map<string, BrowserAccountLease>();
  /**
   * Active leases per authenticated account. The account is a bounded, not an
   * exclusive, resource: this registry owns the account fan-out ceiling that
   * MAX_CHATGPT_BROWSER_TABS defines for the browser layer, nothing more. Every
   * per-turn exclusion is owned elsewhere — the conversationKey surface registry
   * rejects a busy conversation (issue #171), a shared physical resource is
   * rejected below, and `begin()` rejects a second turn for one active native
   * DSH thread — so two distinct DSH chats may hold their own leases at once,
   * each on its own retained page.
   */
  private readonly accountLeases = new Map<string, Set<BrowserAccountLease>>();

  private accountKey(descriptor: BrowserAccountLeaseDescriptor): string {
    return `${descriptor.serviceId}:${fingerprint(descriptor.accountIdentity)}`;
  }

  /** Live account leases, dropping settled entries a caller never handed back. */
  private liveAccountLeases(accountKey: string): Set<BrowserAccountLease> {
    const leases = this.accountLeases.get(accountKey);
    if (!leases) return new Set();
    for (const lease of leases) {
      if (!lease.isActive()) leases.delete(lease);
    }
    return leases;
  }

  acquire(descriptor: BrowserAccountLeaseDescriptor): BrowserAccountLease {
    const lease = new BrowserAccountLease(descriptor);
    const existing = this.leases.get(lease.leaseId);
    if (existing?.isActive()) {
      throw new Error(`Browser resource is already leased for turn ${descriptor.turnId}`);
    }
    const accountKey = this.accountKey(descriptor);
    const accountLeases = this.liveAccountLeases(accountKey);
    if (accountLeases.size >= MAX_CHATGPT_BROWSER_TABS) throw chatGptBrowserTurnLimitError();
    this.leases.set(lease.leaseId, lease);
    accountLeases.add(lease);
    this.accountLeases.set(accountKey, accountLeases);
    return lease;
  }

  bindPhysicalResource(
    lease: BrowserAccountLease,
    binding: ProviderTurnPhysicalResourceBinding,
  ): void {
    if (!lease.isActive() || this.leases.get(lease.leaseId) !== lease) {
      throw new Error("Cannot bind a physical resource for a lease not owned by the registry");
    }
    const existing = this.physicalResources.get(binding.resourceId);
    if (existing && existing !== lease && existing.isActive()) {
      throw new Error(
        `Physical browser resource is already leased by turn ${existing.descriptor.turnId}: ${binding.resourceId}`,
      );
    }
    lease.bindPhysicalResource(binding);
    this.physicalResources.set(binding.resourceId, lease);
  }

  release(lease: BrowserAccountLease): void {
    for (const [resourceId, owner] of this.physicalResources) {
      if (owner === lease) this.physicalResources.delete(resourceId);
    }
    lease.release();
    if (this.leases.get(lease.leaseId) === lease) this.leases.delete(lease.leaseId);
    const accountKey = this.accountKey(lease.descriptor);
    const accountLeases = this.accountLeases.get(accountKey);
    if (accountLeases) {
      accountLeases.delete(lease);
      if (accountLeases.size === 0) this.accountLeases.delete(accountKey);
    }
  }

  activeCount(): number {
    return [...this.leases.values()].filter(lease => lease.isActive()).length;
  }

  clear(): void {
    if (this.activeCount() > 0) {
      throw new Error("Cannot clear active browser leases before physical settlement");
    }
    this.leases.clear();
    this.physicalResources.clear();
    this.accountLeases.clear();
  }
}

export interface ProviderTurnProvenance {
  serviceId: string;
  traceId: string;
  executionKey: string;
  nativeTurnId?: string;
  nativeThreadId?: string;
}

export interface ProviderTurnSnapshot {
  readonly state: ProviderTurnState;
  readonly activity: ProviderTurnActivity;
  readonly recovery: ProviderRecovery;
  readonly submission: SubmissionPhase;
  readonly logicalSettled: boolean;
  readonly logicalOutcome: LogicalSettlementOutcome;
  readonly physicalSettled: boolean;
  readonly physicalSettlementAttached: boolean;
  readonly physicalSettlementOutcome: PhysicalSettlementOutcome;
  readonly physicalSettlementError?: string;
  readonly physicalResourceBound: boolean;
  readonly physicalResource?: ProviderTurnPhysicalResourceBinding;
  readonly retryPolicy: RetryPolicy;
  readonly lease: ReturnType<BrowserAccountLease["provenance"]>;
  readonly provenance: ProviderTurnProvenance;
  readonly capabilitySnapshot: CapabilitySnapshot;
}

export class ProviderTurnLifecycle {
  private state: ProviderTurnState = "PREPARING";
  private activity: ProviderTurnActivity = "idle";
  private recovery: ProviderRecovery = "NEW";
  private submission: SubmissionPhase = "prepared";
  private logicalSettled = false;
  private logicalOutcome: LogicalSettlementOutcome = "pending";
  private physicalSettled = false;
  private physicalSettlement: Promise<void> = Promise.resolve();
  private physicalSettlementAttached = false;
  private physicalSettlementOutcome: PhysicalSettlementOutcome = "not_started";
  private physicalSettlementError?: Error;
  private retirementScheduled = false;
  private shutdownRequested = false;
  private cancelExecution?: (reason: Error) => void;
  /**
   * The WebChat Core lifecycle this turn is a view of (issue #192).
   *
   * It owns the legality of every state, submission-phase, settlement and recovery change: the
   * provider keeps its own vocabulary and fields for its consumers, but it can no longer record a
   * change the core rejects, so there is one execution authority instead of two.
   */
  private readonly core: WebChatExchangeLifecycle;

  constructor(
    readonly lease: BrowserAccountLease,
    readonly provenance: ProviderTurnProvenance,
    readonly capabilitySnapshot: CapabilitySnapshot,
    private readonly retryPolicy: RetryPolicy = "strict",
    private readonly bindResource: (binding: ProviderTurnPhysicalResourceBinding) => void = binding => lease.bindPhysicalResource(binding),
    private readonly releaseLease: () => void = () => lease.release(),
    private readonly onRetired: () => void = () => {},
    /**
     * Conversation epoch this turn belongs to, and submission budget of the logical turn.
     *
     * Optional so existing callers and tests keep working; the core records them either way.
     */
    options: { readonly epoch?: number; readonly maxSubmits?: number } = {},
  ) {
    this.core = new WebChatExchangeLifecycle({
      exchangeId: provenance.executionKey ?? "chatgpt-web",
      conversationKey: lease.descriptor.serviceId,
      epoch: options.epoch ?? 1,
      ...(options.maxSubmits !== undefined ? { maxSubmits: options.maxSubmits } : {}),
    });
  }

  snapshot(): ProviderTurnSnapshot {
    return {
      state: this.state,
      activity: this.activity,
      recovery: this.recovery,
      submission: this.submission,
      logicalSettled: this.logicalSettled,
      logicalOutcome: this.logicalOutcome,
      physicalSettled: this.physicalSettled,
      physicalSettlementAttached: this.physicalSettlementAttached,
      physicalSettlementOutcome: this.physicalSettlementOutcome,
      ...(this.physicalSettlementError
        ? { physicalSettlementError: this.physicalSettlementError.message }
        : {}),
      physicalResourceBound: this.lease.physicalResourceBinding() !== undefined,
      ...(this.lease.physicalResourceBinding()
        ? { physicalResource: this.lease.physicalResourceBinding() }
        : {}),
      retryPolicy: this.retryPolicy,
      lease: this.lease.provenance(),
      capabilitySnapshot: this.capabilitySnapshot,
      provenance: this.provenance,
    };
  }

  transition(next: ProviderTurnState): void {
    if (next === this.state) return;
    if (!TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid provider turn transition: ${this.state} -> ${next}`);
    }
    // The core records the change first: if it is not a legal WebChat exchange transition, the
    // provider turn does not move either.
    this.recordInCore(next);
    this.state = next;
    if (next === "RETIRED") this.activity = "idle";
  }

  /**
   * Record one provider state change in the WebChat Core lifecycle.
   *
   * The provider vocabulary is a view: several of its states mean the same core state, and its
   * submission phase decides whether a `SUBMITTED` turn was confirmed or only activated.
   */
  private recordInCore(next: ProviderTurnState): void {
    switch (next) {
      case "PREPARING":
        this.core.markPreparing();
        return;
      case "LEASED":
        // The core has no lease-as-state: readiness and ownership are recorded by the transport lease.
        return;
      case "SURFACE_READY":
        if (this.core.snapshot().state === "CREATED") this.core.markPreparing();
        this.core.markTransportReady();
        return;
      case "SUBMITTED":
        // The phase was recorded by `markSendActivated`/`markSubmitted`; this only mirrors that the
        // provider considers the turn submitted.
        this.ensureCoreSubmitting();
        return;
      case "RUNNING":
        this.core.markStreaming();
        return;
      case "SETTLING":
        // The provider enters SETTLING while it waits for the client-visible logical outcome; the
        // core is not settled here. The physical settlement is recorded by the settlement methods
        // and the logical one by `markLogicalSettled`.
        return;
      case "RETIRED":
        this.core.markRetired("the provider turn was retired");
        return;
      default:
        return;
    }
  }

  /** The core's view of this turn, for the retry authority and for cross-checks. */
  coreSnapshot() {
    return this.core.snapshot();
  }

  /** Bring the core to the submission attempt that is about to be reported. */
  private ensureCoreSubmitting(): void {
    if (this.core.snapshot().state === "CREATED") this.core.markPreparing();
    if (this.core.snapshot().state === "PREPARING") this.core.markTransportReady();
    if (this.core.snapshot().state === "TRANSPORT_READY") this.core.markSubmitting();
  }

  private recordCoreActivation(): void {
    this.ensureCoreSubmitting();
    if (this.core.snapshot().phase === "prepared") this.core.markSendActivated();
  }

  private recordCoreSubmission(): void {
    this.ensureCoreSubmitting();
    this.core.markSubmitted();
  }

  private assertMutable(): void {
    if (this.state === "SETTLING" || this.state === "RETIRED") {
      throw new Error(`Provider turn is ${this.state.toLowerCase()} and cannot accept lifecycle mutations`);
    }
    if (!this.lease.isActive()) {
      throw new Error("Provider turn lease is no longer active");
    }
  }

  markLeased(): void {
    if (this.state !== "PREPARING") return;
    this.assertMutable();
    this.transition("LEASED");
  }

  bindPhysicalResource(binding: ProviderTurnPhysicalResourceBinding): void {
    this.assertMutable();
    this.bindResource(binding);
  }

  markSurfaceReady(): void {
    if (this.state !== "LEASED" && this.state !== "PREPARING") return;
    this.assertMutable();
    if (!this.lease.physicalResourceBinding()) {
      throw new Error("Provider turn surface cannot become ready before a physical browser resource is bound");
    }
    this.transition("SURFACE_READY");
  }

  markSendActivated(): void {
    if (this.submission !== "prepared") return;
    this.assertMutable();
    this.recordCoreActivation();
    this.submission = "send_activated";
    if (this.state === "SURFACE_READY") {
      this.transition("SUBMITTED");
    }
  }

  markSubmitted(): void {
    if (this.submission === "accepted") return;
    this.assertMutable();
    this.recordCoreSubmission();
    this.submission = "accepted";
    if (this.state === "SURFACE_READY") this.transition("SUBMITTED");
  }

  markRunning(): void {
    this.assertMutable();
    if (this.state !== "SUBMITTED") {
      if (this.state === "RUNNING" && this.submission === "accepted") {
        this.activity = "running";
        return;
      }
      throw new Error(`Provider turn cannot enter RUNNING from ${this.state}`);
    }
    if (this.submission !== "accepted") {
      throw new Error("Provider turn cannot enter RUNNING before submission is accepted");
    }
    this.transition("RUNNING");
    this.activity = "running";
  }

  markCapabilityWait(): void {
    this.assertMutable();
    if (this.state !== "RUNNING") {
      throw new Error(`Capability wait requires a running provider turn, got ${this.state}`);
    }
    this.activity = "capability_wait";
  }

  markRecovery(value: Exclude<ProviderRecovery, "NEW">): void {
    this.assertMutable();
    const currentOrder = RECOVERY_ORDER[this.recovery];
    const nextOrder = RECOVERY_ORDER[value];
    if (nextOrder < currentOrder) {
      throw new Error(`Provider recovery cannot downgrade: ${this.recovery} -> ${value}`);
    }
    if (this.recovery === "EXACT_RESUME" && value === "REPLAY") {
      throw new Error("Provider recovery cannot downgrade exact resume to replay");
    }
    if (this.recovery === "REPLAY" && value === "EXACT_RESUME") {
      throw new Error("Provider recovery cannot reclassify a replay as exact resume");
    }
    this.recovery = value;
    // The recovery decision is shared state: the core records it with its own vocabulary and its own
    // monotonicity guards.
    if (value !== "FAILED" && this.core.snapshot().recovery === undefined) {
      this.core.markRecovery(value === "EXACT_RESUME" ? "exact_resume" : "replay");
    }
  }

  markLogicalSettled(outcome: Exclude<LogicalSettlementOutcome, "pending"> = "completed"): void {
    // Physical browser cleanup can settle just before the client-visible browser outcome is
    // consumed. Logical settlement is the one lifecycle mutation that remains legal in that
    // short SETTLING window; every other lifecycle mutation remains fail-closed.
    if (this.state === "RETIRED") {
      throw new Error("Provider turn is retired and cannot accept lifecycle mutations");
    }
    if (this.state === "SETTLING" && !this.physicalSettled) {
      throw new Error("Provider turn is settling and cannot accept lifecycle mutations");
    }
    if (!this.lease.isActive()) {
      throw new Error("Provider turn lease is no longer active");
    }
    if (this.logicalSettled) {
      if (this.logicalOutcome !== outcome) {
        throw new Error(`Provider turn logical outcome cannot change: ${this.logicalOutcome} -> ${outcome}`);
      }
      return;
    }
    this.logicalSettled = true;
    this.logicalOutcome = outcome;
    if (this.core.snapshot().logical === "pending") this.core.markLogicallySettled(outcome);
    if (outcome === "failed") {
      this.recovery = "FAILED";
      // A logical failure is a shared outcome too, and it escalates a recovery the turn started with
      // (exact resume or replay): the core's rule is that recovery can never downgrade, and failed is
      // the highest rank, so recording it is always legal here.
      this.core.markRecovery("failed");
    }
    this.retireIfSettled();
  }

  attachCancellation(cancel: (reason: Error) => void): void {
    // A second attachment is a second turn that reused this lifecycle — another turn is already
    // running for this conversation. Reported as that local refusal, never as a bare `Error` the API
    // normalizes into `502 upstream_server_error` and blames the provider for (issue #305).
    if (this.cancelExecution) throw chatGptRetainedSurfaceBusyError();
    this.cancelExecution = cancel;
    if (this.shutdownRequested) {
      cancel(new Error("ChatGPT Web ProviderCore is shutting down"));
    }
  }

  requestShutdown(reason: Error = new Error("ChatGPT Web ProviderCore is shutting down")): void {
    if (this.state === "RETIRED") return;
    this.shutdownRequested = true;
    if (!this.logicalSettled && this.state !== "SETTLING") {
      this.markLogicalSettled("cancelled");
    }
    this.cancelExecution?.(reason);
  }

  canAutomaticallyRetry(): boolean {
    if (this.submission !== "prepared") return false;
    if (this.state === "SETTLING" || this.state === "RETIRED") return false;
    return this.retryPolicy === "strict" || this.retryPolicy === "side_effect_free";
  }

  authorizeSurfaceReplay(): void {
    this.assertMutable();
    if (!this.canAutomaticallyRetry()) {
      throw new Error(
        `Automatic browser surface replay is forbidden (submission=${this.submission}, state=${this.state})`,
      );
    }
    if (!this.lease.physicalResourceBinding()) {
      throw new Error("Automatic browser surface replay requires a bound physical resource");
    }
  }

  assertCapabilityExecution(): void {
    this.assertCanAct();
  }

  attachPhysicalSettlement(settlement: Promise<void>): void {
    if (this.physicalSettlementAttached) {
      throw new Error("Provider turn physical settlement can only be attached once");
    }
    this.physicalSettlementAttached = true;
    this.physicalSettlementOutcome = "pending";
    this.physicalSettlement = settlement;
    void settlement.then(
      () => this.finishPhysicalSettlement("fulfilled"),
      error => this.finishPhysicalSettlement("rejected", error),
    );
  }

  async waitForPhysicalSettlement(): Promise<void> {
    await this.physicalSettlement;
  }

  failBeforePhysicalSettlement(): void {
    if (this.physicalSettlementAttached) {
      throw new Error("Cannot force provider turn retirement after physical execution has started");
    }
    if (this.state === "RETIRED") return;
    if (!this.logicalSettled) {
      this.markLogicalSettled("failed");
    }
    if (this.state !== "SETTLING") this.transition("SETTLING");
    this.physicalSettled = true;
    this.physicalSettlementOutcome = "not_started";
    this.core.markPhysicallySettled("not_started");
    this.recovery = "FAILED";
    // The failure before any physical execution escalates the core's recovery the same way.
    this.core.markRecovery("failed");
    this.activity = "idle";
    this.releaseLease();
    this.transition("RETIRED");
    this.onRetired();
  }

  /**
   * Write off a turn whose attached physical settlement never resolved before shutdown's bound.
   *
   * Unlike {@link failBeforePhysicalSettlement} this is the case where physical execution *did*
   * start, so the outcome cannot be `not_started`. It is still never a success claim: the physical
   * settlement could not be established, so the turn records the failure category (`rejected`) and
   * the timeout is the recorded reason in `physicalSettlementError`. The turn retires and its lease
   * is released through the normal failure-settlement path, so a settlement that never resolved can
   * never be presented as a resource that is safe to reuse.
   */
  failPhysicalSettlementTimeout(detail: string): void {
    if (this.state === "RETIRED") return;
    this.finishPhysicalSettlement("rejected", new Error(`Physical settlement timed out: ${detail}`));
  }

  private recordCoreSettlement(outcome: PhysicalSettlementOutcome): void {
    this.core.markPhysicallySettled(outcome);
  }

  private finishPhysicalSettlement(
    outcome: Extract<PhysicalSettlementOutcome, "fulfilled" | "rejected">,
    error?: unknown,
  ): void {
    if (this.physicalSettled) return;
    // The core records what the provider established, in the same step as the local fields, so the
    // two can never describe different outcomes.
    this.recordCoreSettlement(outcome);
    this.physicalSettled = true;
    this.physicalSettlementOutcome = outcome;
    if (outcome === "rejected") {
      this.physicalSettlementError = normalizeError(error);
      this.recovery = "FAILED";
      if (!this.logicalSettled) {
        this.logicalSettled = true;
        this.logicalOutcome = "failed";
        // The logical outcome is the core's too: a physical failure that ends the turn as failed is
        // recorded in the same step, so the provider view and the core cannot describe different
        // outcomes.
        if (this.core.snapshot().logical === "pending") this.core.markLogicallySettled("failed");
      }
      this.core.markRecovery("failed");
    }
    this.activity = "idle";
    if (this.state !== "RETIRED" && this.state !== "SETTLING") {
      this.transition("SETTLING");
    }
    this.retireIfSettled();
  }

  private retireIfSettled(): void {
    if (!this.physicalSettled || !this.logicalSettled || this.state === "RETIRED") return;
    if (this.state !== "SETTLING") this.transition("SETTLING");
    this.activity = "idle";
    this.releaseLease();
    this.transition("RETIRED");
    this.onRetired();
  }

  scheduleRetirementAfterPhysicalSettlement(): void {
    if (this.retirementScheduled) return;
    this.retirementScheduled = true;
    // The settlement handler attached above owns the retirement transition. This method only records
    // that retirement is intentionally bound to physical settlement and therefore must not be forced
    // synchronously by a logical response observer.
  }

  assertCanAct(): void {
    if (this.state === "SETTLING" || this.state === "RETIRED") {
      throw new Error("Provider turn is retired and cannot accept capability work");
    }
    if (!this.lease.isActive()) {
      throw new Error("Provider turn lease is no longer active");
    }
  }

}

export interface ChatGptWebProviderCoreTurnInput {
  executionKey: string;
  traceId: string;
  nativeTurnId?: string;
  nativeThreadId?: string;
  accountIdentity: string;
  /** Provenance of `accountIdentity`; absent means recorded (see `BrowserAccountLeaseDescriptor`). */
  accountIdentityRecorded?: boolean;
  browserProfile: string;
  browserContext: string;
  pageIdentity: string;
  capabilitySnapshot: CapabilitySnapshot;
  retryPolicy?: RetryPolicy;
  recovery?: ProviderRecovery;
}

export class ChatGptWebProviderCore {
  private readonly turns = new Map<string, ProviderTurnLifecycle>();
  /**
   * Retry budgets belong to the logical execution key, not one ProviderTurnLifecycle instance.
   * A failed physical turn is retired before a reconnect can create its replacement lifecycle;
   * keeping the budget here prevents that replacement from resetting the retry limit.
   */
  private readonly retryBudgets = new Map<string, ProviderRetryBudget>();
  // Active snapshots are owned by active logical provider executions. Retired snapshot tombstones
  // are retained only with the bounded retired-execution history so an old snapshot cannot be
  // attached to an unrelated new execution forever growing ProviderCore state.
  private readonly capabilitySnapshotOwners = new Map<string, string>();
  private readonly retiredExecutions = new Map<string, number>();
  private readonly retiredCapabilitySnapshots = new Map<string, CapabilitySnapshot>();
  /**
   * The one admission slot per native DSH thread (issue #305 follow-up).
   *
   * `turns` alone cannot admit a turn *before* it begins, and a turn whose continuity decision runs
   * before admission leaves that decision's side effects behind when admission then refuses it — a
   * replay advances the generation and a first turn records an unconfirmed conversation, so the next
   * attempt fails with "the last attempt on this conversation was never confirmed" even though the
   * refused turn never ran. The reservation is therefore taken *before* the continuity decision and
   * held until the turn retires: it is the conversation's admission authority, `begin` refuses a
   * second execution while another one holds it, and the bounded wait itself is the shared
   * conversation-admission owner (`src/web-chat/transport/conversation-admission.ts`) that the text
   * providers' transport lease composes too — one mechanism, one measured bound.
   */
  private readonly conversationAdmission: ConversationAdmissionGate;
  private closed = false;

  private rememberRetired(executionKey: string): void {
    this.retiredExecutions.set(executionKey, Date.now());
    while (this.retiredExecutions.size > 1024) {
      const oldest = this.retiredExecutions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retiredExecutions.delete(oldest);
    }
  }

  wasRetired(executionKey: string): boolean {
    return this.retiredExecutions.has(executionKey);
  }

  getRetiredCapabilitySnapshot(executionKey: string): CapabilitySnapshot | undefined {
    return this.retiredCapabilitySnapshots.get(executionKey);
  }

  private pruneRetryBudgets(now: number): void {
    for (const [executionKey, budget] of this.retryBudgets) {
      if (budget.lastRetryAt > 0 && now - budget.lastRetryAt >= RETRY_BUDGET_TTL_MS) {
        this.retryBudgets.delete(executionKey);
      }
    }
  }

  private retryBudgetIfPresent(executionKey: string): ProviderRetryBudget | undefined {
    return this.retryBudgets.get(executionKey);
  }

  private ensureRetryBudget(executionKey: string): ProviderRetryBudget {
    const existing = this.retryBudgets.get(executionKey);
    if (existing) return existing;
    const budget: ProviderRetryBudget = { attempts: 0, lastRetryAt: 0 };
    this.retryBudgets.set(executionKey, budget);
    return budget;
  }

  retryDecision(
    executionKey: string,
    turn: ProviderTurnLifecycle,
    now = Date.now(),
    maxAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
  ): ProviderRetryDecision {
    this.pruneRetryBudgets(now);
    const snapshot = turn.snapshot();
    const budget = this.retryBudgetIfPresent(executionKey);
    const attempts = budget?.attempts ?? 0;
    // Provider policy that is not the core's: a budget older than its TTL is forgotten, so a much
    // later reconnect starts from a fresh allowance.
    // An expired budget starts a fresh allowance (provider policy), but the decision itself still
    // goes through the core below: an expired counter is not evidence that nothing was submitted.
    if (budget && budget.lastRetryAt > 0 && now - budget.lastRetryAt >= RETRY_BUDGET_TTL_MS) {
      this.retryBudgets.delete(executionKey);
    }
    const attemptsAfterTtl = this.retryBudgetIfPresent(executionKey)?.attempts ?? 0;
    // The decision itself is the core's (issue #192): one retry authority, not two.
    const decision = decideWebChatRetry({
      snapshot: {
        ...turn.coreSnapshot(),
        submits: attemptsAfterTtl,
        maxSubmits: maxAttempts,
      },
    });
    if (!decision.allowed) {
      return {
        allowed: false,
        attempt: attemptsAfterTtl,
        maxAttempts,
        reason: CORE_RETRY_REASONS[decision.reason ?? "policy"],
      };
    }
    return { allowed: true, attempt: attemptsAfterTtl + 1, maxAttempts };
  }

  recordRetryAttempt(
    executionKey: string,
    turn: ProviderTurnLifecycle,
    now = Date.now(),
    maxAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
  ): ProviderRetryDecision {
    if (turn.snapshot().state === "SETTLING" || turn.snapshot().state === "RETIRED") {
      return this.retryDecision(executionKey, turn, now, maxAttempts);
    }
    const decision = this.retryDecision(executionKey, turn, now, maxAttempts);
    if (!decision.allowed) return decision;
    const budget = this.ensureRetryBudget(executionKey);
    budget.attempts += 1;
    budget.lastRetryAt = now;
    return { allowed: true, attempt: budget.attempts, maxAttempts };
  }

  constructor(
    readonly serviceId = CHATGPT_WEB_PROVIDER_CORE_SERVICE,
    private readonly leases = new BrowserAccountLeaseRegistry(),
    private readonly shutdownSettlementGraceMs = DEFAULT_SHUTDOWN_SETTLEMENT_GRACE_MS,
    /**
     * Bound of one conversation admission wait (see `DEFAULT_TRANSPORT_ADMISSION_WAIT_MS`).
     *
     * The default is the **shared** transport's measured bound — the harness's own session-title
     * deadline — never a second provider-local number. Injectable so a deterministic test can shrink
     * the bound instead of waiting for the production one; the value is validated like every other
     * bound in this provider.
     */
    conversationAdmissionWaitMs = DEFAULT_TRANSPORT_ADMISSION_WAIT_MS,
  ) {
    if (!Number.isFinite(shutdownSettlementGraceMs) || shutdownSettlementGraceMs < 0) {
      throw new Error("ProviderCore shutdown settlement grace must be a non-negative finite number");
    }
    if (!Number.isFinite(conversationAdmissionWaitMs) || conversationAdmissionWaitMs <= 0) {
      throw new Error("ProviderCore conversation admission wait must be a positive finite number of milliseconds");
    }
    this.conversationAdmission = createConversationAdmissionGate({
      admissionWaitMs: conversationAdmissionWaitMs,
      busyError: chatGptRetainedSurfaceBusyError,
      abortError: conversationWaitAbortError,
      closedError: () => new Error("ChatGPT Web ProviderCore is shut down"),
    });
  }

  get(executionKey: string): ProviderTurnLifecycle | undefined {
    return this.turns.get(executionKey);
  }

  async waitForRetirement(executionKey: string): Promise<void> {
    const turn = this.turns.get(executionKey);
    if (!turn) return;
    await turn.waitForPhysicalSettlement();
  }

  /**
   * Take the one admission slot for a native DSH thread, waiting for its holder to be released.
   *
   * The wait is *bounded* by the shared admission wait, *cancellable* through the caller's own abort
   * signal, and event-driven: a waiter holds nothing while it waits and is woken when the holder
   * retires, never by polling. When the bound expires the refusal is exactly the one this provider
   * already publishes for a concurrent turn (issue #305), so a genuine contention is still refused
   * instead of queueing forever. A thread this execution already holds is re-entrant (a reconnect
   * re-admits its own execution), and a turn with no native DSH thread has no conversation-scoped
   * admission to take.
   *
   * The slot must be released by the caller when it does not become a provider turn
   * ({@link releaseConversationAdmission}); a turn that is begun transfers the release to its own
   * retirement.
   */
  async acquireConversationAdmission(
    executionKey: string,
    nativeThreadId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!nativeThreadId) return;
    if (this.closed) throw new Error("ChatGPT Web ProviderCore is shut down");
    await this.conversationAdmission.admit({
      holder: executionKey,
      conversationKey: nativeThreadId,
      ...(signal ? { signal } : {}),
      // The begun-turn guard is a caller-owned blocking condition on top of the slot map: a turn
      // that is still physically unsettled must keep the conversation closed even if a caller ever
      // skipped admission. Retirement wakes the waiters through `notifyReleased`.
      blocked: () => this.activeTurnForThread(nativeThreadId, executionKey) !== undefined,
    });
  }

  /**
   * Give back an admission slot this execution holds but never turned into a provider turn.
   *
   * Idempotent, and deliberately silent when the slot belongs to another execution: only its owner
   * may release it. The wake is sent even when this execution did not own the slot, so a waiter
   * blocked by the begun-turn condition also re-checks after a retirement.
   */
  releaseConversationAdmission(executionKey: string, nativeThreadId?: string): void {
    if (!nativeThreadId) return;
    this.conversationAdmission.release(executionKey, nativeThreadId);
    this.conversationAdmission.notifyReleased(nativeThreadId);
  }

  /** Diagnostic: how many admissions are currently waiting for a conversation to become free. */
  conversationWaiterCount(): number {
    return this.conversationAdmission.waiterCount();
  }

  /** The active turn holding a thread, excluding this execution's own. */
  private activeTurnForThread(
    nativeThreadId: string,
    executionKey: string,
  ): ProviderTurnLifecycle | undefined {
    for (const [key, turn] of this.turns) {
      if (key === executionKey) continue;
      const snapshot = turn.snapshot();
      if (!snapshot.physicalSettled && snapshot.provenance.nativeThreadId === nativeThreadId) return turn;
    }
    return undefined;
  }

  begin(input: ChatGptWebProviderCoreTurnInput): ProviderTurnLifecycle {
    if (this.closed) throw new Error("ChatGPT Web ProviderCore is shut down");
    const existing = this.turns.get(input.executionKey);
    if (existing) {
      const existingSnapshot = existing.snapshot();
      const provenance = existingSnapshot.provenance;
      if (
        existingSnapshot.capabilitySnapshot.snapshotId !== input.capabilitySnapshot.snapshotId
        || existingSnapshot.capabilitySnapshot.sessionId !== input.capabilitySnapshot.sessionId
        || existingSnapshot.capabilitySnapshot.agentId !== input.capabilitySnapshot.agentId
        || existingSnapshot.capabilitySnapshot.turnId !== input.capabilitySnapshot.turnId
      ) {
        throw new Error("Provider execution key is already bound to a different capability snapshot");
      }
      if (input.nativeTurnId && provenance.nativeTurnId !== input.nativeTurnId) {
        throw new Error("Provider execution key is already bound to a different native DSH turn");
      }
      if (input.nativeThreadId && provenance.nativeThreadId !== input.nativeThreadId) {
        throw new Error("Provider execution key is already bound to a different native DSH thread");
      }
      const existingLease = existing.lease.descriptor;
      if (
        existingLease.accountIdentity !== input.accountIdentity
        || existingLease.browserProfile !== input.browserProfile
        || existingLease.browserContext !== input.browserContext
      ) {
        throw new Error("Provider execution key is already bound to a different browser/account identity");
      }
      const existingRetryPolicy = existingSnapshot.retryPolicy;
      const requestedRetryPolicy = input.retryPolicy ?? "strict";
      if (existingRetryPolicy !== requestedRetryPolicy) {
        throw new Error("Provider execution key is already bound to a different retry policy");
      }
      return existing;
    }

    const capabilityOwner = this.capabilitySnapshotOwners.get(input.capabilitySnapshot.snapshotId);
    if (capabilityOwner !== undefined && capabilityOwner !== input.executionKey) {
      throw new Error("Capability snapshot is already bound to a different provider execution");
    }
    for (const [retiredExecutionKey, retiredSnapshot] of this.retiredCapabilitySnapshots) {
      if (
        retiredExecutionKey !== input.executionKey
        && retiredSnapshot.snapshotId === input.capabilitySnapshot.snapshotId
      ) {
        throw new Error("Capability snapshot is already retired under a different provider execution");
      }
    }

    if (input.nativeThreadId) {
      // The admission slot is the conversation's authority (issue #305 follow-up). A turn takes it
      // before its continuity decision; `begin` still refuses fail-closed when another execution
      // holds it, so a caller that skipped admission can never steal a conversation in use.
      const admittedTo = this.conversationAdmission.admissionHolder(input.nativeThreadId);
      if (admittedTo !== undefined && admittedTo !== input.executionKey) {
        throw chatGptRetainedSurfaceBusyError();
      }
      for (const [executionKey, activeTurn] of this.turns) {
        if (executionKey === input.executionKey) continue;
        const snapshot = activeTurn.snapshot();
        if (!snapshot.physicalSettled && snapshot.provenance.nativeThreadId === input.nativeThreadId) {
          // The refusal itself is correct (one active turn per logical conversation), but it is a
          // **local admission decision**: the caller is told a turn is already in flight and to wait,
          // never that the provider failed (issue #305). It is the same conversation-busy refusal the
          // busy retained surface publishes, so the caller reads one category whichever layer refuses.
          throw chatGptRetainedSurfaceBusyError();
        }
      }
    }

    const lease = this.leases.acquire({
      serviceId: this.serviceId,
      accountIdentity: input.accountIdentity,
      ...(input.accountIdentityRecorded !== undefined
        ? { accountIdentityRecorded: input.accountIdentityRecorded }
        : {}),
      browserProfile: input.browserProfile,
      browserContext: input.browserContext,
      pageIdentity: input.pageIdentity,
      // Native DSH turn identity is the authoritative lease owner; traceId remains diagnostic only.
      turnId: input.nativeTurnId ?? input.traceId,
    });
    const turn = new ProviderTurnLifecycle(
      lease,
      {
        serviceId: this.serviceId,
        traceId: input.traceId,
        executionKey: input.executionKey,
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
        ...(input.nativeThreadId ? { nativeThreadId: input.nativeThreadId } : {}),
      },
      input.capabilitySnapshot,
      input.retryPolicy,
      binding => this.leases.bindPhysicalResource(lease, binding),
      () => this.leases.release(lease),
      () => {
        const finalSnapshot = turn.snapshot();
        this.turns.delete(input.executionKey);
        this.rememberRetired(input.executionKey);
        if (this.capabilitySnapshotOwners.get(input.capabilitySnapshot.snapshotId) === input.executionKey) {
          this.capabilitySnapshotOwners.delete(input.capabilitySnapshot.snapshotId);
        }
        this.retiredCapabilitySnapshots.set(input.executionKey, input.capabilitySnapshot);
        if (finalSnapshot.logicalOutcome === "completed") {
          this.retryBudgets.delete(input.executionKey);
        }
        while (this.retiredCapabilitySnapshots.size > 1024) {
          const oldest = this.retiredCapabilitySnapshots.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.retiredCapabilitySnapshots.delete(oldest);
        }
        // Retirement is the conversation's release point: a turn that held its admission slot has
        // stopped using it, and every waiter wakes to re-check instead of polling.
        this.releaseConversationAdmission(input.executionKey, input.nativeThreadId);
      },
    );
    const recovery = input.recovery ?? (this.wasRetired(input.executionKey) ? "REPLAY" : "NEW");
    if (recovery !== "NEW") turn.markRecovery(recovery);
    turn.markLeased();
    this.capabilitySnapshotOwners.set(input.capabilitySnapshot.snapshotId, input.executionKey);
    this.turns.set(input.executionKey, turn);
    // The slot is recorded only once the turn really exists: everything above can throw (a lease
    // conflict, a capability conflict) and a failed `begin` must not leave a conversation reserved.
    if (input.nativeThreadId) {
      this.conversationAdmission.claim(input.executionKey, input.nativeThreadId);
    }
    return turn;
  }

  bindPhysicalSettlement(executionKey: string, settlement: Promise<void>): ProviderTurnLifecycle {
    const turn = this.turns.get(executionKey);
    if (!turn) throw new Error(`Provider turn does not exist: ${executionKey}`);
    turn.attachPhysicalSettlement(settlement);
    turn.scheduleRetirementAfterPhysicalSettlement();
    return turn;
  }

  forget(executionKey: string): void {
    const turn = this.turns.get(executionKey);
    if (!turn) return;
    if (!turn.snapshot().physicalSettled) {
      throw new Error(`Cannot forget provider turn before physical settlement: ${executionKey}`);
    }
    this.turns.delete(executionKey);
    // A turn removed outside retirement still owns its conversation's admission slot; release it here
    // too, so the slot can never outlive the turn it belongs to.
    this.releaseConversationAdmission(executionKey, turn.snapshot().provenance.nativeThreadId);
  }

  /**
   * Drain every turn this core owns, bounded by the shutdown settlement grace.
   *
   * A physical settlement that is attached is awaited, but not forever: a promise that never resolves
   * would keep the process alive past `docker stop`'s grace and into SIGKILL. Both cases are bounded
   * by the same grace — a turn that never attached a settlement is written off as `not_started`, and
   * one whose settlement never resolved is written off as `rejected` with the timeout as its recorded
   * reason. Neither is reported as `fulfilled`, so a resource whose physical state could not be
   * established is retired instead of becoming reusable.
   */
  async shutdown(reason = new Error("ChatGPT Web ProviderCore is shutting down")): Promise<void> {
    if (this.closed && this.turns.size === 0) return;
    this.closed = true;
    const activeTurns = [...this.turns.values()];
    for (const turn of activeTurns) turn.requestShutdown(reason);
    await Promise.allSettled(activeTurns.map(async turn => {
      const deadline = Date.now() + this.shutdownSettlementGraceMs;
      while (!turn.snapshot().physicalSettlementAttached && !turn.snapshot().physicalSettled) {
        if (Date.now() >= deadline) {
          turn.failBeforePhysicalSettlement();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      }
      if (turn.snapshot().physicalSettled) return;
      // The settlement is attached: wait for it, still bounded by the same grace. The bound timer is
      // cleared as soon as the settlement lands, so a drained core leaves no handle on the event loop
      // behind — a stray timer would itself delay the process exit this bound exists to allow. The
      // rejection needs no separate handling: the attached settlement handler has already recorded the
      // outcome, and all this wait decides is whether the settlement or the bound arrived first.
      const settled = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        const finish = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        void turn.waitForPhysicalSettlement().then(finish, finish);
      });
      if (!settled) {
        turn.failPhysicalSettlementTimeout(
          `the attached physical settlement did not resolve within the `
          + `${this.shutdownSettlementGraceMs}ms shutdown settlement grace`,
        );
      }
    }));
    this.leases.clear();
    this.turns.clear();
    // Closing the admission owner clears every slot and wakes every waiter, so a waiter re-checks the
    // closed core and fails instead of holding a timer for the rest of its bound.
    this.conversationAdmission.close();
    this.capabilitySnapshotOwners.clear();
    this.retiredExecutions.clear();
    this.retiredCapabilitySnapshots.clear();
    this.retryBudgets.clear();
  }
}
