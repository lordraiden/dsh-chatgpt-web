/**
 * Issue #360 — the operator settings page.
 *
 * The page is one static document served at `GET /v1/control/settings/` (and `/index.html`), exactly
 * like the sign-in and endpoint-profiles pages: anonymous by design, control token in
 * `sessionStorage`, no data in the body, no absolute URL, no secret. This suite pins the properties
 * that make it safe and usable:
 *
 * - it is served at both paths and carries no data, token, key or external URL;
 * - its inline script **compiles** — the regression the endpoint-profiles page shipped a defect for:
 *   a template-literal escape that resolves into the served script kills every handler at parse time;
 * - the token flow sends the control token as a bearer header and never in a URL;
 * - the routing generator renders the per-operation `HINDSIGHT_API_*_LLM_*` block for a configured
 *   bridge profile, for an external base URL and for `disabled`, with placeholders instead of secrets;
 * - the chat form writes through the **existing** `PUT /v1/control/config` and surfaces the
 *   configuration owner's refusal instead of validating anything itself;
 * - every data-carrying endpoint the page calls stays control-token only, and the doctor route runs
 *   the injected probe only after the token is accepted.
 *
 * The page script is executed in a minimal DOM shim (no dependency): the shim pre-creates one element
 * per `id` in the served document, records `addEventListener` handlers and awaits them on `dispatch`,
 * and routes `fetch` by path. That is enough to drive the real script the server serves, so the test
 * observes the page's own behaviour rather than a re-implementation of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig, loadConfig, saveConfig, type AppConfig } from "../src/config";
import type { DoctorReport } from "../src/doctor";
import { startServer, type RunningServer } from "../src/server";
import {
  WEB_CHAT_SETTINGS_PAGE_HTML,
  WEB_CHAT_SETTINGS_PAGE_PATHS,
} from "../src/web-chat/host/settings-page";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

const CONTROL_TOKEN = "issue-360-settings-control-token-0123456789";
const API_KEY = "issue-360-settings-api-key-0123456789";
const ACCOUNT_FINGERPRINT = "issue-360-account";

let home: string;
let savedHome: SavedChatGptWebHome;
let previousApiKey: string | undefined;
const running: RunningServer[] = [];

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-360-settings-", { clearFreeHome: true });
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
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    ...overrides,
  };
}

/** A configuration that can be persisted and loaded back (a real port, not the ephemeral `0`). */
function persistedConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return config({ port: 17_841, ...overrides });
}

const DOCTOR_REPORT: DoctorReport = {
  ok: true,
  mode: "browser-only",
  checks: [
    { id: "config", status: "ok", message: "Configuration is valid" },
    { id: "structured-output-probe", status: "ok", message: "the structured request was answered" },
  ],
};

function serve(
  value: AppConfig,
  dependencies: Parameters<typeof startServer>[1] = {},
): RunningServer {
  // Every suite here injects a deterministic doctor: the production default performs one real
  // browser turn, which a test must never do.
  const server = startServer(value, { doctor: async () => DOCTOR_REPORT, ...dependencies });
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string): string => `http://127.0.0.1:${server.port}${path}`;
const controlHeaders = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------
// The page script, executed in a minimal DOM shim.
// ---------------------------------------------------------------------------------------------------

interface ShimElement {
  id: string;
  tagName: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  placeholder: string;
  type: string;
  children: ShimElement[];
  textContent: string;
  appendChild(child: ShimElement): ShimElement;
  addEventListener(type: string, handler: (event: unknown) => unknown): void;
  dispatch(type: string, event?: unknown): Promise<void>;
}

