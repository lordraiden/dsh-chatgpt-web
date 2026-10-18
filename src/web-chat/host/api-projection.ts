/**
 * Message-only projection for the public API surface (issue #253).
 *
 * The API transmits **only the conversation's messages**: session context a harness injects at the
 * start of a session — its own instructions, environment blocks, file trees, timestamps — must not
 * become part of the provider turn.
 *
 * Why this is a separate owner from `src/conversation-sanitizer.ts`: that one strips host-injected
 * transport text out of a single piece of text, but it has no notion of message provenance — a
 * generic API client carries no `source.kind`, so text-level sanitization alone cannot decide which
 * messages are the conversation. This owner decides by message role and client session identity
 * instead, and deliberately keeps no second copy of the transport marker list.
 *
 * The rule is structural, never per-harness (a generic client carries no provenance, so a
 * per-harness rule could not be universal):
 *
 * - a stable client session identity is present → transmit **only the current turn**, expressed as
 *   the newest user message that still carries human content; the provider conversation is the
 *   history, so context injected in earlier turns cannot cross;
 * - no session identity → treat the request as stateless: transmit the client's `user`/`assistant`
 *   messages and **drop every non-conversational role** (`system`, `developer`, `tool`, …).
 *
 * "The newest user message that carries human content", not "the last user message", because a
 * request may express one turn as several user messages: a harness that owns its own clock appends
 * its runtime snapshot as one more `user` message after the human one. Selecting by role alone then
 * transmits the snapshot — a turn with no human content, which the provider's compiler is *required*
 * to refuse (issue #307: the harness's identity arrived, the snapshot became the last user message,
 * and every install after that was refused with "must carry a human message"). Human content is
 * decided by `sanitizeConversationText`, the product's one owner of "what is host context", so this
 * owner agrees with the compiler by construction instead of keeping a second marker list. The
 * messages themselves are transmitted unchanged; the compiler still sanitizes what it sends.
 *
 * When **no** user message carries human content the session branch refuses here, before the turn
 * exists: a session-addressed turn whose only human content is host context must not be sent at all.
 * The refusal is typed and names the rule in caller terms (`ApiProjectionRefusalError`), and it is
 * deliberately two codes, not one, because the two situations need different fixes from the caller:
 *
 * - `host_context_only_turn` — a `user` message was there, but every one of them was host context
 *   (the harness's own runtime snapshot alone). The message tells the caller to phrase a real turn.
 * - `no_user_message` — the request carried no `user` message at all.
 *
 * Both refuse at the same point, before any provider work and before any conversation state is
 * written, so a refused request leaves the durable store byte-identical and cannot poison the
 * conversation a later, real turn continues. Recognition of housekeeping by *text* stays out of this
 * owner: the only notion of host context is `sanitizeConversationText`.
 *
 * Documented limit, deliberately not papered over: in the stateless mode, context that the harness
 * puts *inside* the current user message still crosses. Removing that would require content
 * heuristics, which are per-harness and per-version and therefore cannot be the primary rule; the
 * API does not pretend otherwise.
 *
 * ## Conversation identity (pre-vendor hardening, slices 1 and 2)
 *
 * The projection also decides **which provider conversation the turn belongs to**, because an API
 * caller is not a DSH thread and carries no native turn metadata (see `translateChatCompletionsRequest`,
 * which used to compute the mode and the session id and then drop both):
 *
 * - a stable client session identity (`user` / `session_id`) **is** the conversation identity
 *   (`ApiProjectionResult.conversationIdentity`): every turn of that caller continues its own
 *   conversation and no other caller can address it;
 * - with no identity the identity is derived from the canonical **content** of the messages the
 *   projection transmits (`dsh-chat-<hash>`), never from the request itself. The same content keeps
 *   the same conversation — so a client that resends it keeps continuity and a retry does not fork a
 *   second provider conversation — and different content is isolated.
 *
 * The rule is deliberately content-derived and **never per-request**: minting a fresh identity on each
 * call would fork every turn of a client that resends its history.
 *
 * `contentConversationIdentity` is the **one owner of the content-derived identity**, for every
 * surface. `/v1/chat/completions` reaches it through `projectApiConversation`; the Responses surface
 * cannot (its caller sends no session identity and its parsed turn is the only input the surface
 * translation never sees), so the adapter's metadata-less fallback calls the same function instead of
 * writing a second derivation. One rule, two callers.
 *
 * Documented limit, deliberately not papered over: two callers that send **no identity** and
 * **identical message content** are indistinguishable and share one provider conversation. Nothing in
 * the request can tell them apart, so no content-derived rule can separate them; a caller that must be
 * distinct has to send `user`/`session_id`. Symmetrically, a stateless caller that wants continuity
 * has to resend its history: a one-message request is its own conversation, because the API cannot
 * know that a later, different message belongs to the same client.
 */
