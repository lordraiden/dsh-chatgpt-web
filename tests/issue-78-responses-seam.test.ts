import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createChatGptWebRouteAuthority,
  requireChatGptWebRoute,
} from "../src/chatgpt-web-authority";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import {
  expandPreviousResponseInput,
  rememberResponseState,
} from "../src/responses/state";
import { routeChatGptWebRequest } from "../src/codex-integration-route";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("issue #78 Responses compatibility seam audit", () => {
  test("Responses modules stay outside browser/retry/capability execution authorities", () => {
    const responseFiles = [
      "src/responses/compaction.ts",
      "src/responses/parser.ts",
      "src/responses/reasoning-envelope.ts",
      "src/responses/schema.ts",
      "src/responses/state.ts",
      "src/bridge.ts",
    ];

    const forbiddenImports = [
      "provider-core",
      "browser-worker",
      "turn-execution",
      "turn-broker",
      "retry-policy",
      "capability-projector",
      "capability-transport",
      "thread-environment",
      "web-surface-transport",
    ];

    for (const file of responseFiles) {
      const source = read(file);
      for (const moduleName of forbiddenImports) {
        expect(source).not.toMatch(new RegExp(`from ["'].*${moduleName}`));
      }
    }
  });

  test("/v1/responses is an ingress over the shared ChatGPT Web adapter", () => {
    const server = read("src/server.ts");
    expect(server).toContain('url.pathname === "/v1/responses"');
    expect(server).toContain("responseRequest(");
    expect(server).toContain("adapterFactory(provider)");
    expect(server).toContain("routeChatGptWebRequest(parsed, config)");
    expect(server).toContain('forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw)');

    expect(server).not.toContain("browser-worker");
    expect(server).not.toContain("retry-policy");
    expect(server).not.toContain("new ProviderTurnLifecycle");
  });

  test("Responses and native DSH resolve the same route authority", () => {
    const config = defaultConfig();
    const authority = createChatGptWebRouteAuthority(config);
    for (const model of [
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
      "chatgpt-web/luna",
      "chatgpt-web/pro",
    ]) {
      const expected = (() => {
        try { return requireChatGptWebRoute(model, authority).slug; }
        catch { return "rejected"; }
      })();

      let native = "rejected";
      try {
        const parsed = parseRequest({ model, input: "hello" });
        native = routeChatGptWebRequest(parsed, config).modelId;
        native = (() => {
          try { return requireChatGptWebRoute(native, authority).slug; }
          catch { return "rejected"; }
        })();
      } catch {
        native = "rejected";
      }
      expect(native).toBe(expected);
    }
  });

  test("previous_response_id state is compatibility cache only", () => {
    const request = {
      model: "chatgpt-web/luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }],
      store: false,
    };
    rememberResponseState(
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }], store: false },
      { id: "resp_issue_78", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] },
      { force: true },
    );
    const expanded = expandPreviousResponseInput({ ...request, previous_response_id: "resp_issue_78" }) as Record<string, unknown>;
    expect(Array.isArray(expanded.input)).toBe(true);
    expect(expanded).not.toHaveProperty("_dshContext");
    expect(expanded).not.toHaveProperty("provider");
    expect(expanded).not.toHaveProperty("capabilities");
    expect(expanded).not.toHaveProperty("sandbox");
  });
});
