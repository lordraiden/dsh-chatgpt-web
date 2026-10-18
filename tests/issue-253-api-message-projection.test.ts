import { describe, expect, test } from "bun:test";
import {
  API_PROJECTION_HOST_CONTEXT_ONLY_CODE,
  API_PROJECTION_NO_USER_MESSAGE_CODE,
  ApiProjectionRefusalError,
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

/**
 * The harness's own runtime snapshot, sent as one more `user` message after the human turn (the time
 * plugin's rendered text, verbatim). `sanitizeConversationText` strips every line of it, so this
 * message carries no human content: it is context, never a turn (issue #307).
 */
const RUNTIME_SNAPSHOT: ApiConversationMessage = {
  role: "user",
  content: [
    "Time sampled while preparing turn 1, step 1: 2026-10-18T12:17:11+02:00[Europe/Madrid]",
    "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.",
    "Elapsed since the preceding model-visible message: unavailable.",
  ].join("\n"),
};

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
    let refusal: unknown;
    try {
      projectApiConversation({ messages: [SYSTEM_PROMPT], sessionId: "s" });
    } catch (error) {
      refusal = error;
    }
    // The refusal is typed, and this case keeps its own code: "you sent no user message" is a
    // different mistake from "you sent only the host's own context" (asserted below), and a caller can
    // only act on one if it is told which.
    expect(refusal).toBeInstanceOf(ApiProjectionRefusalError);
    expect((refusal as ApiProjectionRefusalError).code).toBe(API_PROJECTION_NO_USER_MESSAGE_CODE);
    expect((refusal as Error).message).toMatch(/no user message/);
  });

  test("the turn is the newest user message that carries content, not the last user-role message", () => {
    // A harness that owns its clock appends a runtime snapshot after the human turn: selecting by
    // role alone would transmit that snapshot — an empty turn the provider's compiler must refuse.
    const projected = projectApiConversation({
      messages: [REAL_QUESTION, RUNTIME_SNAPSHOT],
      sessionId: "harness-session-snapshot",
    });

    expect(projected.mode).toBe("session");
    expect(projected.messages).toEqual([REAL_QUESTION]);
    expect(projected.droppedTurns).toBe(0);

    // The same when the human turn is not the first message of the request.
    const later = projectApiConversation({
      messages: [FIRST_USER_WITH_CONTEXT, ASSISTANT_TURN, REAL_QUESTION, RUNTIME_SNAPSHOT],
      sessionId: "harness-session-snapshot",
    });
    expect(later.messages).toEqual([REAL_QUESTION]);
    expect(later.droppedTurns).toBe(2);
  });

  test("a session-addressed turn whose only human content is host context is refused, not emptied", () => {
    // The owner's rule (issue #307 follow-up): a turn whose entire content is the harness's own
    // runtime snapshot must not be sent at all. It is refused here — before the turn exists — with the
    // code that says exactly that, and never with the "no user message" code, because a `user` message
    // was there: it simply carried nothing human.
    for (const messages of [
      [RUNTIME_SNAPSHOT],
      [SYSTEM_PROMPT, RUNTIME_SNAPSHOT],
    ] as const) {
      let refusal: unknown;
      try {
        projectApiConversation({ messages: [...messages], sessionId: "s" });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ApiProjectionRefusalError);
      expect((refusal as ApiProjectionRefusalError).code).toBe(API_PROJECTION_HOST_CONTEXT_ONLY_CODE);
      // Caller terms: the message says what happened and how to phrase a real turn.
      expect((refusal as Error).message).toMatch(/only host context/);
      expect((refusal as Error).message).toMatch(/user.*message/);
    }

    // Host context added around a real human turn never triggers it: the human turn is the turn.
    expect(projectApiConversation({
      messages: [SYSTEM_PROMPT, RUNTIME_SNAPSHOT, REAL_QUESTION],
      sessionId: "s",
    }).messages).toEqual([REAL_QUESTION]);
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

  test("stateless keeps every conversational message; deciding the human turn is the compiler's", () => {
    // The stateless rule carries the whole conversation, so a trailing runtime snapshot travels with
    // it — and the provider's compiler is what ignores it when it picks the human turn. This owner
    // only selects the turn in session mode, where exactly one message is transmitted.
    const projected = projectApiConversation({ messages: [REAL_QUESTION, RUNTIME_SNAPSHOT] });
    expect(projected.mode).toBe("stateless");
    expect(projected.messages).toEqual([REAL_QUESTION, RUNTIME_SNAPSHOT]);
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
