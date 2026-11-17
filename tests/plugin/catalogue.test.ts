/**
 * doc/plugin.md §13 — the model catalogue, `contextWindow` and configuration freezing.
 *
 * The service catalogue (`GET /v1/models`) is the only source of the declared `contextWindow` DSH
 * compaction depends on (doc/plugin.md §6), and the plugin serves only the two routes it registers.
 * Resolution must therefore fail closed with `UNKNOWN_MODEL` rather than invent a window, while the
 * advisory `listModels()` must never throw: a settings page refresh cannot break because the service
 * is restarting.
 *
 * `prepareCall()` is the other half: it binds one model resolution and its eventual dispatch to the
 * same configuration read, so a live settings edit cannot pair one generation's `contextWindow` with
 * another generation's endpoint.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { MODEL_NOT_FOUND_CODE } from '../../src/plugin/errors'
import {
  FakeService,
  adapterFor,
  captureFailure,
  collectChunks,
  jsonResponse,
  pluginConfig,
  recordingLogger,
  sseCompletion,
  sseResponse,
  textOf,
  turn,
  userMessage,
} from './fake-service'

/** Every fake service started by a test, stopped after it. */
const running: FakeService[] = []

afterEach(() => {
  for (const service of running.splice(0)) service.stop()
})

/** The service catalogue, in the shape `/v1/models` returns it. */
const CATALOGUE = {
  object: 'list',
  models: [
    { slug: 'chatgpt-web/luna', display_name: 'Luna', context_window: 400_000, input_modalities: ['text'] },
    {
      slug: 'chatgpt-web/gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      context_window: 256_000,
      // A reasoning declaration on a ChatGPT Web row must be ignored: only qwen-chat exposes levels.
      supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
    },
    {
      slug: 'qwen-chat/qwen3.7-plus',
      display_name: 'Qwen3.7 Plus',
      context_window: 131_072,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'high', description: 'Deep' },
      ],
      default_reasoning_level: 'high',
    },
    { slug: 'qwen-chat/qwen3.7-max', context_window: 131_072 },
    { slug: 'deepseek-web/deepseek-chat', display_name: 'DeepSeek', context_window: 128_000 },
    { slug: 'qwen-code/qwen3.7-plus', context_window: 131_072 },
    { slug: 'not-a-route', context_window: 1_000 },
  ],
}

/** Start a fake service that answers every request with one JSON payload. */
function catalogueService(payload: unknown = CATALOGUE, status = 200): FakeService {
  const service = FakeService.start(() => jsonResponse(status, payload))
  running.push(service)
  return service
}

/** Start a fake service that serves the catalogue and one completion text. */
function fullService(text: string): FakeService {
  const service = FakeService.start(request =>
    request.path === '/v1/models' ? jsonResponse(200, CATALOGUE) : sseResponse(sseCompletion([text])),
  )
  running.push(service)
  return service
}

/** Build an adapter for one fake service, with an optional recording logger. */
function adapterForService(service: FakeService, logger?: ReturnType<typeof recordingLogger>): ReturnType<typeof adapterFor> {
  return adapterFor({
    config: () => pluginConfig(service.baseUrl),
    workspaceFor: () => undefined,
    ...(logger === undefined ? {} : { logger }),
  })
}

describe('provider metadata', () => {
  test('describes both registered routes and nothing else', () => {
    const adapter = adapterFor({ config: () => pluginConfig('http://127.0.0.1:1'), workspaceFor: () => undefined })

    expect(adapter.providerInfo('chatgpt-web')).toEqual({ id: 'chatgpt-web', name: 'ChatGPT Web' })
    expect(adapter.providerInfo('qwen-chat')).toEqual({ id: 'qwen-chat', name: 'Qwen Chat' })
  })

  test('disables DSH retries, because the service already owns turn settlement', () => {
    const adapter = adapterFor({ config: () => pluginConfig('http://127.0.0.1:1'), workspaceFor: () => undefined })

    const policy = adapter.providerRetryPolicy('chatgpt-web')

    expect(policy?.mode).toBe('normal')
    expect(policy?.mode === 'normal' ? policy.maxRetries : undefined).toBe(0)
  })
})

