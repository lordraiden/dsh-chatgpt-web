import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  isLoopbackHost,
  MINIMUM_API_KEY_LENGTH,
  resolveApiKey,
} from "../src/config";
import { RequestBodyTooLargeError, requestBodyLimits } from "../src/http-body";
import { resolveMaxInflightTurns, startServer, type RunningServer } from "../src/server";

/**
 * Issue #247 — authenticate the public API surface, fail closed on an unsafe bind, and bound what one
 * exposed service can consume.
 *
 * The real listener is exercised over HTTP (the same way the DSH/Codex consumer reaches it), and the
 * two authorities are probed against each other: the API key must never open the operator control
 * routes, and the control token must never open the public API.
 */
const API_KEY = "issue-247-test-api-key-0123456789";
const CONTROL_TOKEN = "issue-247-test-control-token-0123456789";

const ENV_KEYS = [
  "DSH_CHATGPT_WEB_API_KEY",
  "DSH_CHATGPT_WEB_MAX_REQUEST_BYTES",
  "DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    ...overrides,
  };
}

const running: RunningServer[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()!;
    // Bounded: a test that deliberately keeps a turn in flight must never hang the suite's teardown
    // (CI caught exactly that).
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function serve(config = makeConfig()): RunningServer {
  const server = startServer(config as never);
  if (server?.port) running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;

describe("issue #247 — bind and key resolution", () => {
  test("only genuine loopback values count as loopback", () => {
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "localhost.localdomain"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.internal", "127.0.0.2"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("no key configured means no key, and the environment wins over the data directory", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "dsh-auth-"));
    expect(resolveApiKey(home)).toBeUndefined();

    writeFileSync(join(home, "api-key"), `${API_KEY}\n`);
    expect(resolveApiKey(home)).toBe(API_KEY);

    process.env.DSH_CHATGPT_WEB_API_KEY = "from-the-environment-0123456789";
    expect(resolveApiKey(home)).toBe("from-the-environment-0123456789");
  });

  test("a key too short to authenticate anything is refused, from either source", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-auth-"));
    process.env.DSH_CHATGPT_WEB_API_KEY = "x".repeat(MINIMUM_API_KEY_LENGTH - 1);
    expect(() => resolveApiKey(home)).toThrow(/at least 16 characters/);

    clearEnv();
    writeFileSync(join(home, "api-key"), "short\n");
    expect(() => resolveApiKey(home)).toThrow(/at least 16 characters/);
  });

  test("the body cap is overridable and ignores nonsense", () => {
    clearEnv();
    const generous = requestBodyLimits();
    expect(generous.decoded).toBe(generous.encoded * 2);

    process.env.DSH_CHATGPT_WEB_MAX_REQUEST_BYTES = "1024";
    expect(requestBodyLimits()).toEqual({ encoded: 1024, decoded: 2048 });

    process.env.DSH_CHATGPT_WEB_MAX_REQUEST_BYTES = "not-a-number";
    expect(requestBodyLimits().encoded).toBe(generous.encoded);
  });

  test("the in-flight cap is opt-in: zero (unlimited) unless configured", () => {
    expect(resolveMaxInflightTurns({} as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMaxInflightTurns({ DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS: "3" } as NodeJS.ProcessEnv)).toBe(3);
    expect(resolveMaxInflightTurns({ DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMaxInflightTurns({ DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS: "x" } as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("issue #247 — fail closed on an unsafe bind", () => {
  test("a non-loopback bind without an API key refuses to start", () => {
    clearEnv();
    expect(() => startServer(makeConfig({ host: "0.0.0.0" }) as never))
      .toThrow(/Refusing to serve on 0\.0\.0\.0[\s\S]*DSH_CHATGPT_WEB_API_KEY/);
  });

  test("a non-loopback bind is allowed once a key is configured", async () => {
    process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
    const server = serve(makeConfig({ host: "0.0.0.0" }));
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(url(server, "/v1/models"), { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(response.status).toBe(200);
  });

  test("a loopback bind needs no key: the local DSH/Codex consumer is unchanged", async () => {
    clearEnv();
    const server = serve();
    expect((await fetch(url(server, "/v1/models"))).status).toBe(200);
    expect((await fetch(url(server, "/healthz"))).status).toBe(200);
  });
});

describe("issue #247 — the public API surface is authenticated", () => {
  test("the key matrix, including that /healthz stays open and leaks nothing", async () => {
    process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
    const server = serve(makeConfig());

    expect((await fetch(url(server, "/v1/models"))).status).toBe(401);
    expect((await fetch(url(server, "/v1/models"), { headers: { authorization: "Bearer wrong-key-000000000000" } })).status).toBe(401);
    expect((await fetch(url(server, "/v1/models"), { headers: { authorization: `Bearer ${API_KEY}` } })).status).toBe(200);
    expect((await fetch(url(server, "/v1/models"), { headers: { "x-api-key": API_KEY } })).status).toBe(200);

    const unauthorized = await fetch(url(server, "/v1/models"));
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
    const body = await unauthorized.json() as { error?: { code?: string; type?: string } };
    // The bridge derives the code from the status; assert its canonical vocabulary, not ours.
    expect(body.error?.code).toBe("invalid_api_key");
    expect(body.error?.type).toBe("authentication_error");

    const health = await fetch(url(server, "/healthz"));
    expect(health.status).toBe(200);
    expect(await health.text()).not.toContain(API_KEY);
  });

  test("the API key and the control token are separate authorities", async () => {
    process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
    const server = serve(makeConfig());

    // The API key must not open the operator control routes...
    expect((await fetch(url(server, "/v1/control/status"), { headers: { authorization: `Bearer ${API_KEY}` } })).status).toBe(401);
    // ...and the control token must not open the public API.
    expect((await fetch(url(server, "/v1/models"), { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).status).toBe(401);

    // Both keep working on their own surface.
    expect((await fetch(url(server, "/v1/control/status"), { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).status).toBe(200);
    expect((await fetch(url(server, "/v1/models"), { headers: { authorization: `Bearer ${API_KEY}` } })).status).toBe(200);
  });
});

describe("issue #247 — bounded resources", () => {
  test("an oversized body is a typed 413, and a normal body is not", async () => {
    clearEnv();
    process.env.DSH_CHATGPT_WEB_MAX_REQUEST_BYTES = "64";
    const server = serve();

    const oversized = await fetch(url(server, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", input: "x".repeat(200) }),
    });
    expect(oversized.status).toBe(413);
    const body = await oversized.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("request_too_large");
    expect(body.error?.message).toContain("configured limit");

    // Under the cap the request proceeds to normal validation (this body is not a valid Codex turn).
    const small = await fetch(url(server, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", input: "x" }),
    });
    expect(small.status).not.toBe(413);
  });

  test("the typed error carries the limit it exceeded", () => {
    const error = new RequestBodyTooLargeError("Encoded request body", 64);
    expect(error.name).toBe("RequestBodyTooLargeError");
    expect(error.limitBytes).toBe(64);
    expect(error.message).toContain("64");
  });

  test("the optional in-flight cap refuses with a typed 429 instead of queueing forever", async () => {
    clearEnv();
    process.env.DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS = "1";
    const controller = new AbortController();
    const config = makeConfig();
    const server = startServer(config as never, {
      // A turn that stays in flight keeps the single slot busy; like the real adapter it settles when
      // the caller's request is cancelled, so teardown cannot hang.
      adapterFactory: () => ({
        name: "issue-247-stays-in-flight",
        runTurn: (_parsed: unknown, incoming: { abortSignal?: AbortSignal }) =>
          new Promise<void>((resolve) => {
            if (incoming.abortSignal?.aborted) { resolve(); return; }
            incoming.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
      }) as never,
    });
    running.push(server);

    const inFlight = fetch(url(server, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", input: "hold" }),
      signal: controller.signal,
    }).catch(() => undefined);

    // The counter is incremented when the turn is dispatched, before the adapter runs.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = await fetch(url(server, "/v1/models"));
      if (probe.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refused = await fetch(url(server, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", input: "second" }),
    });
    expect(refused.status).toBe(429);
    const body = await refused.json() as { error?: { code?: string; type?: string } };
    expect(body.error?.code).toBe("rate_limit_exceeded");
    expect(body.error?.type).toBe("rate_limit_error");

    controller.abort();
    await inFlight;
  });
});
