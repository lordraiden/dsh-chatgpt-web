import { describe, expect, test } from "bun:test";

import {
  AUTH_SESSION_STATES,
  WebChatError,
  isAuthInput,
  isAuthSessionState,
  isProviderAuthView,
  type AuthInput,
  type AuthSessionState,
  type ProviderAuthController,
  type ProviderAuthSession,
  type ProviderAuthView,
} from "../src/web-chat/core";
import { createWebChatAuthSessionManager } from "../src/web-chat/host/auth-sessions";

/**
 * Issue #276, slice 1 — the provider-neutral auth contract and its transport-agnostic manager.
 *
 * CI expectation: this suite is deterministic. It uses **no browser, no network, no real timer and
 * no ChatGPT code**: the clock is injected and the sweep is driven through an injected scheduler, so
 * it can run in the pinned `bun run test` chain and in bare `bun test` with the same result.
 *
 * The suite proves the contract is satisfiable *without pixels*. A fake provider that relays no
 * frame at all signs in through the same manager, along the same state path, as one that relays PNG
 * frames — because the manager owns lifecycle, not pixels.
 */

/** A real 1x1 PNG (opaque to the manager, which must never decode it). */
const ONE_BY_ONE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A provider double with no browser of any kind.
 *
 * `pixels: true` models a provider that relays synthetic 1x1 PNG frames; `pixels: false` models a
 * device-code/OTP provider whose sign-in needs no display and whose `view()` refuses outright. Both
 * reach `captured` through the same two `input()` steps.
 */
function createFakeProvider(options: { providerId: string; pixels: boolean }) {
  let state: AuthSessionState = "starting";
  let views = 0;
  let inputs = 0;
  let cancels = 0;
  const session: ProviderAuthSession = {
    providerId: options.providerId,
    state: () => state,
    async view(): Promise<ProviderAuthView> {
      views += 1;
      if (!options.pixels) {
        // Nothing to relay: this provider's mechanism has no display at all.
        throw new Error("this provider relays no frames");
      }
      // The provider's own bytes, plus a one-byte frame index the test uses to tell frames apart.
      const png = new Uint8Array(ONE_BY_ONE_PNG.length + 1);
      png.set(ONE_BY_ONE_PNG, 0);
      png[ONE_BY_ONE_PNG.length] = views;
      return { png, width: 1, height: 1 };
    },
    async input(event: AuthInput): Promise<void> {
      inputs += 1;
      if (event.type === "type" && (event.text === "user@example.test" || event.text === "12345678")) {
        state = "verifying";
      } else if (event.type === "key" && event.key === "Enter") {
        state = "captured";
      }
    },
    // Slice 2a widened the provider-owned half of the contract: the session exposes its own capture
    // and the controller owns where that capture lands. This double produces no material, which is
    // the `none` kind — the manager and the relay must not care either way.
    async capture() {
      return { kind: "none" } as const;
    },
    async cancel(): Promise<void> {
      cancels += 1;
      if (state !== "captured") state = "expired";
    },
  };
  return {
    providerId: options.providerId,
    controller: {
      async startAuth(): Promise<ProviderAuthSession> {
        state = "awaiting_input";
        return session;
      },
      async storeCapture(): Promise<{ stored: boolean }> {
        return { stored: false };
      },
    } satisfies ProviderAuthController,
    session,
    counters: () => ({ views, inputs, cancels }),
  };
}

/** The shared sign-in path: two inputs, whatever the provider relays (or does not). */
async function signIn(
  manager: ReturnType<typeof createWebChatAuthSessionManager>,
  providerId: string,
  controller: ProviderAuthController,
  credential: string,
) {
  const handle = await manager.open({ providerId, controller });
  const steps: AuthSessionState[] = [handle.state()];
  await handle.input({ type: "type", text: credential });
  steps.push(handle.state());
  await handle.input({ type: "key", key: "Enter" });
  steps.push(handle.state());
  return { handle, steps };
}

/** A scheduler the test drives by hand: no real timer, and cancellation is observable. */
function createFakeScheduler() {
  let pending: (() => void | Promise<void>) | undefined;
  let scheduledWith: number | undefined;
  let cancels = 0;
  return {
    schedule: (run: () => void | Promise<void>, intervalMs: number) => {
      pending = run;
      scheduledWith = intervalMs;
      return () => {
        cancels += 1;
        pending = undefined;
      };
    },
    async fire(): Promise<void> {
      await pending?.();
    },
    get cancels(): number {
      return cancels;
    },
    get scheduledWith(): number | undefined {
      return scheduledWith;
    },
  };
}