describe('listModels', () => {
  test('lists only the chatgpt-web route', async () => {
    const service = catalogueService()
    const models = await adapterForService(service).listModels('chatgpt-web')

    expect(models.map(model => model.id)).toEqual(['chatgpt-web/luna', 'chatgpt-web/gpt-5.6-sol'])
    expect(models[0]).toEqual({
      provider: 'chatgpt-web',
      id: 'chatgpt-web/luna',
      name: 'Luna',
      inputModalities: ['text'],
    })
  })

  test('lists only the qwen-chat route', async () => {
    const service = catalogueService()
    const models = await adapterForService(service).listModels('qwen-chat')

    expect(models.map(model => model.id)).toEqual(['qwen-chat/qwen3.7-plus', 'qwen-chat/qwen3.7-max'])
  })

  test('falls back to the row name, then to the slug, when no display name is declared', async () => {
    const service = catalogueService({
      models: [
        { slug: 'chatgpt-web/named', name: 'Plain name', context_window: 1000 },
        { slug: 'chatgpt-web/unnamed', context_window: 1000 },
      ],
    })

    const models = await adapterForService(service).listModels('chatgpt-web')

    expect(models.map(model => model.name)).toEqual(['Plain name', 'chatgpt-web/unnamed'])
  })

  test('returns an empty list for a provider this plugin does not serve, without a request', async () => {
    const service = catalogueService()
    const models = await adapterForService(service).listModels('deepseek-web')

    expect(models).toEqual([])
    expect(service.requests).toHaveLength(0)
  })

  test('never throws when the catalogue is down, and reports the failure once', async () => {
    const service = catalogueService({ error: { message: 'not ready' } }, 503)
    const logger = recordingLogger()
    const adapter = adapterForService(service, logger)

    expect(await adapter.listModels('chatgpt-web')).toEqual([])
    expect(await adapter.listModels('chatgpt-web')).toEqual([])

    const warnings = logger.messages.filter(message => message.includes('catalogue is unavailable'))
    expect(warnings).toHaveLength(1)
    expect(service.requests).toHaveLength(2)
  })

  test('never throws on a non-JSON catalogue body', async () => {
    const service = FakeService.start(() => new Response('not json', { status: 200 }))
    running.push(service)
    const logger = recordingLogger()

    expect(await adapterForService(service, logger).listModels('chatgpt-web')).toEqual([])
    expect(logger.messages.some(message => message.includes('catalogue is unavailable'))).toBe(true)
  })

  test('accepts the OpenAI data[] shape when models[] is absent', async () => {
    const service = catalogueService({
      object: 'list',
      data: [{ id: 'chatgpt-web/luna' }, { id: 'qwen-chat/qwen3.7-plus' }],
    })

    const models = await adapterForService(service).listModels('chatgpt-web')

    expect(models.map(model => model.id)).toEqual(['chatgpt-web/luna'])
  })

  test('deduplicates a slug listed twice', async () => {
    const service = catalogueService({
      models: [
        { slug: 'chatgpt-web/luna', display_name: 'Luna', context_window: 1000 },
        { slug: 'chatgpt-web/luna', display_name: 'Luna again', context_window: 2000 },
      ],
    })

    const models = await adapterForService(service).listModels('chatgpt-web')

    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('Luna')
  })
})

