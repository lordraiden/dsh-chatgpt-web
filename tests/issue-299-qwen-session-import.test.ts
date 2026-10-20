import { afterEach, describe, expect, test } from "bun:test";
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
  probeQwenTaskListFromCapture,
  qwenAccessTokenFromPersistedValue,
  qwenTaskListProbeRefusal,
  qwenTaskListRefusal,
  qwenTaskListRequest,
} from "../src/adapters/qwen-code/session-probe";
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

  test("a capture written by the script carries the token the probe sends", async () => {
    const directory = freshDirectory("issue-299-capture-to-probe-");
    const outPath = join(directory, "qwen-storage-state.json");
    captureToFile({
      payload: CDP_PAYLOAD,
      outPath,
      stdout: () => {},
      now: NOW,
      storage: [["qwen_access_token_state", JSON.stringify({ token: "SECRET-CAPTURED-TOKEN", loggedOut: false })]],
    });

    const recorded: Record<string, string>[] = [];
    const probe = (state: unknown) => probeQwenTaskListFromCapture(state, async request => {
      recorded.push({ ...request.headers });
      return { status: 200, payload: AUTHENTICATED_TASK_LIST };
    });
    const result = await importProviderSession({
      provider: qwenCodeAuthImportProvider({ probe }),
      from: outPath,
      now: () => NOW,
    });

    expect(recorded[0]!.authorization).toBe("Bearer SECRET-CAPTURED-TOKEN");
    expect(result.verified).toBe(true);
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
 * Issue #299, second pass — the probe authenticates the way the page does.
 *
 * The live result that defines this block: a real Firefox capture (14 cookies, 15 localStorage keys)
 * reached `POST /v1/control/auth/import` and the service answered `import_predicate_failed`, because
 * `GET /coder/api/v2/task/list` was called with cookies only. The recorded HAR of the signed-in app
 * shows every API call carrying `authorization: Bearer <token>` beside the cookies, and the app's own
 * bundle persists that token under `qwen_access_token_state` in localStorage.
 *
 * These tests drive the **production** request assembly with a recording sender, so the header is
 * asserted exactly as it would be sent, without a browser and without network access.
 */

/** Synthetic token values. Both are asserted absent from every diagnostic and from stdout. */
const PAGE_TOKEN = "SECRET-QWEN-PAGE-TOKEN";
const OTHER_PAGE_TOKEN = "SECRET-QWEN-PAGE-TOKEN-CHANGED";

/** The localStorage entry exactly as the app's token manager persists it (recorded shape). */
function tokenStateEntry(token: string) {
  return {
    name: "qwen_access_token_state",
    value: JSON.stringify({
      token,
      expiresAt: 1_900_000_000_000,
      sessionId: "session-fixture",
      loggedOut: false,
      version: 1,
      stateId: "state-fixture",
      updatedAt: 1_790_000_000_000,
      sourceId: "source-fixture",
    }),
  };
}

/** A capture with the provider's cookies plus the page's own token entry. */
function capturedStateWithToken(token: string) {
  return {
    cookies: [IMPORTABLE_STATE.cookies[0]!],
    origins: [{ origin: "https://coder.qwen.ai", localStorage: [tokenStateEntry(token)] }],
  };
}

/** A capture whose cookies are fine but which carries no token (the live failing shape). */
const CAPTURED_STATE_WITHOUT_TOKEN = {
  cookies: [IMPORTABLE_STATE.cookies[0]!],
  origins: [{ origin: "https://coder.qwen.ai", localStorage: [{ name: "theme", value: "dark" }] }],
};

/** A probe built from the real assembly, with a sender that records what would have been sent. */
function recordingProbe(payload: unknown = AUTHENTICATED_TASK_LIST) {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  return {
    sent,
    probe: (state: unknown) => probeQwenTaskListFromCapture(state, async request => {
      sent.push({ url: request.url, headers: { ...request.headers } });
      return { status: 200, payload };
    }),
  };
}

describe("issue #299 — the probe sends the header the app sends, read from the capture", () => {
  test("the request is the captured shape, and success:true authenticates", async () => {
    const home = freshHome();
    const directory = freshDirectory("issue-299-token-");
    const source = writeState(directory, capturedStateWithToken(PAGE_TOKEN));
    const { sent, probe } = recordingProbe();

    const result = await importProviderSession({
      provider: qwenCodeAuthImportProvider({ probe }),
      from: source,
      now: () => NOW,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://coder.qwen.ai/coder/api/v2/task/list?page=1");

    // Exactly the header set the recorded request carries. `authorization` is the page's own token,
    // and the per-call request id is the app's uuid.
    expect(Object.keys(sent[0]!.headers).sort()).toEqual([
      "accept", "authorization", "bx-v", "content-type", "source", "version", "x-request-id",
    ]);
    expect(sent[0]!.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
      source: "web",
      version: "0.0.29",
      "bx-v": "2.5.37",
      authorization: `Bearer ${PAGE_TOKEN}`,
    });
    expect(sent[0]!.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // A `success:true` answer is the authentication, and the session lands in the provider's layout.
    expect(result.verified).toBe(true);
    expect(result.path).toBe(join(home, "providers", QWEN_CODE_PROVIDER_ID, "storage-state.json"));
    expect(result.detail).toContain("success:true");
    // The verification result and the confirmation never carry the token.
    expect(JSON.stringify(result)).not.toContain(PAGE_TOKEN);
    expect(result.detail).not.toContain(PAGE_TOKEN);
  });

  test("the token comes from the capture, not from a constant: changing it changes the request", async () => {
    const directory = freshDirectory("issue-299-token-change-");
    const changed = capturedStateWithToken(OTHER_PAGE_TOKEN);
    const { sent, probe } = recordingProbe();

    await importProviderSession({
      provider: qwenCodeAuthImportProvider({ probe }),
      from: writeState(directory, changed),
      now: () => NOW,
    });

    expect(sent[0]!.headers.authorization).toBe(`Bearer ${OTHER_PAGE_TOKEN}`);
    expect(sent[0]!.headers.authorization).not.toBe(`Bearer ${PAGE_TOKEN}`);
    // ...and the pure assembly follows the same value.
    expect(qwenTaskListRequest(OTHER_PAGE_TOKEN).headers.authorization).toBe(`Bearer ${OTHER_PAGE_TOKEN}`);
  });

  test("a capture without the token is refused with the honest cause, and nothing is stored", async () => {
    const home = freshHome();
    const directory = freshDirectory("issue-299-no-token-");
    const source = writeState(directory, CAPTURED_STATE_WITHOUT_TOKEN);
    const { sent, probe } = recordingProbe(ANONYMOUS_TASK_LIST);
    const { provider, stores } = countingProvider(qwenCodeAuthImportProvider({ probe }));

    const failure = await importProviderSession({ provider, from: source, now: () => NOW })
      .then(() => undefined, error => error as Error);

    // The request went out cookie-only, which is exactly what the page does not do.
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(sent[0]!.headers.source).toBe("web");

    expect(failure?.message).toContain("could not be verified against the Qwen Code login surface");
    // It reports what the provider answered...
    expect(failure?.message).toContain("HTTP 200");
    expect(failure?.message).toContain("Unauthorized 401 Unauthorized");
    // ...and names the cause instead of failing generically.
    expect(failure?.message).toContain("cookie-only");
    expect(failure?.message).toContain("needs the token the page uses");
    expect(failure?.message).toContain("sign in again");

    expect(stores()).toBe(0);
    expect(existsSync(join(home, "providers", QWEN_CODE_PROVIDER_ID))).toBe(false);
    // Neither the cookie nor any token reaches the refusal.
    expect(failure?.message).not.toContain("SECRET-IMPORT-COOKIE");
    expect(failure?.message).not.toContain(PAGE_TOKEN);
  });

  test("the token is never logged, never echoed, and never read from a fixture", async () => {
    const directory = freshDirectory("issue-299-token-quiet-");
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (write: (...args: unknown[]) => void) => (...args: unknown[]) => { lines.push(args.join(" ")); write(...args); };
    console.log = capture(original.log);
    console.warn = capture(original.warn);
    console.error = capture(original.error);
    console.info = capture(original.info);
    try {
      // A failing predicate, so every diagnostic the import can produce is exercised.
      const failing = recordingProbe(ANONYMOUS_TASK_LIST);
      const failure = await importProviderSession({
        provider: qwenCodeAuthImportProvider({ probe: failing.probe }),
        from: writeState(directory, capturedStateWithToken(PAGE_TOKEN)),
        now: () => NOW,
      }).then(() => undefined, error => error as Error);

      expect(failure?.message).toContain("carried the page's own token and was still refused");
      expect(failure?.message).not.toContain(PAGE_TOKEN);
      expect(lines.join("\n")).not.toContain(PAGE_TOKEN);
      // Production never consults a fixture: the request that was sent carries the capture's value.
      expect(failing.sent[0]!.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
    }
  });

  test("the token reader understands the app's persisted state and its legacy key", () => {
    expect(qwenAccessTokenFromPersistedValue(tokenStateEntry(PAGE_TOKEN).value)).toEqual({ accessToken: PAGE_TOKEN });
    // The legacy key held the bare token.
    expect(qwenAccessTokenFromPersistedValue(PAGE_TOKEN)).toEqual({ accessToken: PAGE_TOKEN });
    // A state that says "logged out" is never used as a token.
    expect(qwenAccessTokenFromPersistedValue(JSON.stringify({ token: PAGE_TOKEN, loggedOut: true })))
      .toEqual({ problem: "logged-out" });
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

  test("a token that was sent and refused says the session, not the capture, is the problem", async () => {
    const directory = freshDirectory("issue-299-token-refused-");
    const { probe } = recordingProbe(ANONYMOUS_TASK_LIST);
    const failure = await importProviderSession({
      provider: qwenCodeAuthImportProvider({ probe }),
      from: writeState(directory, capturedStateWithToken(PAGE_TOKEN)),
      now: () => NOW,
    }).then(() => undefined, error => error as Error);

    expect(failure?.message).toContain("carried the page's own token and was still refused");
    expect(failure?.message).toContain("Unauthorized 401 Unauthorized");
    // The generic "cookies only" cause must not be claimed when a token was sent.
    expect(failure?.message).not.toContain("cookie-only");
    expect(failure?.message).not.toContain(PAGE_TOKEN);
  });

  test("the refusal composer keeps the token out even when it is handed one", () => {
    const message = qwenTaskListProbeRefusal({
      status: 200,
      payload: ANONYMOUS_TASK_LIST,
      sentAuthorization: true,
    });
    expect(message).toContain("Unauthorized 401 Unauthorized");
    expect(message).not.toContain(PAGE_TOKEN);
  });
});
