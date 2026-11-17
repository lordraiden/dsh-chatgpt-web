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
 * 4. `prompt_cache_key` from the request body — an OpenAI-compatible caller's **declared** session
 *    identity (see the declared-channel contract below);
 * 5. the affinity header (`x-session-affinity` / `session_id` / `x-session-id`);
 * 6. none — the surface's own content-derived identity, which is never a caller identity.
 *
 * An **ephemeral** turn (see `src/web-chat/core/turn-delivery.ts`) resolves to no identity at all:
 * housekeeping work is not addressed to a conversation, so a caller cannot accidentally make its
 * session title continue the user's chat by also sending the session id.
 *
 * ## Declared identity channels (issue #307 follow-up)
 *
 * A caller that speaks the OpenAI wire does not necessarily send OpenAI's `user` field. The
 * OpenAI-compatible harness that reproduced the original defect (two sessions → nine provider chats)
 * carries its identity on two other **declared** channels, and this module is their one reader:
 *
 * - `prompt_cache_key` in the body. `@earendil-works/pi-ai`'s OpenAI-completions adapter writes the
 *   harness session id there when the profile asks for long prompt-cache retention; the value is the
 *   session id verbatim (truncated to 64 characters, never hashed).
 * - the session-affinity request headers, which that same adapter can emit beside the body field.
 *
 * Both are *channels that carry a declared identity*, not ChatGPT specifics: a `prompt_cache_key` is
 * what the OpenAI wire calls the caller's stable cache/session affinity, and the header names are the
 * ones an OpenAI-compatible client uses for the same declaration. They sit **below** every existing
 * entry, so neither can shadow the identity this product already understands: an explicit
 * `dsh_session_id`, a native `thread_id`, or OpenAI's own `user` keeps winning exactly as before, and
 * the retirement condition is the same for both — a caller that states a native identity does not need
 * them, and the day the harness sends `dsh_session_id` directly they contribute nothing.
 *
 * ## Declared workspace (doc/plugin.md §3.3)
 *
 * The same metadata payload may declare a `workspace`: the name of the workspace the caller's
 * conversation is about. It is **initialization context, not identity** — it never keys a
 * conversation — and it is used by exactly one thing: the first-message header an install compiler
 * emits (`Project: "<workspace>"`). It is normalized to a bare name here, so a caller that sends a
 * path can never put a local filesystem path into a provider's first message, and it is carried
 * through {@link nativeTurnMetadataFor} so a surface that re-emits the metadata does not lose it.
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

/**
 * The declared workspace name on the wire (doc/plugin.md §3.3).
 *
 * Initialization context for the first message of a conversation, never identity: it is read from the
 * same native metadata payload as the identity fields and it never participates in the conversation
 * key. The value is a **name**, so it is normalized by {@link projectContextName} before anyone uses
 * it.
 */
export const NATIVE_WORKSPACE_KEY = "workspace";

/**
 * Derive a conversation name from a declared workspace: the last non-empty path segment.
 *
 * The workspace is a name, never a path (doc/plugin.md §3.3): a caller that sends an absolute path
 * must not put that local filesystem path into a provider's first message. The retained ChatGPT
 * install derives its project reference from its cwd with this same rule, which is why the rule lives
 * in the host owner both install compilers reach rather than in one adapter.
 */
export function projectContextName(workspace: string | undefined): string | undefined {
  if (workspace === undefined) return undefined;
  const segments = workspace.split(/[\\/]+/).filter(segment => segment.length > 0);
  const name = segments[segments.length - 1];
  return name && name.length > 0 ? name : undefined;
}

/**
 * The first-message header a declared workspace compiles to, or `undefined` when none is declared.
 *
 * The exact text is the workspace form of the project header (doc/plugin.md §3.3):
 * `Project: "<workspace>"` with no `github:` line. Only an install emits it; a continuation sends no
 * header at all. A workspace that normalizes to no name yields no header, so an unusable declaration
 * falls back to the caller's own header instead of fabricating one.
 */
export function workspaceInstallHeader(workspace: string | undefined): string | undefined {
  // A whitespace-only declaration is absence, not a header with blank quotes: the metadata reader
  // already trims, and a direct caller (a provider's install compiler) must get the same rule.
  const name = projectContextName(workspace?.trim());
  return name !== undefined && name.trim() !== "" ? `Project: "${name}"` : undefined;
}

