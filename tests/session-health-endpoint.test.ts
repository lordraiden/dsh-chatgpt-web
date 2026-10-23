import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import {
  AUTH_IMPORT_PROVIDER_IDS,
  authImportProvider,
  qwenChatAuthImportProvider,
  type AuthImportProvider,
} from "../src/auth-import";
import {
  createAuthHealthSurface,
  defaultAuthHealthProviders,
  type AuthHealthProvider,
} from "../src/auth-health";
import { AUTH_IMPORT_REFUSAL_CODES } from "../src/auth-import-errors";
import { CHATGPT_WEB_AUTH_PROVIDER_ID } from "../src/adapters/chatgpt-web/auth-controller";
import { QWEN_CODE_PROVIDER_ID } from "../src/adapters/qwen-code/provider";
import { QWEN_CHAT_PROVIDER_ID } from "../src/adapters/qwen-chat/provider";
import { DEEPSEEK_WEB_IMPORT_PROVIDER_ID } from "../src/auth-import";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * `GET /v1/control/auth/health` — does each stored session still verify, before a turn is sent?
 *
 * The suite runs the real listener with deterministic import descriptors (a fake predicate per
 * provider, the real Qwen Chat capture validator, the real capture-only DeepSeek descriptor), so
 * every state is reachable without a browser: present+verified, present+expired, absent and
 * unverifiable, plus the cache/single-flight/bound behaviour that keeps opening the page from
 * hammering a provider. No response body may echo a cookie, token, storage value or path.
 */

const CONTROL_TOKEN = "session-health-control-token-0123456789";
const API_KEY = "session-health-api-key-0123456789";
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const FUTURE = Math.floor(Date.UTC(2027, 0, 1) / 1_000);
const PAST = Math.floor(Date.UTC(2026, 0, 1) / 1_000);
const MARKER_VERIFIED_AT = "2026-10-22T13:51:35.003Z";

const SECRET_REFRESH = "SECRET-QWEN-REFRESH-TOKEN-VALUE";
const SECRET_COOKIE = "SECRET-QWEN-COOKIE-VALUE";
const SECRET_LOCAL = "SECRET-QWEN-LOCAL-STORAGE-VALUE";
const SECRET_CHATGPT = "SECRET-CHATGPT-COOKIE-VALUE";
const SECRET_DEEPSEEK = "SECRET-DEEPSEEK-COOKIE-VALUE";
const SECRETS = [SECRET_REFRESH, SECRET_COOKIE, SECRET_LOCAL, SECRET_CHATGPT, SECRET_DEEPSEEK];
const ROTATED_REFRESH = "ROTATED-QWEN-REFRESH-TOKEN-VALUE";

const savedHome = captureChatGptWebHome();
const homes: string[] = [];
const running: RunningServer[] = [];
let home: string;

