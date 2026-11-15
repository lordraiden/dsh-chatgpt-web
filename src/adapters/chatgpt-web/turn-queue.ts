/**
 * Bounded wait queue in front of the ChatGPT Web account fan-out bound (issue #358).
 *
 * ## Why this owner exists
 *
 * `MAX_CHATGPT_BROWSER_TABS` (`concurrency.ts`) is an **account-safety** bound: every active turn owns a
 * real browser document in the signed-in account, so unbounded fan-out is indistinguishable from spam.
 * Until this module existed the bound was enforced as an *immediate refusal*: a caller that arrived
 * while five turns were in flight was told to go away. A fan-out client (one that issues several
 * requests at once) then retried, which made the burst worse — the refusal was honest but useless,
 * because the bound is a *rate*, not a permanent condition.
 *
 * This module owns exactly one mechanism: a bounded, cancellable, event-driven **wait** for one of the
 * account's slots. It decides **when** a turn may ask for a lease; it never acquires one, never
 * executes anything, never retries and never interprets a provider conversation. The lease registry
 * (`BrowserAccountLeaseRegistry`) remains the only owner of the bound and of every lease on it: the
 * queue reads the registry's live count and is woken by the registry's releases, so capacity is never
 * counted twice.
 *
 * ## What is bounded
 *
 * - **The wait**: a turn waits at most `waitBudgetMs` (default 60 s, one typical turn). When the budget
 *   expires the queue publishes the caller's refusal — a typed 429 carrying `Retry-After` — instead of
 *   waiting forever or failing at once.
 * - **The depth**: at most `maxWaiters` turns may wait per account. A burst beyond that is refused
 *   immediately with the same honest backpressure, because an unbounded queue would just move the
 *   overload from the browser into the HTTP listener's memory.
 *
 * ## Fairness
 *
 * - **Priority lanes.** A turn whose caller declared a housekeeping purpose (the existing
 *   `purpose` / `x-dsh-turn-purpose` channel, classified by `isEphemeralWebChatTurn`) is served before
 *   conversational turns. Housekeeping work (a session title, a compaction) is small and blocking the
 *   user's own chat behind it is the damaging outcome; a conversational turn waiting behind a few
 *   housekeeping calls is not starved, it is ordered.
 * - **Per-caller fair share.** One caller may not hold every slot while another caller waits. When a
 *   caller already holds `maxPerCaller` slots, its next turn is skipped in favour of another caller's
 *   waiting turn. The cap is lifted when no other caller is waiting, so a single-caller deployment
 *   still uses the whole account — fairness only binds under contention.
 * - FIFO within a lane, so a caller that enqueues many turns cannot jump an earlier arrival.
 *
 * ## Observability
 *
 * `snapshot()` reports depth, grants, wait times and refusals, in total and per caller. Callers are
 * identified by a fingerprint the provider computed before calling this module: no prompt text and no
 * raw identity ever reaches it.
 *
 * ## What this module deliberately does not own
 *
 * The refusal vocabulary, the abort error and the shutdown error are supplied by the caller
 * ({@link ChatGptTurnQueueOptions}), exactly like the shared conversation-admission gate: this module
 * has no provider knowledge and no HTTP vocabulary, so the provider publishes the one refusal it
 * already owns for backpressure.
 */

/** Which lane a waiting turn belongs to. Housekeeping is served first (see the module contract). */
export type ChatGptTurnQueuePriority = "housekeeping" | "conversational";

/** Why the queue refused a turn: it waited its budget out, or the bounded queue was already full. */
export type ChatGptTurnQueueRefusalReason = "wait_budget_exhausted" | "queue_full";

/**
 * The facts a refusal carries.
 *
 * The provider turns this into its typed backpressure error; the queue itself has no error vocabulary.
 * `retryAfterSeconds` is the queue's own deferral hint — the same budget window that just expired — so
 * an OpenAI-compatible caller can sleep instead of retrying into the same saturated fan-out.
 */
export interface ChatGptTurnQueueRefusal {
  readonly reason: ChatGptTurnQueueRefusalReason;
  readonly retryAfterSeconds: number;
  readonly waitBudgetMs: number;
  readonly depth: number;
  readonly capacity: number;
}

