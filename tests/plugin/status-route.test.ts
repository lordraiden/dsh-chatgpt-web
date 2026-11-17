/**
 * doc/plugin.md §7 — the same-origin status route the settings page reads.
 *
 * The page runs in the DSH Web GUI's browser origin and cannot call the service directly, so the host
 * answers `GET /plugins/dsh-chatgpt-web/status` on that origin and queries the service server-side.
 * These tests pin the route's contract with a real `Bun.serve` fake service and a real `node:http`
 * listener: the handler receives genuine `IncomingMessage`/`ServerResponse` objects, the adapter's
 * production `fetch` reaches the fake, and the test observes the exact bytes both ways.
 *
 * The Cordis context is simulated with the members the host touches (`llm`, `sessions`, `logger`,
 * `inject`, `effect`, `fiber`, `webServer`), so the route is exercised through the production `apply`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { apply } from '../../src/plugin'
import { STATUS_ROUTE_PATH, type StatusHandler } from '../../src/plugin/status'
import {
  FakeService,
  jsonResponse,
  type RecordedRequest,
} from './fake-service'

/** Every fake service started by a test, stopped after it. */
const running: FakeService[] = []
/** Every route listener started by a test, stopped after it. */
const listeners: Array<{ stop(): void }> = []

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop()
  for (const service of running.splice(0)) service.stop()
})

/** One exact route the fake `webServer` captured. */
interface CapturedRoute {
  readonly kind: string
  readonly path: string
  readonly handler: StatusHandler
}

/** Options for the simulated context. */
interface HostOptions {
  readonly webServer?: boolean
  readonly settings?: boolean
}

/** The simulated Cordis context and everything it recorded. */
interface Host {
  readonly ctx: Parameters<typeof apply>[0]
  readonly routes: CapturedRoute[]
  readonly logs: string[]
  readonly settingsCalls: unknown[]
}

/** Build a Cordis context with only the members the plugin host touches. */
function hostContext(options: HostOptions = {}): Host {
  const routes: CapturedRoute[] = []
  const logs: string[] = []
  const settingsCalls: unknown[] = []
  const ctx = {
    logger: (tag: string) => ({
      info: (message: string) => logs.push(`info ${tag}: ${message}`),
      warn: (message: string) => logs.push(`warn ${tag}: ${message}`),
      error: (message: string) => logs.push(`error ${tag}: ${message}`),
      debug: (message: string) => logs.push(`debug ${tag}: ${message}`),
    }),
    llm: { registerAdapter: () => () => {} },
    sessions: { get: () => undefined },
    fiber: { entry: { options: { id: 'dsh-chatgpt-web' } } },
    inject: (deps: readonly string[], callback: (child: unknown) => void): void => {
      const child = {
        effect: (fn: () => unknown): (() => void) => {
          const disposer = fn()
          return typeof disposer === 'function' ? disposer as () => void : () => {}
        },
        ...(deps.includes('settings') && options.settings !== false
          ? { settings: { configure: (presentation: unknown) => { settingsCalls.push(presentation); return () => {} } } }
          : {}),
        ...(deps.includes('webServer') && options.webServer !== false
          ? { webServer: { register: (route: CapturedRoute) => { routes.push(route); return () => {} } } }
          : {}),
      }
      // Cordis only runs the callback once every requested service is available.
      const missing = deps.some((dep) =>
        (dep === 'settings' && options.settings === false) || (dep === 'webServer' && options.webServer === false))
      if (!missing) callback(child)
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], routes, logs, settingsCalls }
}

/** Start a real HTTP listener around the captured handler. */
async function startRouteServer(handler: StatusHandler): Promise<{ origin: string; stop(): void }> {
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the route listener has no port')
  const listener = {
    origin: `http://127.0.0.1:${address.port}`,
    stop: (): void => {
      server.closeAllConnections()
      server.close()
    },
  }
  listeners.push(listener)
  return listener
}

/** The catalogue rows the fake service serves; the third row is not this plugin's route. */
const CATALOGUE = {
  object: 'list',
  models: [
    { slug: 'chatgpt-web/luna', name: 'Luna', context_window: 32_000 },
    { slug: 'qwen-chat/qwen3', name: 'Qwen3', context_window: 32_000 },
    { slug: 'other/model', name: 'Other', context_window: 8_000 },
  ],
}

