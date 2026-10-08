/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 *
 * The bound is per authenticated account, not per DSH chat: one account serves several DSH
 * chats, each on its own retained page. Isolation inside one conversation is owned elsewhere:
 * `RetainedSurfaceRegistry` rejects a second turn on a busy conversationKey (issue #171) and
 * `ProviderCore` rejects a second turn for an active native DSH thread.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

/**
 * The one refusal for exceeding the account fan-out bound. Shared by every enforcement site
 * so the user reads the same sentence whichever layer rejects the turn.
 * @returns a fresh error; callers throw it as-is.
 */
export function chatGptBrowserTurnLimitError(): Error {
  return new Error(
    `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; `
    + "close or finish a browser tab before starting another",
  );
}
