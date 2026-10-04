import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * Provider-specific error classification only.
 *
 * Retry ownership lives in ProviderCore. This module deliberately cannot count attempts,
 * authorize replay, or trigger another physical execution.
 */
export function classifyChatGptWebRetry(error: ChatGptWebAdapterError): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(error.message, {
    status: error.status,
    errorType: error.errorType,
    code: error.code,
    retryable: error.retryable,
    cause: error,
  });
}
