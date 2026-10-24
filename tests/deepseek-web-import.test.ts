import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
  deepSeekWebAuthImportProvider,
  importProviderSession,
  type AuthImportProvider,
} from "../src/auth-import";
import { createAuthHealthSurface, type AuthHealthProvider } from "../src/auth-health";
import { DEEPSEEK_WEB_PROVIDER_ID } from "../src/adapters/deepseek-web/provider";
import {
  deepSeekSettingsAuthenticated,
  deepSeekSettingsProbeRequest,
  deepSeekSettingsVerdict,
  deepSeekProbeRefusal,
  probeDeepSeekSessionFromPage,
  probeDeepSeekSettings,
  type DeepSeekProbeObservation,
} from "../src/adapters/deepseek-web/session-probe";
import { deepSeekAccessTokenFromStorage } from "../src/adapters/deepseek-web/page-identity";
import { nonSecretDiagnosticText } from "../src/lib/safe-diagnostics";
import { validateDeepSeekSessionStorageState } from "../src/adapters/deepseek-web/session-store";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  DEEPSEEK_DEVICE_ID,
  DEEPSEEK_HTML,
  DEEPSEEK_SETTINGS_ANONYMOUS,
  DEEPSEEK_SETTINGS_AUTHENTICATED,
  DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED,
  DEEPSEEK_SETTINGS_TOP_TOKEN_REFUSED,
  DEEPSEEK_WAF_HTML,
  OTHER_DEEPSEEK_DEVICE_ID,
  deepSeekCapture,
  deepSeekPageOpener,
  deepSeekStatusAnswer,
  simulatedDeepSeekPage,
  type DeepSeekAnswerFixture,
} from "./support/deepseek-page";

/**
 * The authenticated **import predicate** for `deepseek-web` (issue #299, last rung).
 *
 * The gate this closes: a freshly imported capture used to be stored `verified: false` with no
 * `.verified.json` marker, so `ready()` refused it before a browser started and no turn could run.
 * The measured evidence (`doc/deepseek-web.md` §6.1 rows 3 and 14, §7) is one call:
 *
 * ```text
 * GET /api/v0/client/settings?did=<uuid>&scope=model   ->   HTTP 200 in every case
 *   signed in   {"code":0,"data":{"biz_code":0,…}}
 *   anonymous   {"code":0,"data":{"biz_code":1,"biz_msg":"SETTINGS_NOT_FOUND"}}
 *   token       the 40002/40003 family at whichever layer
 * ```
 *
 * So the predicate is the **nested** `data.biz_code`, never the HTTP status and never the top-level
 * `code` alone. These tests drive the production assembly — the real identity reader, the real
 * page-context request, the real verdict — through a simulated page, so no browser, network or
 * DeepSeek account is needed and every refusal class is reachable deterministically.
 *
 * No token, cookie, device id or leim value may ever reach a refusal, a log line or a response.
 */

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

/** Synthetic secrets: the capture's cookie, the capture's token and the live page's token. */
const SECRET_COOKIE = "SECRET-DEEPSEEK-COOKIE-VALUE";
const SECRET_CAPTURE_TOKEN = "SECRET-DEEPSEEK-CAPTURE-TOKEN-VALUE";
const SECRET_LIVE_TOKEN = "SECRET-DEEPSEEK-LIVE-PAGE-TOKEN-VALUE";
const SECRET_ROTATED_TOKEN = "SECRET-DEEPSEEK-ROTATED-PAGE-TOKEN-VALUE";
const SECRET_LEIM = "SECRET-DEEPSEEK-LEIM-VALUE";
const SECRETS = [SECRET_COOKIE, SECRET_CAPTURE_TOKEN, SECRET_LIVE_TOKEN, SECRET_ROTATED_TOKEN, SECRET_LEIM];

const savedHome = captureChatGptWebHome();
const homes: string[] = [];

beforeEach(() => {
  homes.push(useTemporaryChatGptWebHome("dsh-deepseek-import-"));
});

