import { createHash } from "node:crypto";
import type { CapabilitySnapshot } from "./capability-projector";

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
  browserProfile: string;
  browserContext: string;
  pageIdentity: string;
  turnId: string;
}

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
      throw new Error(
        `Browser lease physical account does not match its logical account identity: expected ${expectedAccountId}`,
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
  private readonly accountLeases = new Map<string, BrowserAccountLease>();

  private accountKey(descriptor: BrowserAccountLeaseDescriptor): string {
    return `${descriptor.serviceId}:${fingerprint(descriptor.accountIdentity)}`;
  }

  acquire(descriptor: BrowserAccountLeaseDescriptor): BrowserAccountLease {
    const lease = new BrowserAccountLease(descriptor);
    const existing = this.leases.get(lease.leaseId);
    if (existing?.isActive()) {
      throw new Error(`Browser resource is already leased for turn ${descriptor.turnId}`);
    }
    const accountKey = this.accountKey(descriptor);
    const accountOwner = this.accountLeases.get(accountKey);
    if (accountOwner?.isActive() && accountOwner !== existing) {
      throw new Error(`Authenticated ChatGPT account is already leased by turn ${accountOwner.descriptor.turnId}`);
    }
    this.leases.set(lease.leaseId, lease);
    this.accountLeases.set(accountKey, lease);
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
    if (this.accountLeases.get(accountKey) === lease) this.accountLeases.delete(accountKey);
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

  constructor(
    readonly lease: BrowserAccountLease,
    readonly provenance: ProviderTurnProvenance,
    readonly capabilitySnapshot: CapabilitySnapshot,
    private readonly retryPolicy: RetryPolicy = "strict",
    private readonly bindResource: (binding: ProviderTurnPhysicalResourceBinding) => void = binding => lease.bindPhysicalResource(binding),
    private readonly releaseLease: () => void = () => lease.release(),
    private readonly onRetired: () => void = () => {},
  ) {}

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
    this.state = next;
    if (next === "RETIRED") this.activity = "idle";
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
    this.submission = "send_activated";
    if (this.state === "SURFACE_READY") {
      this.transition("SUBMITTED");
    }
  }

  markSubmitted(): void {
    if (this.submission === "accepted") return;
    this.assertMutable();
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
  }

  markLogicalSettled(outcome: Exclude<LogicalSettlementOutcome, "pending"> = "completed"): void {
    this.assertMutable();
    if (this.logicalSettled) {
      if (this.logicalOutcome !== outcome) {
        throw new Error(`Provider turn logical outcome cannot change: ${this.logicalOutcome} -> ${outcome}`);
      }
      return;
    }
    this.logicalSettled = true;
    this.logicalOutcome = outcome;
  }

  attachCancellation(cancel: (reason: Error) => void): void {
    if (this.cancelExecution) throw new Error("Provider turn cancellation callback can only be attached once");
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
    this.recovery = "FAILED";
    this.activity = "idle";
    this.releaseLease();
    this.transition("RETIRED");
    this.onRetired();
  }

  private finishPhysicalSettlement(
    outcome: Extract<PhysicalSettlementOutcome, "fulfilled" | "rejected">,
    error?: unknown,
  ): void {
    if (this.physicalSettled) return;
    this.physicalSettled = true;
    this.physicalSettlementOutcome = outcome;
    if (outcome === "rejected") {
      this.physicalSettlementError = normalizeError(error);
      this.recovery = "FAILED";
      if (!this.logicalSettled) {
        this.logicalSettled = true;
        this.logicalOutcome = "failed";
      }
    } else if (!this.logicalSettled) {
      this.logicalSettled = true;
      this.logicalOutcome = "failed";
    }
    this.activity = "idle";
    if (this.state !== "RETIRED") {
      if (this.state !== "SETTLING") this.transition("SETTLING");
      this.transition("RETIRED");
    }
    this.releaseLease();
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
    if (snapshot.submission !== "prepared") {
      return { allowed: false, attempt: attempts, maxAttempts, reason: "submitted" };
    }
    if (snapshot.state === "SETTLING" || snapshot.state === "RETIRED") {
      return { allowed: false, attempt: attempts, maxAttempts, reason: "retired" };
    }
    if (budget && budget.lastRetryAt > 0 && now - budget.lastRetryAt >= RETRY_BUDGET_TTL_MS) {
      this.retryBudgets.delete(executionKey);
      return { allowed: true, attempt: 1, maxAttempts };
    }
    if (attempts >= maxAttempts) {
      return { allowed: false, attempt: attempts, maxAttempts, reason: "budget_exhausted" };
    }
    return { allowed: true, attempt: attempts + 1, maxAttempts };
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
  ) {
    if (!Number.isFinite(shutdownSettlementGraceMs) || shutdownSettlementGraceMs < 0) {
      throw new Error("ProviderCore shutdown settlement grace must be a non-negative finite number");
    }
  }

  get(executionKey: string): ProviderTurnLifecycle | undefined {
    return this.turns.get(executionKey);
  }

  async waitForRetirement(executionKey: string): Promise<void> {
    const turn = this.turns.get(executionKey);
    if (!turn) return;
    await turn.waitForPhysicalSettlement();
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
      for (const [executionKey, activeTurn] of this.turns) {
        if (executionKey === input.executionKey) continue;
        const snapshot = activeTurn.snapshot();
        if (!snapshot.physicalSettled && snapshot.provenance.nativeThreadId === input.nativeThreadId) {
          throw new Error(
            "ChatGPT Web cannot synchronously start a second provider turn for an active native DSH thread",
          );
        }
      }
    }

    const lease = this.leases.acquire({
      serviceId: this.serviceId,
      accountIdentity: input.accountIdentity,
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
      },
    );
    const recovery = input.recovery ?? (this.wasRetired(input.executionKey) ? "REPLAY" : "NEW");
    if (recovery !== "NEW") turn.markRecovery(recovery);
    turn.markLeased();
    this.capabilitySnapshotOwners.set(input.capabilitySnapshot.snapshotId, input.executionKey);
    this.turns.set(input.executionKey, turn);
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
  }

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
      await turn.waitForPhysicalSettlement();
    }));
    this.leases.clear();
    this.turns.clear();
    this.capabilitySnapshotOwners.clear();
    this.retiredExecutions.clear();
    this.retiredCapabilitySnapshots.clear();
    this.retryBudgets.clear();
  }
}
