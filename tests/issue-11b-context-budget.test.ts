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
  solAvailable: true,
  proAvailable: false,
  experimentalBiggerContext: false,
};

test("effective budget separates model window, pre-compaction budget, and output headroom", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-sol", "low", capabilities);

  expect(budget.theoreticalContextWindow).toBe(41_000);
  expect(budget.preCompactionInputBudget).toBe(32_000);
  expect(budget.outputHeadroomTokens).toBe(9_000);
  expect(budget.platformReserveTokens).toBe(8_192);
  expect(budget.imageLimit).toBe(CHATGPT_WEB_MAX_INPUT_IMAGES);
});

test("capacity decision is deterministic and prefers compaction before multipart", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-sol", "low", capabilities);
  const input = {
    estimatedInputTokens: 40_000,
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
    estimatedInputTokens: 30_000,
  }, {
    compactionAvailable: true,
    multipartAvailable: true,
  }).outcome).toBe("fits");
});

test("context exhaustion is independent of token overflow and exposes a stable semantic code", () => {
  const budget = resolveChatGptWebContextBudget("gpt-5.6-sol", "low", capabilities);
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
  expect(JSON.stringify(transport.messages)).toContain("https://example.com/11.png");
});

test("compaction byte budget is explicit and positive", () => {
  expect(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET).toBe(110_000);
  expect(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET).toBeGreaterThan(0);
});
