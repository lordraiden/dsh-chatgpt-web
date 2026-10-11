/**
 * Issue #193 (P1) — the real plugin registration, without injected drivers.
 *
 * The wiring commit registered the ChatGPT route only when a caller injected a driver list, so in
 * production (`webChat = {}`) `ctx.llm.registerAdapter` was never called and the route was missing.
 * These tests exercise `apply` exactly like a production profile: no drivers are injected, the
 * adapter composes the default driver for its own route from the effective provider configuration,
 * and the route reaches the DSH registration authority.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, saveConfig } from "../src/config";
import { apply, type CordisContext } from "../src/plugin";
import { CHATGPT_WEB_PROVIDER_ID } from "../src/adapters/chatgpt-web/llm-adapter";
import type { WebChatProviderDriver } from "../src/web-chat/core";

interface Registered {
  providers: string[];
  adapter: unknown;
}

interface Harness {
  readonly ctx: CordisContext;
  readonly registered: Registered[];
  readonly warnings: string[];
  dispose(): Promise<void>;
}

function harness(): Harness {
  const registered: Registered[] = [];
  const warnings: string[] = [];
  let disposer: (() => void | Promise<void>) | undefined;
  const ctx = {
    llm: {
      registerAdapter(providers: string[], adapter: unknown): () => void {
        registered.push({ providers: [...providers], adapter });
        return () => {};
      },
    },
    logger: () => ({
      info() {},
      warn(message: string) { warnings.push(message); },
      error() {},
      debug() {},
    }),
    effect(callback: () => void | Promise<void> | (() => void) | (() => Promise<void>)) {
      disposer = callback() as (() => void | Promise<void>) | undefined;
    },
  } as unknown as CordisContext;
  return {
    ctx,
    registered,
    warnings,
    dispose: async () => { await disposer?.(); },
  };
}

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

beforeEach(() => {
  previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "issue-193-plugin-"));
  delete process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = home;
});

afterEach(() => {
  if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
  else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
  if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
  rmSync(home, { recursive: true, force: true });
});

/** The production shape: an installed configuration and no injected drivers. */
const installedConfig = { autoStart: false, readyTimeoutMs: 0, port: 1 };

describe("issue #193 — the plugin registers the ChatGPT route in production", () => {
  test("without injected drivers the adapter composes the route driver and DSH registers it", async () => {
    saveConfig(defaultConfig());
    const test1 = harness();
    apply(test1.ctx, installedConfig, {});

    expect(test1.registered.map(entry => entry.providers)).toEqual([[CHATGPT_WEB_PROVIDER_ID]]);
    // The adapter handed to DSH is the one that composed the driver: the route is registered by the
    // same object that owns the provider configuration and the native session registry.
    expect(typeof (test1.registered[0]!.adapter as { webChatDriver?: unknown }).webChatDriver).toBe("function");
    expect(test1.warnings).toEqual([]);

    // Shutdown releases the driver list the registration decision was taken from.
    await test1.dispose();
  });

  test("a route without a driver is still refused, and its injected drivers are still released", async () => {
    saveConfig(defaultConfig());
    let shutdowns = 0;
    const injected: WebChatProviderDriver = {
      id: "other-web",
      inspectAccount: async () => ({ authenticated: false }),
      listModels: async () => [],
      resolveModel: async () => undefined,
      assessConversation: async () => ({ status: "new" }),
      createConversation: async input => ({
        key: "key",
        providerId: "other-web",
        bindingId: input.affinity.bindingId,
        generation: 1,
        handle: "handle" as never,
        status: "new",
      }),
      resumeConversation: async input => input.conversation,
      replayConversation: async input => input.conversation!,
      health: async () => ({ ok: true, detail: "ok" }),
      shutdown: async () => { shutdowns += 1; },
    };
    const refused = harness();
    apply(refused.ctx, installedConfig, { drivers: () => [injected] });

    expect(refused.registered).toEqual([]);
    expect(refused.warnings.some(message => message.includes("is not composed"))).toBe(true);
    await refused.dispose();
    expect(shutdowns).toBe(1);
  });

  test("a provider configuration that cannot be resolved leaves the route unregistered without failing the plugin", async () => {
    // No configuration was written: the adapter cannot compose a driver, so the route is refused
    // exactly like an unimplemented one, and the plugin still loads.
    const missing = harness();
    expect(() => apply(missing.ctx, installedConfig, {})).not.toThrow();

    expect(missing.registered).toEqual([]);
    expect(missing.warnings.some(message => message.includes("could not be composed"))).toBe(true);
    await missing.dispose();
  });
});
