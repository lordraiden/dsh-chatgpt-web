/**
 * Physical ChatGPT Web surface retention for managed-chrome (issue #171).
 *
 * This registry maps a stable conversationKey (defined by #170) to the one
 * physical page that carries the visible ChatGPT conversation for that DSH
 * chat. It manages only physical resources, ownership, lifetime, and mutual
 * exclusion: it never stores messages, transcripts, or session authority, and
 * it introduces no journal. A lost retained surface is reported through an
 * explicit continuity error, never by silently creating a new conversation.
 *
 * ## Bounded retention
 *
 * Retention is bounded: a registry keeps at most {@link DEFAULT_MAX_RETAINED_SURFACES} surfaces, and
 * a surface left idle beyond {@link DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS} is retired. This exists
 * because a caller that resends a *growing* history produces a new conversation identity per turn
 * (and therefore a new retained page per turn), so an unbounded registry accumulates one live
 * ChatGPT page per turn forever — and each page is a real browser document in the signed-in account.
 *
 * **Eviction is retirement, never reuse.** An evicted surface is closed and its key is tombstoned,
 * exactly like a dead page: a later turn for that conversation fails with
 * {@link RetainedSurfaceLostError} until an explicit {@link RetainedSurfaceRegistry.reset} (or an
 * explicit replay that re-establishes the conversation) clears the tombstone. A closed page is never
 * handed to a turn that expects the old one, and an evicted conversation never silently continues on
 * a fresh page as if its history were still installed.
 *
 * ## A failed turn is not a death (issue #314)
 *
 * The measured incident: a turn failed *after* its submission was accepted, and that failure retired the
 * conversation's surface, so every later turn of the session failed with `retained_surface_lost`. One
 * failed turn — a housekeeping one, in the incident — killed the user's whole session, and the rule must
 * not depend on recognising housekeeping, because this build has no reliable marker for it.
 *
 * A failed turn therefore publishes `"unreconciled"` instead of `"rejected"`: the surface stays exactly
 * where it is, physically free and reusable, and the conversation is **observable as needing
 * reconciliation** ({@link RetainedSurfaceRegistry.needsReconciliation}). The next turn of that key is the
 * bounded reconciliation attempt — it resumes the conversation in place instead of being refused — and its
 * success clears the mark. The conversation is retired only on **proof of death** (the page is closed,
 * crashed or gone, or an explicit teardown such as a cancellation) or when the bounded reconciliation
 * budget is spent ({@link DEFAULT_MAX_RETAINED_SURFACE_RECONCILIATION_ATTEMPTS}).
 *
 * Reconciliation never resends: it acquires the surface that already carries the conversation and hands it
 * to a resume turn, so a submission the provider confirmed is never repeated and a replacement
 * conversation is never created to stand in for the old one.
 *
 * ## The failure's phase decides the mark (issue #317 stage 1)
 *
 * What decides whether a failure marks a conversation is the **phase** of the failure, and the phase is
 * structural: the attempt record (below) exists exactly when the attempt's send was activated, so "did
 * this attempt reach the provider?" is read from provider state — never from the error, the prompt or a
 * timer.
 *
 * - **Post-submission** (the attempt has a record): the conversation is marked and reconciled, as above.
 *   The provider may hold output this process never observed, so nothing may be resent, and the bounded
 *   reconciliation gives the conversation up with `reconciliation-exhausted` rather than carrying it
 *   forever.
 * - **Pre-submission** (no record): ChatGPT received nothing, so there is nothing to reconcile and a
 *   retry is safe. The failure publishes `not_started` instead: the conversation is **not** marked and
 *   spends no reconciliation budget, and the pre-existing retry layer governs the retry. Marking it
 *   would spend the caller's bounded reconciliation budget on a conversation that needs none.
 *
 * ## The attempt record (issue #314 stage 3)
 *
 * Marking a conversation is not enough to resume it: the WebChat Core refuses a plain continuation
 * while the durable record's last attempt is unconfirmed, and only the provider can prove what that
 * attempt left behind. The registry therefore also carries the **attempt record**: the provider's own
 * structural snapshot of the conversation when the last attempt's send was activated
 * ({@link RetainedSurfaceRegistry.recordAttempt}). It is provider-opaque — the registry stores it and
 * never interprets it, exactly as it stores a page without interpreting a conversation — and it is
 * what the provider's reconciliation probe reads back to decide whether the retained conversation
 * still holds the attempt's reply. The registry owns only its lifetime: a new attempt invalidates the
 * previous record (the acquire that starts it), and it dies with the entry that carries it.
 *
 * The registry is generic over the concrete page type so callers keep their
 * full page capability (e.g. Playwright `Page`) without a widening cast, and over the attempt record
 * so a provider keeps its own structural type without a cast or an untyped payload.
 */
