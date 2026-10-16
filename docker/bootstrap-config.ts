/**
 * Container bootstrap: write a default `config.json` when the data volume has none.
 *
 * Why this exists (issue #246): a fresh data volume is empty, and `serve` refuses to start without a
 * configuration, so `docker compose up -d` could never become healthy on a clean host. This writes the
 * same default `setup` would write *before* its login step — deterministic, no provider session, no
 * secrets beyond a freshly generated control token — and the entrypoint announces it on stderr.
 *
 * The relative import works both in the image (`/app/docker/…` → `/app/src/config.ts`) and when run
 * from a repository checkout, so it can be exercised locally:
 *   DSH_CHATGPT_WEB_HOME=<dir> bun docker/bootstrap-config.ts
 *
 * `defaultConfig()` records a durable runtime command, so this must run as a FILE and from a
 * non-ephemeral path (never `bun -e`, never from /tmp).
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
