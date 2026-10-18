import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  resolveNativeChatGptContinuityStore,
  shouldRetainChatGptWebConversation,
} from "../src/adapters/chatgpt-web/index";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import type { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import { ChatCompletionsRequestError, translateChatCompletionsRequest } from "../src/responses/chat-completions";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest, startServer, type RunningServer } from "../src/server";
import { isEphemeralWebChatTurn, webChatTurnDeliveryFor } from "../src/web-chat/core";
import {
  API_PROJECTION_HOST_CONTEXT_ONLY_CODE,
  API_PROJECTION_NO_USER_MESSAGE_CODE,
} from "../src/web-chat/host/api-projection";
import {
  nativeTurnMetadataFromBody,
  resolveNativeTurnIdentity,
} from "../src/web-chat/host/turn-identity";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
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
 * Issue #307 — the identity a caller already sends, and the housekeeping turn that must not claim a
 * conversation.
 *
 * The reproduction against the real deployment: a DSH harness reached this service through an
 * OpenAI-compatible provider adapter that sends **no identity at all**, so the chat surface took its
 * documented metadata-less branch and derived identity from the message content. Two harness sessions
 * produced **9 ChatGPT chats instead of 2**.
 *
 * Two independent causes are fixed here, and the tests drive the REAL route a
 * `/v1/chat/completions` caller takes (translate → parse → route → adapter), with only the browser I/O
 * replaced, so the projection, the identity channel, the retention decision and the continuity
 * decision are the production ones:
 *
 * 1. the surface only ever read `body.user` / `body.session_id` **and replaced** the caller's
 *    `client_metadata`, so the native identity and the auxiliary `purpose` were erased before the
 *    adapter could read them;
 * 2. nothing consumed `purpose` at all, so a session-title or compaction call was treated like the
 *    user's own turn and claimed the session's provider conversation.
 *
 * What remains, stated rather than implied: with the harness still sending no identity, this change
 * cannot fuse its turns — see the last block. Everything here is the service being ready for the
 * identity, not the identity arriving.
 *
 * The follow-up block covers the two channels an OpenAI-compatible harness can actually reach with
 * **configuration only** (verified against the installed `@earendil-works/pi-ai` and the harness's
 * `dsh-llm-pi-ai` profile schema): `prompt_cache_key` in the body, which the harness session id lands
 * in once its profile sets `cacheRetention: "long"`, and the session-affinity / declared-purpose
 * request headers. Both are read by the same one owner, below every identity this product already
 * understood, and neither is ever inferred from content.
 */
let home: string;
let savedHome: SavedChatGptWebHome;
const listeners: RunningServer[] = [];

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-307-turn-identity-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  while (listeners.length > 0) {
    const server = listeners.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

const LUNA = "chatgpt-web/luna";
const INSTALL_HEADER = "Project:";

/** The native turn-metadata field the harness can send, spelled exactly as the wire spells it. */
interface NativeMetadata {
  readonly dsh_session_id?: string;
  readonly purpose?: string;
  readonly [key: string]: unknown;
}

interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * One `/v1/chat/completions` request carrying the **native** identity shape, run through the exact
 * production path: the surface translation, the shared Responses parser and the catalogue route.
 */
function nativeApiTurn(options: {
  readonly messages: readonly WireMessage[];
  readonly metadata?: NativeMetadata;
  readonly user?: string;
}): CodexParsedRequest {
  const translated = translateChatCompletionsRequest({
    model: LUNA,
    ...(options.user !== undefined ? { user: options.user } : {}),
    messages: options.messages.map(message => ({ role: message.role, content: message.content })),
    ...(options.metadata
      ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify(options.metadata) } }
      : {}),
  });
  const parsed = parseRequest(translated.body);
  routeChatGptWebRequest(parsed, defaultConfig());
  return parsed;
}

/** The same call as a caller that sends nothing at all keeps making today. */
function plainApiTurn(messages: readonly WireMessage[]): CodexParsedRequest {
  const translated = translateChatCompletionsRequest({
    model: LUNA,
    messages: messages.map(message => ({ role: message.role, content: message.content })),
  });
  const parsed = parseRequest(translated.body);
  routeChatGptWebRequest(parsed, defaultConfig());
  return parsed;
}

/**
 * One `/v1/chat/completions` request that declares its identity on the **OpenAI wire**, not in native
 * metadata: `prompt_cache_key` in the body and/or the session-affinity and declared-purpose request
 * headers.
 *
 * These are the channels an OpenAI-compatible harness (`@earendil-works/pi-ai`) actually uses when its
 * profile asks for long prompt-cache retention, so this drives the same production path as
 * `nativeApiTurn` — translation, the shared Responses parser and the catalogue route — with the request
 * headers the HTTP surface supplies.
 */
function channelApiTurn(options: {
  readonly messages: readonly WireMessage[];
  readonly promptCacheKey?: string;
  readonly headers?: Record<string, string>;
  readonly metadata?: NativeMetadata;
  readonly user?: string;
}): CodexParsedRequest {
  const translated = translateChatCompletionsRequest({
    model: LUNA,
    ...(options.user !== undefined ? { user: options.user } : {}),
    ...(options.promptCacheKey !== undefined ? { prompt_cache_key: options.promptCacheKey } : {}),
    messages: options.messages.map(message => ({ role: message.role, content: message.content })),
    ...(options.metadata
      ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify(options.metadata) } }
      : {}),
  }, new Headers(options.headers ?? {}));
  const parsed = parseRequest(translated.body);
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

