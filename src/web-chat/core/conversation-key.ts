/**
 * Provider-neutral conversation-key derivation (architecture §6.3, §7, §19.2).
 *
 * Two derivations live here, with one owner each:
 *
 * - `webChatAffinityKey` is the canonical affinity key of §7: one provider conversation per
 *   (provider, account binding, host session/thread). Provider and account binding are part of the
 *   key by construction, so the same host session can use several providers without any of them
 *   ever reusing another's conversation handle.
 * - `legacyWebChatThreadKey` is the pre-migration thread key kept for the existing provider path
 *   until that driver migration (issue #192) retires it. It has exactly one production caller and
 *   must not acquire another; its digest is a compatibility surface for conversations that already
 *   exist.
 *
 * The key never contains provider *internals*: it is derived from identities, and the provider
 * conversation handle stays opaque and separate.
 *
 * This module has no provider knowledge and no runtime dependency beyond hashing.
 */
import { createHash } from "node:crypto";

/**
 * The identities one provider conversation affinity is derived from (architecture §7).
 *
 * Provider and account binding are required: a conversation belongs to one provider *and* one
 * authenticated account, so changing either can never continue the previous conversation.
 */
export interface WebChatAffinityKeyInput {
  /** Provider the conversation belongs to. */
  readonly providerId: string;
  /** Authenticated provider/account binding the conversation belongs to. */
  readonly bindingId: string;
  /** Canonical host session identity (or its stable projection). */
  readonly dshSessionId: string;
  /** Provider-private logical thread identity derived from that session. */
  readonly threadId: string;
  /** Execution namespace of this provider deployment. */
  readonly namespace?: string;
}

/** Require one non-empty identity component. */
function requiredIdentity(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`WebChat affinity key requires a non-empty ${field}`);
  }
  return value;
}

/**
 * Derive the canonical provider conversation affinity key (architecture §7).
 *
 * @param input - provider, account binding and session/thread identities.
 * @returns the stable hex affinity key.
 * @throws {TypeError} when a required identity is missing.
 */
export function webChatAffinityKey(input: WebChatAffinityKeyInput): string {
  const providerId = requiredIdentity(input.providerId, "providerId");
  const bindingId = requiredIdentity(input.bindingId, "bindingId");
  const dshSessionId = requiredIdentity(input.dshSessionId, "dshSessionId");
  const threadId = requiredIdentity(input.threadId, "threadId");
  return createHash("sha256").update(JSON.stringify({
    providerId,
    bindingId,
    dshSessionId,
    threadId,
    namespace: input.namespace ?? "",
  })).digest("hex");
}

/**
 * Legacy logical thread key of the existing provider path (issue #170).
 *
 * @deprecated Provider-local continuity key of the pre-migration provider path. The driver migration
 * (issue #192) moves that path onto {@link webChatAffinityKey} and removes this function. Exactly one
 * production caller is allowed meanwhile; the digest must not change, because it addresses provider
 * conversations that already exist.
 *
 * @param namespace - execution namespace of the provider deployment.
 * @param threadId - logical provider thread identity.
 * @returns the stable hex conversation key.
 */
export function legacyWebChatThreadKey(namespace: string, threadId: string): string {
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId,
  })).digest("hex");
}