afterEach(() => {
  while (homes.length > 0) {
    try { rmSync(homes.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  restoreChatGptWebHome(savedHome);
});

/** The temporary data home for the current test. */
const home = (): string => process.env.DSH_CHATGPT_WEB_HOME!;

function writeCapture(state: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-deepseek-capture-"));
  homes.push(directory);
  const path = join(directory, "storage-state.json");
  writeFileSync(path, `${JSON.stringify(state)}\n`);
  return path;
}

/** A capture the provider's own validator accepts, with every synthetic secret in it. */
function liveCapture(options: { readonly token?: string; readonly deviceId?: string } = {}): unknown {
  return deepSeekCapture({
    token: options.token ?? SECRET_CAPTURE_TOKEN,
    cookie: SECRET_COOKIE,
    ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    extraLocalStorage: [{ name: "hif_leim_cached", value: JSON.stringify(SECRET_LEIM) }],
  });
}

const storedPath = (): string => join(home(), "providers", DEEPSEEK_WEB_IMPORT_PROVIDER_ID, "storage-state.json");
const markerPath = (): string => `${storedPath()}.verified.json`;

/**
 * The import provider, wired to a simulated page, with the single writer counted.
 *
 * `launches` counts how many times a page was asked for, so a test can prove a capture problem was
 * refused **before** anything browser-shaped happened.
 */
function provider(page: ReturnType<typeof simulatedDeepSeekPage>["page"] | undefined): {
  provider: AuthImportProvider;
  stores: () => number;
  launches: () => number;
} {
  let stores = 0;
  let launches = 0;
  const base = deepSeekWebAuthImportProvider(page === undefined ? {} : {
    openPage: async capture => {
      launches += 1;
      return await deepSeekPageOpener(page)(capture);
    },
  });
  return {
    provider: {
      ...base,
      store: authentication => {
        stores += 1;
        return base.store(authentication);
      },
    },
    stores: () => stores,
    launches: () => launches,
  };
}

/** One refusal, with the class it produced and the fact that nothing was written. */
async function refusalOf(
  answer: DeepSeekAnswerFixture,
  state: unknown = liveCapture(),
): Promise<string> {
  const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN, answer });
  const { provider: importProvider, stores } = provider(simulated.page);
  const failure = await importProviderSession({
    provider: importProvider,
    from: writeCapture(state),
    now: () => NOW,
  }).then(() => undefined, (error: Error) => error);

  expect(failure).toBeDefined();
  // A predicate failure writes nothing: no session file, no marker.
  expect(stores()).toBe(0);
  expect(existsSync(storedPath())).toBe(false);
  expect(existsSync(markerPath())).toBe(false);
  for (const secret of SECRETS) expect(failure!.message).not.toContain(secret);
  return failure!.message;
}

/** An observation with the measured nesting, so the pure verdict is testable without a page. */
function observation(answer: DeepSeekAnswerFixture): DeepSeekProbeObservation {
  let payload: unknown = answer.text;
  try { payload = answer.text.length === 0 ? "" : JSON.parse(answer.text); } catch { /* stays text */ }
  return {
    status: answer.status,
    payload,
    contentType: answer.contentType,
    bodyText: answer.text,
    truncated: false,
    sentAuthorization: true,
  };
}

/** The identity the page hands the request builder. */
const LIVE_IDENTITY = {
  authorization: `Bearer ${SECRET_LIVE_TOKEN}`,
  deviceId: DEEPSEEK_DEVICE_ID,
  locale: "en_US",
  timezoneOffsetSeconds: 7200,
  bundleId: "com.deepseek.chat",
} as const;

describe("deepseek-web — the predicate reads the nested business code, not the status", () => {
  test("a signed-in envelope is authenticated at both layers", () => {
    const verdict = deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_AUTHENTICATED));
    expect(verdict).toEqual({ kind: "authenticated", authenticated: true });
    expect(deepSeekSettingsAuthenticated(JSON.parse(DEEPSEEK_SETTINGS_AUTHENTICATED.text))).toBe(true);
  });

  test("HTTP 200 with code:0 and a nested refusal is never authenticated", () => {
    // The anonymous answer is the exact trap: the top level says success, the business layer refuses.
    expect(deepSeekSettingsAuthenticated(JSON.parse(DEEPSEEK_SETTINGS_ANONYMOUS.text))).toBe(false);
    const verdict = deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_ANONYMOUS));
    expect(verdict.kind).toBe("settings-refused");
    expect(verdict.authenticated).toBe(false);
    expect(verdict.providerCode).toBe(1);
    expect(verdict.providerMessage).toBe("SETTINGS_NOT_FOUND");
  });

  test("each refusal answer is its own class", () => {
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED)).kind).toBe("token-refused");
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_TOP_TOKEN_REFUSED)).kind).toBe("token-refused");
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_HTML)).kind).toBe("unreadable");
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_WAF_HTML)).kind).toBe("access-verification");
    expect(deepSeekSettingsVerdict(observation(deepSeekStatusAnswer(401))).kind).toBe("http-refused");
    expect(deepSeekSettingsVerdict(observation(deepSeekStatusAnswer(403))).kind).toBe("http-refused");
  });

  test("the provider's own code survives every refusal that had one", () => {
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED)).providerCode).toBe(40003);
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_TOP_TOKEN_REFUSED)).providerCode).toBe(40003);
    // The anonymous business refusal keeps the provider's own code too.
    expect(deepSeekSettingsVerdict(observation(DEEPSEEK_SETTINGS_ANONYMOUS)).providerCode).toBe(1);
  });

  test("an answer with no business layer is unreadable, never success", () => {
    const bare = { status: 200, contentType: "application/json", text: JSON.stringify({ code: 0, msg: "" }) };
    expect(deepSeekSettingsVerdict(observation(bare)).kind).toBe("unreadable");
    expect(deepSeekSettingsVerdict(observation({ status: 200, contentType: "application/json", text: "" })).kind)
      .toBe("unreadable");
    // An array (or any non-envelope JSON) is not the measured answer either.
    expect(deepSeekSettingsVerdict(observation({ status: 200, contentType: "application/json", text: "[]" })).kind)
      .toBe("unreadable");
  });

  test("a 401 that carries the provider's token code keeps the provider's explanation", () => {
    const verdict = deepSeekSettingsVerdict(observation({
      status: 401,
      contentType: "application/json",
      text: JSON.stringify({ code: 40003, msg: "INVALID_TOKEN", data: null }),
    }));
    expect(verdict.kind).toBe("token-refused");
    expect(verdict.providerCode).toBe(40003);
  });
});

