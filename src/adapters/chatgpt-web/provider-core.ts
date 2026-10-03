import { createHash } from "node:crypto";

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

export interface ProviderTurnPhysicalResourceBinding {
  resourceId: string;
  browserContextId: string;
  pageId: string;
  profileId: string;
  accountId: string;
}

type RetryPolicy = "strict" | "side_effect_free";

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

  acquire(descriptor: BrowserAccountLeaseDescriptor): BrowserAccountLease {
    const lease = new BrowserAccountLease(descriptor);
    const existing = this.leases.get(lease.leaseId);
    if (existing?.isActive()) {
      throw new Error(`Browser resource is already leased for turn ${descriptor.turnId}`);
    }
    this.leases.set(lease.leaseId, lease);
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
  }

  activeCount(): number {
    return [...this.leases.values()].filter(lease => lease.isActive()).length;
  }

  clear(): void {
    for (const lease of this.leases.values()) lease.release();
    this.leases.clear();
    this.physicalResources.clear();
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
  readonly physicalSettled: boolean;
  readonly physicalSettlementAttached: boolean;
  readonly physicalSettlementOutcome: PhysicalSettlementOutcome;
  readonly physicalSettlementError?: string;
  readonly physicalResourceBound: boolean;
  readonly physicalResource?: ProviderTurnPhysicalResourceBinding;
  readonly retryPolicy: RetryPolicy;
  readonly lease: ReturnType<BrowserAccountLease["provenance"]>;
  readonly provenance: ProviderTurnProvenance;
}

export class ProviderTurnLifecycle {
  private state: ProviderTurnState = "PREPARING";
  private activity: ProviderTurnActivity = "idle";
  private recovery: ProviderRecovery = "NEW";
  private submission: SubmissionPhase = "prepared";
  private logicalSettled = false;
  private physicalSettled = false;
  private physicalSettlement: Promise<void> = Promise.resolve();
  private physicalSettlementAttached = false;
  private physicalSettlementOutcome: PhysicalSettlementOutcome = "not_started";
  private physicalSettlementError?: Error;
  private retirementScheduled = false;

  constructor(
    readonly lease: BrowserAccountLease,
    readonly provenance: ProviderTurnProvenance,
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
    if (this.state === "SUBMITTED") this.transition("RUNNING");
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
    this.recovery = value;
  }

  markLogicalSettled(): void {
    this.assertMutable();
    this.logicalSettled = true;
  }

  canAutomaticallyRetry(): boolean {
    if (this.submission !== "prepared") return false;
    return this.state !== "SUBMITTED"
      && this.state !== "RUNNING"
      && this.state !== "SETTLING"
      && this.state !== "RETIRED"
      && (this.retryPolicy === "strict" || this.retryPolicy === "side_effect_free");
  }

  authorizeSurfaceReplay(): void {
    this.assertMutable();
    if (!this.canAutomaticallyRetry()) {
      throw new Error(
        `Automatic browser surface replay is forbidden after physical submission has started (submission=${this.submission}, state=${this.state})`,
      );
    }
    if (!this.lease.physicalResourceBinding()) {
      throw new Error("Automatic browser surface replay requires a bound physical resource");
    }
  }

  assertCapabilityExecution(requestTurnId?: string): void {
    this.assertCanAct();
    if (requestTurnId !== undefined) this.assertNotSelfReentrant(requestTurnId);
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
    this.markLogicalSettled();
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

  assertNotSelfReentrant(requestTurnId: string): void {
    if (requestTurnId === this.provenance.nativeTurnId) {
      throw new Error("A ChatGPT-owned provider turn cannot synchronously re-enter itself");
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
  retryPolicy?: RetryPolicy;
  recovery?: ProviderRecovery;
}

export class ChatGptWebProviderCore {
  private readonly turns = new Map<string, ProviderTurnLifecycle>();
  private readonly retiredExecutions = new Map<string, number>();
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

  constructor(
    readonly serviceId = CHATGPT_WEB_PROVIDER_CORE_SERVICE,
    private readonly leases = new BrowserAccountLeaseRegistry(),
  ) {}

  get(executionKey: string): ProviderTurnLifecycle | undefined {
    return this.turns.get(executionKey);
  }

  begin(input: ChatGptWebProviderCoreTurnInput): ProviderTurnLifecycle {
    if (this.closed) throw new Error("ChatGPT Web ProviderCore is shut down");
    const existing = this.turns.get(input.executionKey);
    if (existing) return existing;

    const lease = this.leases.acquire({
      serviceId: this.serviceId,
      accountIdentity: input.accountIdentity,
      browserProfile: input.browserProfile,
      browserContext: input.browserContext,
      pageIdentity: input.pageIdentity,
      turnId: input.traceId,
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
      input.retryPolicy,
      binding => this.leases.bindPhysicalResource(lease, binding),
      () => this.leases.release(lease),
      () => {
        this.turns.delete(input.executionKey);
        this.rememberRetired(input.executionKey);
      },
    );
    const recovery = input.recovery ?? (this.wasRetired(input.executionKey) ? "REPLAY" : "NEW");
    if (recovery !== "NEW") turn.markRecovery(recovery);
    turn.markLeased();
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

  shutdown(): void {
    this.closed = true;
    this.leases.clear();
    this.turns.clear();
    this.retiredExecutions.clear();
  }
}
