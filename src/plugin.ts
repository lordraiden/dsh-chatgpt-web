/**
 * DSH plugin host: registers the container service as a text-only LLM provider
 * (doc/plugin.md §2, §3.1, §7).
 *
 * The host owns only the DSH-facing seam:
 *
 * - the loader configuration (`src/plugin/config.ts`) and its live reads;
 * - the DSH session → workspace-name lookup the adapter sends as first-message context;
 * - the sanitized logger and the settings-page policy;
 * - the single `ctx.llm.registerAdapter` registration for {@link PROVIDERS}.
 *
 * It owns no transport, no browser, no conversation state and no service lifecycle: the adapter
 * (`src/plugin/adapter.ts`) speaks the service HTTP API, and the container service keeps the browser,
 * provider conversations, continuity, retries and concurrency. The plugin never spawns the service,
 * never reads its data volume and never stores a transcript (doc/plugin.md §1, §4).
 */
import { basename } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
// Type-only: `@deepseek-ai/dsh-llm` augments `Context` with the `llm` runtime this plugin registers on.
import type {} from '@deepseek-ai/dsh-llm'
import { createChatGptWebAdapter } from './plugin/adapter'
import { Config, resolvePluginConfig, type PluginConfigInput } from './plugin/config'
import { PROVIDERS, type PluginConfig, type PluginLogger } from './plugin/contract'
import { STATUS_ROUTE_PATH, createStatusHandler, type StatusHandler } from './plugin/status'

export { Config } from './plugin/config'

/** Plugin name: the loader row id in `cordis.patch.yml`, and the default settings namespace. */
export const name = 'dsh-chatgpt-web'

/**
 * Required DSH services.
 *
 * `llm` is the registry the adapter is registered on. `sessions` is required because the plugin's
 * only initialization context is the session's workspace name, resolved from `session.header.cwd`;
 * it is a core DSH service, so requiring it does not narrow the profiles this plugin can load in.
 */
export const inject = ['llm', 'sessions']

/** Tag used by the fallback console logger; `ctx.logger` already namespaces its own messages. */
const LOG_TAG = 'chatgpt-web'

/** One DSH session, reduced to the header facts this plugin reads. */
interface SessionLike {
  readonly header?: { readonly cwd?: string }
}

/** `ctx.sessions` (dsh-session), structural: only the id lookup is used. */
interface SessionsLike {
  get(id: string): SessionLike | undefined
}

/** `ctx.settings` (dsh-settings), structural: only the page policy is used. */
interface SettingsLike {
  configure(presentation: { auto?: boolean }, owner?: Fiber): () => void
}

/** One exact HTTP route, as `dsh-host-webserver` registers it. */
interface WebRouteLike {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: StatusHandler
}

/** `ctx.webServer` (dsh-host-webserver), structural: only exact-route registration is used. */
interface WebServerLike {
  register(route: WebRouteLike): () => void
}

/** The loader row this plugin instance was mounted from (augmented by `cordis-plugin-loader`). */
interface LoaderEntryLike {
  readonly options?: { readonly id?: string }
}

/**
 * The plugin context: Cordis `Context` plus the DSH services this plugin reads.
 *
 * `sessions`, `settings` and the loader `entry` are typed structurally because the packages that
 * augment them (`dsh-session`, `dsh-settings`, `cordis-plugin-loader`) are not dependencies of this
 * package; the runtime contract is the one documented in `.dsh/analysis/03-dsh-contract.md` §2.4, §6.
 */
type PluginContext = Context & {
  readonly sessions: SessionsLike
  readonly fiber: Fiber & { readonly entry?: LoaderEntryLike }
}

/**
 * The sanitized logger the adapter may use.
 *
 * `ctx.logger` is Cordis's callable logger service, and its methods are printf-style: a literal `%`
 * in a message would be read as a placeholder (a percent-encoded endpoint path, for instance), so
 * every message is escaped before it reaches the host logger. A profile without a console exporter
 * still gets a working facade, so the fallback only covers a context that has no logger at all.
 * Every message this plugin logs is static text plus a credential-free endpoint description — never
 * an API key, a control token, a cookie or a message body.
 * @param ctx - the plugin context.
 * @returns the logger facade the adapter receives.
 */
