/**
 * Structural reconciliation of a retained ChatGPT Web conversation (issue #314 stage 3).
 *
 * The measured remaining case: a turn fails *after* its submission was accepted, in a conversation
 * whose initialization is already installed, and the WebChat Core then refuses every later turn with
 * `CONVERSATION_STATE_MISMATCH` — "the last attempt on this conversation was never confirmed; the
 * provider must reconcile it before it can be resumed" (#190). Stage 2 keeps such a conversation's
 * physical surface alive (`unreconciled`); this module is how the provider *proves* whether that
 * surface is coherent enough for the Core to accept an exact resume.
 *
 * Two facts are compared, both structural and both provider state:
 *
 * - the **attempt record** ({@link ChatGptRetainedAttempt}): what the conversation held when the
 *   failed attempt's send was activated;
 * - the conversation's **current state** ({@link ChatGptRetainedConversationState}): what it holds now.
 *
 * The verdict is therefore derived from the page/conversation state — never from comparing the
 * user's text, never from a timer, and never from "the page is alive therefore fine". A conversation
 * that was never submitted to (no record) is coherent because nothing reached ChatGPT; one whose turn
 * structure gained a finalized assistant reply is coherent because the failed attempt's reply is
 * physically there. Everything else fails closed.
 *
 * This module has no browser and no DOM dependency: it is the rule, executed against a snapshot the
 * provider reads, so the rule is testable without a browser.
 */
import { safeErrorDescriptor } from "../../lib/safe-diagnostics";
import {
  type RetainedSurfacePage,
  type RetainedSurfaceRegistry,
} from "./retained-surface";

/**
 * The provider's structural record of one attempt, written when its send was activated.
 *
 * It is deliberately *not* a message: only the conversation's turn identities — the DOM's own stable
 * per-turn keys, the same structural evidence the submission path already uses — so nothing here can
 * be compared against, or reconstructed from, what the caller said.
 */
export interface ChatGptRetainedAttempt {
  /** User-turn identities the conversation held when the attempt's send was activated. */
  readonly userTurns: readonly string[];
  /** Assistant-turn identities the conversation held when the attempt's send was activated. */
  readonly responseTurns: readonly string[];
}

/** The retained conversation's structural state, as one bounded read reports it. */
export interface ChatGptRetainedConversationState {
  readonly userTurns: readonly string[];
  readonly responseTurns: readonly string[];
  /** Whether ChatGPT is visibly generating (its stop control is present). */
  readonly generationRunning: boolean;
}

/**
 * Whether the retained conversation structurally still holds the failed attempt's reply.
 *
 * The rule, in full:
 *
 * - the conversation must still be the one the attempt ran in — every turn the attempt recorded is
 *   still present. A conversation whose turns were replaced is not this conversation, so it is never
 *   declared coherent just because it happens to hold *a* reply;
 * - an assistant turn must have appeared that the attempt did not record — a reply to the accepted
 *   submission;
 * - that reply must be a *finalized* answer: the generation must have stopped and the newest
 *   assistant turn must carry the completion evidence. A reply still streaming, or one whose
 *   generation died midway, is not an outcome this provider can attribute to the failed turn.
 *
 * @param input - the recorded attempt, the conversation's current state and its completion evidence.
 * @returns whether the failed attempt's reply is physically present and finalized.
 */
export function chatGptAttemptReplyPresent(input: {
  readonly attempt: ChatGptRetainedAttempt;
  readonly state: ChatGptRetainedConversationState;
  /** Whether the newest assistant turn carries finalized completion evidence. */
  readonly replyFinalized: boolean;
}): boolean {
  const currentUserTurns = new Set(input.state.userTurns);
  const currentResponseTurns = new Set(input.state.responseTurns);
  const sameConversation = input.attempt.userTurns.every(identity => currentUserTurns.has(identity))
    && input.attempt.responseTurns.every(identity => currentResponseTurns.has(identity));
  if (!sameConversation) return false;
  const known = new Set(input.attempt.responseTurns);
  const appeared = input.state.responseTurns.some(identity => !known.has(identity));
  return appeared && !input.state.generationRunning && input.replyFinalized;
}

/**
 * What the provider established about an unconfirmed attempt (issue #314 stage 3).
 *
 * - `reconciled` — the retained conversation structurally holds the failed attempt's reply (or the
 *   attempt never reached ChatGPT), so an exact resume is honest and nothing has to be resent.
 * - `unprovable` — the conversation is retained but its coherence cannot be proven; the caller keeps
 *   the honest continuity refusal, and the bounded reconciliation gives the surface up when the
 *   state is settled enough to judge.
 * - `lost` — the retained conversation is gone (its page is closed, or its key is retired); its loss
 *   reason is the one the retiring operation published, when it could express one.
 */
export type RetainedConversationReconciliation =
  | { readonly kind: "reconciled"; readonly reason: string }
  | { readonly kind: "unprovable"; readonly reason: string }
  | { readonly kind: "lost"; readonly reason?: string };

/**
 * What one bounded inspection of the retained conversation reported.
 *
 * `unreadable` is a read that failed or could not be interpreted (an unstable DOM, a timeout). It is
 * deliberately not an exception the caller has to interpret: a conversation that cannot be read
 * cannot be proven, which is a verdict of its own.
 */
