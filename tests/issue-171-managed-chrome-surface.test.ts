import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_RETAINED_SURFACES,
  DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS,
  RetainedSurfaceBusyError,
  RetainedSurfaceLostError,
  RetainedSurfaceMissingError,
  RetainedSurfaceRegistry,
  type RetainedSurfacePage,
} from "../src/adapters/chatgpt-web/retained-surface";
import {
  MAX_CHATGPT_BROWSER_TABS,
  ChatGptSuspensionClock,
  attachRetainedSurfaceIdleSweep,
  chatGptEffortSelectionRequired,
} from "../src/adapters/chatgpt-web/browser-worker";

/** Minimal stand-in for a Playwright Page: only the registry's two capabilities. */
function fakePage(name: string): RetainedSurfacePage & { name: string; closeCount: number; markClosed: () => void } {
  let closed = false;
  const page: RetainedSurfacePage & { name: string; closeCount: number; markClosed: () => void } = {
    name,
    closeCount: 0,
    isClosed: () => closed,
    close: async () => {
      closed = true;
      page.closeCount += 1;
    },
    // Test hook: simulate the page dying outside the registry's control.
    markClosed: () => {
      closed = true;
    },
  };
  return page;
}

describe("issue #171 managed-chrome retained surface registry", () => {
  test("first turn creates a surface for the conversationKey", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    const acquired = await registry.acquire("key-a", {
      required: false,
      create: async () => page,
    });
    expect(acquired.created).toBe(true);
    expect(acquired.page).toBe(page);
    expect(registry.has("key-a")).toBe(true);
  });

  test("second turn with the same conversationKey reuses exactly that surface", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    const reused = await registry.acquire("key-a", {
      required: false,
      create: async () => fakePage("page-should-not-be-used"),
    });
    expect(reused.created).toBe(false);
    expect(reused.page).toBe(page);
  });

  test("two distinct conversationKeys do not share a surface", async () => {
    const registry = new RetainedSurfaceRegistry();
    const pageA = fakePage("page-a");
    const pageB = fakePage("page-b");
    const a = await registry.acquire("key-a", { required: false, create: async () => pageA });
    const b = await registry.acquire("key-b", { required: false, create: async () => pageB });
    expect(a.page).not.toBe(b.page);
    expect(registry.has("key-a")).toBe(true);
    expect(registry.has("key-b")).toBe(true);
  });

  test("a retained surface is not closed after a normal turn", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    // End of the normal turn: release clears the busy flag but keeps the page.
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    expect(registry.has("key-a")).toBe(true);
    expect(page.isClosed()).toBe(false);
    expect(page.closeCount).toBe(0);
  });

  test("a lost surface is explicit, tombstoned, and never degrades into a silent new conversation", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    // The page dies outside the registry's control.
    page.markClosed();
    await expect(registry.acquire("key-a", {
      required: false,
      create: async () => fakePage("page-fresh"),
    })).rejects.toBeInstanceOf(RetainedSurfaceLostError);
    // The dead entry is gone and the key is tombstoned: continuity is broken.
    expect(registry.has("key-a")).toBe(false);
    expect(registry.isLost("key-a")).toBe(true);
    // A later turn of the same key fails explicitly — it must NOT create a new
    // conversation silently, even with a create function available.
    await expect(registry.acquire("key-a", {
      required: false,
      create: async () => fakePage("page-quiet"),
    })).rejects.toBeInstanceOf(RetainedSurfaceLostError);
    expect(registry.has("key-a")).toBe(false);
    // Only an explicit reset restores the key; then a new continuity may start.
    registry.reset("key-a");
    const fresh = fakePage("page-reset");
    const next = await registry.acquire("key-a", { required: false, create: async () => fresh });
    expect(next.created).toBe(true);
    expect(next.page).toBe(fresh);
    expect(registry.isLost("key-a")).toBe(false);
  });

  test("shutdown clears retained surfaces and tombstones", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    page.markClosed();
    await expect(registry.acquire("key-a", { required: false, create: async () => fakePage("x") }))
      .rejects.toBeInstanceOf(RetainedSurfaceLostError);
    expect(registry.isLost("key-a")).toBe(true);
    await registry.closeAll();
    expect(registry.isLost("key-a")).toBe(false);
  });

  test("a required surface that does not exist fails explicitly", async () => {
    const registry = new RetainedSurfaceRegistry();
    await expect(registry.acquire("key-missing", {
      required: true,
      create: async () => fakePage("page-1"),
    })).rejects.toBeInstanceOf(RetainedSurfaceMissingError);
  });

  test("a required surface on a tombstoned key fails as a continuity loss", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    page.markClosed();
    await expect(registry.acquire("key-a", { required: false, create: async () => fakePage("x") }))
      .rejects.toBeInstanceOf(RetainedSurfaceLostError);
    await expect(registry.acquire("key-a", { required: true, create: async () => fakePage("y") }))
      .rejects.toBeInstanceOf(RetainedSurfaceLostError);
  });

  test("mutual exclusion: a second turn on the same key is rejected while busy", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    // The first turn has not released yet.
    await expect(registry.acquire("key-a", {
      required: false,
      create: async () => fakePage("page-2"),
    })).rejects.toBeInstanceOf(RetainedSurfaceBusyError);
  });

  test("the first acquisition is mutually exclusive while the surface is being created", async () => {
    const registry = new RetainedSurfaceRegistry();
    const pageA = fakePage("page-a");
    let resolveCreate!: (page: RetainedSurfacePage) => void;
    const createA = new Promise<RetainedSurfacePage>(resolve => {
      resolveCreate = resolve;
    });
    const first = registry.acquire("key-a", { required: false, create: () => createA });
    // Turn B arrives while turn A's creation is in flight: it must be rejected, not start
    // a second creation that would leave two physical pages for one conversationKey.
    await expect(registry.acquire("key-a", {
      required: false,
      create: async () => fakePage("page-b"),
    })).rejects.toBeInstanceOf(RetainedSurfaceBusyError);
    resolveCreate(pageA);
    const acquiredA = await first;
    expect(acquiredA.created).toBe(true);
    expect(acquiredA.page).toBe(pageA);
    expect(registry.has("key-a")).toBe(true);
  });

  test("a failed first creation leaves no state and a later attempt creates normally", async () => {
    const registry = new RetainedSurfaceRegistry();
    const failingCreate = async (): Promise<RetainedSurfacePage> => {
      throw new Error("browser launch failed");
    };
    await expect(registry.acquire("key-a", { required: false, create: failingCreate }))
      .rejects.toThrow("browser launch failed");
    // No surface and no pending marker are left behind.
    expect(registry.has("key-a")).toBe(false);
    const page = fakePage("page-retry");
    const retried = await registry.acquire("key-a", { required: false, create: async () => page });
    expect(retried.created).toBe(true);
    expect(retried.page).toBe(page);
  });

  test("distinct conversationKeys create their surfaces in parallel", async () => {
    const registry = new RetainedSurfaceRegistry();
    const pageA = fakePage("page-a");
    const pageB = fakePage("page-b");
    const [a, b] = await Promise.all([
      registry.acquire("key-a", { required: false, create: async () => pageA }),
      registry.acquire("key-b", { required: false, create: async () => pageB }),
    ]);
    expect(a.page).toBe(pageA);
    expect(b.page).toBe(pageB);
  });

  test("abort of a reused surface keeps the page open and the next turn reuses the same page", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    // Turn 2 acquires the existing surface (a continuation) ...
    const acquired = await registry.acquire("key-a", { required: false, create: async () => fakePage("x") });
    expect(acquired.created).toBe(false);
    expect(acquired.page).toBe(page);
    // ... and is aborted. The worker's abort path for a reused surface only releases.
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    // The page must be untouched: not closed, not removed.
    expect(page.closeCount).toBe(0);
    expect(page.isClosed()).toBe(false);
    expect(registry.has("key-a")).toBe(true);
    // The next turn reuses the exact same page (no new conversation).
    const next = await registry.acquire("key-a", { required: false, create: async () => fakePage("y") });
    expect(next.created).toBe(false);
    expect(next.page).toBe(page);
  });

  test("abort of a created surface invalidates it so no orphaned page is left behind", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    const acquired = await registry.acquire("key-a", { required: false, create: async () => page });
    expect(acquired.created).toBe(true);
    // The turn is aborted before the surface is used. The worker's abort path for a
    // created surface invalidates: the page is closed and the entry removed.
    await registry.invalidate("key-a");
    expect(page.closeCount).toBe(1);
    expect(page.isClosed()).toBe(true);
    expect(registry.has("key-a")).toBe(false);
    // A later turn starts a fresh continuity (nothing was ever sent to ChatGPT).
    const fresh = fakePage("page-fresh");
    const next = await registry.acquire("key-a", { required: false, create: async () => fresh });
    expect(next.created).toBe(true);
    expect(next.page).toBe(fresh);
  });

  test("shutdown releases every retained surface", async () => {
    const registry = new RetainedSurfaceRegistry();
    const pageA = fakePage("page-a");
    const pageB = fakePage("page-b");
    await registry.acquire("key-a", { required: false, create: async () => pageA });
    await registry.acquire("key-b", { required: false, create: async () => pageB });
    await registry.closeAll();
    expect(registry.has("key-a")).toBe(false);
    expect(registry.has("key-b")).toBe(false);
    expect(pageA.isClosed()).toBe(true);
    expect(pageB.isClosed()).toBe(true);
  });

  test("invalidate removes and closes a single retained surface", async () => {
    const registry = new RetainedSurfaceRegistry();
    const pageA = fakePage("page-a");
    const pageB = fakePage("page-b");
    await registry.acquire("key-a", { required: false, create: async () => pageA });
    await registry.acquire("key-b", { required: false, create: async () => pageB });
    await registry.invalidate("key-a");
    expect(registry.has("key-a")).toBe(false);
    expect(pageA.isClosed()).toBe(true);
    // The other conversation's surface is untouched.
    expect(registry.has("key-b")).toBe(true);
    expect(pageB.isClosed()).toBe(false);
  });
});

