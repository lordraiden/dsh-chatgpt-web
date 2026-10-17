import { describe, expect, test } from "bun:test";
import {
  normalizeApiSessionId,
  projectApiConversation,
  type ApiConversationMessage,
} from "../src/web-chat/host/api-projection";

/**
 * Issue #253 — the API transmits only the conversation's messages.
 *
 * The payloads below are shaped like what real harnesses send: their own instructions, an environment
 * block (file tree, open files, terminal output, timestamps) and the human's words, all as ordinary
 * `messages`. The tests use them so the rule is proven against harness behaviour instead of against a
 * convenient fixture.
 */
const SYSTEM_PROMPT: ApiConversationMessage = {
  role: "system",
  content: "You are Cline, an AI coding agent. Follow the user's instructions and use your tools.",
};

const ENVIRONMENT_BLOCK: ApiConversationMessage = {
  role: "system",
  content: [
    "# Environment Details",
    "Current time: 2026-10-16T19:40:00+02:00",
    "Working directory: /srv/project",
    "<file_tree>",
    "├── src/index.ts",
    "└── package.json",
    "</file_tree>",
  ].join("\n"),
};

/** A first user message that a stateless harness stuffs with context, then the real question. */
const FIRST_USER_WITH_CONTEXT: ApiConversationMessage = {
  role: "user",
  content: [
    "<session_context>",
    "Repository: acme/widgets. Open file: src/index.ts. Recent terminal output: …",
    "</session_context>",
    "",
    "Hola",
  ].join("\n"),
};

const ASSISTANT_TURN: ApiConversationMessage = { role: "assistant", content: "¿En qué te ayudo?" };

const REAL_QUESTION: ApiConversationMessage = {
  role: "user",
  content: "Añade un test para el analizador de rutas.",
};

const HARNESS_PAYLOAD: readonly ApiConversationMessage[] = [
  SYSTEM_PROMPT,
  ENVIRONMENT_BLOCK,
  FIRST_USER_WITH_CONTEXT,
  ASSISTANT_TURN,
  REAL_QUESTION,
];

describe("issue #253 — a session identity selects the strict rule", () => {
  test("only the current user message crosses; system, environment and earlier turns do not", () => {
    const projected = projectApiConversation({ messages: HARNESS_PAYLOAD, sessionId: "harness-session-1" });

    expect(projected.mode).toBe("session");
    expect(projected.messages).toEqual([REAL_QUESTION]);
    // The harness's own context never reaches the provider, whatever it looked like.
    const sent = projected.messages.map((message) => message.content).join("\n");
    for (const leaked of ["You are Cline", "Environment Details", "file_tree", "<session_context>", "Hola"]) {
      expect(sent).not.toContain(leaked);
    }
    expect([...projected.droppedRoles].sort()).toEqual(["system"]);
    expect(projected.droppedTurns).toBe(2);
  });

  test("a whitespace-only identity is not an identity", () => {
    expect(normalizeApiSessionId("   ")).toBeUndefined();
    expect(normalizeApiSessionId("")).toBeUndefined();
    expect(normalizeApiSessionId(undefined)).toBeUndefined();
    expect(normalizeApiSessionId(42)).toBeUndefined();
    expect(normalizeApiSessionId("  keep-me  ")).toBe("keep-me");

    expect(projectApiConversation({ messages: HARNESS_PAYLOAD, sessionId: "   " }).mode).toBe("stateless");
  });

  test("a session-addressed request with no user message is refused instead of sending nothing", () => {
    expect(() => projectApiConversation({ messages: [SYSTEM_PROMPT], sessionId: "s" }))
      .toThrow(/no user message/);
  });
});

describe("issue #253 — without a session identity the request is stateless", () => {
  test("non-conversational roles are dropped and the conversation is preserved in order", () => {
    const projected = projectApiConversation({ messages: HARNESS_PAYLOAD });

    expect(projected.mode).toBe("stateless");
    expect(projected.messages).toEqual([FIRST_USER_WITH_CONTEXT, ASSISTANT_TURN, REAL_QUESTION]);
    expect([...projected.droppedRoles].sort()).toEqual(["system"]);
    expect(projected.droppedTurns).toBe(0);
  });

  test("every non-conversational role is dropped, including unknown ones", () => {
    const projected = projectApiConversation({
      messages: [
        { role: "developer", content: "hidden developer instruction" },
        { role: "tool", content: "tool result" },
        { role: "function", content: "legacy function result" },
        { role: "preamble", content: "something a future harness invents" },
        REAL_QUESTION,
      ],
    });

    expect(projected.messages).toEqual([REAL_QUESTION]);
    expect([...projected.droppedRoles].sort()).toEqual(["developer", "function", "preamble", "tool"]);
  });

  test("the documented limit is asserted, not implied: harness text inside the user message crosses", () => {
    // This is the honest boundary of a structural rule. It is a test so a future change cannot
    // silently pretend the API removes it.
    const projected = projectApiConversation({ messages: [FIRST_USER_WITH_CONTEXT] });
    expect(projected.messages[0]!.content).toContain("<session_context>");
  });

  test("a request whose last message is not from the user is refused", () => {
    expect(() => projectApiConversation({ messages: [ASSISTANT_TURN] }))
      .toThrow(/no user message/);
    expect(() => projectApiConversation({ messages: [] }))
      .toThrow(/no user message/);
  });
});

describe("issue #253 — the projection decides the provider conversation identity", () => {
  test("an explicit identity is used verbatim, and a stateless identity is content-derived", () => {
    expect(projectApiConversation({ messages: HARNESS_PAYLOAD, sessionId: "harness-session-1" }).conversationIdentity)
      .toBe("harness-session-1");

    const stateless = projectApiConversation({ messages: HARNESS_PAYLOAD });
    expect(stateless.mode).toBe("stateless");
    expect(stateless.conversationIdentity).toMatch(/^dsh-chat-[0-9a-f]{16}$/);
  });

  test("the identity is never per-request: same content, same conversation; different content, different one", () => {
    const one = projectApiConversation({ messages: [FIRST_USER_WITH_CONTEXT, ASSISTANT_TURN, REAL_QUESTION] });
    const again = projectApiConversation({ messages: [FIRST_USER_WITH_CONTEXT, ASSISTANT_TURN, REAL_QUESTION] });
    const other = projectApiConversation({ messages: [REAL_QUESTION] });

    // Continuity for a client that resends its history — and for a resend of the identical request.
    expect(again.conversationIdentity).toBe(one.conversationIdentity);
    // Isolation for different content.
    expect(other.conversationIdentity).not.toBe(one.conversationIdentity);
    // Dropped roles never participate: injected harness context cannot split or fuse a conversation.
    const withExtraSystem: ApiConversationMessage[] = [{ ...SYSTEM_PROMPT }, ENVIRONMENT_BLOCK, ...one.messages];
    expect(projectApiConversation({ messages: withExtraSystem }).conversationIdentity)
      .toBe(one.conversationIdentity);
  });
});