/** One verified provider row, in the service's auth-health shape. */
const VERIFIED_ROW = {
  providerId: 'chatgpt-web',
  label: 'ChatGPT',
  state: 'verified',
  capturePresent: true,
  verifiedAt: '2026-01-01T00:00:00.000Z',
  checkedAt: '2026-01-01T00:00:00.000Z',
  code: null,
  reason: null,
}

/** Options for the fake service's scripted answers. */
interface ServiceScript {
  readonly healthStatus?: number
  readonly healthBody?: unknown
  readonly storageStatePresent?: boolean
  readonly providers?: readonly unknown[]
}

/** A fake service that answers every endpoint the status route reads. */
function startService(script: ServiceScript = {}): FakeService {
  const service = FakeService.start((request: RecordedRequest): Response => {
    switch (request.path) {
      case '/healthz':
        return jsonResponse(script.healthStatus ?? 200, script.healthBody ?? {
          status: 'ok',
          service: 'dsh-chatgpt-web',
          version: '9.9.9',
        })
      case '/v1/control/status':
        return jsonResponse(200, {
          status: 'ok',
          service: 'dsh-chatgpt-web',
          version: '9.9.9',
          storageStatePresent: script.storageStatePresent ?? true,
        })
      case '/v1/control/auth/health':
        return jsonResponse(200, {
          ok: true,
          checkedAt: '2026-01-01T00:00:00.000Z',
          cache: { ttlMs: 60_000 },
          providers: script.providers ?? [VERIFIED_ROW],
        })
      case '/p/hidden/v1/models':
      case '/v1/models':
        return jsonResponse(200, CATALOGUE)
      default:
        return jsonResponse(404, { error: { message: 'not found' } })
    }
  })
  running.push(service)
  return service
}

/** The fake service's recorded request for one path; fails when it never arrived. */
function requestFor(service: FakeService, path: string): RecordedRequest {
  const request = service.requests.find(entry => entry.path === path)
  if (request === undefined) throw new Error(`the fake service received no ${path} request`)
  return request
}

/** Apply the plugin against a fake service and expose the captured route listener. */
async function startHost(
  service: FakeService,
  overrides: { readonly apiKey?: string; readonly controlToken?: string; readonly baseUrl?: string } = {},
): Promise<{ host: Host; origin: string; url: string }> {
  const host = hostContext()
  apply(host.ctx, {
    baseUrl: overrides.baseUrl ?? `${service.baseUrl}/p/hidden`,
    ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
    ...(overrides.controlToken === undefined ? {} : { controlToken: overrides.controlToken }),
    model: 'chatgpt-web/luna',
    requestTimeoutMs: 0,
  })
  const route = host.routes.find(entry => entry.path === STATUS_ROUTE_PATH)
  if (route === undefined) throw new Error('the host registered no status route')
  const listener = await startRouteServer(route.handler)
  return { host, origin: listener.origin, url: `${listener.origin}${STATUS_ROUTE_PATH}` }
}

