import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  loadConfigForSetup,
  migrateReleaseVersion,
  saveConfig,
} from "../src/config";
import { VERSION } from "../src/version";

function withTemporaryConfigHome(run: () => void): void {
  const previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  const previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-chatgpt-web-release-migration-"));
  try {
    delete process.env.DSH_CHATGPT_FREE_HOME;
    process.env.DSH_CHATGPT_WEB_HOME = home;
    run();
  } finally {
    if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
    else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
    if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
    else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("automatic release version migration", () => {
  test("loadConfig promotes an older persisted release version and writes it back", () => {
    withTemporaryConfigHome(() => {
      const config = defaultConfig();
      saveConfig({ ...config, releaseVersion: "1.0.8" });

      const loaded = loadConfig();

      expect(loaded.releaseVersion).toBe(VERSION);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { releaseVersion?: unknown };
      expect(persisted.releaseVersion).toBe(VERSION);
    });
  });

  test("loadConfigForSetup uses the same automatic migration", () => {
    withTemporaryConfigHome(() => {
      const config = defaultConfig();
      saveConfig({ ...config, releaseVersion: "0.9.0" });

      const loaded = loadConfigForSetup();

      expect(loaded.releaseVersion).toBe(VERSION);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { releaseVersion?: unknown };
      expect(persisted.releaseVersion).toBe(VERSION);
    });
  });

  test("same-version config is left unchanged", () => {
    const config = { ...defaultConfig(), releaseVersion: VERSION };
    expect(migrateReleaseVersion(config)).toBe(config);
  });

  test("newer persisted config is never silently downgraded", () => {
    const config = { ...defaultConfig(), releaseVersion: "99.0.0" };
    expect(() => migrateReleaseVersion(config)).toThrow("refusing automatic downgrade");
  });
});
