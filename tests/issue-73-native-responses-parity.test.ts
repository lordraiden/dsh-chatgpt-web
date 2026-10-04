import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { createChatGptWebRouteAuthority, requireChatGptWebRoute } from "../src/chatgpt-web-authority";
import { parseRequest } from "../src/responses/parser";
import { responseRequest, routeChatGptWebRequest } from "../src/server";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("issue #73 native DSH / Responses ProviderCore parity", () => {
  test("native and Responses ingress converge on one ProviderAdapter execution seam", () => {
    const server = read("src/server.ts");
    expect(server).toContain("const adapter = adapterFactory(provider);");
    expect(server).toContain("await adapter.runTurn!");
    expect(server).toContain("const sharedProviderCore = new ChatGptWebProviderCore();");
    expect(server).not.toContain("new ProviderTurnLifecycle(");
  });

  test("native and Responses use identical route eligibility and backend mapping", () => {
    const matrix = [
      { model: "chatgpt-web/light", sol: true, pro: false },
      { model: "chatgpt-web/high", sol: true, pro: false },
      { model: "chatgpt-web/extra-high", sol: true, pro: true },
      { model: "chatgpt-web/pro", sol: true, pro: true },
      { model: "chatgpt-web/luna", sol: false, pro: false, think: false },
      { model: "chatgpt-web/think", sol: false, pro: false, think: true },
    ] as const;

    for (const entry of matrix) {
      const config = {
        ...defaultConfig(),
        solAvailable: entry.sol,
        proAvailable: entry.pro,
        capabilityState: {
          solAvailable: (entry.sol ? "supported" : "unsupported") as "supported" | "unsupported",
          proAvailable: (entry.pro ? "supported" : "unsupported") as "supported" | "unsupported",
          thinkAvailable: (entry.think ? "supported" : "unsupported") as "supported" | "unsupported",
        },
      };
      const authority = createChatGptWebRouteAuthority(config);
      const expected = requireChatGptWebRoute(entry.model, authority);
      const parsed = parseRequest({ model: entry.model, input: "hello" });
      const resolved = routeChatGptWebRequest(parsed, config);
      expect(resolved.slug).toBe(expected.slug);
      expect(parsed.modelId).toBe(expected.backendModel);
    }

    const excluded = ["gpt-5.6-codex", "chatgpt-work/pro", "gpt-5.6-luna"];
    const config = { ...defaultConfig(), solAvailable: true, proAvailable: true };
    for (const model of excluded) {
      expect(() => parseRequest({ model, input: "hello" })).not.toThrow();
      const parsed = parseRequest({ model, input: "hello" });
      expect(() => routeChatGptWebRequest(parsed, config)).toThrow();
    }
  });

  test("native and Responses preserve the same canonical provider inputs at the ingress boundary", async () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: false,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };

    const seen: unknown[] = [];
    const response = await responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          instructions: "system",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
          ],
          stream: false,
        }),
      }),
      config,
      () => ({
        name: "test-chatgpt-web",
        runTurn: async parsed => {
          seen.push(parsed);
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const parsed = seen[0] as {
      modelId: string;
      context: {
        systemPrompt?: string[];
        messages: Array<{ role: string; content: unknown }>;
      };
      options: unknown;
    };
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed.context.systemPrompt).toEqual(["system"]);
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]?.role).toBe("user");
  });

  test("Responses continuation state is retained only for the external previous_response_id contract", () => {
    const state = read("src/responses/state.ts");
    expect(state).toContain("previous_response_id");
    expect(state).toContain("continuation cache");
    expect(state).toContain("cache, not a source of truth");
    expect(state).toContain("SNAPSHOT_TOTAL_MAX_BYTES");
    expect(state).not.toContain("ChatGPTWebProviderCore");
    expect(state).not.toContain("turn-execution");
    expect(state).not.toContain("retry-policy");
  });

  test("compatibility code has no second ProviderCore/replay/capability/retry authority", () => {
    const files = [
      "src/responses/parser.ts",
      "src/responses/compaction.ts",
      "src/responses/reasoning-envelope.ts",
      "src/responses/schema.ts",
      "src/responses/state.ts",
      "src/bridge.ts",
    ];
    const forbidden = [
      "new ChatGptWebProviderCore",
      "new ProviderTurnLifecycle",
      "new BrowserAccountLease",
      "new TurnBroker",
      "authorizeCapability(",
      "createChatGptReplayBoundary(",
      "classifyChatGptWebRetry(",
    ];
    for (const file of files) {
      const source = read(file);
      for (const token of forbidden) expect(source).not.toContain(token);
    }
  });

  test("native Codex remains outside ChatGPT Web ProviderCore", () => {
    const server = read("src/server.ts");
    const adapter = read("src/adapters/chatgpt-web/index.ts");
    expect(server).toContain('forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw)');
    expect(adapter).not.toContain("forwardNativeCodexRequest");
  });

  test("ProviderCore remains the only owner of retry budget, settlement, recovery and provenance", () => {
    const core = read("src/adapters/chatgpt-web/provider-core.ts");
    expect(core).toContain("retryBudgets");
    expect(core).toContain("recordRetryAttempt");
    expect(core).toContain("physicalSettlement");
    expect(core).toContain("ProviderRecovery");
    expect(core).toContain("ProviderTurnProvenance");

    const retryPolicy = read("src/adapters/chatgpt-web/retry-policy.ts");
    expect(retryPolicy).not.toContain("retryAttempts");
    expect(retryPolicy).not.toContain("recordRetryAttempt");
    expect(retryPolicy).not.toContain("authorizeSurfaceReplay");

    const environment = read("src/adapters/chatgpt-web/thread-environment.ts");
    expect(environment).toContain("continuity/cache state only");
    expect(environment).toContain("current trusted DSH/Codex environment evidence is required");
  });

  test("compatibility ingress does not become a parallel browser execution path", () => {
    const server = read("src/server.ts");
    expect(server).toContain("responseRequest(");
    expect(server).toContain("adapterFactory(provider)");
    expect(server).toContain("adapter.runTurn!");
    expect(server).not.toContain("chatGptWebSurfaceTransportForProvider(provider).run(");
  });
});
