import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { webChatConversationKey } from "../../web-chat/core";
import { extractChatGptTurnIdentity } from "./environment";

/**
 * Logical ChatGPT Web conversation affinity.
 *
 * Derived only from the stable DSH chat identity (thread) and the execution
 * namespace. Model, reasoning effort, and compaction are properties of the
 * turn, not of the chat: they must never split one DSH chat into a second
 * ChatGPT conversation.
 *
 * The digest belongs to the provider-neutral core (`webChatConversationKey`,
 * issue #189); this function owns only the ChatGPT-specific half — which thread
 * identity a request carries and which namespace it runs under.
 */
export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  return webChatConversationKey(namespace, identity.threadId);
}

/** Full history remains canonical; a retained epoch receives only the suffix after its last assistant reply. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.slice(lastAssistant + 1),
    },
  };
}

/**
 * Stable identity of the DSH system block for one retained conversation.
 *
 * The fingerprint of the system block that was PHYSICALLY INSTALLED in a
 * conversation generation is recorded once, when the install turn settles.
 * A later system-prompt change does not propagate into an existing
 * generation: the physically installed prefix stays frozen for the rest of
 * that physical conversation and the change takes effect only in the next
 * physical epoch, which installs the new block.
 */
export function chatGptSystemFingerprint(systemPrompt?: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(systemPrompt ?? [])).digest("hex");
}

/**
 * Registry that remembers which system block was installed in a specific
 * physical generation of a retained conversation. `ChatGptTurnSessions`
 * satisfies this structurally; the adapter's resume orchestration and the
 * deterministic tests share the same decision through this seam.
 */
export interface ChatGptSystemFingerprintStore {
  sentSystemFingerprint(conversationKey: string, generation: number): string | undefined;
}

/**
 * Diagnostic/observability check for a retained continuation (issue
 * #171/#172). True only when the CURRENT physical generation's recorded
 * fingerprint matches this exact system block:
 *
 * - no conversationKey → false (nothing to continue);
 * - no fingerprint recorded for the current generation → false;
 * - the current generation's recorded fingerprint differs → false (the
 *   system block changed since the install — the prefix is frozen);
 * - the current generation's recorded fingerprint matches → true.
 *
 * This does NOT control the resume branch: `resolveChatGptResumeBranch`
 * selects `continue`/`install` from the mere EXISTENCE of a fingerprint for
 * the generation, so a system-prompt change never triggers a re-install or a
 * fallback to the legacy transport. The adapter consults this predicate only
 * to LOG a mid-conversation system change (frozen-prefix observability). A
 * fingerprint recorded for generation N is never considered for generation
 * N+1: a replacement physical epoch re-installs the system.
 */
export function isStableSystemContinuation(
  store: ChatGptSystemFingerprintStore,
  conversationKey: string | undefined,
  generation: number,
  systemPrompt: readonly string[] | undefined,
): boolean {
  if (conversationKey === undefined) return false;
  return store.sentSystemFingerprint(conversationKey, generation) === chatGptSystemFingerprint(systemPrompt);
}

/**
 * Which composer transport a retained turn uses (issue #171/#172):
 *
 * - `continue` → `compileRetainedChatGptWebContinuation` (composer text with
 *   only the new human content; the prefix is already installed in the
 *   physical conversation. A recorded-but-different fingerprint keeps the
 *   prefix frozen for the rest of this physical conversation — the persona
 *   change takes effect in the next physical conversation);
 * - `install` → `compileRetainedChatGptWebInstall` (effective system prompt
 *   + project name + projected conversation, as plain composer text — no
 *   JSON envelope, no transport contract).
 */
export type ChatGptResumeBranch = "continue" | "install";

/**
 * The single branch-selection decision for a retained turn.
 *
 * This is the exact decision the adapter's `compileResume` executes, extracted
 * here so production and the deterministic regression tests share ONE
 * implementation of the decision instead of the test re-stating the condition
 * it protects. It is a pure function of its dependencies — the conversation
 * key, the current physical generation, and the fingerprint store — and
 * performs no compilation: the caller applies the returned branch to the real
 * compile functions (which own the per-turn options).
 *
 * - no conversationKey → `install`;
 * - no fingerprint recorded for the current generation → `install` (the
 *   prefix is not established in this physical epoch, so it must be
 *   installed);
 * - a fingerprint recorded for the current generation (matching OR
 *   mismatched) → `continue` (the prefix is installed in this physical
 *   conversation and stays frozen; the mismatch is only logged by the caller
 *   through `isStableSystemContinuation`).
 *
 * The current system block deliberately does NOT influence the decision: the
 * branch depends only on what is physically installed. A fingerprint
 * recorded for generation N is never considered for generation N+1: a
 * replacement physical epoch re-installs the prefix.
 */
export function resolveChatGptResumeBranch(
  store: ChatGptSystemFingerprintStore,
  conversationKey: string | undefined,
  generation: number,
): ChatGptResumeBranch {
  if (conversationKey === undefined) return "install";
  return store.sentSystemFingerprint(conversationKey, generation) === undefined
    ? "install"
    : "continue";
}

/**
 * Whether the system fingerprint may be (re)recorded after a settled turn
 * (issue #172, fingerprint semantics): the fingerprint represents the system
 * block PHYSICALLY INSTALLED in the current conversation generation, so it is
 * only written when the turn actually performed the install. A continuation
 * never rewrites the installed fingerprint even if DSH's current
 * `systemPrompt` has changed — the physically installed prefix stays frozen
 * for the rest of the physical conversation.
 *
 * Production and the deterministic regression tests share this single
 * implementation of the guard.
 */
export function systemFingerprintRecordedOnBranch(branch: ChatGptResumeBranch): boolean {
  return branch === "install";
}
