/**
 * Issue #267 — the container's first-run bootstrap must run under node, not bun.
 *
 * `docker/entrypoint.sh` brings an empty data volume up by writing a default `config.json` and then
 * `exec node lib/cli.js "$@"`, so the bootstrap step has to run on the same runtime as the service.
 * It used to be the one step that needed bun: `node /app/docker/bootstrap-config.ts` died with
 * `ERR_MODULE_NOT_FOUND …/chatgpt-web-models`, because the module graph it reaches relied on the
 * bundler's extensionless resolution, which Node's ESM loader does not perform. An operator who
 * removed or broke bun on an empty volume got no configuration and a service that refused to start.
 *
 * Two facts are pinned here, without a container build:
 *   1. the shipped bootstrap file runs to completion on `node` against an empty data home;
 *   2. the entrypoint drives that step with `node`, so bun is not required to bring a volume up.
 *
 * `spawnSync("node", …)` is deliberate: `bun test` itself runs on bun, and the point of the test is
 * the other runtime. The container-level form of this check — the entrypoint with bun removed from
 * PATH inside the built image — is `docker/verify-container.sh` step 4b and the container workflow.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = join(repoRoot, "docker", "bootstrap-config.ts");
const entrypointPath = join(repoRoot, "docker", "entrypoint.sh");

/**
 * The `node` on PATH, resolved explicitly so the assertion can prove it is not the bun running this
 * suite. A missing node is a hard failure: the container's engines require it, and a silent skip
 * would retire the whole check.
 */
function nodeRuntime(): string {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  for (const directory of (process.env.PATH ?? "").split(pathSeparator)) {
    if (!directory) continue;
    const candidate = join(directory, executableName);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("issue #267: node is not on PATH; the bootstrap-under-node check cannot run");
}

/** Run the real bootstrap file on node against the given (empty) data home. */
function runBootstrap(node: string, home: string) {
  const env = { ...process.env };
  // The legacy alias must not redirect the child away from the home this test owns.
  delete env.DSH_CHATGPT_FREE_HOME;
  env.DSH_CHATGPT_WEB_HOME = home;
  return spawnSync(node, [bootstrapPath], { cwd: repoRoot, encoding: "utf8", env });
}

describe("issue #267 — the first-run bootstrap runs under node", () => {
  test("node writes the default configuration on an empty data home", () => {
    const node = nodeRuntime();
    expect(basename(node).replace(/\.exe$/i, "")).toBe("node");

    const home = mkdtempSync(join(tmpdir(), "dsh-267-node-bootstrap-"));
    try {
      const result = runBootstrap(node, home);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error).toBeUndefined();
      expect(output).toContain("wrote default configuration");
      expect(result.status).toBe(0);

      const configPath = join(home, "config.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(config.version).toBe(3);
      expect(config.releaseVersion).toBe("container");
      expect(config.mode).toBe("browser-only");
      expect(config.host).toBe("127.0.0.1");
      expect(typeof config.controlToken).toBe("string");
      expect((config.controlToken as string).length).toBeGreaterThanOrEqual(40);

      // A second run must leave an existing configuration untouched (the entrypoint's contract
      // is "bootstrap only when the volume has none").
      const before = readFileSync(configPath, "utf8");
      const second = runBootstrap(node, home);
      expect(`${second.stdout}${second.stderr}`).toContain("configuration already present");
      expect(second.status).toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the entrypoint drives the bootstrap with node, never bun", () => {
    expect(existsSync(bootstrapPath)).toBe(true);
    const executed = readFileSync(entrypointPath, "utf8")
      .split("\n")
      // Comments may name bun; only the lines the shell actually runs are the requirement.
      .filter((line) => !line.trimStart().startsWith("#"));
    const bootstrapLines = executed.filter((line) => line.includes("bootstrap-config.ts"));
    expect(bootstrapLines.length).toBeGreaterThan(0);
    for (const line of bootstrapLines) expect(line).toMatch(/\bnode\b/);
    expect(executed.join("\n")).not.toMatch(/(^|\s)bun(\s|$)/);
  });
});
