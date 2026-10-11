/**
 * Provider-neutral WebChat Core (architecture §8, §18).
 *
 * This is the semantic layer every text-only web chat provider implements. It knows nothing about
 * a provider: no browser page, no DOM selector, no endpoint schema, no credentials, no provider
 * DTO, no tools/files/images, no provider-native agent loop (architecture §18.1).
 *
 * Ownership boundaries, stated once here because the whole core depends on them:
 *
 * - The host runtime owns provider selection, model routing and retry policy; the core only
 *   resolves an already-selected route to a driver (`resolver.ts`).
 * - Conversation affinity, durable continuation and generations are contracted here but decided by
 *   the conversation-affinity work (issue #190 / PR 2).
 * - The exchange state machine, transport readiness and physical settlement are contracted here but
 *   implemented by the exchange lifecycle work (issue #191 / PR 3).
 * - Provider drivers are implemented by the provider migrations (issue #192 and later).
 * - The core is never a transcript store: canonical history stays with the host, and
 *   `replayHistory` is only an input.
 */

export {
  WEB_CHAT_ERROR_CATEGORIES,
  WebChatError,
  isWebChatError,
  webChatError,
  type WebChatErrorCategory,
  type WebChatErrorOptions,
} from "./errors";

export {
  WEB_CHAT_EXCHANGE_EVENT_TYPES,
  isWebChatExchangeEventType,
  type WebChatExchangeEvent,
  type WebChatExchangeEventType,
  type WebChatExchangeCancelledEvent,
  type WebChatExchangeCompletedEvent,
  type WebChatExchangeErrorEvent,
  type WebChatExchangeReadyEvent,
  type WebChatExchangeSubmittedEvent,
  type WebChatExchangeTextDeltaEvent,
} from "./events";

export {
  assertTextOnlyWebChatTurn,
  rejectUnsupportedWebChatFeatures,
  type WebChatExchange,
  type WebChatReplayMessage,
  type WebChatTurnCandidate,
  type WebChatTurnIdentity,
  type WebChatTurnInput,
} from "./exchange";

export {
  webChatConversationHandle,
  type WebChatAccountBinding,
  type WebChatConversation,
  type WebChatConversationAffinity,
  type WebChatConversationHandle,
  type WebChatConversationStatus,
  type WebChatDshSessionIdentity,
} from "./conversation";

export { webChatConversationKey } from "./conversation-key";

export {
  isWebChatModelDescriptor,
  type WebChatModelDescriptor,
  type WebChatReasoningMode,
} from "./model";

export {
  assertWebChatReplayStateOwner,
  isWebChatProviderReplayState,
  webChatReplayStateOwnedBy,
  type WebChatAccountInspection,
  type WebChatConversationAssessment,
  type WebChatConversationAssessmentInput,
  type WebChatConversationCreateInput,
  type WebChatConversationReplayInput,
  type WebChatConversationResumeInput,
  type WebChatConversationSelection,
  type WebChatProviderDriver,
  type WebChatProviderHealth,
  type WebChatProviderReplayState,
  type WebChatReplayStateOwner,
} from "./provider";

export { createWebChatDriverResolver, type WebChatDriverResolver } from "./resolver";
