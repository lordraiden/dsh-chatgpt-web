export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT remained in 'Stopped thinking' for 5 seconds, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export const CHATGPT_CONTEXT_EXHAUSTED_CODE = "context_exhausted";

export function chatGptContextExhaustedError(message = "The current ChatGPT Web conversation has reached its product context limit and must be replaced before the DSH turn can continue."): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 409,
    errorType: "invalid_request_error",
    code: CHATGPT_CONTEXT_EXHAUSTED_CODE,
    retryable: false,
  });
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}

export const CHATGPT_RETAINED_DELTA_EMPTY_CODE = "retained_delta_empty";

/**
 * A retained continuation turn sanitized to no human content. Inside a
 * retained physical conversation the composer transport may only carry the
 * new human content — there is no envelope to fall back to (issue #172).
 * The turn fails explicitly instead of re-introducing the legacy transport.
 */
export function chatGptRetainedDeltaEmptyError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT Web continuation carried no human content to send; the turn was not submitted.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: CHATGPT_RETAINED_DELTA_EMPTY_CODE,
      retryable: false,
    },
  );
}

export const CHATGPT_CONTINUATION_PROMPT_MISSING_CODE = "continuation_prompt_missing";

/**
 * A retained ChatGPT surface was reused for a turn that carried no continuation prompt to send.
 *
 * This is a **local continuity failure**, not an upstream one: the provider conversation was kept,
 * nothing was submitted and ChatGPT never saw the request, so the caller can send the next human
 * turn and retry. It used to be a bare `Error` thrown at the transport, which the API normalized
 * into `502 upstream_server_error` and thereby blamed ChatGPT for a local decision (issue #302).
 */
export function chatGptContinuationPromptMissingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "This turn reused the retained ChatGPT conversation but carried no new human turn to send (it has no continuation prompt). Send the next user message as a new turn; nothing reached ChatGPT.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: CHATGPT_CONTINUATION_PROMPT_MISSING_CODE,
      retryable: false,
    },
  );
}

export const CHATGPT_ANSWER_RECOVERY_UNAVAILABLE_CODE = "answer_recovery_unavailable";

/**
 * No finalized answer could be read from the retained ChatGPT conversation within the recovery
 * window: the conversation exists but its render never exposed a finalized assistant turn in
 * time. Read-only failure — nothing was submitted, navigated or created, so asking again later
 * (once ChatGPT finishes) is safe.
 */
export function chatGptAnswerRecoveryUnavailableError(timeoutMs: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `The retained ChatGPT Web conversation did not expose a finalized answer within ${timeoutMs} ms.`,
    {
      status: 409,
      errorType: "invalid_request_error",
      code: CHATGPT_ANSWER_RECOVERY_UNAVAILABLE_CODE,
      retryable: false,
    },
  );
}

export const CHATGPT_SETTLEMENT_WAIT_TIMEOUT_CODE = "settlement_wait_timeout";

/**
 * A turn waited for another turn's *physical settlement* longer than the settlement-wait grace, so
 * the retained ChatGPT conversation could not be safely handed over (issue #301).
 *
 * This is the service's own stuck-resource category, never an upstream one: nothing was submitted
 * and ChatGPT never saw the request. The wedged session is retired (its runtime cancelled, so the
 * physical owner aborts and publishes a `rejected` settlement) and the key is not reused, but the
 * retained page itself may still finish its teardown — so the caller is told to retry after that
 * rather than being told the provider failed.
 */
export function chatGptSettlementWaitTimeoutError(graceMs: number, phase: string, traceId?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `A previous ChatGPT Web turn did not publish its physical settlement within ${graceMs} ms (${phase})`
    + `${traceId ? ` for turn ${traceId}` : ""}. The retained conversation was retired instead of being `
    + "handed to this turn, so nothing was submitted. Wait for the stuck turn to finish, then retry; if it "
    + "does not clear, restart the service and replay the conversation.",
    {
      status: 503,
      errorType: "server_error",
      code: CHATGPT_SETTLEMENT_WAIT_TIMEOUT_CODE,
      retryable: false,
    },
  );
}

export const CHATGPT_RETAINED_SURFACE_LOST_CODE = "retained_surface_lost";

/**
 * A previously retained managed-chrome surface died, so the visible ChatGPT
 * conversation can no longer be continued. This is an explicit continuity
 * failure: the turn must not fall back to a silently created new conversation.
 */
export function chatGptRetainedSurfaceLostError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT Web conversation was lost and can no longer be continued.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: CHATGPT_RETAINED_SURFACE_LOST_CODE,
      retryable: false,
    },
  );
}

export const CHATGPT_RETAINED_SURFACE_BUSY_CODE = "retained_surface_busy";

/** Two turns of the same DSH chat raced for the one retained managed-chrome surface. */
export function chatGptRetainedSurfaceBusyError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not allowed.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: CHATGPT_RETAINED_SURFACE_BUSY_CODE,
      retryable: false,
    },
  );
}

/**
 * The Temporary Chat surface rehydrated the conversation mid-turn ("Loading chats" / "Loading
 * profile"), so the already-sent prompt and its in-flight generation were lost to a page reload.
 * Unlike a terminal adapter failure, this is recoverable: reloading a fresh Temporary Chat
 * document and resubmitting the same prompt starts a clean turn. The run loop treats this as a
 * bounded-retry signal rather than a user-facing error.
 */
export class ChatGptSurfaceStaleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptSurfaceStaleError";
  }
}
