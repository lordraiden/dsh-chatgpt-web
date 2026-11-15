/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 *
 * The bound is per authenticated account, not per DSH chat: one account serves several DSH
 * chats, each on its own retained page. Isolation inside one conversation is owned elsewhere:
 * `RetainedSurfaceRegistry` rejects a second turn on a busy conversationKey (issue #171) and
 * `ProviderCore` rejects a second turn for an active native DSH thread.
 *
 * ## The bound is a rate, so it has a queue in front of it (issue #358)
 *
 * An immediate refusal is the wrong answer to "five turns are in flight right now": the condition is
 * transient, and a fan-out caller that retries immediately makes the burst worse. `ProviderCore` now
 * fronts this bound with a bounded, cancellable wait (`turn-queue.ts`): a turn that finds the account
 * full waits for a slot up to a configured budget, and only then is refused — with a typed 429 carrying
 * `Retry-After` and a stable code, which is what an OpenAI-compatible caller can act on.
 *
 * The queue decides only **when** a turn may ask for a lease. It never acquires one, never executes,
 * never retries, and never counts capacity itself: it reads this bound's live lease count and is woken
 * by the lease registry's releases. The refusal below therefore stays where it always was, as the
 * last-resort guard for a caller that reached the bound without waiting (a direct `begin`, a defect in
 * the queue, a test), and the number below stays the one authority for the fan-out ceiling.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

/**
 * The last-resort refusal for exceeding the account fan-out bound.
 *
 * Shared by every enforcement site so the user reads the same sentence whichever layer rejects the
 * turn. A turn that arrives through the normal path does not see it: the wait queue refuses first,
 * with the typed 429 backpressure described above. It remains a bare `Error` on purpose — it is a
 * guard against a bypassed queue, not a caller-facing classification.
 *
 * @returns a fresh error; callers throw it as-is.
 */
export function chatGptBrowserTurnLimitError(): Error {
  return new Error(
    `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; `
    + "close or finish a browser tab before starting another",
  );
}
