/**
 * Failure mapping between the service's HTTP/SSE errors and DSH's provider-neutral LLM taxonomy.
 *
 * The service has two error shapes and they must be read differently (doc/plugin.md §3.2):
 *
 * - a **pre-turn rejection** carries an HTTP status and `{error:{message,type,code}}`; the `code` is
 *   authoritative and the status is only a hint, because `/v1/chat/completions` re-derives the status
 *   from the code (a `context_exhausted` adapter failure arrives as HTTP 400, not 409);
 * - a **failure after the turn was accepted** arrives with HTTP 200 and `data: {"error":{message,type}}`
 *   — no `code` at all — so it can only be classified from `type` and `message`.
 *
 * The adapter must never retry a submitted turn, so this module produces stable, typed `LlmError`s
 * and leaves the retry decision to the caller; the adapter's own retry policy disables DSH retries.
 *
 * Two names the design notes use are not part of `BuiltinLlmFailureCode` in the installed
 * `@deepseek-ai/dsh-llm` (0.2.2-rc.3/rc.4): `NO_MODEL` and `PROTOCOL_ERROR`. The canonical codes with
 * the same meaning are exported here as {@link MODEL_NOT_FOUND_CODE} and {@link PROTOCOL_ERROR_CODE}
 * so callers and tests name the intent once instead of spelling a non-existent code.
 */
import {
  LlmError,
  ProviderRequestId,
  isContextWindowExceededError,
  isQuotaExceededError,
  type BuiltinLlmFailureCode,
  type LlmErrorOptions,
} from '@deepseek-ai/dsh-llm'

/** Prefix shared by every diagnostic this plugin raises. */
const PKG = 'dsh-chatgpt-web'

/** Bound applied to a provider-supplied message before it enters an error; never a message body. */
const DETAIL_LIMIT = 300

/**
 * The code for "the service catalogue does not offer this model (or cannot be read)".
 *
 * The design notes call this `NO_MODEL`, but `@deepseek-ai/dsh-llm` has no such built-in code; the
 * canonical code for a model that cannot be resolved is `UNKNOWN_MODEL`. Never invent a
 * `contextWindow` instead of failing: DSH compaction depends on the declared window.
 */
export const MODEL_NOT_FOUND_CODE: BuiltinLlmFailureCode = 'UNKNOWN_MODEL'

/**
 * The code for a stream frame that is not valid JSON.
 *
 * The design notes call this `PROTOCOL_ERROR`; the canonical `BuiltinLlmFailureCode` for a response
 * that violates the wire protocol is `MALFORMED_RESPONSE`.
 */
export const PROTOCOL_ERROR_CODE: BuiltinLlmFailureCode = 'MALFORMED_RESPONSE'

/** The `error` object of the service's error envelope, as far as the adapter reads it. */
export interface ServiceErrorEnvelope {
  readonly message: string
  readonly type?: string
  readonly code?: string
}

/**
 * Read the service's `{error:{message,type,code}}` envelope out of a response body.
 * @param body - the raw response body; it may be empty, non-JSON or a different JSON shape.
 * @returns the envelope when the body is the documented shape, otherwise `undefined`.
 */
export function readErrorEnvelope(body: string): ServiceErrorEnvelope | undefined {
  if (body.trim() === '') return undefined
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return undefined
  }
  const error = asRecord(asRecord(payload)?.error)
  if (error === undefined) return undefined
  const message = typeof error.message === 'string' ? error.message : ''
  const type = typeof error.type === 'string' && error.type.trim() !== '' ? error.type.trim() : undefined
  const code = typeof error.code === 'string' && error.code.trim() !== '' ? error.code.trim() : undefined
  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  }
}

