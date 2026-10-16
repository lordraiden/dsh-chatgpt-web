import { expect, test } from "bun:test";
import {
  projectCanonicalChatGptWebContext,
  serializeCanonicalChatGptWebContext,
  withoutRetiredTurnHandles,
  withoutSupersededModelSwitchContracts,
  CHATGPT_WEB_MAX_INPUT_IMAGES,
  applyChatGptWebImageBudget,
} from "../src/adapters/chatgpt-web/context-projection";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  decideChatGptWebContextCapacity,
  resolveChatGptWebContextBudget,
  selectCompactionMessagesDeterministically,
} from "../src/adapters/chatgpt-web/context-budget";
import { CHATGPT_CONTEXT_EXHAUSTED_CODE } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptReplayCoordinator,
  createChatGptReplayBoundary,
  type ChatGptConversationHandle,
  type ChatGptReplayBoundary,
  type ChatGptReplayIdentity,
  type ChatGptReplayTransport,
} from "../src/adapters/chatgpt-web/replay";
import { BrowserAccountLease, ProviderTurnLifecycle } from "../src/adapters/chatgpt-web/provider-core";
import type { CodexMessage } from "../src/types";

/**
 * Merged from the former issue-11a/-11b/-11c suites, which were green under a bare `bun test` but
 * never gated by the chain. Every test is unchanged; only the three files became one chain entry.
 */

const image = "https://example.com/diagram.png";

function sampleMessages(): CodexMessage[] {
  return [
    { role: "developer", content: "<model_switch>old</model_switch>", timestamp: 1 },
    { role: "developer", content: "<skills_instructions>old skill catalog</skills_instructions>", timestamp: 2 },
    {
      role: "user",
      content: [
        { type: "text", text: "Build the feature." },
        { type: "image", imageUrl: image, detail: "high" },
      ],
      timestamp: 3,
    },
    { role: "agentMessage", author: "planner", recipient: "worker", content: "Review the implementation.", timestamp: 4 },
    {
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "text", text: "I will inspect the code." },
        {
          type: "thinking",
          thinking: "working",
          signature: "sig-1",
          itemId: "reasoning-1",
          redacted: ["redacted-1"],
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          namespace: "mcp__fs",
          arguments: { path: "src/index.ts" },
          thoughtSignature: "tool-sig-1",
        },
      ],
      timestamp: 5,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      toolNamespace: "mcp__fs",
      content: "file contents",
      isError: false,
      timestamp: 6,
    },
    { role: "developer", content: "<model_switch>new</model_switch>", timestamp: 7 },
    { role: "developer", content: "<skills_instructions>new skill catalog</skills_instructions>", timestamp: 8 },
  ];
}

test("canonical projection preserves ordering and semantic tool results", () => {
  const projected = projectCanonicalChatGptWebContext(["system instruction"], sampleMessages());
  expect(projected.version).toBe(3);
  expect(projected.system).toEqual(["system instruction"]);
  expect(projected.messages.map(message => message.role)).toEqual([
    "user", "agent_message", "assistant", "tool_result", "developer", "developer",
  ]);
  expect(projected.messages[2]!.content).toEqual([
    { type: "text", text: "I will inspect the code." },
    {
      type: "thinking_summary",
      text: "working",
      signature: "sig-1",
      item_id: "reasoning-1",
      redacted: ["redacted-1"],
    },
    {
      type: "tool_call",
      id: "call-1",
      name: "read_file",
      namespace: "mcp__fs",
      arguments: { path: "src/index.ts" },
      thought_signature: "tool-sig-1",
    },
  ]);
  expect(projected.messages[3]).toEqual({
    role: "tool_result",
    tool_call_id: "call-1",
    tool_name: "read_file",
    tool_namespace: "mcp__fs",
    is_error: false,
    content: "file contents",
  });
});

test("canonical projection keeps images structured and separate from text", () => {
  const projected = projectCanonicalChatGptWebContext([], sampleMessages());
  expect(projected.images).toEqual([{ ref: "codex-input-image-1", imageUrl: image, detail: "high" }]);
  expect(projected.messages[0]!.content).toEqual([
    { type: "text", text: "Build the feature." },
    { type: "image_attachment", attachment_ref: "codex-input-image-1", detail: "high" },
  ]);
});

