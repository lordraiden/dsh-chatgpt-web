import assert from "node:assert/strict";
import { LlmError, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { ChatGptWebLlmAdapter, toCodexParsedRequest } from "../src/adapters/chatgpt-web/llm-adapter";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { capabilitySnapshotForEnvironment, type CapabilitySnapshot } from "../src/adapters/chatgpt-web/capability-projector";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { resolveChatGptCapabilitySnapshotForTurn } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexProviderConfig } from "../src/types";

function providerConfig(): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    defaultModel: "gpt-5.6-luna",
    models: ["gpt-5.6-luna"],
    liveModels: false,
    contextWindow: 1_050_000,
    modelInputModalities: { "gpt-5.6-luna": ["text", "image"] },
    modelReasoningEfforts: { "gpt-5.6-luna": ["low", "medium"] },
    modelDefaultReasoningEfforts: { "gpt-5.6-luna": "low" },
    noReasoningModels: [],
    chatgptWeb: {
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      storageStatePath: "/tmp/chatgpt-state.json",
      chromeExecutablePath: "/usr/bin/chromium",
      brokerSocketPath: "/tmp/chatgpt-broker-10c-test.sock",
      localToolsEnabled: true,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
    },
  };
}

function request(sessionId: string, toolArguments: string): GenerateOptions {
  return {
    provider: "chatgpt-web",
    model: "chatgpt-web/luna",
    sessionId: sessionId as GenerateOptions["sessionId"],
    messages: [
      {
        role: "assistant",
        id: "assistant-1",
        source: { kind: "model", provider: "chatgpt-web", model: "chatgpt-web/luna" },
        content: [{ type: "tool-call", id: "call-10c", name: "read", arguments: toolArguments }],
      } as unknown as GenerateOptions["messages"][number],
      {
        role: "user",
        id: "user-1",
        source: { kind: "user" },
        content: [{ type: "text", text: "continue" }],
      } as unknown as GenerateOptions["messages"][number],
    ],
  };
}

function leaseInput(turnId: string, snapshot: CapabilitySnapshot) {
  return {
    executionKey: "execution-10c",
    traceId: "trace-10c",
    nativeTurnId: turnId,
    nativeThreadId: "provider-thread-1",
    accountIdentity: "account-10c",
    browserProfile: "managed-chrome",
    browserContext: "context-10c",
    pageIdentity: "page-10c",
    capabilitySnapshot: snapshot,
  };
}

const provider = providerConfig();
const parsed = toCodexParsedRequest(request("dsh-session-parent", '{"path":"README.md"}'), provider);
const identity = extractChatGptTurnIdentity(parsed);
assert.equal(identity.dshSessionId, "dsh-session-parent");
assert.equal(identity.threadId, "dsh-session-parent");

{
  const core = new ChatGptWebProviderCore();
  const executionKey = "execution-10c";
  const firstSnapshot = resolveChatGptCapabilitySnapshotForTurn(
    core,
    executionKey,
    parsed,
    { ...identity, threadId: "provider-thread-A", agentName: "/root/provider-name" },
  );
  assert.equal(firstSnapshot.sessionId, "dsh-session-parent");
  assert.equal(firstSnapshot.agentId, "dsh-session-parent");
  assert.notEqual(firstSnapshot.agentId, "provider-thread-A");
  assert.notEqual(firstSnapshot.agentId, "/root/provider-name");

  const turn = core.begin({ ...leaseInput(identity.turnId!, firstSnapshot) });

  const sameSnapshot = resolveChatGptCapabilitySnapshotForTurn(
    core,
    executionKey,
    parsed,
    { ...identity, threadId: "provider-thread-B", agentName: "/root/another-provider-name" },
  );
  assert.equal(sameSnapshot, firstSnapshot);

  const broker = TurnBroker.forSocket("/tmp/dsh-chatgpt-10c-test.sock");
  try {
    const environment = capabilitySnapshotForEnvironment({
      cwd: "/workspace",
      roots: ["/workspace"],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly" as const, networkAccess: true },
      tools: [],
    }, firstSnapshot);
    const token = await broker.register(environment, 5_000, "trace-10c");
    await broker.updateEnvironment(token, environment);
    assert.equal(turn.snapshot().capabilitySnapshot, firstSnapshot);
    await broker.revoke(token);
  } finally {
    await broker.close();
  }

  const changedSnapshot = projectChatGptCapabilities({
    sessionId: firstSnapshot.sessionId,
    agentId: firstSnapshot.agentId,
    turnId: firstSnapshot.turnId,
    tools: [],
  });
  assert.notEqual(changedSnapshot.snapshotId, firstSnapshot.snapshotId);
  assert.throws(
    () => core.begin({
      ...leaseInput(identity.turnId!, changedSnapshot),
      executionKey,
    }),
    /already bound to a different capability snapshot/i,
  );

  const changedToolsParsed = {
    ...parsed,
    context: {
      ...parsed.context,
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    },
  };
  assert.throws(
    () => resolveChatGptCapabilitySnapshotForTurn(core, executionKey, changedToolsParsed, identity),
    /does not match the trusted Codex environment tool projection/i,
  );

  assert.throws(
    () => resolveChatGptCapabilitySnapshotForTurn(
      core,
      executionKey,
      parsed,
      { ...identity, dshSessionId: "dsh-session-child" },
    ),
    /DSH identity changed during an active provider turn/i,
  );
  turn.failBeforePhysicalSettlement();
}