describe("deepseek-web — the request is the page's own, built from the page's identity", () => {
  test("the settings URL carries the device identity and the measured scope", () => {
    const request = deepSeekSettingsProbeRequest(LIVE_IDENTITY);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://chat.deepseek.com");
    expect(url.pathname).toBe("/api/v0/client/settings");
    expect(url.searchParams.get("did")).toBe(DEEPSEEK_DEVICE_ID);
    expect(url.searchParams.get("scope")).toBe("model");

    // The measured client/device family plus the page's own bearer; the leim header is omitted when
    // the page has no cache, exactly like the app's own header builder.
    expect(request.headers).toMatchObject({
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-platform": "web",
      "x-client-version": "2.7.0",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "7200",
      "x-device-id": DEEPSEEK_DEVICE_ID,
      "x-device-model": "",
      authorization: `Bearer ${SECRET_LIVE_TOKEN}`,
    });
    expect(request.headers["x-hif-leim"]).toBeUndefined();
  });

  test("the leim header appears only when the page's cache has a value", () => {
    const request = deepSeekSettingsProbeRequest({
      deviceId: DEEPSEEK_DEVICE_ID,
      leim: "synthetic.leim",
      locale: "en_US",
      timezoneOffsetSeconds: 0,
      bundleId: "com.deepseek.chat",
    });
    expect(request.headers["x-hif-leim"]).toBe("synthetic.leim");
    // No page token means no bearer: the provider's own refusal then decides.
    expect(request.headers.authorization).toBeUndefined();
  });

  test("a page with no device identity sends no did instead of inventing one", () => {
    const request = deepSeekSettingsProbeRequest({
      deviceId: "",
      locale: "en_US",
      timezoneOffsetSeconds: 0,
      bundleId: "com.deepseek.chat",
    });
    expect(new URL(request.url).searchParams.get("did")).toBeNull();
  });

  test("the identity is read at call time: a rotated page token changes the request", async () => {
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN });

    const first = await probeDeepSeekSessionFromPage(simulated.page);
    simulated.setToken(SECRET_ROTATED_TOKEN);
    const second = await probeDeepSeekSessionFromPage(simulated.page);

    expect(first.sentAuthorization).toBe(true);
    expect(second.sentAuthorization).toBe(true);
    // The page was read twice, and the second request follows the value it holds now.
    expect(simulated.reads).toEqual([SECRET_LIVE_TOKEN, SECRET_ROTATED_TOKEN]);
    expect(simulated.sent[0]!.headers.authorization).toBe(`Bearer ${SECRET_LIVE_TOKEN}`);
    expect(simulated.sent[1]!.headers.authorization).toBe(`Bearer ${SECRET_ROTATED_TOKEN}`);
    expect(simulated.sent[1]!.headers.authorization).not.toBe(`Bearer ${SECRET_LIVE_TOKEN}`);
  });

  test("a page with no token sends no bearer at all, and the provider's answer decides", async () => {
    const simulated = simulatedDeepSeekPage({ token: undefined, answer: DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED });
    const observed = await probeDeepSeekSessionFromPage(simulated.page);
    expect(observed.sentAuthorization).toBe(false);
    expect(simulated.sent[0]!.headers.authorization).toBeUndefined();
    const verdict = deepSeekSettingsVerdict(observed);
    expect(verdict.kind).toBe("token-refused");
    expect(verdict.refusal).toContain("no bearer");
  });

  test("the identity reader is the one the turn path uses, so the storage shape cannot drift", () => {
    // The measured `userToken` handle: `{"value": …, "__version": "0"}`.
    expect(deepSeekAccessTokenFromStorage(JSON.stringify({ value: SECRET_LIVE_TOKEN, __version: "0" })))
      .toBe(SECRET_LIVE_TOKEN);
    expect(deepSeekAccessTokenFromStorage(undefined)).toBeUndefined();
  });
});

