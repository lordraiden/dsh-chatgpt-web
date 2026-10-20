/**
 * The authenticated-session probe for Qwen Code (issue #299), and the provider's own token.
 *
 * ## What the page actually sends (measured, not guessed)
 *
 * The recorded HAR of the signed-in app shows that **cookies are not how this provider
 * authenticates**. Every authenticated API call — `GET /coder/api/v2/task/list` included — carries,
 * next to the cookies:
 *
 * ```text
 * authorization: Bearer <281-character token>
 * accept: application/json
 * content-type: application/json
 * source: web
 * version: 0.0.29
 * bx-v: 2.5.37
 * x-request-id: <uuid>
 * ```
 *
 * and the request is same-origin (`sec-fetch-site: same-origin`, `referer` the app page). The same
 * app's bundle builds that header from `TokenManager.getAccessToken()` and persists the token in
 * `localStorage["qwen_access_token_state"]` (JSON: `{ token, expiresAt, sessionId, loggedOut, … }`),
 * migrating a legacy `token` + `at_expire_time` pair. That is why a cookie-only probe answers
 * `{"success":false,"data":{"code":"Unauthorized"}}`: the request is missing what the app attaches.
 *
 * ## What this module does about it
 *
 * - **The live page is the authority for its own session, never the imported capture.** A capture may
 *   carry a `qwen_access_token_state` that is a leftover: the operator's fresh browser profile wrote
 *   `loggedOut: true` when it first loaded the app, while the real authenticated session lives in the
 *   captured cookies. The app's own bundle repairs exactly that on boot: `prepareSessionRestore()`
 *   resets a stale `loggedOut` state, `GET https://auth.qwen.ai/api/v2/auths/refresh` (cookie-
 *   authenticated) answers an `access_token`, and `setAccessToken()` persists it back under
 *   `qwen_access_token_state`. So the probe opens the page in the captured context, **waits — bounded,
 *   on that observable — for the app to authenticate itself**, then reads the token from the live page
 *   and issues the probe from inside it. A captured token entry is never sent on its own authority.
 * - **The header shape is the app's**, assembled by {@link qwenTaskListRequest} and asserted against
 *   the recorded shape in the suite.
 * - **The request is issued from inside the provider's page** through the provider-neutral
 *   `requestInPageContext`, so origin, referer, cookies and `Sec-Fetch-*` are the page's.
 * - **The token never crosses into a log or a refusal**: the observation carries only whether one was
 *   sent, and the refusal names why it was not.
 *
 * The sign-in controller and the turn facility read the same live page through the same helper
 * ({@link readQwenAccessTokenFromPage}); the controller's own polling loop is its bounded wait. The
 * import path is a single shot, so it uses {@link awaitQwenPageSession} before probing.
 *
 * The two payload predicates ({@link qwenTaskListAuthenticated} / {@link qwenTaskListRefusal}) live
 * here because this is the module that reads the answer; `auth-controller.ts` re-exports them so no
 * caller has to move.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { requestInPageContext } from "../page-context-request";
import { waitForPageHydration } from "../page-hydration";
import {
  QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CODE_AUTH_PROBE_TIMEOUT_MS,
  QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CODE_SESSION_HYDRATION_POLL_INTERVAL_MS,
  QWEN_CODE_SESSION_HYDRATION_TIMEOUT_MS,
  QWEN_CODE_TASK_LIST_PATH,
  qwenCodeApiHeaders,
  qwenCodeUrl,
} from "./provider";

/** How a token was (or was not) found; diagnostics only, never the token itself. */
export type QwenAccessTokenProblem = "absent" | "logged-out" | "expired" | "unreadable";

/** What reading the session's own token produced. `accessToken` is never logged. */
export interface QwenAccessTokenRead {
  /** The token to send, when there is one. */
  readonly accessToken?: string;
  /** Why there is not one; absent when {@link accessToken} is set. */
  readonly problem?: QwenAccessTokenProblem;
}

/** Where a token came from: the live page, or nowhere. A capture is never a source. */
export type QwenAccessTokenSource = "page" | "none";

/** One task-list request, exactly as the page's own client sends it. */
export interface QwenTaskListRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** What one task-list call answered. */
export interface QwenTaskListAnswer {
  readonly status: number;
  readonly payload: unknown;
}

/** Sends one assembled request. Production binds this to the provider's page. */
export type QwenTaskListSender = (request: QwenTaskListRequest) => Promise<QwenTaskListAnswer>;

