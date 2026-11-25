/**
 * doc/plugin.md §13 — the exact request payload the adapter sends.
 *
 * The service is the provider-routing authority and the plugin is a thin text-only client, so the
 * request body is a contract, not an implementation detail (doc/plugin.md §3.2, §5):
 *
 * - a **normal turn** carries only the newest user message that still has human text, because the
 *   service projects exactly that message when the turn has identity;
 * - an **auxiliary call** (`purpose: compaction`/`session-title`) carries the whole user/assistant
 *   conversation and has its system instruction prepended to the last user message, because the
 *   service has no system slot;
 * - `tools` is never read and no `tool-call` chunk is ever emitted; attached non-text content is
 *   refused instead of silently dropped;
 * - every request carries DSH's attribution headers, and the API key only when one is configured.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  FakeService,
  adapterFor,
  captureFailure,
  chunkTypes,
  collectChunks,
  imageUserMessage,
  messagesOf,
  pluginConfig,
  sseCompletion,
  sseResponse,
  turnMetadataOf,
  turn,
  userMessage,
  assistantMessage,
  systemMessage,
  type RecordedRequest,
  type TurnOptions,
} from './fake-service'

/** Every fake service started by a test, stopped after it. */
const running: FakeService[] = []

afterEach(() => {
  for (const service of running.splice(0)) service.stop()
})

/** Start a fake service that answers every turn with one short completion. */
function completionService(): FakeService {
  const service = FakeService.start(() => sseResponse(sseCompletion(['ok'])))
  running.push(service)
  return service
}

