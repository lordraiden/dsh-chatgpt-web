/**
 * Advisor conversation identity (issue #224).
 *
 * An Advisor review is a *separate* provider conversation: it must never reuse — and never be reused
 * by — the normal WebChat conversation of the same DSH session, even when both use the same provider
 * and the same authenticated account.
 *
 * The separation is expressed with the core's own identity owners rather than a private key format:
 *
 * - the affinity is derived by `webChatAffinityKey` (architecture §7), so provider and account
 *   binding are part of the key by construction and two providers can never collide;
 * - the logical thread identity is a stable synthetic `advisor-` thread, so the Advisor conversation
 *   of a session differs from that session's normal thread identity.
 *
 * The provider still owns *its* conversation key: it resolves the affinity through its own driver,
 * which is why nothing here derives a conversation key or knows a provider namespace.
 *
 * This module has no provider knowledge.
 */
import { createHash } from "node:crypto";
import { webChatAffinityKey, type WebChatConversationAffinity } from "../web-chat/core";

/** The scope one Advisor conversation is addressed by. */
export interface AdvisorConversationScope {
  readonly providerId: string;
  readonly bindingId: string;
  /** The DSH session whose Advisor conversation this is. */
  readonly sessionId: string;
}

/**
 * Stable synthetic thread identity of one DSH session's Advisor conversation.
 *
 * The `advisor-` prefix and the salted digest keep the Advisor thread distinct from the DSH session's
 * normal thread identity, so the two conversations can never resolve to the same affinity key.
 */
export function advisorConversationThread(sessionId: string): string {
  return "advisor-" + createHash("sha256").update("advisor:" + sessionId).digest("hex").slice(0, 24);
}

/**
 * The core affinity of one Advisor conversation.
 *
 * @param scope - provider, account binding and the reviewed DSH session.
 * @returns the affinity the provider resolves through its own driver.
 * @throws {TypeError} when a required identity is missing.
 */
export function advisorConversationAffinity(scope: AdvisorConversationScope): WebChatConversationAffinity {
  // The affinity is built through the core owner below, so a malformed identity fails here rather
  // than becoming a provider conversation nobody can address again.
  const threadId = advisorConversationThread(scope.sessionId);
  webChatAffinityKey({
    providerId: scope.providerId,
    bindingId: scope.bindingId,
    dshSessionId: scope.sessionId,
    threadId,
  });
  return { providerId: scope.providerId, bindingId: scope.bindingId, threadId };
}

/**
 * The canonical affinity key of one Advisor conversation, for diagnostics and tests.
 *
 * Production routing derives the key inside the provider (it owns the deployment namespace); this
 * helper exists so a caller can *observe* the identity without duplicating the derivation rules.
 */
export function advisorAffinityKey(scope: AdvisorConversationScope, namespace?: string): string {
  return webChatAffinityKey({
    providerId: scope.providerId,
    bindingId: scope.bindingId,
    dshSessionId: scope.sessionId,
    threadId: advisorConversationThread(scope.sessionId),
    ...(namespace !== undefined ? { namespace } : {}),
  });
}
