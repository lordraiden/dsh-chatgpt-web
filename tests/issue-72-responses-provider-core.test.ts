import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { createChatGptWebRouteAuthority, requireChatGptWebRoute } from "../src/chatgpt-web-authority";
import { parseRequest } from "../src/responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "../src/responses/state";
import { responseRequest, routeChatGptWebRequest } from "../src/server";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";

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
    // The real flow reports the submission before a physical settlement can race; the core records
    // that fact now, so the race is exercised on a turn that reached the submit boundary.
    turn.markSubmitted();
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
    // Same as above: the submission is reported before the physical settlement can win the race.
    turn.markSubmitted();
    core.bindPhysicalSettlement("race-failure-execution", Promise.resolve());
    await turn.waitForPhysicalSettlement();

    expect(turn.snapshot().state).toBe("SETTLING");
    expect(() => turn.markLogicalSettled("failed")).not.toThrow();
    expect(turn.snapshot().recovery).toBe("FAILED");
    expect(turn.snapshot().logicalOutcome).toBe("failed");
    expect(turn.snapshot().state).toBe("RETIRED");
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

  test("native and Responses preserve the same canonical provider inputs at the ingress boundary", async () => {
    // Moved from the deleted issue-73 source-text suite: instead of reading `src/server.ts`, the
    // ingress is driven for real and the request it hands to the provider seam is asserted.
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
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          instructions: "system",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
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
      context: { systemPrompt?: string[]; messages: Array<{ role: string; content: unknown }> };
    };
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed.context.systemPrompt).toEqual(["system"]);
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]?.role).toBe("user");
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
