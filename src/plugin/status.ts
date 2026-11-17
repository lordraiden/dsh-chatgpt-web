/**
 * Same-origin status proxy for the plugin's settings page (doc/plugin.md §7).
 *
 * The settings page runs in the DSH Web GUI's browser origin, and the service is a different origin
 * (`http://127.0.0.1:17842`) whose CORS is limited to `/v1/control/*` with a fixed origin, so the page
 * cannot call the service directly. The host answers instead: the browser asks the origin it was
 * served from, the host queries the service server-side, and the control token never leaves the host
 * process.
 *
 * The route is deliberately read-only and total: it always answers `200 application/json`, even when
 * the service is down or the token is wrong, because a status panel must be able to say "unreachable"
 * instead of failing the page load. Every string it echoes is truncated and has the configured
 * secrets redacted, and the response never carries `apiKey` or `controlToken`.
 *
 * The service's control surface is root-scoped (`/v1/control/*` is resolved before the endpoint
 * profile prefix, `src/server.ts`), while the model catalogue is profile-scoped, so `baseUrl` is
 * split into `root` (for `/healthz` and `/v1/control/*`) and the full API base (for `/v1/models`).
 * The catalogue read here is display-only and deliberately lists the service's whole public
 * catalogue: the settings page shows "N served by this plugin / M in the catalogue", while the
 * adapter stays the owner of the contract that decides which routes are served and their context
 * windows.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginConfig, PluginLogger } from './contract'

/** Exact route the settings page reads; it must match the plugin row id in `cordis.patch.yml`. */
export const STATUS_ROUTE_PATH = '/plugins/dsh-chatgpt-web/status'

/** One status read is bounded so a page load cannot hang on a wedged service. */
export const STATUS_TIMEOUT_MS = 5_000

/** Longest diagnostic string this route will echo. */
const MAX_TEXT = 200

/** The service's health, as the page needs to render it. */
export interface StatusServiceView {
  /** Whether `/healthz` answered 2xx. */
  reachable: boolean
  /** `version` from the health body, when it is a string. */
  version: string | null
  /** `status` from the health body, when it is a string. */
  status: string | null
  /** Sanitized reason the service is not reachable, or `null` when it is. */
  error: string | null
}

/** The service account's sign-in state, when the plugin may read the guarded control surface. */
export interface StatusAuthView {
  /** Whether the service reports a stored account (control status or auth health). */
  configured: boolean
  /** Aggregate provider state: `verified`, `expired`, `absent`, `unverifiable` or `unknown`. */
  state: string | null
  /** One sanitized sentence naming the operator's next action, or `null`. */
  detail: string | null
}

/** The exact JSON body `GET /plugins/dsh-chatgpt-web/status` returns. */
export interface PluginStatus {
  service: StatusServiceView
  /** `null` when no control token is configured, so the guarded surface cannot be read. */
  auth: StatusAuthView | null
  /** Every catalogue route id the service publishes, in catalogue order; never secrets. */
  models: string[]
  /** Service root without the `/p/<profile>` suffix, for `/v1/control/*` links. */
  controlBase: string
  /** The service's interactive sign-in page. */
  authPageUrl: string
}

/** What the route needs from the host. */
export interface StatusRouteDeps {
  /** Live plugin configuration; read once per request. */
  config(): PluginConfig
  /** Sanitized diagnostics only; never a token or a body. */
  logger?: PluginLogger
  /** Bound for the whole read; defaults to {@link STATUS_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** The Node request handler the host registers on the exact route. */
export type StatusHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** One fetch reduced to what the response may safely carry. */
type FetchOutcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: string }

/** The two service bases derived from the configured `baseUrl`. */
interface Endpoints {
  /** Root the control surface and `/healthz` live on. */
  readonly controlBase: string
  /** Full API base, including an endpoint profile prefix. */
  readonly apiBase: string
}

/**
 * Create the route handler.
 *
 * Only `GET` and `HEAD` are served; every other method receives `405` with an `Allow` header. The
 * body is computed once and reused for `HEAD`, so the headers describe exactly what a `GET` would
 * return.
 * @param deps - live configuration, the catalogue reader and the sanitized logger.
 * @returns the handler the host registers on {@link STATUS_ROUTE_PATH}.
 */
