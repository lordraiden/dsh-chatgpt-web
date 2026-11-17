/**
 * The seam between the plugin host (`src/plugin.ts`) and its text-only adapter
 * (`src/plugin/adapter.ts`).
 *
 * Both sides import these types so the two files can be written independently without drifting:
 * the host owns configuration and DSH session resolution, the adapter owns the HTTP/SSE transport.
 * Nothing here is provider-private: the adapter is the only owner of the service wire format.
 */

/** The provider routes this plugin registers with DSH's LLM runtime. */
export const PROVIDERS = ["chatgpt-web", "qwen-chat"] as const;

/** One registered provider route. */
export type ProviderId = (typeof PROVIDERS)[number];

/**
 * Resolved plugin configuration, as the host reads it from the loader row.
 *
 * `apiKey` and `controlToken` are secrets: the adapter may send them, but neither the host nor the
 * adapter may log them or persist them anywhere outside the loader's own settings storage.
 */
export interface PluginConfig {
  /** Service root, e.g. `http://127.0.0.1:17842`; may include `/p/<profile>`. */
  readonly baseUrl: string;
  /** Service API key (`DSH_CHATGPT_WEB_API_KEY`); optional on a loopback service without one. */
  readonly apiKey?: string;
  /** Service control token, used only for status/auth reads. */
  readonly controlToken?: string;
  /** Default model route id from the service catalogue, e.g. `chatgpt-web/luna`. */
  readonly model: string;
  /** Client-side HTTP timeout in milliseconds; `0` means no client timeout. */
  readonly requestTimeoutMs: number;
}

/** Minimal logger surface the adapter may use; every message must be sanitized by the caller. */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

/** What the adapter needs from the host. */
export interface AdapterDeps {
  /** Current configuration; read per call so a live settings change is observed without a restart. */
  config(): PluginConfig;
  /**
   * The workspace name of a DSH session, when the host can resolve it.
   *
   * It is the only initialization context the plugin sends to the provider (first message of a
   * conversation). Returning `undefined` means "unknown": the adapter omits the field and never
   * fabricates a name.
   */
  workspaceFor(sessionId: string | undefined): string | undefined;
  /** Sanitized diagnostics only; never a token, a cookie or a message body. */
  logger?: PluginLogger;
}