describe("issue #276 — the auth vocabulary is pinned and total", () => {
  test("the six states are exactly the contract states, in order", () => {
    expect([...AUTH_SESSION_STATES]).toEqual([
      "starting",
      "awaiting_input",
      "verifying",
      "captured",
      "failed",
      "expired",
    ]);
    for (const state of AUTH_SESSION_STATES) expect(isAuthSessionState(state)).toBe(true);
    expect(isAuthSessionState("cancelled")).toBe(false);
    expect(isAuthSessionState(undefined)).toBe(false);
    expect(isAuthSessionState(1)).toBe(false);
  });

  test("only the five input intents are relayable, and each is strict", () => {
    expect(isAuthInput({ type: "click", x: 3, y: 4 })).toBe(true);
    expect(isAuthInput({ type: "type", text: "hola" })).toBe(true);
    expect(isAuthInput({ type: "key", key: "Enter" })).toBe(true);
    expect(isAuthInput({ type: "scroll", dy: -20 })).toBe(true);
    expect(isAuthInput({ type: "navigate", url: "https://example.test/login" })).toBe(true);
    // Unknown intents, half instructions, empty strings and non-finite coordinates are refused.
    expect(isAuthInput({ type: "drag", x: 1, y: 1 })).toBe(false);
    expect(isAuthInput({ type: "click", x: 1 })).toBe(false);
    expect(isAuthInput({ type: "click", x: Number.NaN, y: 1 })).toBe(false);
    expect(isAuthInput({ type: "scroll", dy: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isAuthInput({ type: "type", text: "" })).toBe(false);
    expect(isAuthInput({ type: "navigate", url: "" })).toBe(false);
    expect(isAuthInput(null)).toBe(false);
    expect(isAuthInput("click")).toBe(false);
  });

  test("a frame is bytes plus a positive integer geometry, nothing else", () => {
    expect(isProviderAuthView({ png: ONE_BY_ONE_PNG, width: 1, height: 1 })).toBe(true);
    expect(isProviderAuthView({ png: new Uint8Array(0), width: 1, height: 1 })).toBe(false);
    expect(isProviderAuthView({ png: [1, 2, 3], width: 1, height: 1 })).toBe(false);
    expect(isProviderAuthView({ png: ONE_BY_ONE_PNG, width: 0, height: 1 })).toBe(false);
    expect(isProviderAuthView({ png: ONE_BY_ONE_PNG, width: 1.5, height: 1 })).toBe(false);
    expect(isProviderAuthView(null)).toBe(false);
  });
});

describe("issue #276 — frame relay, cache and invalidate-after-input", () => {
  test("a browser provider's frames are relayed unchanged, cached, and refreshed after input", async () => {
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });

    expect(handle.providerId).toBe("pixel-web");
    expect(handle.state()).toBe("awaiting_input");
    // The manager hands back one stable handle for one session.
    expect(manager.get(handle.id)).toBe(handle);
    expect(manager.activeFor("pixel-web")).toBe(handle);

    const first = await handle.view();
    expect(provider.counters().views).toBe(1);
    expect([...first.png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(first.width).toBe(1);
    expect(first.height).toBe(1);
    // Byte-for-byte relay: the manager never decodes or rewrites the provider's bytes.
    expect([...first.png]).toEqual([...ONE_BY_ONE_PNG, 1]);

    // A late subscriber gets the cached frame without touching the provider.
    expect(await handle.view()).toBe(first);
    expect(provider.counters().views).toBe(1);

    await handle.input({ type: "type", text: "user@example.test" });
    expect(handle.state()).toBe("verifying");
    expect(provider.counters().inputs).toBe(1);

    // Invalidate-after-input: the next view() is a fresh one from the provider.
    const second = await handle.view();
    expect(provider.counters().views).toBe(2);
    expect(second).not.toBe(first);
    expect([...second.png]).toEqual([...ONE_BY_ONE_PNG, 2]);

    // The primitive is also public, so a caller can force a fresh frame without an input.
    handle.invalidate();
    const last = await handle.view();
    expect(provider.counters().views).toBe(3);

    await handle.input({ type: "key", key: "Enter" });
    expect(handle.state()).toBe("captured");
    // A terminal input keeps the last relayed frame: captured serves it without asking a provider
    // whose mechanism may already be gone, so the caller's final view() does not fail at the exact
    // moment sign-in succeeded.
    expect(await handle.view()).toBe(last);
    expect(provider.counters().views).toBe(3);
    // The slot is released on capture: a new sign-in (or a late state poll) is not blocked.
    expect(manager.activeFor("pixel-web")).toBeUndefined();
    await expect(
      manager.open({ providerId: "pixel-web", controller: provider.controller }),
    ).resolves.toBeDefined();
  });
});

describe("issue #276 — a provider with no browser is served identically", () => {
  test("the no-pixel provider walks the same state path and never relays a frame", async () => {
    const pixel = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const deviceCode = createFakeProvider({ providerId: "device-code-web", pixels: false });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });

    const withPixels = await signIn(manager, pixel.providerId, pixel.controller, "user@example.test");
    const withoutPixels = await signIn(manager, deviceCode.providerId, deviceCode.controller, "12345678");

    // Same lifecycle, same states — the manager cannot tell the two providers apart.
    expect(withPixels.steps).toEqual(["awaiting_input", "verifying", "captured"]);
    expect(withoutPixels.steps).toEqual(withPixels.steps);
    // The neutrality proof: reaching `captured` required no frame at all.
    expect(deviceCode.counters().views).toBe(0);
    expect(withoutPixels.handle.state()).toBe("captured");
    // The captured provider session is the handoff the caller stores; the manager never read it.
    expect(withoutPixels.handle.capturedSession()).toBe(deviceCode.session);
    // And since no frame was ever relayed, asking for one is refused as a state mismatch instead of
    // inventing pixels; the provider is still not called.
    await expect(withoutPixels.handle.view()).rejects.toBeInstanceOf(WebChatError);
    await expect(withoutPixels.handle.view()).rejects.toMatchObject({ category: "CONVERSATION_STATE_MISMATCH" });
    expect(deviceCode.counters().views).toBe(0);
  });

  test("capturedSession is gated: captured material cannot be read before the provider proves it", async () => {
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });
    try {
      handle.capturedSession();
      throw new Error("expected the captured session to be refused before capture");
    } catch (error) {
      expect((error as WebChatError).category).toBe("CONVERSATION_STATE_MISMATCH");
    }
    await handle.input({ type: "type", text: "user@example.test" });
    await handle.input({ type: "key", key: "Enter" });
    expect(handle.capturedSession()).toBe(provider.session);
  });
});

