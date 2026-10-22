/**
 * Qwen Chat (`chat.qwen.ai`) provider.
 *
 * The public surface is deliberately small: the identity a registration and a catalogue row use, the
 * interactive sign-in controller, the model list, and the turn composition. Nothing here enters
 * `src/web-chat/core/**`: a path, a header name and a payload shape are provider-private facts.
 */
export {
  QWEN_CHAT_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CHAT_AUTH_POLL_INTERVAL_MS,
  QWEN_CHAT_AUTH_POLL_TIMEOUT_MS,
  QWEN_CHAT_AUTH_PROBE_TIMEOUT_MS,
  QWEN_CHAT_AUTH_PROVIDER_LABEL,
  QWEN_CHAT_AUTH_VIEWPORT,
  QWEN_CHAT_CHATS_MAX_ANSWER_CHARS,
  QWEN_CHAT_CHATS_NEW_PATH,
  QWEN_CHAT_CHATS_PATH,
  QWEN_CHAT_CHAT_MODE,
  QWEN_CHAT_CHAT_TYPE,
  QWEN_CHAT_CLIENT_VERSION,
  QWEN_CHAT_COMPLETIONS_PATH,
  QWEN_CHAT_COMPLETION_VERSION,
  QWEN_CHAT_DRIVER_ID,
  QWEN_CHAT_LEGACY_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CHAT_MODELS_PATH,
  QWEN_CHAT_MODELS_V1_PATH,
  QWEN_CHAT_MODES,
  QWEN_CHAT_ORIGIN,
  QWEN_CHAT_OUTPUT_SCHEMA,
  QWEN_CHAT_PROVIDER_ID,
  QWEN_CHAT_ROUTE_ID,
  QWEN_CHAT_ROOT_URL,
  QWEN_CHAT_SESSION_HYDRATION_POLL_INTERVAL_MS,
  QWEN_CHAT_SESSION_HYDRATION_TIMEOUT_MS,
  QWEN_CHAT_SOURCE,
  QWEN_CHAT_SUB_CHAT_TYPE,
  isQwenChatMode,
  qwenChatApiHeaders,
  qwenChatDefaultMode,
  qwenChatFeatureConfig,
  qwenChatModesForModel,
  qwenChatThinkingAbility,
  qwenChatUrl,
  type QwenChatMode,
  type QwenChatModelAbilities,
  type QwenThinkingAbility,
} from "./provider";

export {
  QWEN_CHAT_SEED_MODELS,
  parseQwenChatModelsFile,
  parseQwenChatPublicModels,
  qwenChatEntryModes,
  qwenChatModelList,
  qwenChatPublicModelArray,
  readQwenChatModelsFile,
  refreshQwenChatModels,
  writeQwenChatModelsFile,
  type QwenChatFetch,
  type QwenChatModelEntry,
  type QwenChatRefreshOptions,
} from "./models";

export {
  QWEN_CHAT_COOKIE_DOMAINS,
  QWEN_CHAT_STORAGE_ORIGINS,
  qwenChatCredentialsDir,
  sanitizeQwenChatStorageState,
  storeQwenChatSession,
  validateQwenChatSessionStorageState,
  type QwenChatSessionStorageState,
} from "./session-store";

export {
  awaitQwenPageSession,
  createQwenChatPageProbeSender,
  probeQwenChat,
  probeQwenChatFromPage,
  probeQwenChatFromPageAfterHydration,
  qwenChatAuthenticated,
  qwenChatProbeRefusal,
  qwenChatProbeRequest,
  qwenChatProbeVerdict,
  readQwenAccessTokenFromPage,
  type QwenChatProbeObservation,
  type QwenChatProbeReadSource,
  type QwenChatProbeRequest,
  type QwenChatProbeSender,
} from "./session-probe";

export {
  verifyQwenChatImportedSession,
  type QwenChatImportedSessionOptions,
  type QwenChatImportedSessionPage,
  type QwenChatImportedSessionPageOpener,
  type QwenChatImportedSessionProbe,
  type QwenChatImportedSessionProbeResult,
  type QwenChatImportedSessionVerification,
} from "./session-import";