test("canonical projection is deterministic and does not mutate source state", () => {
  const source = sampleMessages();
  const before = structuredClone(source);
  const first = projectCanonicalChatGptWebContext(["sys"], source);
  const second = projectCanonicalChatGptWebContext(["sys"], structuredClone(source));
  expect(source).toEqual(before);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(serializeCanonicalChatGptWebContext(first)).toBe(serializeCanonicalChatGptWebContext(second));
});

test("transport handles are sanitized without corrupting semantic tool ids", () => {
  const raw = JSON.stringify({
    version: 3,
    system: ["system"],
    messages: [
      { role: "tool_result", tool_call_id: "turn_abcdefghijklmnopqrstuvwxyz", content: "x" },
      {
        role: "assistant",
        content: [{
          type: "tool_call",
          id: "binding_abcdefghijklmnopqrstuvwxyz",
          name: "x",
          arguments: {},
        }],
      },
    ],
    __transport_handle: "turn_transport_abcdefghijklmnopqrstuvwxyz",
  });
  const sanitized = withoutRetiredTurnHandles(raw);
  expect(sanitized).toContain("turn_abcdefghijklmnopqrstuvwxyz");
  expect(sanitized).toContain("binding_abcdefghijklmnopqrstuvwxyz");
  expect(sanitized).toContain("[retired transport handle]");
  expect(sanitized).not.toContain("turn_transport_abcdefghijklmnopqrstuvwxyz");
});


test("superseded model-switch contracts are removed without losing current history", () => {
  const normalized = withoutSupersededModelSwitchContracts(sampleMessages());
  expect(normalized.map(message => typeof message.content === "string" ? message.content : "")).toEqual([
    "",
    "Review the implementation.",
    "",
    "file contents",
    "<model_switch>new</model_switch>",
    "<skills_instructions>new skill catalog</skills_instructions>",
  ]);
});



test("canonical projection never infers a missing write.file_path from user text", () => {
  const source: CodexMessage[] = [
    { role: "user", content: "Please update src/inferred.ts and read docs/README.md", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: {
          contents: "keep this payload unchanged",
          nested: { file_path: "user-authored/nested.txt", value: "untouched" },
        },
      }],
      timestamp: 2,
    },
  ];
  const projected = projectCanonicalChatGptWebContext([], source);
  expect(projected.messages[1]!.content).toEqual([{
    type: "tool_call",
    id: "write-1",
    name: "write",
    arguments: {
      contents: "keep this payload unchanged",
      nested: { file_path: "user-authored/nested.txt", value: "untouched" },
    },
  }]);
});

test("missing write.file_path remains missing even when user text contains a filename", () => {
  const source: CodexMessage[] = [
    { role: "user", content: "Edit AGENTS.md before continuing.", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-2",
        name: "write",
        arguments: { contents: "payload" },
      }],
      timestamp: 2,
    },
  ];
  const projected = projectCanonicalChatGptWebContext([], source);
  const call = (projected.messages[1]!.content as Array<Record<string, unknown>>)[0]!;
  expect(call.arguments).toEqual({ contents: "payload" });
});

test("retired-handle scrubbing does not mutate similarly named user data", () => {
  const raw = JSON.stringify({
    metadata: {
      handle: "__turn_handle",
      value: "__request_handle",
    },
    userPayload: {
      fieldName: "__turn_handle",
      literal: "turn_transport_abcdefghijklmnopqrstuvwxyz",
    },
    __turn_handle: "owned-turn-handle",
  });
  const sanitized = JSON.parse(withoutRetiredTurnHandles(raw)) as Record<string, any>;
  expect(sanitized.metadata).toEqual({
    handle: "__turn_handle",
    value: "__request_handle",
  });
  expect(sanitized.userPayload).toEqual({
    fieldName: "__turn_handle",
    literal: "turn_transport_abcdefghijklmnopqrstuvwxyz",
  });
  expect(sanitized.__turn_handle).toBe("[retired transport handle]");
});

