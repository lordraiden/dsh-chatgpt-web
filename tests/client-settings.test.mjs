import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function createHarness(port) {
  const state = [];
  const localStorageCalls = [];
  const fetchCalls = [];
  let stateCursor = 0;
  let page;
  let pendingEffects = [];

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = stateCursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => {
        state[index] = typeof value === "function" ? value(state[index]) : value;
      }];
    },
    useEffect(effect) {
      pendingEffects.push(effect());
    },
  };

  const sandbox = { console, Promise, Date, Number, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__DSH_CHATGPT_WEB_RUNTIME__ = { port };
  sandbox.localStorage = {
    getItem() { localStorageCalls.push("getItem"); return null; },
    setItem() { localStorageCalls.push("setItem"); },
    removeItem() { localStorageCalls.push("removeItem"); },
  };
  sandbox.fetch = async url => {
    fetchCalls.push(String(url));
    const text = String(url);
    const body = text.endsWith("/v1/control/config")
      ? { tuning: {}, defaults: {} }
      : text.includes("/v1/control/recent-turns")
        ? { turns: [] }
        : { version: "1.0.3", pid: 1, uptime: 1, accepting_turns: true,
            active_http_turns: 0, active_browser_turns: 0, storageStatePresent: true,
            storageDir: "/tmp", chromeExecutablePath: "/usr/bin/google-chrome",
            headed: false, solAvailable: true, proAvailable: false };
    return { ok: true, status: 200, json: async () => body };
  };

  sandbox.__ModuleLoader__ = { load(payload) { sandbox.__registeredPlugin = payload; } };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });

  const require = specifier => specifier === "react" ? React : (() => {
    throw new Error(`Unexpected client dependency: ${specifier}`);
  })();

  const context = {
    effect(effect) { effect(); },
    locale: { register() { return () => {}; }, bind() { return undefined; } },
    slots: {
      inject(_slot, register) { return register(); },
      register(_definition, Component) { page = Component; return {}; },
    },
  };
  sandbox.__registeredPlugin.factory(require).apply(context);

  return {
    render() {
      stateCursor = 0;
      pendingEffects = [];
      return { tree: page(), effects: pendingEffects };
    },
    fetchCalls,
    localStorageCalls,
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

test("uses the host-projected sidecar port and keeps the control token in page state", async () => {
  assert.doesNotMatch(clientSource, /127\.0\.0\.1:17841/);
  assert.doesNotMatch(clientSource, /localStorage\./);
  assert.match(clientSource, /__DSH_CHATGPT_WEB_RUNTIME__/);

  for (const port of [17841, 18421]) {
    const harness = createHarness(port);
    const first = harness.render();
    const input = findNode(first.tree, node => node.type === "input");
    assert.ok(input);
    assert.equal(input.props.value, "");

    input.props.onChange({ target: { value: "token-for-test" } });
    const second = harness.render();
    await Promise.all(second.effects);

    assert.deepEqual(harness.fetchCalls.sort(), [
      `http://127.0.0.1:${port}/v1/control/config`,
      `http://127.0.0.1:${port}/v1/control/recent-turns?limit=10`,
      `http://127.0.0.1:${port}/v1/control/status`,
    ].sort());
    assert.deepEqual(harness.localStorageCalls, []);

    const fresh = createHarness(port).render();
    const freshInput = findNode(fresh.tree, node => node.type === "input");
    assert.ok(freshInput);
    assert.equal(freshInput.props.value, "");
  }
});