describe("issue #276 — one active session per provider", () => {
  test("a second session for the same provider is refused, and another provider is not", async () => {
    const first = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const other = createFakeProvider({ providerId: "other-web", pixels: true });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: first.providerId, controller: first.controller });

    try {
      await manager.open({ providerId: first.providerId, controller: first.controller });
      throw new Error("expected the second session to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(WebChatError);
      expect((error as WebChatError).category).toBe("TRANSPORT_UNAVAILABLE");
      expect((error as WebChatError).providerId).toBe("pixel-web");
    }

    // A different provider is a different account and is allowed.
    const otherHandle = await manager.open({ providerId: other.providerId, controller: other.controller });
    expect(otherHandle.providerId).toBe("other-web");
    expect(manager.activeFor("pixel-web")).toBe(handle);

    // Cancelling releases the slot.
    await handle.cancel();
    await expect(
      manager.open({ providerId: first.providerId, controller: first.controller }),
    ).resolves.toBeDefined();
  });

  test("two concurrent opens cannot both start a session for one provider", async () => {
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const results = await Promise.allSettled([
      manager.open({ providerId: provider.providerId, controller: provider.controller }),
      manager.open({ providerId: provider.providerId, controller: provider.controller }),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as WebChatError).category).toBe("TRANSPORT_UNAVAILABLE");
  });
});