export type ChatGptRetainedInspection =
  | {
    readonly kind: "read";
    readonly state: ChatGptRetainedConversationState;
    /** Whether the newest assistant turn carries finalized completion evidence. */
    readonly replyFinalized: boolean;
  }
  | { readonly kind: "unreadable" };

/**
 * Reconcile one retained conversation from its record and one bounded inspection (issue #314
 * stage 3).
 *
 * This is the whole verdict: what the retained surface holds about the attempt, compared against what
 * the attempt recorded, with the surface's own lifetime as the bound. The caller supplies only the
 * inspection (the provider reads its page); every decision — coherent, unprovable, gone, and when the
 * surface is given up — is taken here, so no caller can reconcile on a guess.
 *
 * - no retained surface for the key: `lost` when its continuity was already declared broken (a
 *   retired, tombstoned key), and `unprovable` when this process simply never retained it — a
 *   restart, or a deployment whose conversations live in another process. Absence of a surface is
 *   not evidence that a conversation is gone;
 * - no recorded attempt (nothing was ever submitted through it): `reconciled`, because nothing
 *   reached the provider;
 * - a page that is closed while its conversation is settled and reusable: proof of death, so the
 *   surface is retired with `surface-dead` and the verdict is `lost`;
 * - a page a turn owns, or whose settlement is unpublished: `unprovable`, without retiring a page
 *   that may still produce output;
 * - otherwise the inspection decides; an unprovable verdict retires the surface with
 *   `reconciliation-exhausted`, so a conversation that cannot be reconciled is given up instead of
 *   being carried forever.
 *
 * @param input - the retained-surface owner, the conversation key and the provider's inspection.
 * @returns the reconciliation verdict.
 */
export async function reconcileRetainedConversation<P extends RetainedSurfacePage>(input: {
  readonly registry: RetainedSurfaceRegistry<P, ChatGptRetainedAttempt>;
  readonly conversationKey: string;
  readonly inspect: (
    page: P,
    attempt: ChatGptRetainedAttempt,
  ) => Promise<ChatGptRetainedInspection>;
}): Promise<RetainedConversationReconciliation> {
  const { registry, conversationKey } = input;
  if (!registry.has(conversationKey)) {
    if (registry.isLost(conversationKey)) {
      // A retired key: its continuity was declared broken by the operation that retired it (a dead
      // page, an eviction, a spent reconciliation). The tombstone is not a journal, so the reason is
      // whatever that operation published when it retired — absent here.
      return { kind: "lost" };
    }
    // No surface and no tombstone: this process never retained this conversation (a restart, or a
    // deployment that keeps its conversations elsewhere). That is not evidence of loss, so it fails
    // closed: the core keeps its honest refusal instead of declaring the conversation gone.
    return {
      kind: "unprovable",
      reason: "this process has no retained conversation to reconcile",
    };
  }
  const attempt = registry.attemptRecord(conversationKey);
  if (!attempt) {
    // The last attempt never activated a send, so nothing reached ChatGPT and the conversation is
    // exactly as its last settled turn left it: an exact resume is honest and resends nothing.
    // This is the provider's own record of the attempt — never an inference from the page living.
    return {
      kind: "reconciled",
      reason: "the retained conversation was never submitted to; nothing was sent",
    };
  }
  const page = registry.inspectablePage(conversationKey);
  if (!page) {
    if (registry.isReusable(conversationKey)) {
      // Settled and reusable, yet no page to read: the page is closed. That is proof of death, so
      // the surface is retired with its own distinguishable reason (issue #314 stage 2).
      registry.settle(conversationKey, "rejected", "surface-dead");
      return { kind: "lost", reason: "surface-dead" };
    }
    // A turn currently owns the page, or its settlement is unpublished. Reading it — and closing
    // it — is not safe, so this fails closed without retiring; a later turn may inspect it again.
    return {
      kind: "unprovable",
      reason: "the retained conversation is not idle and could not be inspected",
    };
  }
  let inspection: ChatGptRetainedInspection;
  try {
    inspection = await input.inspect(page, attempt);
  } catch (error) {
    console.warn(
      `[chatgpt-web] retained reconciliation could not read the retained conversation: ${safeErrorDescriptor(error)}`,
    );
    inspection = { kind: "unreadable" };
  }
  if (inspection.kind === "read"
    && chatGptAttemptReplyPresent({
      attempt,
      state: inspection.state,
      replyFinalized: inspection.replyFinalized,
    })) {
    return {
      kind: "reconciled",
      reason: "the retained conversation holds the failed attempt's reply",
    };
  }
  // Bounded (issue #314 stage 3): one inspection per unconfirmed attempt, and a conversation that
  // cannot be proven coherent is given up here instead of being carried forever. The reason keeps
  // stage 2's vocabulary, so "the surface died" and "reconciliation gave up" stay distinguishable.
  registry.settle(conversationKey, "rejected", "reconciliation-exhausted");
  return {
    kind: "unprovable",
    reason: inspection.kind === "unreadable"
      ? "the retained conversation could not be inspected"
      : "the retained conversation does not hold a finalized reply to the failed attempt",
  };
}