describe("deepseek-web — a good capture is verified, stored once, and reported verified", () => {
  test("the nested success code writes the marker exactly once and names the layer that decided", async () => {
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN });
    const { provider: importProvider, stores } = provider(simulated.page);

    const result = await importProviderSession({
      provider: importProvider,
      from: writeCapture(liveCapture()),
      now: () => NOW,
    });

    expect(result.verified).toBe(true);
    expect(result.verifiedAt).toBe(new Date(NOW).toISOString());
    expect(result.path).toBe(storedPath());
    expect(stores()).toBe(1);
    // The operator's line names the call and the layer that decided, not just "OK".
    expect(result.detail).toContain("/api/v0/client/settings");
    expect(result.detail).toContain("data.biz_code:0");
    expect(result.detail).toContain("HTTP 200");

    const marker = JSON.parse(readFileSync(markerPath(), "utf8")) as {
      version: number; authenticated: boolean; verifiedAt: string;
    };
    expect(marker.version).toBe(1);
    expect(marker.authenticated).toBe(true);
    expect(typeof marker.verifiedAt).toBe("string");

    // The stored session is this provider's own material, and the page's live token is what was sent.
    const stored = JSON.parse(readFileSync(storedPath(), "utf8")) as {
      cookies: { domain: string; value: string }[];
      origins: { origin: string }[];
    };
    expect(stored.cookies.map(entry => entry.domain)).toEqual([".deepseek.com"]);
    expect(stored.origins.map(entry => entry.origin)).toEqual(["https://chat.deepseek.com"]);
    expect(simulated.sent).toHaveLength(1);
    expect(simulated.sent[0]!.headers.authorization).toBe(`Bearer ${SECRET_LIVE_TOKEN}`);
    expect(simulated.sent[0]!.url).toContain(`did=${DEEPSEEK_DEVICE_ID}`);

    // Nothing about the capture or the page's token is echoed.
    expect(JSON.stringify(result)).not.toContain(SECRET_LIVE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SECRET_COOKIE);
  });

  test("the health surface reports verified once the marker exists", async () => {
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN });
    const { provider: importProvider } = provider(simulated.page);
    await importProviderSession({
      provider: importProvider,
      from: writeCapture(liveCapture()),
      now: () => NOW,
    });

    const healthProvider: AuthHealthProvider = { storageStatePath: storedPath(), importProvider };
    const surface = createAuthHealthSurface({ providers: [healthProvider], now: () => NOW });
    const snapshot = await surface.snapshot();
    const row = snapshot.providers[0]!;

    expect(row.providerId).toBe(DEEPSEEK_WEB_PROVIDER_ID);
    expect(row.state).toBe("verified");
    expect(row.capturePresent).toBe(true);
    expect(row.code).toBeNull();
    expect(row.reason).toBeNull();
    expect(row.verifiedAt).toBe(new Date(NOW).toISOString());
    const body = JSON.stringify(snapshot);
    for (const secret of SECRETS) expect(body).not.toContain(secret);
  });

  test("a previously unverified capture becomes verified on re-import, and stays idempotent", async () => {
    // The exact gate this change closes: the capture exists but nothing proved it.
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN });
    const { provider: importProvider } = provider(simulated.page);
    await importProviderSession({ provider: importProvider, from: writeCapture(liveCapture()), now: () => NOW });
    expect(existsSync(markerPath())).toBe(true);

    // A second import of the same capture is idempotent: one marker, one session, still verified.
    const second = await importProviderSession({
      provider: importProvider,
      from: writeCapture(liveCapture()),
      now: () => NOW,
    });
    expect(second.verified).toBe(true);
    expect((JSON.parse(readFileSync(markerPath(), "utf8")) as { authenticated: boolean }).authenticated).toBe(true);
  });
});

