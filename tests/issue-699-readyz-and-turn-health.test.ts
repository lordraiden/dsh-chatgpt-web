/**
 * Issue #699 (T3.5) / D1.4 — readiness without quota, and the last successful turn.
 *
 * The service now answers three distinct questions, and this suite pins the boundary between them:
 *
 * - `GET /healthz` — **liveness**: the process answers HTTP. Cheap and unconditional.
 * - `GET /readyz` — **readiness**: the listener can accept a turn *now* (not draining, writable data
 *   directory, the ChatGPT Web session capture present, a non-saturated turn queue, a catalogue that
 *   resolved in memory). No browser, no provider call, no quota.
 * - the **canary** — a real minimal turn. The only check that proves the account can send, therefore
 *   never part of readiness and never automatic.
 *
 * `last_successful_turn_at` (plus model/endpoint/count) makes "no turn in N hours" observable without a
 * canary: it is recorded from the provider's own terminal `done` event, never from an HTTP status.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, type AppConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import {
  createReadinessProbe,
  type ReadinessProbeOptions,
} from "../src/web-chat/host/readiness";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

const CONTROL_TOKEN = "issue-699-readyz-control-token-0123456789";
const ACCOUNT_FINGERPRINT = "issue-699-readyz-account";

let home: string;
let savedHome: SavedChatGptWebHome;
let previousApiKey: string | undefined;
const running: RunningServer[] = [];

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-699-readyz-", { clearFreeHome: true });
});

afterEach(async () => {
  if (previousApiKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
  else process.env.DSH_CHATGPT_WEB_API_KEY = previousApiKey;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  restoreChatGptWebHome(savedHome, home);
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    ...overrides,
  };
}

/** Write the ChatGPT Web capture the readiness auth check gates on. */
function writeCapture(value: AppConfig): void {
  mkdirSync(join(home, "browser"), { recursive: true });
  writeFileSync(value.storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
}

function probe(
  value: AppConfig,
  overrides: Partial<ReadinessProbeOptions> = {},
) {
  return createReadinessProbe({
    config: value,
    version: "1.5.8",
    isAcceptingTurns: () => true,
    turnQueue: () => ({ waiting: 0, maxWaiters: 20, active: 0 }),
    ...overrides,
  });
}

describe("issue #699 — readiness is a cheap, browser-free verdict", () => {
  test("a ready listener reports one ok entry per check and no sensitive detail", () => {
    const value = config();
    writeCapture(value);
    const report = probe(value).snapshot();

    expect(report.status).toBe("ready");
    expect(report.httpStatus).toBe(200);
    expect(report.body.service).toBe("dsh-chatgpt-web");
    expect(report.body.version).toBe("1.5.8");
    expect(Object.keys(report.body.checks).sort()).toEqual([
      "auth",
      "catalogue",
      "lifecycle",
      "storage",
      "turn_queue",
    ]);
    for (const check of Object.values(report.body.checks)) expect(check.ok).toBe(true);
    expect(report.body.checks.auth.required).toEqual(["chatgpt-web"]);
    expect(report.body.checks.auth.present).toContain("chatgpt-web");
    expect(report.body.checks.turn_queue.max_waiters).toBe(20);
    expect(report.body.checks.catalogue.models as number).toBeGreaterThan(0);

    // No credential, no prompt, no filesystem path: the probe is public and must stay inert.
    const serialized = JSON.stringify(report.body);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain("Bearer");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("cookie");
  });

  test("draining is not ready, even though the process is alive", () => {
    const value = config();
    writeCapture(value);
    const report = probe(value, { isAcceptingTurns: () => false }).snapshot();
    expect(report.httpStatus).toBe(503);
    expect(report.body.status).toBe("not_ready");
    expect(report.body.checks.lifecycle).toMatchObject({ ok: false, accepting_turns: false });
    // The rest of the checks stay honest: only the failing precondition is reported as broken.
    expect(report.body.checks.storage.ok).toBe(true);
  });

  test("an absent data directory is not ready", () => {
    const value = config();
    writeCapture(value);
    rmSync(home, { recursive: true, force: true });
    const report = probe(value).snapshot();
    expect(report.httpStatus).toBe(503);
    expect(report.body.checks.storage).toMatchObject({ ok: false, code: "storage_missing" });
  });

  test("an unwritable data directory is not ready", () => {
    const value = config();
    writeCapture(value);
    // Make the probe path itself a directory: the write fails with EISDIR for any user, including
    // root, so the verdict does not depend on the test runner's privileges.
    mkdirSync(join(home, `.readyz-${process.pid}`), { recursive: true });
    const report = probe(value).snapshot();
    expect(report.httpStatus).toBe(503);
    expect(report.body.checks.storage).toMatchObject({ ok: false, code: "storage_unwritable" });
  });

  test("the storage probe is cached, so a probe loop is not a disk-write loop", () => {
    const value = config();
    writeCapture(value);
    let instant = 1_000_000;
    const instance = createReadinessProbe({
      config: value,
      version: "1.5.8",
      isAcceptingTurns: () => true,
      turnQueue: () => ({ waiting: 0, maxWaiters: 20, active: 0 }),
      now: () => instant,
      storageProbeTtlMs: 10_000,
    });
    expect(instance.snapshot().body.checks.storage.ok).toBe(true);
    // The directory disappears, but the cached verdict still stands inside the TTL...
    rmSync(home, { recursive: true, force: true });
    expect(instance.snapshot().body.checks.storage.ok).toBe(true);
    // ...and the next probe after the TTL observes the truth.
    instant += 10_001;
    expect(instance.snapshot().body.checks.storage).toMatchObject({ ok: false, code: "storage_missing" });
  });

  test("an absent ChatGPT Web capture is not ready, and it names what is missing", () => {
    const value = config();
    // No capture written at all.
    const report = probe(value).snapshot();
    expect(report.httpStatus).toBe(503);
    expect(report.body.checks.auth).toMatchObject({ ok: false, required: ["chatgpt-web"] });
    expect(report.body.checks.auth.missing).toContain("chatgpt-web");
  });

  test("a saturated turn queue is not ready: the next turn would be refused immediately", () => {
    const value = config();
    writeCapture(value);
    const report = probe(value, {
      turnQueue: () => ({ waiting: 20, maxWaiters: 20, active: 5 }),
    }).snapshot();
    expect(report.httpStatus).toBe(503);
    expect(report.body.checks.turn_queue).toMatchObject({
      ok: false,
      waiting: 20,
      max_waiters: 20,
      active: 5,
    });
  });

  test("a store whose capture disappeared after boot flips readiness without a restart", () => {
    const value = config();
    writeCapture(value);
    const instance = probe(value);
    expect(instance.snapshot().httpStatus).toBe(200);
    rmSync(value.storageStatePath, { force: true });
    expect(instance.snapshot().httpStatus).toBe(503);
  });
});

/** A provider stub: the adapter seam is simulated, the listener and routing are real. */
function stubAdapterFactory(): (provider: CodexProviderConfig) => ProviderAdapter {
  return (): ProviderAdapter => ({
    name: "issue-699-readyz-stub",
    runTurn: async (
      _parsed: CodexParsedRequest,
      _incoming: unknown,
      emit: (event: AdapterEvent) => void,
    ) => {
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
}

function serve(value: AppConfig, dependencies: Parameters<typeof startServer>[1] = {}): RunningServer {
  const server = startServer(value, dependencies);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string): string => `http://127.0.0.1:${server.port}${path}`;

describe("issue #699 — /readyz and last_successful_turn_at on the real listener", () => {
  test("readiness answers 200 with the same per-check shape over HTTP", async () => {
    const value = config();
    writeCapture(value);
    const server = serve(value, { adapterFactory: stubAdapterFactory() });
    const response = await fetch(url(server, "/readyz"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as {
      status: string;
      checks: Record<string, { ok: boolean }>;
    };
    expect(body.status).toBe("ready");
    expect(body.checks.auth.ok).toBe(true);
  });

  test("readiness answers 503 when the session capture is gone", async () => {
    const value = config();
    // Deliberately no capture.
    const server = serve(value, { adapterFactory: stubAdapterFactory() });
    const response = await fetch(url(server, "/readyz"));
    expect(response.status).toBe(503);
    const body = await response.json() as { status: string; checks: { auth: { ok: boolean } } };
    expect(body.status).toBe("not_ready");
    expect(body.checks.auth.ok).toBe(false);
  });

  test("last_successful_turn_at starts empty and moves after a successful turn", async () => {
    const value = config();
    writeCapture(value);
    const server = serve(value, { adapterFactory: stubAdapterFactory() });

    const before = await (await fetch(url(server, "/healthz"))).json() as {
      last_successful_turn_at: string | null;
      successful_turns: number;
    };
    expect(before.last_successful_turn_at).toBeNull();
    expect(before.successful_turns).toBe(0);

    const turn = await fetch(url(server, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        messages: [{ role: "user", content: "hola" }],
      }),
    });
    expect(turn.status).toBe(200);

    const after = await (await fetch(url(server, "/healthz"))).json() as {
      last_successful_turn_at: string | null;
      last_successful_turn_model: string | null;
      last_successful_turn_endpoint: string | null;
      successful_turns: number;
    };
    expect(after.last_successful_turn_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(after.last_successful_turn_at!))).toBe(false);
    expect(after.last_successful_turn_model).toBe("chatgpt-web/luna");
    expect(after.last_successful_turn_endpoint).toBe("chat-completions");
    expect(after.successful_turns).toBe(1);
  });

  test("the operator control surface publishes the same turn facts", async () => {
    const value = config();
    writeCapture(value);
    const server = serve(value, { adapterFactory: stubAdapterFactory() });

    const turn = await fetch(url(server, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        input: [{ role: "user", content: "hola" }],
        stream: false,
      }),
    });
    expect(turn.status).toBe(200);

    const status = await (await fetch(url(server, "/v1/control/status"), {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })).json() as {
      last_successful_turn_at: string | null;
      last_successful_turn_model: string | null;
      last_successful_turn_endpoint: string | null;
      successful_turns: number;
    };
    expect(status.last_successful_turn_at).not.toBeNull();
    expect(status.last_successful_turn_model).toBe("chatgpt-web/luna");
    expect(status.last_successful_turn_endpoint).toBe("responses");
    expect(status.successful_turns).toBe(1);
  });
});
