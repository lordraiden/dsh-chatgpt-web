/**
 * DeepSeek Web (`chat.deepseek.com`) provider.
 *
 * The public surface is deliberately small: the identity a registration and a catalogue row use, the
 * provider facts, the model_type list, the session, the network facility with its **two documented
 * seams**, the stream vocabulary and the turn composition. Nothing here enters
 * `src/web-chat/core/**`: a path, a header name, a payload shape and a proof-of-work contract are
 * provider-private facts.
 *
 * ## What this adapter can and cannot do today
 *
 * It parses the recorded stream, speaks the recorded turn body over the page-context relay, and keeps
 * continuity keyed to `chat_session_id` + `parent_message_id`. It **cannot complete a live turn**:
 * the proof of work is an unproven seam whose default is a typed refusal, and the `Authorization`
 * token's provenance was not measured. `doc/deepseek-web.md` §6 is the exact inventory, with the one
 * observation that settles each point.
 */
export {
  DEEPSEEK_WEB_BUNDLE_COMMIT_ID,
  DEEPSEEK_WEB_COMPLETION_PATH,
  DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES,
  DEEPSEEK_WEB_DRIVER_ID,
  DEEPSEEK_WEB_MAX_ANSWER_CHARS,
  DEEPSEEK_WEB_NAVIGATION_TIMEOUT_MS,
  DEEPSEEK_WEB_ORIGIN,
  DEEPSEEK_WEB_PATCH_OPERATIONS,
  DEEPSEEK_WEB_POW_CHALLENGE_PATH,
  DEEPSEEK_WEB_PROVIDER_ID,
  DEEPSEEK_WEB_PROVIDER_LABEL,
  DEEPSEEK_WEB_RECORDED_BODY_KEYS,
  DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE,
  DEEPSEEK_WEB_ROUTE_ID,
  DEEPSEEK_WEB_ROOT_URL,
  DEEPSEEK_WEB_SESSION_CREATE_PATH,
  DEEPSEEK_WEB_SESSION_ID_PATHS,
  DEEPSEEK_WEB_SSE_EVENTS,
  DEEPSEEK_WEB_UNSENT_BODY_KEYS,
  DEEPSEEK_WEB_USERS_CURRENT_PATH,
  DEEPSEEK_WEB_VIEWPORT,
  deepSeekApiHeaders,
  deepSeekCompletionRequest,
  deepSeekEnvelope,
  deepSeekRefusal,
  deepSeekSessionCreateRequest,
  deepSeekSessionDigest,
  deepSeekTransportFailure,
  deepSeekUrl,
  isDeepSeekPatchOperation,
  readDeepSeekCreatedSessionId,
  readDeepSeekProofChallenge,
  type DeepSeekEnvelope,
  type DeepSeekPatchOperation,
  type DeepSeekProofChallenge,
  type DeepSeekRefusalInput,
  type DeepSeekRefusedOperation,
  type DeepSeekSseEventName,
} from "./provider";

export {
  DEEPSEEK_TERMINATIONS,
  DeepSeekFragmentAssembler,
  DeepSeekProtocolError,
  DeepSeekSseReader,
  createDeepSeekCompletionAccumulator,
  normaliseDeepSeekPatch,
  parseDeepSeekSseEvent,
  type DeepSeekCompletionAccumulator,
  type DeepSeekCompletionAccumulatorOptions,
  type DeepSeekCompletionResult,
  type DeepSeekDeltaPatch,
  type DeepSeekFragment,
  type DeepSeekSseFrame,
  type DeepSeekSseRawEvent,
  type DeepSeekTermination,
} from "./sse";

export {
  DEEPSEEK_WEB_JSON_TIMEOUT_MS,
  createDeepSeekPageRequestFacility,
  unprovenDeepSeekProofOfWork,
  type DeepSeekJsonResult,
  type DeepSeekPageFacilityOptions,
  type DeepSeekProofOfWork,
  type DeepSeekProofOfWorkRequest,
  type DeepSeekProofOfWorkSolver,
  type DeepSeekStreamOpened,
  type DeepSeekStreamPostOptions,
  type DeepSeekStreamResult,
  type DeepSeekTurnRequestFacility,
} from "./network-turn";

export {
  DEEPSEEK_WEB_SIGN_IN_INSTRUCTION,
  createDeepSeekBrowserSession,
  type DeepSeekBrowserSessionOptions,
  type DeepSeekRequestSession,
  type DeepSeekSessionPage,
  type DeepSeekSessionPageOpener,
} from "./session";

export {
  createFileDeepSeekConversationState,
  createMemoryDeepSeekConversationState,
  type DeepSeekConversationEntry,
  type DeepSeekConversationState,
  type DeepSeekSessionRecord,
} from "./chat-state";

export {
  DEEPSEEK_WEB_UNRECORDED_ACCOUNT_FINGERPRINT,
  deepSeekAccountBinding,
  deepSeekCatalogueNote,
  deepSeekCatalogueRows,
  deepSeekCatalogueVisible,
  deepSeekCapturePresent,
  deepSeekExecutionNamespace,
  deepSeekModelDescriptors,
  deepSeekPublicRoutes,
  deepSeekSessionVerified,
  resolveDeepSeekProviderConfig,
  type DeepSeekCatalogueRow,
  type DeepSeekModelType,
  type DeepSeekProviderConfig,
} from "./provider-config";

export { createDeepSeekDriver, deepSeekAffinityKey, deepSeekConversationHandle } from "./driver";

export {
  compileDeepSeekWebReplayPrompt,
  createDeepSeekWebProvider,
  deepSeekWebAffinitySessionId,
  deepSeekWebCatalogueExplanation,
  deepSeekWebDefaultModel,
  deepSeekWebDescriptorOf,
  deepSeekWebReplayHistory,
  deepSeekWebRequestedReasoning,
  DeepSeekWebRequestError,
  type DeepSeekWebProviderComposition,
  type DeepSeekWebProviderOptions,
  type DeepSeekWebResolvedTurn,
} from "./provider-runtime";

export { deepSeekWebResponsesRequest, type DeepSeekWebResponsesRequestOptions } from "./responses";

export {
  DEEPSEEK_WEB_SETTLE_TIMEOUT_MS,
  DEEPSEEK_WEB_TURN_TIMEOUT_MS,
  createDeepSeekWebTextTransport,
  isDeepSeekProtocolError,
  type DeepSeekTurnAnswer,
  type DeepSeekTurnDiagnostic,
  type DeepSeekWebTextTransportOptions,
} from "./text-transport";