describe("deepseek-web — every refusal is its own class and writes nothing", () => {
  test("the nested token failure preserves the provider's code", async () => {
    const message = await refusalOf(DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED);
    expect(message).toContain("code 40003");
    expect(message).toContain("auth import --provider deepseek-web");
  });

  test("the nested settings failure keeps SETTINGS_NOT_FOUND and names it", async () => {
    const message = await refusalOf(DEEPSEEK_SETTINGS_ANONYMOUS);
    expect(message).toContain("business layer");
    expect(message).toContain("code 1");
    expect(message).toContain("SETTINGS_NOT_FOUND");
    // Never dressed up as a password problem.
    expect(message.toLowerCase()).not.toContain("password");
  });

  test("HTTP 200 carrying an HTML document is unreadable, not a session verdict", async () => {
    const message = await refusalOf(DEEPSEEK_HTML);
    expect(message).toContain("cannot read");
    expect(message).toContain("HTTP 200");
    expect(message).toContain("text/html");
    expect(message.toLowerCase()).not.toContain("expired");
  });

  test("HTTP 401 and 403 are their own class", async () => {
    for (const status of [401, 403] as const) {
      const message = await refusalOf(deepSeekStatusAnswer(status));
      expect(message).toContain(`HTTP ${status}`);
      expect(message).toContain("not accepted");
    }
  });

  test("a WAF challenge is its own class, never 'wrong password'", async () => {
    const message = await refusalOf(DEEPSEEK_WAF_HTML);
    expect(message).toContain("access-verification challenge");
    expect(message).toContain("never retries past a challenge");
    expect(message.toLowerCase()).not.toContain("password");
  });

  test("an unreadable body claims nothing about the session", async () => {
    const message = await refusalOf({ status: 200, contentType: "application/json", text: "" });
    expect(message).toContain("nothing was claimed");
  });

  test("every refusal survives the pipeline's non-secret reduction unchanged", () => {
    // The sentences reach the operator through `nonSecretDiagnosticText`, which rewrites URLs to
    // `[url]` and bounds a line at 300 characters. A refusal that changed shape there would be
    // truncated where it says what to do, so each one has to pass through untouched.
    const answers: DeepSeekAnswerFixture[] = [
      DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED,
      DEEPSEEK_SETTINGS_TOP_TOKEN_REFUSED,
      DEEPSEEK_SETTINGS_ANONYMOUS,
      DEEPSEEK_HTML,
      DEEPSEEK_WAF_HTML,
      deepSeekStatusAnswer(401),
      deepSeekStatusAnswer(403),
      { status: 200, contentType: "application/json", text: "" },
    ];
    for (const answer of answers) {
      const refusal = deepSeekProbeRefusal(observation(answer));
      expect(refusal.length).toBeGreaterThan(0);
      expect(nonSecretDiagnosticText(new Error(refusal))).toBe(refusal);
    }
  });
});