import { createHash } from "node:crypto";

import { sanitizeConversationText } from "../../conversation-sanitizer";

/** The roles that carry a conversation. Everything else is harness context (or unknown). */
const CONVERSATIONAL_ROLES = new Set(["user", "assistant"]);

/** Prefix of a content-derived identity, so it can never be mistaken for a caller-chosen one. */
const CONTENT_IDENTITY_PREFIX = "dsh-chat-";
/** Hexadecimal characters of the content digest kept in the identity (64 bits). */
const CONTENT_IDENTITY_HASH_CHARS = 16;

/** Stable refusal code: the request carried no `user` message to answer. */
export const API_PROJECTION_NO_USER_MESSAGE_CODE = "no_user_message";
/** Stable refusal code: the request's `user` messages carried host context only. */
export const API_PROJECTION_HOST_CONTEXT_ONLY_CODE = "host_context_only_turn";

/** The refusals this projection owns; each one is a different fix for the caller. */
export type ApiProjectionRefusalCode =
  | typeof API_PROJECTION_NO_USER_MESSAGE_CODE
  | typeof API_PROJECTION_HOST_CONTEXT_ONLY_CODE;

/**
 * A request this projection cannot turn into a provider turn.
 *
 * It is thrown **before** the turn exists — before any provider work and before any conversation
 * state is written — so the surface can publish a typed `400` that leaves the conversation exactly as
 * it was. The message is written for the caller, not for the installer: it names the rule and what a
 * real turn has to look like.
 */
export class ApiProjectionRefusalError extends Error {
  readonly code: ApiProjectionRefusalCode;

  constructor(code: ApiProjectionRefusalCode, message: string) {
    super(message);
    this.name = "ApiProjectionRefusalError";
    this.code = code;
  }
}

/** Caller-facing message for a request whose only human content was host context. */
const HOST_CONTEXT_ONLY_MESSAGE =
  "The request carried only host context: no `user` message carried human content once the "
  + "host-injected context this service recognizes (runtime snapshots, environment and memory blocks, "
  + "harness transport text) was removed, so there is no turn to send. A session-addressed turn is "
  + "answered from its newest `user` message — send the user's actual instruction as one; the "
  + "harness's own context does not need to be sent.";

/** Caller-facing message for a request with no `user` message at all. */
const NO_USER_MESSAGE_MESSAGE =
  "The request carries no user message; a session-addressed turn is answered from its newest user "
  + "message, so the instruction has to arrive as one.";

/** One message as it arrives on the wire. `content` is already reduced to text by the caller. */
export interface ApiConversationMessage {
  readonly role: string;
  readonly content: string;
}

export interface ApiProjectionInput {
  readonly messages: readonly ApiConversationMessage[];
  /**
   * A stable identity the client chose for this conversation (the OpenAI `user` field, or the
   * `session_id` extension). Absence selects the stateless mode.
   */
  readonly sessionId?: string;
}

export type ApiProjectionMode = "session" | "stateless";

export interface ApiProjectionResult {
  readonly mode: ApiProjectionMode;
  /**
   * The provider conversation this turn belongs to: the caller's own session identity when it sent
   * one, otherwise a content-derived identity (see the module contract). Never per-request.
   */
  readonly conversationIdentity: string;
  /** The messages that may reach the provider, in order. */
  readonly messages: readonly ApiConversationMessage[];
  /** Non-conversational roles that were dropped, for observability and tests. */
  readonly droppedRoles: readonly string[];
  /** Earlier conversational turns dropped because a session identity made them redundant. */
  readonly droppedTurns: number;
}