describe('status route', () => {
  test('registers one exact GET route on the plugin path', async () => {
    const service = startService()
    const { host } = await startHost(service, { apiKey: 'api-key', controlToken: 'control-token' })
    expect(host.routes).toHaveLength(1)
    expect(host.routes[0]!.kind).toBe('exact')
    expect(host.routes[0]!.path).toBe('/plugins/dsh-chatgpt-web/status')
  })

  test('answers the documented shape from the live service', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-secret-123', controlToken: 'control-secret-456' })

    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({
      service: { reachable: true, version: '9.9.9', status: 'ok', error: null },
      auth: { configured: true, state: 'verified', detail: 'ChatGPT: verified' },
      // The whole public catalogue, in order: the page reports the service total and filters the
      // subset this plugin serves itself.
      models: ['chatgpt-web/luna', 'qwen-chat/qwen3', 'other/model'],
      controlBase: service.baseUrl,
      authPageUrl: `${service.baseUrl}/v1/control/auth/`,
    })
  })

  test('queries the service server-side with the right authority per endpoint', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-secret-123', controlToken: 'control-secret-456' })
    await fetch(url)

    // Root-scoped endpoints ignore the `/p/hidden` profile prefix; the catalogue keeps it.
    expect(requestFor(service, '/healthz').headers.get('authorization')).toBeNull()
    expect(requestFor(service, '/v1/control/status').headers.get('authorization')).toBe('Bearer control-secret-456')
    expect(requestFor(service, '/v1/control/auth/health').headers.get('authorization')).toBe('Bearer control-secret-456')
    expect(requestFor(service, '/p/hidden/v1/models').headers.get('authorization')).toBe('Bearer api-secret-123')
  })

  test('never echoes a secret or a userinfo-bearing base URL', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-secret-123', controlToken: 'control-secret-456' })
    const text = await (await fetch(url)).text()
    expect(text).not.toContain('api-secret-123')
    expect(text).not.toContain('control-secret-456')
    expect(text).not.toContain('apiKey')
    expect(text).not.toContain('controlToken')
  })

  test('serves GET and HEAD only, with 405 for every other method', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-key', controlToken: 'control-token' })

    const get = await fetch(url)
    const getBody = await get.text()

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(getBody)))

    const post = await fetch(url, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect(await post.text()).toBe('')
  })

  test('reports an unreachable service as 200 JSON instead of failing the page', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-key', controlToken: 'control-token' })
    service.stop()

    const response = await fetch(url)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      service: { reachable: boolean; error: string | null }
      auth: { configured: boolean; state: string | null; detail: string | null } | null
      models: string[]
    }
    expect(body.service.reachable).toBe(false)
    expect(body.service.error).not.toBeNull()
    expect(body.models).toEqual([])
    expect(body.auth).toEqual({ configured: false, state: null, detail: expect.stringContaining('unavailable') })
  })

  test('reports a non-2xx health answer as unreachable with its status code', async () => {
    const service = startService({ healthStatus: 503, healthBody: { error: 'draining' } })
    const { url } = await startHost(service, { apiKey: 'api-key', controlToken: 'control-token' })
    const body = await (await fetch(url)).json() as { service: { reachable: boolean; error: string | null } }
    expect(body.service.reachable).toBe(false)
    expect(body.service.error).toBe('HTTP 503')
  })

  test('leaves auth null when no control token is configured', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-key' })
    const body = await (await fetch(url)).json() as { auth: unknown; service: { reachable: boolean } }
    expect(body.auth).toBeNull()
    expect(body.service.reachable).toBe(true)
    // The guarded endpoints are never called without the token.
    expect(service.requests.some(request => request.path === '/v1/control/status')).toBe(false)
    expect(service.requests.some(request => request.path === '/v1/control/auth/health')).toBe(false)
  })

  test('reports an expired account from the auth surface', async () => {
    const service = startService({
      storageStatePresent: false,
      providers: [{
        providerId: 'chatgpt-web',
        label: 'ChatGPT',
        state: 'expired',
        capturePresent: true,
        verifiedAt: null,
        checkedAt: '2026-01-01T00:00:00.000Z',
        code: 'import_expired',
        reason: 'Sign in at /v1/control/auth/ (choose "ChatGPT"), then check again.',
      }],
    })
    const { url } = await startHost(service, { apiKey: 'api-key', controlToken: 'control-token' })
    const body = await (await fetch(url)).json() as {
      auth: { configured: boolean; state: string; detail: string }
    }
    expect(body.auth.configured).toBe(true)
    expect(body.auth.state).toBe('expired')
    expect(body.auth.detail).toContain('Sign in at /v1/control/auth/')
  })

  test('answers 200 JSON for an invalid base URL, without echoing it', async () => {
    const service = startService()
    const { url } = await startHost(service, { apiKey: 'api-key', baseUrl: 'http://user:pass@not a url' })
    const response = await fetch(url)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('user:pass')
    const body = JSON.parse(text) as {
      service: { reachable: boolean; error: string | null }
      controlBase: string
      authPageUrl: string
    }
    expect(body.service.reachable).toBe(false)
    expect(body.service.error).toBe('invalid baseUrl')
    expect(body.controlBase).toBe('')
    expect(body.authPageUrl).toBe('')
  })

  test('does not fail the plugin when webServer is unavailable', async () => {
    const host = hostContext({ webServer: false })
    expect(() => apply(host.ctx, { baseUrl: 'http://127.0.0.1:1', model: 'chatgpt-web/luna' })).not.toThrow()
    expect(host.routes).toHaveLength(0)
  })
})