describe("issue #307 — the chat-completions surface honours the identity the service already understands", () => {
  test("two requests carrying the same native dsh_session_id land in ONE conversation", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    const first = await runTurn(target, nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-a" },
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    // The caller resends its growing history; the session owns the provider conversation, so the
    // projection transmits only the newest user message (same rule as `/v1/responses`).
    const second = await runTurn(target, nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-a" },
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "assistant", content: "respuesta uno" },
        { role: "user", content: "pregunta dos" },
      ],
    }));

    expect(errors(first)).toEqual([]);
    expect(errors(second)).toEqual([]);
    expect(finalText(first)).toBe("uno");
    expect(finalText(second)).toBe("dos");

    // ONE conversation for ONE session: the same resolved identity, one physical provider
    // conversation, and the second turn a true continuation (the new human turn only).
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[0]!.prompt).toContain(INSTALL_HEADER);
    expect(surface.runs[1]!.prompt).toBe("pregunta dos");

    // The identity travelled as request metadata: it never becomes provider-visible text.
    for (const run of surface.runs) {
      expect(run.prompt).not.toContain("harness-session-307-a");
      expect(run.prompt).not.toContain("dsh_session_id");
    }
  });

  test("two DIFFERENT native dsh_session_ids stay separate even with identical content", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    // Byte-identical messages: content alone cannot tell these two callers apart, so this is exactly
    // the case the content-derived rule fuses and a session identity must separate.
    const messages = [{ role: "user", content: "hola" }] as const;
    await runTurn(target, nativeApiTurn({ metadata: { dsh_session_id: "harness-session-307-a" }, messages }));
    await runTurn(target, nativeApiTurn({ metadata: { dsh_session_id: "harness-session-307-b" }, messages }));

    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).not.toBe(surface.runs[0]!.turn.conversationKey);
    // A second identity opens its own conversation and never continues the first one's thread.
    expect(surface.runs[0]!.prompt).toContain(INSTALL_HEADER);
    expect(surface.runs[1]!.prompt).toContain(INSTALL_HEADER);
  });

  test("body.user still works, the native session outranks it, and neither becomes message text", () => {
    const messages = [{ role: "user" as const, content: "hola" }];

    // The OpenAI-compatible spelling keeps working exactly as before.
    const byUser = translateChatCompletionsRequest({
      model: LUNA,
      user: "openai-style-307",
      messages: [...messages],
    });
    expect(nativeTurnMetadataFromBody(byUser.body)).toEqual({ thread_id: "openai-style-307" });
    expect(byUser.mode).toBe("session");

    // A caller that states both: the canonical session identity wins, and the surface's resolved
    // identity agrees with it (the precedence the native path already applies).
    const bySession = translateChatCompletionsRequest({
      model: LUNA,
      user: "openai-style-307",
      messages: [...messages],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          dsh_session_id: "native-session-307",
          thread_id: "native-thread-307",
        }),
      },
    });
    expect(bySession.conversationIdentity).toBe("native-session-307");
    const parsedBySession = parseRequest(bySession.body);
    expect(extractChatGptTurnIdentity(parsedBySession)).toMatchObject({
      dshSessionId: "native-session-307",
      threadId: "native-session-307",
    });

    // A caller that states only its own provider-private thread keeps it verbatim.
    const byThread = translateChatCompletionsRequest({
      model: LUNA,
      messages: [...messages],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "caller-thread-307" }) },
    });
    expect(byThread.conversationIdentity).toBe("caller-thread-307");

    // The identity is request metadata, never content: nothing the model could read carries it.
    const history = JSON.stringify(bySession.body);
    expect(history).toContain("native-session-307"); // metadata (the turn's channel)...
    expect(JSON.stringify((bySession.body.input as unknown[]))).not.toContain("native-session-307");
  });
});