/**
 * The body field an OpenAI-compatible caller declares its stable session affinity in.
 *
 * `@earendil-works/pi-ai`'s OpenAI-completions adapter places the harness session id here verbatim
 * (`clampOpenAIPromptCacheKey` only truncates past 64 characters; it never hashes), so the value is a
 * declared identity rather than an opaque cache token when the caller sent one.
 *
 * A client can use the same channel for its **operation** identity: sending one per-operation trace
 * id on every call of a multi-step run makes this service read the run as one conversation — so a
 * multi-turn loop continues one provider conversation while a different run gets a different one
 * (issue #359). That reuse is scoped to the operation by construction; it is never shared across
 * operations.
 */
export const NATIVE_PROMPT_CACHE_KEY_FIELD = "prompt_cache_key";

/**
 * The request headers an OpenAI-compatible caller may declare session affinity in, in read order.
 *
 * The three names are exactly pi-ai's own affinity spellings — `session_id` and `x-session-affinity`
 * in its OpenAI format, `x-session-id` in its OpenRouter format. `x-client-request-id`, which pi-ai
 * emits in the OpenAI format beside them, is deliberately **not** read: its name declares a *request*,
 * and a caller that sets it per request would turn every turn into its own conversation, which is the
 * exact harm this channel exists to prevent.
 */
export const NATIVE_TURN_AFFINITY_HEADERS = ["x-session-affinity", "session_id", "x-session-id"] as const;

/**
 * The header a caller declares an **auxiliary turn purpose** in.
 *
 * The harness drops its native `purpose` field before an OpenAI-compatible wire (the pi-ai adapter
 * never reads it), so a route that serves housekeeping work can still mark it: a static per-route
 * header names the purpose the route exists for. This is a declaration, never an inference — the value
 * is the caller's own word and is classified by the same core rule as the native field.
 */
export const NATIVE_TURN_PURPOSE_HEADER = "x-dsh-turn-purpose";

/** A read-only view of request headers. The platform `Headers` type satisfies it. */
export interface NativeTurnHeaderSource {
  get(name: string): string | null | undefined;
}

/**
 * The declared identity channels that arrive beside — or instead of — the native turn metadata.
 *
 * `Headers` carries the request's headers when the surface that built the request can see them; a
 * surface that cannot stays absent rather than guessed.
 */
export interface NativeTurnDeclaredChannels {
  readonly promptCacheKey?: unknown;
  readonly headers?: NativeTurnHeaderSource;
}

/** A string, trimmed; blank and whitespace-only are absence. */
function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read the declared identity channels out of one request body and its headers.
 *
 * Surfaces call this instead of picking fields themselves, so "what a caller may declare, and under
 * which spelling" stays in one place for both `/v1/responses` and `/v1/chat/completions`.
 */