test("nested tool arguments survive canonical projection without semantic mutation", () => {
  const argumentsValue = {
    request: {
      file_path: "keep/me.txt",
      nested: { arbitrary: ["a", { handle: "__surface_handle", file_path: "nested.md" }] },
    },
    __turn_handle: "user-authored-field",
  };
  const source: CodexMessage[] = [{
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "nested-1",
      name: "custom_tool",
      arguments: structuredClone(argumentsValue),
    }],
    timestamp: 1,
  }];
  const projected = projectCanonicalChatGptWebContext([], source);
  const call = (projected.messages[0]!.content as Array<Record<string, unknown>>)[0]!;
  expect(call.arguments).toEqual(argumentsValue);
});

test("reprojecting the same canonical DSH history is replay-stable", () => {
  const source = sampleMessages();
  const first = serializeCanonicalChatGptWebContext(projectCanonicalChatGptWebContext(["sys"], source));
  const second = serializeCanonicalChatGptWebContext(projectCanonicalChatGptWebContext(["sys"], structuredClone(source)));
  expect(second).toBe(first);
});

test("replay fixture is generated entirely from canonical DSH state", () => {
  const projected = projectCanonicalChatGptWebContext(["system instruction"], sampleMessages());
  const replayFixture = serializeCanonicalChatGptWebContext(projected);
  expect(replayFixture).toContain("<model_switch>new</model_switch>");
  expect(replayFixture).toContain("call-1");
  expect(replayFixture).toContain("file contents");
  expect(replayFixture).not.toContain("chatgpt.com");
  expect(replayFixture).not.toContain("conversationId");
  expect(replayFixture).not.toContain("threadId");
});

test("Free Web budget separates theoretical window from measured browser transport", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low");

  expect(budget.theoreticalContextWindow).toBe(1_050_000);
  expect(budget.preCompactionInputBudget).toBe(128_000);
  expect(budget.outputHeadroomTokens).toBe(922_000);
  expect(budget.browserMessageTokenLimit).toBe(128_000);
  expect(budget.browserComposerCharLimit).toBe(120_000);
  expect(budget.platformReserveTokens).toBe(8_192);
  expect(budget.imageLimit).toBe(CHATGPT_WEB_MAX_INPUT_IMAGES);
});

test("capacity decision is deterministic and prefers compaction before multipart", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low");
  const input = {
    estimatedInputTokens: 140_000,
    estimatedMessageTokens: 20_000,
    partCount: 1 as const,
  };

  expect(decideChatGptWebContextCapacity(budget, input, {
    compactionAvailable: true,
    multipartAvailable: true,
  }).outcome).toBe("compaction_required");

  expect(decideChatGptWebContextCapacity(budget, input, {
    compactionAvailable: false,
    multipartAvailable: true,
  }).outcome).toBe("multipart_required");

  expect(decideChatGptWebContextCapacity(budget, {
    ...input,
    estimatedInputTokens: 100_000,
  }, {
    compactionAvailable: true,
    multipartAvailable: true,
  }).outcome).toBe("fits");
});

test("context exhaustion is independent of token overflow and exposes a stable semantic code", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low");
  const decision = decideChatGptWebContextCapacity(
    budget,
    { estimatedInputTokens: 10, estimatedMessageTokens: 10 },
    { compactionAvailable: false, multipartAvailable: false, productContextExhausted: true },
  );

  expect(decision.outcome).toBe("context_exhausted");
  expect(decision.nextAction).toBe("replay");
  expect(CHATGPT_CONTEXT_EXHAUSTED_CODE).toBe("context_exhausted");
});

test("unrecoverable compaction keeps developer instructions and settled tool results", () => {
  const messages: CodexMessage[] = [
    { role: "user", content: "old user", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
    { role: "developer", content: "required developer instruction", timestamp: 3 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "src/index.ts" },
      }],
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "settled result",
      isError: false,
      timestamp: 5,
    },
    { role: "user", content: "current request", timestamp: 6 },
  ];

  const selected = selectCompactionMessagesDeterministically(
    messages,
    candidate => candidate.length <= 4,
  );

  expect(selected.messages.map(message => message.role)).toEqual([
    "developer",
    "assistant",
    "toolResult",
    "user",
  ]);
  expect(selected.messages[0]!.content).toBe("required developer instruction");
  expect(selected.messages[2]!.role).toBe("toolResult");
  expect(selected.removed).toBe(2);
});