describe("issue #307 — an auxiliary purpose is answered, but claims no provider conversation", () => {
  test("a purpose-marked call answers, creates no conversation, retains no surface and disturbs nothing", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "un titulo" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    // The session's own first turn: it installs its conversation, as it always did.
    const human = await runTurn(target, nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-human" },
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    expect(errors(human)).toEqual([]);
    const humanRun = surface.runs[0]!;
    expect(humanRun.prompt).toContain(INSTALL_HEADER);

    // The harness housekeeping call: same session identity, a declared auxiliary purpose. It carries
    // no `user`/`session_id`, exactly like the harness's standalone auxiliary request.
    const titleRequest = nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-human", purpose: "session-title" },
      messages: [{ role: "user", content: "pregunta uno" }],
    });
    const title = await runTurn(target, titleRequest);

    // (1) It gets its answer: an ephemeral turn is executed, never refused.
    expect(errors(title)).toEqual([]);
    expect(title.some(event => event.type === "done")).toBe(true);
    expect(finalText(title)).toBe("un titulo");

    // (2) NO provider conversation is created for it, and none of the session's is claimed: the
    //     retention decision is the single owner of that guarantee, and the turn the transport ran
    //     carries no conversation key at all (there is nothing for a later turn to resolve to).
    expect(shouldRetainChatGptWebConversation(titleRequest, { localTools: false })).toBe(false);
    const titleRun = surface.runs[1]!;
    expect(titleRun.turn.conversationKey).toBeUndefined();
    expect(humanRun.turn.conversationKey).toBeDefined();

    // (3) It leaves NO retained surface: after it, the session's own conversation is still the one a
    //     later turn resumes, and that turn is a true continuation (delta only, no re-install).
    const after = await runTurn(target, nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-human" },
      messages: [{ role: "user", content: "pregunta dos" }],
    }));
    expect(errors(after)).toEqual([]);
    expect(finalText(after)).toBe("dos");
    expect(surface.runs).toHaveLength(3);
    expect(surface.runs[2]!.turn.conversationKey).toBe(humanRun.turn.conversationKey);
    expect(surface.runs[2]!.prompt).toBe("pregunta dos");
    // The housekeeping call's own content never re-entered the session's conversation.
    expect(surface.runs[2]!.prompt).not.toContain("un titulo");
  });

  test("housekeeping work is content-stable, and the same round is never executed twice", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "un titulo" });
    const target = adapter(surface);

    const title = nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-titles", purpose: "session-title" },
      messages: [{ role: "user", content: "pregunta uno" }],
    });

    await runTurn(target, title);
    // The SAME turn again — a retry of one round, which the provider answers from its own round journal
    // instead of opening a second provider surface.
    const repeated = await runTurn(target, title);

    expect(surface.runs).toHaveLength(1);
    expect(errors(repeated)).toEqual([]);
    expect(finalText(repeated)).toBe("un titulo");
    expect(shouldRetainChatGptWebConversation(title, { localTools: false })).toBe(false);

    // The housekeeping conversation is content-derived and session-independent: a declared purpose
    // resolves to no caller identity even when the caller also sent the session id, so nothing about it
    // is addressable as — or a fork of — the session's own chat.
    const otherSession = nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-other", purpose: "session-title" },
      messages: [{ role: "user", content: "pregunta uno" }],
    });
    expect(extractChatGptTurnIdentity(title).threadId).toMatch(/^dsh-chat-[0-9a-f]{16}$/);
    expect(extractChatGptTurnIdentity(otherSession).threadId).toBe(extractChatGptTurnIdentity(title).threadId);
    expect(extractChatGptTurnIdentity(title).dshSessionId).toBeUndefined();
    expect(shouldRetainChatGptWebConversation(otherSession, { localTools: false })).toBe(false);

    // And the session itself is still reachable as its own conversation: a title call for another
    // session never becomes an address this one resolves to.
    const session = nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-titles" },
      messages: [{ role: "user", content: "pregunta uno" }],
    });
    expect(extractChatGptTurnIdentity(session).threadId).toBe("harness-session-307-titles");
    expect(shouldRetainChatGptWebConversation(session, { localTools: false })).toBe(true);
  });

  test("the classification is the core's, and it is the caller's declaration — never an inference", () => {
    // The provider-neutral contract (one owner for "what makes a turn ephemeral").
    expect(webChatTurnDeliveryFor("session-title")).toBe("ephemeral");
    expect(webChatTurnDeliveryFor("compaction")).toBe("ephemeral");
    expect(webChatTurnDeliveryFor(undefined)).toBe("conversational");
    expect(webChatTurnDeliveryFor("")).toBe("conversational");
    expect(webChatTurnDeliveryFor("   ")).toBe("conversational");
    // An unknown purpose is housekeeping too: attaching unrecognized auxiliary work to the user's chat
    // is the damaging outcome, while merely not retaining it costs provider work.
    expect(isEphemeralWebChatTurn("some-future-purpose")).toBe(true);

    // A purpose is read from the caller's metadata, never guessed from anything else.
    expect(resolveNativeTurnIdentity(undefined, "caller-session")).toEqual({ threadId: "caller-session" });
    expect(resolveNativeTurnIdentity({ purpose: "session-title" }, "caller-session")).toEqual({
      purpose: "session-title",
    });
    expect(resolveNativeTurnIdentity({ dsh_session_id: "native-session" }, "caller-session")).toEqual({
      dshSessionId: "native-session",
      threadId: "native-session",
    });
  });
});

