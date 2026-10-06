import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { createChatGptWebRouteAuthority, requireChatGptWebRoute } from "../src/chatgpt-web-authority";
import { parseRequest } from "../src/responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "../src/responses/state";
import { responseRequest, routeChatGptWebRequest } from "../src/server";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("issue #72 Responses -> single Web ProviderCore", () => {

  test("keeps the provider turn mutable for logical settlement when physical cleanup wins the race", async () => {
    const core = new ChatGptWebProviderCore();
    const physical = Promise.resolve();
    const turn = core.begin({
      executionKey: "race-execution",
      traceId: "race-trace",
      nativeTurnId: "turn-race",
      nativeThreadId: "thread-race",
      accountIdentity: "account-race",
      browserProfile: "profile-race",
      browserContext: "context-race",
      pageIdentity: "page-race",
      capabilitySnapshot: projectChatGptCapabilities({
        sessionId: "session-race",
        agentId: "agent-race",
        turnId: "turn-race",
        tools: [],
      }),
    });
    core.bindPhysicalSettlement("race-execution", physical);
    await physical;

    expect(turn.snapshot().state).toBe("SETTLING");
    expect(() => turn.markLogicalSettled("completed")).not.toThrow();
    expect(turn.snapshot().state).toBe("RETIRED");
    expect(turn.snapshot().logicalOutcome).toBe("completed");
  });

  test("ProviderCore accepts failed logical settlement after physical cleanup wins the race", async () => {
    const core = new ChatGptWebProviderCore();
    const turn = core.begin({
      executionKey: "race-failure-execution",
      traceId: "race-failure-trace",
      nativeTurnId: "turn-race-failure",
      nativeThreadId: "thread-race-failure",
      accountIdentity: "account-race-failure",
      browserProfile: "profile-race-failure",
      browserContext: "context-race-failure",
      pageIdentity: "page-race-failure",
      capabilitySnapshot: projectChatGptCapabilities({
        sessionId: "session-race-failure",
        agentId: "agent-race-failure",
        turnId: "turn-race-failure",
        tools: [],
      }),
    });
    core.bindPhysicalSettlement("race-failure-execution", Promise.resolve());
    await turn.waitForPhysicalSettlement();

    expect(turn.snapshot().state).toBe("SETTLING");
    expect(() => turn.markLogicalSettled("failed")).not.toThrow();
    expect(turn.snapshot().recovery).toBe("FAILED");
    expect(turn.snapshot().logicalOutcome).toBe("failed");
    expect(turn.snapshot().state).toBe("RETIRED");
  });

  test("Responses ingress delegates Web execution to the same ProviderAdapter entrypoint used by native DSH", () => {
    const server = read("src/server.ts");
    expect(server).toContain("route = routeChatGptWebRequest(parsed, config)");
    expect(server).toContain("const adapter = adapterFactory(provider)");
    expect(server).toContain("await adapter.runTurn!");
    expect(server).toContain("const sharedProviderCore = new ChatGptWebProviderCore();");
    expect(server).not.toContain("new ProviderTurnLifecycle(");
  });

  test("native DSH and Responses use the same Web route authority", () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: true,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "supported" as const },
    };
    const authority = createChatGptWebRouteAuthority(config);
    for (const model of ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro"]) {
      const expected = requireChatGptWebRoute(model, authority).slug;
      const parsed = parseRequest({ model, input: "hello" });
      expect(routeChatGptWebRequest(parsed, config).slug).toBe(expected);
    }

    const lunaConfig = {
      ...defaultConfig(),
      solAvailable: false,
      proAvailable: false,
      capabilityState: { solAvailable: "unsupported" as const, proAvailable: "unsupported" as const },
    };
    const lunaAuthority = createChatGptWebRouteAuthority(lunaConfig);
    for (const model of ["chatgpt-web/luna", "chatgpt-web/think"]) {
      const expected = requireChatGptWebRoute(model, lunaAuthority).slug;
      const parsed = parseRequest({ model, input: "hello" });
      expect(routeChatGptWebRequest(parsed, lunaConfig).slug).toBe(expected);
    }
  });

  test("Responses actually uses the injected Web ProviderAdapter seam", async () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: false,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };
    let calls = 0;
    const response = await responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          input: "hello",
          stream: false,
        }),
      }),
      config,
      () => ({
        name: "test-chatgpt-web",
        runTurn: async (_parsed, _incoming, emit) => {
          calls += 1;
          emit({ type: "text_delta", text: "provider-core answer", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    const body = await response.json() as { status?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    expect(body.status).toBe("completed");
    expect(body.output?.some(item => item.content?.some(part => part.text === "provider-core answer"))).toBe(true);
  });

  test("Responses compatibility modules do not own ProviderCore execution authority", () => {
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
      "thread-environment",
      "web-surface-transport",
      "replay",
    ];
    for (const file of responseFiles) {
      const source = read(file);
      for (const moduleName of forbiddenImports) {
        expect(source).not.toMatch(new RegExp(`from ["'].*${moduleName}`));
      }
    }
  });

  test("backend Web model ids cannot be used as a Web Responses route", () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };
    for (const model of ["gpt-5.6-sol", "gpt-5.6-luna", "chatgpt-web-zero-risk", "chatgpt-web-zero-risk-pro"]) {
      const parsed = parseRequest({ model, input: "hello" });
      expect(() => routeChatGptWebRequest(parsed, config)).toThrow();
    }
  });

  test("Codex passthrough remains explicitly separate from Web execution", () => {
    const server = read("src/server.ts");
    expect(server).toContain('forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw)');
    const adapterSource = read("src/adapters/chatgpt-web/index.ts");
    expect(adapterSource).not.toContain("forwardNativeCodexRequest");
  });

  test("Responses continuation state is cache-only compatibility state", () => {
    const previous = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }], store: false };
    const response = {
      id: "resp_issue_72",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }],
    };
    rememberResponseState(previous, response, { force: true });
    const expanded = expandPreviousResponseInput({
      model: "chatgpt-web/luna",
      previous_response_id: "resp_issue_72",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }],
    }) as Record<string, unknown>;
    expect(Array.isArray(expanded.input)).toBe(true);
    expect(expanded).not.toHaveProperty("_dshContext");
    expect(expanded).not.toHaveProperty("capabilities");
    expect(expanded).not.toHaveProperty("sandbox");
  });
});
