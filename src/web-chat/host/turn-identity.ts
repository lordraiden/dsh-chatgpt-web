/**
 * Native DSH turn-metadata identity for the **public API surfaces** (issue #307).
 *
 * ## The problem this owner closes
 *
 * The provider's own identity reader (`src/adapters/chatgpt-web/environment.ts`) has always read the
 * caller's identity from `client_metadata["x-codex-turn-metadata"]` — the one channel every native
 * surface uses — but each API surface reached it differently, and only one of them reached it at all:
 *
 * - `/v1/responses` passes the caller's body through, so the adapter reads the metadata itself;
 * - `/v1/chat/completions` reads identity **only** from `body.user` / `body.session_id` and then
 *   **replaces** `client_metadata` with the identity it derived. A caller that sent the native shape
 *   therefore had its `dsh_session_id` and its turn `purpose` **erased** by this surface: the identity
 *   could not reach the turn even when the caller sent it.
 *
 * A caller is not obliged to speak OpenAI's `user` field: the harness that talks to this service holds
 * a DSH session identity, so the shape it can send is the native one. This module is the host's reader
 * for that shape, so the derivation happens **once**, in host terms (`DshNativeTurnContext`), and both
 * surfaces agree instead of the chat surface keeping a second, narrower idea of "identity".
 *
 * It is deliberately not a second identity concept: the metadata keys and the "a session id must be a
 * non-empty string" normalization are the ones this product already applies, and the precedence it
 * applies natively — a session identity outranks a provider-private thread identity — is the
 * precedence used here.
 *
 * ## Precedence
 *
 * The first identity that exists wins:
 *
 * 1. `dsh_session_id` from the native metadata (the harness-native channel; the session is the
 *    stronger identity, exactly as the native affinity derivation already treats it);
 * 2. `thread_id` from the native metadata (the caller's own provider-private thread);
 * 3. `user` / `session_id` from the request body (the OpenAI-compatible spelling);
 * 4. none — the surface's own content-derived identity, which is never a caller identity.
 *
 * An **ephemeral** turn (see `src/web-chat/core/turn-delivery.ts`) resolves to no identity at all:
 * housekeeping work is not addressed to a conversation, so a caller cannot accidentally make its
 * session title continue the user's chat by also sending the session id.
 */
import { isEphemeralWebChatTurn } from "../core/turn-delivery";

/** The metadata key every native surface of this product carries turn metadata in. */
export const NATIVE_TURN_METADATA_KEY = "x-codex-turn-metadata";

/** The `dsh_session_id` spelling on the wire, shared with the provider's own reader. */
export const NATIVE_DSH_SESSION_ID_KEY = "dsh_session_id";

/** The provider-private thread spelling on the wire, used when the caller declares no session. */
export const NATIVE_THREAD_ID_KEY = "thread_id";

/** The turn-classification field on the wire, shared with the provider's own reader. */
export const NATIVE_TURN_PURPOSE_KEY = "purpose";

