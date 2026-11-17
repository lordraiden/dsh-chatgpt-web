/**
 * doc/plugin.md §13 — failure mapping between the service and DSH's provider-neutral taxonomy.
 *
 * The service has two error shapes and they must be read differently (doc/plugin.md §3.2): a
 * pre-turn rejection carries an HTTP status plus `{error:{message,type,code}}`, where the **code is
 * authoritative** because `/v1/chat/completions` re-derives the status from it (`context_exhausted`
 * arrives as HTTP 400, not 409); a failure after the turn was accepted arrives with HTTP 200 and
 * `data: {"error":{message,type}}` — no `code` at all — and can only be classified from `type`/`message`.
 *
 * These tests drive both paths through the production adapter against a fake service, and pin the
 * pure mapping helpers directly so a table change is visible as a one-line diff.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import {
  MODEL_NOT_FOUND_CODE,
  PROTOCOL_ERROR_CODE,
  httpErrorFromService,
  mapServiceFailureCode,
  parseRetryAfterMs,
  readErrorEnvelope,
  streamErrorFromService,
} from '../../src/plugin/errors'
import {
  FakeService,
  adapterFor,
  captureFailure,
  collectChunks,
  errorResponse,
  pluginConfig,
  turn,
  userMessage,
} from './fake-service'

/** Every fake service started by a test, stopped after it. */
const running: FakeService[] = []

afterEach(() => {
  for (const service of running.splice(0)) service.stop()
})

/** One service error envelope, as the service's public surface renders it. */
interface Envelope {
  readonly message: string
  readonly type?: string
  readonly code?: string
}

/** Run one normal turn against a service that rejects it with the given status and envelope. */
async function rejection(
  status: number,
  error: Envelope,
  options: { readonly headers?: Record<string, string>; readonly apiKey?: string } = {},
): Promise<LlmError> {
  const service = FakeService.start(() => errorResponse(status, error, options.headers ?? {}))
  running.push(service)
  const adapter = adapterFor({
    config: () => pluginConfig(service.baseUrl, options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    workspaceFor: () => undefined,
  })
  return captureFailure(() => collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] }))))
}

describe('parseRetryAfterMs', () => {
  test('reads delay-seconds, including a decimal a proxy may emit', () => {
    expect(parseRetryAfterMs('7')).toBe(7000)
    expect(parseRetryAfterMs('2.5')).toBe(2500)
    expect(parseRetryAfterMs(' 3 ')).toBe(3000)
  })

  test('reads an HTTP-date in the future', () => {
    const delay = parseRetryAfterMs(new Date(Date.now() + 30_000).toUTCString())
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(30_000)
  })

  test('treats an absent, blank, non-positive or unparseable value as absent', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs(undefined)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('0')).toBeUndefined()
    expect(parseRetryAfterMs('-5')).toBeUndefined()
    expect(parseRetryAfterMs('soon')).toBeUndefined()
    expect(parseRetryAfterMs(new Date(Date.now() - 30_000).toUTCString())).toBeUndefined()
  })
})

describe('readErrorEnvelope', () => {
  test('reads the documented envelope', () => {
    expect(readErrorEnvelope('{"error":{"message":"boom","type":"server_error","code":"turn_timeout"}}')).toEqual({
      message: 'boom',
      type: 'server_error',
      code: 'turn_timeout',
    })
  })

  test('returns undefined for an empty, non-JSON or differently shaped body', () => {
    expect(readErrorEnvelope('')).toBeUndefined()
    expect(readErrorEnvelope('   ')).toBeUndefined()
    expect(readErrorEnvelope('not json')).toBeUndefined()
    expect(readErrorEnvelope('{"error":"a string"}')).toBeUndefined()
    expect(readErrorEnvelope('{"message":"no error object"}')).toBeUndefined()
  })

  test('keeps a message-only envelope and drops blank type/code', () => {
    expect(readErrorEnvelope('{"error":{"message":"boom","type":"  ","code":""}}')).toEqual({ message: 'boom' })
    expect(readErrorEnvelope('{"error":{}}')).toEqual({ message: '' })
  })
})