describe("issue #307 — a declared OpenAI-wire identity and purpose are read, never guessed", () => {
  test("the body's prompt_cache_key is one conversation per value, never one per content", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    surface.enqueue({ answer: "tres" });
    const target = adapter(surface);

    const first = await runTurn(target, channelApiTurn({
      promptCacheKey: "pi-ai-session-307-a",
      messages: [{ role: "user", content: "alfa" }],
    }));
    // The SAME declared key with different content: the declaration owns the conversation, so this is
    // a continuation (delta only) rather than the fork the content-derived rule would produce.
    const second = await runTurn(target, channelApiTurn({
      promptCacheKey: "pi-ai-session-307-a",
      messages: [
        { role: "user", content: "alfa" },
        { role: "assistant", content: "uno" },
        { role: "user", content: "beta" },
      ],
    }));
    // A DIFFERENT key with content byte-identical to the second turn: content alone cannot separate
    // these two callers, and the declared key must.
    const other = await runTurn(target, channelApiTurn({
      promptCacheKey: "pi-ai-session-307-b",
      messages: [
        { role: "user", content: "alfa" },
        { role: "assistant", content: "uno" },
        { role: "user", content: "beta" },
      ],
    }));

    expect(errors(first)).toEqual([]);
    expect(errors(second)).toEqual([]);
    expect(errors(other)).toEqual([]);
    expect(finalText(first)).toBe("uno");
    expect(finalText(second)).toBe("dos");
    expect(finalText(other)).toBe("tres");

    expect(surface.runs).toHaveLength(3);
    expect(surface.runs[1]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[2]!.turn.conversationKey).not.toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[0]!.prompt).toContain(INSTALL_HEADER);
    expect(surface.runs[1]!.prompt).toBe("beta");
    expect(surface.runs[2]!.prompt).toContain(INSTALL_HEADER);
    // The declared key is request identity, never text the model could read.
    for (const run of surface.runs) {
      expect(run.prompt).not.toContain("pi-ai-session-307");
    }
  });

  test("the session-affinity headers name the same conversation in pi-ai's own spellings", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    surface.enqueue({ answer: "tres" });
    const target = adapter(surface);

    const byAffinity = await runTurn(target, channelApiTurn({
      headers: { "x-session-affinity": "header-session-307" },
      messages: [{ role: "user", content: "alfa" }],
    }));
    // The same declaration in pi-ai's other spelling is the SAME conversation, not a second one.
    const bySessionId = await runTurn(target, channelApiTurn({
      headers: { session_id: "header-session-307" },
      messages: [
        { role: "user", content: "alfa" },
        { role: "assistant", content: "uno" },
        { role: "user", content: "beta" },
      ],
    }));
    // A third spelling and a different value: its own conversation, even with identical content.
    const bySessionIdHeader = await runTurn(target, channelApiTurn({
      headers: { "x-session-id": "header-session-307-other" },
      messages: [{ role: "user", content: "beta" }],
    }));

    expect(errors(byAffinity)).toEqual([]);
    expect(errors(bySessionId)).toEqual([]);
    expect(errors(bySessionIdHeader)).toEqual([]);
    expect(finalText(byAffinity)).toBe("uno");
    expect(finalText(bySessionId)).toBe("dos");
    expect(finalText(bySessionIdHeader)).toBe("tres");

    expect(surface.runs).toHaveLength(3);
    expect(surface.runs[1]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[1]!.prompt).toBe("beta");
    expect(surface.runs[2]!.turn.conversationKey).not.toBe(surface.runs[0]!.turn.conversationKey);
    expect(surface.runs[2]!.prompt).toContain(INSTALL_HEADER);
    for (const run of surface.runs) {
      expect(run.prompt).not.toContain("header-session-307");
    }
  });

  test("a purpose on the auxiliary route's static header classifies the turn ephemeral", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "un titulo" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    // The session's own first turn, declaring its identity only on the wire header pi-ai emits.
    const human = await runTurn(target, channelApiTurn({
      headers: { "x-session-affinity": "aux-route-307-human" },
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    expect(errors(human)).toEqual([]);
    const humanRun = surface.runs[0]!;
    expect(humanRun.prompt).toContain(INSTALL_HEADER);

    // The harness housekeeping call: the SAME wire session, routed at the profile whose static header
    // declares `session-title`, carrying no native metadata at all (the harness drops `purpose` before
    // an OpenAI-compatible wire, so the route header is the declaration that survives).
    const titleRequest = channelApiTurn({
      headers: { "x-session-affinity": "aux-route-307-human", "x-dsh-turn-purpose": "session-title" },
      messages: [{ role: "user", content: "pregunta uno" }],
    });
    expect(extractChatGptTurnIdentity(titleRequest).purpose).toBe("session-title");
    expect(isEphemeralWebChatTurn(extractChatGptTurnIdentity(titleRequest).purpose)).toBe(true);
    expect(shouldRetainChatGptWebConversation(titleRequest, { localTools: false })).toBe(false);

    const title = await runTurn(target, titleRequest);
    // It is answered, and it claims no provider conversation at all.
    expect(errors(title)).toEqual([]);
    expect(finalText(title)).toBe("un titulo");
    expect(surface.runs[1]!.turn.conversationKey).toBeUndefined();

    // A declaration, never an inference: the byte-identical body without the header is the session's
    // own conversational turn, with the same wire session identity.
    const undeclared = channelApiTurn({
      headers: { "x-session-affinity": "aux-route-307-human" },
      messages: [{ role: "user", content: "pregunta uno" }],
    });
    expect(extractChatGptTurnIdentity(undeclared).purpose).toBeUndefined();
    expect(shouldRetainChatGptWebConversation(undeclared, { localTools: false })).toBe(true);

    // The session's own conversation is untouched and is still what the next turn resumes.
    const after = await runTurn(target, channelApiTurn({
      headers: { "x-session-affinity": "aux-route-307-human" },
      messages: [{ role: "user", content: "pregunta dos" }],
    }));
    expect(errors(after)).toEqual([]);
    expect(finalText(after)).toBe("dos");
    expect(surface.runs).toHaveLength(3);
    expect(surface.runs[2]!.turn.conversationKey).toBe(humanRun.turn.conversationKey);
    expect(surface.runs[2]!.prompt).toBe("pregunta dos");
    expect(surface.runs[2]!.prompt).not.toContain("un titulo");
  });

  test("an explicit native identity outranks both declared wire channels", () => {
    const messages = [{ role: "user" as const, content: "hola" }];

    // A caller that states a native session AND both declared channels: the native identity wins, and
    // the turn is still addressed by it.
    expect(extractChatGptTurnIdentity(channelApiTurn({
      metadata: { dsh_session_id: "native-307" },
      promptCacheKey: "cache-307",
      headers: { "x-session-affinity": "affinity-307" },
      messages,
    }))).toMatchObject({ dshSessionId: "native-307", threadId: "native-307" });

    // OpenAI's own `user` spelling outranks the declared channels too.
    expect(extractChatGptTurnIdentity(channelApiTurn({
      user: "openai-user-307",
      promptCacheKey: "cache-307",
      headers: { "x-session-affinity": "affinity-307" },
      messages,
    })).threadId).toBe("openai-user-307");

    // The body channel outranks the header channel, and a blank value is absence, not an identity.
    expect(extractChatGptTurnIdentity(channelApiTurn({
      promptCacheKey: "cache-307",
      headers: { "x-session-affinity": "affinity-307" },
      messages,
    })).threadId).toBe("cache-307");
    expect(extractChatGptTurnIdentity(channelApiTurn({
      promptCacheKey: "   ",
      headers: { "x-session-affinity": "affinity-307" },
      messages,
    })).threadId).toBe("affinity-307");

    // A native purpose outranks a route header's declaration of the same axis.
    expect(extractChatGptTurnIdentity(channelApiTurn({
      metadata: { dsh_session_id: "native-307", purpose: "session-title" },
      headers: { "x-dsh-turn-purpose": "compaction" },
      messages,
    })).purpose).toBe("session-title");

    // The precedence itself, at its one owner, with no surface in the way.
    expect(resolveNativeTurnIdentity(undefined, undefined, undefined, { promptCacheKey: "cache" }))
      .toEqual({ threadId: "cache" });
    expect(resolveNativeTurnIdentity(undefined, "user", undefined, {
      promptCacheKey: "cache",
      headers: new Headers({ session_id: "affinity" }),
    })).toEqual({ threadId: "user" });
    expect(resolveNativeTurnIdentity(undefined, undefined, undefined, {
      headers: new Headers({ "x-session-affinity": "affinity" }),
    })).toEqual({ threadId: "affinity" });
    expect(resolveNativeTurnIdentity(undefined, undefined, undefined, {
      headers: new Headers({ "x-session-affinity": "affinity", "x-dsh-turn-purpose": "session-title" }),
    })).toEqual({ purpose: "session-title" });
    // A hand-derived surface fallback still applies when the caller declared nothing at all.
    expect(resolveNativeTurnIdentity(undefined, undefined, "content-derived")).toEqual({ threadId: "content-derived" });
  });

  test("the real listener hands both declared wire channels to the adapter's one reader", async () => {
    const seen: Array<{
      identity: ReturnType<typeof extractChatGptTurnIdentity>;
      retained: boolean;
    }> = [];
    const server = startServer(
      {
        ...defaultConfig(),
        port: 0,
        host: "127.0.0.1",
        controlToken: "issue-307-listener-control-token-0123456789",
        webChat: { conversationStorePath: join(home, "conversations.json") },
      },
      {
        adapterFactory: () => ({
          name: "issue-307-wire-stub",
          runTurn: async (
            parsed: CodexParsedRequest,
            _incoming: unknown,
            emit: (event: AdapterEvent) => void,
          ) => {
            seen.push({
              identity: extractChatGptTurnIdentity(parsed),
              retained: shouldRetainChatGptWebConversation(parsed, { localTools: false }),
            });
            emit({ type: "text_delta", text: "ok", phase: "final_answer" });
          },
        }),
      } as never,
    );
    listeners.push(server);

    const post = async (body: Record<string, unknown>, headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    // A conversational turn declaring its identity only on the wire channels.
    const conversational = await post(
      { model: LUNA, messages: [{ role: "user", content: "hola" }], prompt_cache_key: "listener-cache-307" },
      { "x-session-affinity": "listener-header-307" },
    );
    // The housekeeping turn: its route declares the purpose with a static header.
    const housekeeping = await post(
      { model: LUNA, messages: [{ role: "user", content: "hola" }] },
      { "x-session-affinity": "listener-header-307", "x-dsh-turn-purpose": "session-title" },
    );

    expect(conversational.status).toBe(200);
    expect(housekeeping.status).toBe(200);
    expect(seen).toHaveLength(2);
    // The body channel won over the header channel, the declared purpose classified the second turn
    // ephemeral, and both reached the adapter through the listener rather than a content hash.
    expect(seen[0]!.identity).toMatchObject({ threadId: "listener-cache-307" });
    expect(seen[0]!.identity.threadId).not.toMatch(/^dsh-chat-/);
    expect(seen[0]!.retained).toBe(true);
    expect(seen[1]!.identity).toMatchObject({ purpose: "session-title" });
    // The ephemeral turn carries no caller identity: only the content-derived surface the provider
    // answers on, which no later turn can resolve to.
    expect(seen[1]!.identity.dshSessionId).toBeUndefined();
    expect(seen[1]!.identity.threadId).toMatch(/^dsh-chat-[0-9a-f]{16}$/);
    expect(seen[1]!.retained).toBe(false);
  });
});

/**
 * The runtime-context snapshot the harness appends as its own trailing `user` message (the time
 * plugin's rendered text, verbatim). It is host context only: `sanitizeConversationText` strips every
 * line of it, so it carries no human content at all.
 *
 * This is the shape that broke once the caller's identity started arriving: a session-addressed turn
 * transmits only "the user message this request is asking", and picking that message by **role alone**
 * picks the snapshot — an empty turn the install compiler must refuse.
 */
const TIME_CONTEXT_SNAPSHOT = [
  "Time sampled while preparing turn 1, step 1: 2026-10-18T12:17:11+02:00[Europe/Madrid]",
  "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.",
  "Elapsed since the preceding model-visible message: unavailable.",
].join("\n");

describe("issue #307 — an identity must not detach the human turn from its runtime snapshot", () => {
  test("a session-addressed turn ending in the runtime snapshot installs the human message", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    const turn = await runTurn(target, channelApiTurn({
      promptCacheKey: "snapshot-307-a",
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "user", content: TIME_CONTEXT_SNAPSHOT },
      ],
    }));

    // The human turn is answered: the runtime snapshot is not a turn and must never replace one.
    expect(errors(turn)).toEqual([]);
    expect(finalText(turn)).toBe("uno");
    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]!.prompt).toContain(INSTALL_HEADER);
    expect(surface.runs[0]!.prompt).toContain("pregunta uno");
    // Host context still never reaches the provider.
    expect(surface.runs[0]!.prompt).not.toContain("Time sampled while preparing turn");

    // The next turn of the same session continues the conversation the first turn installed.
    const next = await runTurn(target, channelApiTurn({
      promptCacheKey: "snapshot-307-a",
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "assistant", content: "uno" },
        { role: "user", content: "pregunta dos" },
        { role: "user", content: TIME_CONTEXT_SNAPSHOT },
      ],
    }));
    expect(errors(next)).toEqual([]);
    expect(finalText(next)).toBe("dos");
    expect(surface.runs[1]!.prompt).toBe("pregunta dos");
  });

  test("a replacement-epoch install still carries the human message, not the trailing snapshot", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    // The session's first turn installs generation 1.
    const first = await runTurn(target, channelApiTurn({
      promptCacheKey: "snapshot-307-b",
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    expect(errors(first)).toEqual([]);
    const conversationKey = surface.runs[0]!.turn.conversationKey;
    expect(conversationKey).toBeDefined();

    // A replay/replacement epoch (the production log's "the current generation is 2"): the prefix has
    // no fingerprint in the new generation, so the retained conversation installs again — from a
    // request that ends with the runtime snapshot.
    chatGptTurnSessions.setConversationGeneration(conversationKey!, 2);
    const reinstalled = await runTurn(target, channelApiTurn({
      promptCacheKey: "snapshot-307-b",
      messages: [
        { role: "user", content: "pregunta dos" },
        { role: "user", content: TIME_CONTEXT_SNAPSHOT },
      ],
    }));

    expect(errors(reinstalled)).toEqual([]);
    expect(finalText(reinstalled)).toBe("dos");
    expect(surface.runs[1]!.turn.conversationKey).toBe(conversationKey);
    expect(surface.runs[1]!.prompt).toContain("pregunta dos");
    expect(surface.runs[1]!.prompt).not.toContain("Time sampled while preparing turn");
  });

  test("the same payload without an identity keeps working, and the snapshot is never a turn", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    const target = adapter(surface);

    const stateless = await runTurn(target, plainApiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "user", content: TIME_CONTEXT_SNAPSHOT },
    ]));
    expect(errors(stateless)).toEqual([]);
    expect(finalText(stateless)).toBe("uno");
    expect(surface.runs[0]!.prompt).toContain("pregunta uno");
    expect(surface.runs[0]!.prompt).not.toContain("Time sampled while preparing turn");
  });

  test("a session-addressed request with no human content is refused at the surface, not by the installer", () => {
    // Failing closed stays, but it fails where the caller can act on it: the surface refuses the
    // request before any provider work, with a typed code and a message that names the rule — never
    // the installer's "must carry a human message", which the caller can only read as an internal
    // defect.
    let refusal: unknown;
    try {
      translateChatCompletionsRequest({
        model: LUNA,
        prompt_cache_key: "snapshot-307-c",
        messages: [{ role: "user", content: TIME_CONTEXT_SNAPSHOT }],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ChatCompletionsRequestError);
    expect((refusal as ChatCompletionsRequestError).code).toBe(API_PROJECTION_HOST_CONTEXT_ONLY_CODE);
    expect((refusal as Error).message).toMatch(/only host context/);
    expect((refusal as Error).message).not.toMatch(/must carry a human message/);
    // The distinct case is not folded into it: a request with no user message at all keeps its own code.
    let noUserMessage: unknown;
    try {
      translateChatCompletionsRequest({
        model: LUNA,
        prompt_cache_key: "snapshot-307-c",
        messages: [{ role: "system", content: "harness instructions" }],
      });
    } catch (error) {
      noUserMessage = error;
    }
    expect((noUserMessage as ChatCompletionsRequestError).code).toBe(API_PROJECTION_NO_USER_MESSAGE_CODE);

    // And the snapshot is not rescued by role alone: the same request *with* the human message is the
    // one that gets answered (proven above), so the refusal is about content, not about the snapshot's
    // presence.
    const human = translateChatCompletionsRequest({
      model: LUNA,
      prompt_cache_key: "snapshot-307-c",
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "user", content: TIME_CONTEXT_SNAPSHOT },
      ],
    });
    expect(human.mode).toBe("session");
    expect(JSON.stringify(human.body.input)).toContain("pregunta uno");
    expect(JSON.stringify(human.body.input)).not.toContain("Time sampled while preparing turn");
  });

  test("the auxiliary route stays safe with the same snapshot: answered, retained nowhere", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "un titulo" });
    surface.enqueue({ answer: "dos" });
    const target = adapter(surface);

    const human = await runTurn(target, channelApiTurn({
      headers: { "x-session-affinity": "snapshot-307-aux" },
      messages: [{ role: "user", content: "pregunta uno" }],
    }));
    expect(errors(human)).toEqual([]);
    const humanRun = surface.runs[0]!;
    expect(humanRun.prompt).toContain(INSTALL_HEADER);

    // The housekeeping call on the auxiliary route: the same wire session, the route's static purpose
    // header, and the harness's runtime snapshot appended after the human message.
    const titleRequest = channelApiTurn({
      headers: { "x-session-affinity": "snapshot-307-aux", "x-dsh-turn-purpose": "session-title" },
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "user", content: TIME_CONTEXT_SNAPSHOT },
      ],
    });
    const title = await runTurn(target, titleRequest);

    expect(errors(title)).toEqual([]);
    expect(finalText(title)).toBe("un titulo");
    expect(shouldRetainChatGptWebConversation(titleRequest, { localTools: false })).toBe(false);
    expect(surface.runs[1]!.turn.conversationKey).toBeUndefined();
    // A turn with no conversation to continue compiles through the envelope transport, so its human
    // message travels inside that context; what this test owns is that the turn is answered, claims
    // nothing and leaves the session's own chat intact.
    expect(surface.runs[1]!.prompt).toContain("pregunta uno");

    // The session's own conversation is untouched: the next turn is a true continuation.
    const after = await runTurn(target, channelApiTurn({
      headers: { "x-session-affinity": "snapshot-307-aux" },
      messages: [{ role: "user", content: "pregunta dos" }],
    }));
    expect(errors(after)).toEqual([]);
    expect(finalText(after)).toBe("dos");
    expect(surface.runs[2]!.turn.conversationKey).toBe(humanRun.turn.conversationKey);
    expect(surface.runs[2]!.prompt).toBe("pregunta dos");
  });

  test("the Responses surface still refuses a human-less install: the refusals are not weakened", async () => {
    // This surface has no message projection to select a turn (its caller sends no session identity
    // there), so a request whose only content is host context still reaches the install compiler —
    // which is exactly the invariant the projection fix must not have deleted. Nothing is submitted.
    const surface = new ControlledSurface();
    const target = adapter(surface);
    const parsed = parseRequest({
      model: LUNA,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: TIME_CONTEXT_SNAPSHOT }],
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ dsh_session_id: "snapshot-307-responses" }),
      },
    });
    routeChatGptWebRequest(parsed, defaultConfig());

    await expect(runTurn(target, parsed)).rejects.toThrow(/must carry a human message/);
    expect(surface.runs).toHaveLength(0);
  });
});

