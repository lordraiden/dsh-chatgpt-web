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

test("Luna retains the authenticated ChatGPT Web conversation without a Launcher", () => {
  expect(
    shouldRetainChatGptWebConversation(nativeParsed(), { localTools: false }),
  ).toBe(true);
});

test("Sol retains only when local tools are enabled", () => {
  expect(
    shouldRetainChatGptWebConversation(nativeParsed({ modelId: "gpt-5.6-sol" }), { localTools: true }),
  ).toBe(true);
  expect(
    shouldRetainChatGptWebConversation(nativeParsed({ modelId: "gpt-5.6-sol" }), { localTools: false }),
  ).toBe(false);
});

test("manual Zero Risk turns keep their existing explicit launcher lifecycle", () => {
  expect(
    shouldRetainChatGptWebConversation(nativeParsed(), { localTools: true }, true),
  ).toBe(false);
});

test("a Sol turn without local tools and without a stable thread identity has no conversation affinity", () => {
  const sol = parsed({ modelId: "gpt-5.6-sol" });
  expect(chatGptConversationKey(sol, "namespace-a")).toBeUndefined();
});

test("consecutive turns of the same DSH chat keep one conversation affinity", () => {
  const firstTurn = nativeParsed({
    _dshContext: { dshSessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
  });
  const secondTurn = nativeParsed({
    _dshContext: { dshSessionId: "session-1", threadId: "thread-1", turnId: "turn-2" },
  });
  const key = chatGptConversationKey(firstTurn, "namespace-a");
  expect(key).toBe(chatGptConversationKey(secondTurn, "namespace-a"));
  const otherChat = nativeParsed({
    _dshContext: { dshSessionId: "session-2", threadId: "thread-9", turnId: "turn-1" },
  });
  expect(key).not.toBe(chatGptConversationKey(otherChat, "namespace-a"));
});

test("model and reasoning changes do not change the conversation key", () => {
  const base = nativeParsed();
  const key = chatGptConversationKey(base, "namespace-a");
  expect(key).toBe(chatGptConversationKey(
    nativeParsed({ modelId: "gpt-5.6-sol" }),
    "namespace-a",
  ));
  expect(key).toBe(chatGptConversationKey(
    nativeParsed({ options: { reasoning: "medium" } }),
    "namespace-a",
  ));
});

test("a compaction marker in the raw body does not change the conversation key", () => {
  const normal = nativeParsed();
  const compacted = nativeParsed({
    _rawBody: {
      input: [
        { type: "message", role: "user", content: "first" },
        { type: "compaction" },
      ],
    },
  });
  expect(chatGptConversationKey(normal, "namespace-a"))
    .toBe(chatGptConversationKey(compacted, "namespace-a"));
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