import { createHash } from "node:crypto";

/** The only page capabilities the registry needs; Playwright Page satisfies it. */
export interface RetainedSurfacePage {
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * How many retained surfaces one registry keeps before the least-recently-used one is retired.
 *
 * The bound deliberately sits above the provider's concurrent-turn ceiling (five simultaneous
 * browser turns per authenticated account), so eviction can only ever touch a surface that no turn
 * is using: the live fan-out alone can never reach this cap. Each retained surface is a real
 * browser document in the signed-in account, so the cap is what keeps a long-lived process from
 * accumulating one page per caller identity.
 */
export const DEFAULT_MAX_RETAINED_SURFACES = 16;
/**
 * How long a retained surface may sit idle before it is retired.
 *
 * Thirty minutes: long enough that a normal pause inside one chat (reading, thinking, a short
 * interruption) never costs the physical conversation, and short enough that an abandoned chat
 * releases its ChatGPT page within one working session. The next turn for a retired key needs an
 * explicit replay, which is the documented recovery the no-silent-fork contract requires.
 */
export const DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS = 30 * 60_000;
/**
 * How many turns may carry an unreconciled conversation before the bounded reconciliation gives up.
 *
 * The bound is what keeps "a failure is not a death" from becoming "a conversation can never be
 * retired": a marked conversation is still handed to the next turn, but a key that reaches this many
 * carried failures is retired instead, with the honest continuity-loss error, rather than being handed
 * out for a fourth attempt. Three is deliberately above one — the single housekeeping failure that
 * motivated the rule consumes none of the caller's own turns — and it is the same shape as the
 * provider's other bounded retry budgets (page rebinds, tolerated observation faults).
 */
export const DEFAULT_MAX_RETAINED_SURFACE_RECONCILIATION_ATTEMPTS = 3;

/** Why one retained surface was retired. */
export type RetainedSurfaceEvictionReason = "idle-timeout" | "over-capacity";

/**
 * Why a conversation is now a continuity loss, when the operation that decided the retirement can
 * express it (issue #314).
 *
 * The tombstone itself still records only that continuity is broken — it is not a journal — so this is
 * published by the decision that retired the surface, on the error the caller receives at that moment.
 * It keeps "the page is physically gone" apart from "the bounded reconciliation budget is spent".
 */
export type RetainedSurfaceLossReason = "surface-dead" | "reconciliation-exhausted";

/**
 * What a finished turn publishes about the operation that held the surface.
 *
 * `"unreconciled"` is the failed-turn settlement (issue #314): the operation ended, but what happened to
 * the conversation's remote generation is unknown, so the surface stays in place and the conversation is
 * marked for reconciliation instead of being retired.
 *
 * `"not_started"` is the same failure in its pre-submission phase (issue #317 stage 1): the operation
 * never reached the provider, so the surface is reusable, the conversation is not marked and no
 * reconciliation budget is spent — a retry is safe and there is nothing to reconcile.
 */
export type RetainedSurfaceSettlementOutcome =
  | "fulfilled"
  | "not_started"
  | "pending"
  | "rejected"
  | "unreconciled";

/** How a finished turn ended, as the retained-surface owner reads it (issue #314). */
export type RetainedSurfaceTurnEnd = "completed" | "failed" | "torn-down";

/**
 * Whether a failed turn's submission was confirmed, as the retained-surface owner reads it (issue #317
 * stage 1).
 *
 * `"confirmed"` means the attempt's send was activated — the stage-3 attempt record exists for it — so
 * ChatGPT may hold output this process never observed. `"unconfirmed"` means the attempt never reached
 * ChatGPT, so there is nothing to reconcile and a retry is safe.
 *
 * It is a closed structural fact, and it is never derived from the failure's message, the caller's
 * prompt, a timer, or any other heuristic. It is required at every call site for exactly that reason: a
 * caller cannot leave the phase to a default and accidentally classify a failure by omission.
 */
export type RetainedSurfaceSubmissionPhase = "confirmed" | "unconfirmed";

