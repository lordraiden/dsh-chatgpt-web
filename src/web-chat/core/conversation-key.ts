/**
 * Provider-neutral conversation-key derivation (architecture §6.3, §7, §19.2).
 *
 * This is the *generic* half of the affinity rule: one logical provider conversation per
 * (namespace, thread) pair. Everything that decides what the thread identity is — host session
 * derivation, provider-specific fallbacks, physical-generation rules — stays with the driver.
 *
 * The digest is a compatibility surface: an installed provider conversation is addressed by this
 * key, so the derivation may never change silently.
 *
 * This module has no provider knowledge and no runtime dependency beyond hashing.
 */
import { createHash } from "node:crypto";

/**
 * Derive one provider conversation key.
 *
 * @param namespace - execution namespace of the provider deployment.
 * @param threadId - logical provider thread identity, derived by the driver from host identity.
 * @returns the stable hex conversation key.
 */
export function webChatConversationKey(namespace: string, threadId: string): string {
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId,
  })).digest("hex");
}
