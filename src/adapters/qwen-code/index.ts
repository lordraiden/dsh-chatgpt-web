/**
 * Qwen Code provider (issue #299, slice 1).
 *
 * The public surface of this adapter is deliberately three things and nothing else:
 *
 * - the **identity** (provider/route/driver id and label) a registration and a catalogue row use;
 * - the **interactive sign-in controller** over the neutral `ProviderAuthController` contract;
 * - the **turn-level network proof** (`network-turn.ts`) and its SSE vocabulary.
 *
 * No conversation identity, no affinity, no retention, no routing: those are slice 2's, and they
 * belong to the provider driver, never to `src/web-chat/core/**`.
 */
export {
  QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CODE_AUTH_POLL_INTERVAL_MS,
  QWEN_CODE_AUTH_POLL_TIMEOUT_MS,
  QWEN_CODE_AUTH_PROBE_TIMEOUT_MS,
  QWEN_CODE_AUTH_PROVIDER_LABEL,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_BX_VERSION,
  QWEN_CODE_CHAT_MODE,
  QWEN_CODE_CHAT_TYPE,
  QWEN_CODE_CLIENT_VERSION,
  QWEN_CODE_COMPLETIONS_PATH,
  QWEN_CODE_COMPLETION_VERSION,
  QWEN_CODE_CONFIGS_GIT_PATH,
  QWEN_CODE_DEFAULT_MODEL,
  QWEN_CODE_DRIVER_ID,
  QWEN_CODE_ORIGIN,
  QWEN_CODE_OUTPUT_SCHEMA,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CODE_ROUTE_ID,
  QWEN_CODE_ROOT_URL,
  QWEN_CODE_SUB_CHAT_TYPE,
  QWEN_CODE_TASK_LIST_PATH,
  QWEN_CODE_TASK_NEW_PATH,
  qwenCodeApiHeaders,
  qwenCodeUrl,
} from "./provider";

export {
  createQwenCodeAuthController,
  qwenCodeAuthLaunchArgs,
  qwenTaskListAuthenticated,
  qwenTaskListRefusal,
  type QwenCodeAuthBrowserHandle,
  type QwenCodeAuthBrowserLaunch,
  type QwenCodeAuthBrowserLauncher,
  type QwenCodeAuthControllerOptions,
  type QwenCodeAuthSessionStored,
  type QwenCodeAuthViewport,
  type QwenCodeSessionProbe,
  type QwenCodeSessionProbeResult,
  type QwenCodeSessionStore,
} from "./auth-controller";

export {
  QWEN_CODE_COOKIE_DOMAINS,
  QWEN_CODE_STORAGE_ORIGINS,
  qwenCodeCredentialsDir,
  sanitizeQwenStorageState,
  storeQwenSession,
  validateQwenCodeSessionStorageState,
  type QwenCodeSessionStorageState,
} from "./session-store";

export {
  verifyQwenCodeImportedSession,
  type QwenCodeImportedSessionOptions,
  type QwenCodeImportedSessionProbe,
  type QwenCodeImportedSessionProbeResult,
  type QwenCodeImportedSessionVerification,
} from "./session-import";

export {
  QWEN_COMPLETION_TERMINATIONS,
  QwenSseParser,
  createQwenCompletionAccumulator,
  parseQwenSsePayload,
  type QwenCompletionAccumulator,
  type QwenCompletionAccumulatorOptions,
  type QwenCompletionResult,
  type QwenCompletionTermination,
  type QwenSseFrame,
} from "./sse";

export {
  createQwenPageRequestFacility,
  qwenCodeCompletionRequest,
  runQwenNetworkTurn,
  type QwenCompletionRequest,
  type QwenJsonPostResult,
  type QwenNetworkTurnOptions,
  type QwenNetworkTurnResult,
  type QwenStreamPostResult,
  type QwenTurnMessage,
  type QwenTurnRequestFacility,
} from "./network-turn";
