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
