import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  RetainedSurfaceBusyError,
  RetainedSurfaceLostError,
  RetainedSurfaceMissingError,
  RetainedSurfaceRegistry,
  type RetainedSurfacePage,
} from "../src/adapters/chatgpt-web/retained-surface";

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

  test("a lost surface produces an explicit continuity error, not a silent new conversation", async () => {
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
    // The dead entry is gone; the key no longer maps to a (silent) replacement.
    expect(registry.has("key-a")).toBe(false);
  });

  test("a required surface that does not exist fails explicitly", async () => {
    const registry = new RetainedSurfaceRegistry();
    await expect(registry.acquire("key-missing", {
      required: true,
      create: async () => fakePage("page-1"),
    })).rejects.toBeInstanceOf(RetainedSurfaceMissingError);
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

  test("a reused surface aborted during acquisition leaves no dead entry behind", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage("page-1");
    await registry.acquire("key-a", { required: false, create: async () => page });
    registry.release("key-a");
    // The page dies and the turn that would have reused it is aborted; the worker
    // invalidates the key, so the next turn creates fresh instead of hitting a loss.
    page.markClosed();
    await registry.invalidate("key-a");
    expect(registry.has("key-a")).toBe(false);
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

  test("continuation skips root navigation and surface preparation", () => {
    // The surface-preparation stage (which navigates to the ChatGPT root) runs only when
    // the turn is NOT a continuation.
    expect(workerSource).toContain("if (!effectiveReuse) {");
    // A continuation takes the resume prompt, not the full prompt.
    expect(workerSource).toContain("const prepare = effectiveReuse ? turn.prepareResume : turn.prepare;");
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

  test("a created surface is only discarded when its turn did not complete", () => {
    expect(workerSource).toContain("if (!turnCompleted && retainedCreated && retainedPage && !retainedPage.isClosed()) {");
  });
});