describe("issue #307 — a caller that sends nothing keeps today's content-derived behaviour", () => {
  test("identical content is one conversation, different content is isolated, nothing is retained twice", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    surface.enqueue({ answer: "uno otra vez" });
    const target = adapter(surface);

    await runTurn(target, plainApiTurn([{ role: "user", content: "alpha" }]));
    await runTurn(target, plainApiTurn([{ role: "user", content: "beta" }]));
    // A resending client, or a retry it chose to make: identical content keeps ONE conversation, so the
    // documented limit stays documented behaviour rather than a per-request fork.
    await runTurn(target, plainApiTurn([{ role: "user", content: "alpha" }]));

    expect(surface.runs).toHaveLength(3);
    expect(surface.runs[0]!.turn.conversationKey).not.toBe(surface.runs[1]!.turn.conversationKey);
    expect(surface.runs[2]!.turn.conversationKey).toBe(surface.runs[0]!.turn.conversationKey);
    // Nothing about this branch became ephemeral: with no declared purpose the turn is the caller's.
    for (const turn of [plainApiTurn([{ role: "user", content: "alpha" }])]) {
      expect(shouldRetainChatGptWebConversation(turn, { localTools: false })).toBe(true);
    }

    // THE REMAINING GAP, asserted instead of assumed: with no identity at all, a session whose turns
    // carry different content still becomes several provider conversations — one per distinct content.
    // This change cannot fix that; the harness has to send the identity (see the issue).
    const perSession = nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-gap" },
      messages: [{ role: "user", content: "alpha" }],
    });
    const perSessionNext = nativeApiTurn({
      metadata: { dsh_session_id: "harness-session-307-gap" },
      messages: [{ role: "user", content: "beta" }],
    });
    expect(extractChatGptTurnIdentity(perSessionNext).threadId).toBe(extractChatGptTurnIdentity(perSession).threadId);
    expect(extractChatGptTurnIdentity(plainApiTurn([{ role: "user", content: "beta" }])).threadId)
      .toMatch(/^dsh-chat-[0-9a-f]{16}$/);
  });
});