export interface ResolvedNativeTurnIdentity {
  /**
   * The canonical DSH session identity the caller declared, if any. Absent on an ephemeral turn even
   * when the caller sent one: housekeeping work is addressed to no conversation.
   */
  readonly dshSessionId?: string;
  /**
   * The identity this turn is addressed by: the caller's first declared identity, otherwise the
   * caller-supplied fallback. A provider turns this into its own conversation affinity through its own
   * owner (`chatGptAffinitySessionId` in the ChatGPT adapter), never by re-deriving it here. Absent
   * only when neither the caller nor the caller-supplied fallback named one.
   */
  readonly threadId?: string;
  /** The declared turn purpose, trimmed. `undefined` when the caller declared none. */
  readonly purpose?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsedMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    try {
      return record(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  return record(raw);
}

/**
 * Parse one native turn-metadata payload.
 *
 * The two accepted shapes are the ones the provider's reader accepts: the JSON string this product's
 * surfaces emit, and an already-parsed object. A malformed payload yields nothing rather than a
 * partially read identity, so a broken metadata blob can never become half an identity.
 */
export function parseNativeTurnMetadata(raw: unknown): Record<string, unknown> | undefined {
  return parsedMetadata(raw);
}

/**
 * The native metadata of one **chat-completions** request.
 *
 * The OpenAI-compatible surface carries everything in the body — unlike `/responses/compact`, which
 * also accepts the canonical `x-codex-turn-metadata` header and merges it there — so body-only is the
 * whole contract for this reader.
 */
export function nativeTurnMetadataFromBody(body: unknown): Record<string, unknown> | undefined {
  const metadata = record(record(body)?.client_metadata);
  return parseNativeTurnMetadata(metadata?.[NATIVE_TURN_METADATA_KEY]);
}

/** One string value, trimmed; blank and whitespace-only are absence. */
function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** One string field of the metadata, in the same normalization. */
function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return trimmedString(metadata?.[key]);
}

/**
 * Read one string field out of a native turn-metadata payload, normalized.
 *
 * The provider's own reader uses this for the fields only it owns — a turn id, a parent thread, an
 * agent name, a subagent kind — so "a blank string is absence, and a value is trimmed" is applied in
 * exactly one place for the whole channel instead of once per reader.
 */
export function nativeTurnMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return metadataString(metadata, key);
}

/**
 * Resolve the conversation identity and the declared purpose of one native turn metadata payload.
 *
 * This is the **one place** the precedence is applied, shared by every surface that reads this
 * channel:
 *
 * 1. `dsh_session_id` — the canonical session identity. It is the stronger identity by design: the
 *    session is what the caller considers its conversation, while a provider-private thread is one
 *    possible projection of it. This is the precedence the native path already applies
 *    (`webChatAffinityKey`, which keys a conversation by the session and never by the thread alone).
 * 2. `thread_id` — the caller's own thread, used as-is when it declared no session.
 * 3. `bodySessionId` — the identity the surface already parsed (`user` / `session_id`).
 * 4. `threadId` — the surface's own derived identity, used only when the caller chose none. The
 *    caller supplies it because it is the caller's own rule, never this module's.
 *
 * An **ephemeral** turn resolves to no identity at all even when the metadata carries one:
 * housekeeping work is addressed to no conversation.
 *
 * @param metadata - the caller's native turn metadata, if it sent any.
 * @param bodySessionId - the OpenAI-compatible identity the surface already parsed, if any.
 * @param threadId - the surface's own derived identity, used only when the caller chose none.
 */
export function resolveNativeTurnIdentity(
  metadata: Record<string, unknown> | undefined,
  bodySessionId: string | undefined,
  threadId?: string,
): ResolvedNativeTurnIdentity {
  const purpose = metadataString(metadata, NATIVE_TURN_PURPOSE_KEY);
  const ephemeral = isEphemeralWebChatTurn(purpose);
  const dshSessionId = ephemeral ? undefined : metadataString(metadata, NATIVE_DSH_SESSION_ID_KEY);
  const metadataThreadId = ephemeral ? undefined : metadataString(metadata, NATIVE_THREAD_ID_KEY);
  const explicit = ephemeral ? undefined : trimmedString(bodySessionId);
  const resolved = dshSessionId ?? metadataThreadId ?? explicit ?? trimmedString(threadId);
  return {
    ...(dshSessionId !== undefined ? { dshSessionId } : {}),
    ...(resolved !== undefined ? { threadId: resolved } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
  };
}

/**
 * The complete native metadata a surface must emit for a turn, with the resolved conversation identity
 * as its thread identity.
 *
 * The caller's own fields are preserved, never replaced: `dsh_session_id` and `purpose` are what makes
 * the turn addressable and classified downstream, so a surface that derived an identity of its own must
 * not erase the caller's declaration while forwarding it. `thread_id` is written last because the
 * surface's resolved identity is the one the turn is addressed by.
 */
export function nativeTurnMetadataFor(
  metadata: Record<string, unknown> | undefined,
  threadId: string,
): Record<string, unknown> {
  return { ...metadata, thread_id: threadId };
}