/** One probe's full observation. Credential-free by construction. */
export interface QwenTaskListObservation extends QwenTaskListAnswer {
  /**
   * Whether the provider's own `authorization` header accompanied the request.
   *
   * `undefined` means the caller could not observe it (an injected probe seam); the refusal then
   * stays generic instead of claiming something about the token it cannot prove.
   */
  readonly sentAuthorization?: boolean;
  /** Where the token came from (`none` when {@link sentAuthorization} is `false`). */
  readonly tokenSource?: QwenAccessTokenSource;
  /** Why no token was available; present when {@link sentAuthorization} is `false`. */
  readonly tokenProblem?: QwenAccessTokenProblem;
  /**
   * The bounded wait that preceded the read, when the probe waited on the live page (the import path).
   *
   * Absent for the sign-in controller's poll step, whose own polling loop is the wait. When present
   * and `hydrated` is `false`, the page itself was still signed out at the deadline — which is a
   * different fact from "no token was ever fetched" and the refusal says so.
   */
  readonly pageSession?: QwenPageSessionProgress;
}

/** What a bounded hydration wait saw, without any credential. */
export interface QwenPageSessionProgress {
  /** Whether the page's own token existed, unexpired, before the deadline. */
  readonly hydrated: boolean;
  /** The deadline that was actually enforced, in milliseconds. Diagnostics only. */
  readonly waitedMs: number;
}

/**
 * Whether a `task/list` payload means "authenticated".
 *
 * The captured service answers an anonymous caller HTTP **200** with `success:false` and
 * `data.code: "Unauthorized"`, so the HTTP status alone cannot decide this. A signed-in caller gets
 * `success:true` and a `data` array.
 */
export function qwenTaskListAuthenticated(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return record["success"] === true && Array.isArray(record["data"]);
}

/** Bounds a body snippet so a refusal stays one readable line. */
const REFUSAL_SNIPPET_CHARS = 60;

/** The provider's own free-text explanation, when the body carries one. */
const REFUSAL_MESSAGE_KEYS = ["message", "detail", "error", "msg"] as const;

/**
 * A bounded, URL-scrubbed rendering of a body that carried no recognisable provider code.
 *
 * The provider's own `message`/`detail`/`error` text is preferred when it exists: it is the part a
 * human can act on. Only when there is none does the raw JSON get truncated into a snippet. Either
 * way the value is passed through the one sanitizer (no URL, no unbounded text) and is never a
 * credential.
 */
function qwenTaskListBodySnippet(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of REFUSAL_MESSAGE_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        const text = nonSecretDiagnosticText(value.trim());
        return `${key}: ${text.length > REFUSAL_SNIPPET_CHARS ? `${text.slice(0, REFUSAL_SNIPPET_CHARS)}…` : text}`;
      }
    }
  }

  let text: string;
  try {
    text = JSON.stringify(payload) ?? String(payload);
  } catch {
    text = String(payload);
  }
  const sanitized = nonSecretDiagnosticText(text);
  return sanitized.length > REFUSAL_SNIPPET_CHARS
    ? `${sanitized.slice(0, REFUSAL_SNIPPET_CHARS)}…`
    : sanitized;
}

/**
 * The non-secret reason a probe payload means "not authenticated" (diagnostics only).
 *
 * The provider's own words are preferred (`code` + `details`, the shape the captured service uses).
 * Anything else still reports what arrived — bounded to a snippet — because "an unrecognised body"
 * alone is exactly the guessing this task set out to remove.
 */
export function qwenTaskListRefusal(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "an unrecognised body";
  const record = payload as Record<string, unknown>;
  const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
  const code = data["code"];
  const details = data["details"];
  if (typeof code === "string" && typeof details === "string") return `${code} ${details}`;
  if (typeof code === "string") return code;
  const snippet = qwenTaskListBodySnippet(payload);
  return snippet.length === 0 ? "an unrecognised body" : `an unrecognised body (${snippet})`;
}

/**
 * Read the token out of one persisted value.
 *
 * The app stores JSON under {@link QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY}; the legacy
 * {@link QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY} held the bare token. A value that is neither is
 * `unreadable` rather than silently treated as a token: sending a guessed credential to the provider
 * is exactly the invention this module must not do.
 *
 * An expired state is `expired`, not a token: the app's token manager writes `expiresAt` as epoch
 * **milliseconds** (its bundle converts a seconds-scale `expires_at`/JWT `exp` with `*1000`), and its
 * own interceptor would refresh rather than send a token past that instant. A `0`/absent `expiresAt`
 * is "unknown", not "expired": the provider, not a guess, decides whether such a token still works.
 */
export function qwenAccessTokenFromPersistedValue(
  value: unknown,
  now: number = Date.now(),
): QwenAccessTokenRead {
  if (typeof value !== "string") return { problem: "absent" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { problem: "absent" };
  if (!trimmed.startsWith("{")) return { accessToken: trimmed };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { problem: "unreadable" };
  }
  if (!parsed || typeof parsed !== "object") return { problem: "unreadable" };
  const state = parsed as Record<string, unknown>;
  if (state["loggedOut"] === true) return { problem: "logged-out" };
  const token = state["token"];
  if (typeof token !== "string" || token.trim().length === 0) return { problem: "absent" };
  const expiresAt = state["expiresAt"];
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
    return { problem: "expired" };
  }
  return { accessToken: token.trim() };
}