/**
 * The owner's decision (A), driven through the **real HTTP route** a `/v1/chat/completions` caller
 * takes: the listener, the OpenAI translation, the shared Responses parser, the catalogue route and
 * the real adapter, with only the browser I/O replaced by a controlled surface.
 *
 * A session-addressed turn whose only human content is the harness's runtime-context snapshot must not
 * be sent at all. It is refused up front — at the surface, before the turn exists — with the
 * projection's own typed code, so nothing reaches the browser and nothing is written: the durable
 * store stays byte-identical, the conversation's generation does not move, and the next real turn
 * still continues the same conversation instead of finding it poisoned.
 */
function serveControlled(surface: ControlledSurface): RunningServer {
  const server = startServer(
    {
      ...defaultConfig(),
      port: 0,
      host: "127.0.0.1",
      controlToken: "issue-307-host-context-control-token-0123456789",
      webChat: { conversationStorePath: join(home, "conversations.json") },
    },
    {
      adapterFactory: (_provider: unknown, providerCore: ChatGptWebProviderCore) => createChatGptWebAdapter(
        controlledProviderConfig(home),
        { providerCore, surfaceTransport: surface.transport },
      ),
    } as never,
  );
  listeners.push(server);
  return server;
}

interface ChatHttpResult {
  readonly status: number;
  readonly body: {
    readonly error?: { readonly message?: string; readonly type?: string; readonly code?: string };
  };
}

