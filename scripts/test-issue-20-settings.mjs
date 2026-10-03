import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = readFileSync(resolve(root, "client.js"), "utf8");
const plugin = readFileSync(resolve(root, "src", "plugin.ts"), "utf8");
const cli = readFileSync(resolve(root, "src", "cli.ts"), "utf8");

assert(!client.includes("localStorage"), "control token must not use localStorage");
assert(!client.includes("sessionStorage"), "control token must not use sessionStorage");
assert(!client.includes("dsh-chatgpt-web.controlToken"), "legacy persistent token key must be gone");
assert(!client.includes("127.0.0.1:17841"), "client must not hard-code the default sidecar port");
assert(client.includes("configForms.get(CONFIG_ID)"), "client must consume the DSH config form");
assert(client.includes("inject: ['slots', 'locale', 'configForms']"), "client must inject configForms");
assert(client.includes("const LOOPBACK_HOST = '127.0.0.1'"), "client must retain the loopback-only boundary");
assert(client.includes("React.useState('')"), "control token must start empty in each page session");
assert(client.includes("configForm.subscribe"), "client must follow live port updates");
assert(client.includes("api(base, token, path, options)"), "API helper must use the effective endpoint");

assert(plugin.includes("port: Volatile<number>"), "port must be declared volatile");
assert(plugin.includes(".volatile()"), "port schema must be live");
assert(plugin.includes("loader/volatile-update"), "runtime must react to live port changes");
assert(plugin.includes("Config"), "plugin must export its DSH Config schema");
assert(plugin.includes("resolveLauncher(config.bunPath, host, port)"), "launcher must use the effective configured port");
assert(plugin.includes('"--host", host, "--port", String(port)'), "launcher must pass host and port explicitly");
assert(cli.includes('takeOption(args, "--host")'), "serve must accept a host override");
assert(cli.includes('takeOption(args, "--port")'), "serve must accept a port override");
assert(cli.includes("The sidecar is loopback-only"), "serve must preserve loopback-only access");

console.log("issue #20 settings invariants passed");