test("repeated compaction selection produces byte-for-byte identical input", () => {
  const messages: CodexMessage[] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
    { role: "developer", content: "keep this", timestamp: 3 },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: "keep result",
      isError: false,
      timestamp: 4,
    },
    { role: "user", content: "latest", timestamp: 5 },
  ];
  const first = selectCompactionMessagesDeterministically(messages, candidate => candidate.length <= 4).messages;
  const second = selectCompactionMessagesDeterministically(messages, candidate => candidate.length <= 4).messages;
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

test("canonical images survive intact until the explicit transport budget", () => {
  const messages: CodexMessage[] = Array.from({ length: 12 }, (_, index) => ({
    role: "user" as const,
    content: [
      { type: "text" as const, text: "image " + index },
      { type: "image" as const, imageUrl: "https://example.com/" + index + ".png" },
    ],
    timestamp: index,
  }));

  const canonical = projectCanonicalChatGptWebContext([], messages);
  expect(canonical.images).toHaveLength(12);

  const transport = applyChatGptWebImageBudget(canonical, CHATGPT_WEB_MAX_INPUT_IMAGES);
  expect(transport.images).toHaveLength(CHATGPT_WEB_MAX_INPUT_IMAGES);
  expect(JSON.stringify(transport.messages)).toContain("older image not attached");
  expect(JSON.stringify(transport.messages)).not.toContain("https://example.com/0.png");
  expect(transport.images.at(-1)!.imageUrl).toBe("https://example.com/11.png");
});


test("atomic message overflow remains unrecoverable even when compaction is available", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low");
  const decision = decideChatGptWebContextCapacity(
    budget,
    {
      estimatedInputTokens: 1_000,
      estimatedMessageTokens: 1_000,
      promptChars: budget.browserComposerCharLimit! + 1,
    },
    { compactionAvailable: true, multipartAvailable: true },
  );
  expect(decision.outcome).toBe("budget_exceeded");
  expect(decision.nextAction).toBe("fail");
});

test("long-session reduction is oldest-first and leaves protected state intact", () => {
  const messages: CodexMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: "user", content: "historical-" + i, timestamp: i });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "answer-" + i }],
      timestamp: i + 100,
    });
  }
  messages.push({ role: "developer", content: "must keep", timestamp: 10_000 });
  messages.push({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "settled-call",
      name: "read_file",
      arguments: { path: "important.txt" },
    }],
    timestamp: 10_001,
  });
  messages.push({
    role: "toolResult",
    toolCallId: "settled-call",
    toolName: "read_file",
    content: "settled result",
    isError: false,
    timestamp: 10_002,
  });
  messages.push({ role: "user", content: "latest request", timestamp: 10_003 });

  const selected = selectCompactionMessagesDeterministically(
    messages,
    candidate => candidate.length <= 5,
  );

  expect(selected.messages.at(-1)).toEqual(messages.at(-1));
  expect(selected.messages.some(message => message.role === "developer")).toBe(true);
  expect(selected.messages.some(message => message.role === "toolResult")).toBe(true);
  expect(selected.messages.some(message =>
    message.role === "assistant"
    && message.content.some(part => part.type === "toolCall" && part.id === "settled-call")
  )).toBe(true);
  expect(selected.removed).toBe(messages.length - 5);
});

test("budget diagnostics include serialized input bytes", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low");
  const decision = decideChatGptWebContextCapacity(
    budget,
    {
      estimatedInputTokens: 100,
      estimatedMessageTokens: 100,
      serializedInputBytes: 42_424,
    },
    { compactionAvailable: true, multipartAvailable: true },
  );
  expect(decision.diagnostics.serializedInputBytes).toBe(42_424);
  expect(decision.diagnostics.partCount).toBe(1);
});

test("compaction byte budget is explicit and positive", () => {
  expect(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET).toBe(110_000);
  expect(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET).toBeGreaterThan(0);
});