describe("issue #171 physical reuse vs configuration reuse", () => {
  test("a retained managed-chrome turn re-applies a changed model/effort configuration", () => {
    // The worker passes configurationReuse=false for a managed-chrome retained surface, so
    // effort selection runs whenever the turn's configuration differs from the surface's.
    expect(chatGptEffortSelectionRequired(false, "high", "low")).toBe(true);
    expect(chatGptEffortSelectionRequired(false, "low", "low")).toBe(true);
    // A first turn (no reuse at all) always selects its configuration.
    expect(chatGptEffortSelectionRequired(false, "high", "high")).toBe(true);
  });

  test("the Launcher lease keeps its current configuration-reuse semantics", () => {
    // Launcher reuse with the same configuration skips selection (existing behavior).
    expect(chatGptEffortSelectionRequired(true, "high", "high")).toBe(false);
    // Launcher reuse with a different configuration still re-applies it (existing behavior).
    expect(chatGptEffortSelectionRequired(true, "high", "low")).toBe(true);
  });

  test("a retained managed-chrome turn reuses the same physical page across turns", async () => {
    // physicalReuse (registry) never creates a second page for the same conversationKey,
    // no matter how the turn's configuration changes.
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    const first = await registry.acquire("key-a", { required: false, create: async () => page });
    expect(first.created).toBe(true);
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    const second = await registry.acquire("key-a", { required: false, create: async () => fakePage("x") });
    expect(second.created).toBe(false);
    expect(second.page).toBe(page);
    registry.release("key-a");
        registry.settle("key-a", "fulfilled");
    const third = await registry.acquire("key-a", { required: false, create: async () => fakePage("y") });
    expect(third.created).toBe(false);
    expect(third.page).toBe(page);
    expect(page.closeCount).toBe(0);
  });
  // The former `configurationReuse`/`physicalReuse`/send-boundary/wiring assertions read
  // `browser-worker.ts` and `index.ts` and asserted on their text. The registry behaviour they
  // guarded is asserted above and in `issue-192-retained-surface-settlement.test.ts`; the worker
  // call sites themselves remain unverifiable without a browser worker (recorded in the report).
});

