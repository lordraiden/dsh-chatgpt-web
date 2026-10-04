import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  CONTEXT_EXHAUSTED_CODE,
  decideChatGptWebContextCapacity,
  resolveChatGptWebContextBudget,
  selectCompactionMessagesDeterministically,
} from "../src/adapters/chatgpt-web/context-budget";
import {
  CHATGPT_WEB_MAX_INPUT_IMAGES,
  applyChatGptWebImageBudget,
  projectCanonicalChatGptWebContext,
} from "../src/adapters/chatgpt-web/context-projection";
import type { CodexMessage } from "../src/types";

const capabilities = {
  solAvailable: false,
  proAvailable: false,
  experimentalBiggerContext: false,
};

test("Free Web budget separates theoretical window from measured browser transport", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low", capabilities);

  expect(budget.theoreticalContextWindow).toBe(1_050_000);
  expect(budget.preCompactionInputBudget).toBe(128_000);
  expect(budget.outputHeadroomTokens).toBe(922_000);
  expect(budget.browserMessageTokenLimit).toBe(128_000);
  expect(budget.browserComposerCharLimit).toBeUndefined();
  expect(budget.platformReserveTokens).toBe(8_192);
  expect(budget.imageLimit).toBe(CHATGPT_WEB_MAX_INPUT_IMAGES);
});

test("capacity decision is deterministic and prefers compaction before multipart", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low", capabilities);
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

test("Luna does not preflight-reject prompts only because they exceed the measured composer character boundary", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low", capabilities);
  expect(budget.browserComposerCharLimit).toBeUndefined();
  expect(decideChatGptWebContextCapacity(
    budget,
    { estimatedInputTokens: 100_000, estimatedMessageTokens: 100_000, promptChars: 140_000 },
    { compactionAvailable: false, multipartAvailable: false },
  ).outcome).toBe("fits");
});

test("context exhaustion is independent of token overflow and exposes a stable semantic code", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low", capabilities);
  const decision = decideChatGptWebContextCapacity(
    budget,
    { estimatedInputTokens: 10, estimatedMessageTokens: 10 },
    { compactionAvailable: false, multipartAvailable: false, productContextExhausted: true },
  );

  expect(decision.outcome).toBe("context_exhausted");
  expect(decision.nextAction).toBe("replay");
  expect(CONTEXT_EXHAUSTED_CODE).toBe("context_exhausted");
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
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low", capabilities);
  const decision = decideChatGptWebContextCapacity(
    budget,
    {
      estimatedInputTokens: 1_000,
      estimatedMessageTokens: budget.browserMessageTokenLimit! + 1,
      promptChars: 1_000,
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
  const budget = resolveChatGptWebContextBudget("gpt-5.6-luna", "low", capabilities);
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
