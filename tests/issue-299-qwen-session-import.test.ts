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
} from "../scripts/qwen-storage-state.mjs";
import {
  importProviderSession,
  qwenCodeAuthImportProvider,
  readImportedStorageState,
  type AuthImportProvider,
} from "../src/auth-import";
import { QWEN_CODE_COOKIE_DOMAINS } from "../src/adapters/qwen-code/session-store";
import { QWEN_CODE_PROVIDER_ID } from "../src/adapters/qwen-code/provider";
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