/**
 * The default retention cap has to sit above the provider's concurrent-turn ceiling, or eviction
 * could be forced onto a surface that a live turn owns. The ceiling is a provider fact
 * (`MAX_CHATGPT_BROWSER_TABS`); the check below pins the default so a future change to either number
 * cannot silently cross them.
 */
describe("issue #171 bounded retention — the cap cannot be below the concurrent-turn ceiling", () => {
  test("the default cap is above the concurrent ChatGPT browser turns", () => {
    expect(DEFAULT_MAX_RETAINED_SURFACES).toBeGreaterThan(MAX_CHATGPT_BROWSER_TABS);
  });
});

/**
 * Issue #171 bounded retention — eviction is retirement.
 *
 * The registry used to retain one physical page per conversationKey forever: a caller that resends a
 * *growing* history produces a new conversation identity per turn, so pages accumulated without
 * bound (and a second provider multiplies it). These tests pin the bound and, more importantly, the
 * safety rule around it: what is evicted is retired, never handed on, never closed while a turn is
 * using it, and never closed while its settlement is still unproven.
 *
 * Everything here runs against the real registry with an injected clock and fake pages: no browser
 * and no real time.
 */

/** A fake clock the test advances by hand. */
function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface CountingPage extends RetainedSurfacePage {
  readonly name: string;
  readonly closeCount: number;
  /** Simulate the page dying outside the registry (a crash, a closed tab). */
  readonly markClosed: () => void;
}

