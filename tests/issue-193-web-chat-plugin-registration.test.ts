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
import { apply, createSidecarAgreement, sidecarRefusal, type CordisContext } from "../src/plugin";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { CHATGPT_WEB_PROVIDER_ID } from "../src/adapters/chatgpt-web/llm-adapter";
import type { WebChatProviderDriver } from "../src/web-chat/core";
import { VERSION } from "../src/version";

interface Registered {
  providers: string[];
  adapter: unknown;
}

interface Harness {
  readonly ctx: CordisContext;
  readonly registered: Registered[];
  readonly warnings: string[];
  readonly errors: string[];
  dispose(): Promise<void>;
}

function harness(): Harness {
  const registered: Registered[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
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
      error(message: string) { errors.push(message); },
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
    errors,
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

  test("does not silently reuse a healthy sidecar from an older plugin release", async () => {
    saveConfig(defaultConfig());
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => Response.json({
        status: "ok",
        service: "dsh-chatgpt-web",
        version: "1.0.24",
        pid: 4242,
        mode: "browser-only",
      }),
    });

    const outdated = harness();
    try {
      apply(outdated.ctx, installedConfig, {});
      // startDaemon is intentionally fire-and-forget from the Cordis effect.
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(outdated.errors.some(message =>
        message.includes("Outdated sidecar")
        && message.includes("running version 1.0.24")
        && message.includes(`installed plugin is ${VERSION}`)
        && message.includes("restart DSH"),
      )).toBe(true);
      expect(outdated.warnings).toEqual([]);
    } finally {
      await outdated.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  test("reuses a healthy sidecar only when its version matches the installed plugin", async () => {
    saveConfig(defaultConfig());
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => Response.json({
        status: "ok",
        service: "dsh-chatgpt-web",
        version: VERSION,
        pid: 4243,
        mode: "browser-only",
      }),
    });

    const current = harness();
    try {
      apply(current.ctx, installedConfig, {});
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(current.errors).toEqual([]);
      expect(current.warnings).toEqual([]);
    } finally {
      await current.dispose();
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The startup decision alone left turns flowing to a daemon the plugin had refused, so the same
 * agreement is asserted on the turn path (issue #236 follow-up: release/runtime hygiene).
 */
describe("the sidecar agreement guard", () => {
  const where = { url: "http://127.0.0.1:17841/v1", port: 17841 };

  test("refuses an outdated daemon with its version, pid and the remedy", () => {
    const refusal = sidecarRefusal({ service: "dsh-chatgpt-web", version: "1.0.24", pid: 4242 }, VERSION, where);
    expect(refusal).toContain("Outdated sidecar");
    expect(refusal).toContain("1.0.24");
    expect(refusal).toContain("pid 4242");
    expect(refusal).toContain(`installed plugin is ${VERSION}`);
    expect(refusal).toContain("restart DSH");
  });

  test("refuses a healthy foreign service instead of adopting its port", () => {
    const refusal = sidecarRefusal({ service: "something-else", version: "9.9.9" }, VERSION, where);
    expect(refusal).toContain("Port 17841");
    expect(refusal).toContain("something-else");
  });

  test("accepts a matching daemon and an empty port", () => {
    expect(sidecarRefusal({ service: "dsh-chatgpt-web", version: VERSION }, VERSION, where)).toBeUndefined();
    expect(sidecarRefusal(undefined, VERSION, where)).toBeUndefined();
  });

  test("the remembered agreement fails closed and asks for a re-inspection", () => {
    let refreshes = 0;
    const agreement = createSidecarAgreement(VERSION, { onRefusal: () => { refreshes += 1; } });
    // Nothing inspected yet: the guard does not invent a refusal.
    expect(() => agreement.assertUsable()).not.toThrow();
    agreement.observe({ service: "dsh-chatgpt-web", version: "1.0.24" }, where);
    expect(() => agreement.assertUsable()).toThrow(/Outdated sidecar/);
    expect(refreshes).toBe(1);
    // A daemon the operator has since replaced is accepted again.
    agreement.observe({ service: "dsh-chatgpt-web", version: VERSION }, where);
    expect(() => agreement.assertUsable()).not.toThrow();
    // A free port clears the refusal rather than remembering it.
    agreement.observe(undefined, where);
    expect(agreement.refusal()).toBeUndefined();
  });
});

describe("issue #193 — an outdated sidecar fails the turn path closed", () => {
  function nativeTurnOptions(text: string): GenerateOptions {
    return {
      provider: CHATGPT_WEB_PROVIDER_ID,
      model: "chatgpt-web/luna",
      messages: [
        {
          role: "user",
          id: "msg-1",
          source: { kind: "user" },
          content: [{ type: "text", text }],
        } as unknown as GenerateOptions["messages"][number],
      ],
    };
  }

  async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
  }

  test("a turn refuses with the same message the startup log reports", async () => {
    saveConfig(defaultConfig());
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => Response.json({
        status: "ok",
        service: "dsh-chatgpt-web",
        version: "1.0.24",
        pid: 4242,
        mode: "browser-only",
      }),
    });

    const outdated = harness();
    try {
      apply(outdated.ctx, installedConfig, {});
      await new Promise(resolve => setTimeout(resolve, 10));

      const adapter = outdated.registered[0]?.adapter as
        | { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
        | undefined;
      expect(adapter).toBeDefined();

      const chunks = await collect(adapter!.stream(nativeTurnOptions("hi")));
      const finish = chunks[chunks.length - 1] as Extract<StreamChunk, { type: "finish" }>;
      expect(finish?.type).toBe("finish");
      const failure = (finish as unknown as { reason?: { failure?: { message?: string; code?: string } } }).reason?.failure;
      expect(failure?.message).toContain("Outdated sidecar");
      expect(failure?.message).toContain("1.0.24");
      expect(failure?.message).toContain(`installed plugin is ${VERSION}`);
      expect(failure?.code).toBe("PROVIDER_ERROR");
    } finally {
      await outdated.dispose();
      globalThis.fetch = originalFetch;
    }
  });
});