/**
 * The settlement a finished turn publishes about the retained surface it held (issue #314).
 *
 * - `completed` — the turn reached its answer, so the conversation is settled and the reconciliation
 *   mark (if any) is cleared.
 * - `failed` — the turn ran and errored, and *the phase decides what that means* (issue #317 stage 1).
 *   Post-submission (`confirmed`) a failure is not a death: the surface stays where it is and the
 *   conversation becomes observable as needing reconciliation, so the next turn of the same key resumes
 *   it instead of being refused as a lost surface. Nothing is resent; a later start-over has to be an
 *   explicit decision taken by the turn's own continuity path. Pre-submission (`unconfirmed`) nothing
 *   reached the provider: the conversation is not marked and spends no reconciliation budget.
 * - `torn-down` — the turn was ended by an explicit teardown (caller cancellation, a closed tab, the
 *   service retiring a wedged turn, or a page whose document was replaced by a rehydration). The
 *   explicit-teardown contract is kept: no settlement was published for the operation, so the surface is
 *   retired rather than trusted again, whatever the phase.
 *
 * @param end - how the turn ended.
 * @param submission - whether that turn's attempt confirmed a submission; see
 *   {@link RetainedSurfaceSubmissionPhase}.
 * @returns the settlement the surface owner publishes.
 */
export function retainedSurfaceSettlementForTurn(
  end: RetainedSurfaceTurnEnd,
  submission: RetainedSurfaceSubmissionPhase,
): RetainedSurfaceSettlementOutcome {
  switch (end) {
    case "completed":
      return "fulfilled";
    case "torn-down":
      return "rejected";
    case "failed":
      // The phase decides a failure; nothing else does (issue #317 stage 1). Post-submission the
      // provider may hold output this process never saw, so the conversation is marked and reconciled —
      // and never resent. Pre-submission nothing reached the provider, so marking it would spend the
      // caller's reconciliation budget on a conversation that needs none: it settles as `not_started`.
      return submission === "confirmed" ? "unreconciled" : "not_started";
  }
}

/** What one eviction did, for tests and for the caller's diagnostics. */
export interface RetainedSurfaceEviction<P extends RetainedSurfacePage> {
  /** The conversation whose surface was retired; its key is tombstoned. */
  readonly conversationKey: string;
  readonly reason: RetainedSurfaceEvictionReason;
  readonly page: P;
  /** Settlement of the operation that last held it was proven, so the page was free to close. */
  readonly settled: boolean;
}

/** Construction options for {@link RetainedSurfaceRegistry}. */
export interface RetainedSurfaceRegistryOptions {
  /** Retention cap; see {@link DEFAULT_MAX_RETAINED_SURFACES}. */
  readonly maxSurfaces?: number;
  /** Idle retirement window; see {@link DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number;
  /**
   * How many turns may carry an unreconciled conversation before it is retired instead of reused;
   * see {@link DEFAULT_MAX_RETAINED_SURFACE_RECONCILIATION_ATTEMPTS}.
   */
  readonly maxReconciliationAttempts?: number;
  /** Clock seam; tests inject one so idle expiry needs no real time. */
  readonly now?: () => number;
}

export interface RetainedSurfaceAcquired<P extends RetainedSurfacePage> {
  page: P;
  /** True when this turn created the surface; false when it reuses an existing one. */
  created: boolean;
  /**
   * True when this acquire is the bounded reconciliation attempt of a conversation whose previous turn
   * failed (issue #314). The caller is resuming the retained conversation — never creating one and never
   * resending a submission the provider already confirmed.
   */
  reconciling: boolean;
}

export interface RetainedSurfaceAcquireOptions<P extends RetainedSurfacePage> {
  /**
   * The turn requires a pre-existing retained surface (e.g. the compaction
   * handoff). When no surface exists for the key this fails explicitly
   * instead of creating one.
   */
  required: boolean;
  /** Creates the surface for the first turn of the conversation. */
  create: () => Promise<P>;
  /**
   * This turn IS the explicit recovery of a retired key: the caller has already decided to
   * re-establish the conversation from canonical history (a replay), so clearing the tombstone is
   * that decision, taken here, instead of an implicit fallback.
   *
   * Defaults to false. Without it a retired key keeps failing with
   * {@link RetainedSurfaceLostError}, so an eviction can never be mistaken for "the conversation is
   * still there, just somewhere else".
   */
  acceptRetired?: boolean;
}

/** A required retained surface does not exist for the conversation key. */
export class RetainedSurfaceMissingError extends Error {
  constructor(conversationKey: string) {
    super(`The retained ChatGPT conversation for ${conversationKey} does not exist`);
    this.name = "RetainedSurfaceMissingError";
  }
}