function makeElement(tagName: string, id = ""): ShimElement {
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  const element = {
    id,
    tagName,
    className: "",
    hidden: false,
    disabled: false,
    value: "",
    placeholder: "",
    type: "",
    children: [] as ShimElement[],
    _text: "",
    appendChild(child: ShimElement): ShimElement {
      this.children.push(child);
      return child;
    },
    addEventListener(type: string, handler: (event: unknown) => unknown): void {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    async dispatch(type: string, event: unknown = { preventDefault() {} }): Promise<void> {
      for (const handler of listeners.get(type) ?? []) await handler(event);
    },
  };
  Object.defineProperty(element, "textContent", {
    get(): string {
      return this._text + this.children.map((child: ShimElement) => child.textContent).join("");
    },
    set(value: string): void {
      this._text = String(value);
      this.children.length = 0;
    },
  });
  return element as unknown as ShimElement;
}

/** The ids the served document declares, so every `getElementById` the script makes resolves. */
function documentIds(html: string): string[] {
  const ids: string[] = [];
  for (const match of html.matchAll(/id="([^"]+)"/g)) ids.push(match[1]!);
  return ids;
}

function inlineScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start + "<script>".length, end);
}

interface FetchCall {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

type RouteAnswer = { readonly status: number; readonly body: unknown } | unknown;

interface PageHarness {
  readonly document: {
    getElementById(id: string): ShimElement;
    createElement(tagName: string): ShimElement;
  };
  readonly storage: Map<string, string>;
  readonly calls: FetchCall[];
}

/**
 * Execute the exact script the server serves.
 *
 * `routes` is keyed by `"<METHOD> <path>"` (and by bare `path` for GET). An answer that is an object
 * with a numeric `status` is a refusal; anything else is a 200 JSON body.
 */
function runPage(
  html: string,
  routes: Record<string, RouteAnswer>,
  initialStorage: Record<string, string> = {},
): PageHarness {
  const elements = new Map<string, ShimElement>();
  for (const id of documentIds(html)) elements.set(id, makeElement("div", id));
  const documentShim = {
    getElementById(id: string): ShimElement {
      const element = elements.get(id);
      if (!element) throw new Error(`the page asked for an element the document does not declare: ${id}`);
      return element;
    },
    createElement(tagName: string): ShimElement {
      return makeElement(tagName);
    },
  };
  const storage = new Map<string, string>(Object.entries(initialStorage));
  const sessionStorage = {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
  };
  const calls: FetchCall[] = [];
  const fetchImpl = async (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    const method = init.method ?? "GET";
    calls.push({ path, method, headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
    const answer = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (answer === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: `no route for ${method} ${path}` }) };
    }
    if (typeof answer === "object" && answer !== null
      && typeof (answer as { status?: unknown }).status === "number") {
      const refusal = answer as { status: number; body: unknown };
      return { ok: false, status: refusal.status, json: async () => refusal.body };
    }
    return { ok: true, status: 200, json: async () => answer };
  };
  const location = { origin: "http://127.0.0.1:17841" };
  const navigator = { clipboard: { writeText: async () => undefined } };
  new Function("document", "sessionStorage", "location", "fetch", "navigator", inlineScript(html))(
    documentShim,
    sessionStorage,
    location,
    fetchImpl,
    navigator,
  );
  return { document: documentShim, storage, calls };
}

const TUNING_DEFAULTS = {
  composerCharLimit: 120_000,
  responseDomGraceMs: 60_000,
  responseDomGraceMaxMs: 240_000,
  responseDomGracePerCharMs: 2.5,
  sendEnableGraceMs: 5_000,
  generationRunningStallMs: 900_000,
};

const CONFIG_PAYLOAD = {
  tuning: {},
  effective: TUNING_DEFAULTS,
  defaults: TUNING_DEFAULTS,
  chatVisibility: "persistent",
  effectiveChatVisibility: "persistent",
  endpointProfiles: [
    {
      name: "hidden",
      path: "/p/hidden",
      chatVisibility: "temporary",
      models: ["chatgpt-web/luna"],
      maxConcurrentTurns: 1,
    },
  ],
};