/**
 * Parse a `retry-after` header into the millisecond delay DSH expects.
 *
 * Both HTTP forms are accepted: delay-seconds (including a decimal, which some proxies emit) and an
 * HTTP-date. A non-positive or unparseable value is treated as absent, because `LlmError` rejects a
 * non-positive `providerRetryAfterMs`.
 * @param value - the header value, or `null` when the header is absent.
 * @returns the positive delay in milliseconds, or `undefined`.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const delay = Number(trimmed) * 1000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  const delay = at - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/**
 * Map one service failure code (or, when the wire carries none, its `type`/`message`) onto a
 * provider-neutral DSH failure code.
 *
 * The explicit service codes win over the wording heuristics, except for the generic
 * `invalid_request_error` code: the service uses it for every malformed request, including
 * "Unknown model" and context overflow, so the message is consulted before that generic fallback.
 * @param code - the service's `error.code`, when the wire carries one.
 * @param type - the service's `error.type`.
 * @param message - the service's `error.message` (never a conversation body).
 * @returns the mapped code, or `undefined` when nothing identifies the failure.
 */
export function mapServiceFailureCode(
  code: string | undefined,
  type: string | undefined,
  message: string,
): BuiltinLlmFailureCode | undefined {
  const normalizedCode = typeof code === 'string' ? code.trim().toLowerCase() : ''
  // Endpoint-profile refusals are configuration/route mismatches, not request-content failures.
  if (normalizedCode.startsWith('endpoint_profile_')) return 'UNSUPPORTED_OPTION'

  const explicit = SERVICE_CODE_MAP[normalizedCode]
  if (explicit !== undefined && normalizedCode !== 'invalid_request_error') return explicit

  const detail = [code, type, message].filter((part): part is string => typeof part === 'string').join(' ')
  if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (isQuotaExceededError(detail)) return 'QUOTA'
  if (UNKNOWN_MODEL_PATTERN.test(detail)) return 'UNKNOWN_MODEL'

  if (explicit !== undefined) return explicit

  switch (typeof type === 'string' ? type.trim().toLowerCase() : '') {
    case 'authentication_error':
      return 'AUTH'
    case 'rate_limit_error':
      return 'RATE_LIMIT'
    case 'server_error':
      return 'SERVER'
    case 'invalid_request_error':
      return 'INVALID_REQUEST'
    default:
      return undefined
  }
}

/**
 * Build the error for a non-streaming (pre-turn) service rejection.
 *
 * Status mapping is deliberately coarse where the service's status is authoritative (401/403, 429,
 * 5xx) and code-driven everywhere else, because the service re-derives the HTTP status from the
 * adapter code: `context_exhausted`, `retained_surface_lost` and `endpoint_profile_*` all arrive as
 * HTTP 400/409 with their own `code`.
 * @param status - the HTTP status the service returned.
 * @param body - the raw response body (bounded by the caller).
 * @param headers - the response headers, read for `retry-after` and `x-request-id`.
 * @returns the typed failure to throw.
 */
export function httpErrorFromService(status: number, body: string, headers: Headers): LlmError {
  const envelope = readErrorEnvelope(body)
  const detail = (envelope?.message ?? body).trim()
  // The service's own `code` is more specific than its HTTP status: it re-derives the status from
  // the adapter code, so a quota exhaustion can arrive as a 429 (`insufficient_quota`) and a queue
  // timeout as the same 429. Consult the code first and keep the status as the fallback, except for
  // the authentication statuses, where the transport is authoritative.
  const mapped = mapServiceFailureCode(envelope?.code, envelope?.type, detail)
  const code =
    status === 401 || status === 403
      ? 'AUTH'
      : mapped !== undefined
        ? mapped
        : status === 429
          ? 'RATE_LIMIT'
          : status >= 500
            ? 'SERVER'
            : fallbackCodeForStatus(status)

  const options: LlmErrorOptions = { status }
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'))
  if (retryAfterMs !== undefined) options.providerRetryAfterMs = retryAfterMs
  const requestId = headers.get('x-request-id')?.trim()
  if (requestId !== undefined && requestId !== '') options.requestId = ProviderRequestId(requestId)

  return new LlmError(
    `${PKG}: service request failed (HTTP ${status})${detailSuffix(detail)}`,
    code,
    options,
  )
}

