import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultConfig,
  providerCredentialsDir,
  providerStorageStatePath,
  resolveProviderStorageStatePath,
  saveConfig,
  storageStateMarkerPath,
} from "../src/config";
import { browserLoginStateExists, loginVerificationMarkerPath, storeProviderSession } from "../src/browser-login";

/**
 * Issue #249 — guided provider login and credential layout.
 *
 * The session now lives under `<data home>/providers/<providerId>/`, with the legacy single-provider
 * path kept as an alias so an existing installation keeps working without a migration or a rewritten
 * `config.json`. These tests pin the layout, the alias, the isolation between providers, and the
 * fail-closed behaviour of `auth import`.
 */
const homes: string[] = [];
const originalHome = process.env.DSH_CHATGPT_WEB_HOME;

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-249-"));
  homes.push(home);
  process.env.DSH_CHATGPT_WEB_HOME = home;
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()!;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (originalHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = originalHome;
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
    // The default Chrome path does not exist here, so verification cannot succeed — which is exactly
    // the fail-closed path: no browser proof, no stored session.
    saveConfig(defaultConfig());
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
