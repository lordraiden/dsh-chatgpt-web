#!/usr/bin/env node
/**
 * Container base-image pin check (issue #246).
 *
 * The Playwright image must match the installed `playwright-core` exactly: if the versions differ,
 * Playwright cannot locate its browser executables inside the container, and the failure only shows
 * up at the first browser turn. This keeps the three declarations that encode that version — the
 * lockfile, the Dockerfile ARG and the Compose build arg — from drifting apart.
 *
 * It is intentionally offline (no registry call) so it can run in the ordinary test chain.
 *
 * Usage: node scripts/test-246-container-pin.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(repoRoot, name), "utf8");

const failures = [];
const fail = (message) => failures.push(message);

function playwrightVersionFromLock() {
  const lock = read("bun.lock");
  const match = /"playwright-core"\s*:\s*\[\s*"playwright-core@(\d+\.\d+\.\d+)"/.exec(lock);
  return match?.[1];
}

function dockerfileArg() {
  const match = /^ARG\s+PLAYWRIGHT_VERSION=(\S+)\s*$/m.exec(read("Dockerfile"));
  return match?.[1];
}

function composeArg() {
  const text = read("docker-compose.yml");
  const matches = [...text.matchAll(/^\s*PLAYWRIGHT_VERSION:\s*"([^"]+)"\s*$/gm)].map((entry) => entry[1]);
  const unique = [...new Set(matches)];
  if (unique.length > 1) fail(`docker-compose.yml declares conflicting PLAYWRIGHT_VERSION values: ${unique.join(", ")}`);
  return unique[0];
}

const lock = playwrightVersionFromLock();
const dockerfile = dockerfileArg();
const compose = composeArg();

if (!lock) fail("could not read playwright-core's version from bun.lock");
if (!dockerfile) fail("Dockerfile does not declare `ARG PLAYWRIGHT_VERSION=<version>`");
if (!compose) fail('docker-compose.yml does not declare `PLAYWRIGHT_VERSION: "<version>"`');

if (lock && dockerfile && lock !== dockerfile) {
  fail(`bun.lock has playwright-core ${lock} but the Dockerfile pins ${dockerfile} (the container's browser build would not match the package)`);
}
if (lock && compose && lock !== compose) {
  fail(`bun.lock has playwright-core ${lock} but docker-compose.yml pins ${compose}`);
}

if (failures.length > 0) {
  console.error("container base-image pin check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nUpdate the Dockerfile ARG and the Compose build arg together with playwright-core.");
  process.exit(1);
}

console.log(`container base-image pin check passed (playwright-core ${lock})`);
