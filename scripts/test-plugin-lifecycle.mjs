import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const plugin = readFileSync(resolve(root, "src", "plugin.ts"), "utf8");

const healthGuard = plugin.indexOf("if (generation !== startGeneration) return;");
const spawnIndex = plugin.indexOf("const child = spawn(");
const timeoutCleanup = plugin.indexOf('await terminateChild(child, logger, "sidecar startup child")');

assert(healthGuard > 0, "startup must invalidate a superseded generation before spawn");
assert(spawnIndex > healthGuard, "generation guard must execute before child creation");
assert(timeoutCleanup > spawnIndex, "startup timeout must terminate the owned child");
assert(plugin.includes("async function waitForChildExit"), "lifecycle must await child exit");
assert(plugin.includes("async function terminateChild"), "lifecycle must escalate stuck children");
assert(plugin.includes('await terminateChild(child, logger, "owned sidecar")'), "shutdown must await owned child termination");
assert(!plugin.includes("/admin/shutdown"), "plugin must not rely on the unauthenticated admin shutdown route");

console.log("plugin lifecycle source contracts passed");