/** A previously retained surface died, breaking conversation continuity. */
export class RetainedSurfaceLostError extends Error {
  /**
   * Why the continuity was declared lost, when the retiring operation could express it (issue #314):
   * the physical page was gone, or the bounded reconciliation budget was spent.
   */
  readonly reason?: RetainedSurfaceLossReason;

  constructor(conversationKey: string, reason?: RetainedSurfaceLossReason) {
    super(`The retained ChatGPT conversation for ${conversationKey} was lost${reason ? ` (${reason})` : ""}`);
    this.name = "RetainedSurfaceLostError";
    this.reason = reason;
  }
}

/** Another turn already owns the retained surface for the conversation key. */
export class RetainedSurfaceBusyError extends Error {
  constructor(conversationKey: string) {
    super(`Another turn is already using the retained ChatGPT conversation for ${conversationKey}`);
    this.name = "RetainedSurfaceBusyError";
  }
}

/**
 * The non-secret identity of one conversation in the eviction log.
 *
 * The same 12-hex-character SHA-256 prefix the execution trace uses. A conversation key is derived
 * from session and thread identities, so the raw value must never reach a log line; the digest is
 * stable within one process, which is all an operator needs to correlate an eviction with a chat.
 */
function retainedSurfaceDigest(conversationKey: string): string {
  return createHash("sha256").update(conversationKey).digest("hex").slice(0, 12);
}

interface RetainedSurfaceEntry<P extends RetainedSurfacePage, R> {
  page: P;
  busy: boolean;
  /**
   * Whether the physical settlement of the last holder has been published.
   *
   * A resource that may still produce output must not be reused (architecture §9.3, §15.3): a turn
   * that released the surface without settling it leaves the key unavailable for reuse until `settle`
   * says what happened, and only an explicit settlement — or an explicit loss — makes it reusable.
   */
  settled: boolean;
  /**
   * When the surface last became idle (or was created). Retention ages a surface from here, never
   * from whichever wall-clock moment a sweep happens to run: the idle window measures how long the
   * caller has left the conversation alone, not how long the registry has existed.
   */
  lastUsedAt: number;
  /**
   * Bounded reconciliation state of a conversation whose last turn failed (issue #314).
   *
   * Present while the conversation is observable as needing reconciliation; `attempts` counts the
   * reconciliation turns already handed the surface. A turn that settles the conversation successfully
   * removes the state, and the state never retires the surface by itself — only the exhausted budget
   * does, at the acquire that would carry it beyond the bound.
   */
  reconciliation?: { attempts: number };
  /**
   * The provider's structural record of the last attempt that was submitted through this surface
   * (issue #314 stage 3).
   *
   * Provider-opaque: written by the provider turn when the attempt's send is activated and read back
   * by the provider's reconciliation probe. It never holds a message: it is what the conversation
   * *held* (its structural state), not what was said. The registry owns only its lifetime — a new
   * attempt clears it ({@link RetainedSurfaceRegistry.acquire}), and it goes with the entry.
   */
  attempt?: R;
}

export class RetainedSurfaceRegistry<
  P extends RetainedSurfacePage = RetainedSurfacePage,
  R = unknown,