const STATUS_PAYLOAD = {
  status: "ok",
  service: "dsh-chatgpt-web",
  version: "1.1.3",
  mode: "browser-only",
  accepting_turns: true,
  solAvailable: false,
  proAvailable: false,
  uptime: 42,
  turnQueue: {
    capacity: 4,
    waitBudgetMs: 600_000,
    maxWaiters: 16,
    maxPerCaller: 3,
    retryAfterSeconds: 5,
    depth: 0,
    grants: 0,
    active: 0,
    granted: 3,
    refused: 0,
    waitMsTotal: 12,
    waitMsMax: 7,
    activeLeases: 0,
    callers: [],
  },
  turnAccounting: {
    requests: 3,
    browserTurns: 3,
    replayTurns: 2,
    continuationTurns: 1,
    replayMessages: 5,
    replayChars: 1_200,
    waitMsTotal: 12,
    waitMsMax: 7,
    turnMsTotal: 9_000,
    turnMsMax: 4_000,
    recent: [],
    operations: [
      {
        operation: "1a2b3c4d5e6f",
        requests: 3,
        browserTurns: 3,
        replayTurns: 2,
        continuationTurns: 1,
        replayMessages: 5,
        replayChars: 1_200,
        waitMsTotal: 12,
        waitMsMax: 7,
        turnMsTotal: 9_000,
        turnMsMax: 4_000,
        lastSeenAt: 1,
      },
    ],
  },
};

const HEALTH_PAYLOAD = {
  ok: true,
  checkedAt: "2026-11-15T00:00:00.000Z",
  cache: { ttlMs: 60_000 },
  providers: [
    {
      providerId: "chatgpt-web",
      label: "ChatGPT Web",
      state: "verified",
      capturePresent: true,
      verifiedAt: "2026-11-15T00:00:00.000Z",
      checkedAt: "2026-11-15T00:00:00.000Z",
      code: null,
      reason: null,
    },
  ],
};

const CATALOGUE_PAYLOAD = {
  models: [{ slug: "chatgpt-web/luna", display_name: "Luna", default_reasoning_level: "normal" }],
};

function pageRoutes(overrides: Record<string, RouteAnswer> = {}): Record<string, RouteAnswer> {
  return {
    "../config": CONFIG_PAYLOAD,
    "../status": STATUS_PAYLOAD,
    "../catalogue": CATALOGUE_PAYLOAD,
    "../auth/health": HEALTH_PAYLOAD,
    "PUT ../config": { status: "ok" },
    "POST ../doctor": DOCTOR_REPORT,
    ...overrides,
  };
}

/** Run the page and accept the token, so every section is rendered. */
async function loadedPage(overrides: Record<string, RouteAnswer> = {}): Promise<PageHarness> {
  const harness = runPage(WEB_CHAT_SETTINGS_PAGE_HTML, pageRoutes(overrides));
  harness.document.getElementById("token").value = CONTROL_TOKEN;
  // `dispatch` awaits the submit handler, which awaits its own load: every section is rendered when
  // this resolves, with no timer and no polling.
  await harness.document.getElementById("token-form").dispatch("submit");
  return harness;
}

// ---------------------------------------------------------------------------------------------------
// Serving, secrecy and the compile guard.
// ---------------------------------------------------------------------------------------------------

