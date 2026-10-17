import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { CapabilitySnapshot } from "./capability-projector";
import type { BrokerToolRequest } from "./turn-broker";
import { chatGptBrowserTabClosedError, chatGptSettlementWaitTimeoutError } from "./adapter-error";
import {
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS, chatGptBrowserTurnLimitError } from "./concurrency";
import type { ChatGptExternalTurnProgress } from "./turn-progress";

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  readonly capabilitySnapshot: CapabilitySnapshot;
  browser: Promise<string>;
  /** Physical helper/Playwright settlement, including the launcher end/release acknowledgement. */
  physicalSettlement: Promise<void>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  usageInput?: CodexParsedRequest;
  conversationKey?: string;
  releaseRetainedConversation?: () => Promise<void>;
  /** Idempotently retire the turn-bound MCP capability after browser and observer settlement. */
  retireCapability?: () => void | Promise<void>;
  submission?: { phase: "prepared" | "send_activated" | "accepted" };
  /** Semantic ChatGPT conversation epoch. Physical page/resource identity remains separate. */
  conversationGeneration?: number;
  /** Present only when the visible ChatGPT tab is driven manually through the Codex Zero Risk MCP contract. */
  manualControl?: { surfaceNonce: string };
  cancel: (reason?: Error) => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & {
    mode: "tools";
    token: Promise<string>;
    externalProgress: ChatGptExternalTurnProgress;
  })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    revision: parsed._compactionRequest
      ? compactionInputRevision(parsed)
      : extractChatGptTurnUserRevision(parsed),
  });
}

/** Exact canonical round identity inside one long-lived browser execution. */
export function chatGptTurnRoundKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for round replay");
  const purpose = parsed._compactionRequest ? "compaction" : "response";
  const body = parsed._rawBody;
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { input?: unknown }).input
    : undefined;
  if (!Array.isArray(input)) {
    // An internal DSH-owned turn (the Advisor review, #178) is routed straight to `runTurn` and
    // carries the native `_dshContext` instead of a Responses wire body. Its round identity is
    // the canonical user revision the same turn is already keyed by — never a fabricated wire
    // input. A wire ingress (Responses/Codex) still fails closed without its complete input.
    if (parsed._dshContext === undefined) {
      throw new Error("ChatGPT web requires the complete native Codex input for round replay");
    }
    return executionKey(parsed, {
      threadId: identity.threadId,
      turnId: identity.turnId,
      purpose,
      revision: extractChatGptTurnUserRevision(parsed),
    });
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose,
    input,
  });
}

/** One native Codex thread may own at most one live ChatGPT browser surface. */
export function chatGptThreadOwnershipKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const owner = identity.threadId
    ? { kind: "thread", id: identity.threadId }
    : identity.promptCacheKey
      ? { kind: "prompt_cache", id: identity.promptCacheKey }
      : identity.turnId
        ? { kind: "turn", id: identity.turnId }
        : undefined;
  if (!owner) throw new Error("ChatGPT web requires native Codex turn identity metadata for browser ownership");
  return createHash("sha256").update(JSON.stringify(owner)).digest("hex");
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? identity.turnId,
    purpose: "response",
    revision: source.content,
  });
}

