/**
 * doc/plugin.md §13 — the plugin host (`src/plugin.ts`) and its configuration.
 *
 * The host owns only the DSH-facing seam: one `ctx.llm.registerAdapter` for both routes, the
 * DSH session → workspace-name lookup the adapter sends as first-message context, the sanitized
 * logger, the settings-page policy, and the live configuration read.
 *
 * The Cordis context is simulated with the few members the host actually touches (`llm`,
 * `sessions`, `logger`, `inject`, `effect`, `fiber`), so these tests pin the host's contract without
 * booting a harness. The workspace lookup is asserted through the wire payload, which is the only
 * thing the service ever sees.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

import { Config, apply, default as pluginDefault, inject, name } from '../../src/plugin'
import { resolvePluginConfig } from '../../src/plugin/config'
import {
  FakeService,
  collectChunks,
  jsonResponse,
  sseCompletion,
  sseResponse,
  turn,
  turnMetadataOf,
  userMessage,
} from './fake-service'

/** Every fake service started by a test, stopped after it. */
const running: FakeService[] = []

afterEach(() => {
  for (const service of running.splice(0)) service.stop()
})

/** One DSH session, reduced to the header fact the host reads. */
interface FakeSession {
  readonly header?: { readonly cwd?: string }
}

/** One adapter registration the fake `llm` service received. */
interface Registration {
  readonly providers: readonly string[]
  readonly adapter: LlmAdapter
}

/** One settings-page policy call. */
interface SettingsCall {
  readonly presentation: { readonly auto?: boolean }
  readonly owner: unknown
}

/** Options for the simulated context. */
interface FakeContextOptions {
  readonly sessions?: Map<string, FakeSession>
  readonly entryId?: string
  readonly settingsAvailable?: boolean
  readonly loggerThrows?: boolean
  readonly sessionsThrow?: boolean
}

/** The simulated Cordis context and everything it recorded. */
interface FakeContext {
  /** The context handed to `apply`; assigned once its child context exists. */
  ctx: Parameters<typeof apply>[0]
  readonly registrations: Registration[]
  readonly logs: string[]
  readonly settingsCalls: SettingsCall[]
  readonly injected: string[][]
  readonly fiber: unknown
  /** Fake services this context's adapter may call, in attach order. */
  readonly services: FakeService[]
  /** How many effects the host opened. */
  effects: number
}