export function createStatusHandler(deps: StatusRouteDeps): StatusHandler {
  const timeoutMs = deps.timeoutMs ?? STATUS_TIMEOUT_MS
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    let status: PluginStatus
    try {
      status = await readStatus(deps, timeoutMs)
    } catch (error) {
      // The route must answer JSON even when the unexpected happens; the page then shows "unknown".
      deps.logger?.warn(`status route failed (${errorName(error)})`)
      status = unavailableStatus('status unavailable')
    }
    const body = JSON.stringify(status)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

/**
 * Read the whole status once, in parallel, under one deadline.
 *
 * Four fixed reads, no caller-supplied URL, header or body: the unauthenticated health probe, the two
 * guarded control reads (only with a token) and the display-only catalogue. A failed call never fails
 * the route: each failure becomes a sanitized `error`/`detail` string.
 * @param deps - the route dependencies.
 * @param timeoutMs - the whole read's bound.
 * @returns the response body.
 */
async function readStatus(deps: StatusRouteDeps, timeoutMs: number): Promise<PluginStatus> {
  let config: PluginConfig
  try {
    config = deps.config()
  } catch {
    return unavailableStatus('invalid configuration')
  }
  const endpoints = endpointsFor(config.baseUrl)
  if (endpoints === undefined) return unavailableStatus('invalid baseUrl')

  const secrets = [config.apiKey, config.controlToken]
    .filter((secret): secret is string => typeof secret === 'string' && secret !== '')
  const signal = AbortSignal.timeout(timeoutMs)
  const bearer = config.controlToken === undefined
    ? undefined
    : { authorization: `Bearer ${config.controlToken}` }

  const [health, control, authHealth, models] = await Promise.all([
    fetchJson(`${endpoints.controlBase}/healthz`, {}, signal),
    bearer === undefined
      ? Promise.resolve<FetchOutcome | undefined>(undefined)
      : fetchJson(`${endpoints.controlBase}/v1/control/status`, bearer, signal),
    bearer === undefined
      ? Promise.resolve<FetchOutcome | undefined>(undefined)
      : fetchJson(`${endpoints.controlBase}/v1/control/auth/health`, bearer, signal),
    readCatalogue(endpoints, config.apiKey, signal),
  ])

  return {
    service: serviceView(health, secrets),
    auth: authView(config.controlToken, control, authHealth, secrets),
    models: [...new Set(models)].map(model => sanitize(model, secrets)),
    controlBase: endpoints.controlBase,
    authPageUrl: `${endpoints.controlBase}/v1/control/auth/`,
  }
}

/** Reduce the unauthenticated health read to the page's service view. */
function serviceView(outcome: FetchOutcome, secrets: readonly string[]): StatusServiceView {
  if (!outcome.ok) {
    return { reachable: false, version: null, status: null, error: sanitize(outcome.error, secrets) }
  }
  const body = asRecord(outcome.body)
  return {
    reachable: true,
    version: typeof body?.version === 'string' ? sanitize(body.version, secrets) : null,
    status: typeof body?.status === 'string' ? sanitize(body.status, secrets) : null,
    error: null,
  }
}

/**
 * Reduce the two guarded control reads to the page's auth view.
 *
 * `configured` is true when either the control status reports a stored capture
 * (`storageStatePresent`) or the auth health reports one (`capturePresent`). The state/detail come
 * from the auth health rows: a verified provider wins, otherwise the first row. With no control token
 * the guarded surface cannot be read at all, so the view is `null` rather than a guessed "absent".
 * @param controlToken - the configured control token, if any.
 * @param control - the control-status outcome, or `undefined` without a token.
 * @param health - the auth-health outcome, or `undefined` without a token.
 * @param secrets - configured secret values to redact from echoed text.
 * @returns the auth view, or `null` when it cannot be read.
 */
function authView(
  controlToken: string | undefined,
  control: FetchOutcome | undefined,
  health: FetchOutcome | undefined,
  secrets: readonly string[],
): StatusAuthView | null {
  if (controlToken === undefined) return null

  const controlBody = control?.ok === true ? asRecord(control.body) : undefined
  const healthBody = health?.ok === true ? asRecord(health.body) : undefined
  const rows = healthBody !== undefined && Array.isArray(healthBody.providers)
    ? healthBody.providers
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined)
    : []

  const configured = controlBody?.storageStatePresent === true
    || rows.some(row => row.capturePresent === true)
  const primary = rows.find(row => row.state === 'verified') ?? rows[0]
  const state = primary !== undefined && typeof primary.state === 'string' ? primary.state : null
  const label = primary !== undefined && typeof primary.label === 'string' ? primary.label.trim() : ''
  const reason = primary !== undefined && typeof primary.reason === 'string' ? primary.reason.trim() : ''

  const detail = reason !== ''
    ? reason
    : label !== '' && state !== null
      ? `${label}: ${state}`
      : control?.ok === false
        ? `control token rejected or control status unavailable (${control.error})`
        : health?.ok === false
          ? `auth health unavailable (${health.error})`
          : null

  return {
    configured,
    state: state === null ? null : sanitize(state, secrets),
    detail: detail === null ? null : sanitize(detail, secrets),
  }
}

