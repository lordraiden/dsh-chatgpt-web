/**
 * Qwen Code (`coder.qwen.ai`) provider constants (issue #299, slice 1).
 *
 * The captured network surface this module describes was observed, not invented: the shapes named
 * here come from a recorded HAR of the signed-in web app (paths, methods and JSON keys only — no
 * cookie, token or header value is reproduced anywhere in this adapter).
 *
 * Qwen Code is a **network** provider, not a DOM one. The browser is only the session holder:
 *
 * - `POST /coder/api/v2/task/new` creates a chat and answers `{ success, request_id, data: { id } }`;
 * - `POST /coder/api/v2/task/completions?chat_id=…` answers `text/event-stream`;
 * - `GET  /coder/api/v2/task/list?page=1` is the authenticated-session probe;
 * - `GET  /api/v2/configs/git` is a second authenticated endpoint.
 *
 * The public route/catalogue identity is the provider id; the model id is provider-local. Nothing
 * here is reachable from `src/web-chat/core/**`: a path, a header name and a payload shape are
 * provider-private facts (AGENTS.md → *Provider conversation is opaque*).
 */

/**
 * The catalogue/driver/auth provider id.
 *
 * One id serves all three roles (catalogue route, driver, sign-in) — the same rule the ChatGPT
 * provider follows (`doc/provider-onboarding.md` §1.3), so the sign-in surface can never list a
 * provider the catalogue does not have.
 */
export const QWEN_CODE_PROVIDER_ID = "qwen-code";

/**
 * The catalogue route id.
 *
 * Equal to the provider id by definition (the public route is `<providerId>/<modelId>`), exported
 * under its route name so a registration or a test can assert the equality rather than assume it.
 */
export const QWEN_CODE_ROUTE_ID = QWEN_CODE_PROVIDER_ID;

/** The driver id; the same value, named for the contract it satisfies. */
export const QWEN_CODE_DRIVER_ID = QWEN_CODE_PROVIDER_ID;

/** The operator-facing label for this provider on the sign-in page. */
export const QWEN_CODE_AUTH_PROVIDER_LABEL = "Qwen Code";

/** The web product's origin. Every request the adapter makes is same-origin with it. */
export const QWEN_CODE_ORIGIN = "https://coder.qwen.ai";

/** Where the sign-in browser starts. The app shell is public; only its API is authenticated. */
export const QWEN_CODE_ROOT_URL = `${QWEN_CODE_ORIGIN}/`;

/** A chat is created before it can be continued; this path returns its id. */
export const QWEN_CODE_TASK_NEW_PATH = "/coder/api/v2/task/new";

/** The task list is the simplest endpoint that refuses an anonymous caller. */
export const QWEN_CODE_TASK_LIST_PATH = "/coder/api/v2/task/list";

/** The authenticated git-config endpoint, kept as a documented alternative probe. */
export const QWEN_CODE_CONFIGS_GIT_PATH = "/api/v2/configs/git";

/** The streaming completion endpoint. The chat id travels in the query string. */
export const QWEN_CODE_COMPLETIONS_PATH = "/coder/api/v2/task/completions";

/**
 * The localStorage entry the app's own token manager persists its session token under.
 *
 * **Evidence, not a guess.** The recorded HAR of the signed-in app shows an `authorization` header on
 * *every* authenticated API call — `GET /coder/api/v2/task/list` included — alongside the cookies
 * (`Bearer <token>`, 281 characters, JWT-shaped), with `source: web`, `version: 0.0.29` and `bx-v:
 * 2.5.37`. The same app's bundle (`.../qwen-coder-fe/0.0.29/js/main.js`, the exact version the client
 * header reports) builds that header as `` `Bearer ${token}` `` from `TokenManager.getAccessToken()`,
 * whose coordinator persists the token as JSON under this key (migrating the legacy `token` +
 * `at_expire_time` pair). A cookie-only request is therefore *not* how the page authenticates, which
 * is what the live import measured as `import_predicate_failed`.
 *
 * The key lives here, with the provider, and never in a provider-neutral module.
 */
