import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CHATGPT_CONTINUATION_PROMPT_MISSING_CODE } from "../src/adapters/chatgpt-web/adapter-error";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { closeNativeChatGptContinuityStores, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import { translateChatCompletionsRequest } from "../src/responses/chat-completions";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";
import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "../src/types";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  ControlledSurface,
  controlledIncoming,
  controlledProviderConfig,
} from "./support/chatgpt-web-surface";

/**
 * Issue #302 — the second turn of an existing conversation is a continuation, not a refusal.
 *
 * The reproduction against the real deployment: turn 1 on an identity answers (200); turn 2 on the
 * SAME identity is refused in ~0 ms with `502 upstream_server_error` /
 * `"The retained ChatGPT conversation has no continuation prompt"`. A different identity answers in
 * its own conversation.
 *
 * The causal shape proven here: the retained-continuation delta is derived by
 * `retainedConversationResumeRequest`, which treats the incoming message list as a growing canonical
 * transcript and returned `undefined` whenever it carried no assistant reply. The API identity
 * projection (`projectApiConversation`, session mode) deliberately transmits **only the newest user
 * message** for a caller with a stable identity, so that is exactly the shape every identity-addressed
 * caller has — and the adapter read `undefined` as "this turn cannot continue a retained
 * conversation", attached no resume prompt, and a reused retained surface was refused as if ChatGPT
 * had failed. The retained-continuation owner now reads a list with no assistant reply as *all-new
 * content*.
 *
 * The tests drive the real route a `/v1/chat/completions` caller takes (translate → parse → route →
 * adapter) with only the browser I/O replaced, so the projection, the identity channel, the
 * continuity decision and the delta are the production ones.
 */
let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-302-continuation-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

const LUNA = "chatgpt-web/luna";
const INSTALL_HEADER = "Project:";

/** One message as the wire carries it. */
interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * The exact turn `/v1/chat/completions` produces for a request: the OpenAI translation (which owns
 * the message-only projection and the caller's conversation identity), the shared Responses parser
 * and the catalogue-to-driver route resolution.
 */
function apiTurn(options: {
  readonly identity?: string;
  readonly messages: readonly WireMessage[];
}): CodexParsedRequest {
  const translated = translateChatCompletionsRequest({
    model: LUNA,
    ...(options.identity !== undefined ? { user: options.identity } : {}),
    messages: options.messages.map(message => ({ role: message.role, content: message.content })),
  });
  const parsed = parseRequest(translated.body);
  routeChatGptWebRequest(parsed, defaultConfig());
  return parsed;
}

/**
 * A turn built directly on the metadata channel every surface shares, for the input shapes the public
 * projection cannot produce (it always ends on a user message by construction).
 */
function metadataTurn(identity: string, messages: readonly WireMessage[]): CodexParsedRequest {
  const parsed = parseRequest({
    model: LUNA,
    input: messages.map(message => ({
      type: "message",
      role: message.role,
      content: [{ type: "input_text", text: message.content }],
    })),
    stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: identity }) },
  });
  routeChatGptWebRequest(parsed, defaultConfig());
  return parsed;
}

function adapter(surface: ControlledSurface) {
  return createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: surface.transport });
}

async function runTurn(
  target: ReturnType<typeof adapter>,
  request: CodexParsedRequest,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await target.runTurn(request, controlledIncoming(), event => events.push(event));
  return events;
}

