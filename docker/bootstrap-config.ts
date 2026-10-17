/**
 * Container bootstrap: write a default `config.json` when the data volume has none.
 *
 * Why this exists (issue #246): a fresh data volume is empty, and `serve` refuses to start without a
 * configuration, so `docker compose up -d` could never become healthy on a clean host. This writes the
 * same default `setup` would write *before* its login step — deterministic, no provider session, no
 * secrets beyond a freshly generated control token — and the entrypoint announces it on stderr.
 *
 * The entrypoint runs this file with `node` — the same runtime as `node lib/cli.js` — so everything it
 * reaches must be resolvable by Node's ESM loader, which never adds an extension: the relative
 * specifiers in `src/config.ts` and the modules it imports are fully specified (issue #267). Bun
 * resolves both forms, so this file can still be exercised locally either way:
 *   DSH_CHATGPT_WEB_HOME=<dir> node docker/bootstrap-config.ts
 *   DSH_CHATGPT_WEB_HOME=<dir> bun docker/bootstrap-config.ts
 *
 * `defaultConfig()` records a durable runtime command, so this must run as a FILE and from a
 * non-ephemeral path (never an evaluated script, never from /tmp).
 */
import { existsSync } from "node:fs";
import { defaultConfig, saveConfig, getConfigPath } from "../src/config.ts";

const path = getConfigPath();
if (existsSync(path)) {
  console.log(`configuration already present: ${path}`);
} else {
  const config = defaultConfig("browser-only");
  config.releaseVersion = "container";
  saveConfig(config);
  console.log(`wrote default configuration: ${path}`);
}