/**
 * Read the provider's token from the **live page's own `localStorage`**, at call time.
 *
 * The sign-in controller and the turn facility have a page, not a capture; this is the same
 * localStorage the app itself reads. Only string values leave the page — never a header, never a
 * cookie — and the caller decides whether the value is a usable token.
 */
export async function readQwenAccessTokenFromPage(page: Page): Promise<QwenAccessTokenRead> {
  const stored = await page.evaluate(({ accessKey, legacyKey }) => {
    try {
      return {
        state: localStorage.getItem(accessKey) ?? undefined,
        legacy: localStorage.getItem(legacyKey) ?? undefined,
      };
    } catch {
      return {};
    }
  }, {
    accessKey: QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY,
    legacyKey: QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY,
  });

  if (typeof stored?.state === "string") return qwenAccessTokenFromPersistedValue(stored.state);
  if (typeof stored?.legacy === "string") return qwenAccessTokenFromPersistedValue(stored.legacy);
  return { problem: "absent" };
}

/**
 * The `authorization` header the page's own client would attach, read from the live page.
 *
 * The turn facility and the sign-in controller have a page rather than a capture, so this is the
 * same value the app would use, read at call time. An empty object means "no usable token": the
 * caller then proceeds exactly as before and the provider's refusal is reported honestly.
 */
export async function qwenAuthorizationHeaderFromPage(page: Page): Promise<Record<string, string>> {
  const read = await readQwenAccessTokenFromPage(page);
  return read.accessToken === undefined ? {} : { authorization: `Bearer ${read.accessToken}` };
}

/**
 * Build the task-list request in the captured app's own shape.
 *
 * Everything except `authorization` and the per-call `x-request-id` is the shared client header set
 * (`qwenCodeApiHeaders`), which the recorded HAR matches exactly for `GET /coder/api/v2/task/list`.
 */
export function qwenTaskListRequest(accessToken?: string): QwenTaskListRequest {
  return {
    url: qwenCodeUrl(QWEN_CODE_TASK_LIST_PATH, { page: "1" }),
    headers: qwenCodeApiHeaders({
      ...(accessToken === undefined || accessToken.length === 0 ? {} : { authorization: `Bearer ${accessToken}` }),
      "x-request-id": randomUUID(),
    }),
  };
}

/** The page-bound sender: the request is issued from the page's own browsing context. */
export function createQwenPageTaskListSender(page: Page): QwenTaskListSender {
  return async request => {
    const answer = await requestInPageContext(page, {
      url: request.url,
      headers: request.headers,
      timeoutMs: QWEN_CODE_AUTH_PROBE_TIMEOUT_MS,
    });
    return { status: answer.status, payload: answer.payload ?? answer.text };
  };
}

/**
 * Probe `task/list` with an explicit token read and a sender.
 *
 * Split from the page helpers below so a test can drive the *production* assembly — the same
 * {@link qwenTaskListRequest} and the same observation — with a recording sender and assert the exact
 * header that was sent, without a browser.
 */
export async function probeQwenTaskList(
  read: QwenAccessTokenRead,
  source: QwenAccessTokenSource,
  send: QwenTaskListSender,
): Promise<QwenTaskListObservation> {
  const request = qwenTaskListRequest(read.accessToken);
  const answer = await send(request);
  return {
    status: answer.status,
    payload: answer.payload,
    sentAuthorization: read.accessToken !== undefined,
    tokenSource: read.accessToken === undefined ? "none" : source,
    ...(read.accessToken === undefined && read.problem !== undefined ? { tokenProblem: read.problem } : {}),
  };
}

