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
 * The registry is generic over the concrete page type so callers keep their
 * full page capability (e.g. Playwright `Page`) without a widening cast.
 */

/** The only page capabilities the registry needs; Playwright Page satisfies it. */
export interface RetainedSurfacePage {
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface RetainedSurfaceAcquired<P extends RetainedSurfacePage> {
  page: P;
  /** True when this turn created the surface; false when it reuses an existing one. */
  created: boolean;
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
  constructor(conversationKey: string) {
    super(`The retained ChatGPT conversation for ${conversationKey} was lost`);
    this.name = "RetainedSurfaceLostError";
  }
}

/** Another turn already owns the retained surface for the conversation key. */
export class RetainedSurfaceBusyError extends Error {
  constructor(conversationKey: string) {
    super(`Another turn is already using the retained ChatGPT conversation for ${conversationKey}`);
    this.name = "RetainedSurfaceBusyError";
  }
}

interface RetainedSurfaceEntry<P extends RetainedSurfacePage> {
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
}

export class RetainedSurfaceRegistry<P extends RetainedSurfacePage = RetainedSurfacePage> {
  private readonly surfaces = new Map<string, RetainedSurfaceEntry<P>>();
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
   */
  async acquire(
    conversationKey: string,
    options: RetainedSurfaceAcquireOptions<P>,
  ): Promise<RetainedSurfaceAcquired<P>> {
    if (this.lostSurfaces.has(conversationKey)) {
      throw new RetainedSurfaceLostError(conversationKey);
    }
    const existing = this.surfaces.get(conversationKey);
    if (existing) {
      if (existing.busy) throw new RetainedSurfaceBusyError(conversationKey);
      if (existing.page.isClosed()) {
        // A dead page is a continuity loss whatever its settlement state, so this is decided first.
        this.surfaces.delete(conversationKey);
        this.lostSurfaces.add(conversationKey);
        throw new RetainedSurfaceLostError(conversationKey);
      }
      if (!existing.settled) {
        // A surface that was released without a published settlement may still produce output: it is
        // retained, but it is not handed to another turn (architecture §9.3, §15.3).
        throw new RetainedSurfaceBusyError(conversationKey);
      }
      existing.busy = true;
      return { page: existing.page, created: false };
    }
    if (this.pendingCreates.has(conversationKey)) {
      throw new RetainedSurfaceBusyError(conversationKey);
    }
    if (options.required) throw new RetainedSurfaceMissingError(conversationKey);
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
      this.surfaces.set(conversationKey, { page, busy: true, settled: true });
      return { page, created: true };
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
    }
  }

  /**
   * Publish the physical settlement of the operation that held this surface.
   *
   * `fulfilled`/`not_started` make the retained surface reusable again and `pending` keeps it
   * settling; `rejected` means settlement could not be proven, so the surface is dropped and the key
   * tombstoned instead of being trusted again (an explicit `reset` is the only way back).
   */
  settle(conversationKey: string, outcome: "fulfilled" | "not_started" | "pending" | "rejected" = "fulfilled"): void {
    const entry = this.surfaces.get(conversationKey);
    if (!entry) return;
    if (outcome === "rejected") {
      this.surfaces.delete(conversationKey);
      this.lostSurfaces.add(conversationKey);
      void entry.page.close().catch(() => {});
      return;
    }
    entry.settled = outcome !== "pending";
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
