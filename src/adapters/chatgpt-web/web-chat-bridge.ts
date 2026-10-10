/**
 * ChatGPT → WebChat Core bridge (issue #189).
 *
 * The provider-neutral contracts live in `src/web-chat/core`; this module is the provider-local
 * seam that expresses the *existing* ChatGPT path in them, without changing its behaviour and
 * without moving ChatGPT code (issue #192 / PR 4 owns the migration).
 *
 * Every projection here is pure and takes values the ChatGPT owners already produce
 * (`extractChatGptTurnIdentity`, the execution namespace, the account fingerprint of one turn's
 * lease, `ChatGptWebAdapterError` codes). Nothing is re-derived independently, so the bridge cannot
 * become a second source of truth for identity or account state.
 */
import type { CodexParsedRequest } from "../../types";
import type {
  WebChatAccountBinding,
  WebChatAffinityKeyInput,
  WebChatErrorCategory,
  WebChatTurnIdentity,
} from "../../web-chat/core";
import { chatGptConversationKey } from "./conversation-key";
import { extractChatGptTurnIdentity } from "./environment";

/** Values the ChatGPT path already owns and supplies to the projections. */
export interface ChatGptWebChatBindingInput {
  /**
   * Stable provider/account binding identity.
   *
   * The durable binding identity is owned by the conversation-affinity work (issue #190 / PR 2);
   * the ChatGPT path supplies it here instead of the bridge inventing a second one.
   */
  readonly bindingId: string;
  /** Execution namespace of this provider deployment (`chatGptWebExecutionNamespace`). */
  readonly namespace: string;
}

/**
 * One ChatGPT turn expressed as a core turn identity.
 *
 * `threadId` is added on top of the core identity because it is provider-private continuity state
 * the driver needs; the core itself only stores and passes it.
 */
export interface ChatGptWebChatTurnProjection extends WebChatTurnIdentity {
  /** Provider-private logical thread identity this turn belongs to. */
  readonly threadId: string;
}

/**
 * Project one ChatGPT turn into the core turn identity.
 *
 * The conversation key comes from the ChatGPT owner (`chatGptConversationKey`), which derives it
 * through the core's `webChatConversationKey`.
 *
 * @param parsed - the parsed ChatGPT request.
 * @param input - binding identity and execution namespace owned by the ChatGPT path.
 * @returns the core identity plus the provider thread.
 * @throws {Error} when the request carries no provider thread identity, as the ChatGPT path requires.
 */
export function chatGptWebChatTurnIdentity(
  parsed: CodexParsedRequest,
  input: ChatGptWebChatBindingInput,
): ChatGptWebChatTurnProjection {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) {
    throw new Error("The ChatGPT turn has no provider thread identity to project");
  }
  if (!identity.turnId) {
    throw new Error("The ChatGPT turn has no native turn identity to project");
  }
  if (!input.bindingId) {
    throw new Error("The ChatGPT turn projection requires a provider/account binding identity");
  }
  const conversationKey = chatGptConversationKey(parsed, input.namespace);
  return {
    bindingId: input.bindingId,
    turnId: identity.turnId,
    threadId: identity.threadId,
    ...(identity.dshSessionId !== undefined ? { dshSessionId: identity.dshSessionId } : {}),
    ...(conversationKey !== undefined ? { conversationKey } : {}),
  };
}

/**
 * Project one ChatGPT turn into the canonical provider-neutral affinity (architecture §7).
 *
 * The affinity carries the provider, the account binding, the host session and the provider thread,
 * so a later migration can address the same conversation through the core key while the ChatGPT
 * path keeps its own legacy thread key until the driver migration (issue #192).
 *
 * @param parsed - the parsed ChatGPT request.
 * @param input - provider id, binding identity and execution namespace of the ChatGPT path.
 * @returns the core affinity key input.
 * @throws {Error} when the turn carries no host session or provider thread identity.
 */
export function chatGptWebChatAffinity(
  parsed: CodexParsedRequest,
  input: ChatGptWebChatBindingInput & { readonly providerId: string },
): WebChatAffinityKeyInput {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) {
    throw new Error("The ChatGPT turn has no provider thread identity to project");
  }
  if (!identity.dshSessionId) {
    throw new Error("The ChatGPT turn has no host session identity to project");
  }
  if (!input.providerId) throw new Error("The ChatGPT affinity requires the provider identity");
  if (!input.bindingId) throw new Error("The ChatGPT affinity requires a provider/account binding identity");
  return {
    providerId: input.providerId,
    bindingId: input.bindingId,
    dshSessionId: identity.dshSessionId,
    threadId: identity.threadId,
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
  };
}

/**
 * Project the ChatGPT account/browser identity into the core account binding.
 *
 * The caller passes the values the ChatGPT path already computed for one turn's lease
 * (`browserAccountLeaseInput`) plus the provider id it already owns; nothing here reads
 * configuration by itself, and the id is not duplicated as a second constant.
 */