export class ChatGptTurnSession {
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  readonly physicalSettlement: Promise<void>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private capabilityRetirementScheduled = false;
  private readonly rounds = new Map<string, {
    events: AdapterEvent[];
    reasoning: string[];
    completed: boolean;
    failure?: Error;
  }>();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly traceId?: string,
    readonly ownerKey?: string,
    readonly nativeTurnId?: string,
    readonly nativeThreadId?: string,
  ) {
    this.attachedConversationKey = runtime.conversationKey;
    this.physicalSettlement = runtime.physicalSettlement.then(
      () => { this.settledPhysical = true; },
      error => {
        this.settledPhysical = true;
        throw error;
      },
    );
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    this.scheduleCapabilityRetirement();
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  conversationKey(): string | undefined {
    return this.attachedConversationKey;
  }

  detachConversation(conversationKey: string): boolean {
    if (this.attachedConversationKey !== conversationKey) return false;
    this.attachedConversationKey = undefined;
    return true;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /** The client-visible browser result can settle before launcher/helper cleanup does. */
  isPhysicallySettled(): boolean {
    return this.settledPhysical;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  roundEvents(key: string): AdapterEvent[] {
    return [...this.round(key).events];
  }

  roundReasoning(key: string): string[] {
    return [...this.round(key).reasoning];
  }

  appendRoundEvent(key: string, event: AdapterEvent): void {
    this.appendRoundEvents(key, [event]);
  }

  appendRoundEvents(key: string, events: readonly AdapterEvent[]): void {
    if (events.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append to a completed ChatGPT native round");
    round.events.push(...events);
  }

  appendRoundReasoning(key: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append reasoning to a completed ChatGPT native round");
    round.reasoning.push(...values);
  }

  completeRound(key: string): void {
    this.round(key).completed = true;
  }

  failRound(key: string, error: Error): void {
    const round = this.round(key);
    round.failure = error;
    round.completed = true;
  }

  roundCompleted(key: string): boolean {
    return this.rounds.get(key)?.completed === true;
  }

  roundFailure(key: string): Error | undefined {
    return this.rounds.get(key)?.failure;
  }

  roundHasTerminalEvent(key: string): boolean {
    return this.rounds.get(key)?.events.some(event => event.type === "done" || event.type === "error") === true;
  }

  cancel(reason?: Error): void {
    this.runtime.cancel(reason);
  }

  private scheduleCapabilityRetirement(): void {
    if (this.capabilityRetirementScheduled || !this.runtime.retireCapability) return;
    this.capabilityRetirementScheduled = true;
    // Register only after the first observer entered `runExclusive`. This ensures an immediately
    // completed mocked/real browser cannot revoke its token ahead of the browser-outcome branch.
    // At physical settlement, read the current tail so every tool-result/reconnect observer that
    // was already admitted finishes before the capability is retired.
    void this.physicalSettlement
      .then(() => this.tail)
      .then(() => this.runtime.retireCapability!())
      .catch(error => {
        console.error(
          `[chatgpt-web] failed to retire settled turn capability: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private round(key: string) {
    let round = this.rounds.get(key);
    if (round) return round;
    round = { events: [], reasoning: [], completed: false };
    this.rounds.set(key, round);
    while (this.rounds.size > 512) {
      const oldestCompleted = [...this.rounds].find(([, candidate]) => candidate.completed);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      this.rounds.delete(oldestCompleted[0]);
    }
    return round;
  }
}

/**
 * How long a turn may wait for *another turn's* physical settlement before it fails closed
 * (issue #301).
 *
 * The lifetime decision this bounds is the registry's serialization: a later turn waits for the
 * response that already owns a retained conversation. That wait used to have no bound at all, so a
 * predecessor whose operation never published a settlement (a dead or unresponsive page) held every
 * later turn forever — no error, no progress, and no signal on the availability surface.
 *
 * The grace must never cut a *legitimate* teardown short: the launcher's own turn-end
 * acknowledgement alone is allowed `LAUNCHER_TURN_END_TIMEOUT_MS` (15 s), and page/context release
 * and storage-state persistence follow it, so the default is a comfortable multiple of that single
 * step. #291 bounded shutdown's wait on an attached settlement with the same shape (bound, then
 * write off as `rejected`, never `fulfilled`, and retire the resource); this is that discipline
 * applied to the turn path.
 */
export const DEFAULT_SETTLEMENT_WAIT_GRACE_MS = 60_000;

export interface ChatGptContextExhaustionRecord {
  readonly conversationKey: string;
  readonly handle: {
    readonly id: string;
    readonly generation: number;
  };
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly conversationHeads = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();
  private readonly conversationGenerations = new Map<string, number>();
  private readonly contextExhaustions = new Map<string, ChatGptContextExhaustionRecord>();
  private readonly sentSystemFingerprints = new Map<string, { generation: number; fingerprint: string }>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
    private readonly settlementWaitGraceMs: number = DEFAULT_SETTLEMENT_WAIT_GRACE_MS,
  ) {
    if (!Number.isFinite(settlementWaitGraceMs) || settlementWaitGraceMs <= 0) {
      throw new TypeError("The ChatGPT settlement-wait grace must be a positive finite number of milliseconds");
    }
  }

  /**
   * Wait for *another turn's* physical settlement, bounded by the registry's grace (issue #301).
   *
   * The settlement owner stays the only authority on the outcome: this bound only decides which
   * arrives first. `true` means the settlement landed — fulfilled or rejected, either way the
   * resource's fate is known; `false` means the grace expired and the caller must fail closed
   * instead of waiting. The timer is cleared as soon as the settlement lands, so a settlement that
   * does resolve is still awaited in full and never cut short.
   */
  private awaitSettlementWithinGrace(
    settlement: Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (signal?.aborted) {
        // Keep the underlying settlement observed: another owner may still depend on it.
        void settlement.catch(() => {});
        reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        return;
      }
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      };
      const onAbort = (): void => {
        if (done) return;
        done = true;
        cleanup();
        reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
      };
      timer = setTimeout(() => finish(false), this.settlementWaitGraceMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      settlement.then(() => finish(true), () => finish(true));
    });
  }

  /**
   * Retire the session whose physical settlement never came and report the explicit outcome.
   *
   * Retirement is the resource decision (the #291 shape): the session is cancelled — which is how the
   * physical owner is told to abort and publish a `rejected` settlement — and its key stops being
   * reusable, so a later turn can never be handed a page that may still produce output. Nothing is
   * reported as settled.
   */
  private failSettlementWait(
    key: string,
    session: ChatGptTurnSession | undefined,
    phase: string,
    traceId?: string,
  ): never {
    const error = chatGptSettlementWaitTimeoutError(this.settlementWaitGraceMs, phase, traceId);
    if (session) this.retire(key, session, error);
    console.warn(`[chatgpt-web] ${error.message}`);
    throw error;
  }

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    ownerKey?: string,
    nativeTurnId?: string,
    nativeThreadId?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) throw chatGptBrowserTurnLimitError();
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), traceId, ownerKey, nativeTurnId, nativeThreadId);
    this.entries.set(key, session);
    const conversationKey = session.conversationKey();
    if (conversationKey) {
      this.conversationHeads.set(conversationKey, session);
      if (!this.conversationGenerations.has(conversationKey)) {
        this.conversationGenerations.set(conversationKey, session.runtime.conversationGeneration ?? 1);
      }
      this.pruneConversationGenerations();
    }
    return session;
  }

  conversationGeneration(conversationKey: string): number {
    const generation = this.conversationGenerations.get(conversationKey);
    return generation === undefined ? 1 : generation;
  }

  setConversationGeneration(conversationKey: string, generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("ChatGPT conversation generation must be a positive safe integer");
    }
    const current = this.conversationGenerations.get(conversationKey);
    if (current !== undefined && generation < current) {
      throw new Error("ChatGPT conversation generation cannot move backwards");
    }
    this.conversationGenerations.set(conversationKey, generation);
    this.pruneConversationGenerations();
  }

  /**
   * The system-block identity installed in the EXACT physical generation of this
   * conversation, if any.
   *
   * Three distinct identities are deliberately kept apart and never conflated:
   * - `conversationKey` = the stable logical DSH chat identity (issue #170);
   * - `generation` = the physical ChatGPT Web conversation epoch (a replay or
   *   replacement surface bumps it; issue #170/#171);
   * - the fingerprint = which DSH system block was installed in THAT epoch.
   *
   * Returns undefined when no fingerprint was recorded for the given
   * generation. A fingerprint recorded for generation N is never considered
   * valid for generation N+1: a new physical epoch re-installs the system, so
   * the caller falls back to the full compile (the safe direction).
   */
  sentSystemFingerprint(conversationKey: string, generation: number): string | undefined {
    const recorded = this.sentSystemFingerprints.get(conversationKey);
    if (!recorded || recorded.generation !== generation) return undefined;
    return recorded.fingerprint;
  }

  recordSentSystemFingerprint(conversationKey: string, generation: number, fingerprint: string): void {
    if (!conversationKey.trim()) throw new Error("ChatGPT system fingerprint requires a conversation key");
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("ChatGPT system fingerprint requires a positive safe generation");
    }
    if (!fingerprint.trim()) throw new Error("ChatGPT system fingerprint is empty");
    this.sentSystemFingerprints.set(conversationKey, { generation, fingerprint });
    this.pruneConversationGenerations();
  }

  rememberContextExhaustion(executionKey: string, record: ChatGptContextExhaustionRecord): void {
    if (!executionKey.trim()) throw new Error("ChatGPT context exhaustion requires an execution key");
    if (!record.conversationKey.trim()) throw new Error("ChatGPT context exhaustion requires a conversation key");
    if (!record.handle.id.trim() || !Number.isSafeInteger(record.handle.generation) || record.handle.generation < 1) {
      throw new Error("ChatGPT context exhaustion requires a valid conversation handle");
    }
    this.contextExhaustions.set(executionKey, {
      conversationKey: record.conversationKey,
      handle: { id: record.handle.id, generation: record.handle.generation },
    });
    while (this.contextExhaustions.size > this.maxEntries) {
      const oldest = this.contextExhaustions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.contextExhaustions.delete(oldest);
    }
  }

  contextExhaustion(executionKey: string): ChatGptContextExhaustionRecord | undefined {
    const record = this.contextExhaustions.get(executionKey);
    return record
      ? { conversationKey: record.conversationKey, handle: { ...record.handle } }
      : undefined;
  }

  clearContextExhaustion(executionKey: string): void {
    this.contextExhaustions.delete(executionKey);
  }

  async getOrCreateAfterOwnerRetirement(
    key: string,
    ownerKey: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    signal?: AbortSignal,
    nativeTurnId?: string,
    nativeThreadId?: string,
  ): Promise<ChatGptTurnSession> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const existing = this.entries.get(key);
      if (existing) {
        existing.touch();
        return existing;
      }
      const pending = this.retirements.get(key) ?? this.ownerRetirements.get(ownerKey);
      if (pending) {
        // Bounded (issue #301): a retirement whose settlement never lands must not hold this turn
        // forever. The retired session's runtime was already cancelled when it was retired, so the
        // physical owner has been asked to abort and publish its settlement.
        if (!await this.awaitSettlementWithinGrace(pending, signal)) {
          this.failSettlementWait(key, undefined, "waiting for a previous turn's retirement", traceId);
        }
        continue;
      }
      const activeOwner = [...this.entries].find(([ownedKey, session]) => (
        ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled()
      ));
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        // A different native message for the same thread is sequential work, not permission to
        // kill the response already using that retained conversation. Wait for its complete
        // browser/launcher settlement, bounded by the settlement-wait grace (issue #301): a turn
        // whose operation stopped publishing a settlement is retired instead of holding this one
        // forever. Explicit tab close and lifecycle cancellation remain the only paths that
        // preempt an active owner.
        if (!await this.awaitSettlementWithinGrace(ownedSession.physicalSettlement, signal)) {
          this.failSettlementWait(ownedKey, ownedSession, "waiting for the active turn that owns this conversation", traceId);
        }
        continue;
      }
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      return this.getOrCreate(key, start, traceId, ownerKey, nativeTurnId, nativeThreadId);
    }
  }

  find(key: string): ChatGptTurnSession | undefined {
    const session = this.entries.get(key);
    session?.touch();
    return session;
  }

  findConversationHead(conversationKey: string): ChatGptTurnSession | undefined {
    const session = this.conversationHeads.get(conversationKey);
    session?.touch();
    return session;
  }

  /** Wait for a retained conversation epoch that has been detached but not physically released. */
  async waitForConversationRetirement(conversationKey: string, signal?: AbortSignal): Promise<void> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (!pending) return;
    if (!await this.awaitSettlementWithinGrace(pending, signal)) {
      this.failSettlementWait(conversationKey, undefined, "waiting for a retained conversation to be retired");
    }
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  /**
   * Close the physical retained-chat epoch without discarding a terminal response that won the
   * compaction race before any compaction instruction reached that response. The detached logical
   * session remains addressable by its exact Responses execution key, so the post-compaction
   * native round can consume the already-committed answer instead of opening another browser turn.
   */
  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    const outcome = preserved.settledOutcome();
    if (!outcome || outcome.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) {
      if (!await this.awaitSettlementWithinGrace(pending)) {
        this.failSettlementWait(conversationKey, undefined, "waiting for a retained conversation to be retired");
      }
      return 0;
    }
    const matches = [...this.entries].filter(([, session]) => (
      session.conversationKey() === conversationKey
    ));
    if (matches.length === 0) return 0;
    if (preserved && !matches.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    this.conversationHeads.delete(conversationKey);
    for (const [key, session] of matches) {
      if (this.entries.get(key) === session
        && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) session.cancel();
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = matches.findLast(([, session]) => (
      session.runtime.releaseRetainedConversation !== undefined
    ))?.[1].runtime.releaseRetainedConversation;
    const retirement = Promise.all(matches.map(([, session]) => session.physicalSettlement))
      .then(async () => { await release?.(); });
    this.conversationRetirements.set(conversationKey, retirement);
    // The coordination entry belongs to the physical close, not to this bounded wait: only the
    // settlement itself removes it, so a caller that arrives while the close is still running keeps
    // waiting behind the same operation instead of starting a second one.
    const forgetConversationRetirement = (): void => {
      if (this.conversationRetirements.get(conversationKey) === retirement) {
        this.conversationRetirements.delete(conversationKey);
      }
    };
    void retirement.then(forgetConversationRetirement, forgetConversationRetirement);
    if (!await this.awaitSettlementWithinGrace(retirement)) {
      this.failSettlementWait(conversationKey, undefined, "retiring a retained conversation");
    }
    return matches.length;
  }

  async waitForRetirement(key: string): Promise<void> {
    const pending = this.retirements.get(key);
    if (!pending) return;
    if (!await this.awaitSettlementWithinGrace(pending)) {
      this.failSettlementWait(key, undefined, "waiting for a previous turn's retirement");
    }
  }

  async retireAndWait(key: string, signal?: AbortSignal): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      if (!await this.awaitSettlementWithinGrace(pending, signal)) {
        this.failSettlementWait(key, undefined, "waiting for a previous turn to retire");
      }
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    this.forgetConversationHead(session);
    if (!await this.awaitSettlementWithinGrace(this.beginRetirement(key, session), signal)) {
      this.failSettlementWait(key, undefined, "retiring an interrupted turn");
    }
    return true;
  }

  retire(key: string, session: ChatGptTurnSession, reason?: Error): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    this.beginRetirement(key, session, reason);
    return true;
  }

  /** Cancel only active responses whose exact native turn ids Codex marked as interrupted. */
  retireAbortedOwnerTurns(
    ownerKey: string,
    abortedTurnIds: ReadonlySet<string>,
    keepKey: string,
  ): number {
    const matches = [...this.entries].filter(([key, session]) => (
      key !== keepKey
      && session.ownerKey === ownerKey
      && session.nativeTurnId !== undefined
      && abortedTurnIds.has(session.nativeTurnId)
      && session.isActive()
    ));
    for (const [key, session] of matches) {
      this.entries.delete(key);
      this.forgetConversationHead(session);
      this.beginRetirement(key, session);
    }
    return matches.length;
  }

  clear(executionNamespace?: string): number {
    const matches = [...this.entries].filter(([key]) => (
      executionNamespace === undefined || key.startsWith(`${executionNamespace}:`)
    ));
    for (const [key, session] of matches) this.beginRetirement(key, session);
    for (const [key] of matches) this.entries.delete(key);
    if (executionNamespace === undefined) {
      this.conversationHeads.clear();
      this.contextExhaustions.clear();
      this.sentSystemFingerprints.clear();
      // A cleared registry stands for a fresh process, and the conversation generations are part of
      // that process state: keeping them would make the first turn of the "new process" create the
      // next generation instead of the one a new conversation starts at.
      this.conversationGenerations.clear();
      // In-flight retirements are deliberately **kept**. A retirement is how this registry
      // coordinates the physical close of a retained conversation: a caller that arrives while one is
      // pending waits for it instead of starting a second close (`closeConversationAndWait`). Dropping
      // the entry here would lose that coordination exactly while the close is still running. Each
      // entry removes itself when its promise settles, so nothing is retained beyond its lifetime.
    } else {
      const clearedConversationKeys: string[] = [];
      for (const [key, session] of this.conversationHeads) {
        if (session.ownerKey?.startsWith(`${executionNamespace}:`)) {
          this.conversationHeads.delete(key);
          clearedConversationKeys.push(key);
        }
      }
      for (const key of this.contextExhaustions.keys()) {
        if (key.startsWith(`${executionNamespace}:`)) this.contextExhaustions.delete(key);
      }
      for (const key of clearedConversationKeys) this.sentSystemFingerprints.delete(key);
    }
    return matches.length;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    await Promise.all(sessions.map(session => session.physicalSettlement));
    return sessions.length;
  }

  /**
   * Begin retiring only the browser execution owned by the exact native Codex turn.
   *
   * Codex runs Interrupt hooks synchronously with a short deadline. Ownership is removed and the
   * abort is delivered before this method returns; physical helper cleanup remains represented by
   * `settlement`, so replacement turns still serialize behind the real teardown without blocking
   * the hook acknowledgement itself.
   */
  cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: Error,
  ): { cancelled: number; settlement: Promise<void> } {
    const matches = [...this.entries].filter(([, session]) => (
      session.nativeThreadId === threadId
      && session.nativeTurnId === turnId
    ));
    for (const [key, session] of matches) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
    const settlement = Promise.all(
      matches.map(([key, session]) => this.beginRetirement(key, session, reason)),
    ).then(() => undefined);
    return { cancelled: matches.length, settlement };
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private pruneConversationGenerations(): void {
    const activeConversationKeys = new Set(this.conversationHeads.keys());
    if (this.conversationGenerations.size > this.maxEntries) {
      for (const conversationKey of this.conversationGenerations.keys()) {
        if (this.conversationGenerations.size <= this.maxEntries) break;
        if (activeConversationKeys.has(conversationKey)) continue;
        this.conversationGenerations.delete(conversationKey);
      }
    }
    if (this.sentSystemFingerprints.size > this.maxEntries) {
      for (const conversationKey of this.sentSystemFingerprints.keys()) {
        if (this.sentSystemFingerprints.size <= this.maxEntries) break;
        if (activeConversationKeys.has(conversationKey)) continue;
        this.sentSystemFingerprints.delete(conversationKey);
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
  }

  private forgetConversationHead(session: ChatGptTurnSession): void {
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) {
      this.conversationHeads.delete(conversationKey);
    }
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const conversationKey = session.conversationKey();
    session.cancel(reason);
    const retirement = session.physicalSettlement;
    this.retirements.set(key, retirement);
    void retirement.then(() => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    });
    if (session.ownerKey) {
      const previous = this.ownerRetirements.get(session.ownerKey);
      const ownerRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.ownerRetirements.set(session.ownerKey, ownerRetirement);
      void ownerRetirement.then(() => {
        if (this.ownerRetirements.get(session.ownerKey!) === ownerRetirement) {
          this.ownerRetirements.delete(session.ownerKey!);
        }
      });
    }
    if (conversationKey) {
      const previous = this.conversationRetirements.get(conversationKey);
      const conversationRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.conversationRetirements.set(conversationKey, conversationRetirement);
      const forgetConversationRetirement = () => {
        if (this.conversationRetirements.get(conversationKey) === conversationRetirement) {
          this.conversationRetirements.delete(conversationKey);
        }
      };
      void conversationRetirement.then(
        forgetConversationRetirement,
        forgetConversationRetirement,
      );
    }
    return retirement;
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