async function postChat(server: RunningServer, body: Record<string, unknown>): Promise<ChatHttpResult> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as ChatHttpResult["body"];
  return { status: response.status, body: payload };
}

describe("issue #307 — a session turn that carries only host context is refused before it exists", () => {
  test("the refusal is typed and write-free, and the next real turn still continues the conversation", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    surface.enqueue({ answer: "dos" });
    const server = serveControlled(surface);
    const store = resolveNativeChatGptContinuityStore();
    const file = join(home, "conversations.json");

    // The session's own first turn: it installs the conversation and writes its durable continuity
    // record, which is the state the refusal below must leave untouched.
    const first = await postChat(server, {
      model: LUNA,
      prompt_cache_key: "snapshot-307-refusal",
      messages: [{ role: "user", content: "pregunta uno" }],
    });
    expect(first.status).toBe(200);
    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]!.prompt).toContain(INSTALL_HEADER);
    const conversationKey = surface.runs[0]!.turn.conversationKey!;
    expect(conversationKey).toBeDefined();

    const beforeBytes = readFileSync(file, "utf8");
    const beforeRecords = await store.list();
    const generationBefore = chatGptTurnSessions.conversationGeneration(conversationKey);

    // The harness's runtime-context snapshot alone, session-addressed on the same conversation. The
    // product's one owner of "what is host context" empties it, so this turn has no human content and
    // must not be sent at all.
    const refused = await postChat(server, {
      model: LUNA,
      prompt_cache_key: "snapshot-307-refusal",
      messages: [{ role: "user", content: TIME_CONTEXT_SNAPSHOT }],
    });

    // Typed and actionable, in caller terms — never the installer's "must carry a human message".
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe(API_PROJECTION_HOST_CONTEXT_ONLY_CODE);
    expect(refused.body.error?.type).toBe("invalid_request_error");
    expect(refused.body.error?.message).toMatch(/only host context/);
    expect(refused.body.error?.message).toMatch(/`user` message/);
    expect(refused.body.error?.message).not.toMatch(/must carry a human message/);

    // Nothing reached the browser: the refused request ran no provider turn.
    expect(surface.runs).toHaveLength(1);
    // Nothing was written, and nothing that a later turn could read as "the last attempt was never
    // confirmed" was left behind: the durable store is byte-identical, its records are unchanged, and
    // the conversation's generation did not move.
    expect(readFileSync(file, "utf8")).toBe(beforeBytes);
    expect(await store.list()).toEqual(beforeRecords);
    expect(chatGptTurnSessions.conversationGeneration(conversationKey)).toBe(generationBefore);

    // The next real turn still continues the same conversation: same provider conversation, and a true
    // delta (a fork or a re-install would send the header again).
    const after = await postChat(server, {
      model: LUNA,
      prompt_cache_key: "snapshot-307-refusal",
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "assistant", content: "uno" },
        { role: "user", content: "pregunta dos" },
      ],
    });
    expect(after.status).toBe(200);
    expect(surface.runs).toHaveLength(2);
    expect(surface.runs[1]!.turn.conversationKey).toBe(conversationKey);
    expect(surface.runs[1]!.prompt).toBe("pregunta dos");
    expect(surface.runs[1]!.prompt).not.toContain(INSTALL_HEADER);
  });

  test("the snapshot plus a real human message still travels: the human message is sent, the snapshot is not", async () => {
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "uno" });
    const server = serveControlled(surface);

    const answered = await postChat(server, {
      model: LUNA,
      prompt_cache_key: "snapshot-307-refusal-human",
      messages: [
        { role: "user", content: "pregunta uno" },
        { role: "user", content: TIME_CONTEXT_SNAPSHOT },
      ],
    });

    // Existing behaviour preserved: the presence of host context beside a real turn changes nothing.
    expect(answered.status).toBe(200);
    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]!.prompt).toContain("pregunta uno");
    expect(surface.runs[0]!.prompt).not.toContain("Time sampled while preparing turn");
  });

  test("a stateless turn (no identity) with only host context is unchanged: sent to the compiler, which refuses it", async () => {
    // Stated plainly because it is deliberately NOT part of this decision: with no identity the request
    // is stateless by design, the projection transmits the whole conversation (the structural rule's
    // documented limit), and host context still never reaches the provider because the install compiler
    // refuses a human-less install. That path is unchanged here.
    const translated = translateChatCompletionsRequest({
      model: LUNA,
      messages: [{ role: "user", content: TIME_CONTEXT_SNAPSHOT }],
    });
    expect(translated.mode).toBe("stateless");
    expect(JSON.stringify(translated.body.input)).toContain("Time sampled while preparing turn");

    const surface = new ControlledSurface();
    const target = adapter(surface);
    const parsed = parseRequest(translated.body);
    routeChatGptWebRequest(parsed, defaultConfig());
    await expect(runTurn(target, parsed)).rejects.toThrow(/must carry a human message/);
    expect(surface.runs).toHaveLength(0);
  });
});
