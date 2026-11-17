/**
 * doc/plugin.md §13 — SSE framing and stream translation.
 *
 * The service speaks OpenAI-compatible SSE over a browser turn that can run for minutes: `: keep-alive`
 * comments, `data: <json>` frames, a terminal `data: [DONE]`, an empty terminal `delta`, and — once the
 * turn was accepted — a failure as `data: {"error":{"message","type"}}` with HTTP 200 and **no `code`**.
 *
 * These tests pin both layers: the incremental decoder (a frame split across chunks, CRLF/CR/LF, a
 * comment, a multi-line `data:` field, a missing trailing blank line) and the adapter's translation of
 * those frames into DSH's canonical chunk order, including cancellation and the failures that must not
 * become a silent end.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { PROTOCOL_ERROR_CODE } from '../../src/plugin/errors'
import { SseDecoder } from '../../src/plugin/sse'
import {
  FakeService,
  SSE_DONE,
  adapterFor,
  captureFailure,
  chunkTypes,
  collectChunks,
  heldSseResponse,
  pluginConfig,
  sseComment,
  sseCompletion,
  sseData,
  sseDelta,
  sseError,
  sseResponse,
  sseRole,
  sseTerminal,
  textOf,
  turn,
  userMessage,
} from './fake-service'

/** Every fake service started by a test, stopped after it. */
const running: FakeService[] = []

afterEach(() => {
  for (const service of running.splice(0)) service.stop()
})

/** Start a fake service that answers with one scripted SSE stream. */
function streamService(
  frames: readonly string[],
  options: { readonly delayMs?: number } = {},
): { service: FakeService; adapter: ReturnType<typeof adapterFor> } {
  const service = FakeService.start(() => sseResponse(frames, options))
  running.push(service)
  const adapter = adapterFor({ config: () => pluginConfig(service.baseUrl), workspaceFor: () => undefined })
  return { service, adapter }
}

