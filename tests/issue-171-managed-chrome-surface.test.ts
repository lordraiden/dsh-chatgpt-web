import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  RetainedSurfaceBusyError,
  RetainedSurfaceLostError,
  RetainedSurfaceMissingError,
  RetainedSurfaceRegistry,
  type RetainedSurfacePage,
} from "../src/adapters/chatgpt-web/retained-surface";
import { chatGptEffortSelectionRequired } from "../src/adapters/chatgpt-web/browser-worker";

const adapterSource = readFileSync(
  new URL("../src/adapters/chatgpt-web/index.ts", import.meta.url),
  "utf8",
);
const workerSource = readFileSync(
  new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url),
  "utf8",
);

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
    expect(registry.has("key-a")).toBe(true);
    expect(page.isClosed()).toBe(false);
    expect(page.closeCount).toBe(0);
  });

  test("a lost surface is explicit, tombstoned, and never degrades into a silent new conversation", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
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
    // Turn 2 acquires the existing surface (a continuation) ...
    const acquired = await registry.acquire("key-a", { required: false, create: async () => fakePage("x") });
    expect(acquired.created).toBe(false);
    expect(acquired.page).toBe(page);
    // ... and is aborted. The worker's abort path for a reused surface only releases.
    registry.release("key-a");
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
    const second = await registry.acquire("key-a", { required: false, create: async () => fakePage("x") });
    expect(second.created).toBe(false);
    expect(second.page).toBe(page);
    registry.release("key-a");
    const third = await registry.acquire("key-a", { required: false, create: async () => fakePage("y") });
    expect(third.created).toBe(false);
    expect(third.page).toBe(page);
    expect(page.closeCount).toBe(0);
  });

  test("configurationReuse is derived from the Launcher lease only, never from managed-chrome retention", () => {
    const configurationReuse = workerSource.match(/const configurationReuse = [\s\S]*?;/)?.[0] ?? "";
    // Exactly the Launcher lease — a retained managed-chrome page is NOT a configuration reuse.
    expect(configurationReuse).toContain("reuseConversation");
    expect(configurationReuse).not.toContain("managedReuse");
    const physicalReuse = workerSource.match(/const physicalReuse = [\s\S]*?;/)?.[0] ?? "";
    expect(physicalReuse).toContain("reuseConversation || managedReuse");
  });

  test("effort selection is driven by configurationReuse, not by physical reuse", () => {
    expect(workerSource).toContain("chatGptEffortSelectionRequired(\n        configurationReuse,");
  });

  test("root navigation and surface preparation are skipped for a physical continuation", () => {
    expect(workerSource).toContain("if (!physicalReuse) {");
    expect(workerSource).toContain("const prepare = physicalReuse ? turn.prepareResume : turn.prepare;");
  });
});

describe("issue #171 send-boundary retention", () => {
  test("a created surface is discarded only when the send never activated", () => {
    // The finally block gates the discard on the send activation boundary, not on
    // whole-turn completion: a post-completion housekeeping fault must not destroy it.
    expect(workerSource).toContain("if (!sendActivated && retainedCreated && retainedPage && !retainedPage.isClosed()) {");
    expect(workerSource).not.toContain("turnCompleted");
  });

  test("send activation and submission both mark the boundary", () => {
    // The wrapped lifecycle records the boundary on both signals and forwards to the
    // adapter's callbacks, reusing the existing submissionLifecycle architecture.
    const lifecycle = workerSource.match(/const retainedSubmissionLifecycle = [\s\S]*?^\s{4}\};/m)?.[0] ?? "";
    expect(lifecycle).toContain("onSendActivated");
    expect(lifecycle).toContain("onSubmitted");
    const activatedMarks = (lifecycle.match(/sendActivated = true;/g) ?? []).length;
    expect(activatedMarks).toBeGreaterThanOrEqual(2);
  });

  test("both send paths route through the boundary-wrapping lifecycle", () => {
    // Multipart stage sends and the final commit must both observe the boundary.
    const sites = (workerSource.match(/retainedSubmissionLifecycle,/g) ?? []).length;
    expect(sites).toBe(2);
  });
});

describe("issue #171 worker and adapter wiring", () => {
  test("the read-only adapter path carries the retention identity to the transport", () => {
    // The normal (no-local-tools) path must pass the stable conversationKey and the
    // continuation prompt, exactly like the tool-capable path.
    expect(adapterSource).toContain("...(retainConversation ? { retainConversation: true, conversationKey } : {})");
    expect(adapterSource).toContain("prepareResume");
  });

  test("managed-chrome retention is gated on the browser host and a stable conversationKey", () => {
    expect(workerSource).toContain('this.config.browserHost === "managed-chrome"');
    expect(workerSource).toContain("turn.conversationKey !== undefined");
    expect(workerSource).toContain("this.retainedSurfaces.acquire");
  });

  test("the Launcher lease path is not routed through the managed-chrome registry", () => {
    // managedRetained must exclude a launcher-leased surface.
    const managedRetained = workerSource.match(/const managedRetained = [\s\S]*?;/)?.[0] ?? "";
    expect(managedRetained).toContain("!launcherSurfaceId");
    expect(managedRetained).toContain("!maintenancePage");
  });

  test("a retained surface is released at the end of a turn and kept open", () => {
    expect(workerSource).toContain("this.retainedSurfaces.release(turn.conversationKey!);");
  });

  test("a retained surface is never tracked as a per-turn managedPage", () => {
    expect(workerSource).toContain("!managedRetained) managedPage = page;");
  });

  test("a lost or busy retained surface surfaces an explicit continuity error", () => {
    expect(workerSource).toContain("if (error instanceof RetainedSurfaceLostError) throw chatGptRetainedSurfaceLostError();");
    expect(workerSource).toContain("if (error instanceof RetainedSurfaceBusyError) throw chatGptRetainedSurfaceBusyError();");
  });

  test("worker shutdown releases all retained surfaces", () => {
    expect(workerSource).toContain("await this.retainedSurfaces.closeAll();");
  });

  test("an aborted acquisition discards a created surface but keeps a reused one", () => {
    // A created surface is invalidated (closed + removed) so no orphan/dead entry remains.
    expect(workerSource).toContain("await this.retainedSurfaces.invalidate(turn.conversationKey!);");
    // A reused surface only clears the busy flag, preserving the prior conversation.
    expect(workerSource).toMatch(/if \(retained\.created\)[\s\S]*?invalidate[\s\S]*?else[\s\S]*?retainedSurfaces\.release/);
  });
});
