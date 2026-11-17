/**
 * Plugin configuration: the loader-facing schema, the documented defaults, and the normalized
 * {@link PluginConfig} the adapter reads on every call (doc/plugin.md §7).
 *
 * The loader owns persistence, so this module only describes and normalizes:
 *
 * - every field is declared `volatile()`, which is what lets a settings-page edit be applied live
 *   (`loader/volatile-update`) instead of remounting the plugin, and what lets the host's
 *   `configForms` surface write it at all — that surface exposes and accepts volatile fields only;
 * - `apply()` therefore receives `Volatile<T>` wrappers, and {@link resolvePluginConfig} reads them
 *   through `.get()`. It also accepts plain values, so a test or a hand-written profile row can pass
 *   either shape;
 * - `apiKey` and `controlToken` are literal secrets, not credential references: the adapter sends
 *   them to the service directly. They are marked `role('secret')` — the host's convention for a
 *   value that must be redacted from settings descriptors and rendered as a write-only input — and
 *   deliberately not `role('credential-ref')`, which would promise resolution through the
 *   credentials service.
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PluginConfig } from './contract'

/** Service root used when the profile row does not set one (the DSH-side instance, doc/plugin.md §8). */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:17842'

/** Catalogue route used when the profile row does not set one. */
export const DEFAULT_MODEL = 'chatgpt-web/luna'

/** No client-side timeout by default: the service sends SSE keep-alives while a turn runs. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 0

/** A configuration value as `apply()` may receive it: a plain value or a live loader `Volatile`. */
export type ConfigValue<T> = T | Volatile<T>

/** Parsed loader configuration: every field is live, so an edit is observed without a restart. */
export interface Config {
  /** Service root, e.g. `http://127.0.0.1:17842`; may include `/p/<profile>`. */
  baseUrl: Volatile<string>
  /** Service API key (`DSH_CHATGPT_WEB_API_KEY`); absent on a loopback service without one. */
  apiKey: Volatile<string | undefined>
  /** Service control token, used only for status/auth reads; absent when unused. */
  controlToken: Volatile<string | undefined>
  /** Default model route id from the service catalogue, e.g. `chatgpt-web/luna`. */
  model: Volatile<string>
  /** Client-side HTTP timeout in milliseconds; `0` means no client timeout. */
  requestTimeoutMs: Volatile<number>
}

/** The loader-facing schema; {@link Config} above is its parsed output. */
export const Config = z.object({
  baseUrl: z.string()
    .default(DEFAULT_BASE_URL)
    .description('Service root; may include an endpoint profile: http://127.0.0.1:17842/p/<profile>.')
    .volatile(),
  // Optional secrets carry no default: an absent value must stay absent so the settings surface can
  // tell "not configured" from "configured" (its redaction reports `set` per secret field).
  apiKey: z.string()
    .role('secret')
    .description('Service API key; optional on a loopback service.')
    .volatile(),
  controlToken: z.string()
    .role('secret')
    .description('Service control token; used only for status and sign-in reads.')
    .volatile(),
  model: z.string()
    .default(DEFAULT_MODEL)
    .description('Default catalogue model route served by the service.')
    .volatile(),
  requestTimeoutMs: z.number()
    .step(1)
    .min(0)
    .default(DEFAULT_REQUEST_TIMEOUT_MS)
    .description('Client-side HTTP timeout in milliseconds; 0 disables it.')
    .volatile(),
})

/** What `apply()` may receive: the parsed loader config, or a plain object with any subset of it. */
export interface PluginConfigInput {
  readonly baseUrl?: ConfigValue<string>
  readonly apiKey?: ConfigValue<string | undefined>
  readonly controlToken?: ConfigValue<string | undefined>
  readonly model?: ConfigValue<string>
  readonly requestTimeoutMs?: ConfigValue<number>
}

/** Read a loader value that may be plain or live. */
function readValue<T>(value: ConfigValue<T> | undefined): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    // `Volatile.get()` is typed with `VolatileSnapshot<T>`; every field here is a primitive, so the
    // snapshot is the value itself.
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/** Read a non-empty trimmed string; blank means "not configured". */
function readText(value: ConfigValue<string | undefined> | undefined): string | undefined {
  const raw = readValue(value)
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read a non-negative integer timeout; anything unusable falls back to the documented default. */
function readTimeout(value: ConfigValue<number> | undefined): number {
  const raw = readValue(value)
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.floor(raw)
}

/**
 * Normalize the loader configuration into the adapter's {@link PluginConfig}.
 *
 * Defaults are applied only when a field is absent or blank. A present but malformed `baseUrl` is
 * passed through unchanged so the adapter fails the turn with an explicit `INVALID_CONFIG` instead of
 * silently redirecting it to the default service — the two service instances in doc/plugin.md §8
 * serve two different accounts. Secrets are trimmed, and a blank secret means "unset", so an empty
 * form field can never reach the service as an empty `Bearer`.
 *
 * @param input - the loader configuration, live or plain, possibly partial.
 * @returns the resolved configuration; a fresh object on every call, so a live edit is observed.
 */
export function resolvePluginConfig(input: PluginConfigInput | undefined): PluginConfig {
  const apiKey = readText(input?.apiKey)
  const controlToken = readText(input?.controlToken)
  return {
    baseUrl: readText(input?.baseUrl) ?? DEFAULT_BASE_URL,
    model: readText(input?.model) ?? DEFAULT_MODEL,
    requestTimeoutMs: readTimeout(input?.requestTimeoutMs),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(controlToken === undefined ? {} : { controlToken }),
  }
}
