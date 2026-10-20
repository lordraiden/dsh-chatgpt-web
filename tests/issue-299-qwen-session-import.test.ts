import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QWEN_COOKIE_DOMAINS,
  captureToFile,
  cdpCookiesToStorageState,
  hostAllowed,
  localStorageToOrigins,
} from "../scripts/qwen-storage-state.mjs";
import {
  importProviderSession,
  qwenCodeAuthImportProvider,
  readImportedStorageState,
  type AuthImportProvider,
} from "../src/auth-import";
import { QWEN_CODE_COOKIE_DOMAINS } from "../src/adapters/qwen-code/session-store";
import { QWEN_CODE_PROVIDER_ID } from "../src/adapters/qwen-code/provider";
import {
  awaitQwenPageSession,
  probeQwenTaskListFromPageAfterHydration,
  qwenAccessTokenFromPersistedValue,
  qwenAuthorizationHeaderFromPage,
  qwenTaskListProbeRefusal,
  qwenTaskListRefusal,
  qwenTaskListRequest,
} from "../src/adapters/qwen-code/session-probe";
import { waitForPageHydration } from "../src/adapters/page-hydration";
import { defaultConfig, saveConfig } from "../src/config";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * Issue #299 — adopting a Qwen Code session captured on the operator's own machine.
 *
 * This is the alternative sign-in path for a provider whose risk engine refuses relayed input. Two
 * things are proven here without a browser, without network access and without a Qwen account:
 *
 * - the capture script turns a recorded DevTools cookie payload into the storage-state shape, keeps
 *   only this provider's domains, and never logs a cookie value;
 * - `auth import` validates the file *and* runs the controller's own `task/list` predicate before the
 *   single session writer is allowed to touch the disk.
 */

