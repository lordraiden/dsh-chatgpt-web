import { expect, test } from "bun:test";
import {
  detectChatGptContextExhaustion,
  type ChatGptContextExhaustionObservation,
} from "../src/adapters/chatgpt-web/context-exhaustion";
import { chatGptContextExhaustedError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, type ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";

function observation(overrides: Partial<ChatGptContextExhaustionObservation>): ChatGptContextExhaustionObservation {
  return {
    role: "alert",
    text: "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.",
    actionLabels: ["New chat"],
    ...overrides,
  };
}

test("detects the canonical maximum-conversation-length surface", () => {
  const signal = detectChatGptContextExhaustion(observation({}));
  expect(signal).toEqual({
    kind: "context_exhausted",
    variant: "maximum-conversation-length",
    source: "surface-structure",
    text: "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.",
  });
});

test("detects the shorter conversation-too-long variant", () => {
  const signal = detectChatGptContextExhaustion(observation({
    text: "This conversation is too long, please start a new one.",
    actionLabels: ["Start a new chat"],
  }));
  expect(signal?.kind).toBe("context_exhausted");
  expect(signal?.variant).toBe("conversation-too-long");
});

test("detects localized structural equivalents without relying on English copy", () => {
  const cases = [
    ["Has alcanzado la longitud máxima de esta conversación. Inicia un nuevo chat.", "Nuevo chat"],
    ["Vous avez atteint la longueur maximale de cette conversation. Nouvelle conversation.", "Nouvelle conversation"],
    ["此对话已达到最大长度，请开始新对话。", "新对话"],
    ["この会話は最大長さに達しました。新しいチャットを開始してください。", "新しいチャット"],
    ["현재 대화가 최대 길이에 도달했습니다. 새 채팅을 시작하세요.", "새 채팅"],
  ] as const;

  for (const [text, action] of cases) {
    const signal = detectChatGptContextExhaustion(observation({ text, actionLabels: [action] }));
    expect(signal?.kind).toBe("context_exhausted");
  }
});

test("detects a plain structural wrapper when the exhaustion surface exposes a New Chat action", () => {
  const signal = detectChatGptContextExhaustion({
    text: "This conversation is too long, please start a new one.",
    actionLabels: ["New chat"],
  });
  expect(signal?.kind).toBe("context_exhausted");
  expect(signal?.variant).toBe("conversation-too-long");
});

test("does not classify an ordinary assistant message", () => {
  const signal = detectChatGptContextExhaustion(observation({
    role: "assistant",
    withinAssistantTurn: true,
    text: "This conversation is too long; you could start a new chat if you want a different topic.",
  }));
  expect(signal).toBeUndefined();
});

test("does not classify a generic ChatGPT error", () => {
  const signal = detectChatGptContextExhaustion(observation({
    text: "Something went wrong. Please try again.",
    actionLabels: ["Retry"],
  }));
  expect(signal).toBeUndefined();
});

test("does not let a New Chat button turn a generic maximum-attempt error into exhaustion", () => {
  const signal = detectChatGptContextExhaustion(observation({
    role: "alert",
    testId: "request-error",
    text: "Maximum retry attempts reached. Please try again later.",
    actionLabels: ["New chat"],
  }));
  expect(signal).toBeUndefined();
});

test("does not classify a loading/readiness surface", () => {
  const signal = detectChatGptContextExhaustion(observation({
    role: "status",
    text: "Loading chats",
    actionLabels: [],
  }));
  expect(signal).toBeUndefined();
});

test("context exhaustion is a terminal semantic provider condition", () => {
  const error = chatGptContextExhaustedError();
  expect(error.code).toBe("context_exhausted");
  expect(error.retryable).toBe(false);
  expect(error.status).toBe(409);
});

function runtimeForRetainedConversation(physicalSettlement: Promise<void>, release: () => void): ChatGptTurnRuntime {
  const capabilitySnapshot = projectChatGptCapabilities({
    sessionId: "dsh-session-1",
    agentId: "agent-1",
    turnId: "native-turn-1",
    tools: [],
  });

  return {
    mode: "read-only",
    capabilitySnapshot,
    browser: Promise.resolve("terminal"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "conversation-1",
    releaseRetainedConversation: async () => release(),
    cancel: () => {},
  };
}

test("confirmed exhaustion invalidates the retained conversation immediately but releases it only after physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolvePhysical!: () => void;
  let released = false;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  const runtime = runtimeForRetainedConversation(
    physicalSettlement,
    () => { released = true; },
  );
  const session = sessions.getOrCreate(
    "execution-1",
    () => runtime,
    "trace-1",
    "owner-1",
    "native-turn-1",
    "thread-1",
  );

  const retirement = sessions.retireConversationAndWait("conversation-1");

  expect(sessions.find("execution-1")).toBeUndefined();
  expect(sessions.findConversationHead("conversation-1")).toBeUndefined();
  expect(session.conversationKey()).toBeUndefined();
  expect(released).toBe(false);

  resolvePhysical();
  await retirement;

  expect(released).toBe(true);
});