/** One turn asking for an account slot. */
export interface ChatGptTurnQueueRequest {
  /** Stable account grouping (the same key the lease registry uses). */
  readonly accountKey: string;
  /** Fingerprinted caller identity, used only for fairness and metrics. */
  readonly callerKey: string;
  readonly priority: ChatGptTurnQueuePriority;
  /** Cancellation of the whole turn; an aborted wait never grants a slot. */
  readonly signal?: AbortSignal;
}

/**
 * One granted slot.
 *
 * The turn that receives it must call exactly one of {@link ChatGptTurnQueueTicket.commit} (it acquired
 * its lease) or {@link ChatGptTurnQueueTicket.abandon} (it did not), and the queue releases a committed
 * slot through {@link ChatGptTurnQueue.release} when the turn retires. Both are idempotent, so a
 * cancellation racing a grant cannot leak a slot.
 */
export interface ChatGptTurnQueueTicket {
  readonly accountKey: string;
  readonly callerKey: string;
  readonly priority: ChatGptTurnQueuePriority;
  /** How long this turn waited before the slot was granted. */
  readonly waitedMs: number;
  commit(): void;
  abandon(): void;
}

/** One caller's queue view: how much it holds, how long it waited and how often it was refused. */
export interface ChatGptTurnQueueCallerSnapshot {
  readonly caller: string;
  /** Slots this caller currently holds (committed turns). */
  readonly active: number;
  /** This caller's turns waiting right now. */
  readonly depth: number;
  readonly granted: number;
  readonly refused: number;
  readonly waitMsTotal: number;
  readonly waitMsMax: number;
  readonly lastWaitMs?: number;
}

/** The queue's whole observable state. Counters only: no prompt text, no raw identity. */
export interface ChatGptTurnQueueSnapshot {
  readonly capacity: number;
  readonly waitBudgetMs: number;
  readonly maxWaiters: number;
  readonly maxPerCaller: number;
  readonly retryAfterSeconds: number;
  /** Turns waiting right now (all accounts). */
  readonly depth: number;
  /** Grants handed out but not yet committed/abandoned. */
  readonly grants: number;
  /** Slots held by committed tickets (the provider adds its live lease count beside this). */
  readonly active: number;
  readonly granted: number;
  readonly refused: number;
  readonly waitMsTotal: number;
  readonly waitMsMax: number;
  readonly lastWaitMs?: number;
  readonly callers: readonly ChatGptTurnQueueCallerSnapshot[];
}

export interface ChatGptTurnQueueOptions {
  /** The account fan-out bound the queue waits in front of. */
  readonly capacity: number;
  /** Live leases for one account key; the queue never owns capacity itself. */
  readonly activeLeases: (accountKey: string) => number;
  /** Bound of one wait. Defaults to {@link DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS}. */
  readonly waitBudgetMs?: number;
  /** Bound of the queue depth per account. Defaults to four turns per slot. */
  readonly maxWaiters?: number;
  /** Slots one caller may hold while another caller waits. Defaults to `capacity - 1`. */
  readonly maxPerCaller?: number;
  /** The refusal published when the wait budget expires or the queue is full. */
  readonly refusal: (refusal: ChatGptTurnQueueRefusal) => Error;
  /** The cancellation published when the caller's signal aborts the wait. */
  readonly abortError: (signal: AbortSignal | undefined) => Error;
  /** The refusal published when the queue has been closed (shutdown). */
  readonly closedError: () => Error;
}

/** The one account-slot queue for a provider core. */
export interface ChatGptTurnQueue {
  /**
   * Wait for one account slot, up to the configured budget.
   *
   * Resolves with a ticket the turn must commit or abandon. Rejects with the caller's refusal when the
   * budget expires or the queue is full, and with the caller's abort error when the turn is cancelled.
   */
  acquire(request: ChatGptTurnQueueRequest): Promise<ChatGptTurnQueueTicket>;
  /** Release a committed slot (called when the turn retires). Idempotent, silent for a foreign ticket. */
  release(ticket: ChatGptTurnQueueTicket | undefined): void;
  /** Wake waiters after a lease was released outside a ticket (defensive; idempotent). */
  notifyReleased(accountKey: string): void;
  /** The deferral hint published with a refusal, in whole seconds. */
  retryAfterSeconds(): number;
  snapshot(): ChatGptTurnQueueSnapshot;
  /** Refuse every waiter and forget every grant. Idempotent; used on shutdown. */
  close(): void;
}