/** Build the adapter for one fake service. */
function adapterForService(
  service: FakeService,
  options: { readonly apiKey?: string; readonly workspace?: string } = {},
): ReturnType<typeof adapterFor> {
  return adapterFor({
    config: () =>
      pluginConfig(service.baseUrl, options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    workspaceFor: () => options.workspace,
  })
}

/** Run one turn and return the request the service received plus the chunks DSH saw. */
async function exchange(
  service: FakeService,
  options: TurnOptions,
  adapterOptions: { readonly apiKey?: string; readonly workspace?: string } = {},
): Promise<{ request: RecordedRequest; chunks: StreamChunk[] }> {
  const adapter = adapterForService(service, adapterOptions)
  const chunks = await collectChunks(adapter.stream(turn(options)))
  return { request: service.lastRequest, chunks }
}

describe('normal turn payload', () => {
  test('sends model, the single current user message, stream:true and the native turn metadata', async () => {
    const service = completionService()

    const { request } = await exchange(
      service,
      { messages: [userMessage('hola')], sessionId: 'ses-1' },
      { workspace: 'dsh-chatgpt-web' },
    )

    expect(request.method).toBe('POST')
    expect(request.path).toBe('/v1/chat/completions')
    expect(request.body.model).toBe('chatgpt-web/luna')
    expect(request.body.stream).toBe(true)
    expect(messagesOf(request)).toEqual([{ role: 'user', content: 'hola' }])
    expect(turnMetadataOf(request)).toEqual({ dsh_session_id: 'ses-1', workspace: 'dsh-chatgpt-web' })
  })

  test('sends no tools, no tool_choice and no unrelated field', async () => {
    const service = completionService()

    const { request } = await exchange(service, { messages: [userMessage('hola')], sessionId: 'ses-1' })

    expect(Object.keys(request.body).sort()).toEqual(['client_metadata', 'messages', 'model', 'stream'])
    expect('tools' in request.body).toBe(false)
    expect('tool_choice' in request.body).toBe(false)
    expect('user' in request.body).toBe(false)
  })

  test('carries the attribution headers, the SSE accept and the JSON content type', async () => {
    const service = completionService()

    const { request } = await exchange(service, { messages: [userMessage('hola')] })

    expect(request.headers.get('user-agent')).toContain('deepseek-harness')
    expect(request.headers.get('accept')).toBe('text/event-stream')
    expect(request.headers.get('content-type')).toBe('application/json')
  })

  test('sends the api key as a bearer token only when one is configured', async () => {
    const withKey = completionService()
    const first = await exchange(withKey, { messages: [userMessage('hola')] }, { apiKey: 'key-123' })
    expect(first.request.headers.get('authorization')).toBe('Bearer key-123')

    const withoutKey = completionService()
    const second = await exchange(withoutKey, { messages: [userMessage('hola')] })
    expect(second.request.headers.get('authorization')).toBeNull()

    const blankKey = completionService()
    const third = await exchange(blankKey, { messages: [userMessage('hola')] }, { apiKey: '   ' })
    expect(third.request.headers.get('authorization')).toBeNull()
  })

  test('omits the workspace when the host cannot resolve one', async () => {
    const service = completionService()

    const { request } = await exchange(service, { messages: [userMessage('hola')], sessionId: 'ses-1' })

    expect(turnMetadataOf(request)).toEqual({ dsh_session_id: 'ses-1' })
  })

  test('omits client_metadata entirely when there is no session identity and no workspace', async () => {
    const service = completionService()

    const { request } = await exchange(service, { messages: [userMessage('hola')] })

    expect('client_metadata' in request.body).toBe(false)
    expect(Object.keys(request.body).sort()).toEqual(['messages', 'model', 'stream'])
  })

  test('projects a full history onto the newest user message only', async () => {
    const service = completionService()

    const { request } = await exchange(service, {
      messages: [userMessage('first question'), assistantMessage('first answer'), userMessage('second question')],
      sessionId: 'ses-1',
    })

    expect(messagesOf(request)).toEqual([{ role: 'user', content: 'second question' }])
  })

  test('skips a trailing user message that carries no human text', async () => {
    const service = completionService()

    const { request } = await exchange(service, {
      messages: [userMessage('the real turn'), userMessage('   ')],
    })

    expect(messagesOf(request)).toEqual([{ role: 'user', content: 'the real turn' }])
  })

  test('skips a trailing user message that is only the harness time snapshot', async () => {
    const service = completionService()

    // The harness appends its time context as a `user` message after the human turn. Its text is not
    // blank, but the service strips it as host context, so sending it would be an empty turn and the
    // service would refuse the request with `host_context_only_turn` (regression: a real session lost
    // its question this way).
    const timeSnapshot = [
      'Time sampled while preparing turn 1, step 1: 2026-11-25T08:41:25+01:00[Europe/Madrid]',
      'Browser time zone for this request: Europe/Madrid. Interpret otherwise-unqualified dates and times in this zone.',
      'Elapsed since the preceding model-visible message: unavailable.',
    ].join('\n')

    const { request } = await exchange(service, {
      messages: [userMessage('the real turn'), userMessage(timeSnapshot)],
      sessionId: 'ses-1',
    })

    expect(messagesOf(request)).toEqual([{ role: 'user', content: 'the real turn' }])
  })

  test('skips a trailing user message that is only a runtime-context snapshot', async () => {
    const service = completionService()

    const runtimeSnapshot = [
      'Current runtime context:',
      '',
      'Current working directory: "/home/raiden/Projects/homeserver".',
      '',
      'Current DSH file policy: workspace-write.',
    ].join('\n')

    const { request } = await exchange(service, {
      messages: [userMessage('the real turn'), userMessage(runtimeSnapshot)],
      sessionId: 'ses-1',
    })

    expect(messagesOf(request)).toEqual([{ role: 'user', content: 'the real turn' }])
  })

  test('appends the API path to a baseUrl that carries an endpoint profile', async () => {
    const service = completionService()
    const adapter = adapterFor({
      config: () => pluginConfig(`${service.baseUrl}/p/hidden`),
      workspaceFor: () => undefined,
    })

    await collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] })))

    expect(service.lastRequest.path).toBe('/p/hidden/v1/chat/completions')
  })

  test('does not double the slash of a baseUrl with a trailing slash', async () => {
    const service = completionService()
    const adapter = adapterFor({
      config: () => pluginConfig(`${service.baseUrl}/`),
      workspaceFor: () => undefined,
    })

    await collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] })))

    expect(service.lastRequest.path).toBe('/v1/chat/completions')
  })

  test('refuses a request with no user message instead of sending an empty turn', async () => {
    const service = completionService()
    const adapter = adapterForService(service)

    const failure = await captureFailure(() =>
      collectChunks(adapter.stream(turn({ messages: [assistantMessage('orphan answer')] }))),
    )

    expect(failure.code).toBe('INVALID_REQUEST')
    expect(service.requests).toHaveLength(0)
  })

  test('refuses a configuration without a service root before any request', async () => {
    const adapter = adapterFor({ config: () => pluginConfig('   '), workspaceFor: () => undefined })

    const failure = await captureFailure(() => collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] }))))

    expect(failure.code).toBe('INVALID_CONFIG')
  })
})