function countingPage(name: string): CountingPage {
  let closed = false;
  let closeCount = 0;
  const page: CountingPage = {
    name,
    get closeCount() {
      return closeCount;
    },
    isClosed: () => closed,
    close: async () => {
      closed = true;
      closeCount += 1;
    },
    markClosed: () => {
      closed = true;
    },
  };
  return page;
}

/** One completed, settled turn on `key`, the state a retained surface is normally left in. */
async function retainSettled(
  registry: RetainedSurfaceRegistry<CountingPage>,
  key: string,
  page: CountingPage,
): Promise<void> {
  const acquired = await registry.acquire(key, { required: false, create: async () => page });
  expect(acquired.created).toBe(true);
  registry.release(key);
  registry.settle(key, "fulfilled");
}

describe("issue #171 bounded retention — eviction is retirement, never reuse", () => {
  test("exceeding the cap retires the least-recently-used surface and closes it exactly once", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 2,
      idleTimeoutMs: DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS,
      now: clock.now,
    });
    const first = countingPage("page-1");
    const second = countingPage("page-2");
    await retainSettled(registry, "key-1", first);
    clock.advance(60_000);
    await retainSettled(registry, "key-2", second);
    clock.advance(60_000);

    // The third conversation exceeds the cap of 2. key-1 was used least recently.
    const third = countingPage("page-3");
    await retainSettled(registry, "key-3", third);

    expect(registry.size).toBe(2);
    // key-1 is the one that was retired, and its page was closed — exactly once.
    expect(registry.has("key-1")).toBe(false);
    expect(first.isClosed()).toBe(true);
    expect(first.closeCount).toBe(1);
    // The two most recently used surfaces are untouched.
    expect(registry.has("key-2")).toBe(true);
    expect(registry.has("key-3")).toBe(true);
    expect(second.closeCount).toBe(0);
    expect(third.closeCount).toBe(0);
  });

  test("a surface idle beyond the timeout is retired and a recently used one is not", async () => {
    const clock = fixedClock();
    const idleTimeoutMs = 30 * 60_000;
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 8,
      idleTimeoutMs,
      now: clock.now,
    });
    const stale = countingPage("page-stale");
    const fresh = countingPage("page-fresh");
    await retainSettled(registry, "key-stale", stale);
    clock.advance(10 * 60_000);
    await retainSettled(registry, "key-fresh", fresh);

    // Ten more minutes: key-stale has been idle for twenty, still inside the window, so a sweep
    // retires nothing.
    clock.advance(10 * 60_000);
    expect(registry.sweep()).toHaveLength(0);
    expect(registry.has("key-stale")).toBe(true);
    expect(stale.closeCount).toBe(0);

    // Eleven more minutes: key-stale is now past the thirty-minute window while key-fresh (used ten
    // minutes later) is still inside it.
    clock.advance(11 * 60_000);
    const evictions = registry.sweep();
    expect(evictions.map(eviction => eviction.conversationKey)).toEqual(["key-stale"]);
    expect(evictions[0]!.reason).toBe("idle-timeout");
    expect(stale.isClosed()).toBe(true);
    expect(stale.closeCount).toBe(1);
    expect(registry.has("key-stale")).toBe(false);
    // The recently used surface is still retained and untouched.
    expect(registry.has("key-fresh")).toBe(true);
    expect(fresh.closeCount).toBe(0);
  });

  test("a surface with an active turn is never evicted, even at the cap and past the timeout", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 3,
      idleTimeoutMs: 60_000,
      now: clock.now,
    });
    // Both surfaces are held by turns that have not released them, long past any idle window.
    const busyA = countingPage("page-busy-a");
    const busyB = countingPage("page-busy-b");
    await registry.acquire("key-busy-a", { required: false, create: async () => busyA });
    await registry.acquire("key-busy-b", { required: false, create: async () => busyB });
    await retainSettled(registry, "key-idle", countingPage("page-idle"));
    clock.advance(10 * 60_000);

    // A settled surface is retained in the LRU position in front of the two held ones: an
    // over-capacity acquire must retire that, and never a page a turn is still using.
    const evictable = countingPage("page-evictable");
    await retainSettled(registry, "key-evictable", evictable);
    const incoming = countingPage("page-incoming");
    await registry.acquire("key-incoming", { required: false, create: async () => incoming });
    expect(evictable.isClosed()).toBe(true);
    expect(evictable.closeCount).toBe(1);
    expect(registry.isLost("key-evictable")).toBe(true);
    expect(busyA.closeCount).toBe(0);
    expect(busyB.closeCount).toBe(0);
    expect(incoming.closeCount).toBe(0);
    expect(registry.has("key-busy-a")).toBe(true);
    expect(registry.has("key-busy-b")).toBe(true);

    // When the held surfaces are the only obstacles left, the acquire refuses BEFORE it creates
    // anything, so no page is leaked either.
    const refused = countingPage("page-refused");
    await expect(registry.acquire("key-refused", { required: false, create: async () => refused }))
      .rejects.toBeInstanceOf(RetainedSurfaceBusyError);
    expect(refused.closeCount).toBe(0);
    expect(busyA.closeCount).toBe(0);
    expect(busyB.closeCount).toBe(0);
    expect(busyA.isClosed()).toBe(false);
    expect(busyB.isClosed()).toBe(false);

    // Releasing one turn makes exactly that surface retirable, and only because it stopped holding:
    // the surface still in a turn keeps its page.
    registry.release("key-busy-a");
    registry.settle("key-busy-a", "fulfilled");
    clock.advance(2 * 60_000);
    expect(registry.sweep().map(eviction => eviction.conversationKey)).toEqual(["key-busy-a"]);
    expect(busyA.closeCount).toBe(1);
    expect(busyB.closeCount).toBe(0);
    expect(busyB.isClosed()).toBe(false);
    expect(registry.has("key-busy-b")).toBe(true);
  });

  test("a surface whose settlement is unproven is never closed by an eviction", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 2,
      idleTimeoutMs: 30 * 60_000,
      now: clock.now,
    });
    // A settled surface the registry may retire, and one released without a settlement that it may
    // not: the second is the LRU and would be the obvious victim at the cap.
    const settled = countingPage("page-settled");
    await retainSettled(registry, "key-settled", settled);
    const settling = countingPage("page-settling");
    await registry.acquire("key-settling", { required: false, create: async () => settling });
    registry.release("key-settling");
    clock.advance(10 * 60_000);

    // The idle sweep refuses to touch the unsettled surface, even though it is the oldest.
    expect(registry.sweep()).toEqual([]);
    expect(settling.closeCount).toBe(0);

    // The over-capacity acquire retires the settled surface instead of the unsettled one.
    const incoming = countingPage("page-incoming");
    await registry.acquire("key-incoming", { required: false, create: async () => incoming });
    expect(settling.closeCount).toBe(0);
    expect(settling.isClosed()).toBe(false);
    expect(registry.has("key-settling")).toBe(true);
    expect(settled.isClosed()).toBe(true);
    expect(settled.closeCount).toBe(1);
    expect(registry.isLost("key-settled")).toBe(true);

    // Age does not change the answer: settlement, not time, is what gates the closing.
    clock.advance(31 * 60_000);
    expect(registry.sweep()).toEqual([]);
    expect(settling.closeCount).toBe(0);
  });

  test("after eviction a turn for that conversation is a continuity loss, not a silent new page", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 1,
      idleTimeoutMs: 60_000,
      now: clock.now,
    });
    const evicted = countingPage("page-evicted");
    await retainSettled(registry, "key-evicted", evicted);
    clock.advance(10 * 60_000);

    // The cap forces a new conversation in; the old one is retired on the way.
    await retainSettled(registry, "key-current", countingPage("page-current"));
    expect(evicted.closeCount).toBe(1);

    // The contract the caller reads: the conversation is tombstoned (explicit continuity loss), and a
    // later turn for it is refused instead of being handed the closed page or a fresh one.
    expect(registry.has("key-evicted")).toBe(false);
    expect(registry.isLost("key-evicted")).toBe(true);
    expect(registry.isReusable("key-evicted")).toBe(false);
    const freshPage = countingPage("page-should-not-be-used");
    await expect(registry.acquire("key-evicted", { required: false, create: async () => freshPage }))
      .rejects.toBeInstanceOf(RetainedSurfaceLostError);
    // The refused acquire created nothing and touched nothing.
    expect(freshPage.closeCount).toBe(0);
    expect(evicted.closeCount).toBe(1);

    // Recovery is explicit, exactly as the continuity contract requires: the caller replays.
    const replayed = await registry.acquire("key-evicted", {
      required: false,
      acceptRetired: true,
      create: async () => freshPage,
    });
    expect(replayed.created).toBe(true);
    expect(replayed.page).toBe(freshPage);
    expect(registry.isLost("key-evicted")).toBe(false);
  });

  test("shutdown after eviction still closes everything that remains, once", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 2,
      idleTimeoutMs: 60_000,
      now: clock.now,
    });
    const evicted = countingPage("page-evicted");
    const keptA = countingPage("page-kept-a");
    const keptB = countingPage("page-kept-b");
    await retainSettled(registry, "key-evicted", evicted);
    clock.advance(5_000);
    await retainSettled(registry, "key-a", keptA);
    clock.advance(5_000);
    await retainSettled(registry, "key-b", keptB);
    expect(evicted.closeCount).toBe(1);

    await registry.closeAll();
    expect(registry.size).toBe(0);
    expect(keptA.closeCount).toBe(1);
    expect(keptB.closeCount).toBe(1);
    // Idempotence is preserved: the shutdown path closes nothing a second time.
    await registry.closeAll();
    expect(evicted.closeCount).toBe(1);
    expect(keptA.closeCount).toBe(1);
    expect(keptB.closeCount).toBe(1);
    // Shutdown clears every tombstone, including the one this eviction wrote.
    expect(registry.isLost("key-evicted")).toBe(false);
  });

  /**
   * The guard is a re-check for every candidate, and each half of it is what this test pins:
   *
   * - the **busy** half: `key-held` has an active turn, so it is never evicted even when it is the
   *   LRU and over the cap;
   * - the **settled** half: `key-stale` is over the cap in the LRU order, but its settlement is
   *   unpublished, so the reclaim that needs a slot passes over it.
   *
   * Replace `!busy && settled` with "close the oldest" and the first expectations fail.
   */
  test("eviction re-checks the settlement/retirement guard for every candidate", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 2,
      idleTimeoutMs: 60_000,
      now: clock.now,
    });
    // A surface still held by a turn, and one released without a settlement. key-held is acquired
    // first, so it is the LRU candidate a "close the oldest" policy would reach first.
    const held = countingPage("page-held");
    const stale = countingPage("page-stale");
    await registry.acquire("key-held", { required: false, create: async () => held });
    await registry.acquire("key-stale", { required: false, create: async () => stale });
    registry.release("key-stale");
    clock.advance(5_000);

    // The reclaim needs a slot and both candidates are off limits: it refuses, having closed
    // nothing, instead of closing a page a turn is using or one whose settlement is unproven.
    expect(registry.sweep()).toHaveLength(0);
    await expect(registry.acquire("key-new", { required: false, create: async () => countingPage("page-new") }))
      .rejects.toBeInstanceOf(RetainedSurfaceBusyError);
    expect(registry.size).toBe(2);
    expect(held.closeCount).toBe(0);
    expect(stale.closeCount).toBe(0);
    expect(registry.isLost("key-held")).toBe(false);
    expect(registry.isLost("key-stale")).toBe(false);

    // Removing the obstacles one at a time is what proves both halves are live guards. Publishing
    // key-stale's settlement alone changes nothing for the cap, because key-held is still held — the
    // reclaim walks past the held surface and reaches only key-stale.
    registry.settle("key-stale", "fulfilled");
    expect(registry.sweep()).toHaveLength(0);
    const incoming = countingPage("page-incoming");
    await registry.acquire("key-incoming", { required: false, create: async () => incoming });
    expect(stale.isClosed()).toBe(true);
    expect(stale.closeCount).toBe(1);
    expect(registry.isLost("key-stale")).toBe(true);
    expect(held.isClosed()).toBe(false);
    expect(held.closeCount).toBe(0);
    expect(registry.isLost("key-held")).toBe(false);
    expect(registry.has("key-held")).toBe(true);
    expect(incoming.closeCount).toBe(0);
  });

  test("an over-capacity acquire retires the eligible LRU surface and never the held one", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 2,
      idleTimeoutMs: 60_000,
      now: clock.now,
    });
    // A surface still held by a turn, and an idle settled one behind it in the LRU order. The
    // reclaim has to walk past the held surface and retire the settled one.
    const held = countingPage("page-held");
    await registry.acquire("key-held", { required: false, create: async () => held });
    const retired = countingPage("page-retired");
    await retainSettled(registry, "key-retired", retired);
    clock.advance(10 * 60_000);

    const incoming = countingPage("page-incoming");
    await registry.acquire("key-incoming", { required: false, create: async () => incoming });
    expect(retired.isClosed()).toBe(true);
    expect(retired.closeCount).toBe(1);
    expect(registry.isLost("key-retired")).toBe(true);
    expect(held.closeCount).toBe(0);
    expect(held.isClosed()).toBe(false);
    expect(registry.isLost("key-held")).toBe(false);
    expect(registry.has("key-held")).toBe(true);
    expect(incoming.closeCount).toBe(0);
    expect(registry.size).toBe(2);
  });

  test("the registry fills to exactly the cap and evicts only past it", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({
      maxSurfaces: 3,
      idleTimeoutMs: DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS,
      now: clock.now,
    });
    const pages: CountingPage[] = [];
    for (const key of ["key-1", "key-2", "key-3"]) {
      const page = countingPage(`page-${key}`);
      pages.push(page);
      clock.advance(60_000);
      await retainSettled(registry, key, page);
    }
    // Reaching the cap is normal use: nothing is evicted to get there.
    expect(registry.size).toBe(3);
    expect(pages.every(page => page.closeCount === 0)).toBe(true);

    // One more conversation is the one that exceeds it.
    const fourth = countingPage("page-4");
    clock.advance(60_000);
    await retainSettled(registry, "key-4", fourth);
    expect(registry.size).toBe(3);
    expect(pages[0]!.closeCount).toBe(1);
    expect(pages[1]!.closeCount).toBe(0);
    expect(pages[2]!.closeCount).toBe(0);
    expect(registry.has("key-1")).toBe(false);
    expect(registry.isLost("key-1")).toBe(true);
  });

  test("malformed retention options are refused instead of silently defaulting", () => {
    expect(() => new RetainedSurfaceRegistry({ maxSurfaces: 0 })).toThrow(TypeError);
    expect(() => new RetainedSurfaceRegistry({ maxSurfaces: 1.5 })).toThrow(TypeError);
    expect(() => new RetainedSurfaceRegistry({ idleTimeoutMs: 0 })).toThrow(TypeError);
    expect(() => new RetainedSurfaceRegistry({ idleTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});

/**
 * Issue #171 (next retention slice) — the idle sweep runs on the worker's steady tick.
 *
 * The registry enforced the idle window only when something asked it to acquire, so a process that
 * stopped acquiring held its retained pages until shutdown and the window was mostly decorative. The
 * sweep now rides `ChatGptSuspensionClock`, the one steady interval the worker already runs for its
 * stage budgets: no scheduler and no second timer were added. This is the wiring under test, against
 * the real registry, the real clock class and fake pages — no browser and no real time.
 */
describe("issue #171 bounded retention — the idle sweep runs on the worker's steady tick", () => {
  test("an idle surface is reclaimed on the clock without a new acquisition", async () => {
    const clock = fixedClock();
    const idleTimeoutMs = 30 * 60_000;
    const registry = new RetainedSurfaceRegistry<CountingPage>({ idleTimeoutMs, now: clock.now });
    const suspensionClock = new ChatGptSuspensionClock();
    const detach = attachRetainedSurfaceIdleSweep(registry, suspensionClock);
    const page = countingPage("page-idle");
    await retainSettled(registry, "key-idle", page);
    expect(page.closeCount).toBe(0);

    // Nothing acquires anything: only the clock advances and the worker's tick fires.
    clock.advance(idleTimeoutMs + 1);
    suspensionClock.tick(clock.now());

    expect(registry.has("key-idle")).toBe(false);
    expect(page.isClosed()).toBe(true);
    expect(page.closeCount).toBe(1);
    // Eviction is retirement: the key is tombstoned exactly like a page that died.
    expect(registry.isLost("key-idle")).toBe(true);
    detach();
  });

  test("the tick never reclaims a surface an active turn holds", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({ idleTimeoutMs: 60_000, now: clock.now });
    const suspensionClock = new ChatGptSuspensionClock();
    const detach = attachRetainedSurfaceIdleSweep(registry, suspensionClock);
    const busy = countingPage("page-busy");
    // Held by a turn: acquired and never released, so `busy` is true.
    await registry.acquire("key-busy", { required: false, create: async () => busy });

    clock.advance(24 * 60 * 60_000);
    suspensionClock.tick(clock.now());
    // The registry's own eligibility rule (`!busy && settled`) refused to close it; the wiring only
    // asked, and it respects that refusal.
    expect(registry.has("key-busy")).toBe(true);
    expect(busy.isClosed()).toBe(false);
    expect(busy.closeCount).toBe(0);

    // Once the turn releases and settles its surface, the next tick past the window reclaims it.
    registry.release("key-busy");
    registry.settle("key-busy", "fulfilled");
    clock.advance(60_001);
    suspensionClock.tick(clock.now());
    expect(busy.isClosed()).toBe(true);
    expect(busy.closeCount).toBe(1);
    detach();
  });

  test("detaching the tick stops the sweep", async () => {
    const clock = fixedClock();
    const registry = new RetainedSurfaceRegistry<CountingPage>({ idleTimeoutMs: 1_000, now: clock.now });
    const suspensionClock = new ChatGptSuspensionClock();
    const detach = attachRetainedSurfaceIdleSweep(registry, suspensionClock);
    const page = countingPage("page-detached");
    await retainSettled(registry, "key-detached", page);
    detach();

    clock.advance(60_000);
    suspensionClock.tick(clock.now());
    expect(registry.has("key-detached")).toBe(true);
    expect(page.closeCount).toBe(0);
  });
});