/** Build a Cordis context with only the members the plugin host touches. */
function fakeContext(options: FakeContextOptions = {}): FakeContext {
  const sessions = options.sessions ?? new Map<string, FakeSession>()
  const registrations: Registration[] = []
  const logs: string[] = []
  const settingsCalls: SettingsCall[] = []
  const injected: string[][] = []
  const services: FakeService[] = []
  const fiber = { entry: { options: { id: options.entryId ?? name } } }

  const loggerFor = (tag: string) => ({
    info: (message: string) => logs.push(`info ${tag}: ${message}`),
    warn: (message: string) => logs.push(`warn ${tag}: ${message}`),
    error: (message: string) => logs.push(`error ${tag}: ${message}`),
    debug: (message: string) => logs.push(`debug ${tag}: ${message}`),
  })

  const settings = {
    configure: (presentation: { readonly auto?: boolean }, owner?: unknown): (() => void) => {
      settingsCalls.push({ presentation, owner })
      return () => {}
    },
  }

  const context: FakeContext = {
    // Assigned below: the child context that `inject` hands back needs this object to record into.
    ctx: undefined as unknown as Parameters<typeof apply>[0],
    registrations,
    logs,
    settingsCalls,
    injected,
    fiber,
    services,
    effects: 0,
  }

  const child = {
    ...(options.settingsAvailable === false ? {} : { settings }),
    effect: (fn: () => unknown): (() => void) => {
      context.effects += 1
      const disposer = fn()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
  }

  const ctx = {
    llm: {
      registerAdapter(providers: string[], adapter: LlmAdapter): () => void {
        registrations.push({ providers: [...providers], adapter })
        return () => {}
      },
    },
    sessions: {
      get(id: string): FakeSession | undefined {
        if (options.sessionsThrow === true) throw new Error('the session service is unavailable')
        return sessions.get(id)
      },
    },
    logger: options.loggerThrows === true
      ? (): never => {
          throw new Error('no logger service')
        }
      : loggerFor,
    inject(names: string[], callback: (child: unknown) => void): void {
      injected.push([...names])
      callback(child)
    },
    effect(fn: () => unknown): () => void {
      context.effects += 1
      const disposer = fn()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
    fiber,
  }

  context.ctx = ctx as unknown as Parameters<typeof apply>[0]
  return context
}

/** Start a fake service that serves the catalogue and one completion. */
function fullService(text = 'ok'): FakeService {
  const service = FakeService.start(request =>
    request.path === '/v1/models'
      ? jsonResponse(200, {
          models: [
            { slug: 'chatgpt-web/luna', display_name: 'Luna', context_window: 400_000 },
            { slug: 'qwen-chat/qwen3.7-plus', display_name: 'Qwen3.7 Plus', context_window: 131_072 },
          ],
        })
      : sseResponse(sseCompletion([text])),
  )
  running.push(service)
  return service
}

/** Attach one fake service to a context. */
function attach(context: FakeContext, service: FakeService): FakeService {
  context.services.push(service)
  return service
}

/** The single adapter the host registered. */
function registeredAdapter(context: FakeContext): LlmAdapter {
  const registration = context.registrations[0]
  if (registration === undefined) throw new Error('the host registered no adapter')
  return registration.adapter
}

/** Run one turn through the host-registered adapter and return the metadata the service received. */
async function runTurn(
  context: FakeContext,
  sessionId: string,
  service: FakeService,
): Promise<Record<string, string>> {
  const adapter = registeredAdapter(context)
  await collectChunks(adapter.stream(turn({ messages: [userMessage('hola')], sessionId })))
  return turnMetadataOf(service.lastRequest)
}

describe('apply', () => {
  test('registers one adapter for both provider routes', () => {
    const context = fakeContext()

    apply(context.ctx, { baseUrl: 'http://127.0.0.1:17842' })

    expect(context.registrations).toHaveLength(1)
    expect(context.registrations[0]?.providers).toEqual(['chatgpt-web', 'qwen-chat'])
    expect(context.registrations[0]?.adapter.providerInfo('chatgpt-web')).toEqual({ id: 'chatgpt-web', name: 'ChatGPT Web' })
    expect(context.registrations[0]?.adapter.providerInfo('qwen-chat')).toEqual({ id: 'qwen-chat', name: 'Qwen Chat' })
  })

  test('logs the registration without ever echoing a secret', () => {
    const context = fakeContext()

    apply(context.ctx, {
      baseUrl: 'http://127.0.0.1:17842',
      model: 'chatgpt-web/luna',
      apiKey: 'sk-super-secret-value',
      controlToken: 'control-secret-value',
    })

    const info = context.logs.find(message => message.includes('registered'))
    expect(info).toContain('"chatgpt-web", "qwen-chat"')
    expect(info).toContain('"chatgpt-web/luna"')
    expect(info).toContain('http://127.0.0.1:17842')
    expect(context.logs.join('\n')).not.toContain('sk-super-secret-value')
    expect(context.logs.join('\n')).not.toContain('control-secret-value')
  })

  test('never echoes credentials embedded in the configured baseUrl', () => {
    const context = fakeContext()

    apply(context.ctx, { baseUrl: 'http://operator:operator-secret@127.0.0.1:17842' })

    expect(context.logs.join('\n')).not.toContain('operator-secret')
    expect(context.logs.join('\n')).toContain('http://127.0.0.1:17842')
  })

  test('declares the settings page policy on the plugin fiber', () => {
    const context = fakeContext()

    apply(context.ctx, { baseUrl: 'http://127.0.0.1:17842' })

    expect(context.injected).toContainEqual(['settings'])
    expect(context.settingsCalls).toHaveLength(1)
    expect(context.settingsCalls[0]?.presentation).toEqual({ auto: false })
    expect(context.settingsCalls[0]?.owner).toBe(context.fiber)
    expect(context.effects).toBe(1)
  })

  test('keeps working in a profile without a settings service', () => {
    const context = fakeContext({ settingsAvailable: false })

    expect(() => apply(context.ctx, { baseUrl: 'http://127.0.0.1:17842' })).not.toThrow()

    expect(context.registrations).toHaveLength(1)
    expect(context.settingsCalls).toHaveLength(0)
  })

  test('falls back to a console logger when the context has no usable one', () => {
    const context = fakeContext({ loggerThrows: true })
    const lines: string[] = []
    const original = console.info
    console.info = (message: string) => {
      lines.push(String(message))
    }
    try {
      apply(context.ctx, { baseUrl: 'http://127.0.0.1:17842' })
    } finally {
      console.info = original
    }

    expect(context.registrations).toHaveLength(1)
    expect(lines.some(line => line.includes('[chatgpt-web] registered'))).toBe(true)
  })

  test('uses the loader row id as the settings namespace, falling back to the plugin name', () => {
    const custom = fakeContext({ entryId: 'chatgpt-web-alt' })
    apply(custom.ctx, { baseUrl: 'http://127.0.0.1:17842' })
    expect(custom.logs.join('\n')).toContain('settings namespace "chatgpt-web-alt"')

    const fallback = fakeContext()
    apply(fallback.ctx, { baseUrl: 'http://127.0.0.1:17842' })
    expect(fallback.logs.join('\n')).toContain('settings namespace "dsh-chatgpt-web"')
  })

  test('applies the documented defaults when the loader row is empty', () => {
    const context = fakeContext()

    apply(context.ctx, {})

    const info = context.logs.find(message => message.includes('registered'))
    expect(info).toContain('"chatgpt-web/luna"')
    expect(info).toContain('http://127.0.0.1:17842')
  })

  test('exposes the object-plugin form loaders normalize', () => {
    expect(pluginDefault.name).toBe('dsh-chatgpt-web')
    expect(pluginDefault.inject).toEqual(['llm', 'sessions'])
    expect(pluginDefault.apply).toBe(apply)
    expect(pluginDefault.Config).toBe(Config)
    expect(name).toBe('dsh-chatgpt-web')
    expect(inject).toEqual(['llm', 'sessions'])
  })
})

describe('workspaceFor', () => {
  test('sends the basename of the session cwd as the workspace name', async () => {
    const service = fullService()
    const sessions = new Map([['ses-1', { header: { cwd: '/home/raiden/Projects/dsh-chatgpt-web' } }]])
    const context = fakeContext({ sessions })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })
    const metadata = await runTurn(context, 'ses-1', service)

    expect(metadata).toEqual({ dsh_session_id: 'ses-1', workspace: 'dsh-chatgpt-web' })
  })

  test('reduces a nested cwd and a trailing slash to the last path segment', async () => {
    const service = fullService()
    const sessions = new Map([
      ['nested', { header: { cwd: '/srv/work/alpha/beta' } }],
      ['trailing', { header: { cwd: '/srv/work/alpha/beta/' } }],
    ])
    const context = fakeContext({ sessions })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })

    expect((await runTurn(context, 'nested', service)).workspace).toBe('beta')
    expect((await runTurn(context, 'trailing', service)).workspace).toBe('beta')
  })

  test('omits the workspace for an unknown session', async () => {
    const service = fullService()
    const context = fakeContext({ sessions: new Map() })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })
    const metadata = await runTurn(context, 'missing-session', service)

    expect(metadata).toEqual({ dsh_session_id: 'missing-session' })
    expect('workspace' in metadata).toBe(false)
  })

  test('omits the workspace when the session has no cwd', async () => {
    const service = fullService()
    const sessions = new Map([['ses-2', { header: {} }]])
    const context = fakeContext({ sessions })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })
    const metadata = await runTurn(context, 'ses-2', service)

    expect('workspace' in metadata).toBe(false)
  })

  test('omits the workspace when the cwd has no last path segment', async () => {
    const service = fullService()
    const sessions = new Map([['root', { header: { cwd: '/' } }]])
    const context = fakeContext({ sessions })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })
    const metadata = await runTurn(context, 'root', service)

    expect('workspace' in metadata).toBe(false)
  })

  test('omits the workspace when the session lookup fails, without failing the turn', async () => {
    const service = fullService()
    const context = fakeContext({ sessionsThrow: true })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })
    const metadata = await runTurn(context, 'ses-1', service)

    expect('workspace' in metadata).toBe(false)
    expect(service.requests.map(request => request.path)).toEqual(['/v1/chat/completions'])
  })

  test('omits the workspace for a blank session id', async () => {
    const service = fullService()
    const sessions = new Map([['', { header: { cwd: '/srv/work/alpha' } }]])
    const context = fakeContext({ sessions })
    attach(context, service)

    apply(context.ctx, { baseUrl: service.baseUrl })
    const metadata = await runTurn(context, '', service)

    expect('workspace' in metadata).toBe(false)
  })
})

