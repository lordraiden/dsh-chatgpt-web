import { describe, expect, test } from "bun:test";

import { RetainedSurfaceRegistry } from "../src/adapters/chatgpt-web/retained-surface";

/**
 * Issue #192 (slice 1b) — a retained surface is not reusable until its physical settlement is known.
 *
 * The owner of the surface records the settlement of the operation that held it, and the reuse
 * decision asks for it: a released-but-unsettled surface stays out of reach (architecture §9.3,
 * §15.3), and a settlement that cannot be proven drops it and tombstones the key.
 */

interface FakePage { closed: boolean; isClosed(): boolean; close(): Promise<void> }

function fakePage(): FakePage {
  const page: FakePage = {
    closed: false,
    isClosed: () => page.closed,
    close: async () => { page.closed = true; },
  };
  return page;
}

describe("issue #192 — settlement gates surface reuse", () => {
  test("a held, released and settled surface", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage>();
    const acquired = await registry.acquire("key-1", { create: async () => fakePage(), required: false });
    expect(acquired.created).toBe(true);
    // Held by the turn: not reusable.
    expect(registry.isReusable("key-1")).toBe(false);

    // Released without a settlement: retained, still not reusable.
    registry.release("key-1");
    expect(registry.has("key-1")).toBe(true);
    expect(registry.isReusable("key-1")).toBe(false);

    // Settlement published: reusable again.
    registry.settle("key-1", "fulfilled");
    expect(registry.isReusable("key-1")).toBe(true);
    expect(registry.has("key-1")).toBe(true);
  });

  test("a pending settlement keeps it out of reach", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage>();
    await registry.acquire("key-2", { create: async () => fakePage(), required: false });
    registry.release("key-2");
    registry.settle("key-2", "pending");
    expect(registry.isReusable("key-2")).toBe(false);
    registry.settle("key-2", "not_started");
    expect(registry.isReusable("key-2")).toBe(true);
  });

  test("a settlement that cannot be proven drops the surface and tombstones the key", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage>();
    const page = fakePage();
    await registry.acquire("key-3", { create: async () => page, required: false });
    registry.release("key-3");
    registry.settle("key-3", "rejected");

    expect(page.closed).toBe(true);
    expect(registry.isReusable("key-3")).toBe(false);
    expect(registry.isLost("key-3")).toBe(true);
    // Nothing recreates it silently: an explicit reset is the only way back.
    await expect(registry.acquire("key-3", { create: async () => fakePage(), required: false })).rejects.toThrow(/lost/i);
    registry.reset("key-3");
    expect(registry.isLost("key-3")).toBe(false);
    const recreated = await registry.acquire("key-3", { create: async () => fakePage(), required: false });
    expect(recreated.created).toBe(true);
    expect(registry.isReusable("key-3")).toBe(false);
  });

  test("settling a key that is not retained is a no-op", () => {
    const registry = new RetainedSurfaceRegistry<FakePage>();
    expect(() => registry.settle("never-seen", "fulfilled")).not.toThrow();
    expect(registry.isReusable("never-seen")).toBe(false);
    expect(registry.isLost("never-seen")).toBe(false);
  });
});
