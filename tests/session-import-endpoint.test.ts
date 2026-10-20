import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config";
import { AUTH_IMPORT_MAX_BODY_BYTES, startServer, type RunningServer } from "../src/server";
import {
  DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
  chatGptWebAuthImportProvider,
  deepSeekWebAuthImportProvider,
  qwenCodeAuthImportProvider,
  type AuthImportProvider,
} from "../src/auth-import";
import { CHATGPT_WEB_AUTH_PROVIDER_ID } from "../src/adapters/chatgpt-web/auth-controller";
import { QWEN_CODE_PROVIDER_ID } from "../src/adapters/qwen-code/provider";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * The generic session-import endpoint, `POST /v1/control/auth/import`.
 *
 * The contract is fixed by the Harness plugin being written against it:
 *
 *   body      { "provider": "chatgpt-web" | "qwen-code" | "deepseek-web", "storageState": {...} }
 *   success   { "ok": true, "provider", "verified", "verifiedAt", "storedAt" }
 *   refusal   4xx { "ok": false, "code", "message" }
 *
 * The suite runs the REAL listener with deterministic import descriptors (a fake ChatGPT
 * predicate, the Qwen probe seam, the real capture-only DeepSeek descriptor): no browser, no
 * network and no provider account. It proves the one-policy seam, the layout each provider lands
 * in, the refusal codes, the authority boundary, and that no response body ever echoes a cookie.
 */

const API_KEY = "session-import-api-key-0123456789";
const CONTROL_TOKEN = "session-import-control-token-0123456789";
const NOW = Date.UTC(2026, 9, 19, 21, 0, 0);

const SECRET_CHATGPT = "SECRET-CHATGPT-COOKIE-VALUE";
const SECRET_QWEN = "SECRET-QWEN-COOKIE-VALUE";
const SECRET_QWEN_LOCAL = "SECRET-QWEN-LOCAL-STORAGE-VALUE";
const SECRET_DEEPSEEK = "SECRET-DEEPSEEK-COOKIE-VALUE";
const SECRET_DEEPSEEK_LOCAL = "SECRET-DEEPSEEK-LOCAL-STORAGE-VALUE";
const SECRET_FOREIGN = "SECRET-FOREIGN-COOKIE-VALUE";
/** The page's own token, read from the live page. Asserted absent from every response body. */
const SECRET_QWEN_PAGE_TOKEN = "SECRET-QWEN-PAGE-TOKEN-VALUE";
/** A leftover token in a stale capture's state; it must never be what the probe sends. */
const SECRET_QWEN_STALE_TOKEN = "SECRET-QWEN-STALE-TOKEN-VALUE";
const SECRETS = [
  SECRET_CHATGPT,
  SECRET_QWEN,
  SECRET_QWEN_LOCAL,
  SECRET_DEEPSEEK,
  SECRET_DEEPSEEK_LOCAL,
  SECRET_FOREIGN,
  SECRET_QWEN_PAGE_TOKEN,
  SECRET_QWEN_STALE_TOKEN,
];

const AUTHENTICATED_TASK_LIST = {
  success: true,
  request_id: "request-fixture",
  data: [{ id: "chat-fixture" }],
};

const ANONYMOUS_TASK_LIST = {
  success: false,
  request_id: "request-fixture",
  data: { code: "Unauthorized", details: "401 Unauthorized" },
};

function cookie(domain: string, value: string, expires = -1) {
  return { name: "session", value, domain, path: "/", expires, httpOnly: true, secure: true, sameSite: "Lax" as const };
}

const CHATGPT_STATE = {
  cookies: [cookie(".chatgpt.com", SECRET_CHATGPT)],
  origins: [{ origin: "https://chatgpt.com", localStorage: [] }],
};

const QWEN_STATE = {
  cookies: [
    cookie(".qwen.ai", SECRET_QWEN, 1_893_456_000),
    cookie(".doubleclick.net", SECRET_FOREIGN, 1_893_456_000),
  ],
  origins: [
    { origin: "https://coder.qwen.ai", localStorage: [{ name: "token", value: SECRET_QWEN_LOCAL }] },
    { origin: "https://example.invalid", localStorage: [] },
  ],
};