{
  const childParsed = toCodexParsedRequest(request("dsh-session-child", '{"path":"README.md"}'), provider);
  const childIdentity = extractChatGptTurnIdentity(childParsed);
  const core = new ChatGptWebProviderCore();
  const parentSnapshot = resolveChatGptCapabilitySnapshotForTurn(core, "execution-parent", parsed, identity);
  const childSnapshot = resolveChatGptCapabilitySnapshotForTurn(core, "execution-child", childParsed, childIdentity);
  assert.equal(childIdentity.dshSessionId, "dsh-session-child");
  assert.notEqual(childIdentity.dshSessionId, identity.dshSessionId);
  assert.notEqual(childSnapshot.snapshotId, parentSnapshot.snapshotId);
  assert.notEqual(childSnapshot.agentId, parentSnapshot.agentId);

  const parentTurn = core.begin({
    ...leaseInput(identity.turnId!, parentSnapshot),
    executionKey: "execution-parent",
  });
  assert.equal(parentTurn.snapshot().capabilitySnapshot, parentSnapshot);
  parentTurn.failBeforePhysicalSettlement();
  const childTurn = core.begin({
    ...leaseInput(childIdentity.turnId!, childSnapshot),
    executionKey: "execution-child",
  });
  assert.equal(childTurn.snapshot().capabilitySnapshot, childSnapshot);
  assert.notEqual(childTurn.snapshot().capabilitySnapshot, parentTurn.snapshot().capabilitySnapshot);
  childTurn.failBeforePhysicalSettlement();
}

for (const [label, toolArguments] of [
  ["primitive", "42"],
  ["array", '["README.md"]'],
  ["malformed", '{"path":'],
] as const) {
  assert.throws(
    () => toCodexParsedRequest(request("dsh-session-errors", toolArguments), provider),
    (error: unknown) => error instanceof LlmError
      && error.code === "PROTOCOL_ERROR"
      && error.message.includes("ChatGPT Web received"),
    label,
  );
}

{
  const valid = toCodexParsedRequest(request("dsh-session-valid", '{"path":"README.md","depth":2}'), provider);
  const assistant = valid.context.messages.find(message => message.role === "assistant");
  assert(assistant?.role === "assistant");
  const toolCall = assistant.content.find(part => part.type === "toolCall");
  assert(toolCall?.type === "toolCall");
  assert.deepEqual(toolCall.arguments, { path: "README.md", depth: 2 });
}

{
  let backendCalled = false;
  const adapter = new ChatGptWebLlmAdapter({
    loadProvider: () => provider,
    createBackend: () => ({ name: "chatgpt-web", async runTurn() { backendCalled = true; } }),
  });
  const chunks: unknown[] = [];
  for await (const chunk of adapter.stream(request("dsh-session-no-exec", '{"path":'))) chunks.push(chunk);
  assert.equal(backendCalled, false);
  const finish = chunks.find(chunk => (chunk as { type?: string }).type === "finish") as {
    reason?: { kind?: string; failure?: { code?: string } };
  } | undefined;
  assert.equal(finish?.reason?.kind, "error");
  assert.equal(finish?.reason?.failure?.code, "PROTOCOL_ERROR");
}

console.log("Issue #10-C capability snapshot and DSH identity tests passed.");