describe("deepseek-web — the capture is validated before any browser starts", () => {
  /** A state whose `localStorage` lacks one required entry. */
  function without(key: "userToken" | "deepseek-device-id:chat"): unknown {
    const capture = deepSeekCapture({ token: SECRET_CAPTURE_TOKEN, cookie: SECRET_COOKIE }) as {
      origins: { origin: string; localStorage: { name: string; value: string }[] }[];
    };
    capture.origins[0]!.localStorage = capture.origins[0]!.localStorage.filter(entry => entry.name !== key);
    return capture;
  }

  test("a capture without userToken is refused without launching a browser", async () => {
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN });
    const { provider: importProvider, stores, launches } = provider(simulated.page);

    const failure = await importProviderSession({
      provider: importProvider,
      from: writeCapture(without("userToken")),
      now: () => NOW,
    }).then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain("`userToken`");
    expect(failure?.message).toContain("missing");
    // The browser was never part of the decision, and nothing was written.
    expect(launches()).toBe(0);
    expect(stores()).toBe(0);
    expect(existsSync(join(home(), "providers", DEEPSEEK_WEB_IMPORT_PROVIDER_ID))).toBe(false);
  });

  test("a capture without the device id is refused without launching a browser", async () => {
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN });
    const { provider: importProvider, launches } = provider(simulated.page);

    const failure = await importProviderSession({
      provider: importProvider,
      from: writeCapture(without("deepseek-device-id:chat")),
      now: () => NOW,
    }).then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain("`deepseek-device-id:chat`");
    expect(failure?.message).toContain("missing");
    expect(launches()).toBe(0);
  });

  test("a capture with cookies but no local storage is refused, naming both halves", async () => {
    const { provider: importProvider, launches } = provider(simulatedDeepSeekPage().page);
    const failure = await importProviderSession({
      provider: importProvider,
      from: writeCapture({ cookies: deepSeekCapture().cookies as unknown[], origins: [] }),
      now: () => NOW,
    }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("no local storage");
    expect(failure?.message).toContain("userToken");
    expect(launches()).toBe(0);
  });

  test("a capture with no deepseek.com cookie is refused as a foreign domain", async () => {
    const capture = deepSeekCapture({ token: SECRET_CAPTURE_TOKEN }) as { cookies: { domain: string }[] };
    capture.cookies[0]!.domain = ".example.invalid";
    const { provider: importProvider, launches } = provider(simulatedDeepSeekPage().page);
    const failure = await importProviderSession({
      provider: importProvider,
      from: writeCapture(capture),
      now: () => NOW,
    }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("no deepseek.com cookie");
    expect(launches()).toBe(0);
  });

  test("a page that cannot be opened is a transport failure, not a session verdict", async () => {
    const importProvider = deepSeekWebAuthImportProvider({
      openPage: async () => {
        throw new Error("browserType.launch: Executable doesn't exist at /tmp/chromium");
      },
    });
    const failure = await importProviderSession({
      provider: importProvider,
      from: writeCapture(liveCapture()),
      now: () => NOW,
    }).then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain("could not be opened");
    // Nothing was judged, so nothing is claimed about the session.
    expect(failure?.message).not.toContain("settings");
    expect(existsSync(storedPath())).toBe(false);
    // The sentence is the shared non-secret reduction: URLs are rewritten, the line is bounded, and
    // no cookie or token from the capture is quoted. (A bare absolute path is not a URL and is not
    // rewritten by that helper — the reason it gives is the operator's diagnosis.)
    for (const secret of SECRETS) expect(failure?.message).not.toContain(secret);
    expect(failure!.message.length).toBeLessThan(500);
  });

  test("the validator accepts the doc's entries and rejects a malformed token handle", () => {
    const accepted = validateDeepSeekSessionStorageState(liveCapture(), NOW);
    expect(accepted.cookies).toHaveLength(1);
    expect(accepted.origins[0]!.origin).toBe("https://chat.deepseek.com");

    const malformed = liveCapture() as { origins: { localStorage: { name: string; value: string }[] }[] };
    malformed.origins[0]!.localStorage = malformed.origins[0]!.localStorage.map(entry =>
      entry.name === "userToken" ? { name: entry.name, value: '{"value": "", "__version": "0"}' } : entry);
    expect(() => validateDeepSeekSessionStorageState(malformed, NOW)).toThrow(/userToken/);
  });
});