/** How long the import probe waits for the app's own session restore, and how often it re-reads. */
export interface QwenPageHydrationOptions {
  /** Defaults to {@link QWEN_CODE_SESSION_HYDRATION_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Defaults to {@link QWEN_CODE_SESSION_HYDRATION_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

/** What the bounded wait plus its final read produced. */
export interface QwenPageSessionWait {
  /** The page's token read after the wait; `accessToken` absent when there was none. */
  readonly read: QwenAccessTokenRead;
  /** Whether the page's own token existed, unexpired, before the deadline. */
  readonly hydrated: boolean;
  /** The deadline actually enforced, in milliseconds. Diagnostics only. */
  readonly waitedMs: number;
}

/**
 * Wait, bounded, for the **live page** to restore its own session; then keep the last read.
 *
 * The observable is the app's own token state in `localStorage`: the app's token manager reads and
 * writes it (its request interceptor builds `Authorization: Bearer <token>` from
 * `getAccessToken()`, which syncs that key), and on boot it replaces a stale `loggedOut` state with a
 * token obtained from its own cookie-authenticated `/auths/refresh` call. So "a non-empty token that
 * is not expired" is the app's own signed-in state, not a proxy for it.
 *
 * The wait itself is the provider-neutral {@link waitForPageHydration}; this function only decides
 * what to observe and when it counts as hydrated. It never invents a token and never falls back to
 * the imported capture.
 */
export async function awaitQwenPageSession(
  page: Page,
  options: QwenPageHydrationOptions = {},
): Promise<QwenPageSessionWait> {
  const wait = await waitForPageHydration(
    () => readQwenAccessTokenFromPage(page),
    read => read.accessToken !== undefined,
    {
      timeoutMs: options.timeoutMs ?? QWEN_CODE_SESSION_HYDRATION_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? QWEN_CODE_SESSION_HYDRATION_POLL_INTERVAL_MS,
    },
  );
  return {
    read: wait.state ?? { problem: "absent" },
    hydrated: wait.hydrated,
    waitedMs: wait.waitedMs,
  };
}

/**
 * Probe with the token the live page keeps in its own `localStorage`, read now.
 *
 * This is the sign-in controller's poll step: its polling loop already waits on the app's own
 * authenticated answer, so it calls this repeatedly instead of sleeping inside one probe.
 */
export async function probeQwenTaskListFromPage(page: Page): Promise<QwenTaskListObservation> {
  const read = await readQwenAccessTokenFromPage(page);
  return await probeQwenTaskList(read, "page", createQwenPageTaskListSender(page));
}

/**
 * Probe from the live page after a bounded wait for the app to authenticate itself.
 *
 * The import path is a single shot, so it waits (observably, not on a sleep) before reading. The
 * request itself is assembled and sent by exactly the same primitives the controller uses, so the
 * two paths cannot disagree about which token is sent.
 */
export async function probeQwenTaskListFromPageAfterHydration(
  page: Page,
  options: QwenPageHydrationOptions = {},
): Promise<QwenTaskListObservation> {
  const session = await awaitQwenPageSession(page, options);
  const observation = await probeQwenTaskList(
    session.read,
    "page",
    createQwenPageTaskListSender(page),
  );
  return {
    ...observation,
    pageSession: { hydrated: session.hydrated, waitedMs: session.waitedMs },
  };
}

/** How the absence of a token is described to a human, without ever showing one. */
function qwenTokenProblemText(problem: QwenAccessTokenProblem): string {
  switch (problem) {
    case "logged-out":
      return "the page's token state says it is signed out";
    case "expired":
      return "the live page's token has expired";
    case "unreadable":
      return "the page's token state is not the JSON the app writes";
    default:
      return "the live page has no token yet";
  }
}

/**
 * The honest, specific refusal for a probe that did not authenticate.
 *
 * It always reports what the provider answered (status + its own code, or a bounded body snippet).
 * When the request went out without a token it says which fact decided that: the live page was still
 * signed out at the deadline of the bounded wait, or (for a caller that reads the page once) the page
 * simply had no token at that instant. It never claims a captured token was the authority. The whole
 * message is kept under the pipeline's 300-character diagnostic bound, so no part of the cause or its
 * fix is truncated away. No URL is embedded: the sanitizer would rewrite it, and the operator knows
 * where they signed in.
 */
export function qwenTaskListProbeRefusal(
  observation: Pick<
    QwenTaskListObservation,
    "status" | "payload" | "sentAuthorization" | "tokenProblem" | "pageSession"
  >,
): string {
  const answered = `the task list answered HTTP ${observation.status} with `
    + `${qwenTaskListRefusal(observation.payload)}`;
  if (observation.sentAuthorization === false) {
    const problem = qwenTokenProblemText(observation.tokenProblem ?? "absent");
    if (observation.pageSession !== undefined && !observation.pageSession.hydrated) {
      return `${answered}; the captured session opened the page, but after `
        + `${observation.pageSession.waitedMs}ms it still does not consider itself signed in `
        + `(${problem}), so no page token was sent — sign in again, then re-export and re-import`;
    }
    return `${answered}; the provider's API rejected the cookie-only request: it needs the token the `
      + `page uses (${problem}) — sign in again so the page itself has one, then re-export and re-import`;
  }
  if (observation.sentAuthorization === true) {
    return `${answered}; the request carried the page's own token and was still refused, so the session `
      + "itself is no longer accepted — sign in again, then re-export and re-import";
  }
  return `${answered}; sign in to Qwen Code again, export the session again, and re-run the import`;
}