const DEEPSEEK_STATE = {
  cookies: [cookie(".deepseek.com", SECRET_DEEPSEEK)],
  origins: [],
};

const savedHome = captureChatGptWebHome();
const homes: string[] = [];
const running: RunningServer[] = [];
let home: string;

beforeEach(() => {
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
  home = useTemporaryChatGptWebHome("dsh-session-import-endpoint-");
  homes.push(home);
});

afterEach(async () => {
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  while (homes.length > 0) {
    try { rmSync(homes.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  restoreChatGptWebHome(savedHome);
});

function serve(providers: readonly AuthImportProvider[], now: () => number = () => NOW): RunningServer {
  const server = startServer(
    { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN },
    { authImport: { providers, now } },
  );
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const controlHeaders = { ...bearer(CONTROL_TOKEN), "content-type": "application/json" };

/** ChatGPT with its browser predicate replaced by a deterministic fake; the real store remains. */
function chatGptImport(options: { readonly failWith?: Error } = {}): AuthImportProvider {
  const base = chatGptWebAuthImportProvider(defaultConfig());
  return {
    ...base,
    authenticate: async state => {
      if (options.failWith) throw options.failWith;
      return {
        storageState: state,
        detail: "Account surface: https://chatgpt.com/",
        evidence: {},
        verified: true,
      };
    },
  };
}

/** Qwen with the probe seam; its real capture validation and store remain. */
function qwenImport(
  payload: unknown = AUTHENTICATED_TASK_LIST,
  options: { readonly onProbe?: () => void } = {},
): AuthImportProvider {
  return qwenCodeAuthImportProvider({
    probe: async () => {
      options.onProbe?.();
      return { status: 200, payload };
    },
  });
}


/**
 * A simulated provider page.
 *
 * `states` is the page's own successive answers to the token read (the first entries model the app
 * repairing a stale capture state), and every request the probe issues from the page is recorded.
 */
function simulatedQwenPage(
  states: readonly (string | undefined)[],
  payload: unknown,
  sent: Record<string, string>[],
) {
  let readIndex = 0;
  const page = {
    evaluate: async (_fn: unknown, arg?: Record<string, unknown>) => {
      if (typeof arg?.["accessKey"] === "string") {
        const state = states[Math.min(readIndex, states.length - 1)];
        readIndex += 1;
        return { state, legacy: undefined };
      }
      sent.push({ ...(arg?.["headers"] as Record<string, string>) });
      return { status: 200, contentType: "application/json", text: JSON.stringify(payload) };
    },
  } as unknown as Page;
  return async () => ({ page, close: async () => {} });
}

/** Wait for the app itself, not a timer, but keep the suite fast. */
const FAST_HYDRATION = { timeoutMs: 500, pollIntervalMs: 5 } as const;

/** Wrap one descriptor so a test can prove the single writer was (or was not) reached. */
function tracked(provider: AuthImportProvider): { provider: AuthImportProvider; stores: () => number } {
  let stores = 0;
  return {
    provider: {
      ...provider,
      store: authentication => {
        stores += 1;
        return provider.store(authentication);
      },
    },
    stores: () => stores,
  };
}

interface ImportResponse {
  readonly status: number;
  readonly text: string;
  readonly json: () => Record<string, unknown>;
}

async function postImport(
  server: RunningServer,
  body: unknown,
  headers: Record<string, string> = controlHeaders,
): Promise<ImportResponse> {
  const response = await fetch(url(server, "/v1/control/auth/import"), {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("session import — a verified provider lands in its own layout once", () => {
  test("chatgpt-web: the capture is stored and the answer carries the verified shape", async () => {
    const chatgpt = tracked(chatGptImport());
    const server = serve([chatgpt.provider, qwenImport(), deepSeekWebAuthImportProvider()]);

    const result = await postImport(server, {
      provider: CHATGPT_WEB_AUTH_PROVIDER_ID,
      storageState: CHATGPT_STATE,
    });
    const storedAt = join(home, "providers", CHATGPT_WEB_AUTH_PROVIDER_ID, "storage-state.json");

    expect(result.status).toBe(200);
    expect(result.json()).toEqual({
      ok: true,
      provider: CHATGPT_WEB_AUTH_PROVIDER_ID,
      verified: true,
      verifiedAt: new Date(NOW).toISOString(),
      storedAt,
    });
    expect(chatgpt.stores()).toBe(1);
    expect(existsSync(storedAt)).toBe(true);
    expect(existsSync(`${storedAt}.verified.json`)).toBe(true);
    expectNoSecret(result.text);
  });

  test("qwen-code: the capture is stored sanitized, in the provider's own layout, once", async () => {
    const qwen = tracked(qwenImport());
    const server = serve([chatGptImport(), qwen.provider, deepSeekWebAuthImportProvider()]);

    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: QWEN_STATE,
    });
    const storedAt = join(home, "providers", QWEN_CODE_PROVIDER_ID, "storage-state.json");

    expect(result.status).toBe(200);
    expect(result.json()).toEqual({
      ok: true,
      provider: QWEN_CODE_PROVIDER_ID,
      verified: true,
      verifiedAt: new Date(NOW).toISOString(),
      storedAt,
    });
    expect(qwen.stores()).toBe(1);

    const stored = JSON.parse(readFileSync(storedAt, "utf8")) as {
      cookies: { domain: string }[];
      origins: { origin: string }[];
    };
    // The importer's sanitizer is the same one the CLI applies: foreign domains/origins never land.
    expect(stored.cookies.map(entry => entry.domain)).toEqual([".qwen.ai"]);
    expect(stored.origins.map(entry => entry.origin)).toEqual(["https://coder.qwen.ai"]);

    const marker = JSON.parse(readFileSync(`${storedAt}.verified.json`, "utf8")) as {
      authenticated: boolean;
    };
    expect(marker.authenticated).toBe(true);
    expectNoSecret(result.text);
  });

  test("deepseek-web: the capture is stored, but verified is false and the answer says it is unusable", async () => {
    const deepseek = tracked(deepSeekWebAuthImportProvider());
    const server = serve([chatGptImport(), qwenImport(), deepseek.provider]);

    const result = await postImport(server, {
      provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
      storageState: DEEPSEEK_STATE,
    });
    const storedAt = join(home, "providers", DEEPSEEK_WEB_IMPORT_PROVIDER_ID, "storage-state.json");
    const body = result.json();

    expect(result.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
      verified: false,
      verifiedAt: null,
      storedAt,
    });
    expect(typeof body.message).toBe("string");
    expect(String(body.message)).toMatch(/not verified/i);
    expect(String(body.message)).toMatch(/no adapter/i);
    expect(String(body.message)).toMatch(/cannot be used/i);

    expect(deepseek.stores()).toBe(1);
    expect(existsSync(storedAt)).toBe(true);
    // No verified marker: every reader that gates on it must keep treating this as unverified.
    expect(existsSync(`${storedAt}.verified.json`)).toBe(false);
    // The capture itself carries the cookie value; the response never does.
    expect(readFileSync(storedAt, "utf8")).toContain(SECRET_DEEPSEEK);
    expectNoSecret(result.text);
  });

  test("deepseek-web: an unverified capture cannot inherit a stale verified marker", async () => {
    const server = serve([deepSeekWebAuthImportProvider()]);
    const directory = join(home, "providers", DEEPSEEK_WEB_IMPORT_PROVIDER_ID);
    const storedAt = join(directory, "storage-state.json");
    const marker = `${storedAt}.verified.json`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      marker,
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: new Date(NOW).toISOString() })}\n`,
    );

    const result = await postImport(server, {
      provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
      storageState: DEEPSEEK_STATE,
    });

    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ verified: false, verifiedAt: null });
    expect(existsSync(marker)).toBe(false);
  });

  test("deepseek-web: an origins-only capture is accepted because no adapter has declared where the token lives", async () => {
    const server = serve([deepSeekWebAuthImportProvider()]);
    const state = {
      cookies: [],
      origins: [{
        origin: "https://chat.deepseek.com",
        localStorage: [{ name: "token", value: SECRET_DEEPSEEK_LOCAL }],
      }],
    };

    const result = await postImport(server, {
      provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
      storageState: state,
    });

    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ verified: false, verifiedAt: null });
    const storedAt = join(home, "providers", DEEPSEEK_WEB_IMPORT_PROVIDER_ID, "storage-state.json");
    expect(JSON.parse(readFileSync(storedAt, "utf8"))).toEqual(state);
    expectNoSecret(result.text);
  });
});

describe("session import — caller capture problems are 4xx with the pipeline's own codes", () => {
  test("a capture with no cookies is import_empty and writes nothing", async () => {
    const qwen = tracked(qwenImport());
    const server = serve([qwen.provider]);
    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: { cookies: [], origins: [] },
    });

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_empty" });
    expect(qwen.stores()).toBe(0);
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
    expectNoSecret(result.text);
  });

  test("malformed JSON is import_malformed and never quotes the body", async () => {
    const qwen = tracked(qwenImport());
    const server = serve([qwen.provider]);
    const result = await postImport(
      server,
      `{"provider":"${QWEN_CODE_PROVIDER_ID}","storageState":{"cookies":[{"value":"${SECRET_QWEN}`,
    );

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_malformed" });
    expect(result.text).not.toContain(SECRET_QWEN);
    expect(qwen.stores()).toBe(0);
  });

  test("a value that is not a storage state is import_shape_invalid and writes nothing", async () => {
    const qwen = tracked(qwenImport());
    const server = serve([qwen.provider]);
    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: { nope: true },
    });

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_shape_invalid" });
    expect(qwen.stores()).toBe(0);
  });

  test("a capture with only foreign cookies is import_foreign_domain and never reaches the probe", async () => {
    let probed = false;
    const qwen = tracked(qwenImport(AUTHENTICATED_TASK_LIST, { onProbe: () => { probed = true; } }));
    const server = serve([qwen.provider]);
    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: { cookies: [cookie(".example.com", SECRET_FOREIGN)], origins: [] },
    });

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_foreign_domain" });
    expect(probed).toBe(false);
    expect(qwen.stores()).toBe(0);
    expectNoSecret(result.text);
  });

  test("a capture whose provider cookies all expired is import_expired and writes nothing", async () => {
    const qwen = tracked(qwenImport());
    const server = serve([qwen.provider]);
    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: { cookies: [cookie(".qwen.ai", SECRET_QWEN, 1_000_000)], origins: [] },
    });

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_expired" });
    expect(qwen.stores()).toBe(0);
    expectNoSecret(result.text);
  });

  test("a predicate that answers unauthenticated is import_predicate_failed and writes nothing", async () => {
    const qwen = tracked(qwenImport(ANONYMOUS_TASK_LIST));
    const server = serve([qwen.provider]);
    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: QWEN_STATE,
    });

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_predicate_failed" });
    expect(qwen.stores()).toBe(0);
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
  });

  test("qwen-code: the live page's token is what the probe sends, and a refusal reports the answer", async () => {
    // The production assembly with a simulated page instead of a browser: the header asserted is the
    // one the service would send, built from the page the captured cookies opened — never from the
    // stale token entry the capture happens to carry.
    const sent: Record<string, string>[] = [];
    const liveState = JSON.stringify({
      token: SECRET_QWEN_PAGE_TOKEN, loggedOut: false, version: 1, expiresAt: 1_900_000_000_000,
    });
    const qwen = tracked(qwenCodeAuthImportProvider({
      openPage: simulatedQwenPage([liveState], ANONYMOUS_TASK_LIST, sent),
      hydration: FAST_HYDRATION,
    }));
    const server = serve([qwen.provider]);
    const result = await postImport(server, {
      provider: QWEN_CODE_PROVIDER_ID,
      storageState: {
        cookies: [cookie(".qwen.ai", SECRET_QWEN, 1_893_456_000)],
        origins: [{
          origin: "https://coder.qwen.ai",
          localStorage: [{
            name: "qwen_access_token_state",
            value: JSON.stringify({ token: SECRET_QWEN_STALE_TOKEN, loggedOut: true, version: 1 }),
          }],
        }],
      },
    });

    // The header the signed-in app itself sends, from the live page.
    expect(sent[0]?.authorization).toBe(`Bearer ${SECRET_QWEN_PAGE_TOKEN}`);
    expect(sent[0]?.authorization).not.toBe(`Bearer ${SECRET_QWEN_STALE_TOKEN}`);
    expect(sent[0]?.source).toBe("web");

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_predicate_failed" });
    expect(result.text).toContain("Unauthorized 401 Unauthorized");
    expect(result.text).toContain("carried the page's own token and was still refused");
    expect(qwen.stores()).toBe(0);
    expectNoSecret(result.text);
  });

  test("qwen-code: a page with no token gets the honest signed-out refusal, not a generic one", async () => {
    const sent: Record<string, string>[] = [];
    const qwen = tracked(qwenCodeAuthImportProvider({
      openPage: simulatedQwenPage([undefined], ANONYMOUS_TASK_LIST, sent),
      hydration: FAST_HYDRATION,
    }));
    const server = serve([qwen.provider]);
    const logged: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { logged.push(args.join(" ")); };
    let result;
    try {
      result = await postImport(server, {
        provider: QWEN_CODE_PROVIDER_ID,
        storageState: {
          cookies: [cookie(".qwen.ai", SECRET_QWEN, 1_893_456_000)],
          origins: [{ origin: "https://coder.qwen.ai", localStorage: [{ name: "theme", value: "dark" }] }],
        },
      });
    } finally {
      console.warn = originalWarn;
    }
    const refusalLog = logged.join("\n");

    expect(sent[0]?.authorization).toBeUndefined();
    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_predicate_failed" });
    // The operator (and the log) sees what the provider answered and the page's own verdict.
    expect(result.text).toContain("HTTP 200");
    expect(result.text).toContain("Unauthorized 401 Unauthorized");
    expect(result.text).toContain("does not consider itself signed in");
    expect(result.text).toContain("sign in again");
    expect(qwen.stores()).toBe(0);
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
    expectNoSecret(result.text);

    // The same evidence reaches the log, so the next person diagnoses from it instead of guessing.
    expect(refusalLog).toContain("auth_import_refused");
    expect(refusalLog).toContain("import_predicate_failed");
    expect(refusalLog).toContain("Unauthorized 401 Unauthorized");
    expect(refusalLog).toContain("does not consider itself signed in");
    expectNoSecret(refusalLog);
  });

  test("a ChatGPT predicate that fails is the same import_predicate_failed refusal", async () => {
    const chatgpt = tracked(chatGptImport({ failWith: new Error("the account surface was not authenticated") }));
    const server = serve([chatgpt.provider]);
    const result = await postImport(server, {
      provider: CHATGPT_WEB_AUTH_PROVIDER_ID,
      storageState: CHATGPT_STATE,
    });

    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ ok: false, code: "import_predicate_failed" });
    expect(chatgpt.stores()).toBe(0);
    expect(existsSync(join(home, "providers", CHATGPT_WEB_AUTH_PROVIDER_ID))).toBe(false);
  });

  test("an unregistered provider is a 404 naming one that exists, and no store runs", async () => {
    const server = serve([chatGptImport(), deepSeekWebAuthImportProvider()]);
    const result = await postImport(server, {
      provider: "not-a-provider",
      storageState: CHATGPT_STATE,
    });

    expect(result.status).toBe(404);
    expect(result.json()).toMatchObject({ ok: false, code: "import_provider_unknown" });
    expect(String(result.json().message)).toContain(CHATGPT_WEB_AUTH_PROVIDER_ID);
  });

  test("a body missing provider or storageState is import_invalid_request", async () => {
    const server = serve([deepSeekWebAuthImportProvider()]);

    for (const body of [{}, { provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID }, { storageState: DEEPSEEK_STATE }]) {
      const result = await postImport(server, body);
      expect(result.status).toBe(400);
      expect(result.json()).toMatchObject({ ok: false, code: "import_invalid_request" });
    }
  });
});