describe('mapServiceFailureCode', () => {
  test('maps the service context-pressure code onto the canonical DSH code', () => {
    expect(mapServiceFailureCode('context_exhausted', 'invalid_request_error', '')).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(mapServiceFailureCode('context_length_exceeded', 'invalid_request_error', '')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  test('maps the bounded turn queue onto RATE_LIMIT backpressure', () => {
    expect(mapServiceFailureCode('turn_queue_timeout', 'rate_limit_error', '')).toBe('RATE_LIMIT')
    expect(mapServiceFailureCode('turn_queue_full', 'rate_limit_error', '')).toBe('RATE_LIMIT')
    expect(mapServiceFailureCode('rate_limit_exceeded', 'rate_limit_error', '')).toBe('RATE_LIMIT')
  })

  test('maps continuity and settlement failures onto SERVER, never onto a retryable class', () => {
    for (const code of [
      'retained_surface_lost',
      'retained_surface_busy',
      'retained_delta_empty',
      'continuation_prompt_missing',
      'answer_recovery_unavailable',
      'settlement_wait_timeout',
      'turn_timeout',
      'upstream_server_error',
      'qwen_chat_lost',
    ]) {
      expect(mapServiceFailureCode(code, 'invalid_request_error', '')).toBe('SERVER')
    }
  })

  test('maps every endpoint-profile refusal onto UNSUPPORTED_OPTION', () => {
    for (const code of [
      'endpoint_profile_unavailable',
      'endpoint_profile_not_found',
      'endpoint_profile_route_not_found',
      'endpoint_profile_model_not_allowed',
    ]) {
      expect(mapServiceFailureCode(code, 'invalid_request_error', '')).toBe('UNSUPPORTED_OPTION')
    }
  })

  test('maps an unknown model onto UNKNOWN_MODEL, by code or by the service wording', () => {
    expect(mapServiceFailureCode('unknown_model', 'invalid_request_error', '')).toBe('UNKNOWN_MODEL')
    expect(
      mapServiceFailureCode('invalid_request_error', 'invalid_request_error', 'Unknown model "chatgpt-web/nope". Available models: ...'),
    ).toBe('UNKNOWN_MODEL')
  })

  test('consults the wording before the generic invalid_request_error fallback', () => {
    expect(
      mapServiceFailureCode(
        'invalid_request_error',
        'invalid_request_error',
        "This model's maximum context length is 128000 tokens",
      ),
    ).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(mapServiceFailureCode('invalid_request_error', 'invalid_request_error', 'messages must be an array')).toBe(
      'INVALID_REQUEST',
    )
  })

  test('falls back to the error type when the wire carries no code', () => {
    expect(mapServiceFailureCode(undefined, 'authentication_error', '')).toBe('AUTH')
    expect(mapServiceFailureCode(undefined, 'rate_limit_error', '')).toBe('RATE_LIMIT')
    expect(mapServiceFailureCode(undefined, 'server_error', '')).toBe('SERVER')
    expect(mapServiceFailureCode(undefined, 'invalid_request_error', '')).toBe('INVALID_REQUEST')
  })

  test('returns undefined when nothing identifies the failure', () => {
    expect(mapServiceFailureCode(undefined, undefined, 'something broke')).toBeUndefined()
    expect(mapServiceFailureCode(undefined, 'mystery_error', '')).toBeUndefined()
  })
})

describe('httpErrorFromService', () => {
  test('maps 401 and 403 onto AUTH regardless of the body', () => {
    const headers = new Headers()
    expect(httpErrorFromService(401, '', headers).code).toBe('AUTH')
    expect(httpErrorFromService(403, '{"error":{"message":"nope"}}', headers).code).toBe('AUTH')
  })

  test('maps 429 onto RATE_LIMIT and carries the retry-after delay', () => {
    const headers = new Headers({ 'retry-after': '7' })
    const error = httpErrorFromService(429, '{"error":{"message":"slow down","type":"rate_limit_error"}}', headers)
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.failure.status).toBe(429)
    expect(error.failure.providerRetryAfterMs).toBe(7000)
  })

  test('maps 5xx onto SERVER', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(httpErrorFromService(status, '', new Headers()).code).toBe('SERVER')
    }
  })

  test('maps 408 and 499 onto TIMEOUT and ABORTED', () => {
    expect(httpErrorFromService(408, '', new Headers()).code).toBe('TIMEOUT')
    expect(httpErrorFromService(499, '', new Headers()).code).toBe('ABORTED')
  })

  test('keeps the x-request-id as an opaque request id', () => {
    const error = httpErrorFromService(500, '', new Headers({ 'x-request-id': 'req-42' }))
    expect(String(error.failure.requestId)).toBe('req-42')
  })

  test('bounds the diagnostic detail and never adds a credential', () => {
    const detail = 'x'.repeat(5000)
    const error = httpErrorFromService(500, JSON.stringify({ error: { message: detail } }), new Headers())
    expect(error.message.length).toBeLessThan(400)
    expect(error.message).toContain('…')
  })
})