/**
 * Default bound of one turn-queue wait, in milliseconds.
 *
 * The number is chosen from the competitor the queue waits on, not from taste: a slot frees when one
 * browser turn finishes, and this provider's own turn clocks allow a turn to run for minutes
 * (`turnTimeoutMs`, `generationRunningStallMs`). One typical turn is therefore the useful courtesy
 * window — long enough to absorb a burst that outlives a single generation, short enough that a
 * saturated account answers its caller with a typed 429 inside the caller's own retry horizon instead
 * of holding an HTTP connection for the whole turn ceiling.
 */
export const DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS = 60_000;

/** The operator override for the wait budget (milliseconds). */
export const CHATGPT_TURN_QUEUE_WAIT_ENV = "DSH_CHATGPT_WEB_TURN_QUEUE_WAIT_MS";

/** Read the configured wait budget; a missing or invalid value keeps the default. */
export function resolveChatGptTurnQueueWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHATGPT_TURN_QUEUE_WAIT_ENV];
  const configured = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS;
}

/**
 * How many callers the metrics keep.
 *
 * Bounded so a deployment that talks to many sessions cannot grow the control surface's snapshot
 * without limit; the least recently active caller is dropped first.
 */
const MAX_TRACKED_CALLERS = 64;

interface CallerHeld {
  committed: number;
  granted: number;
}

interface Waiter {
  readonly accountKey: string;
  readonly callerKey: string;
  readonly priority: ChatGptTurnQueuePriority;
  readonly enqueuedAt: number;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  readonly signal?: AbortSignal;
  readonly resolve: (ticket: ChatGptTurnQueueTicket) => void;
  readonly reject: (error: Error) => void;
}

interface TicketState {
  state: "granted" | "committed" | "abandoned" | "released";
  readonly accountKey: string;
  readonly callerKey: string;
}

interface CallerMetrics {
  granted: number;
  refused: number;
  waitMsTotal: number;
  waitMsMax: number;
  lastWaitMs?: number;
  lastSeenAt: number;
}

function priorityRank(priority: ChatGptTurnQueuePriority): number {
  return priority === "housekeeping" ? 0 : 1;
}

