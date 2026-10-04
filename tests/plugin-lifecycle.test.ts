import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  constructor(readonly events: string[]) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.events.push(`kill:${signal}`);
    setTimeout(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
      this.events.push("child-exit");
    }, 20);
    return true;
  }
}

const spawned: FakeChild[] = [];
const events: string[] = [];

mock.module("node:child_process", () => ({
  spawn: () => {
    const child = new FakeChild(events);
    spawned.push(child);
    events.push("spawn");
    return child;
  },
}));

const { apply } = await import("../src/plugin.ts");

function makeContext() {
  let update: (() => void | Promise<void>) | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  const form = {
    value: undefined as Record<string, unknown> | undefined,
    mutate(next: Record<string, unknown>) {
      this.value = next;
    },
  };

  const logs: string[] = [];
  const context = {
    get: () => undefined,
    effect(effect: () => void | (() => void) | (() => Promise<void>)) {
      cleanup = effect() as (() => Promise<void>) | undefined;
    },
    on(_event: string, callback: () => void | Promise<void>) {
      update = callback;
    },
    logger: () => ({
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
      debug: () => {},
    }),
    llm: {
      registerAdapter: () => () => {},
    },
    form,
    getUpdate: () => update,
    getCleanup: () => cleanup,
    logs,
  };
  return context;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function jsonResponse(status = "ok"): Response {
  return new Response(JSON.stringify({ status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("native plugin sidecar lifecycle", () => {
  test("does not start a stale port after a hot reconfiguration races with the health probe", async () => {
    spawned.length = 0;
    events.length = 0;

    let releaseInitialHealth!: () => void;
    const initialHealth = new Promise<void>(resolve => { releaseInitialHealth = resolve; });
    let firstHealthObserved!: () => void;
    const firstHealth = new Promise<void>(resolve => { firstHealthObserved = resolve; });

    const originalFetch = globalThis.fetch;
    const healthCounts = new Map<string, number>();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/healthz") {
        const count = (healthCounts.get(url.port) ?? 0) + 1;
        healthCounts.set(url.port, count);
        if (url.port === "17841" && count === 1) {
          firstHealthObserved();
          await initialHealth;
          return jsonResponse("offline");
        }
        if (url.port === "19001") return jsonResponse();
        return jsonResponse("offline");
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const config = { port: 17841, autoStart: true, readyTimeoutMs: 500 };
    const context = makeContext();
    try {
      apply(context, config);
      await firstHealth;
      config.port = 19001;
      context.getUpdate()!();
      await new Promise(resolve => setTimeout(resolve, 0));
      releaseInitialHealth();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(spawned).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      await context.getCleanup()?.();
    }
  });

  test("waits for the old child to exit before starting the replacement sidecar", async () => {
    spawned.length = 0;
    events.length = 0;

    const originalFetch = globalThis.fetch;
    const healthCounts = new Map<string, number>();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/healthz") {
        const count = (healthCounts.get(url.port) ?? 0) + 1;
        healthCounts.set(url.port, count);
        if (count === 1) return jsonResponse("offline");
        return jsonResponse();
      }
      if (url.pathname === "/admin/shutdown") return jsonResponse();
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const config = { port: 17841, autoStart: true, readyTimeoutMs: 500 };
    const context = makeContext();
    try {
      apply(context, config);
      await waitFor(() => spawned.length === 1);
      await waitFor(() => healthCounts.get("17841") === 2);

      config.port = 19001;
      context.getUpdate()!();
      await waitFor(() => spawned.length === 2);

      expect(events.indexOf("child-exit")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("child-exit")).toBeLessThan(events.lastIndexOf("spawn"));
    } finally {
      globalThis.fetch = originalFetch;
      await context.getCleanup()?.();
    }
  });
});