/**
 * Build the error for a failure delivered inside an already-accepted SSE stream.
 *
 * The HTTP status is 200 and the frame carries no `code`, so classification uses `type` and
 * `message` only. The failure is never retryable by this adapter: the turn was submitted.
 * @param error - the `error` object of the `data: {"error":{…}}` frame.
 * @returns the typed failure to throw.
 */
export function streamErrorFromService(error: unknown): LlmError {
  const record = asRecord(error)
  const message = typeof record?.message === 'string' ? record.message : ''
  const type = typeof record?.type === 'string' && record.type.trim() !== '' ? record.type.trim() : undefined
  const code = mapServiceFailureCode(undefined, type, message) ?? 'SERVER'
  return new LlmError(`${PKG}: service stream failed${detailSuffix(message)}`, code)
}

/** Map a status with no identifying code onto a coarse failure class. */
function fallbackCodeForStatus(status: number): BuiltinLlmFailureCode {
  if (status === 408) return 'TIMEOUT'
  if (status === 499) return 'ABORTED'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

/** Render the bounded, sanitized detail suffix of a diagnostic. */
function detailSuffix(detail: string): string {
  const trimmed = detail.trim()
  if (trimmed === '') return ''
  const bounded = trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT)}…` : trimmed
  return `: ${bounded}`
}

/** Narrow an unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Explicit service codes, keyed by their lowercased wire spelling.
 *
 * `invalid_request_error` is listed but handled after the wording heuristics, because the service
 * also uses it for "Unknown model" and context overflow.
 */
const SERVICE_CODE_MAP: Readonly<Record<string, BuiltinLlmFailureCode>> = Object.freeze({
  // Context pressure: DSH compaction owns the response, so it must see the canonical code.
  context_exhausted: 'CONTEXT_WINDOW_EXCEEDED',
  context_length_exceeded: 'CONTEXT_WINDOW_EXCEEDED',
  // Backpressure: the service's bounded turn queue is full or the caller waited out its budget.
  turn_queue_timeout: 'RATE_LIMIT',
  turn_queue_full: 'RATE_LIMIT',
  rate_limit_exceeded: 'RATE_LIMIT',
  endpoint_profile_concurrency_exceeded: 'RATE_LIMIT',
  // Continuity or settlement failures: retrying would not restore the lost provider surface.
  retained_surface_lost: 'SERVER',
  retained_surface_busy: 'SERVER',
  retained_delta_empty: 'SERVER',
  continuation_prompt_missing: 'SERVER',
  answer_recovery_unavailable: 'SERVER',
  settlement_wait_timeout: 'SERVER',
  turn_timeout: 'SERVER',
  upstream_server_error: 'SERVER',
  server_is_overloaded: 'SERVER',
  qwen_chat_lost: 'SERVER',
  // The caller's request cannot be served as sent.
  compaction_source_unavailable: 'INVALID_REQUEST',
  request_too_large: 'INVALID_REQUEST',
  invalid_response_format: 'INVALID_REQUEST',
  conflicting_max_tokens: 'INVALID_REQUEST',
  host_context_only_turn: 'INVALID_REQUEST',
  no_user_message: 'INVALID_REQUEST',
  invalid_request_error: 'INVALID_REQUEST',
  unknown_model: 'UNKNOWN_MODEL',
  unknown_reasoning_mode: 'UNSUPPORTED_OPTION',
  // Authentication and quota.
  chatgpt_session_expired: 'AUTH',
  qwen_session_missing: 'AUTH',
  invalid_api_key: 'AUTH',
  insufficient_quota: 'QUOTA',
  // A cancelled caller turn is an abort, not a provider failure.
  client_cancelled: 'ABORTED',
  client_closed_request: 'ABORTED',
})

/** The service's wording for a model that is not in its catalogue. */
const UNKNOWN_MODEL_PATTERN = /\bunknown model\b/i
