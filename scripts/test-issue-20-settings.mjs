import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");
const client = readFileSync(resolve(root, "client.js"), "utf8");
const plugin = readFileSync(resolve(root, "src", "plugin.ts"), "utf8");
const supervisor = readFileSync(resolve(root, "src", "sidecar-supervisor.ts"), "utf8");
const cli = readFileSync(resolve(root, "src", "cli.ts"), "utf8");
const config = readFileSync(resolve(root, "src", "config.ts"), "utf8");

assert(!client.includes("localStorage.getItem"), "client must not read a persisted control token");
assert(!client.includes("localStorage.setItem"), "client must not write a persisted control token");
assert(client.includes("localStorage.removeItem(LEGACY_TOKEN_KEY)"), "migration must remove the legacy persisted token key");
assert(!client.includes("sessionStorage"), "control token must not use sessionStorage");
assert(!client.includes("127.0.0.1:17841"), "client must not hard-code the default sidecar port");
assert(client.includes("configForms.get(CONFIG_ID)"), "client must consume the DSH config form");
assert(client.includes("inject: ['slots', 'locale', 'configForms']"), "client must inject configForms");
assert(client.includes("plugins.bundle.config"), "client must use the DSH 0.2 plugin configuration seat");
assert(client.includes("BUNDLE_CONFIG_KEY = '@lordraiden/dsh-chatgpt-web'"), "client must key bundle configuration by package name");
assert(!client.includes("settings.section"), "client must not register an obsolete settings.section page");
assert(client.includes("configForm.mutate"), "runtime settings must use the canonical DSH config form write path");
assert(client.includes("const RUNTIME_DEFAULTS"), "client must expose runtime setting defaults in the UI");
assert(client.includes("const LOOPBACK_HOST = '127.0.0.1'"), "client must retain the loopback-only boundary");
assert(client.includes("React.useState('')"), "control token must start empty in each page session");
assert(client.includes("configForm.subscribe"), "client must follow live port updates");
assert(client.includes("api(base, token, path, options)"), "API helper must use the effective endpoint");

assert(plugin.includes("port: Volatile<number>"), "port must be declared volatile");
assert(plugin.includes("autoStart: Volatile<boolean>"), "autoStart must be declared volatile");
assert(plugin.includes("readyTimeoutMs: Volatile<number>"), "readyTimeoutMs must be declared volatile");
assert(plugin.includes(".volatile()"), "runtime schema fields must be live");
assert(plugin.includes("loader/volatile-update"), "runtime must react to live configuration changes");
assert(plugin.includes("readBoolean(config.autoStart, true)"), "runtime must read the live autoStart value");
assert(plugin.includes("readReadyTimeout(config.readyTimeoutMs)"), "runtime must read the live ready timeout");
assert(plugin.includes("Config"), "plugin must export its DSH Config schema");
assert(plugin.includes("new SidecarSupervisor("), "plugin must delegate sidecar lifecycle to the single supervisor");
assert(supervisor.includes("resolveLauncher(targetBunPath, targetPort)"), "launcher must use the operation snapshot of the configured port");
assert(plugin.includes('"--host", DEFAULT_HOST, "--port", String(port)'), "launcher must preserve the loopback boundary and pass the effective port");
assert(supervisor.includes("const generation = ++this.generation"), "live reconfiguration must invalidate an in-flight start");
assert(supervisor.includes("if (this.spawnedProcess === child)"), "old sidecar exits must not clear ownership of a newer child");
assert(!plugin.includes("host?: string"), "host must not become a configurable plugin field");
assert(config.includes("contextWindow?: number"), "legacy contextWindow must be optional");
assert(config.includes("New configurations do not write it") || config.includes("New configurations do not write it;"), "new config must stop treating contextWindow as a user capacity setting");
assert(config.includes("resolveChatGptWebContextLimits("), "provider config must derive context from route limits");
assert(!config.includes("contextWindow: 256_000"), "default config must not invent a 256K user capacity");
assert(cli.includes('takeOption(args, "--host")'), "serve must accept a host override");
assert(cli.includes('takeOption(args, "--port")'), "serve must accept a port override");
assert(cli.includes("--host must be 127.0.0.1; the sidecar is loopback-only"), "serve must preserve loopback-only access");

async function exerciseClient(port) {
  const state = [];
  let cursor = 0;
  let page;
  const listeners = new Set();
  const requests = [];
  const storage = { removed: [] };

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) {
        state[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        state[index],
        value => {
          state[index] = typeof value === "function" ? value(state[index]) : value;
        },
      ];
    },
    useEffect(effect) {
      const cleanup = effect();
      return cleanup;
    },
  };

  const form = {
    value: { port },
    getSnapshot() {
      return { status: "ready", value: this.value };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const sandbox = {
    console,
    Promise,
    Number,
    setTimeout,
    clearTimeout,
    setImmediate,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    removeItem(key) {
      storage.removed.push(key);
    },
  };
  sandbox.fetch = async url => {
    const text = String(url);
    requests.push(text);
    const payload = text.includes("/recent-turns")
      ? { turns: [] }
      : text.endsWith("/v1/control/config")
        ? { tuning: {}, defaults: {} }
        : {
            version: "1.0.3",
            pid: 1,
            uptime: 1,
            accepting_turns: true,
            active_http_turns: 0,
            active_browser_turns: 0,
            storageStatePresent: true,
            storageDir: "/tmp",
            chromeExecutablePath: "/usr/bin/google-chrome",
            headed: false,
            solAvailable: true,
            proAvailable: false,
          };
    return { ok: true, status: 200, json: async () => payload };
  };
  sandbox.__ModuleLoader__ = {
    load(payload) {
      sandbox.plugin = payload;
    },
  };

  vm.runInNewContext(client, sandbox, { filename: "client.js" });

  const require = specifier => {
    if (specifier === "react") return React;
    throw new Error("unexpected client dependency: " + specifier);
  };

  const context = {
    locale: {
      register() { return () => {}; },
      bind() { return undefined; },
    },
    configForms: {
      get(id) {
        assert.equal(id, "dsh-chatgpt-web");
        return form;
      },
    },
    slots: {
      inject(_slot, register) {
        return register();
      },
      register(_definition, Component) {
        page = Component;
        return {};
      },
    },
    effect(effect) {
      effect();
    },
  };

  sandbox.plugin.factory(require).apply(context);

  cursor = 0;
  const firstTree = page({ view: "page" });
  const tokenInput = findNode(firstTree, node => node.type === "input");
  assert(tokenInput, "control-token input must render");
  assert.equal(tokenInput.props.value, "");

  tokenInput.props.onChange({ target: { value: "ephemeral-token" } });
  cursor = 0;
  page();
  await new Promise(resolve => setImmediate(resolve));

  assert(requests.includes("http://127.0.0.1:" + port + "/v1/control/status"));
  assert(requests.includes("http://127.0.0.1:" + port + "/v1/control/config"));
  assert(requests.includes("http://127.0.0.1:" + port + "/v1/control/recent-turns?limit=10"));
  assert(storage.removed.includes("dsh-chatgpt-web.controlToken"));

  form.value = { port: 19001, autoStart: true, readyTimeoutMs: 30000 };
  for (const listener of listeners) listener();
  cursor = 0;
  page();
  await new Promise(resolve => setImmediate(resolve));
  assert(requests.includes("http://127.0.0.1:19001/v1/control/status"));
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const result = findNode(child, predicate);
    if (result) return result;
  }
  return undefined;
}

await exerciseClient(17841);
console.log("issue #20 settings invariants passed");