describe("deepseek-web — no credential reaches a refusal, a log or a response", () => {
  test("a refusing predicate writes nothing and never echoes the token, the cookie or the leim", async () => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (write: (...args: unknown[]) => void) => (...args: unknown[]) => {
      lines.push(args.join(" "));
      write(...args);
    };
    console.log = capture(original.log);
    console.warn = capture(original.warn);
    console.error = capture(original.error);
    console.info = capture(original.info);

    let message = "";
    try {
      message = await refusalOf(DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
    }

    for (const secret of SECRETS) {
      expect(message).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  test("the verdict itself carries no credential, whatever it is handed", async () => {
    const observationWithSecrets = await probeDeepSeekSettings({
      authorization: `Bearer ${SECRET_LIVE_TOKEN}`,
      deviceId: DEEPSEEK_DEVICE_ID,
      leim: SECRET_LEIM,
      locale: "en_US",
      timezoneOffsetSeconds: 7200,
      bundleId: "com.deepseek.chat",
    }, async () => ({
      status: DEEPSEEK_SETTINGS_ANONYMOUS.status,
      payload: JSON.parse(DEEPSEEK_SETTINGS_ANONYMOUS.text),
      contentType: DEEPSEEK_SETTINGS_ANONYMOUS.contentType,
      bodyText: DEEPSEEK_SETTINGS_ANONYMOUS.text,
    }));
    const verdict = deepSeekSettingsVerdict(observationWithSecrets);
    const serialized = JSON.stringify(verdict);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(SECRET_LIVE_TOKEN);
  });

  test("the device identity the request carries is the page's, not the capture's", async () => {
    const simulated = simulatedDeepSeekPage({ token: SECRET_LIVE_TOKEN, deviceId: OTHER_DEEPSEEK_DEVICE_ID });
    const { provider: importProvider } = provider(simulated.page);
    await importProviderSession({ provider: importProvider, from: writeCapture(liveCapture()), now: () => NOW });
    expect(simulated.sent[0]!.url).toContain(`did=${OTHER_DEEPSEEK_DEVICE_ID}`);
    expect(simulated.sent[0]!.url).not.toContain(DEEPSEEK_DEVICE_ID);
  });
});