export const QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY = "qwen_access_token_state";

/** The legacy key the same token manager migrates a session from when the state entry is absent. */
export const QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY = "token";

/**
 * The model the one-turn proof asks for.
 *
 * Provider-local and *not* a public route: the public route identity is `<providerId>/<modelId>`
 * and is minted by the host, never here (`doc/provider-onboarding.md` §4.2).
 */
export const QWEN_CODE_DEFAULT_MODEL = "qwen3-coder-plus";

/** The chat-mode/product axes the web app sends when it creates a coding chat. */
export const QWEN_CODE_CHAT_MODE = "normal";
export const QWEN_CODE_CHAT_TYPE = "code";
export const QWEN_CODE_SUB_CHAT_TYPE = "web_dev";

/** The client-version headers the web app sends; they are not credentials. */
export const QWEN_CODE_CLIENT_VERSION = "0.0.29";
export const QWEN_CODE_COMPLETION_VERSION = "2.1";
export const QWEN_CODE_BX_VERSION = "2.5.37";

/** The output schema the web app requests; `phase` is what makes `delta.phase` meaningful. */
export const QWEN_CODE_OUTPUT_SCHEMA = "phase";

/** The frame geometry the sign-in browser is launched with, reported truthfully by `view()`. */
export const QWEN_CODE_AUTH_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * How long the controller polls the authenticated API before reporting `failed`.
 *
 * Deliberately under the sign-in session manager's 10-minute default TTL, so a sign-in that never
 * authenticates reports the controller's own typed failure instead of being expired out from under
 * it by the manager's sweep. Signing in by verification code / password + a redirect takes minutes.
 */
export const QWEN_CODE_AUTH_POLL_TIMEOUT_MS = 8 * 60_000;

/** How often the authenticated endpoint is polled while the operator works. Never a busy loop. */
export const QWEN_CODE_AUTH_POLL_INTERVAL_MS = 1_500;

/** How long one navigation (the initial one and any operator `navigate`) may take. */
export const QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS = 60_000;

/** How long one authenticated-session probe may take before it counts as "not yet". */
export const QWEN_CODE_AUTH_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long the import probe waits for the app to restore its own session before it concludes that
 * the page really still considers itself signed out.
 *
 * The app's own bundle (0.0.29) makes this a two-step boot, not a static page: a persisted
 * `loggedOut` state is reset, then `GET https://auth.qwen.ai/api/v2/auths/refresh` — authenticated by
 * the captured cookies — returns an `access_token`, which the token manager persists under
 * {@link QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY}. On a cold container that is a handful of network round
 * trips, so the bound is generous; it is a deadline, never a sleep that makes the probe correct.
 */
export const QWEN_CODE_SESSION_HYDRATION_TIMEOUT_MS = 20_000;

/**
 * How often the hydration wait re-reads the page's own token state.
 *
 * A polling interval, not a correctness sleep: the probe is ready as soon as the app's own token
 * exists and is unexpired, and gives up at {@link QWEN_CODE_SESSION_HYDRATION_TIMEOUT_MS}.
 */
export const QWEN_CODE_SESSION_HYDRATION_POLL_INTERVAL_MS = 250;

/**
 * The non-secret headers every Qwen API request carries.
 *
 * They are exactly the client header set the recorded HAR shows on `GET /coder/api/v2/task/list`:
 * `accept`, `content-type`, `source: web`, `version` and `bx-v`. The *credential* header
 * (`authorization: Bearer <token>`) is not part of this set: it is read from the session at call time
 * and added by `session-probe.ts`, so it can never be baked into a constant here.
 */
export function qwenCodeApiHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    source: "web",
    version: QWEN_CODE_CLIENT_VERSION,
    "bx-v": QWEN_CODE_BX_VERSION,
    ...extra,
  };
}

/** Build an absolute Qwen URL from a path. Pure, so a probe URL is assertable without a browser. */
export function qwenCodeUrl(path: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(path, QWEN_CODE_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}