describe('resolveModel', () => {
  test('declares the contextWindow from models[].context_window', async () => {
    const service = catalogueService()
    const info = await adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/luna')

    expect(info).toEqual({
      provider: 'chatgpt-web',
      id: 'chatgpt-web/luna',
      name: 'Luna',
      inputModalities: ['text'],
      context: { contextWindow: 400_000 },
    })
  })

  test('exposes the qwen-chat reasoning levels and their declared default', async () => {
    const service = catalogueService()
    const info = await adapterForService(service).resolveModel('qwen-chat', 'qwen-chat/qwen3.7-plus')

    expect(info.reasoning?.efforts.map(effort => [String(effort.id), effort.name])).toEqual([
      ['low', 'Fast'],
      ['high', 'Deep'],
    ])
    expect(String(info.reasoning?.defaultEffort)).toBe('high')
  })

  test('ignores a reasoning declaration on a chatgpt-web row', async () => {
    const service = catalogueService()
    const info = await adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/gpt-5.6-sol')

    expect(info.reasoning).toBeUndefined()
  })

  test('fails closed with UNKNOWN_MODEL for a model the catalogue does not list', async () => {
    const service = catalogueService()
    const failure = await captureFailure(() =>
      adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/does-not-exist'),
    )

    expect(failure.code).toBe(MODEL_NOT_FOUND_CODE)
    expect(failure.code).toBe('UNKNOWN_MODEL')
  })

  test('fails closed with UNKNOWN_MODEL when the catalogue is unavailable', async () => {
    const service = catalogueService({ error: { message: 'down' } }, 500)
    const failure = await captureFailure(() => adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/luna'))

    expect(failure.code).toBe('UNKNOWN_MODEL')
  })

  test('fails closed with UNKNOWN_MODEL when the row declares no context_window', async () => {
    const service = catalogueService({ models: [{ slug: 'chatgpt-web/luna', display_name: 'Luna' }] })
    const failure = await captureFailure(() => adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/luna'))

    expect(failure.code).toBe('UNKNOWN_MODEL')
  })

  test('fails closed with UNKNOWN_MODEL for the OpenAI data[] shape, which declares no window', async () => {
    const service = catalogueService({ object: 'list', data: [{ id: 'chatgpt-web/luna' }] })
    const failure = await captureFailure(() => adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/luna'))

    expect(failure.code).toBe('UNKNOWN_MODEL')
  })

  test('rejects a model id that does not belong to the provider route, without a request', async () => {
    const service = catalogueService()
    const failure = await captureFailure(() => adapterForService(service).resolveModel('chatgpt-web', 'qwen-chat/qwen3.7-plus'))

    expect(failure.code).toBe('UNKNOWN_MODEL')
    expect(service.requests).toHaveLength(0)
  })

  test('rejects a provider route this plugin does not register', async () => {
    const service = catalogueService()
    const failure = await captureFailure(() => adapterForService(service).resolveModel('deepseek-web', 'deepseek-web/deepseek-chat'))

    expect(failure.code).toBe('UNKNOWN_MODEL')
    expect(service.requests).toHaveLength(0)
  })

  test('honours an already-aborted signal', async () => {
    const service = catalogueService()
    const controller = new AbortController()
    controller.abort()

    const failure = await captureFailure(() =>
      adapterForService(service).resolveModel('chatgpt-web', 'chatgpt-web/luna', controller.signal),
    )

    expect(failure.code).toBe('ABORTED')
  })

  test('reuses one successful catalogue read for the cache lifetime', async () => {
    const service = catalogueService()
    const adapter = adapterForService(service)

    await adapter.resolveModel('chatgpt-web', 'chatgpt-web/luna')
    await adapter.resolveModel('qwen-chat', 'qwen-chat/qwen3.7-plus')

    expect(service.requests).toHaveLength(1)
    expect(service.lastRequest.path).toBe('/v1/models')
    expect(service.lastRequest.method).toBe('GET')
  })
})

describe('prepareCall', () => {
  test('returns the resolved model and freezes the configuration read at preparation time', async () => {
    const first = fullService('from first')
    const second = fullService('from second')

    let baseUrl = first.baseUrl
    const adapter = adapterFor({ config: () => pluginConfig(baseUrl), workspaceFor: () => undefined })

    const prepared = await adapter.prepareCall('chatgpt-web', 'chatgpt-web/luna')
    expect(prepared.model.context?.contextWindow).toBe(400_000)

    // A live settings edit between preparation and dispatch must not move the request.
    baseUrl = second.baseUrl
    const chunks = await collectChunks(prepared.stream(turn({ messages: [userMessage('hola')] })))

    expect(textOf(chunks)).toBe('from first')
    expect(first.requests.map(request => request.path)).toEqual(['/v1/models', '/v1/chat/completions'])
    expect(second.requests).toHaveLength(0)
  })

  test('fails with UNKNOWN_MODEL before returning a call for an unresolvable model', async () => {
    const service = catalogueService()
    const failure = await captureFailure(() => adapterForService(service).prepareCall('chatgpt-web', 'chatgpt-web/nope'))

    expect(failure.code).toBe('UNKNOWN_MODEL')
  })
})

describe('transport failures', () => {
  test('maps an unreachable service onto TRANSPORT', async () => {
    // Port 1 needs a privileged bind, so nothing can be listening there.
    const adapter = adapterFor({ config: () => pluginConfig('http://127.0.0.1:1'), workspaceFor: () => undefined })

    const failure = await captureFailure(() => collectChunks(adapter.stream(turn({ messages: [userMessage('hola')] }))))

    expect(failure.code).toBe('TRANSPORT')
    expect(failure.message).toContain('cannot reach the service')
  })
})
