/**
 * The effective ChatGPT conversation visibility of one provider configuration (issue #355).
 *
 * `chatVisibility` is a provider fact, so it has exactly one resolver: the configuration module
 * (`providerConfig` + `validateChatGptWebProviderFacts` + `mergeChatGptWebProviderFacts`), with the
 * provider-scoped overlay applied by `effectiveChatGptWebProviderConfig`. This module only *reads* the
 * resolved fact for the provider's own consumers (the browser surface, the retention decision, the
 * continuity decision and the driver), so none of them re-decides what "absent" means.
 *
 * Absent means `"persistent"` — today's behaviour — which is why the projection omits the fact when it
 * was never authored and this reader treats anything that is not `"temporary"` as persistent. A value
 * that is neither mode cannot reach here: the configuration validator refuses it with its location.
 */
import type { ChatGptWebChatVisibility, CodexProviderConfig } from "../../types";

/** The visibility a configuration that never states the fact runs in. */
export const CHATGPT_WEB_CHAT_VISIBILITY_DEFAULT: ChatGptWebChatVisibility = "persistent";

/**
 * The visibility mode one provider configuration runs in.
 *
 * @param provider - the resolved provider facts (`providerConfig` or the effective configuration).
 * @returns `"temporary"` only when the resolved fact says so; `"persistent"` otherwise.
 */
export function chatGptWebChatVisibility(provider: CodexProviderConfig): ChatGptWebChatVisibility {
  return provider.chatgptWeb?.chatVisibility === "temporary" ? "temporary" : CHATGPT_WEB_CHAT_VISIBILITY_DEFAULT;
}

/**
 * Whether this provider configuration runs on ChatGPT's Temporary Chat surface.
 *
 * A temporary surface is deliberately **not** a resumable provider conversation: the provider claims
 * no conversation key for it, records no installed-prefix fingerprint and publishes no conversation
 * handle, and each turn is rebuilt explicitly from the caller's canonical history instead.
 *
 * @param provider - the resolved provider facts.
 * @returns whether turns land on the temporary surface.
 */
export function chatGptWebChatIsTemporary(provider: CodexProviderConfig): boolean {
  return chatGptWebChatVisibility(provider) === "temporary";
}