/** Recorded-shape DevTools answer. Every value is synthetic and is asserted absent from the logs. */
const CDP_PAYLOAD = {
  cookies: [
    {
      name: "session",
      value: "SECRET-QWEN-VALUE",
      domain: ".qwen.ai",
      path: "/",
      expires: 1_893_456_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "coder_token",
      value: "SECRET-CODER-VALUE",
      domain: "coder.qwen.ai",
      path: "/",
      expires: -1,
      session: true,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
    {
      name: "aliyun_ticket",
      value: "SECRET-ALIYUN-VALUE",
      domain: ".aliyun.com",
      path: "/",
      expires: 1_893_456_000,
      secure: true,
      sameSite: "None",
    },
    {
      name: "already_expired",
      value: "SECRET-EXPIRED-VALUE",
      domain: ".qwen.ai",
      path: "/",
      expires: 1_000_000,
    },
    {
      name: "partitioned",
      value: "SECRET-PARTITIONED-VALUE",
      domain: ".qwen.ai",
      path: "/",
      expires: 1_893_456_000,
      partitionKey: { topLevelSite: "https://coder.qwen.ai" },
    },
    {
      name: "foreign",
      value: "SECRET-FOREIGN-VALUE",
      domain: ".example.com",
      path: "/",
      expires: 1_893_456_000,
    },
  ],
};

const SECRET_VALUES = [
  "SECRET-QWEN-VALUE",
  "SECRET-CODER-VALUE",
  "SECRET-ALIYUN-VALUE",
  "SECRET-EXPIRED-VALUE",
  "SECRET-PARTITIONED-VALUE",
  "SECRET-FOREIGN-VALUE",
];

/** The same shape a Playwright storage state has, for the import tests. */
const IMPORTABLE_STATE = {
  cookies: [
    {
      name: "session",
      value: "SECRET-IMPORT-COOKIE",
      domain: ".qwen.ai",
      path: "/",
      expires: 1_893_456_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
    {
      name: "tracking",
      value: "SECRET-FOREIGN-COOKIE",
      domain: ".doubleclick.net",
      path: "/",
      expires: 1_893_456_000,
      httpOnly: false,
      secure: true,
      sameSite: "Lax" as const,
    },
  ],
  origins: [
    { origin: "https://coder.qwen.ai", localStorage: [{ name: "synthetic", value: "SECRET-LOCAL-STORAGE" }] },
    { origin: "https://example.invalid", localStorage: [] },
  ],
};

const NOW = Date.UTC(2026, 9, 19);

const ANONYMOUS_TASK_LIST = {
  success: false,
  request_id: "request-fixture",
  data: { code: "Unauthorized", details: "401 Unauthorized" },
};

const AUTHENTICATED_TASK_LIST = {
  success: true,
  request_id: "request-fixture",
  data: [{ id: "chat-fixture" }],
};

const homes: string[] = [];
const savedHome = captureChatGptWebHome();

function freshHome(): string {
  const home = useTemporaryChatGptWebHome("dsh-299-import-");
  homes.push(home);
  return home;
}

function freshDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  homes.push(directory);
  return directory;
}

function writeState(directory: string, state: unknown): string {
  const path = join(directory, "storage-state.json");
  writeFileSync(path, `${JSON.stringify(state)}\n`);
  return path;
}

function countingProvider(provider: AuthImportProvider): { provider: AuthImportProvider; stores: () => number } {
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

afterEach(() => {
  while (homes.length > 0) {
    try { rmSync(homes.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  restoreChatGptWebHome(savedHome);
});

describe("issue #299 — the capture script turns a DevTools payload into a storage state", () => {
  test("the provider domain list cannot drift from the importer's sanitizer", () => {
    expect([...QWEN_COOKIE_DOMAINS]).toEqual([...QWEN_CODE_COOKIE_DOMAINS]);
    expect(hostAllowed(".qwen.ai")).toBe(true);
    expect(hostAllowed("coder.qwen.ai")).toBe(true);
    expect(hostAllowed(".aliyun.com")).toBe(true);
    expect(hostAllowed(".example.com")).toBe(false);
    expect(hostAllowed(undefined as unknown as string)).toBe(false);
  });

  test("cookies are mapped field by field and filtered to this provider's domains", () => {
    const state = cdpCookiesToStorageState(CDP_PAYLOAD, NOW);

    // Expired, partitioned and foreign cookies are dropped, never "kept just in case".
    expect(state.cookies.map(cookie => cookie.name)).toEqual(["session", "coder_token", "aliyun_ticket"]);
    expect(state.origins).toEqual([]);

    // Exactly Playwright's cookie shape: no CDP bookkeeping leaked into the file.
    expect(state.cookies[0]).toEqual({
      name: "session",
      value: "SECRET-QWEN-VALUE",
      domain: ".qwen.ai",
      path: "/",
      expires: 1_893_456_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    // A session cookie keeps Playwright's `-1` sentinel.
    expect(state.cookies[1]).toMatchObject({ name: "coder_token", expires: -1, sameSite: "Strict" });
    // A missing sameSite is Chrome's default, not an omission the importer has to guess.
    expect(state.cookies[2]).toMatchObject({ name: "aliyun_ticket", sameSite: "None" });
  });

  test("the page's local storage is captured too, because that is where the API's token lives", () => {
    const entries = [
      ["theme", "dark"],
      ["qwen_access_token_state", JSON.stringify({ token: "SECRET-LS-TOKEN", loggedOut: false, version: 1 })],
    ];

    // Pure mapping: the app's origin plus the page's own entries, in order.
    expect(localStorageToOrigins(entries)).toEqual([{
      origin: "https://coder.qwen.ai",
      localStorage: [
        { name: "theme", value: "dark" },
        { name: "qwen_access_token_state", value: entries[1]![1] },
      ],
    }]);
    expect(localStorageToOrigins(undefined)).toEqual([]);
    expect(localStorageToOrigins([["theme"]])).toEqual([]);

    const directory = freshDirectory("issue-299-storage-capture-");
    const outPath = join(directory, "qwen-storage-state.json");
    const lines: string[] = [];
    const result = captureToFile({
      payload: CDP_PAYLOAD,
      outPath,
      stdout: line => lines.push(line),
      now: NOW,
      storage: entries,
    });
    const log = lines.join("\n");
    const written = JSON.parse(readFileSync(outPath, "utf8")) as {
      origins: { origin: string; localStorage: { name: string; value: string }[] }[];
    };

    expect(result.storageKeys).toBe(2);
    expect(written.origins.map(origin => origin.origin)).toEqual(["https://coder.qwen.ai"]);
    expect(written.origins[0]!.localStorage.map(entry => entry.name)).toEqual(["theme", "qwen_access_token_state"]);

    // A count, never a key or a value: the log is the part that gets pasted.
    expect(log).toContain("local storage keys: 2");
    expect(log).not.toContain("SECRET-LS-TOKEN");
    expect(log).not.toContain("qwen_access_token_state");
  });

  test("a capture written by the script is imported, and the probe follows the live page", async () => {
    const directory = freshDirectory("issue-299-capture-to-probe-");
    const outPath = join(directory, "qwen-storage-state.json");
    captureToFile({
      payload: CDP_PAYLOAD,
      outPath,
      stdout: () => {},
      now: NOW,
      storage: [["qwen_access_token_state", JSON.stringify({ token: "SECRET-CAPTURED-TOKEN", loggedOut: true })]],
    });

    // The script's output is a valid capture. The token it happens to hold is not the probe's
    // authority: the page, opened with those cookies, is.
    const live = JSON.stringify({ token: LIVE_PAGE_TOKEN, loggedOut: false, version: 1 });
    const { page, sent } = simulatedQwenPage({ states: [live] });
    const result = await importProviderSession({
      provider: qwenCodeAuthImportProvider({
        openPage: openerFor(page),
        hydration: FAST_HYDRATION,
      }),
      from: outPath,
      now: () => NOW,
    });

    expect(result.verified).toBe(true);
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${LIVE_PAGE_TOKEN}`);
    expect(sent[0]!.headers.authorization).not.toContain("SECRET-CAPTURED-TOKEN");
  });

  test("the capture is written privately, safe to re-run, and never logs a cookie value", () => {
    const directory = freshDirectory("issue-299-capture-");
    const outPath = join(directory, "qwen-storage-state.json");
    const lines: string[] = [];

    const first = captureToFile({ payload: CDP_PAYLOAD, outPath, stdout: line => lines.push(line), now: NOW });
    const log = lines.join("\n");
    const written = readFileSync(outPath, "utf8");

    expect(first.path).toBe(outPath);
    expect(first.cookies).toBe(3);
    expect(first.domains).toEqual([".aliyun.com", ".qwen.ai", "coder.qwen.ai"]);

    // Where it is and what it is, plainly stated.
    expect(log).toContain(outPath);
    expect(log.toLowerCase()).toContain("session");
    expect(log).toContain("mode 0600");
    // Not a single cookie value, and no cookie name either: the log is the part people paste.
    for (const secret of SECRET_VALUES) expect(log).not.toContain(secret);
    expect(log).not.toContain("coder_token");
    // The file itself is the one place the session may live.
    expect(written).toContain("SECRET-QWEN-VALUE");

    if (process.platform !== "win32") {
      expect(statSync(outPath).mode & 0o777).toBe(0o600);
    }

    // Re-running replaces the capture atomically instead of appending or failing on an existing file.
    const second = captureToFile({ payload: CDP_PAYLOAD, outPath, stdout: line => lines.push(line), now: NOW });
    expect(second.path).toBe(outPath);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(JSON.parse(written));
    expect(lines.join("\n")).toContain("replaced the previous capture");

    // A capture with nothing for this provider is refused and leaves no file behind.
    const refusedPath = join(directory, "refused.json");
    const foreignOnly = { cookies: [CDP_PAYLOAD.cookies[5]] };
    expect(() => captureToFile({ payload: foreignOnly, outPath: refusedPath, stdout: () => {} })).toThrow(
      /none of the cookies/,
    );
    expect(existsSync(refusedPath)).toBe(false);
  });
});

describe("issue #299 — an imported capture is validated before it can be stored", () => {
  test("a valid Playwright storage state is accepted", () => {
    const directory = freshDirectory("issue-299-valid-");
    const source = writeState(directory, IMPORTABLE_STATE);

    const parsed = readImportedStorageState(source);
    expect(parsed.cookies).toHaveLength(2);
    expect(parsed.origins).toHaveLength(2);
  });

  test("an empty file is refused with its own message, writing nothing", () => {
    const directory = freshDirectory("issue-299-empty-");
    const source = join(directory, "storage-state.json");
    writeFileSync(source, "");

    expect(() => readImportedStorageState(source)).toThrow(/is empty; export the session again/);
  });

  test("malformed JSON is refused without echoing the file's contents", () => {
    const directory = freshDirectory("issue-299-malformed-");
    const source = join(directory, "storage-state.json");
    writeFileSync(source, '{"cookies": [SECRET-IMPORT-COOKIE');

    const failure = (() => {
      try {
        readImportedStorageState(source);
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure?.message).toContain("is not valid JSON");
    expect(failure?.message).not.toContain("SECRET-IMPORT-COOKIE");
  });

  test("something that is not a storage state is refused", () => {
    const directory = freshDirectory("issue-299-shape-");
    const source = join(directory, "storage-state.json");
    writeFileSync(source, JSON.stringify({ nope: true }));

    expect(() => readImportedStorageState(source)).toThrow(/does not look like a Playwright storage state/);
  });

  test("a renamed or missing provider domain is refused, naming the next step", async () => {
    const directory = freshDirectory("issue-299-domain-");
    const source = writeState(directory, {
      cookies: [{ ...IMPORTABLE_STATE.cookies[0], domain: ".qwen-web.invalid" }],
      origins: [],
    });
    let probed = false;
    const provider = qwenCodeAuthImportProvider({
      probe: async () => {
        probed = true;
        return { status: 200, payload: AUTHENTICATED_TASK_LIST };
      },
    });

    await expect(importProviderSession({ provider, from: source, now: () => NOW })).rejects.toThrow(
      /contains no coder\.qwen\.ai cookies.*open https:\/\/coder\.qwen\.ai/s,
    );
    // A file that cannot be this provider's session never reaches a browser.
    expect(probed).toBe(false);
  });

  test("a capture with no cookies at all is refused with its own message", async () => {
    const directory = freshDirectory("issue-299-absent-");
    const source = writeState(directory, { cookies: [], origins: [] });
    const provider = qwenCodeAuthImportProvider({
      probe: async () => ({ status: 200, payload: AUTHENTICATED_TASK_LIST }),
    });

    await expect(importProviderSession({ provider, from: source, now: () => NOW })).rejects.toThrow(
      /contains no cookies at all/,
    );
  });

  test("a capture whose provider cookies have all expired is refused with its own message", async () => {
    const directory = freshDirectory("issue-299-expired-");
    const source = writeState(directory, {
      cookies: [{ ...IMPORTABLE_STATE.cookies[0], expires: 1_000_000 }],
      origins: [],
    });
    const provider = qwenCodeAuthImportProvider({
      probe: async () => ({ status: 200, payload: AUTHENTICATED_TASK_LIST }),
    });

    await expect(importProviderSession({ provider, from: source, now: () => NOW })).rejects.toThrow(
      /every coder\.qwen\.ai cookie in the capture has expired/,
    );
  });
});

describe("issue #299 — the CLI wires the Qwen import through the same pipeline", () => {
  test("auth import --provider qwen-code refuses an unverifiable capture and writes nothing", () => {
    const home = freshHome();
    // A Chrome path that cannot exist: the refusal is deterministic on every machine, and the point
    // asserted is the fail-closed DECISION, not a browser's latency.
    saveConfig({ ...defaultConfig(), chromeExecutablePath: join(home, "no-such-chrome") });
    const directory = freshDirectory("issue-299-cli-");
    const source = writeState(directory, IMPORTABLE_STATE);

    const result = Bun.spawnSync({
      cmd: ["bun", "src/cli.ts", "auth", "import", "--provider", QWEN_CODE_PROVIDER_ID, "--from", source],
      env: { ...process.env, DSH_CHATGPT_WEB_HOME: home },
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();

    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("could not be verified against the Qwen Code login surface");
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
    // Neither the console nor the refusal carries a cookie value.
    expect(stderr).not.toContain("SECRET-IMPORT-COOKIE");
    expect(result.stdout.toString()).not.toContain("SECRET-IMPORT-COOKIE");
  });
});

describe("issue #299 — the authenticated predicate gates the single session writer", () => {
  test("task/list answering success:false is never stored", async () => {
    const home = freshHome();
    const directory = freshDirectory("issue-299-anonymous-");
    const source = writeState(directory, IMPORTABLE_STATE);
    const { provider, stores } = countingProvider(qwenCodeAuthImportProvider({
      probe: async () => ({ status: 200, payload: ANONYMOUS_TASK_LIST }),
    }));

    const failure = await importProviderSession({ provider, from: source, now: () => NOW })
      .then(() => undefined, error => error as Error);

    expect(failure?.message).toContain("could not be verified against the Qwen Code login surface");
    expect(failure?.message).toContain("Unauthorized 401 Unauthorized");
    // The predicate failed, so the single writer was never called and no layout appeared.
    expect(stores()).toBe(0);
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
    // The file's secret never leaks into the refusal.
    expect(failure?.message).not.toContain("SECRET-IMPORT-COOKIE");
  });

  test("task/list answering success:true stores exactly once, in the provider's own layout", async () => {
    const home = freshHome();
    const directory = freshDirectory("issue-299-authenticated-");
    const source = writeState(directory, IMPORTABLE_STATE);
    const { provider, stores } = countingProvider(qwenCodeAuthImportProvider({
      probe: async () => ({ status: 200, payload: AUTHENTICATED_TASK_LIST }),
    }));

    const result = await importProviderSession({ provider, from: source, now: () => NOW });
    const expectedPath = join(home, "providers", QWEN_CODE_PROVIDER_ID, "storage-state.json");

    expect(stores()).toBe(1);
    expect(result.path).toBe(expectedPath);
    expect(result.detail).toContain("success:true");
    expect(result.detail).not.toContain("SECRET-IMPORT-COOKIE");

    const stored = JSON.parse(readFileSync(expectedPath, "utf8")) as {
      cookies: { domain: string; value: string }[];
      origins: { origin: string }[];
    };
    // The sanitizer is applied on the way in: the tracking cookie and the foreign origin are gone.
    expect(stored.cookies.map(cookie => cookie.domain)).toEqual([".qwen.ai"]);
    expect(stored.origins.map(origin => origin.origin)).toEqual(["https://coder.qwen.ai"]);

    const marker = JSON.parse(readFileSync(`${expectedPath}.verified.json`, "utf8")) as {
      version: number;
      authenticated: boolean;
      verifiedAt: string;
    };
    expect(marker.version).toBe(1);
    expect(marker.authenticated).toBe(true);
    expect(typeof marker.verifiedAt).toBe("string");
  });
});


/**
 * Issue #299, third pass — the live page is the authority for its own session.
 *
 * The live evidence that defines this block: the second operator capture carried a
 * `qwen_access_token_state` whose content said `loggedOut: true` — a stale entry written when the
 * operator's fresh profile first loaded the app — while the real authenticated session lived in the
 * captured cookies. A probe that sends that state's token (or none) is refused exactly as the
 * deployed service logged it. The corrected rule: open the page in the captured context, wait
 * (bounded, observably) for the app's own bootstrap to restore its session, then read the token from
 * the live page and issue the probe from inside it.
 *
 * These tests drive the **production** assembly (wait + live read + request) with a simulated page,
 * so no browser, network or account is needed, and changing the simulated page value must change the
 * request.
 */

/** Synthetic token values. All are asserted absent from every diagnostic and from stdout. */
const STALE_CAPTURE_TOKEN = "SECRET-QWEN-STALE-CAPTURE-TOKEN";
const LIVE_PAGE_TOKEN = "SECRET-QWEN-LIVE-PAGE-TOKEN";
const OTHER_LIVE_PAGE_TOKEN = "SECRET-QWEN-LIVE-PAGE-TOKEN-CHANGED";

/** The localStorage entry exactly as the app's token manager persists it (recorded shape). */
function tokenStateEntry(
  token: string | null,
  options: { readonly loggedOut?: boolean; readonly expiresAt?: number } = {},
) {
  return {
    name: "qwen_access_token_state",
    value: JSON.stringify({
      token,
      expiresAt: options.expiresAt ?? 1_900_000_000_000,
      sessionId: "session-fixture",
      loggedOut: options.loggedOut ?? false,
      version: 1,
      stateId: "state-fixture",
      updatedAt: 1_790_000_000_000,
      sourceId: "source-fixture",
    }),
  };
}

/** A capture with the provider's cookies and one localStorage entry. */
function captureWithTokenState(entry: ReturnType<typeof tokenStateEntry>) {
  return {
    cookies: [IMPORTABLE_STATE.cookies[0]!],
    origins: [{ origin: "https://coder.qwen.ai", localStorage: [entry] }],
  };
}

/** A capture whose cookies are fine but which carries no token entry at all. */
const CAPTURE_WITHOUT_TOKEN = {
  cookies: [IMPORTABLE_STATE.cookies[0]!],
  origins: [{ origin: "https://coder.qwen.ai", localStorage: [{ name: "theme", value: "dark" }] }],
};

/**
 * A simulated provider page.
 *
 * `states` is the page's own successive answers to the token read: the first entries model the stale
 * capture being repaired by the app's bootstrap, the last one repeats. Every request the probe sends
 * from the page is recorded, so the header can be asserted without a network.
 */
function simulatedQwenPage(options: {
  readonly states: readonly (string | undefined)[];
  readonly payload?: unknown;
  /** A recorded-shape answer body, for the cases the predicate's JSON fixture cannot express. */
  readonly body?: { readonly contentType: string; readonly text: string };
}) {
  const reads: (string | undefined)[] = [];
  const sent: { url: string; headers: Record<string, string> }[] = [];
  let readIndex = 0;
  const page = {
    evaluate: async (_fn: unknown, arg?: Record<string, unknown>) => {
      if (typeof arg?.["accessKey"] === "string") {
        const state = options.states[Math.min(readIndex, options.states.length - 1)];
        reads.push(state);
        readIndex += 1;
        return { state, legacy: undefined };
      }
      if (typeof arg?.["url"] === "string") {
        sent.push({ url: String(arg["url"]), headers: { ...(arg["headers"] as Record<string, string>) } });
        return options.body === undefined
          ? {
            status: 200,
            contentType: "application/json",
            text: JSON.stringify(options.payload ?? AUTHENTICATED_TASK_LIST),
          }
          : { status: 200, contentType: options.body.contentType, text: options.body.text };
      }
      throw new Error("the simulated page does not implement this evaluation");
    },
  } as unknown as Page;
  return { page, reads, sent };
}

function openerFor(page: Page) {
  return async () => ({ page, close: async () => {} });
}

/** The bounded wait, shrunk so the suite stays fast; the production defaults are the real ones. */
const FAST_HYDRATION = { timeoutMs: 500, pollIntervalMs: 5 } as const;

describe("issue #299 — the live page, not the capture, is the authority", () => {
  test("a stale loggedOut capture whose page restores a token authenticates and stores", async () => {
    const home = freshHome();
    const directory = freshDirectory("issue-299-live-page-");
    // The exact live shape: the capture's state says signed out (and even carries a leftover token);
    // the page, opened with those cookies, repairs that state and exposes a valid token.
    const stale = tokenStateEntry(STALE_CAPTURE_TOKEN, { loggedOut: true });
    const live = tokenStateEntry(LIVE_PAGE_TOKEN);
    const { page, reads, sent } = simulatedQwenPage({
      states: [stale.value, stale.value, live.value],
    });
    const source = writeState(directory, captureWithTokenState(stale));
    const { provider, stores } = countingProvider(qwenCodeAuthImportProvider({
      openPage: openerFor(page),
      hydration: FAST_HYDRATION,
    }));

    const result = await importProviderSession({ provider, from: source, now: () => NOW });

    expect(result.verified).toBe(true);
    expect(stores()).toBe(1);
    // It polled the page's own state instead of trusting (or ignoring) the capture on a timer.
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(sent).toHaveLength(1);
    // The header is the live page's token, never the stale capture entry's.
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${LIVE_PAGE_TOKEN}`);
    expect(sent[0]!.headers.authorization).not.toBe(`Bearer ${STALE_CAPTURE_TOKEN}`);
    expect(sent[0]!.headers.source).toBe("web");

    // A verified session lands in the provider's layout, and no token is echoed anywhere.
    expect(result.path).toBe(join(home, "providers", QWEN_CODE_PROVIDER_ID, "storage-state.json"));
    expect(existsSync(result.path)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(LIVE_PAGE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(STALE_CAPTURE_TOKEN);
  });

  test("neither the capture nor the page has a token: the honest refusal, nothing stored", async () => {
    const home = freshHome();
    const directory = freshDirectory("issue-299-no-page-token-");
    const source = writeState(directory, CAPTURE_WITHOUT_TOKEN);
    const { page, sent } = simulatedQwenPage({ states: [undefined], payload: ANONYMOUS_TASK_LIST });
    const { provider, stores } = countingProvider(qwenCodeAuthImportProvider({
      openPage: openerFor(page),
      hydration: FAST_HYDRATION,
    }));

    const failure = await importProviderSession({ provider, from: source, now: () => NOW })
      .then(() => undefined, error => error as Error);

    // The page had no token, so the request could only be cookie-only — and the provider said so.
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(failure?.message).toContain("could not be verified against the Qwen Code login surface");
    expect(failure?.message).toContain("HTTP 200");
    expect(failure?.message).toContain("Unauthorized 401 Unauthorized");
    // The specific, honest cause: the page itself does not consider itself signed in.
    expect(failure?.message).toContain("does not consider itself signed in");
    expect(failure?.message).toMatch(/after \d+ms/);
    expect(failure?.message).toContain("sign in again");

    expect(stores()).toBe(0);
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
    expect(failure?.message).not.toContain("SECRET-IMPORT-COOKIE");
  });

  test("the wait is bounded: a page that never hydrates ends in the refusal, not a hang", async () => {
    const directory = freshDirectory("issue-299-hydration-bound-");
    const stale = tokenStateEntry(null, { loggedOut: true });
    const source = writeState(directory, captureWithTokenState(stale));
    const { page, reads } = simulatedQwenPage({ states: [stale.value], payload: ANONYMOUS_TASK_LIST });
    const { provider, stores } = countingProvider(qwenCodeAuthImportProvider({
      openPage: openerFor(page),
      hydration: { timeoutMs: 60, pollIntervalMs: 5 },
    }));

    const started = Date.now();
    const failure = await importProviderSession({ provider, from: source, now: () => NOW })
      .then(() => undefined, error => error as Error);
    const elapsed = Date.now() - started;

    expect(failure?.message).toContain("does not consider itself signed in");
    // The deadline was enforced, and it was the only bound that ended the wait.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(2_000);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(stores()).toBe(0);

    // The same wait, observed directly: it reports the bound it enforced instead of hanging.
    const direct = await awaitQwenPageSession(page, { timeoutMs: 40, pollIntervalMs: 5 });
    expect(direct.hydrated).toBe(false);
    expect(direct.waitedMs).toBeGreaterThanOrEqual(40);
    expect(direct.read.problem).toBe("logged-out");
  });

  test("the token is read from the page, never a constant: changing the page changes the request", async () => {
    for (const [pageToken, other] of [
      [LIVE_PAGE_TOKEN, OTHER_LIVE_PAGE_TOKEN],
      [OTHER_LIVE_PAGE_TOKEN, LIVE_PAGE_TOKEN],
    ] as const) {
      const directory = freshDirectory("issue-299-page-token-");
      const live = tokenStateEntry(pageToken);
      const { page, sent } = simulatedQwenPage({ states: [live.value] });
      const source = writeState(directory, CAPTURE_WITHOUT_TOKEN);
      const { provider } = countingProvider(qwenCodeAuthImportProvider({
        openPage: openerFor(page),
        hydration: FAST_HYDRATION,
      }));

      await importProviderSession({ provider, from: source, now: () => NOW });

      expect(sent[0]!.headers.authorization).toBe(`Bearer ${pageToken}`);
      expect(sent[0]!.headers.authorization).not.toBe(`Bearer ${other}`);
      // ...and the pure assembly follows the same value.
      expect(qwenTaskListRequest(pageToken).headers.authorization).toBe(`Bearer ${pageToken}`);
    }
  });

  test("the live token never reaches the refusal or the console", async () => {
    const directory = freshDirectory("issue-299-live-token-quiet-");
    const live = tokenStateEntry(LIVE_PAGE_TOKEN);
    const { page } = simulatedQwenPage({ states: [live.value], payload: ANONYMOUS_TASK_LIST });
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
    let failure: Error | undefined;
    try {
      failure = await importProviderSession({
        provider: qwenCodeAuthImportProvider({ openPage: openerFor(page), hydration: FAST_HYDRATION }),
        from: writeState(directory, captureWithTokenState(live)),
        now: () => NOW,
      }).then(() => undefined, error => error as Error);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
    }

    // A token was sent, so the refusal is about the session, not the capture.
    expect(failure?.message).toContain("carried the page's own token and was still refused");
    expect(failure?.message).not.toContain(LIVE_PAGE_TOKEN);
    expect(lines.join("\n")).not.toContain(LIVE_PAGE_TOKEN);
  });

  test("the token reader understands the app's persisted state, its legacy key, and its expiry", () => {
    expect(qwenAccessTokenFromPersistedValue(tokenStateEntry(LIVE_PAGE_TOKEN).value, NOW))
      .toEqual({ accessToken: LIVE_PAGE_TOKEN });
    // The legacy key held the bare token.
    expect(qwenAccessTokenFromPersistedValue(LIVE_PAGE_TOKEN, NOW)).toEqual({ accessToken: LIVE_PAGE_TOKEN });
    // A state that says "logged out" is never used as a token.
    expect(qwenAccessTokenFromPersistedValue(tokenStateEntry(LIVE_PAGE_TOKEN, { loggedOut: true }).value, NOW))
      .toEqual({ problem: "logged-out" });
    // The app persists `expiresAt` in epoch milliseconds; a past one is the app's own "refresh me".
    expect(qwenAccessTokenFromPersistedValue(tokenStateEntry(LIVE_PAGE_TOKEN, { expiresAt: NOW - 1 }).value, NOW))
      .toEqual({ problem: "expired" });
    // An unknown expiry is not a reason to reject a token the provider might still accept.
    expect(qwenAccessTokenFromPersistedValue(tokenStateEntry(LIVE_PAGE_TOKEN, { expiresAt: 0 }).value, NOW))
      .toEqual({ accessToken: LIVE_PAGE_TOKEN });
    expect(qwenAccessTokenFromPersistedValue("")).toEqual({ problem: "absent" });
    expect(qwenAccessTokenFromPersistedValue("{not json")).toEqual({ problem: "unreadable" });
    expect(qwenAccessTokenFromPersistedValue(undefined)).toEqual({ problem: "absent" });
  });

  test("a refusal with no recognisable provider code still reports a bounded body snippet", () => {
    const refusal = qwenTaskListRefusal({ success: false, message: "upstream refused the request" });
    expect(refusal).toContain("upstream refused the request");
    // Bounded: one readable line, never the whole body.
    expect(refusal.length).toBeLessThanOrEqual(160);
  });

  test("the cookie-only refusal (no bounded wait) still names the page token", () => {
    const message = qwenTaskListProbeRefusal({
      status: 200,
      payload: ANONYMOUS_TASK_LIST,
      sentAuthorization: false,
      tokenProblem: "absent",
    });
    expect(message).toContain("Unauthorized 401 Unauthorized");
    expect(message).toContain("cookie-only");
    expect(message).toContain("it needs the token the page uses");
    expect(message).toContain("sign in again");
  });

  test("the refusal composer keeps the token out even when it is handed one", () => {
    const message = qwenTaskListProbeRefusal({
      status: 200,
      payload: ANONYMOUS_TASK_LIST,
      sentAuthorization: true,
    });
    expect(message).toContain("Unauthorized 401 Unauthorized");
    expect(message).not.toContain(LIVE_PAGE_TOKEN);
  });

  test("the turn path and the probe path read the page through the same rule", async () => {
    const live = tokenStateEntry(LIVE_PAGE_TOKEN);
    const { page, sent } = simulatedQwenPage({ states: [live.value] });

    const observation = await probeQwenTaskListFromPageAfterHydration(page, FAST_HYDRATION);
    // The turn facility's header (`createQwenPageRequestFacility` uses exactly this helper).
    const turnHeader = await qwenAuthorizationHeaderFromPage(page);

    expect(observation.sentAuthorization).toBe(true);
    expect(turnHeader.authorization).toBe(`Bearer ${LIVE_PAGE_TOKEN}`);
    expect(sent[0]!.headers.authorization).toBe(turnHeader.authorization);
  });

  test("the assembly waits on the observable and reports what it saw", async () => {
    const stale = tokenStateEntry(null, { loggedOut: true });
    const live = tokenStateEntry(LIVE_PAGE_TOKEN);
    const { page, reads } = simulatedQwenPage({ states: [stale.value, live.value] });

    const observation = await probeQwenTaskListFromPageAfterHydration(page, FAST_HYDRATION);

    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(observation.sentAuthorization).toBe(true);
    expect(observation.tokenSource).toBe("page");
    expect(observation.pageSession?.hydrated).toBe(true);
    expect(observation.pageSession?.waitedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("issue #299 — the generic hydration wait is bounded and observable", () => {
  test("a page that is already hydrated costs one read and no wait", async () => {
    let reads = 0;
    const wait = await waitForPageHydration(
      async () => { reads += 1; return "ready"; },
      state => state === "ready",
      { timeoutMs: 1_000, pollIntervalMs: 5 },
    );
    expect(wait.hydrated).toBe(true);
    expect(wait.state).toBe("ready");
    expect(reads).toBe(1);
    expect(wait.waitedMs).toBeLessThan(100);
  });

  test("it polls the observable until the page's own state is ready", async () => {
    const seen = ["signed-out", "signed-out", "token"];
    let reads = 0;
    const wait = await waitForPageHydration(
      async () => seen[Math.min(reads++, seen.length - 1)]!,
      state => state === "token",
      { timeoutMs: 1_000, pollIntervalMs: 5 },
    );
    expect(wait.hydrated).toBe(true);
    expect(wait.state).toBe("token");
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  test("it enforces the deadline instead of hanging on a page that never hydrates", async () => {
    let reads = 0;
    const started = Date.now();
    const wait = await waitForPageHydration(
      async () => { reads += 1; return "signed-out"; },
      state => state === "token",
      { timeoutMs: 40, pollIntervalMs: 5 },
    );
    const elapsed = Date.now() - started;
    expect(wait.hydrated).toBe(false);
    expect(wait.state).toBe("signed-out");
    expect(wait.waitedMs).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1_000);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  test("an observation that throws is 'not yet', and the deadline still ends it", async () => {
    let reads = 0;
    const wait = await waitForPageHydration(
      async () => { reads += 1; throw new Error("page is navigating"); },
      () => true,
      { timeoutMs: 30, pollIntervalMs: 5 },
    );
    expect(wait.hydrated).toBe(false);
    expect(wait.state).toBeUndefined();
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  test("a non-positive bound or interval is refused, not silently defaulted", async () => {
    await expect(waitForPageHydration(async () => 1, () => true, { timeoutMs: 0 }))
      .rejects.toBeInstanceOf(TypeError);
    await expect(waitForPageHydration(async () => 1, () => true, { timeoutMs: 10, pollIntervalMs: 0 }))
      .rejects.toBeInstanceOf(TypeError);
  });
});

/**
 * Issue #299 — a task-list answer the predicate does not recognise must be reported, not discarded.
 *
 * The live failure this covers: the page hydrated, the probe sent its token, and the provider answered
 * HTTP 200 with a body the predicate did not recognise — which the refusal then threw away, leaving
 * "an unrecognised body" with no evidence. These fixtures are recorded shapes, not live calls.
 */
describe("issue #299 — an unrecognised task-list answer is reported, never discarded", () => {
  /** A JWT-shaped synthetic token. It must never appear in a refusal. */
  const SHAPE_TOKEN =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXBsYWNlaG9sZGVy";

  /** Compose exactly as the production probe does: parse, keep the raw body, then refuse. */
  function refusalFor(body: string, contentType: string): string {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = body;
    }
    return qwenTaskListProbeRefusal({
      status: 200,
      payload,
      contentType,
      bodyText: body,
      sentAuthorization: true,
    });
  }

  test("(a) a JSON body with an unknown envelope reports status, content-type and a snippet", () => {
    const body = JSON.stringify({
      success: false,
      data: null,
      request_id: "req-fixture",
      error: { type: "quota_exceeded", message: "daily limit reached" },
    });
    const refusal = refusalFor(body, "application/json");

    expect(refusal).toContain("HTTP 200");
    expect(refusal).toContain("content-type: application/json");
    expect(refusal).toContain("body snippet:");
    // The actual envelope, not a guess from a known shape.
    expect(refusal).toContain('"success":false');
    expect(refusal).toContain("quota_exceeded");
    // Bounded to the pipeline's inner diagnostic limit.
    expect(refusal.length).toBeLessThanOrEqual(300);
  });

  test("(b) a non-JSON HTML block page is named as a document, with its title", () => {
    const body = "<!DOCTYPE html>\n<html lang=\"en\">\n<head><title>Access Verification</title></head>\n"
      + "<body><p>Please complete the slider.</p></body>\n</html>";
    const refusal = refusalFor(body, "text/html; charset=utf-8");

    expect(refusal).toContain("HTTP 200");
    expect(refusal).toContain("content-type: text/html; charset=utf-8");
    expect(refusal).toContain("the provider answered with a non-JSON document");
    expect(refusal).toContain("Access Verification");
    // Not dressed up as a JSON payload.
    expect(refusal).not.toContain("body snippet");
    expect(refusal.length).toBeLessThanOrEqual(300);
    expect(refusal).not.toContain(SHAPE_TOKEN);
  });

  test("(c) an empty body says so instead of pretending it was JSON", () => {
    const refusal = refusalFor("", "application/json");

    expect(refusal).toContain("HTTP 200");
    expect(refusal).toContain("content-type: application/json");
    expect(refusal).toContain("empty body");
    expect(refusal.length).toBeLessThanOrEqual(300);
  });

  test("(d) a body that is only a token-like string is redacted", () => {
    const refusal = refusalFor(SHAPE_TOKEN, "text/plain");

    expect(refusal).toContain("HTTP 200");
    expect(refusal).toContain("content-type: text/plain");
    expect(refusal).toContain("[redacted]");
    expect(refusal).not.toContain(SHAPE_TOKEN);
    // Not even a fragment of the token survives.
    expect(refusal).not.toContain(SHAPE_TOKEN.slice(0, 16));
    expect(refusal.length).toBeLessThanOrEqual(300);
  });

  test("the page-bound sender keeps the answer the refusal needs", async () => {
    // The regression that made the live refusal blind: the sender used to keep only `payload`, so a
    // non-JSON body arrived as a bare string with no content type and no raw text.
    const body = "<!DOCTYPE html><html><head><title>Access Verification</title></head></html>";
    const live = tokenStateEntry(LIVE_PAGE_TOKEN);
    const { page } = simulatedQwenPage({
      states: [live.value],
      body: { contentType: "text/html; charset=utf-8", text: body },
    });

    const observation = await probeQwenTaskListFromPageAfterHydration(page, FAST_HYDRATION);

    expect(observation.status).toBe(200);
    expect(observation.contentType).toBe("text/html; charset=utf-8");
    expect(observation.bodyText).toBe(body);
    // The predicate still sees a non-object for a non-JSON body, so it cannot authenticate.
    expect(qwenTaskListRefusal(observation.payload, observation)).toContain("non-JSON document");

    const refusal = qwenTaskListProbeRefusal(observation);
    expect(refusal).toContain("content-type: text/html; charset=utf-8");
    expect(refusal).toContain("Access Verification");
    expect(refusal.length).toBeLessThanOrEqual(300);
    expect(refusal).not.toContain(LIVE_PAGE_TOKEN);
  });

  test("a known provider message containing a token is redacted too", () => {
    const refusal = qwenTaskListRefusal({ success: false, message: `rejected token ${SHAPE_TOKEN}` });
    expect(refusal).toContain("rejected token");
    expect(refusal).toContain("[redacted]");
    expect(refusal).not.toContain(SHAPE_TOKEN);
  });

  test("a short secret in a credential-named field is redacted by name, not only by length", () => {
    const body = JSON.stringify({
      success: false,
      data: { token: "short-session-value", note: "unfamiliar envelope" },
    });
    const refusal = refusalFor(body, "application/json");

    expect(refusal).not.toContain("short-session-value");
    expect(refusal).toContain("[redacted]");
    // The non-secret part of the envelope is still visible.
    expect(refusal).toContain("unfamiliar envelope");
  });
});