/** Drain one normal turn against a scripted stream. */
async function runTurn(
  adapter: ReturnType<typeof adapterFor>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof collectChunks>>> {
  return collectChunks(
    adapter.stream(turn({ messages: [userMessage('hola')], ...(options.signal === undefined ? {} : { signal: options.signal }) })),
  )
}

describe('SseDecoder', () => {
  test('ignores the keep-alive comment and dispatches data frames', () => {
    const decoder = new SseDecoder()
    const events = decoder.push(`${sseComment()}${sseDelta('hola')}`)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe(JSON.stringify({ choices: [{ delta: { content: 'hola' } }] }))
  })

  test('joins multi-line data fields with a newline, as the SSE specification requires', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: first\ndata: second\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('first\nsecond')
  })

  test('treats a field line without a colon as a field with an empty value', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('')
  })

  test('holds back a trailing CR that may be the first half of a CRLF pair split across chunks', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: split\r')).toEqual([])
    const events = decoder.push('\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('split')
  })

  test('accepts LF-only line endings', () => {
    expect(new SseDecoder().push('data: lf\n\n')).toEqual([{ data: 'lf' }])
  })

  test('accepts CR-only line endings, holding the final CR until end of stream', () => {
    const decoder = new SseDecoder()
    // The second CR is held back: it could be the first half of a CRLF pair that never arrives.
    expect(decoder.push('data: cr\r\r')).toEqual([])
    expect(decoder.end()).toEqual([{ data: 'cr' }])
  })

  test('flushes the last pending event at end of stream without a trailing blank line', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: tail')).toEqual([])
    expect(decoder.end()).toEqual([{ data: 'tail' }])
  })

  test('treats a trailing lone CR as a line terminator at end of stream', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: tail\r')).toEqual([])
    expect(decoder.end()).toEqual([{ data: 'tail' }])
  })

  test('carries the event and id fields of one event', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('event: delta\nid: 7\ndata: payload\n\n')).toEqual([
      { data: 'payload', event: 'delta', id: '7' },
    ])
  })

  test('ignores unknown fields such as retry', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('retry: 5000\ndata: payload\n\n')).toEqual([{ data: 'payload' }])
  })

  test('does not dispatch an event that carries no data', () => {
    const decoder = new SseDecoder()
    expect(decoder.push(`${sseComment()}\n\n`)).toEqual([])
  })

  test('decodes the same frame whether it arrives whole or one character at a time', () => {
    const frame = `${sseComment()}${sseDelta('partido')}${sseTerminal()}${SSE_DONE}`
    const whole = new SseDecoder().push(frame)
    const decoder = new SseDecoder()
    const pieces = [...frame].flatMap(char => decoder.push(char))
    expect(pieces).toEqual(whole)
    expect(whole.map(event => event.data)).toEqual([
      JSON.stringify({ choices: [{ delta: { content: 'partido' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])
  })
})

describe('adapter stream translation', () => {
  test('translates keep-alive, role, deltas, terminal delta and [DONE] into the canonical chunk order', async () => {
    const { service, adapter } = streamService(sseCompletion(['Hello', ' world'], { keepAlive: true }))

    const chunks = await runTurn(adapter)

    expect(chunkTypes(chunks)).toEqual(['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(textOf(chunks)).toBe('Hello world')
    expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
    expect(chunks[4]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(service.requests).toHaveLength(1)
  })

  test('treats the empty terminal delta as the end of the turn, not as another text chunk', async () => {
    const { adapter } = streamService([
      sseRole(),
      sseDelta('ok'),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      SSE_DONE,
    ])

    const chunks = await runTurn(adapter)

    expect(textOf(chunks)).toBe('ok')
    expect(chunkTypes(chunks)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
  })

  test('reassembles a frame split across chunks', async () => {
    const frames = sseCompletion(['split ', 'across ', 'chunks'])
    // Split each frame in the middle, and send the halves as separate writes.
    const chunks = frames.flatMap(frame => [frame.slice(0, Math.floor(frame.length / 2)), frame.slice(Math.floor(frame.length / 2))])
    const { adapter } = streamService(chunks, { delayMs: 2 })

    const result = await runTurn(adapter)

    expect(textOf(result)).toBe('split across chunks')
    expect(result.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  test('maps a malformed frame to MALFORMED_RESPONSE instead of ending the turn silently', async () => {
    const { adapter } = streamService([sseDelta('partial'), 'data: {not json}\n\n', SSE_DONE])

    const failure = await captureFailure(() => runTurn(adapter))

    expect(failure.code).toBe(PROTOCOL_ERROR_CODE)
    expect(failure.code).toBe('MALFORMED_RESPONSE')
  })

  test('classifies a mid-stream error frame that carries no code by its type', async () => {
    const { adapter } = streamService([sseDelta('partial'), sseError('the provider surface was lost', 'server_error'), SSE_DONE])

    const failure = await captureFailure(() => runTurn(adapter))

    expect(failure.code).toBe('SERVER')
    expect(failure.message).toContain('the provider surface was lost')
  })

  test('classifies a mid-stream authentication failure as AUTH', async () => {
    const { adapter } = streamService([sseError('the session expired', 'authentication_error'), SSE_DONE])

    const failure = await captureFailure(() => runTurn(adapter))

    expect(failure.code).toBe('AUTH')
  })

  test('falls back to SERVER for a mid-stream error frame with no type at all', async () => {
    const { adapter } = streamService([sseError('something failed'), SSE_DONE])

    const failure = await captureFailure(() => runTurn(adapter))

    expect(failure.code).toBe('SERVER')
  })

  test('never turns a mid-stream error into a clean finish chunk', async () => {
    const { adapter } = streamService([sseDelta('partial'), sseError('failed', 'server_error'), SSE_DONE])

    const chunks: string[] = []
    const failure = await captureFailure(async () => {
      for await (const chunk of adapter.stream(turn({ messages: [userMessage('hola')] }))) chunks.push(chunk.type)
    })

    expect(failure.code).toBe('SERVER')
    expect(chunks).toEqual(['block-start', 'text-delta'])
    expect(chunks).not.toContain('finish')
  })

  test('honours AbortSignal cancellation while the stream is still open', async () => {
    const held = heldSseResponse([sseDelta('first')])
    const service = FakeService.start(() => held.response)
    running.push(service)
    const adapter = adapterFor({ config: () => pluginConfig(service.baseUrl), workspaceFor: () => undefined })
    const controller = new AbortController()

    const iterator = adapter.stream(turn({ messages: [userMessage('hola')], signal: controller.signal }))[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect((await iterator.next()).value).toEqual({ type: 'text-delta', index: 0, text: 'first' })

    controller.abort()
    const failure = await captureFailure(async () => {
      await iterator.next()
    })
    held.release()

    expect(failure.code).toBe('ABORTED')
  })

  test('refuses an already-aborted signal before sending anything', async () => {
    const { service, adapter } = streamService(sseCompletion(['never']))
    const controller = new AbortController()
    controller.abort()

    const failure = await captureFailure(() => runTurn(adapter, { signal: controller.signal }))

    expect(failure.code).toBe('ABORTED')
    expect(service.requests).toHaveLength(0)
  })

  test('maps a configured request deadline to TIMEOUT', async () => {
    const held = heldSseResponse([])
    const service = FakeService.start(() => held.response)
    running.push(service)
    const adapter = adapterFor({
      config: () => pluginConfig(service.baseUrl, { requestTimeoutMs: 40 }),
      workspaceFor: () => undefined,
    })

    const failure = await captureFailure(() => runTurn(adapter))
    held.release()

    expect(failure.code).toBe('TIMEOUT')
  })

  test('fails with TRANSPORT when the stream ends after content but before a terminal frame', async () => {
    const { adapter } = streamService([sseRole(), sseDelta('partial answer')])

    const failure = await captureFailure(() => runTurn(adapter))

    expect(failure.code).toBe('TRANSPORT')
  })

  test('fails with EMPTY_RESPONSE when the service completes without any text', async () => {
    const { adapter } = streamService([sseRole(), sseTerminal(), SSE_DONE])

    const failure = await captureFailure(() => runTurn(adapter))

    expect(failure.code).toBe('EMPTY_RESPONSE')
  })

  test('accepts [DONE] as a terminal frame when no finish_reason was sent', async () => {
    const { adapter } = streamService([sseDelta('done without reason'), SSE_DONE])

    const chunks = await runTurn(adapter)

    expect(textOf(chunks)).toBe('done without reason')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  test('maps finish_reason length to the max-tokens finish reason', async () => {
    const { adapter } = streamService([sseDelta('truncated'), sseTerminal('length'), SSE_DONE])

    const chunks = await runTurn(adapter)

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  test('forwards a usage frame that a future service includes', async () => {
    const { adapter } = streamService([
      sseData({
        choices: [{ delta: { content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      sseTerminal(),
      SSE_DONE,
    ])

    const chunks = await runTurn(adapter)

    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })
    expect(chunkTypes(chunks)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  test('reads a delta whose content is an OpenAI content-part array', async () => {
    const { adapter } = streamService([
      sseData({ choices: [{ delta: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }),
      sseTerminal(),
      SSE_DONE,
    ])

    const chunks = await runTurn(adapter)

    expect(textOf(chunks)).toBe('ab')
  })

  test('never emits a tool-call chunk', async () => {
    const { adapter } = streamService(sseCompletion(['text only']))

    const chunks = await runTurn(adapter)

    expect(chunkTypes(chunks)).not.toContain('tool-call-delta')
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type !== 'text')).toBe(false)
  })
})