export {
  createQwenChatBrowserSession,
  QWEN_CHAT_SIGN_IN_INSTRUCTION,
  type QwenChatBrowserSessionOptions,
  type QwenChatRequestSession,
  type QwenChatSessionPage,
  type QwenChatSessionPageOpener,
} from "./browser-session";

export {
  createQwenChatPageRequestFacility,
  qwenChatChatNewRequest,
  qwenChatCompletionPath,
  qwenChatCompletionRequest,
  qwenChatEmptyStream,
  qwenChatRefusal,
  qwenChatTransportFailure,
  readQwenChatCreatedChatId,
  readQwenChatRefusal,
  type QwenChatCompletionRequest,
  type QwenChatJsonPostResult,
  type QwenChatRefusalInput,
  type QwenChatRefusalKind,
  type QwenChatRefusalRead,
  type QwenChatRefusalWhat,
  type QwenChatStreamOpened,
  type QwenChatStreamPostOptions,
  type QwenChatStreamPostResult,
  type QwenChatTurnMessage,
  type QwenChatTurnRequestFacility,
} from "./network-turn";

export {
  QWEN_CHAT_ANSWER_PHASES,
  QWEN_CHAT_FRAME_SHAPE_CHARS,
  QWEN_CHAT_REASONING_PHASES,
  QWEN_CHAT_SHAPES_SHOWN,
  QWEN_CHAT_TERMINATIONS,
  QWEN_CHAT_TERMINAL_STATUS,
  QwenChatSseParser,
  createQwenChatCompletionAccumulator,
  parseQwenChatSsePayload,
  qwenChatDeltaCarriesAnswer,
  qwenChatDeltaClosesTurn,
  qwenChatEmptyStreamSummary,
  qwenChatFrameShape,
  type QwenChatCompletionAccumulator,
  type QwenChatCompletionAccumulatorOptions,
  type QwenChatCompletionResult,
  type QwenChatEmptyStreamDetail,
  type QwenChatFrameShapeCount,
  type QwenChatSseFrame,
  type QwenChatStreamObservation,
  type QwenChatTermination,
} from "./sse";

export {
  createQwenChatTextTransport,
  qwenChatChatDigest,
  QWEN_CHAT_SETTLE_TIMEOUT_MS,
  QWEN_CHAT_TURN_TIMEOUT_MS,
  type QwenChatTextTransportOptions,
  type QwenChatTurnAnswer,
  type QwenChatTurnDiagnostic,
} from "./text-transport";

export {
  createFileQwenChatConversationState,
  createMemoryQwenChatConversationState,
  type QwenChatChatRecord,
  type QwenChatConversationEntry,
  type QwenChatConversationState,
} from "./chat-state";

export {
  QWEN_CHAT_UNRECORDED_ACCOUNT_FINGERPRINT,
  qwenChatAccountBinding,
  qwenChatCatalogueRows,
  qwenChatCatalogueVisible,
  qwenChatExecutionNamespace,
  qwenChatModelDescriptors,
  qwenChatPublicRoutes,
  qwenChatSessionVerified,
  resolveQwenChatProviderConfig,
  type QwenChatCatalogueRow,
  type QwenChatProviderConfig,
} from "./provider-config";

export { createQwenChatDriver, qwenChatAffinityKey, qwenChatConversationHandle } from "./driver";

export {
  compileQwenChatReplayPrompt,
  createQwenChatProvider,
  qwenChatAffinitySessionId,
  qwenChatDefaultModel,
  qwenChatDescriptorOf,
  qwenChatReplayHistory,
  qwenChatRequestedMode,
  qwenChatTurnMode,
  QwenChatRequestError,
  type QwenChatProviderComposition,
  type QwenChatProviderOptions,
  type QwenChatResolvedTurn,
} from "./provider-runtime";

export { qwenChatResponsesRequest, type QwenChatResponsesRequestOptions } from "./responses";

export {
  createQwenChatAuthController,
  qwenChatCredentialsDir as qwenChatAuthCredentialsDir,
  type QwenChatAuthControllerOptions,
} from "./auth-controller";
