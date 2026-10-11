/**
 * Provider-neutral conversation contract (architecture §6, §8.2).
 *
 * Five identities stay separate and none of them is the host session: the host session identity,
 * the provider/account binding, the conversation key, the provider conversation handle and the
 * turn identity. This module owns the first three plus the conversation record; the turn identity
 * lives in `exchange.ts`.
 *
 * A provider conversation handle is **opaque**: the common layer stores, persists, compares and
 * passes it, but never interprets its contents (architecture §4.2). It is the driver's private
 * state.
 *
 * This module has no provider knowledge and no runtime dependency.
 */

/** Opaque provider conversation handle: the driver's private state, branded so core code cannot forge it. */
export type WebChatConversationHandle = string & {
  readonly __webChatConversationHandle: unique symbol;
};

/**
 * What the driver can say about an existing conversation (architecture §10, §8.2).
 *
 * The *decision* that produces one of these outcomes belongs to the conversation-affinity work
 * (issue #190 / PR 2); this is the shared vocabulary.
 */
export type WebChatConversationStatus =
  /** No conversation exists for this affinity yet. */
  | "new"
  /** The existing conversation can continue. */
  | "resumable"
  /** The provider cannot continue and an explicit replay is required. */
  | "replay_required"
  /** The conversation existed but is provably gone. */
  | "lost"
  /** The conversation state cannot currently be established (unknown remote state stays explicit). */
  | "unreachable"
  /** The provider cannot represent the requested turn in this conversation. */
  | "unsupported";

/**
 * One logical provider conversation (architecture §8.2).
 *
 * `key` is the provider-neutral affinity key; `bindingId` ties it to one provider/account binding;
 * `generation` distinguishes physical epochs of the same logical conversation; `handle` is opaque.
 */
export interface WebChatConversation {
  /** Provider-neutral conversation affinity key. */
  readonly key: string;
  /** Driver that owns this conversation. */
  readonly providerId: string;
  /** Provider/account binding this conversation belongs to. */
  readonly bindingId: string;
  /** Physical epoch of this logical conversation; a replay/new conversation starts a new one. */
  readonly generation: number;
  /** Opaque provider conversation handle. */
  readonly handle: WebChatConversationHandle;
  /** What the driver currently knows about this conversation. */
  readonly status: WebChatConversationStatus;
}

/**
 * Host session identity (architecture §6.1).
 *
 * The host session is canonical and never derived from provider state.
 */
export interface WebChatDshSessionIdentity {
  /** Host session identity, when the caller is session-bound. */
  readonly sessionId?: string;
}

/**
 * Provider/account binding identity (architecture §6.2).
 *
 * A fingerprint, never a credential: the common layer must not carry cookies, tokens or provider
 * session material.
 */
export interface WebChatAccountBinding {
  readonly providerId: string;
  /** Stable account fingerprint (never the account name or a credential). */
  readonly accountFingerprint: string;
  /** Browser profile identity, when the transport uses one. */
  readonly browserProfile?: string;
  /** Browser context identity, when the transport uses one. */
  readonly browserContext?: string;
}

/**
 * The one identity a conversation key is derived from (architecture §6.3, §7).
 *
 * A binding id and a *logical* thread identity are required; nothing else may participate, so a
 * model or reasoning change can never split one host chat into a second provider conversation.
 */
export interface WebChatConversationAffinity {
  readonly providerId: string;
  readonly bindingId: string;
  /** Logical provider thread identity (the driver derives it from host identity). */
  readonly threadId: string;
}

/**
 * Admit a value as an opaque conversation handle.
 *
 * Only a non-empty string is a handle; the core never parses it, so the admission is deliberately
 * blind to its contents.
 */
export function webChatConversationHandle(value: unknown): WebChatConversationHandle | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value as WebChatConversationHandle;
}