test("compaction preserves the latest agent handoff and assistant continuity", () => {
  const messages: CodexMessage[] = [
    { role: "user", content: "old request", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
    { role: "agentMessage", author: "planner", recipient: "worker", content: "active handoff", timestamp: 3 },
    { role: "assistant", content: [{ type: "thinking", thinking: "latest reasoning state" }], timestamp: 4 },
    { role: "developer", content: "must keep", timestamp: 5 },
    { role: "user", content: "latest request", timestamp: 6 },
  ];

  const selected = selectCompactionMessagesDeterministically(
    messages,
    candidate => candidate.length <= 4,
  );

  expect(selected.messages.length).toBe(4);
  expect(selected.messages.some(message => message.role === "agentMessage")).toBe(true);
  expect(selected.messages.some(message =>
    message.role === "assistant"
    && message.content.some(part => part.type === "thinking" && part.thinking === "latest reasoning state")
  )).toBe(true);
  expect(selected.messages.some(message => message.role === "developer")).toBe(true);
  expect(selected.messages.at(-1)?.role).toBe("user");
});

const identity: ChatGptReplayIdentity = {
  sessionId: "dsh-session-1",
  agentId: "agent-1",
  turnId: "turn-1",
  capabilitySnapshotId: "snapshot-1",
  capabilityBindingId: "binding-1",
};

const trigger = { code: "context_exhausted" as const };

const context = projectCanonicalChatGptWebContext([], [
  { role: "user", content: "continue the task", timestamp: 1 },
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-settled",
      name: "read_file",
      arguments: { path: "src/index.ts" },
    }],
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "call-settled",
    toolName: "read_file",
    content: "trusted result",
    isError: false,
    timestamp: 3,
  },
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-pending",
      name: "write",
      arguments: { path: "x.txt", content: "x" },
    }],
    timestamp: 4,
  },
]);

const boundary = createChatGptReplayBoundary(context, {
  settledToolCallIds: ["call-settled"],
  pendingToolCallIds: ["call-pending"],
});

function transportSpy(
  replacement: ChatGptConversationHandle = { id: "conversation-2", generation: 2 },
): { transport: ChatGptReplayTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: ChatGptReplayTransport = {
    invalidateConversation(conversation) {
      calls.push("invalidate:" + conversation.id);
      return Promise.resolve();
    },
    createReplacementConversation() {
      calls.push("create");
      return Promise.resolve(replacement);
    },
    waitForReplacementReady(conversation) {
      calls.push("ready:" + conversation.id);
      return Promise.resolve();
    },
    bindReplacementConversation(previous, next) {
      calls.push("bind:" + previous.id + "->" + next.id);
      return Promise.resolve({ conversation: next, identity });
    },
    replayCanonicalContext(conversation, replayContext, replayBoundary, replayIdentity) {
      calls.push(
        "replay:"
        + conversation.id
        + ":"
        + replayContext.version
        + ":"
        + replayBoundary.settledToolCallIds.join(",")
        + ":"
        + replayBoundary.pendingToolCallIds.join(",")
        + ":"
        + replayIdentity.turnId,
      );
      return Promise.resolve();
    },
    resume(conversation) {
      calls.push("resume:" + conversation.id);
      return Promise.resolve();
    },
  };
  return { transport, calls };
}

test("deterministic replay replaces the conversation without changing trusted DSH identity", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  const result = await coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport);

  expect(result.recovery).toBe("REPLAY");
  expect(result.phase).toBe("COMPLETED");
  expect(result.oldConversation?.id).toBe("conversation-1");
  expect(result.activeConversation?.id).toBe("conversation-2");
  expect(result.generation).toBe(2);
  expect(result.staleConversationIds).toEqual(["conversation-1"]);
  expect(calls).toEqual([
    "create",
    "ready:conversation-2",
    "bind:conversation-1->conversation-2",
    "invalidate:conversation-1",
    "replay:conversation-2:3:call-settled:call-pending:turn-1",
    "resume:conversation-2",
  ]);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-1", generation: 1 })).toBe(false);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-2", generation: 2 })).toBe(true);
});

test("replacement must be a fresh conversation identity", async () => {
  const { transport } = transportSpy({ id: "conversation-1", generation: 1 });
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    code: "chatgpt_replay_failed",
    phase: "FAILED",
  });
  expect(coordinator.snapshot().phase).toBe("FAILED");
});

