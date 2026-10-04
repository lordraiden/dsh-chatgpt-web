import { expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import {
  shouldRetainChatGptWebConversation,
} from "../src/adapters/chatgpt-web/index";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";

function parsed(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    stream: true,
    options: { reasoning: "low" },
    context: {
      systemPrompt: ["system"],
      messages: [],
    },
    ...overrides,
  };
}

function nativeParsed(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return parsed({
    _dshContext: {
      dshSessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-2",
    },
    ...overrides,
  });
}

test("Luna retains the authenticated ChatGPT Web conversation when a launcher is available", () => {
  expect(
    shouldRetainChatGptWebConversation(nativeParsed(), { localTools: false }, true),
  ).toBe(true);
});

test("Luna does not retain a conversation without the launcher surface", () => {
  expect(
    shouldRetainChatGptWebConversation(nativeParsed(), { localTools: false }, false),
  ).toBe(false);
});

test("Luna does not retain a conversation for compaction turns", () => {
  expect(
    shouldRetainChatGptWebConversation(
      nativeParsed({ _compactionRequest: true }),
      { localTools: false },
      true,
    ),
  ).toBe(false);
});

test("manual Zero Risk turns keep their existing explicit launcher lifecycle", () => {
  expect(
    shouldRetainChatGptWebConversation(nativeParsed(), { localTools: true }, true, true),
  ).toBe(false);
});

test("Luna conversation keys are stable for the same DSH conversation affinity", () => {
  const input = nativeParsed();
  expect(chatGptConversationKey(input, "namespace-a"))
    .toBe(chatGptConversationKey(input, "namespace-a"));
  expect(chatGptConversationKey(input, "namespace-a"))
    .not.toBe(chatGptConversationKey({ ...input, _dshContext: { ...input._dshContext!, threadId: "thread-2" } }, "namespace-a"));
});

test("retained Luna turns compile only the suffix after the last assistant reply", () => {
  const input = nativeParsed({
    context: {
      systemPrompt: ["system"],
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 },
        { role: "user", content: "second", timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: 4 },
        { role: "user", content: "third", timestamp: 5 },
      ],
    },
  });

  const resumed = retainedConversationResumeRequest(input);
  expect(resumed?.context.systemPrompt).toEqual(["system"]);
  expect(resumed?.context.messages).toEqual([
    { role: "user", content: "third", timestamp: 5 },
  ]);
});

test("a retained conversation with no new suffix does not produce a continuation request", () => {
  const input = nativeParsed({
    context: {
      systemPrompt: ["system"],
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 },
      ],
    },
  });

  expect(retainedConversationResumeRequest(input)).toBeUndefined();
});