export function declaredTurnChannels(
  body: unknown,
  headers?: NativeTurnHeaderSource,
): NativeTurnDeclaredChannels {
  const promptCacheKey = record(body)?.[NATIVE_PROMPT_CACHE_KEY_FIELD];
  return {
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** The declared purpose a route-level header carries, if any. */
export function declaredTurnPurposeFromHeaders(headers?: NativeTurnHeaderSource): string | undefined {
  return trimmedString(headers?.get(NATIVE_TURN_PURPOSE_HEADER));
}

/** The declared session affinity a header carries, if any, in {@link NATIVE_TURN_AFFINITY_HEADERS} order. */
export function declaredTurnAffinityFromHeaders(headers?: NativeTurnHeaderSource): string | undefined {
  for (const name of NATIVE_TURN_AFFINITY_HEADERS) {
    const value = trimmedString(headers?.get(name));
    if (value !== undefined) return value;
  }
  return undefined;
}

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
  /**
   * The declared workspace as a conversation name, normalized (a path collapses to its last segment).
   *
   * Initialization context for the first message, never identity: it does not key a conversation and
   * is resolved even on an ephemeral turn, which never installs one. `undefined` when the caller
   * declared none (or declared one that is not a usable name).
   */
  readonly workspace?: string;
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
 * Resolve the conversation identity and the declared purpose of one native turn-metadata payload.
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
 * 4. `declared.promptCacheKey` — the caller's declared OpenAI-wire session affinity.
 * 5. the affinity header — the same declaration carried in a header instead of the body.
 * 6. `threadId` — the surface's own derived identity, used only when the caller chose none. The
 *    caller supplies it because it is the caller's own rule, never this module's.
 *
 * Entries 4 and 5 are declared channels, so they are applied only after every identity this product
 * already understands: they can never shadow a native `dsh_session_id`, a native `thread_id`, or
 * OpenAI's own `user`. A declared purpose is likewise read from the native metadata first and from
 * {@link NATIVE_TURN_PURPOSE_HEADER} only when the metadata declares none.
 *
 * An **ephemeral** turn resolves to no identity at all even when the metadata carries one:
 * housekeeping work is addressed to no conversation.
 *
 * The declared `workspace` is not part of this precedence — it is initialization context, not an
 * identity — so it is resolved from the metadata on its own and normalized to a bare name
 * ({@link projectContextName}).
 *
 * @param metadata - the caller's native turn metadata, if it sent any.
 * @param bodySessionId - the OpenAI-compatible identity the surface already parsed, if any.
 * @param threadId - the surface's own derived identity, used only when the caller chose none.
 * @param declared - the declared identity channels read beside the metadata, when the surface can see
 *   them ({@link declaredTurnChannels}).
 */
export function resolveNativeTurnIdentity(
  metadata: Record<string, unknown> | undefined,
  bodySessionId: string | undefined,
  threadId?: string,
  declared?: NativeTurnDeclaredChannels,
): ResolvedNativeTurnIdentity {
  const purpose = metadataString(metadata, NATIVE_TURN_PURPOSE_KEY)
    ?? declaredTurnPurposeFromHeaders(declared?.headers);
  const ephemeral = isEphemeralWebChatTurn(purpose);
  const dshSessionId = ephemeral ? undefined : metadataString(metadata, NATIVE_DSH_SESSION_ID_KEY);
  const metadataThreadId = ephemeral ? undefined : metadataString(metadata, NATIVE_THREAD_ID_KEY);
  const explicit = ephemeral ? undefined : trimmedString(bodySessionId);
  const promptCacheKey = ephemeral ? undefined : trimmedString(declared?.promptCacheKey);
  const headerAffinity = ephemeral ? undefined : declaredTurnAffinityFromHeaders(declared?.headers);
  const resolved = dshSessionId
    ?? metadataThreadId
    ?? explicit
    ?? promptCacheKey
    ?? headerAffinity
    ?? trimmedString(threadId);
  // The workspace is initialization context rather than identity, so it is resolved independently of
  // the ephemeral classification: an ephemeral turn never installs a conversation, so the value is
  // carried but never emitted.
  const workspace = projectContextName(metadataString(metadata, NATIVE_WORKSPACE_KEY));
  return {
    ...(dshSessionId !== undefined ? { dshSessionId } : {}),
    ...(resolved !== undefined ? { threadId: resolved } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
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
 *
 * `purpose` is written only when the resolver derived one that the caller's own metadata did not carry
 * (a declared purpose header): the native field already preserved above stays the caller's word.
 *
 * A declared `workspace` is carried through in its normalized form: the caller's raw spelling (which
 * may be a path) is not what an install may emit, and a surface that re-emits the metadata must not
 * lose the declaration on the way through. A payload that declares no usable workspace keeps whatever
 * it had (an unusable value is ignored by every reader, never turned into a name).
 */
export function nativeTurnMetadataFor(
  metadata: Record<string, unknown> | undefined,
  threadId: string,
  purpose?: string,
): Record<string, unknown> {
  const workspace = projectContextName(metadataString(metadata, NATIVE_WORKSPACE_KEY));
  return {
    ...metadata,
    ...(workspace !== undefined ? { [NATIVE_WORKSPACE_KEY]: workspace } : {}),
    ...(purpose !== undefined && metadataString(metadata, NATIVE_TURN_PURPOSE_KEY) === undefined
      ? { [NATIVE_TURN_PURPOSE_KEY]: purpose }
      : {}),
    thread_id: threadId,
  };
}