/** Normalize a client-provided identity; whitespace-only is not an identity. */
export function normalizeApiSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Identity of a caller that sent no identity, derived from the canonical content of the conversation
 * it sent.
 *
 * This is the **one owner** of the content-derived identity rule (see the module contract): the chat
 * surface reaches it through `projectApiConversation`, and the adapter's metadata-less Responses
 * fallback calls it with the turn it is about to run. Callers pass the messages they have; the
 * conversational-role filter lives here too, so no caller can keep a second copy of "what counts as
 * content" and let harness context split or fuse a conversation.
 *
 * Only role and text participate: never a timestamp or any other per-request value. Hashing the
 * parsed messages (which carry a timestamp) would mint a new identity on every call — exactly the
 * per-request fork this rule exists to prevent.
 *
 * ## What this rule really produces, stated plainly (issue #307)
 *
 * This is **isolation, not session continuity**. Because the identity is a function of the content,
 * a caller that sends no identity gets **one provider conversation per distinct content** — which is
 * the correct outcome when nothing in the request can tell two callers apart, and it is why an
 * identity-less caller is never *wrong* — but it is not "one conversation per session". A harness that
 * holds a session identity, sends it nowhere and varies its messages therefore produces a new provider
 * conversation on almost every turn (measured: two harness sessions, nine ChatGPT chats), and no
 * heuristic here can fix that: matching a project header, a timestamp window or a message prefix would
 * be guessing a caller's session from its text, which is exactly the fragile behaviour this module
 * refuses to own.
 *
 * **A sender that wants one conversation per session must send its identity**: `user` / `session_id`
 * on the OpenAI-compatible surface, or the native turn metadata (`dsh_session_id` in
 * `client_metadata["x-codex-turn-metadata"]`, read through `src/web-chat/host/turn-identity.ts`), which
 * every surface of this product now honours.
 */
export function contentConversationIdentity(messages: readonly ApiConversationMessage[]): string {
  const conversational = messages.filter(message => CONVERSATIONAL_ROLES.has(message.role));
  const canonical = JSON.stringify(conversational.map(message => [message.role, message.content]));
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${CONTENT_IDENTITY_PREFIX}${digest.slice(0, CONTENT_IDENTITY_HASH_CHARS)}`;
}

/**
 * Apply the message-only rule.
 *
 * @throws {ApiProjectionRefusalError} when the projection would leave nothing to say — no
 * conversational message at all, or (session mode) no user message that still carries human content.
 * The code tells the two apart, and the caller must turn either into a typed 400 rather than
 * submitting an empty turn. Nothing is written and no provider work is started for a refusal.
 */
export function projectApiConversation(input: ApiProjectionInput): ApiProjectionResult {
  const droppedRoles: string[] = [];
  const conversational: ApiConversationMessage[] = [];
  for (const message of input.messages) {
    if (CONVERSATIONAL_ROLES.has(message.role)) {
      conversational.push(message);
    } else if (!droppedRoles.includes(message.role)) {
      droppedRoles.push(message.role);
    }
  }

  const sessionId = normalizeApiSessionId(input.sessionId);
  if (sessionId !== undefined) {
    // The provider conversation owns the history, so only the turn being asked now is transmitted.
    // That turn is the newest user message that still carries human content — not merely the last
    // message with role `user`, because a harness may append its own runtime snapshot after the human
    // turn. A snapshot-only message is not a turn: transmitting it sends an empty turn, which the
    // provider's compiler must refuse (`currentChatUserMessage`). `sanitizeConversationText` is the
    // one owner of what host context is, so this selection and that compiler agree by construction.
    let current = -1;
    let sawUserMessage = false;
    for (let index = conversational.length - 1; index >= 0; index -= 1) {
      const message = conversational[index]!;
      if (message.role !== "user") continue;
      sawUserMessage = true;
      if (sanitizeConversationText(message.content) !== "") {
        current = index;
        break;
      }
    }
    if (current < 0) {
      // A turn whose only human content is host context must not be sent at all. The two refusals are
      // deliberately distinct: "you sent only the host's own context" and "you sent no user message"
      // are different mistakes, and a caller can only act on the first if it is told which one it made.
      throw sawUserMessage
        ? new ApiProjectionRefusalError(API_PROJECTION_HOST_CONTEXT_ONLY_CODE, HOST_CONTEXT_ONLY_MESSAGE)
        : new ApiProjectionRefusalError(API_PROJECTION_NO_USER_MESSAGE_CODE, NO_USER_MESSAGE_MESSAGE);
    }
    return {
      mode: "session",
      conversationIdentity: sessionId,
      messages: [conversational[current]!],
      droppedRoles,
      droppedTurns: current,
    };
  }

  if (conversational.length === 0 || conversational[conversational.length - 1]!.role !== "user") {
    throw new Error("The request carries no user message; nothing would be sent to the provider.");
  }
  return {
    mode: "stateless",
    conversationIdentity: contentConversationIdentity(conversational),
    messages: conversational,
    droppedRoles,
    droppedTurns: 0,
  };
}
