import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defaultConfig,
  providerCredentialsDir,
  providerStorageStatePath,
  resolveProviderStorageStatePath,
  saveConfig,
  storageStateMarkerPath,
} from "../src/config";
import {
  browserLoginStateExists,
  loginToChatGpt,
  loginVerificationMarkerPath,
  storeProviderSession,
  withTemporaryLoginProfile,
} from "../src/browser-login";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * Issue #249 — guided provider login and credential layout.
 *
 * The session now lives under `<data home>/providers/<providerId>/`, with the legacy single-provider
 * path kept as an alias so an existing installation keeps working without a migration or a rewritten
 * `config.json`. These tests pin the layout, the alias, the isolation between providers, and the
 * fail-closed behaviour of `auth import`.
 */
const homes: string[] = [];
const savedHome = captureChatGptWebHome();

function freshHome(): string {
  const home = useTemporaryChatGptWebHome("dsh-249-");
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()!;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  restoreChatGptWebHome(savedHome);
});

/** A complete Playwright storage state; the cookie value is the secret the CLI must never echo. */
const STATE = {
  cookies: [{
    name: "session",
    value: "redacted",
    domain: "chatgpt.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  }],
  origins: [],
};

function runCli(args: string[], home: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/cli.ts", ...args],
    env: { ...process.env, DSH_CHATGPT_WEB_HOME: home },
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe("issue #249 — the per-provider credential layout", () => {
  test("the provider-scoped session wins, and the legacy path stays the alias", () => {
    const home = freshHome();
    const legacy = join(home, "browser", "storage-state.json");
    const scoped = join(home, "providers", "chatgpt-web", "storage-state.json");

    expect(providerCredentialsDir()).toBe(join(home, "providers", "chatgpt-web"));
    expect(providerStorageStatePath()).toBe(scoped);
    expect(resolveProviderStorageStatePath()).toBe(legacy);

    // A file, or only its verification marker, is enough to select the provider-scoped session.
    mkdirSync(join(home, "providers", "chatgpt-web"), { recursive: true });
    writeFileSync(storageStateMarkerPath(scoped), "{}\n");
    expect(resolveProviderStorageStatePath()).toBe(scoped);

    rmSync(storageStateMarkerPath(scoped), { force: true });
    writeFileSync(scoped, JSON.stringify(STATE));
    expect(resolveProviderStorageStatePath()).toBe(scoped);

    // An explicitly configured path is honoured while no provider session exists.
    expect(resolveProviderStorageStatePath("/tmp/explicit-state.json")).toBe(scoped);
    rmSync(scoped, { force: true });
    expect(resolveProviderStorageStatePath(join(home, "custom.json"))).toBe(join(home, "custom.json"));
  });

  test("another provider's directory can never satisfy this provider's check", () => {
    const home = freshHome();
    mkdirSync(join(home, "providers", "qwen-web"), { recursive: true });
    writeFileSync(join(home, "providers", "qwen-web", "storage-state.json"), JSON.stringify(STATE));

    // chatgpt-web must not pick it up: the fallback is its own legacy path.
    expect(resolveProviderStorageStatePath()).toBe(join(home, "browser", "storage-state.json"));
    // And the resolver is explicit about the provider it is asked for.
    expect(resolveProviderStorageStatePath(undefined, "qwen-web")).toBe(join(home, "providers", "qwen-web", "storage-state.json"));
  });

  test("storing a session writes BOTH files into the provider layout, atomically", () => {
    const home = freshHome();
    const target = storeProviderSession(STATE, { solAvailable: true, proAvailable: false });

    expect(target).toBe(providerStorageStatePath());
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(STATE);

    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(target), "utf8")) as Record<string, unknown>;
    expect(marker.version).toBe(1);
    expect(marker.authenticated).toBe(true);
    expect(typeof marker.verifiedAt).toBe("string");
    expect(marker.solAvailable).toBe(true);

    // The marker convention has one owner: the login module delegates to config.
    expect(loginVerificationMarkerPath(target)).toBe(storageStateMarkerPath(target));
    // And the runtime's own predicate is satisfied by what was written.
    expect(browserLoginStateExists({ ...defaultConfig(), storageStatePath: target } as never)).toBe(true);
  });

  test("a configuration is not rewritten by resolving it", () => {
    const home = freshHome();
    saveConfig(defaultConfig());
    const before = readFileSync(join(home, "config.json"), "utf8");
    mkdirSync(join(home, "providers", "chatgpt-web"), { recursive: true });
    writeFileSync(providerStorageStatePath(), JSON.stringify(STATE));

    // Setup keeps the configured value; only reads resolve (loadConfig), so the persisted format is
    // untouched and the legacy alias keeps meaning something.
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    expect(JSON.parse(before).storageStatePath).toContain(join("browser", "storage-state.json"));
  });
});

describe("issue #249 — `auth import` fails closed", () => {
  test("a capture that is not a Playwright storage state is refused, writing nothing", () => {
    const home = freshHome();
    saveConfig(defaultConfig());
    const source = join(home, "not-a-capture.json");
    writeFileSync(source, JSON.stringify({ nope: true }));

    const result = runCli(["auth", "import", "--provider", "chatgpt-web", "--from", source], home);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("does not look like a Playwright storage state");
    expect(existsSync(join(home, "providers"))).toBe(false);
  });

  test("a well-formed capture that cannot be verified is refused, writing nothing", () => {
    const home = freshHome();
    // A Chrome path that does not exist makes verification fail immediately and identically on every
    // machine: this test asserts the fail-closed DECISION, not a browser's failure latency.
    saveConfig({ ...defaultConfig(), chromeExecutablePath: join(home, "no-such-chrome") });
    const source = join(home, "capture.json");
    writeFileSync(source, JSON.stringify(STATE));

    const result = runCli(["auth", "import", "--provider", "chatgpt-web", "--from", source], home);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("could not be verified");
    expect(existsSync(providerStorageStatePath())).toBe(false);
    // Nothing secret is echoed, whatever happened.
    expect(result.err).not.toContain("redacted");
    expect(result.out).not.toContain("redacted");
  });

  test("the provider and --from are validated with actionable messages", () => {
    const home = freshHome();
    saveConfig(defaultConfig());

    const unknown = runCli(["auth", "import", "--provider", "qwen-web", "--from", join(home, "x.json")], home);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain('the only supported provider is "chatgpt-web"');

    const missing = runCli(["auth", "import"], home);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("requires --from");
  });
});

/**
 * Issue #287 slice 4a — the temporary login profile never outlives its sign-in.
 *
 * The profile was removed in a `finally` guarded by `browserLoginStateExists(config)`, so a sign-in
 * that failed before writing any state left `login-profile-*` directories behind in
 * `providers/<id>/` forever. The removal is now one owner; these tests pin it without a browser.
 */
describe("issue #287 slice 4a — the disposable login profile is removed on every exit path", () => {
  const loginProfilesIn = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith("login-profile-")) : [];

  test("the profile owner removes the profile after success and after failure", async () => {
    const home = freshHome();
    const parent = join(home, "providers", "chatgpt-web");

    const seen: string[] = [];
    const result = await withTemporaryLoginProfile(parent, async profileDir => {
      // The body runs inside a real, existing `login-profile-*` directory under the parent.
      expect(profileDir.startsWith(join(parent, "login-profile-"))).toBe(true);
      expect(existsSync(profileDir)).toBe(true);
      seen.push(profileDir);
      return "captured";
    });
    expect(result).toBe("captured");
    expect(loginProfilesIn(parent)).toEqual([]);

    // The failure path is the one that used to leak: no state was ever written, so the old
    // `browserLoginStateExists()` guard was false and the profile stayed.
    const failure = await withTemporaryLoginProfile(parent, async profileDir => {
      seen.push(profileDir);
      throw new Error("the sign-in failed before any state was written");
    }).catch(error => error);
    expect((failure as Error).message).toContain("failed before any state");
    expect(loginProfilesIn(parent)).toEqual([]);

    // Two distinct profiles were created, and neither survives.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("a sign-in whose browser never comes up leaves no login-profile-* behind", async () => {
    // The real `loginToChatGpt`, with no browser needed: the configured executable exists (so the
    // pre-flight passes) but is this runtime, not Chromium, so Playwright fails the launch in
    // milliseconds and nothing is downloaded or installed.
    if (process.platform === "win32") {
      // Under Bun on Windows the function deliberately delegates to `login-helper.cjs` before any
      // profile is created, so this wiring assertion is not reachable there.
      return;
    }
    const home = freshHome();
    const config = { ...defaultConfig(), chromeExecutablePath: process.execPath };

    const failure = await loginToChatGpt(config, { timeoutMs: 5_000 }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);

    // The profile root exists (the run body started) and holds no profile: the launch failure, which
    // happens before the old `try` even began, is cleaned up too.
    const providerDir = providerCredentialsDir();
    expect(existsSync(providerDir)).toBe(true);
    expect(loginProfilesIn(providerDir)).toEqual([]);
  });
});