describe('text-only behaviour', () => {
  test('ignores options.tools and never emits a tool-call chunk', async () => {
    const service = completionService()

    const { request, chunks } = await exchange(service, {
      messages: [userMessage('use a tool please')],
      tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }],
    })

    expect('tools' in request.body).toBe(false)
    expect(chunkTypes(chunks)).not.toContain('tool-call-delta')
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  test('refuses non-text content in a user message instead of dropping it', async () => {
    const service = completionService()
    const adapter = adapterForService(service)

    const failure = await captureFailure(() => collectChunks(adapter.stream(turn({ messages: [imageUserMessage()] }))))

    expect(failure.code).toBe('UNSUPPORTED_CONTENT')
    expect(service.requests).toHaveLength(0)
  })

  test('forwards reasoning_effort for qwen-chat only', async () => {
    const qwen = completionService()
    const qwenResult = await exchange(qwen, {
      provider: 'qwen-chat',
      model: 'qwen-chat/qwen3.7-plus',
      messages: [userMessage('hola')],
      reasoningEffort: 'high',
    })
    expect(qwenResult.request.body.reasoning_effort).toBe('high')

    const chatgpt = completionService()
    const chatgptResult = await exchange(chatgpt, {
      messages: [userMessage('hola')],
      reasoningEffort: 'high',
    })
    expect('reasoning_effort' in chatgptResult.request.body).toBe(false)
  })
})

describe('auxiliary calls (compaction and session title)', () => {
  test('sends the full user/assistant conversation with the system instruction prepended to the last user message', async () => {
    const service = completionService()

    const { request } = await exchange(
      service,
      {
        messages: [systemMessage('You are a summarizer.'), userMessage('a'), assistantMessage('b'), userMessage('c')],
        system: 'Summarize the conversation.',
        purpose: 'compaction',
        sessionId: 'ses-1',
      },
      { workspace: 'dsh-chatgpt-web' },
    )

    expect(messagesOf(request)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'Summarize the conversation.\n\nYou are a summarizer.\n\nc' },
    ])
  })

  test('declares the purpose and never the workspace', async () => {
    const service = completionService()

    const { request } = await exchange(
      service,
      { messages: [userMessage('title this')], purpose: 'session-title', sessionId: 'ses-1' },
      { workspace: 'dsh-chatgpt-web' },
    )

    const metadata = turnMetadataOf(request)
    expect(metadata).toEqual({ dsh_session_id: 'ses-1', purpose: 'session-title' })
    expect('workspace' in metadata).toBe(false)
  })

  test('declares compaction as the purpose', async () => {
    const service = completionService()

    const { request } = await exchange(service, {
      messages: [userMessage('compact this')],
      purpose: 'compaction',
      sessionId: 'ses-1',
    })

    expect(turnMetadataOf(request).purpose).toBe('compaction')
  })

  test('prepends the system instruction even when the last user message is empty', async () => {
    const service = completionService()

    const { request } = await exchange(service, {
      messages: [userMessage('a'), userMessage('')],
      system: 'Only the instruction.',
      purpose: 'compaction',
    })

    expect(messagesOf(request)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'Only the instruction.' },
    ])
  })

  test('refuses an auxiliary call that ends with an assistant message', async () => {
    const service = completionService()
    const adapter = adapterForService(service)

    const failure = await captureFailure(() =>
      collectChunks(
        adapter.stream(
          turn({ messages: [userMessage('a'), assistantMessage('b')], purpose: 'compaction' }),
        ),
      ),
    )

    expect(failure.code).toBe('INVALID_REQUEST')
    expect(service.requests).toHaveLength(0)
  })

  test('refuses an auxiliary call with no user message at all', async () => {
    const service = completionService()
    const adapter = adapterForService(service)

    const failure = await captureFailure(() =>
      collectChunks(adapter.stream(turn({ messages: [assistantMessage('b')], purpose: 'compaction' }))),
    )

    expect(failure.code).toBe('INVALID_REQUEST')
    expect(service.requests).toHaveLength(0)
  })

  test('treats a blank purpose as an ordinary turn', async () => {
    const service = completionService()

    const { request } = await exchange(
      service,
      { messages: [userMessage('hola')], purpose: '   ', sessionId: 'ses-1' },
      { workspace: 'dsh-chatgpt-web' },
    )

    expect(messagesOf(request)).toEqual([{ role: 'user', content: 'hola' }])
    expect(turnMetadataOf(request)).toEqual({ dsh_session_id: 'ses-1', workspace: 'dsh-chatgpt-web' })
  })
})
