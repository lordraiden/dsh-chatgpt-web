import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import { VERSION } from "../src/version";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * The operator control surface: `/admin/*` and `/healthz`.
 *
 * `/admin/*` had no tests at all, so the authority boundary that the AGENTS.md rules call out —
 * the control token is the operator authority and the API key is a different one — and the
 * drain/cancel/shutdown behaviour the container entrypoint relies on are pinned here. `/healthz`
 * was previously asserted only by status code; the response shape every compose health check and
 * `docker/verify-container.sh` consumes is asserted too, together with the guarantee that it never
 * echoes a credential.
 */
const API_KEY = "issue-247-control-surface-api-key-0123456789";
const CONTROL_TOKEN = "issue-247-control-surface-control-token-0123456789";
const ACCOUNT = "issue-247-control-surface-account";

let savedHome: SavedChatGptWebHome;
let previousApiKey: string | undefined;
let home: string;

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-247-control-surface-", { clearFreeHome: true });
});

const running: RunningServer[] = [];
afterEach(async () => {
  if (previousApiKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
  else process.env.DSH_CHATGPT_WEB_API_KEY = previousApiKey;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  restoreChatGptWebHome(savedHome, home);
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT,
    ...overrides,
  };
}

function serve(config = makeConfig()): RunningServer {
  const server = startServer(config as never);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const admin = (server: RunningServer, path: string, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
const control = (server: RunningServer, path: string, body: unknown = {}) =>
  fetch(url(server, path), {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Every POST-only operator route; the authority matrix applies to all of them. */
const ADMIN_ROUTES = [
  "/admin/drain",
  "/admin/resume",
  "/admin/cancel-turn",
  "/admin/cancel-turns",
  "/admin/interrupt-turn",
  "/admin/shutdown",
] as const;

describe("admin control surface — the control token is the only authority", () => {
  test("no credentials and the public API key are both refused on every /admin route", async () => {
    const server = serve();
    for (const route of ADMIN_ROUTES) {
      expect((await admin(server, route)).status, `${route} without credentials`).toBe(401);
      expect((await admin(server, route, bearer(API_KEY))).status, `${route} with the API key`).toBe(401);
      expect((await admin(server, route, bearer("wrong-token-000000000000"))).status, `${route} with a wrong token`).toBe(401);
    }
  });

  test("the control token reaches the handlers, and never opens the public API", async () => {
    const server = serve();
    // A wrong-shaped body is a 400 from the handler, not a 401: the token was accepted.
    const reached = await admin(server, "/admin/cancel-turn", bearer(CONTROL_TOKEN));
    expect(reached.status).toBe(400);

    // The token is not an API credential: the public surface still refuses it.
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(CONTROL_TOKEN) })).status).toBe(401);
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(API_KEY) })).status).toBe(200);
  });
});

describe("admin control surface — draining", () => {
  test("/admin/drain stops accepting turns and /admin/resume restores them", async () => {
    const server = serve();
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(API_KEY) })).status).toBe(200);

    const drained = await control(server, "/admin/drain");
    expect(drained.status).toBe(200);
    expect(await drained.json()).toMatchObject({ status: "ok", accepting_turns: false });

    // Both the health check the container waits on and the public surface observe the drain.
    const health = await (await fetch(url(server, "/healthz"))).json() as { accepting_turns: boolean };
    expect(health.accepting_turns).toBe(false);
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(API_KEY) })).status).toBe(503);

    const resumed = await control(server, "/admin/resume");
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ status: "ok", accepting_turns: true });
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(API_KEY) })).status).toBe(200);
  });
});