describe("issue #360 — the settings page is served anonymously and carries nothing secret", () => {
  test("both paths serve the same static document", async () => {
    const server = serve(config());
    for (const path of WEB_CHAT_SETTINGS_PAGE_PATHS) {
      const response = await fetch(url(server, path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("connect-src 'self'");
      expect(policy).toContain("form-action 'none'");
      expect(await response.text()).toBe(WEB_CHAT_SETTINGS_PAGE_HTML);
    }
  });

  test("the document carries no data, no secret and no external URL", () => {
    const html = WEB_CHAT_SETTINGS_PAGE_HTML;
    expect(/https?:\/\//.test(html)).toBe(false);
    expect(html).toContain("sessionStorage");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain(CONTROL_TOKEN);
    expect(html).not.toContain(API_KEY);
    // The page is a client of the existing surfaces, never a second management surface.
    expect(html).toContain("../config");
    expect(html).toContain("../status");
    expect(html).toContain("../catalogue");
    expect(html).toContain("../auth/health");
    expect(html).toContain("../doctor");
    expect(html).toContain("../endpoints/");
    expect(html).toContain("../auth/");
    // The doctor button states its cost.
    expect(html).toContain("one real browser turn");
  });

  test("the served inline script compiles", () => {
    // A template-literal escape that resolves into the page (for example a newline written as an
    // escape, or a `\/` inside a regex) breaks the whole script at parse time, which silently
    // disables every handler. Compiling the exact string the server serves is the only check that
    // catches it — the same guard the endpoint-profiles page has (issue #356).
    expect(() => new Function(inlineScript(WEB_CHAT_SETTINGS_PAGE_HTML))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------
// The page's own behaviour, driven through the served script.
// ---------------------------------------------------------------------------------------------------

describe("issue #360 — the page script drives the existing control surface", () => {
  test("the token flow sends the bearer header and never puts the token in a URL", async () => {
    const harness = runPage(WEB_CHAT_SETTINGS_PAGE_HTML, pageRoutes());
    harness.document.getElementById("token").value = CONTROL_TOKEN;
    await harness.document.getElementById("token-form").dispatch("submit");

    expect(harness.storage.get("dsh-chatgpt-web.control-token")).toBe(CONTROL_TOKEN);
    expect(harness.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of harness.calls) {
      expect(call.headers.Authorization, `${call.method} ${call.path}`).toBe(`Bearer ${CONTROL_TOKEN}`);
      expect(call.path).not.toContain(CONTROL_TOKEN);
      expect(call.path.startsWith("../")).toBe(true);
    }
    expect(harness.calls.map(call => call.path)).toEqual(
      expect.arrayContaining(["../config", "../status", "../catalogue", "../auth/health"]),
    );
    // The status section rendered what the service reported, including the capability and counters.
    expect(harness.document.getElementById("status-list").textContent).toContain("1.1.3");
    expect(harness.document.getElementById("status-list").textContent).toContain("Free");
    expect(harness.document.getElementById("queue").textContent).toContain("capacity 4");
    expect(harness.document.getElementById("accounting").textContent).toContain("1a2b3c4d5e6f");
    expect(harness.document.getElementById("health").textContent).toContain("verified");
    expect(harness.document.getElementById("catalogue").textContent).toContain("chatgpt-web/luna");
    expect(harness.document.getElementById("status").textContent).toBe("Settings loaded.");
  });

  test("a refused token shows the refusal and keeps the token card", async () => {
    const harness = runPage(WEB_CHAT_SETTINGS_PAGE_HTML, {
      "../config": { status: 401, body: { error: "Unauthorized" } },
      "../status": { status: 401, body: { error: "Unauthorized" } },
      "../catalogue": { status: 401, body: { error: "Unauthorized" } },
      "../auth/health": { status: 401, body: { error: "Unauthorized" } },
    });
    harness.document.getElementById("token").value = "wrong-token-000000000000";
    await harness.document.getElementById("token-form").dispatch("submit");
    expect(harness.document.getElementById("status").textContent).toBe("That control token was refused.");
    expect(harness.document.getElementById("token-card").hidden).toBe(false);
    expect(harness.document.getElementById("status-card").hidden).toBe(true);
  });
});

describe("issue #360 — the routing generator writes an environment block, never a secret", () => {
  test("a chosen bridge profile renders the per-operation block", async () => {
    const harness = await loadedPage();
    const env = harness.document.getElementById("env");
    // Nothing is selected yet: every operation is explicitly disabled.
    expect(env.textContent).toContain("# retain → disabled");
    expect(env.textContent).toContain("# consolidation → disabled");
    expect(env.textContent).toContain("# reflect → disabled");
    expect(env.textContent).not.toContain("HINDSIGHT_API_RETAIN_LLM_");

    const target = harness.document.getElementById("target-retain");
    target.value = "profile:hidden";
    await target.dispatch("change");

    const block = env.textContent;
    expect(block).toContain("# retain → bridge profile hidden");
    expect(block).toContain("HINDSIGHT_API_RETAIN_LLM_PROVIDER=openai");
    expect(block).toContain("HINDSIGHT_API_RETAIN_LLM_BASE_URL=http://127.0.0.1:17841/p/hidden/v1");
    expect(block).toContain("HINDSIGHT_API_RETAIN_LLM_API_KEY=<the bridge API key>");
    expect(block).toContain("HINDSIGHT_API_RETAIN_LLM_MODEL=chatgpt-web/luna");
    // The other operations stay disabled, and no secret is ever rendered.
    expect(block).toContain("# consolidation → disabled");
    expect(block).toContain("# reflect → disabled");
    expect(block).not.toContain(API_KEY);
    expect(block).not.toContain(CONTROL_TOKEN);
  });

  test("an external base URL is normalized and gets its own placeholders", async () => {
    const harness = await loadedPage();
    const target = harness.document.getElementById("target-reflect");
    target.value = "external";
    await target.dispatch("change");
    const external = harness.document.getElementById("external-reflect");
    external.value = "https://api.example.com/";
    await external.dispatch("input");

    const block = harness.document.getElementById("env").textContent;
    expect(block).toContain("# reflect → external base URL");
    expect(block).toContain("HINDSIGHT_API_REFLECT_LLM_BASE_URL=https://api.example.com/v1");
    expect(block).toContain("HINDSIGHT_API_REFLECT_LLM_API_KEY=<that provider's API key>");
    expect(block).toContain("HINDSIGHT_API_REFLECT_LLM_MODEL=<model id>");
    // A base URL that already names /v1 is not doubled.
    external.value = "https://api.example.com/v1";
    await external.dispatch("input");
    expect(harness.document.getElementById("env").textContent)
      .toContain("HINDSIGHT_API_REFLECT_LLM_BASE_URL=https://api.example.com/v1");
    expect(harness.document.getElementById("env").textContent)
      .not.toContain("https://api.example.com/v1/v1");
    // A scheme-less host means the usual https origin.
    external.value = "api.example.com";
    await external.dispatch("input");
    expect(harness.document.getElementById("env").textContent)
      .toContain("HINDSIGHT_API_REFLECT_LLM_BASE_URL=https://api.example.com/v1");
  });

  test("a model the operator types wins over the profile default", async () => {
    const harness = await loadedPage();
    const target = harness.document.getElementById("target-consolidation");
    target.value = "profile:hidden";
    await target.dispatch("change");
    const model = harness.document.getElementById("model-consolidation");
    model.value = "chatgpt-web/light";
    await model.dispatch("input");
    expect(harness.document.getElementById("env").textContent)
      .toContain("HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=chatgpt-web/light");
  });
});

describe("issue #360 — the chat form writes through the existing PUT /v1/control/config", () => {
  test("the page posts only what the operator set, with the bearer header", async () => {
    const harness = await loadedPage();
    harness.document.getElementById("visibility").value = "temporary";
    harness.document.getElementById("t-composerCharLimit").value = "90000";
    await harness.document.getElementById("chat-form").dispatch("submit");

    const write = harness.calls.find(call => call.method === "PUT");
    expect(write?.path).toBe("../config");
    expect(write?.headers.Authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
    expect(JSON.parse(write!.body!)).toEqual({
      chatVisibility: "temporary",
      tuning: { composerCharLimit: 90_000 },
    });
    expect(harness.document.getElementById("status").textContent).toBe("Chat settings saved.");
  });

  test("an invalid value is refused by the configuration owner and shown, not clamped", async () => {
    const harness = await loadedPage({
      "PUT ../config": {
        status: 400,
        body: { status: "error", error: "Invalid tuning.composerCharLimit in control API" },
      },
    });
    harness.document.getElementById("t-composerCharLimit").value = "-5";
    await harness.document.getElementById("chat-form").dispatch("submit");
    expect(harness.document.getElementById("status").textContent)
      .toBe("Could not save: Invalid tuning.composerCharLimit in control API");
  });

  test("the real write path rejects an invalid value and accepts a valid one", async () => {
    saveConfig(persistedConfig());
    const server = serve(loadConfig());

    const refused = await fetch(url(server, "/v1/control/config"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ tuning: { composerCharLimit: -1 } }),
    });
    expect(refused.status).toBe(400);
    expect(String((await json(refused)).error)).toContain("Invalid tuning.composerCharLimit");

    const accepted = await fetch(url(server, "/v1/control/config"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ chatVisibility: "temporary", tuning: { composerCharLimit: 90_000 } }),
    });
    expect(accepted.status).toBe(200);
    const body = await json(accepted);
    expect(body.chatVisibility).toBe("temporary");
    expect(body.tuning).toEqual({ composerCharLimit: 90_000 });
  });
});

// ---------------------------------------------------------------------------------------------------
// Authority boundary and the doctor probe.
// ---------------------------------------------------------------------------------------------------

describe("issue #360 — every data-carrying endpoint stays control-token only", () => {
  test("the page's endpoints refuse an absent, wrong or API-key credential", async () => {
    const server = serve(config());
    const routes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "GET", path: "/v1/control/config" },
      { method: "PUT", path: "/v1/control/config", body: { chatVisibility: "persistent" } },
      { method: "GET", path: "/v1/control/status" },
      { method: "GET", path: "/v1/control/catalogue" },
      { method: "GET", path: "/v1/control/auth/health" },
      { method: "POST", path: "/v1/control/doctor" },
    ];
    const credentialVariants: Array<Record<string, string>> = [
      {},
      { authorization: `Bearer ${API_KEY}` },
      { authorization: "Bearer wrong-token-000000000000" },
    ];
    for (const route of routes) {
      for (const headers of credentialVariants) {
        const response = await fetch(url(server, route.path), {
          method: route.method,
          headers: { "content-type": "application/json", ...headers },
          ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        });
        expect(response.status, `${route.method} ${route.path} with ${JSON.stringify(headers)}`).toBe(401);
      }
    }
  });

  test("the catalogue view reuses the catalogue owner and carries no credential", async () => {
    const server = serve(config());
    const response = await fetch(url(server, "/v1/control/catalogue"), { headers: controlHeaders });
    expect(response.status).toBe(200);
    const body = await json(response);
    const models = body.models as Array<Record<string, unknown>>;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(model => model.slug === "chatgpt-web/luna")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(JSON.stringify(body)).not.toContain(CONTROL_TOKEN);
  });

  test("the doctor route runs the probe only after the token is accepted", async () => {
    let runs = 0;
    const server = serve(config(), {
      doctor: async () => {
        runs += 1;
        return DOCTOR_REPORT;
      },
    });

    const unauthorized = await fetch(url(server, "/v1/control/doctor"), { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(runs).toBe(0);

    const authorized = await fetch(url(server, "/v1/control/doctor"), {
      method: "POST",
      headers: controlHeaders,
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json() as unknown).toEqual(DOCTOR_REPORT);
    expect(runs).toBe(1);
  });

  test("the page renders a doctor report without any credential", async () => {
    const harness = await loadedPage();
    await harness.document.getElementById("run-doctor").dispatch("click");
    const report = harness.document.getElementById("doctor-report").textContent;
    expect(report).toContain("Doctor result: ready");
    expect(report).toContain("structured-output-probe");
    expect(report).not.toContain(CONTROL_TOKEN);
    expect(harness.document.getElementById("status").textContent).toBe("Doctor: ready.");
  });
});