beforeEach(() => {
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
  home = useTemporaryChatGptWebHome("dsh-session-health-");
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

const providerHome = (providerId: string): string => join(home, "providers", providerId);
const capturePath = (providerId: string): string => join(providerHome(providerId), "storage-state.json");

function writeCapture(providerId: string, value: unknown, verifiedAt = MARKER_VERIFIED_AT): string {
  const path = capturePath(providerId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (verifiedAt.length > 0) {
    writeFileSync(`${path}.verified.json`, `${JSON.stringify({
      version: 1,
      authenticated: true,
      verifiedAt,
    })}\n`, { mode: 0o600 });
  }
  return path;
}

/** A Qwen Chat capture the provider's own validator accepts, carrying sentinels for the leak check. */
function qwenChatCapture(options: { readonly expires?: number; readonly refresh?: string } = {}) {
  return {
    cookies: [
      {
        name: "refresh_token",
        value: options.refresh ?? SECRET_REFRESH,
        domain: ".qwen.ai",
        path: "/",
        expires: options.expires ?? FUTURE,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
      {
        name: "c",
        value: SECRET_COOKIE,
        domain: "chat.qwen.ai",
        path: "/",
        expires: options.expires ?? FUTURE,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [{
      origin: "https://chat.qwen.ai",
      localStorage: [{ name: "qwen_access_token_state", value: SECRET_LOCAL }],
    }],
  };
}

/** The provider's own refusal, as a real page reports it. */
const EXPIRED_SENTENCE = "Qwen Chat is not signed in: the live page's token has expired. "
  + "Sign in at /v1/control/auth/ (choose \"Qwen Chat\").";

/** A counting predicate over the accepted capture. */
function countingAuthenticate(
  answer: (state: unknown) => Promise<{ storageState: unknown }> | { storageState: unknown },
): { authenticate: (state: unknown) => Promise<{ storageState: unknown; detail: string; verified: true }>; calls: () => number } {
  let calls = 0;
  return {
    authenticate: async state => {
      calls += 1;
      const result = await answer(state);
      return {
        storageState: result.storageState as never,
        detail: "Authenticated: /api/v2/chats answered success:true (HTTP 200)",
        verified: true as const,
      };
    },
    calls: () => calls,
  };
}

/** One provider's health descriptor, its capture path and the import descriptor that proves it. */
function healthProvider(
  importProvider: AuthImportProvider,
  storageStatePath: string,
): AuthHealthProvider {
  return { storageStatePath, importProvider };
}

/** The four descriptors, with the Qwen Chat predicate replaced by `qwenChat`. */
function descriptors(qwenChat: AuthImportProvider): AuthImportProvider[] {
  const chatgptBase = authImportProvider(CHATGPT_WEB_AUTH_PROVIDER_ID, defaultConfig());
  const qwenCodeBase = authImportProvider(QWEN_CODE_PROVIDER_ID, defaultConfig());
  return [
    {
      ...chatgptBase,
      authenticate: async state => ({
        storageState: state,
        detail: "Account surface: https://chatgpt.com/",
        evidence: {},
        verified: true,
      }),
    },
    {
      ...qwenCodeBase,
      authenticate: async () => {
        throw new Error(EXPIRED_SENTENCE.replace("Qwen Chat", "Qwen Code"));
      },
    },
    qwenChat,
    authImportProvider(DEEPSEEK_WEB_IMPORT_PROVIDER_ID, defaultConfig()),
  ];
}

function healthProviders(providers: readonly AuthImportProvider[]): AuthHealthProvider[] {
  return providers.map(provider => healthProvider(provider, capturePath(provider.id)));
}

interface ServeOptions {
  readonly providers: readonly AuthImportProvider[];
  readonly now: () => number;
  readonly cacheTtlMs?: number;
  readonly probeTimeoutMs?: number;
}

function serve(options: ServeOptions): RunningServer {
  const server = startServer(
    { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN },
    {
      authImport: { providers: options.providers, now: options.now },
      authHealth: {
        providers: healthProviders(options.providers),
        now: options.now,
        ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
        ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      },
    },
  );
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const controlHeaders = { authorization: `Bearer ${CONTROL_TOKEN}` };

interface HealthResponse {
  readonly status: number;
  readonly text: string;
  json(): Record<string, unknown>;
}

async function getHealth(
  server: RunningServer,
  headers: Record<string, string> = controlHeaders,
): Promise<HealthResponse> {
  const response = await fetch(url(server, "/v1/control/auth/health"), { headers });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

function rowOf(response: HealthResponse, providerId: string): Record<string, unknown> {
  const body = response.json();
  const providers = (body.providers ?? []) as Record<string, unknown>[];
  const row = providers.find(entry => entry["providerId"] === providerId);
  if (row === undefined) throw new Error(`no health row for ${providerId}: ${response.text}`);
  return row;
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  // A path is not a credential, but the answer is not a filesystem report either.
  expect(text).not.toContain(home);
}

describe("session health — every state, from the pipeline's own predicate", () => {
  test("present+verified, present+expired, absent and unverifiable are all reported, with no secret", async () => {
    writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    writeCapture(CHATGPT_WEB_AUTH_PROVIDER_ID, {
      cookies: [{
        name: "session", value: SECRET_CHATGPT, domain: ".chatgpt.com", path: "/",
        expires: FUTURE, httpOnly: true, secure: true, sameSite: "Lax",
      }],
      origins: [],
    });
    writeCapture(DEEPSEEK_WEB_IMPORT_PROVIDER_ID, {
      cookies: [{
        name: "x", value: SECRET_DEEPSEEK, domain: ".deepseek.com", path: "/",
        expires: FUTURE, httpOnly: true, secure: true, sameSite: "Lax",
      }],
      origins: [],
    }, "");

    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const server = serve({ providers: descriptors({
      ...qwenChatAuthImportProvider({}),
      authenticate: qwenChat.authenticate,
    } as AuthImportProvider), now: () => NOW });

    const response = await getHealth(server);
    expect(response.status).toBe(200);
    const body = response.json();
    expect(body["ok"]).toBe(true);
    expect(body["cache"]).toEqual({ ttlMs: 60_000 });
    expect((body["providers"] as unknown[]).length).toBe(4);

    const qwenChatRow = rowOf(response, QWEN_CHAT_PROVIDER_ID);
    expect(qwenChatRow["state"]).toBe("verified");
    expect(qwenChatRow["capturePresent"]).toBe(true);
    expect(qwenChatRow["reason"]).toBeNull();
    expect(qwenChatRow["code"]).toBeNull();
    expect(qwenChatRow["verifiedAt"]).toBe(new Date(NOW).toISOString());
    expect(qwenChatRow["checkedAt"]).toBe(new Date(NOW).toISOString());
    expect(qwenChat.calls()).toBe(1);

    const qwenCodeRow = rowOf(response, QWEN_CODE_PROVIDER_ID);
    expect(qwenCodeRow["state"]).toBe("absent");
    expect(qwenCodeRow["capturePresent"]).toBe(false);
    expect(qwenCodeRow["code"]).toBeNull();
    expect(String(qwenCodeRow["reason"])).toMatch(/No Qwen Code session is stored/);

    const chatgptRow = rowOf(response, CHATGPT_WEB_AUTH_PROVIDER_ID);
    expect(chatgptRow["state"]).toBe("verified");
    expect(chatgptRow["capturePresent"]).toBe(true);

    const deepseekRow = rowOf(response, DEEPSEEK_WEB_IMPORT_PROVIDER_ID);
    expect(deepseekRow["state"]).toBe("unverifiable");
    expect(deepseekRow["capturePresent"]).toBe(true);
    expect(String(deepseekRow["reason"])).toMatch(/no authenticated predicate/i);

    expectNoSecret(response.text);
  });

  test("a capture whose own cookies expired is refused by the provider's validator, not probed", async () => {
    writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture({ expires: PAST }));
    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    const response = await getHealth(server);
    const row = rowOf(response, QWEN_CHAT_PROVIDER_ID);
    expect(row["state"]).toBe("expired");
    expect(row["code"]).toBe(AUTH_IMPORT_REFUSAL_CODES.expired);
    expect(String(row["reason"])).toMatch(/every chat\.qwen\.ai cookie in the capture has expired/);
    // The provider's own acceptance rule decided, before any browser: one policy, shared.
    expect(qwenChat.calls()).toBe(0);
    expectNoSecret(response.text);
  });

  test("the provider's own sentence is reported, not the import wrapper's 'nothing was written'", async () => {
    writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    const qwenChat = countingAuthenticate(async () => {
      throw new Error(EXPIRED_SENTENCE);
    });
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    const response = await getHealth(server);
    const row = rowOf(response, QWEN_CHAT_PROVIDER_ID);
    expect(row["state"]).toBe("expired");
    expect(row["code"]).toBe(AUTH_IMPORT_REFUSAL_CODES.predicateFailed);
    expect(row["reason"]).toBe(EXPIRED_SENTENCE);
    expect(String(row["reason"])).not.toContain("nothing was written");
    expect(qwenChat.calls()).toBe(1);
    expectNoSecret(response.text);
  });

  test("an unreadable capture is expired with an honest reason, and its bytes are not echoed", async () => {
    const path = capturePath(QWEN_CHAT_PROVIDER_ID);
    mkdirSync(dirname(path), { recursive: true });
    // Deliberately truncated JSON that contains a sentinel: the parser's own message would quote it.
    writeFileSync(path, `{"cookies":[{"value":"${SECRET_REFRESH}"`, { mode: 0o600 });
    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    const response = await getHealth(server);
    const row = rowOf(response, QWEN_CHAT_PROVIDER_ID);
    expect(row["state"]).toBe("expired");
    expect(row["capturePresent"]).toBe(true);
    expect(String(row["reason"])).toMatch(/not readable JSON/);
    expect(qwenChat.calls()).toBe(0);
    expect(response.text).not.toContain(SECRET_REFRESH);
    expectNoSecret(response.text);
  });
});

describe("session health — cached, single-flight and bounded", () => {
  test("a warm verdict is reused, and a check past the TTL runs the predicate again", async () => {
    writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    let clock = NOW;
    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => clock,
      cacheTtlMs: 30_000,
    });

    const first = await getHealth(server);
    expect(rowOf(first, QWEN_CHAT_PROVIDER_ID)["state"]).toBe("verified");
    expect(qwenChat.calls()).toBe(1);

    // Opening the page again inside the TTL is free: no second browser round trip.
    clock = NOW + 10_000;
    const second = await getHealth(server);
    expect(qwenChat.calls()).toBe(1);
    expect(rowOf(second, QWEN_CHAT_PROVIDER_ID)["checkedAt"]).toBe(new Date(NOW).toISOString());
    expect((second.json()["cache"] as { ttlMs: number }).ttlMs).toBe(30_000);

    clock = NOW + 31_000;
    const third = await getHealth(server);
    expect(qwenChat.calls()).toBe(2);
    expect(rowOf(third, QWEN_CHAT_PROVIDER_ID)["checkedAt"]).toBe(new Date(NOW + 31_000).toISOString());
  });

  test("two concurrent page loads share one in-flight check", async () => {
    writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    const qwenChat = countingAuthenticate(async state => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return { storageState: state };
    });
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    const [left, right] = await Promise.all([getHealth(server), getHealth(server)]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect(qwenChat.calls()).toBe(1);
  });

  test("a check that does not finish in the bound is 'unknown', never 'expired'", async () => {
    writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    const qwenChat = countingAuthenticate(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      return { storageState: {} };
    });
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
      probeTimeoutMs: 25,
    });

    const response = await getHealth(server);
    const row = rowOf(response, QWEN_CHAT_PROVIDER_ID);
    expect(row["state"]).toBe("unknown");
    expect(String(row["reason"])).toMatch(/did not finish within/);
    expect(row["code"]).toBeNull();
    // The last recorded verification is still reported, so the row can say "last proved at …".
    expect(row["verifiedAt"]).toBe(MARKER_VERIFIED_AT);
  });

  test("the surface refuses a negative cache TTL and a non-positive bound", () => {
    expect(() => createAuthHealthSurface({ providers: [], cacheTtlMs: -1 })).toThrow(TypeError);
    expect(() => createAuthHealthSurface({ providers: [], probeTimeoutMs: 0 })).toThrow(TypeError);
  });
});

describe("session health — one writer, one cache, one authority", () => {
  test("a check that renewed the page state writes the renewal through the provider's writer", async () => {
    const path = writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    const qwenChat = countingAuthenticate(state => ({
      storageState: {
        ...(state as ReturnType<typeof qwenChatCapture>),
        cookies: [
          ...(state as ReturnType<typeof qwenChatCapture>).cookies.filter(cookie => cookie.name !== "refresh_token"),
          {
            name: "refresh_token", value: ROTATED_REFRESH, domain: ".qwen.ai", path: "/",
            expires: FUTURE, httpOnly: true, secure: true, sameSite: "Lax" as const,
          },
        ],
      },
    }));
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    const response = await getHealth(server);
    expect(rowOf(response, QWEN_CHAT_PROVIDER_ID)["state"]).toBe("verified");
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain(ROTATED_REFRESH);
    expect(stored).not.toContain(SECRET_REFRESH);
    // The renewal is stored as a verified session, with the marker kept in step.
    const marker = JSON.parse(readFileSync(`${path}.verified.json`, "utf8")) as { verifiedAt: string };
    // The single writer stamps its own instant; what matters is that the marker moved off the
    // fixture's import time and stayed a real timestamp.
    expect(marker.verifiedAt).not.toBe(MARKER_VERIFIED_AT);
    expect(Number.isFinite(Date.parse(marker.verifiedAt))).toBe(true);
    // …and the credential never appears in the answer.
    expect(response.text).not.toContain(ROTATED_REFRESH);
    expectNoSecret(response.text);
  });

  test("a check that proved the same state writes nothing", async () => {
    const path = writeCapture(QWEN_CHAT_PROVIDER_ID, qwenChatCapture());
    const before = readFileSync(path, "utf8");
    const markerBefore = readFileSync(`${path}.verified.json`, "utf8");
    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    await getHealth(server);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(`${path}.verified.json`, "utf8")).toBe(markerBefore);
  });

  test("a successful import seeds the check cache, so the page load launches nothing", async () => {
    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const provider = { ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider;
    const server = serve({
      providers: descriptors(provider),
      now: () => NOW,
    });

    const imported = await fetch(url(server, "/v1/control/auth/import"), {
      method: "POST",
      headers: { ...controlHeaders, "content-type": "application/json" },
      body: JSON.stringify({ provider: QWEN_CHAT_PROVIDER_ID, storageState: qwenChatCapture() }),
    });
    expect(imported.status).toBe(200);
    expect(qwenChat.calls()).toBe(1);

    const response = await getHealth(server);
    const row = rowOf(response, QWEN_CHAT_PROVIDER_ID);
    expect(row["state"]).toBe("verified");
    expect(row["verifiedAt"]).toBe(new Date(NOW).toISOString());
    // The import's proof is the health read's proof: no second browser.
    expect(qwenChat.calls()).toBe(1);
  });

  test("the control token opens the endpoint and the API key does not", async () => {
    const qwenChat = countingAuthenticate(state => ({ storageState: state }));
    const server = serve({
      providers: descriptors({ ...qwenChatAuthImportProvider({}), authenticate: qwenChat.authenticate } as AuthImportProvider),
      now: () => NOW,
    });

    expect((await getHealth(server, {})).status).toBe(401);
    expect((await getHealth(server, { authorization: `Bearer ${API_KEY}` })).status).toBe(401);
    const opened = await getHealth(server);
    expect(opened.status).toBe(200);
    // The two authorities stay separate: the control token does not open the public API.
    const api = await fetch(url(server, "/v1/models"), { headers: controlHeaders });
    expect(api.status).toBe(401);
  });
});

describe("session health — the deployment's own provider list", () => {
  test("the defaults cover the four import providers, each with its own capture path", () => {
    const providers = defaultAuthHealthProviders(defaultConfig());
    expect(providers.map(provider => provider.importProvider.id)).toEqual([...AUTH_IMPORT_PROVIDER_IDS]);
    const paths = providers.map(provider => provider.storageStatePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const provider of providers) expect(provider.storageStatePath.startsWith(home)).toBe(true);
    for (const provider of providers) {
      if (provider.importProvider.id === CHATGPT_WEB_AUTH_PROVIDER_ID) continue;
      expect(provider.storageStatePath).toContain(join("providers", provider.importProvider.id));
    }
    // The Qwen Chat row is the one this deployment had to renew by hand: it resolves to its own
    // directory, never to another provider's capture, and it is not present on a fresh volume.
    const qwenChatPath = providers.find(provider => provider.importProvider.id === QWEN_CHAT_PROVIDER_ID)?.storageStatePath;
    expect(qwenChatPath).toBe(join(home, "providers", QWEN_CHAT_PROVIDER_ID, "storage-state.json"));
    expect(existsSync(qwenChatPath!)).toBe(false);
  });
});
