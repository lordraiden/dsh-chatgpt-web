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
 * - a stable client session identity is present → transmit **only the current user message**; the
 *   provider conversation is the history, so context injected in earlier turns cannot cross;
 * - no session identity → treat the request as stateless: transmit the client's `user`/`assistant`
 *   messages and **drop every non-conversational role** (`system`, `developer`, `tool`, …).
 *
 * Documented limit, deliberately not papered over: in the stateless mode, context that the harness
 * puts *inside* the current user message still crosses. Removing that would require content
 * heuristics, which are per-harness and per-version and therefore cannot be the primary rule; the
 * API does not pretend otherwise.
 */

/** The roles that carry a conversation. Everything else is harness context (or unknown). */
const CONVERSATIONAL_ROLES = new Set(["user", "assistant"]);

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
 * Apply the message-only rule.
 *
 * @throws {Error} when the projection would leave nothing to say — the caller must turn that into a
 * typed 400 rather than submitting an empty turn.
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
    let lastUser = -1;
    for (let index = conversational.length - 1; index >= 0; index -= 1) {
      if (conversational[index]!.role === "user") { lastUser = index; break; }
    }
    if (lastUser < 0) {
      throw new Error("The request carries no user message; a session-addressed turn needs one.");
    }
    return {
      mode: "session",
      messages: [conversational[lastUser]!],
      droppedRoles,
      droppedTurns: lastUser,
    };
  }

  if (conversational.length === 0 || conversational[conversational.length - 1]!.role !== "user") {
    throw new Error("The request carries no user message; nothing would be sent to the provider.");
  }
  return { mode: "stateless", messages: conversational, droppedRoles, droppedTurns: 0 };
}