> {
  private readonly surfaces = new Map<string, RetainedSurfaceEntry<P, R>>();
  private readonly maxSurfaces: number;
  private readonly idleTimeoutMs: number;
  private readonly maxReconciliationAttempts: number;
  private readonly now: () => number;
  /**
   * In-flight first creations, per key. A key that is being created is busy,
   * so a second acquire of the same key fails with RetainedSurfaceBusyError
   * instead of starting a second creation. The marker is cleared as soon as
   * the creation settles (success or failure); it stores no conversation
   * state beyond the physical creation itself.
   */
  private readonly pendingCreates = new Set<string>();
  /**
   * Lost surfaces, per key. When a retained page dies the key is tombstoned:
   * every later acquire fails with RetainedSurfaceLostError until an explicit
   * `reset` restores the key. This is the explicit continuity-loss policy for
   * issue #171 — a lost surface never degrades into a silently created new
   * conversation. The tombstone records only that continuity is broken, not
   * what happened; it is not a journal.
   */
  private readonly lostSurfaces = new Set<string>();

  constructor(options: RetainedSurfaceRegistryOptions = {}) {
    const maxSurfaces = options.maxSurfaces ?? DEFAULT_MAX_RETAINED_SURFACES;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS;
    const maxReconciliationAttempts = options.maxReconciliationAttempts
      ?? DEFAULT_MAX_RETAINED_SURFACE_RECONCILIATION_ATTEMPTS;
    if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1) {
      throw new TypeError("The retained-surface cap must be a positive safe integer");
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new TypeError("The retained-surface idle timeout must be a positive finite number of milliseconds");
    }
    if (!Number.isSafeInteger(maxReconciliationAttempts) || maxReconciliationAttempts < 1) {
      throw new TypeError("The retained-surface reconciliation budget must be a positive safe integer");
    }
    this.maxSurfaces = maxSurfaces;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxReconciliationAttempts = maxReconciliationAttempts;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.surfaces.size;
  }

  has(conversationKey: string): boolean {
    return this.surfaces.has(conversationKey);
  }

  /** True when the key's continuity is broken until an explicit reset. */
  isLost(conversationKey: string): boolean {
    return this.lostSurfaces.has(conversationKey);
  }

  /**
   * True when the conversation's last turn failed **after its submission was confirmed** and the
   * surface is still in place (issues #314, #317).
   *
   * This is the explicit, observable "needs reconciliation" state: the physical conversation was kept,
   * and the next acquire for this key is the bounded reconciliation attempt that clears it on success.
   * It is not a continuity loss and it does not refuse anything. A turn that failed *before* its
   * submission was confirmed never reaches this state: nothing was sent, so there is nothing to
   * reconcile (issue #317 stage 1).
   */
  needsReconciliation(conversationKey: string): boolean {
    return this.surfaces.get(conversationKey)?.reconciliation !== undefined;
  }

  /**
   * Record the provider's structural snapshot of the attempt that is being submitted through this
   * surface (issue #314 stage 3).
   *
   * The payload is provider-opaque and never holds a message: it is what the conversation *held*
   * when the attempt's send was activated, which is what lets the provider's reconciliation probe
   * decide, structurally, whether the attempt's reply is present. The write is a no-op for a key with
   * no retained surface, and {@link acquire} clears the record when the next attempt starts.
   */
  recordAttempt(conversationKey: string, record: R): void {
    const entry = this.surfaces.get(conversationKey);
    if (entry) entry.attempt = record;
  }

  /** The recorded attempt of this conversation, when one was submitted through it. */
  attemptRecord(conversationKey: string): R | undefined {
    return this.surfaces.get(conversationKey)?.attempt;
  }

  /**
   * Whether the attempt that last ran through this conversation confirmed its submission (issue #317
   * stage 1).
   *
   * This is the **structural phase fact** the settlement rule reads, and it is the attempt record's own
   * presence: {@link recordAttempt} writes the record at send activation, and {@link acquire} clears the
   * previous attempt's record when the next attempt starts — so a surface with no record is one whose
   * last attempt never reached the provider. It is never derived from a message, a timer, or the
   * failure's own error.
   *
   * A key with no retained surface answers `false`: nothing was submitted through this process's
   * surface, which is the same statement the record's absence makes, and the safe one — it cannot mark a
   * conversation this process never submitted to.
   */
  submissionConfirmed(conversationKey: string): boolean {
    return this.surfaces.get(conversationKey)?.attempt !== undefined;
  }

  /**
   * The retained page for one read-only inspection (issue #314 stage 3), or `undefined` when it must
   * not be read: the key is not retained, a turn holds it, its settlement is unpublished, or the page
   * is closed.
   *
   * This never acquires, settles or retires anything. A caller that needs proof about a conversation
   * reads it through here so that reading a page another turn owns — or a page whose operation may
   * still produce output — is impossible by construction.
   */
  inspectablePage(conversationKey: string): P | undefined {
    const entry = this.surfaces.get(conversationKey);
    if (!entry || entry.busy || !entry.settled) return undefined;
    return entry.page.isClosed() ? undefined : entry.page;
  }

  /**
   * Explicit recovery action for a lost key: continuity may start again. The
   * only way to clear a tombstone; there is no implicit fallback.
   */
  reset(conversationKey: string): void {
    this.lostSurfaces.delete(conversationKey);
  }

  /**
   * Acquire the retained surface for one turn. The surface stays busy until
   * `release` is called, so two turns of the same conversationKey can never
   * share a page concurrently. A dead stored page is tombstoned and reported
   * as a continuity loss; it is never replaced silently.
   *
   * A successful acquire also enforces bounded retention (see the module comment): acquiring the
   * surface is the moment retention is eligible to change, so the idle sweep and the cap live here
   * rather than on a real timer. The cap is checked before the page is created, so the registry never
   * grows past it on the way to a new conversation.
   */
  async acquire(
    conversationKey: string,
    options: RetainedSurfaceAcquireOptions<P>,
  ): Promise<RetainedSurfaceAcquired<P>> {
    if (this.lostSurfaces.has(conversationKey) && options.acceptRetired !== true) {
      // A tombstoned key stays a continuity loss even for a `required` turn: the caller has to know
      // the conversation is broken, not merely missing (issue #171 contract, kept unchanged).
      throw new RetainedSurfaceLostError(conversationKey);
    }
    const existing = this.surfaces.get(conversationKey);
    if (existing) {
      if (existing.busy) throw new RetainedSurfaceBusyError(conversationKey);
      if (existing.page.isClosed()) {
        // A dead page is a continuity loss whatever its settlement state, so this is decided first.
        // This is proof of death, which is what makes retirement honest here (issue #314).
        this.retireWithLoss(conversationKey, existing, "surface-dead");
        throw new RetainedSurfaceLostError(conversationKey, "surface-dead");
      }
      if (!existing.settled) {
        // A surface that was released without a published settlement may still produce output: it is
        // retained, but it is not handed to another turn (architecture §9.3, §15.3).
        throw new RetainedSurfaceBusyError(conversationKey);
      }
      // Bounded reconciliation (issue #314): a conversation whose previous turn failed is handed to this
      // turn as its reconciliation attempt, until the attempt budget is spent. Only the spent budget
      // retires it — never the earlier turn's failure, which is why one failure no longer ends a session.
      const reconciliation = existing.reconciliation;
      if (reconciliation && reconciliation.attempts >= this.maxReconciliationAttempts) {
        this.retireWithLoss(conversationKey, existing, "reconciliation-exhausted");
        throw new RetainedSurfaceLostError(conversationKey, "reconciliation-exhausted");
      }
      if (reconciliation) reconciliation.attempts += 1;
      // This acquire is the next attempt of the conversation, so the previous attempt's structural
      // record no longer describes the last submission: it is cleared here, before the new attempt
      // takes the page (issue #314 stage 3). A conversation whose surface was reused without a new
      // activation therefore has no record, which is exactly "nothing was submitted since".
      delete existing.attempt;
      existing.busy = true;
      this.touch(conversationKey, existing);
      return { page: existing.page, created: false, reconciling: reconciliation !== undefined };
    }
    if (this.pendingCreates.has(conversationKey)) {
      throw new RetainedSurfaceBusyError(conversationKey);
    }
    if (options.required) throw new RetainedSurfaceMissingError(conversationKey);
    // Room is made BEFORE the surface is created: a registry at its cap retires the surface that is
    // both least recently used and safe to retire. When only a surface with an active turn or an
    // unpublished settlement stands in the way, this refuses explicitly instead of closing a page
    // that may still produce output — the condition stays visible rather than being swallowed.
    if (this.surfaces.size >= this.maxSurfaces) {
      this.reclaimFor(conversationKey);
      if (this.surfaces.size >= this.maxSurfaces) throw new RetainedSurfaceBusyError(conversationKey);
    }
    // This acquire is the explicit recovery of a retired key (the caller asked for it), or the key
    // was never retired. Either way the regression is behind us: the tombstone is cleared so the
    // re-established conversation starts from a clean continuity state.
    this.lostSurfaces.delete(conversationKey);
    // Claim the key before the (awaitable) creation so a concurrent acquire of the
    // same key is rejected while the first surface is being created. The marker is
    // always cleared, on success and on failure, so a failed creation never leaves
    // the key permanently busy and a later attempt can create normally.
    this.pendingCreates.add(conversationKey);
    try {
      const page = await options.create();
      if (page.isClosed()) {
        this.surfaces.delete(conversationKey);
        throw new RetainedSurfaceLostError(conversationKey);
      }
      this.surfaces.set(conversationKey, {
        page,
        busy: true,
        settled: true,
        lastUsedAt: this.now(),
      });
      // The new surface is not a candidate for its own pass, so this only reclaims surfaces that have
      // gone idle while the registry was busy; it is what returns the registry to its cap.
      this.sweep(conversationKey);
      return { page, created: true, reconciling: false };
    } finally {
      this.pendingCreates.delete(conversationKey);
    }
  }

  /**
   * Drop the busy flag at the end of a turn; the surface stays retained.
   *
   * The key becomes *settling*: still retained, but not reusable for a later turn until `settle`
   * publishes what happened to the operation that was using it.
   */
  release(conversationKey: string): void {
    const entry = this.surfaces.get(conversationKey);
    if (entry) {
      entry.busy = false;
      entry.settled = false;
      this.touch(conversationKey, entry);
    }
  }

  /**
   * Publish the physical settlement of the operation that held this surface.
   *
   * `fulfilled`/`not_started` make the retained surface reusable again and clear any reconciliation mark;
   * `pending` keeps it settling; `rejected` means settlement could not be proven, so the surface is
   * dropped and the key tombstoned instead of being trusted again (an explicit `reset` is the only way
   * back); `unreconciled` is the failed-turn settlement (issue #314): the operation is over, so the
   * surface is reusable, but the conversation's remote outcome is unknown and it becomes observable as
   * needing reconciliation instead of being retired. No settlement path resends anything.
   *
   * `not_started` and `unreconciled` are the two phases of one failure (issue #317 stage 1): the
   * classification happens where the turn's end is read ({@link retainedSurfaceSettlementForTurn}), and
   * both are reusable settlements — the difference is that a confirmed submission leaves the
   * reconciliation mark while a pre-submission failure clears it, because there is nothing to reconcile.
   *
   * `reason` names why a `rejected` settlement declared the loss, when the operation that decided it
   * can express one (issue #314): the page is physically gone, or the bounded reconciliation could not
   * prove the conversation. It is published on the error the caller receives at that moment; the
   * tombstone itself still records only that continuity is broken.
   */
  settle(
    conversationKey: string,
    outcome: RetainedSurfaceSettlementOutcome = "fulfilled",
    reason?: RetainedSurfaceLossReason,
  ): void {
    const entry = this.surfaces.get(conversationKey);
    if (!entry) return;
    if (outcome === "rejected") {
      this.retireWithLoss(conversationKey, entry, reason);
      return;
    }
    if (outcome === "unreconciled") {
      if (entry.page.isClosed()) {
        // The page died during the turn: that is proof of death, so the conversation is retired instead
        // of being marked as reconcilable (issue #314).
        this.retireWithLoss(conversationKey, entry, "surface-dead");
        return;
      }
      entry.settled = true;
      // The first failed turn opens the mark; a failed reconciliation attempt keeps the attempts it has
      // already consumed, so the budget counts consecutive carries, not failures inside one carry.
      entry.reconciliation ??= { attempts: 0 };
      this.touch(conversationKey, entry);
      return;
    }
    entry.settled = outcome !== "pending";
    // A published settlement that proved the operation reconciles the conversation: the mark is cleared.
    if (entry.settled) delete entry.reconciliation;
    this.touch(conversationKey, entry);
  }

  /**
   * Retire every surface idle beyond the timeout.
   *
   * A surface with an active turn (`busy`) or an unpublished settlement is never retired: it may
   * still produce output, so closing its page is not safe (architecture §9.3, §15.3). When an
   * over-capacity acquire is blocked by exactly such a surface, {@link acquire} refuses explicitly
   * with {@link RetainedSurfaceBusyError}; the condition stays visible instead of being swallowed.
   *
   * Called before a creation that would exceed the cap and after every successful acquire, and public
   * so a long-lived owner can enforce the idle window on its own schedule (never on a real timer this
   * class owns — a timer would make the behaviour untestable with an injected clock).
   *
   * @param currentConversationKey - the key just acquired, which this pass never retires.
   * @returns the evictions performed, oldest first.
   */
  sweep(currentConversationKey?: string): RetainedSurfaceEviction<P>[] {
    const evictions: RetainedSurfaceEviction<P>[] = [];
    const idleCutoff = this.now() - this.idleTimeoutMs;
    for (const [conversationKey, entry] of this.surfaces) {
      if (conversationKey === currentConversationKey) continue;
      if (entry.lastUsedAt <= idleCutoff) {
        this.retire(conversationKey, "idle-timeout", evictions);
      }
    }
    return evictions;
  }

  /**
   * Make room for one new surface at the cap.
   *
   * Retires the least-recently-used surface that is safe to retire; the registry's insertion order is
   * its LRU order, because every acquire and every release moves a key to the back (see
   * {@link touch}). A candidate is skipped, never closed, while a turn holds it or its settlement is
   * still unpublished — that is what makes an over-capacity acquire refuse rather than close a page
   * that may still produce output.
   *
   * This is deliberately NOT the idle sweep: room has to be made whether or not the oldest surface
   * has reached the idle window yet, because the registry may not grow past its cap.
   *
   * @param incomingConversationKey - the key asking for room; it is never itself retired.
   * @returns the evictions performed, or an empty list when nothing could be safely retired.
   */
  private reclaimFor(incomingConversationKey: string): RetainedSurfaceEviction<P>[] {
    const evictions: RetainedSurfaceEviction<P>[] = [];
    for (const conversationKey of [...this.surfaces.keys()]) {
      // One slot has to be free for the incoming surface, so stop once the registry is below its cap.
      if (this.surfaces.size < this.maxSurfaces) break;
      if (conversationKey === incomingConversationKey) continue;
      this.retire(conversationKey, "over-capacity", evictions);
    }
    return evictions;
  }

  /**
   * Retire one surface: close its page once and tombstone its key.
   *
   * Eviction is retirement, never reuse: the key is tombstoned exactly like a dead page, so no later
   * turn can be handed this surface and nothing silently creates a replacement for it.
   */
  private retire(
    conversationKey: string,
    reason: RetainedSurfaceEvictionReason,
    evictions: RetainedSurfaceEviction<P>[],
  ): void {
    const entry = this.surfaces.get(conversationKey);
    if (!entry || !this.isEvictable(conversationKey)) return;
    this.surfaces.delete(conversationKey);
    this.lostSurfaces.add(conversationKey);
    console.info(
      `[chatgpt-web] retained surface evicted key=${retainedSurfaceDigest(conversationKey)}`
      + ` reason=${reason} settlement=${entry.settled ? "proven" : "unproven"}`,
    );
    evictions.push({ conversationKey, reason, page: entry.page, settled: entry.settled });
    void entry.page.close().catch(() => {});
  }

  /**
   * Retire one surface because its continuity is broken: tombstone its key and close its page once.
   *
   * This is the *evidence* path, not the eviction path — a dead page, a settlement that could not be
   * proven, or a spent reconciliation budget — so it deliberately does not consult the eviction guard:
   * a surface whose continuity is broken must not be handed out again even while a turn still holds it
   * (issue #314). A page that has already reported itself closed is not closed a second time.
   */
  private retireWithLoss(
    conversationKey: string,
    entry: RetainedSurfaceEntry<P, R>,
    reason: RetainedSurfaceLossReason | undefined,
  ): void {
    this.surfaces.delete(conversationKey);
    this.lostSurfaces.add(conversationKey);
    if (reason !== undefined) {
      console.info(
        `[chatgpt-web] retained surface retired key=${retainedSurfaceDigest(conversationKey)} reason=${reason}`,
      );
    }
    if (!entry.page.isClosed()) void entry.page.close().catch(() => {});
  }

  /** Move a key to the back of the LRU order (the Map's insertion order). */
  private touch(conversationKey: string, entry: RetainedSurfaceEntry<P, R>): void {
    entry.lastUsedAt = this.now();
    this.surfaces.delete(conversationKey);
    this.surfaces.set(conversationKey, entry);
  }

  /**
   * Whether this surface may be retired without endangering an operation.
   *
   * Both conditions are the settlement rule read literally: no turn holds it, and the operation that
   * last held it published a settlement (so nothing is still producing output).
   */
  private isEvictable(conversationKey: string): boolean {
    const entry = this.surfaces.get(conversationKey);
    return entry !== undefined && !entry.busy && entry.settled;
  }

  /**
   * Whether this surface may be handed to a later turn.
   *
   * Retained, not held by an operation in flight, and physically settled. `has()` keeps its
   * pre-existing meaning ("retained") and `acquire` keeps its pre-existing behaviour, because the
   * reuse decision belongs to the caller that owns the turn: it asks this instead of `has()`.
   */
  isReusable(conversationKey: string): boolean {
    const entry = this.surfaces.get(conversationKey);
    return entry !== undefined && entry.settled && !entry.busy;
  }

  /** Remove and close one retained surface. */
  async invalidate(conversationKey: string): Promise<void> {
    const entry = this.surfaces.get(conversationKey);
    if (!entry) return;
    this.surfaces.delete(conversationKey);
    await entry.page.close().catch(() => {});
  }

  /** Shutdown path: release every retained surface and clear every tombstone. */
  async closeAll(): Promise<void> {
    const entries = [...this.surfaces.values()];
    this.surfaces.clear();
    this.lostSurfaces.clear();
    await Promise.all(entries.map(entry => entry.page.close().catch(() => {})));
  }
}