const errors = (events: readonly AdapterEvent[]) =>
  events.filter((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");

const finalText = (events: readonly AdapterEvent[]) =>
  events.filter(event => event.type === "text_delta").map(event => (event as { text: string }).text).join("");

describe("issue #302 — an identity-addressed second turn continues its retained conversation", () => {
  test("two turns on the same identity answer, and the second one continues with the new turn only", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    // Turn 1: a first conversation, so it installs the project header and the human turn.
    const first = await runTurn(target, apiTurn({
      identity: "prueba-sesion-nueva-1",
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    expect(errors(first)).toEqual([]);
    expect(first.some(event => event.type === "done")).toBe(true);
    expect(finalText(first)).toBe("uno");

    // Turn 2: the caller resends the growing history. The projection transmits only the newest user
    // message (the provider conversation owns the history), and that must still be a continuation.
    const second = await runTurn(target, apiTurn({
      identity: "prueba-sesion-nueva-1",
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "assistant", content: "respuesta uno" },
        { role: "user", content: "pregunta dos" },
      ],
    }));

    // The acceptance criterion: 200, real content, no refusal.
    expect(errors(second)).toEqual([]);
    expect(second.some(event => event.type === "done")).toBe(true);
    expect(finalText(second)).toBe("dos");

    // Both turns ran on the SAME physical provider conversation...
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    // ...the first installed the header, and the second was a true continuation: the new human turn
    // only, never a re-install of the already-installed prefix.
    expect(surface.runs[0]!.prompt).toContain(INSTALL_HEADER);
    expect(surface.runs[1]!.prompt).toBe("pregunta dos");
  });

  test("a caller that resends only the newest message continues with that message", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    await runTurn(target, apiTurn({
      identity: "newest-message-only",
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    const second = await runTurn(target, apiTurn({
      identity: "newest-message-only",
      messages: [{ role: "user", content: "pregunta dos" }],
    }));

    // Decided from the evidence: it CONTINUES with that message. A newest-message-only caller is the
    // normal shape of a chat client (and of the API projection), never an error.
    expect(errors(second)).toEqual([]);
    expect(second.some(event => event.type === "done")).toBe(true);
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[1]!.prompt).toBe("pregunta dos");
  });

  test("a session-addressed history that diverges is the caller's business: the newest turn still continues", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    await runTurn(target, apiTurn({
      identity: "divergent-history",
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    // The resent history is NOT an extension of what was sent: different earlier turns entirely.
    const second = await runTurn(target, apiTurn({
      identity: "divergent-history",
      messages: [
        { role: "user", content: "algo distinto" },
        { role: "assistant", content: "otra respuesta" },
        { role: "user", content: "pregunta dos" },
      ],
    }));

    // Explicit and documented, never an upstream error: a session-addressed caller never transmits
    // its history at all (the provider conversation owns it), so the turn continues with the newest
    // human message. Divergence is not observable at this seam by design.
    expect(errors(second)).toEqual([]);
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[1]!.prompt).toBe("pregunta dos");
  });

  test("a stateless caller whose resent content diverges opens its own conversation, not a fork", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    await runTurn(target, apiTurn({ messages: [{ role: "user", content: "pregunta uno" }] }));
    const second = await runTurn(target, apiTurn({ messages: [{ role: "user", content: "pregunta dos" }] }));

    // No identity: the contract's documented limit is that a one-message request is its own
    // conversation, so the second content is a NEW conversation (an install), never a mismatch error
    // and never a silent replacement of the first.
    expect(errors(second)).toEqual([]);
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).not.toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[1]!.prompt).toContain(INSTALL_HEADER);
  });

  test("a new identity still opens its own conversation", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    await runTurn(target, apiTurn({
      identity: "prueba-sesion-nueva-1",
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    const second = await runTurn(target, apiTurn({
      identity: "prueba-sesion-nueva-2",
      messages: [{ role: "user", content: "pregunta dos" }],
    }));

    expect(errors(second)).toEqual([]);
    expect(second.some(event => event.type === "done")).toBe(true);
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).not.toBe(surface.runs[0]!.turn.conversationKey);
    // A new conversation installs its own header; it never continues the other identity's thread.
    expect(surface.runs[1]!.prompt).toContain(INSTALL_HEADER);
  });

  test("a reused conversation with genuinely nothing to send refuses with its own category, never an upstream 502", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    const target = adapter(surface);

    await runTurn(target, metadataTurn("nothing-to-send", [{ role: "user", content: "pregunta uno" }]));
    // The request ends on the assistant reply, so this turn carries no new human content at all —
    // the one shape that really cannot continue.
    const second = await runTurn(target, metadataTurn("nothing-to-send", [
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "respuesta uno" },
    ]));

    const failures = errors(second);
    expect(failures).toHaveLength(1);
    // Its own category, never `upstream_server_error` and never a 502: nothing reached ChatGPT.
    expect(failures[0]!.code).toBe(CHATGPT_CONTINUATION_PROMPT_MISSING_CODE);
    expect(failures[0]!.code).not.toBe("upstream_server_error");
    expect(failures[0]!.status).toBe(409);
    expect(failures[0]!.retryable).toBe(false);
    // The message says what the caller should do, not what an internal state is.
    expect(failures[0]!.message).toMatch(/next user message/i);
    // The reused surface never opened a second browser run.
    expect(surface.runs).toHaveLength(1);
  });
});

describe("issue #302 — the continuation delta owner reads a list without an assistant reply as new content", () => {
  const user = (content: string): CodexMessage => ({ role: "user", content, timestamp: 1 });
  const assistant = (content: string): CodexMessage => ({
    role: "assistant",
    content: [{ type: "text", text: content }],
    timestamp: 2,
  });
  const turn = (messages: readonly CodexMessage[]): CodexParsedRequest => ({
    modelId: "gpt-5.6-luna",
    context: { messages: [...messages] },
    stream: false,
    options: {},
    _dshContext: { dshSessionId: "delta-owner-session", threadId: "delta-owner-thread", turnId: "delta-owner-turn" },
  } as unknown as CodexParsedRequest);

  test("a list with no assistant reply is all-new content, not 'no continuation'", () => {
    const newestOnly = retainedConversationResumeRequest(turn([user("pregunta dos")]));
    expect(newestOnly).toBeDefined();
    expect(newestOnly!.context.messages.map(message => message.role)).toEqual(["user"]);

    const wholeTurn = retainedConversationResumeRequest(turn([user("uno"), user("dos")]));
    expect(wholeTurn!.context.messages).toHaveLength(2);
  });

  test("the suffix after the last assistant reply is still the delta, and the turn identity is preserved", () => {
    const resume = retainedConversationResumeRequest(turn([
      user("viejo"),
      assistant("respuesta vieja"),
      user("nuevo"),
    ]))!;
    expect(resume.context.messages.map(message => message.role)).toEqual(["user"]);
    expect(JSON.stringify(resume.context.messages)).toContain("nuevo");
    // The resume compiles against the same turn: identity, options and body are not dropped.
    expect(resume.modelId).toBe("gpt-5.6-luna");
    expect(resume._dshContext).toEqual(turn([])._dshContext);
  });

  test("only a request that ends on the assistant reply has nothing to continue with", () => {
    expect(retainedConversationResumeRequest(turn([user("uno"), assistant("respuesta")]))).toBeUndefined();
  });
});