describe("issue #276 — TTL expiry is swept, and captured material is never expired away", () => {
  test("the sweep timer expires a session, cancels its provider, and frees its slot", async () => {
    const scheduler = createFakeScheduler();
    let clock = 1_000;
    const manager = createWebChatAuthSessionManager({
      ttlMs: 1_000,
      now: () => clock,
      sweepIntervalMs: 250,
      schedule: scheduler.schedule,
    });
    expect(scheduler.scheduledWith).toBe(250);

    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });
    expect(handle.snapshot().expiresAt).toBe(2_000);

    // Not yet: a sweep before the deadline leaves the session alone.
    expect(await manager.sweep()).toBe(0);

    clock = 2_000;
    await scheduler.fire();
    expect(handle.state()).toBe("expired");
    expect(handle.snapshot().closeReason).toBe("expired");
    expect(provider.counters().cancels).toBe(1);
    expect(manager.activeFor("pixel-web")).toBeUndefined();

    // An expired session serves nothing, with the semantic category, whatever is asked of it.
    await expect(handle.view()).rejects.toMatchObject({ category: "AUTH_EXPIRED" });
    await expect(handle.input({ type: "click", x: 1, y: 1 })).rejects.toMatchObject({ category: "AUTH_EXPIRED" });

    // The slot is free again.
    const restarted = await manager.open({ providerId: provider.providerId, controller: provider.controller });
    clock = 4_000;
    expect(await manager.sweep()).toBe(1);
    expect(restarted.state()).toBe("expired");
  });

  test("a captured session is terminal and is not cancelled by the TTL sweep or by close", async () => {
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0, ttlMs: 1 });
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });
    await handle.input({ type: "type", text: "user@example.test" });
    await handle.input({ type: "key", key: "Enter" });
    expect(handle.state()).toBe("captured");

    expect(await manager.sweep()).toBe(0);
    await manager.close();
    // The captured material must outlive the manager: the caller still has to store it.
    expect(handle.state()).toBe("captured");
    expect(provider.counters().cancels).toBe(0);
    expect(() => handle.capturedSession()).not.toThrow();
  });
});

describe("issue #276 — cancellation and close are deterministic", () => {
  test("cancel is idempotent, closes the session, and releases the provider exactly once", async () => {
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });

    await handle.cancel();
    expect(handle.state()).toBe("expired");
    expect(handle.snapshot().closeReason).toBe("cancelled");
    expect(provider.counters().cancels).toBe(1);

    await handle.cancel();
    expect(provider.counters().cancels).toBe(1);
    await expect(handle.view()).rejects.toMatchObject({ category: "AUTH_EXPIRED" });
  });

  test("a failing provider cancel still terminalizes, and records the failure", async () => {
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const failing: ProviderAuthController = {
      async startAuth() {
        const session = await provider.controller.startAuth();
        return { ...session, cancel: async () => { throw new Error("browser already gone"); } };
      },
      async storeCapture() {
        return { stored: false };
      },
    };
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: provider.providerId, controller: failing });
    await handle.cancel();
    expect(handle.state()).toBe("expired");
    expect(handle.snapshot().detail).toBe("browser already gone");
  });

  test("close cancels the sweep timer, cancels active sessions, and is idempotent", async () => {
    const scheduler = createFakeScheduler();
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const manager = createWebChatAuthSessionManager({
      now: () => 1_000,
      schedule: scheduler.schedule,
      sweepIntervalMs: 100,
    });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });

    await manager.close();
    // The timer is cancelled exactly once: nothing outlives the manager.
    expect(scheduler.cancels).toBe(1);
    expect(handle.state()).toBe("expired");
    expect(provider.counters().cancels).toBe(1);
    expect(scheduler.cancels).toBe(1);

    await manager.close();
    expect(scheduler.cancels).toBe(1);
    expect(provider.counters().cancels).toBe(1);
    await expect(
      manager.open({ providerId: provider.providerId, controller: provider.controller }),
    ).rejects.toMatchObject({ category: "SHUTDOWN" });
  });

  test("malformed input fails as a caller defect, and a malformed open is refused", async () => {
    const provider = createFakeProvider({ providerId: "pixel-web", pixels: true });
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: provider.providerId, controller: provider.controller });
    await expect(handle.input({ type: "drag", x: 1, y: 1 } as unknown as AuthInput)).rejects.toBeInstanceOf(TypeError);
    expect(provider.counters().inputs).toBe(0);
    await expect(manager.open({ providerId: "", controller: provider.controller })).rejects.toBeInstanceOf(TypeError);
    await expect(
      manager.open({ providerId: "pixel-web", controller: {} as ProviderAuthController }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("a manager requires a positive TTL and a non-negative sweep interval", () => {
    expect(() => createWebChatAuthSessionManager({ ttlMs: 0 })).toThrow(TypeError);
    expect(() => createWebChatAuthSessionManager({ ttlMs: 1.5 })).toThrow(TypeError);
    expect(() => createWebChatAuthSessionManager({ sweepIntervalMs: -1 })).toThrow(TypeError);
  });
});