export function chatGptWebChatAccountBinding(input: {
  readonly providerId: string;
  readonly accountFingerprint: string;
  readonly browserProfile?: string;
  readonly browserContext?: string;
}): WebChatAccountBinding {
  if (!input.providerId) throw new Error("The ChatGPT account binding requires the provider identity");
  if (!input.accountFingerprint) {
    throw new Error("The ChatGPT account binding requires the authenticated account fingerprint");
  }
  return {
    providerId: input.providerId,
    accountFingerprint: input.accountFingerprint,
    ...(input.browserProfile !== undefined ? { browserProfile: input.browserProfile } : {}),
    ...(input.browserContext !== undefined ? { browserContext: input.browserContext } : {}),
  };
}

/** Core category for every ChatGPT failure code the common layer can classify. */
const CHATGPT_WEB_CHAT_CATEGORY_BY_CODE: Readonly<Record<string, WebChatErrorCategory>> = {
  // Authentication and account availability.
  chatgpt_session_expired: "AUTH_EXPIRED",
  chatgpt_subscription_unavailable: "ACCOUNT_UNAVAILABLE",
  rate_limit_exceeded: "UPSTREAM_RATE_LIMITED",
  // Request and context admission.
  context_length_exceeded: "INPUT_TOO_LARGE",
  context_budget_exceeded: "INPUT_TOO_LARGE",
  context_compaction_required: "INPUT_TOO_LARGE",
  context_exhausted: "INPUT_TOO_LARGE",
  context_unsupported_content: "UNSUPPORTED_OPTION",
  invalid_output_schema: "UNSUPPORTED_OPTION",
  structured_output_validation_failed: "UNSUPPORTED_OPTION",
  manual_multipart_unsupported: "UNSUPPORTED_OPTION",
  browser_interaction_mode_mismatch: "UNSUPPORTED_OPTION",
  // Conversation continuity and state.
  retained_surface_lost: "CONVERSATION_LOST",
  retained_delta_empty: "CONVERSATION_STATE_MISMATCH",
  chatgpt_surface_stale: "CONVERSATION_STATE_MISMATCH",
  context_canonical_state_missing: "CONVERSATION_STATE_MISMATCH",
  compaction_source_unavailable: "CONVERSATION_STATE_MISMATCH",
  retained_surface_busy: "TRANSPORT_UNAVAILABLE",
  // Submission and response.
  chatgpt_submission_ambiguous: "SUBMISSION_AMBIGUOUS",
  chatgpt_submitted_turn_failed: "UPSTREAM_ERROR",
  answer_recovery_unavailable: "RESPONSE_TIMEOUT",
  codex_tool_timeout: "RESPONSE_TIMEOUT",
  compaction_handoff_timeout: "RESPONSE_TIMEOUT",
  manual_handoff_timeout: "RESPONSE_TIMEOUT",
  // Transport and upstream.
  manual_launcher_failed: "TRANSPORT_UNAVAILABLE",
  connector_not_found: "TRANSPORT_UNAVAILABLE",
  upstream_server_error: "UPSTREAM_ERROR",
  multipart_protocol_violation: "UPSTREAM_ERROR",
  prompt_attachment_integrity: "UPSTREAM_ERROR",
  compaction_control_unavailable: "UPSTREAM_ERROR",
  compaction_handoff_failed: "UPSTREAM_ERROR",
  // Cancellation.
  client_cancelled: "CANCELLED",
  aborted: "CANCELLED",
  manual_turn_cancelled: "CANCELLED",
};

/** Every ChatGPT failure code the bridge classifies. */
export const CHATGPT_WEB_CHAT_CLASSIFIED_CODES = Object.keys(
  CHATGPT_WEB_CHAT_CATEGORY_BY_CODE,
) as readonly string[];

/**
 * ChatGPT failure codes deliberately outside the common text-only layer, with the reason.
 *
 * The Advisor surface (architecture §20) is a ChatGPT-specific control API rather than a text turn,
 * so its failures are never classified as WebChat exchange failures.
 */
export const CHATGPT_WEB_CHAT_UNCLASSIFIED_CODES: Readonly<Record<string, string>> = {
  advisor_input_invalid: "Advisor control surface, not a text turn (architecture §20)",
  advisor_turn_failed: "Advisor control surface, not a text turn (architecture §20)",
  advisor_recovery_unavailable: "Advisor control surface, not a text turn (architecture §20)",
};

/**
 * Category used for a provider failure the bridge does not classify.
 *
 * An unclassified ChatGPT failure is still an upstream failure; its provider code stays attached as
 * diagnostic detail. The contract test scans the provider's declared codes and fails when a new one
 * lands here instead of in the table.
 */
export const CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT: WebChatErrorCategory = "UPSTREAM_ERROR";

/**
 * Classify a ChatGPT failure into a core category.
 *
 * @param failure - a ChatGPT adapter error, a normalized `{code}` payload, or a raw code.
 * @returns the shared category.
 */
export function classifyChatGptWebFailure(
  failure: { readonly code?: string | null } | string | null | undefined,
): WebChatErrorCategory {
  const code = typeof failure === "string" ? failure : failure?.code ?? undefined;
  if (!code) return CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT;
  return CHATGPT_WEB_CHAT_CATEGORY_BY_CODE[code] ?? CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT;
}