describe("session import — authority is the control token, exactly like the rest of /v1/control/*", () => {
  const validBody = { provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID, storageState: DEEPSEEK_STATE };

  test("anonymous, the API key and a wrong control token are refused; the control token opens it", async () => {
    const server = serve([deepSeekWebAuthImportProvider()]);

    const anonymous = await postImport(server, validBody, { "content-type": "application/json" });
    expect(anonymous.status).toBe(401);

    const apiKey = await postImport(server, validBody, { ...bearer(API_KEY), "content-type": "application/json" });
    expect(apiKey.status).toBe(401);

    const wrongControl = await postImport(server, validBody, {
      ...bearer(`${CONTROL_TOKEN}-wrong`),
      "content-type": "application/json",
    });
    expect(wrongControl.status).toBe(401);

    const control = await postImport(server, validBody);
    expect(control.status).toBe(200);
  });

  test("the endpoint does not exist under the API authority", async () => {
    const server = serve([deepSeekWebAuthImportProvider()]);

    // With the control token this is the public API surface, which refuses the non-API authority.
    const withControl = await fetch(url(server, "/v1/auth/import"), {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify(validBody),
    });
    expect(withControl.status).toBe(401);

    // With the API key the route still does not exist: there is no alias beside /v1/control/auth/import.
    const withApiKey = await fetch(url(server, "/v1/auth/import"), {
      method: "POST",
      headers: { ...bearer(API_KEY), "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(withApiKey.status).toBe(404);
  });
});

describe("session import — the body ceiling is the capture's, not the API's", () => {
  test("a wildly oversized body is 413 request_too_large and writes nothing", async () => {
    const deepseek = tracked(deepSeekWebAuthImportProvider());
    const server = serve([deepseek.provider]);
    const oversized = {
      provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
      storageState: {
        cookies: [cookie(".deepseek.com", "x".repeat(AUTH_IMPORT_MAX_BODY_BYTES))],
        origins: [],
      },
    };
    const payload = JSON.stringify(oversized);
    expect(payload.length).toBeGreaterThan(AUTH_IMPORT_MAX_BODY_BYTES);

    const result = await postImport(server, payload);

    expect(result.status).toBe(413);
    expect(result.json()).toMatchObject({ ok: false, code: "request_too_large" });
    expect(deepseek.stores()).toBe(0);
    expect(existsSync(join(home, "providers", DEEPSEEK_WEB_IMPORT_PROVIDER_ID))).toBe(false);
  });
});

describe("session import — stored files are private and the response is never the capture", () => {
  test("a stored session is mode 0600 and every response body is cookie-free", async () => {
    if (process.platform === "win32") return;
    const server = serve([chatGptImport(), qwenImport(), deepSeekWebAuthImportProvider()]);

    const responses = [
      await postImport(server, { provider: CHATGPT_WEB_AUTH_PROVIDER_ID, storageState: CHATGPT_STATE }),
      await postImport(server, { provider: QWEN_CODE_PROVIDER_ID, storageState: QWEN_STATE }),
      await postImport(server, { provider: DEEPSEEK_WEB_IMPORT_PROVIDER_ID, storageState: DEEPSEEK_STATE }),
      await postImport(server, { provider: QWEN_CODE_PROVIDER_ID, storageState: { cookies: [], origins: [] } }),
    ];

    for (const response of responses) {
      expectNoSecret(response.text);
      expect(response.text).not.toContain(SECRET_CHATGPT);
    }

    for (const providerId of [CHATGPT_WEB_AUTH_PROVIDER_ID, QWEN_CODE_PROVIDER_ID, DEEPSEEK_WEB_IMPORT_PROVIDER_ID]) {
      const storedAt = join(home, "providers", providerId, "storage-state.json");
      expect(statSync(storedAt).mode & 0o777).toBe(0o600);
    }
  });
});