describe('streamErrorFromService', () => {
  test('classifies a mid-stream failure from its type, since the wire carries no code', () => {
    expect(streamErrorFromService({ message: 'lost', type: 'server_error' }).code).toBe('SERVER')
    expect(streamErrorFromService({ message: 'expired', type: 'authentication_error' }).code).toBe('AUTH')
  })

  test('defaults to SERVER when nothing identifies the failure', () => {
    expect(streamErrorFromService({ message: 'mystery' }).code).toBe('SERVER')
    expect(streamErrorFromService(undefined).code).toBe('SERVER')
  })
})

describe('adapter failure mapping against the fake service', () => {
  test('maps a 401 pre-turn rejection onto AUTH', async () => {
    const failure = await rejection(401, { message: 'invalid api key', type: 'authentication_error', code: 'invalid_api_key' })
    expect(failure.code).toBe('AUTH')
    expect(failure.failure.status).toBe(401)
    expect(failure.message).toContain('HTTP 401')
  })

  test('maps a 403 onto AUTH', async () => {
    const failure = await rejection(403, { message: 'forbidden', type: 'authentication_error' })
    expect(failure.code).toBe('AUTH')
  })

  test('maps a 429 with retry-after onto RATE_LIMIT and surfaces providerRetryAfterMs', async () => {
    const failure = await rejection(
      429,
      { message: 'the turn queue is full', type: 'rate_limit_error', code: 'turn_queue_full' },
      { headers: { 'retry-after': '12' } },
    )
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.failure.providerRetryAfterMs).toBe(12_000)
  })

  test('maps a 429 without retry-after onto RATE_LIMIT with no delay', async () => {
    const failure = await rejection(429, { message: 'too many turns', type: 'rate_limit_error' })
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.failure.providerRetryAfterMs).toBeUndefined()
  })

  test('maps 5xx onto SERVER', async () => {
    for (const status of [500, 502, 503]) {
      const failure = await rejection(status, { message: 'upstream failed', type: 'server_error' })
      expect(failure.code).toBe('SERVER')
    }
  })

  test('maps context_exhausted (HTTP 400) onto CONTEXT_WINDOW_EXCEEDED', async () => {
    const failure = await rejection(400, {
      message: 'the conversation exhausted the context window',
      type: 'invalid_request_error',
      code: 'context_exhausted',
    })
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(failure.failure.status).toBe(400)
  })

  test('maps turn_queue_timeout and turn_queue_full onto RATE_LIMIT', async () => {
    for (const code of ['turn_queue_timeout', 'turn_queue_full']) {
      const failure = await rejection(
        429,
        { message: 'queue backpressure', type: 'rate_limit_error', code },
        { headers: { 'retry-after': '3' } },
      )
      expect(failure.code).toBe('RATE_LIMIT')
      expect(failure.failure.providerRetryAfterMs).toBe(3000)
    }
  })

  test('maps a turn_queue_full code that arrives with HTTP 400 onto RATE_LIMIT (the code wins)', async () => {
    const failure = await rejection(400, {
      message: 'queue backpressure',
      type: 'rate_limit_error',
      code: 'turn_queue_full',
    })
    expect(failure.code).toBe('RATE_LIMIT')
  })

  test('maps retained_surface_lost and retained_surface_busy onto SERVER', async () => {
    for (const [status, code] of [
      [400, 'retained_surface_lost'],
      [409, 'retained_surface_busy'],
    ] as const) {
      const failure = await rejection(status, { message: 'the surface is gone', type: 'invalid_request_error', code })
      expect(failure.code).toBe('SERVER')
    }
  })

  test('maps endpoint_profile_* refusals onto UNSUPPORTED_OPTION', async () => {
    for (const [status, code] of [
      [409, 'endpoint_profile_unavailable'],
      [404, 'endpoint_profile_not_found'],
      [400, 'endpoint_profile_model_not_allowed'],
    ] as const) {
      const failure = await rejection(status, { message: 'profile refused', type: 'invalid_request_error', code })
      expect(failure.code).toBe('UNSUPPORTED_OPTION')
    }
  })

  test('maps an unknown model reported by the service onto UNKNOWN_MODEL', async () => {
    const failure = await rejection(400, {
      message: 'Unknown model "chatgpt-web/nope". Available models: chatgpt-web/luna.',
      type: 'invalid_request_error',
      code: 'invalid_request_error',
    })
    expect(failure.code).toBe('UNKNOWN_MODEL')
    expect(failure.code).toBe(MODEL_NOT_FOUND_CODE)
  })

  // A quota exhaustion reaches this surface as HTTP 429 — `httpStatusFromTerminalError` in
  // `src/lib/errors.ts` maps `insufficient_quota` to 429 — so the adapter must consult `error.code`
  // before the status; otherwise a quota-exhausted account is reported as retryable backpressure.
  test('maps a 429 insufficient_quota onto QUOTA', async () => {
    const failure = await rejection(429, {
      message: 'You exceeded your current quota',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    })
    expect(failure.code).toBe('QUOTA')
  })

  test('maps a cancelled caller turn onto ABORTED', async () => {
    const failure = await rejection(499, { message: 'client closed the request', type: 'invalid_request_error', code: 'client_cancelled' })
    expect(failure.code).toBe('ABORTED')
  })

  test('maps a 504 turn_timeout onto SERVER', async () => {
    const failure = await rejection(504, { message: 'the turn timed out', type: 'server_error', code: 'turn_timeout' })
    expect(failure.code).toBe('SERVER')
  })

  test('maps a body-less 400 onto INVALID_REQUEST', async () => {
    const service = FakeService.start(() => new Response('', { status: 400 }))
    running.push(service)
    const adapter = adapterFor({ config: () => pluginConfig(service.baseUrl), workspaceFor: () => undefined })
    const failure = await captureFailure(() => collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] }))))
    expect(failure.code).toBe('INVALID_REQUEST')
  })

  test('keeps the configured api key out of the diagnostic', async () => {
    const failure = await rejection(
      500,
      { message: 'upstream failed', type: 'server_error' },
      { apiKey: 'sk-super-secret-value' },
    )
    expect(failure.message).not.toContain('sk-super-secret-value')
  })

  test('never classifies a malformed frame as a transport failure', async () => {
    const service = FakeService.start(() => new Response('data: nope\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    running.push(service)
    const adapter = adapterFor({ config: () => pluginConfig(service.baseUrl), workspaceFor: () => undefined })
    const failure = await captureFailure(() => collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] }))))
    expect(failure.code).toBe(PROTOCOL_ERROR_CODE)
  })
})