export function createChatGptTurnQueue(options: ChatGptTurnQueueOptions): ChatGptTurnQueue {
  const capacity = options.capacity;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error("A turn queue capacity must be a positive safe integer");
  }
  const waitBudgetMs = options.waitBudgetMs ?? DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS;
  if (!Number.isFinite(waitBudgetMs) || waitBudgetMs <= 0) {
    throw new Error("A turn queue wait budget must be a positive finite number of milliseconds");
  }
  const maxWaiters = options.maxWaiters ?? capacity * 4;
  if (!Number.isSafeInteger(maxWaiters) || maxWaiters <= 0) {
    throw new Error("A turn queue depth must be a positive safe integer");
  }
  const maxPerCaller = options.maxPerCaller ?? Math.max(1, capacity - 1);
  if (!Number.isSafeInteger(maxPerCaller) || maxPerCaller <= 0) {
    throw new Error("A turn queue caller share must be a positive safe integer");
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(waitBudgetMs / 1_000));

  /** Waiters in service order: housekeeping lane first, FIFO inside a lane. */
  const waiters: Waiter[] = [];
  /** Outstanding grants per account (granted, neither committed nor abandoned). */
  const grants = new Map<string, number>();
  /** Committed/granted slots per account and caller, for the fair share. */
  const held = new Map<string, Map<string, CallerHeld>>();
  const ticketStates = new WeakMap<ChatGptTurnQueueTicket, TicketState>();
  const metrics = new Map<string, CallerMetrics>();
  const totals = { granted: 0, refused: 0, waitMsTotal: 0, waitMsMax: 0, lastWaitMs: undefined as number | undefined };
  let closed = false;

  const callerHeld = (accountKey: string, callerKey: string): CallerHeld => {
    let perAccount = held.get(accountKey);
    if (!perAccount) {
      perAccount = new Map<string, CallerHeld>();
      held.set(accountKey, perAccount);
    }
    let entry = perAccount.get(callerKey);
    if (!entry) {
      entry = { committed: 0, granted: 0 };
      perAccount.set(callerKey, entry);
    }
    return entry;
  };

  const heldCount = (accountKey: string, callerKey: string): number => {
    const entry = held.get(accountKey)?.get(callerKey);
    return entry === undefined ? 0 : entry.committed + entry.granted;
  };

  /**
   * Drop a caller/account entry once it holds nothing.
   *
   * The queue lives for the whole process, so a settled caller must not leave a permanent entry behind
   * for every session the deployment ever served.
   */
  const pruneHeld = (accountKey: string, callerKey: string, entry: CallerHeld): void => {
    if (entry.committed > 0 || entry.granted > 0) return;
    const perAccount = held.get(accountKey);
    if (!perAccount || perAccount.get(callerKey) !== entry) return;
    perAccount.delete(callerKey);
    if (perAccount.size === 0) held.delete(accountKey);
  };

  const outstandingGrants = (accountKey: string): number => grants.get(accountKey) ?? 0;

  /** Capacity is the lease registry's live count plus this queue's own outstanding grants. */
  const hasCapacity = (accountKey: string): boolean =>
    options.activeLeases(accountKey) + outstandingGrants(accountKey) < capacity;

  /**
   * Whether one caller may take a slot now.
   *
   * Under its fair share: always. Over it: only when no other caller is waiting for the same account,
   * so the cap never leaves an account slot idle when there is nobody to be fair to.
   */
  const callerEligible = (accountKey: string, callerKey: string): boolean => {
    if (heldCount(accountKey, callerKey) < maxPerCaller) return true;
    return !waiters.some(waiter => waiter.accountKey === accountKey && waiter.callerKey !== callerKey);
  };

  const waitingFor = (accountKey: string): number =>
    waiters.reduce((count, waiter) => count + (waiter.accountKey === accountKey ? 1 : 0), 0);

  const metricsFor = (callerKey: string): CallerMetrics => {
    let metric = metrics.get(callerKey);
    if (!metric) {
      if (metrics.size >= MAX_TRACKED_CALLERS) {
        let oldestKey: string | undefined;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [key, value] of metrics) {
          if (value.lastSeenAt < oldestAt) {
            oldestAt = value.lastSeenAt;
            oldestKey = key;
          }
        }
        if (oldestKey !== undefined) metrics.delete(oldestKey);
      }
      metric = { granted: 0, refused: 0, waitMsTotal: 0, waitMsMax: 0, lastSeenAt: 0 };
      metrics.set(callerKey, metric);
    }
    metric.lastSeenAt = Date.now();
    return metric;
  };

  const recordGrant = (callerKey: string, waitedMs: number): void => {
    const metric = metricsFor(callerKey);
    metric.granted += 1;
    metric.waitMsTotal += waitedMs;
    metric.waitMsMax = Math.max(metric.waitMsMax, waitedMs);
    metric.lastWaitMs = waitedMs;
    totals.granted += 1;
    totals.waitMsTotal += waitedMs;
    totals.waitMsMax = Math.max(totals.waitMsMax, waitedMs);
    totals.lastWaitMs = waitedMs;
  };

  const recordRefusal = (callerKey: string): void => {
    const metric = metricsFor(callerKey);
    metric.refused += 1;
    totals.refused += 1;
  };

  const refusalFor = (reason: ChatGptTurnQueueRefusalReason, accountKey: string): Error =>
    options.refusal({
      reason,
      retryAfterSeconds,
      waitBudgetMs,
      depth: waitingFor(accountKey),
      capacity,
    });

  const makeTicket = (
    accountKey: string,
    callerKey: string,
    priority: ChatGptTurnQueuePriority,
    waitedMs: number,
  ): ChatGptTurnQueueTicket => {
    const entry = callerHeld(accountKey, callerKey);
    const state: TicketState = { state: "granted", accountKey, callerKey };
    const settleGrant = (): void => {
      const remaining = Math.max(0, outstandingGrants(accountKey) - 1);
      if (remaining === 0) grants.delete(accountKey);
      else grants.set(accountKey, remaining);
      entry.granted = Math.max(0, entry.granted - 1);
    };
    const ticket: ChatGptTurnQueueTicket = {
      accountKey,
      callerKey,
      priority,
      waitedMs,
      commit: () => {
        if (state.state !== "granted") return;
        state.state = "committed";
        settleGrant();
        entry.committed += 1;
      },
      abandon: () => {
        if (state.state !== "granted") return;
        state.state = "abandoned";
        settleGrant();
        pruneHeld(accountKey, callerKey, entry);
        pump(accountKey);
      },
    };
    ticketStates.set(ticket, state);
    return ticket;
  };

  /** Count one grant and mint its ticket. The single place a slot is handed out. */
  const grantSlot = (
    accountKey: string,
    callerKey: string,
    priority: ChatGptTurnQueuePriority,
    enqueuedAt: number,
  ): ChatGptTurnQueueTicket => {
    const waitedMs = Math.max(0, Date.now() - enqueuedAt);
    grants.set(accountKey, outstandingGrants(accountKey) + 1);
    callerHeld(accountKey, callerKey).granted += 1;
    recordGrant(callerKey, waitedMs);
    return makeTicket(accountKey, callerKey, priority, waitedMs);
  };

  /** Hand one slot to one waiter: count the grant, then resolve the wait. */
  const grantWaiter = (waiter: Waiter): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(grantSlot(waiter.accountKey, waiter.callerKey, waiter.priority, waiter.enqueuedAt));
  };

  const removeWaiter = (waiter: Waiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
  };

  const insertWaiter = (waiter: Waiter): void => {
    const rank = priorityRank(waiter.priority);
    let index = waiters.length;
    // Insert after every waiter of the same or a higher-priority lane: housekeeping first, FIFO inside
    // a lane, so an earlier arrival always outranks a later one of its own lane.
    while (index > 0 && priorityRank(waiters[index - 1]!.priority) > rank) index -= 1;
    waiters.splice(index, 0, waiter);
  };

  /**
   * The first waiter of this account whose caller may take a slot, in service order.
   *
   * If every waiting caller is over its fair share, the earliest arrival proceeds anyway: the fair
   * share exists to stop one caller monopolising the account, never to deadlock the queue when a
   * deployment configures a cap below `capacity - 1`. Progress is the safety valve; fairness is the
   * ordering rule.
   */
  const nextEligibleIndex = (accountKey: string): number => {
    let earliest = -1;
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]!;
      if (waiter.accountKey !== accountKey) continue;
      if (earliest < 0) earliest = index;
      if (callerEligible(accountKey, waiter.callerKey)) return index;
    }
    return earliest;
  };

  /** Grant as many waiters as the account's capacity and each caller's fair share allow. */
  const pump = (accountKey: string): void => {
    if (closed) return;
    for (;;) {
      if (!hasCapacity(accountKey)) return;
      const index = nextEligibleIndex(accountKey);
      if (index < 0) return;
      const [waiter] = waiters.splice(index, 1);
      grantWaiter(waiter!);
    }
  };

  const enqueue = (request: ChatGptTurnQueueRequest, startedAt: number): Promise<ChatGptTurnQueueTicket> =>
    new Promise<ChatGptTurnQueueTicket>((resolve, reject) => {
      const waiter: Waiter = {
        accountKey: request.accountKey,
        callerKey: request.callerKey,
        priority: request.priority,
        enqueuedAt: startedAt,
        settled: false,
        ...(request.signal ? { signal: request.signal } : {}),
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        removeWaiter(waiter);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        recordRefusal(waiter.callerKey);
        reject(refusalFor("wait_budget_exhausted", waiter.accountKey));
      }, Math.max(1, waitBudgetMs));
      waiter.timer.unref?.();
      if (request.signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          removeWaiter(waiter);
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          reject(options.abortError(request.signal));
        };
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      insertWaiter(waiter);
      // Capacity may have become available between the fast path and the insert (another turn
      // released its lease); re-check now instead of waiting for the next release.
      pump(request.accountKey);
    });

  const snapshot = (): ChatGptTurnQueueSnapshot => {
    const perCaller = new Map<string, {
      active: number;
      depth: number;
      granted: number;
      refused: number;
      waitMsTotal: number;
      waitMsMax: number;
      lastWaitMs?: number;
    }>();
    const entryFor = (callerKey: string) => {
      let entry = perCaller.get(callerKey);
      if (!entry) {
        entry = { active: 0, depth: 0, granted: 0, refused: 0, waitMsTotal: 0, waitMsMax: 0 };
        perCaller.set(callerKey, entry);
      }
      return entry;
    };
    let active = 0;
    for (const perAccount of held.values()) {
      for (const [callerKey, entry] of perAccount) {
        active += entry.committed;
        entryFor(callerKey).active += entry.committed;
      }
    }
    for (const waiter of waiters) entryFor(waiter.callerKey).depth += 1;
    for (const [callerKey, metric] of metrics) {
      const entry = entryFor(callerKey);
      entry.granted = metric.granted;
      entry.refused = metric.refused;
      entry.waitMsTotal = metric.waitMsTotal;
      entry.waitMsMax = metric.waitMsMax;
      if (metric.lastWaitMs !== undefined) entry.lastWaitMs = metric.lastWaitMs;
    }
    const callers = [...perCaller.entries()]
      .filter(([, entry]) => entry.active > 0 || entry.depth > 0 || entry.granted > 0 || entry.refused > 0)
      .map(([caller, entry]) => ({ caller, ...entry }))
      .sort((left, right) => (
        (right.active + right.depth) - (left.active + left.depth)
        || left.caller.localeCompare(right.caller)
      ));
    return {
      capacity,
      waitBudgetMs,
      maxWaiters,
      maxPerCaller,
      retryAfterSeconds,
      depth: waiters.length,
      grants: [...grants.values()].reduce((sum, count) => sum + count, 0),
      active,
      granted: totals.granted,
      refused: totals.refused,
      waitMsTotal: totals.waitMsTotal,
      waitMsMax: totals.waitMsMax,
      ...(totals.lastWaitMs !== undefined ? { lastWaitMs: totals.lastWaitMs } : {}),
      callers,
    };
  };

  return {
    async acquire(request) {
      if (!request.accountKey) throw new TypeError("A turn queue request requires an account key");
      if (!request.callerKey) throw new TypeError("A turn queue request requires a caller key");
      if (closed) throw options.closedError();
      if (request.signal?.aborted) throw options.abortError(request.signal);
      const startedAt = Date.now();
      // Fast path: the account has room and this caller is within its fair share. The slot is granted
      // without waiting, and the caller still commits or abandons it like any other grant.
      if (hasCapacity(request.accountKey) && callerEligible(request.accountKey, request.callerKey)) {
        return grantSlot(request.accountKey, request.callerKey, request.priority, startedAt);
      }
      if (waitingFor(request.accountKey) >= maxWaiters) {
        recordRefusal(request.callerKey);
        throw refusalFor("queue_full", request.accountKey);
      }
      return await enqueue(request, startedAt);
    },
    release(ticket) {
      if (!ticket) return;
      const state = ticketStates.get(ticket);
      if (!state || state.state !== "committed") return;
      state.state = "released";
      const entry = callerHeld(state.accountKey, state.callerKey);
      entry.committed = Math.max(0, entry.committed - 1);
      pruneHeld(state.accountKey, state.callerKey, entry);
      pump(state.accountKey);
    },
    notifyReleased(accountKey) {
      pump(accountKey);
    },
    retryAfterSeconds() {
      return retryAfterSeconds;
    },
    snapshot,
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        if (waiter.settled) continue;
        waiter.settled = true;
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(options.closedError());
      }
      grants.clear();
      held.clear();
    },
  };
}
