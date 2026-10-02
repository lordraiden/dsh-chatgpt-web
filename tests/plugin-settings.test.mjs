import { strict as assert } from "node:assert";
import { test } from "node:test";
import { apply } from "../src/plugin.ts";

function captureInjection(config) {
  let listener;
  const ctx = {
    on(event, next) {
      assert.equal(event, "webserver/index-inject");
      listener = next;
    },
    effect() {},
    logger() {
      return {
        info() {},
        warn() {},
        error() {},
        debug() {},
      };
    },
  };

  apply(ctx, config);
  assert.equal(typeof listener, "function");
  const table = [];
  listener(table);
  return table;
}

test("projects the configured sidecar port through the DSH Web index injection", () => {
  assert.deepEqual(
    captureInjection({ host: "127.0.0.1", port: 17841, autoStart: false }),
    [{
      kind: "global",
      name: "__DSH_CHATGPT_WEB_RUNTIME__",
      value: { port: 17841 },
    }],
  );

  assert.deepEqual(
    captureInjection({ host: "127.0.0.1", port: 18421, autoStart: false }),
    [{
      kind: "global",
      name: "__DSH_CHATGPT_WEB_RUNTIME__",
      value: { port: 18421 },
    }],
  );
});