describe('live configuration', () => {
  test('re-reads volatile configuration on every call', async () => {
    const first = fullService('from first')
    const second = fullService('from second')
    let baseUrl = first.baseUrl
    let apiKey: string | undefined = 'key-one'
    const context = fakeContext()
    attach(context, first)
    attach(context, second)

    apply(context.ctx, {
      baseUrl: { get: () => baseUrl },
      apiKey: { get: () => apiKey },
      model: { get: () => 'chatgpt-web/luna' },
      requestTimeoutMs: { get: () => 0 },
    })

    await runTurn(context, 'ses-1', first)
    expect(first.lastRequest.headers.get('authorization')).toBe('Bearer key-one')

    // A settings-page edit is observed without remounting the plugin.
    baseUrl = second.baseUrl
    apiKey = 'key-two'
    await runTurn(context, 'ses-1', second)

    expect(second.requests.map(request => request.path)).toEqual(['/v1/chat/completions'])
    expect(second.lastRequest.headers.get('authorization')).toBe('Bearer key-two')
  })
})

describe('resolvePluginConfig', () => {
  test('applies the documented defaults for an absent row', () => {
    expect(resolvePluginConfig(undefined)).toEqual({
      baseUrl: 'http://127.0.0.1:17842',
      model: 'chatgpt-web/luna',
      requestTimeoutMs: 0,
    })
  })

  test('reads plain values', () => {
    expect(
      resolvePluginConfig({
        baseUrl: 'http://127.0.0.1:17841/p/hidden',
        apiKey: ' key ',
        controlToken: 'token',
        model: 'qwen-chat/qwen3.7-plus',
        requestTimeoutMs: 1500,
      }),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:17841/p/hidden',
      model: 'qwen-chat/qwen3.7-plus',
      requestTimeoutMs: 1500,
      apiKey: 'key',
      controlToken: 'token',
    })
  })

  test('reads live Volatile values through get()', () => {
    const config = resolvePluginConfig({
      baseUrl: { get: () => 'http://127.0.0.1:17842' },
      apiKey: { get: () => 'live-key' },
      model: { get: () => 'chatgpt-web/luna' },
      requestTimeoutMs: { get: () => 250 },
    })

    expect(config.apiKey).toBe('live-key')
    expect(config.requestTimeoutMs).toBe(250)
  })

  test('treats blank strings as unset and falls back to the defaults', () => {
    const config = resolvePluginConfig({ baseUrl: '   ', model: '', apiKey: '  ', controlToken: '' })

    expect(config.baseUrl).toBe('http://127.0.0.1:17842')
    expect(config.model).toBe('chatgpt-web/luna')
    expect('apiKey' in config).toBe(false)
    expect('controlToken' in config).toBe(false)
  })

  test('falls back to the default timeout for an unusable value', () => {
    expect(resolvePluginConfig({ requestTimeoutMs: -1 }).requestTimeoutMs).toBe(0)
    expect(resolvePluginConfig({ requestTimeoutMs: Number.NaN }).requestTimeoutMs).toBe(0)
    expect(resolvePluginConfig({ requestTimeoutMs: 10.9 }).requestTimeoutMs).toBe(10)
  })

  test('passes a malformed baseUrl through unchanged, so the adapter fails instead of redirecting', () => {
    expect(resolvePluginConfig({ baseUrl: 'not a url' }).baseUrl).toBe('not a url')
  })

  test('returns a fresh object on every call, so a live edit is observed', () => {
    const input = { baseUrl: 'http://127.0.0.1:17842' }
    expect(resolvePluginConfig(input)).not.toBe(resolvePluginConfig(input))
  })
})