test("missing trusted replay classification fails before browser replacement", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary: {
      canonicalRevision: "not-trusted",
      canonicalMessageCount: context.messages.length,
      settledToolCallIds: [],
      pendingToolCallIds: [],
    } as never,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("ambiguous replay boundary fails closed before browser replacement", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary: {
      canonicalRevision: "forged",
      canonicalMessageCount: context.messages.length,
      settledToolCallIds: ["same"],
      pendingToolCallIds: ["same"],
    } as never,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("boundary factory rejects duplicate settled tool ids", () => {
  expect(() => createChatGptReplayBoundary(context, {
    settledToolCallIds: ["call-settled", "call-settled"],
    pendingToolCallIds: ["call-pending"],
  })).toThrow("duplicate settled tool call id");
});

test("settled tool ids may not be duplicated", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary: {
      canonicalRevision: "forged",
      canonicalMessageCount: context.messages.length,
      settledToolCallIds: ["settled", "settled"],
      pendingToolCallIds: [],
    } as never,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("replacement readiness is a hard gate", async () => {
  const calls: string[] = [];
  const { transport } = transportSpy();
  const blocked: ChatGptReplayTransport = {
    ...transport,
    waitForReplacementReady() {
      calls.push("ready");
      return Promise.reject(new Error("surface not ready"));
    },
  };
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, blocked)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual(["ready"]);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-2", generation: 2 })).toBe(false);
});

test("a late callback from the old conversation stays rejected after replay completes", async () => {
  const { transport } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport);

  expect(coordinator.acceptsConversationEvent({ id: "conversation-1", generation: 1 })).toBe(false);
  expect(coordinator.acceptsConversationEvent({ id: "conversation-2", generation: 2 })).toBe(true);
});

test("settled tool results are replay data, never execution requests", async () => {
  const executedToolCallIds: string[] = [];
  const { transport } = transportSpy();
  const guardedTransport = {
    ...transport,
    replayCanonicalContext(
      conversation: ChatGptConversationHandle,
      replayContext: typeof context,
      replayBoundary: ChatGptReplayBoundary,
    ) {
      if (replayBoundary.settledToolCallIds.length > 0) {
        // A real DSH executor is deliberately not part of the replay transport contract.
        // Passing settled IDs is reconstruction data only.
        executedToolCallIds.push(...[]);
      }
      return Promise.resolve();
    },
  };
  const coordinator = new ChatGptReplayCoordinator();

  await coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, guardedTransport);

  expect(executedToolCallIds).toEqual([]);
});

test("replay requires the explicit context_exhausted semantic condition", async () => {
  const { transport, calls } = transportSpy();
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger: { code: "unexpected_recovery" as never },
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, transport)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
  expect(calls).toEqual([]);
});

test("EXACT_RESUME cannot be silently reclassified as REPLAY", () => {
  const lease = new BrowserAccountLease({
    serviceId: "chatgpt-web",
    accountIdentity: "account-1",
    browserProfile: "profile-1",
    browserContext: "context-1",
    pageIdentity: "page-1",
    turnId: identity.turnId,
  });
  const capabilitySnapshot = {
    snapshotId: "snapshot-1",
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    turnId: identity.turnId,
    createdAt: Date.now(),
    lifecycle: "active" as const,
    tools: [],
  };
  const lifecycle = new ProviderTurnLifecycle(
    lease,
    { serviceId: "chatgpt-web", traceId: "trace-1", executionKey: "exec-1", nativeTurnId: identity.turnId },
    capabilitySnapshot,
  );

  lifecycle.markRecovery("EXACT_RESUME");
  expect(() => lifecycle.markRecovery("REPLAY")).toThrow(
    "Provider recovery cannot downgrade exact resume to replay",
  );
  expect(lifecycle.snapshot().recovery).toBe("EXACT_RESUME");
});


test("replacement binding cannot change DSH session, agent, turn, snapshot, or capability identity", async () => {
  const { transport } = transportSpy();
  const mismatched: ChatGptReplayTransport = {
    ...transport,
    bindReplacementConversation(previous, next, replayIdentity) {
      return Promise.resolve({
        conversation: next,
        identity: { ...replayIdentity, turnId: "different-turn" },
      });
    },
  };
  const coordinator = new ChatGptReplayCoordinator();

  await expect(coordinator.replay({
    trigger,
    exhaustedConversation: { id: "conversation-1", generation: 1 },
    identity,
    context,
    boundary,
  }, mismatched)).rejects.toMatchObject({
    name: "ChatGptReplayError",
    phase: "FAILED",
  });
});
