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
import { providerConfig, validateChatGptWebProviderFacts, type AppConfig } from "./config";
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
  // The scoped block **overrides** the flat block; it does not replace it. A block that states only
  // what it wants to change therefore keeps every value the flat configuration already produced —
  // including the ones that are *derived* rather than configured (the account identity fingerprint
  // read from the stored session), which a whole-block replacement would silently drop.
  const declared = Object.fromEntries(
    Object.entries(scoped as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );
  const merged = { ...provider.chatgptWeb, ...declared } as Record<string, unknown>;

  // A scoped capability state decides the compatibility boolean it implies, unless the scoped block
  // states that boolean itself: then the pair is a genuine contradiction and the shared validator
  // refuses it, which is the project's rule for an explicit tri-state next to an explicit claim.
  const state = declared.capabilityState as
    | { solAvailable?: "supported" | "unsupported" | "unknown"; proAvailable?: "supported" | "unsupported" | "unknown" }
    | undefined;
  if (state) {
    for (const [claim, capability] of [
      ["solAvailable", "solAvailable"],
      ["proAvailable", "proAvailable"],
    ] as const) {
      const claimed = declared[claim];
      const reported = state[capability];
      if (reported === undefined || reported === "unknown") continue;
      const implied = reported === "supported";
      if (claimed === undefined) {
        merged[claim] = implied;
        continue;
      }
      // Both are stated, and they disagree: the block is refused instead of the adapter and the host
      // disagreeing about what this deployment can serve.
      if (claimed !== implied) {
        throw new Error(
          `Invalid capability combination in ${CHATGPT_WEB_SCOPED_CONFIG_PATH}: `
          + `${claim} is ${String(claimed)} while capabilityState.${capability} is ${reported}`,
        );
      }
    }
  }

  // The **merge** is what gets validated, so an incoherence the overlay introduced is refused with
  // the block's location instead of reaching the driver.
  validateChatGptWebProviderFacts(merged, CHATGPT_WEB_SCOPED_CONFIG_PATH);
  return {
    ...provider,
    chatgptWeb: merged as NonNullable<ReturnType<typeof providerConfig>["chatgptWeb"]>,
  };
}
