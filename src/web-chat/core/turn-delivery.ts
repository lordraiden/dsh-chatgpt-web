/**
 * Provider-neutral **turn delivery** semantics: a caller's turn is either part of the conversation it
 * is addressed to, or an **ephemeral turn** that is answered and kept nowhere.
 *
 * ## Why this owner exists
 *
 * A caller that keeps its own canonical transcript also runs *housekeeping* model calls on the same
 * session identity: naming the session, summarizing/compacting its history, and similar auxiliary
 * work. Those calls are not the user's conversation. A harness that holds the session identity sends
 * the classification with them — DSH calls it a turn `purpose` — so the classification exists on the
 * wire before any provider runs, which is exactly why it belongs here, in the common layer, and not
 * inside a provider driver: the *meaning* ("answered, kept nowhere") is common to every text-only web
 * provider, while *how* a provider avoids keeping a conversation is provider-specific.
 *
 * Two turns of the same session therefore resolve differently, and only this module decides which:
 *
 * - `conversational` — the turn belongs to the session's provider conversation. Whether an already
 *   existing conversation is continued or a first one is created is the provider's own decision.
 * - `ephemeral` — the turn is answered and leaves nothing behind (see the contract below).
 *
 * ## The ephemeral contract
 *
 * What the host **guarantees** to an ephemeral turn:
 *
 * - the turn is executed normally and its answer is returned to the caller like any other answer;
 * - the turn is validated, authenticated and accounted for exactly like a conversational one.
 *
 * What the host **requires** of the provider serving it:
 *
 * - **it must not create a provider conversation for the turn, and must not retain one**: no
 *   conversation handle is stored or published, so no later turn can ever resolve to it;
 * - **it must not write any of the session's conversation state**: it is neither a continuation of
 *   the session's conversation nor an installment into it — it changes no stored continuation state,
 *   no conversation generation, and no installed-prefix/system fingerprint;
 * - **it must not consume or retire the session's conversation**: the turn reads no retained surface
 *   and leaves the session's own conversation exactly as it was, so the next conversational turn
 *   continues or installs as if the ephemeral turn had never run;
 * - **it must fail closed if it cannot run ephemerally**: a provider that has no way to run a turn
 *   without claiming the session's conversation must refuse the turn with an explicit, typed failure.
 *   The one thing it must never do is answer by quietly taking over the session's conversation:
 *   a housekeeping call that looks like the user's chat is worse than a refused title.
 *
 * The classification is the caller's declaration, never an inference. Nothing here derives a purpose
 * from timestamps, message content, headers or project names: those heuristics cannot be correct for
 * a caller this layer does not know, and a wrong guess silently attaches housekeeping work to the
 * user's conversation (or detaches a real turn from it).
 *
 * This module has no provider knowledge and no runtime dependency.
 */

/** The purposes this product's own harness declares, spelled once here for callers and tests. */
export const WEB_CHAT_AUXILIARY_TURN_PURPOSES = ["session-title", "compaction"] as const;

export type WebChatAuxiliaryTurnPurpose = typeof WEB_CHAT_AUXILIARY_TURN_PURPOSES[number];

/** How one turn relates to the session's provider conversation. */
export type WebChatTurnDelivery = "conversational" | "ephemeral";

/**
 * Classify one turn from the purpose its caller declared.
 *
 * @param purpose - the purpose a caller sent with the turn. Absent is the ordinary case: a turn that
 * declares nothing is the user's conversation.
 * @returns `ephemeral` for a declared auxiliary purpose, `conversational` otherwise.
 *
 * The rule is deliberately one-sided: **a declared purpose makes the turn ephemeral**, whether or not
 * this build knows the word, because attaching an unrecognized piece of auxiliary work to the user's
 * conversation is the damaging outcome while merely not retaining it costs a little provider work.
 * A blank or whitespace-only value is not a declaration and stays conversational, so nothing can turn
 * every turn into housekeeping by accident.
 */
export function webChatTurnDeliveryFor(purpose: string | undefined): WebChatTurnDelivery {
  return typeof purpose === "string" && purpose.trim() !== "" ? "ephemeral" : "conversational";
}

/**
 * True for a turn the provider must serve **without** claiming the session's provider conversation
 * (see the module contract for what that requires).
 *
 * Providers call this instead of comparing purpose strings themselves, so "what makes a turn
 * ephemeral" has one owner: a newly declared auxiliary purpose is ephemeral here and nowhere else.
 */
export function isEphemeralWebChatTurn(purpose: string | undefined): boolean {
  return webChatTurnDeliveryFor(purpose) === "ephemeral";
}