function createLogger(ctx: PluginContext): PluginLogger {
  try {
    const logger = ctx.logger?.(LOG_TAG)
    if (logger !== undefined && typeof logger.info === 'function') {
      return {
        info: (message) => logger.info(escapeFormat(message)),
        warn: (message) => logger.warn(escapeFormat(message)),
        error: (message) => logger.error(escapeFormat(message)),
        debug: (message) => logger.debug(escapeFormat(message)),
      }
    }
  } catch {
    // A context without a usable logger must not prevent provider registration.
  }
  return {
    info: (message) => console.info(`[${LOG_TAG}] ${message}`),
    warn: (message) => console.warn(`[${LOG_TAG}] ${message}`),
    error: (message) => console.error(`[${LOG_TAG}] ${message}`),
    debug: (message) => console.debug(`[${LOG_TAG}] ${message}`),
  }
}

/** Escape `%` so a dynamic value is never interpreted as a printf placeholder. */
function escapeFormat(message: string): string {
  return message.replace(/%/g, '%%')
}

/**
 * Describe the configured service root for a diagnostic without ever echoing userinfo.
 *
 * The configured `baseUrl` is operator input: it may embed credentials, so it is never logged raw.
 * @param baseUrl - the resolved service root.
 * @returns the origin plus path, or a fixed placeholder when the value is not a URL.
 */
function describeEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    url.username = ''
    url.password = ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return '<invalid baseUrl>'
  }
}

/**
 * Apply the plugin: register one text-only adapter for every route this plugin serves.
 *
 * The registration is effect-owned by this plugin's fiber (`ctx.llm.registerAdapter` is a
 * `ctx.effect`), so there is no manual dispose. Configuration is re-read on every adapter call, so a
 * live settings edit is observed without a restart.
 * @param ctx - the plugin context, with `llm` and `sessions` injected.
 * @param config - the loader configuration, live or plain.
 */
export function apply(ctx: PluginContext, config: PluginConfigInput): void {
  const logger = createLogger(ctx)
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name
  const currentConfig = (): PluginConfig => resolvePluginConfig(config)

  /**
   * The workspace name of a DSH session, or `undefined` when it cannot be resolved.
   *
   * `session.header.cwd` is the only source: the last path segment is the workspace name the service
   * puts in the first-message header. A missing session, a missing `cwd`, a blank name or an
   * unavailable service all mean "unknown" — the adapter then omits the field rather than fabricating
   * a name (doc/plugin.md §3.3, §5). The lookup is read per call so a replaced service is observed.
   */
  const workspaceFor = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined || sessionId === '') return undefined
    let session: SessionLike | undefined
    try {
      session = ctx.sessions.get(sessionId)
    } catch {
      // A workspace name is optional context, never identity: a failed lookup must not fail a turn.
      return undefined
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string') return undefined
    const workspace = basename(cwd)
    return workspace === '' ? undefined : workspace
  }

  const adapter = createChatGptWebAdapter({ config: currentConfig, workspaceFor, logger })

  // One registration for both routes; released with this plugin's fiber.
  ctx.llm.registerAdapter([...PROVIDERS], adapter)

  // The settings page runs in the GUI's browser origin and cannot call the service (a different
  // origin, and the service's CORS covers only `/v1/control/*`), so the host answers its status read
  // on the same origin and the control token never reaches the browser. `webServer` is optional: a
  // profile without it simply has no status route, and the provider registration is unaffected.
  ctx.inject(['webServer'], (child) => {
    const webServer = (child as Context & { webServer?: WebServerLike }).webServer
    if (webServer === undefined) return
    child.effect(() => webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE_PATH,
      handler: createStatusHandler({ config: currentConfig, logger }),
    }))
  })

  // This plugin ships its own settings page (client.js), so the host must not also generate an
  // automatic form from the raw schema; the page owns the fields and the host owns persistence
  // (doc/plugin.md §7). `settings` is optional: a profile without it simply keeps no page policy.
  ctx.inject(['settings'], (child) => {
    const settings = (child as Context & { settings?: SettingsLike }).settings
    if (settings === undefined) return
    child.effect(() => settings.configure({ auto: false }, ctx.fiber))
  })

  const initial = currentConfig()
  logger.info(
    `registered ${PROVIDERS.map((provider) => `"${provider}"`).join(', ')} for model "${initial.model}"`
      + ` via ${describeEndpoint(initial.baseUrl)} (settings namespace "${settingsNs}")`,
  )
}

/** Object-plugin form for loaders that normalize `module.default` before the named exports. */
export default { name, inject, Config, apply }
