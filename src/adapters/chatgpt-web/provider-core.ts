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

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

  provenance(): {
    serviceId: string;
    account: string;
    browserProfile: string;
    browserContext: string;
    page: string;
    turnId: string;
    leaseId: string;
  } {
    return {
      serviceId: this.descriptor.serviceId,
      account: fingerprint(this.descriptor.accountIdentity),
      browserProfile: fingerprint(this.descriptor.browserProfile),
      browserContext: fingerprint(this.descriptor.browserContext),
      page: fingerprint(this.descriptor.pageIdentity),
      turnId: this.descriptor.turnId,
      leaseId: this.leaseId,
    };
  }
}

export class BrowserAccountLeaseRegistry {
  private readonly leases = new Map<string, BrowserAccountLease>();

  acquire(descriptor: BrowserAccountLeaseDescriptor): BrowserAccountLease {
    const lease = new BrowserAccountLease(descriptor);
    const existing = this.leases.get(lease.leaseId);
    if (existing?.isActive()) {
      throw new Error(`Browser resource is already leased for turn ${descriptor.turnId}`);
    }
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  release(lease: BrowserAccountLease): void {
    lease.release();
    if (this.leases.get(lease.leaseId) === lease) this.leases.delete(lease.leaseId);
  }

  activeCount(): number {
    return [...this.leases.values()].filter(lease => lease.isActive()).length;
  }

  clear(): void {
    for (const lease of this.leases.values()) lease.release();
    this.leases.clear();
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
  private retirementScheduled = false;

  constructor(
    readonly lease: BrowserAccountLease,
    readonly provenance: ProviderTurnProvenance,
    private readonly retryPolicy: RetryPolicy = "strict",
    private readonly releaseLease: () => void = () => lease.release(),
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

  markLeased(): void {
    this.transition("LEASED");
  }

  markSurfaceReady(): void {
    this.transition("SURFACE_READY");
  }

  markSendActivated(): void {
    if (this.submission !== "prepared") return;
    this.submission = "send_activated";
    if (this.state === "SURFACE_READY") {
      this.transition("SUBMITTED");
    }
  }

  markSubmitted(): void {
    this.submission = "accepted";
    if (this.state === "SURFACE_READY" || this.state === "SUBMITTED") {
      if (this.state === "SURFACE_READY") this.transition("SUBMITTED");
    }
  }

  markRunning(): void {
    if (this.state === "SUBMITTED") this.transition("RUNNING");
    this.activity = "running";
  }

  markCapabilityWait(): void {
    if (this.state !== "RUNNING") {
      throw new Error(`Capability wait requires a running provider turn, got ${this.state}`);
    }
    this.activity = "capability_wait";
  }

  markRecovery(value: Exclude<ProviderRecovery, "NEW">): void {
    this.recovery = value;
  }

  markLogicalSettled(): void {
    this.logicalSettled = true;
  }

  canAutomaticallyRetry(): boolean {
    if (this.retryPolicy === "side_effect_free") return true;
    return this.submission === "prepared"
      && this.state !== "SUBMITTED"
      && this.state !== "RUNNING"
      && this.state !== "SETTLING"
      && this.state !== "RETIRED";
  }

  attachPhysicalSettlement(settlement: Promise<void>): void {
    if (this.physicalSettlementAttached) {
      throw new Error("Provider turn physical settlement can only be attached once");
    }
    this.physicalSettlementAttached = true;
    this.physicalSettlement = settlement.then(
      () => undefined,
      () => undefined,
    );
    void this.physicalSettlement.then(() => this.finishPhysicalSettlement());
  }

  async waitForPhysicalSettlement(): Promise<void> {
    await this.physicalSettlement;
  }

  private finishPhysicalSettlement(): void {
    if (this.physicalSettled) return;
    this.physicalSettled = true;
    this.activity = "idle";
    if (this.state !== "RETIRED") {
      if (this.state !== "SETTLING") this.transition("SETTLING");
      this.transition("RETIRED");
    }
    this.releaseLease();
  }

  scheduleRetirementAfterPhysicalSettlement(): void {
    if (this.retirementScheduled) return;
    this.retirementScheduled = true;
    void this.waitForPhysicalSettlement();
  }

  assertCanAct(): void {
    if (this.state === "SETTLING" || this.state === "RETIRED") {
      throw new Error("Provider turn is retired and cannot accept capability work");
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
  private closed = false;

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
    if (existing) {
      if (existing.snapshot().state !== "RETIRED") return existing;
      this.turns.delete(input.executionKey);
    }

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
      () => this.leases.release(lease),
    );
    if (input.recovery && input.recovery !== "NEW") turn.markRecovery(input.recovery);
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
  }
}