/** The response body used when the read cannot start at all. */
function unavailableStatus(error: string): PluginStatus {
  return {
    service: { reachable: false, version: null, status: null, error },
    auth: null,
    models: [],
    controlBase: '',
    authPageUrl: '',
  }
}

/**
 * Split the configured service root into the control root and the full API base.
 *
 * The endpoint profile prefix (`/p/<name>`) scopes the public API only: `/healthz` and
 * `/v1/control/*` are resolved before it. Userinfo, query and fragment are dropped, so a `baseUrl`
 * that embeds credentials can never be echoed by this route.
 * @param baseUrl - the configured service root.
 * @returns both bases, or `undefined` when the value is not an HTTP(S) URL.
 */
function endpointsFor(baseUrl: string): Endpoints | undefined {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const apiPath = url.pathname.replace(/\/+$/, '')
  const profile = /^(.*)\/p\/[^/]+$/.exec(apiPath)
  const controlPath = profile === null ? apiPath : profile[1]!
  return {
    controlBase: `${url.origin}${controlPath}`,
    apiBase: `${url.origin}${apiPath}`,
  }
}

/** Fetch one JSON endpoint, reducing every failure to a sanitized code. */
async function fetchJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, error: `HTTP ${response.status}` }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, error: 'invalid response' }
    }
    return { ok: true, body }
  } catch (error) {
    return { ok: false, error: describeFetchError(error) }
  }
}

/** Reduce a fetch failure to a stable, credential-free code. */
function describeFetchError(error: unknown): string {
  const name = errorName(error)
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  return 'unreachable'
}

/** The error's class name, never its message (which may embed a URL or a path). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown'
}

/**
 * Read the service's public catalogue ids for the settings page.
 *
 * Display-only: it accepts the same `models[]`/`data[]` shapes the adapter tolerates, keeps the
 * catalogue order, drops duplicates, and never filters by provider — the page reports both the
 * service total and the subset this plugin serves. A failed read is an empty list, never an error.
 * @param endpoints - the derived service bases.
 * @param apiKey - the configured service API key, when there is one.
 * @param signal - the route's deadline.
 * @returns the catalogue route ids.
 */
async function readCatalogue(
  endpoints: Endpoints,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  const headers: Record<string, string> = apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }
  const outcome = await fetchJson(`${endpoints.apiBase}/v1/models`, headers, signal)
  if (!outcome.ok) return []
  const body = asRecord(outcome.body)
  const rows = Array.isArray(body?.models) && body.models.length > 0
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : []
  const slugs: string[] = []
  const seen = new Set<string>()
  for (const entry of rows) {
    const row = asRecord(entry)
    if (row === undefined) continue
    const slug = typeof row.slug === 'string'
      ? row.slug.trim()
      : typeof row.id === 'string'
        ? row.id.trim()
        : ''
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    slugs.push(slug)
  }
  return slugs
}

/** Read a JSON object without trusting its shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Make one echoed string safe: collapse control characters, redact the configured secrets, truncate.
 * @param text - the value to echo.
 * @param secrets - configured secret values that must never appear in the response.
 * @returns the sanitized text.
 */
function sanitize(text: string, secrets: readonly string[]): string {
  let clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  for (const secret of secrets) {
    if (secret !== '') clean = clean.split(secret).join('[redacted]')
  }
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean
}
