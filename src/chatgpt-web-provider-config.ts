/**
 * The single resolver of the effective ChatGPT Web provider configuration (issue #193).
 *
 * Every seam that needs ChatGPT Web **provider facts** — the DSH LLM adapter and its driver, the
 * model catalogue behind `/v1/models`, the Responses ingress (`/v1/responses`) and the private native
 * DSH loopback (`/internal/native-llm`) — resolves them here, so a provider-scoped block cannot reach
 * one seam and miss another.
 *
 * What this module owns, and what it deliberately does not:
 *
 * - it produces **provider facts only**: the same `CodexProviderConfig` shape `providerConfig(config)`
 *   produces. A provider-scoped `webChat.providers["chatgpt-web"]` block **overrides** the flat
 *   `chatgptWeb` block field by field — the fields it does not state keep the flat value, including the
 *   derived ones (the account identity fingerprint) — and the merged block, not the scoped payload
 *   alone, is what the shared validator checks. Without `webChat` the result is structurally
 *   `providerConfig(config)` unchanged;
 * - it is **not** a second routing authority. `ctx.llm` remains the public provider registry and route
 *   dispatch authority, and the sidecar remains the execution authority; callers derive their own
 *   provider-scoped views (routes, catalogue) from these facts exactly as they derived them from
 *   `providerConfig` before.
 *
 * Resolution happens **per call, never cached**, so a live reload is observed by the next turn — for
 * example the control API mutating the in-memory `tuning`, over which a scoped `tuning` keeps winning.
 *
 * A scoped block is validated before it is used, through the same owner the flat block uses
 * (`validateChatGptWebProviderFacts`): a malformed internal value or an incoherent capability
 * combination is refused with its location instead of being cast into the driver. A scoped payload that
 * is not an object keeps the host boundary's previously documented fail-closed behavior: the flat
 * block stays effective rather than an unusable provider being produced.
 */
import { mergeChatGptWebProviderFacts, providerConfig, type AppConfig } from "./config";
import { CHATGPT_WEB_DRIVER_ID, resolveWebChatProviderConfig } from "./web-chat/host/dsh-integration";

/** The configuration location named when a provider-scoped block is refused. */
export const CHATGPT_WEB_SCOPED_CONFIG_PATH = `webChat.providers["${CHATGPT_WEB_DRIVER_ID}"]`;

/**
 * Resolve the provider facts the ChatGPT Web route actually uses for one configuration.
 *
 * @param config - the effective application configuration, read at the point of use.
 * @returns `providerConfig(config)` with the provider-scoped WebChat block substituted when one is
 *   configured for this route.
 * @throws {Error} when a configured provider-scoped block is malformed or incoherent; the message
 *   names the block's location.
 */
export function effectiveChatGptWebProviderConfig(config: AppConfig): ReturnType<typeof providerConfig> {
  const provider = providerConfig(config);
  const scoped = resolveWebChatProviderConfig(
    { webChat: config.webChat, chatgptWeb: provider.chatgptWeb },
    CHATGPT_WEB_DRIVER_ID,
  );
  if (scoped === provider.chatgptWeb || !scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return provider;
  }
  // Shared merge/validation preserves derived base facts and checks invariants only after overlay.
  const merged = mergeChatGptWebProviderFacts(
    provider.chatgptWeb as unknown as Record<string, unknown>,
    scoped,
    CHATGPT_WEB_SCOPED_CONFIG_PATH,
  );
  return {
    ...provider,
    chatgptWeb: merged as NonNullable<ReturnType<typeof providerConfig>["chatgptWeb"]>,
  };
}