describe("admin control surface — cancellation and shutdown", () => {
  test("cancel-turn validates its trace id and answers with the cancellation shape", async () => {
    const server = serve();
    for (const traceId of ["", "short", "with/slash", 42]) {
      const refused = await control(server, "/admin/cancel-turn", { traceId });
      expect(refused.status, `traceId ${JSON.stringify(traceId)}`).toBe(400);
      expect((await refused.json() as { status?: string }).status).toBe("error");
    }

    const cancelled = await control(server, "/admin/cancel-turn", { traceId: "issue-247-trace-1" });
    expect(cancelled.status).toBe(200);
    const body = await cancelled.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.trace_id).toBe("issue-247-trace-1");
    for (const field of [
      "cancelled_browser_turns", "cancelled_broker_turns", "cancelled_compaction_runs",
      "active_http_turns", "active_browser_turns",
    ]) {
      expect(typeof body[field], field).toBe("number");
    }
  });

  test("interrupt-turn validates both native identities and answers with the cancellation shape", async () => {
    const server = serve();
    for (const candidate of [{}, { threadId: "short" }, { threadId: "thread_123456" }, { threadId: "thread_123456", turnId: "bad/slash" }]) {
      const refused = await control(server, "/admin/interrupt-turn", candidate);
      expect(refused.status, JSON.stringify(candidate)).toBe(400);
    }

    const interrupted = await control(server, "/admin/interrupt-turn", { threadId: "thread_123456", turnId: "turn_123456" });
    expect(interrupted.status).toBe(200);
    const body = await interrupted.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    for (const field of ["cancelled_http_turns", "cancelled_browser_turns", "cancelled_compaction_runs"]) {
      expect(typeof body[field], field).toBe("number");
    }
  });

  test("cancel-turns cancels every owner and reports the counts", async () => {
    const server = serve();
    const body = await (await control(server, "/admin/cancel-turns")).json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    for (const field of [
      "cancelled_http_turns", "cancelled_browser_turns", "cancelled_compaction_runs",
      "active_http_turns", "active_browser_turns",
    ]) {
      expect(typeof body[field], field).toBe("number");
    }
  });

  test("shutdown is refused until the listener is draining, then accepted", async () => {
    const server = serve();

    const refused = await control(server, "/admin/shutdown");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ status: "refused", accepting_turns: true });

    expect((await control(server, "/admin/drain")).status).toBe(200);
    const accepted = await control(server, "/admin/shutdown");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "ok", accepting_turns: false });

    // The cleanup runs on the next tick; let it settle before teardown.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe("/healthz — the shape every health check reads, with nothing sensitive in it", () => {
  test("the body is the documented status document", async () => {
    const config = makeConfig();
    const server = serve(config);
    const response = await fetch(url(server, "/healthz"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("dsh-chatgpt-web");
    expect(body.version).toBe(VERSION);
    expect(body.mode).toBe("browser-only");
    expect(body.pid).toBe(process.pid);
    // The document reports the port the listener is actually bound to. The config asks for an
    // ephemeral port (`port: 0`), so echoing the configured value would tell an operator or supervisor
    // "0" and leave them unable to reach the service; the assigned port must be reported instead.
    expect(config.port).toBe(0);
    expect(typeof body.port).toBe("number");
    expect(body.port).toBeGreaterThan(0);
    expect(body.port).toBe(server.port);
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime as number).toBeGreaterThanOrEqual(0);
    expect(body.accepting_turns).toBe(true);
    expect(typeof body.successful_model_catalog_requests).toBe("number");
    expect(body.successful_model_catalog_requests).toBe(0);
    expect(body.last_successful_model_catalog_request_at).toBeNull();
    expect(typeof body.active_http_turns).toBe("number");
    expect(typeof body.active_browser_turns).toBe("number");
  });

  test("a successful catalogue request is counted, and the counter is a real timestamp", async () => {
    const server = serve();
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(API_KEY) })).status).toBe(200);

    const body = await (await fetch(url(server, "/healthz"))).json() as {
      successful_model_catalog_requests: number;
      last_successful_model_catalog_request_at: string | null;
    };
    expect(body.successful_model_catalog_requests).toBe(1);
    expect(typeof body.last_successful_model_catalog_request_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.last_successful_model_catalog_request_at!))).toBe(false);
  });

  test("it never echoes a credential", async () => {
    const server = serve();
    const raw = await (await fetch(url(server, "/healthz"))).text();
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(CONTROL_TOKEN);
    // The status document is not the diagnostic dump: it carries no data-directory or storage path.
    expect(raw).not.toContain("storageStatePath");
    expect(raw).not.toContain(home);
  });
});

describe("/v1/control/status — the operator status document reports the bound port, like /healthz", () => {
  test("with an ephemeral configured port, the status port is the listening one and never 0", async () => {
    // The same defect `/healthz` had (issue #287 slice 4a): the control document echoed `config.port`,
    // which is the *requested* port. With `port: 0` the OS assigns the real one, so an operator or a
    // supervisor reading this document would be told "0" and could not reach the service.
    const config = makeConfig();
    const server = serve(config);
    const response = await fetch(url(server, "/v1/control/status"), { headers: bearer(CONTROL_TOKEN) });
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(config.port).toBe(0);
    expect(typeof body.port).toBe("number");
    expect(body.port).toBeGreaterThan(0);
    expect(body.port).toBe(server.port);
    // The two surfaces publish the same fact and can never disagree about the bound port.
    const health = await (await fetch(url(server, "/healthz"))).json() as { port: number };
    expect(body.port).toBe(health.port);
  });
});
