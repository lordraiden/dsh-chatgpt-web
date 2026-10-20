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
 *   sent, and the refusal names why it was not. What *does* cross is the provider's answer: when the
 *   body is not a shape this adapter recognises, a redacted, bounded snippet of it (plus the status
 *   and content type) is reported, because a thrown-away body is a refusal nobody can act on.
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
  /**
   * The answer's `content-type`, when the issuing seam could observe it.
   *
   * Diagnostics only: it is reported when the body does not match a shape this module understands.
   * An injected probe that cannot observe headers may omit it; the refusal then says so instead of
   * inventing one.
   */
  readonly contentType?: string;
  /**
   * The answer's (already bounded) raw body text, when the issuing seam could observe it.
   *
   * This is the field that used to be thrown away: a body that is not the expected JSON object was
   * reduced to "an unrecognised body" with no evidence. It is reduced to a redacted snippet before it
   * can reach a refusal, and it is never a credential.
   */
  readonly bodyText?: string;
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

/**
 * The pipeline's inner diagnostic bound: `nonSecretDiagnosticText` keeps only the first 300 characters
 * of a provider failure, so the probe refusal is composed to fit that budget exactly.
 */
const PROBE_REFUSAL_MAX_CHARS = 300;

/** How much of the body a snippet may consider before the message budget cuts it. */
const REFUSAL_BODY_CHARS = 200;

/** The longest `content-type` value the refusal will spend characters on; the rest is dropped. */
const REFUSAL_CONTENT_TYPE_CHARS = 32;

/** A body fragment shorter than this is not worth spending the budget on. */
const REFUSAL_MIN_FRAGMENT_CHARS = 8;

/** The provider's own free-text explanation, when the body carries one. */
const REFUSAL_MESSAGE_KEYS = ["message", "detail", "error", "msg"] as const;

/** Bounds a provider's own free-text message so it stays one readable fragment. */
const REFUSAL_MESSAGE_CHARS = 60;

/**
 * Shapes that are secrets wherever they appear in a provider's answer.
 *
 * Long alphanumeric runs are redacted on purpose even when they are not a known token format: a
 * session token does not advertise itself, and a snippet is exactly where one would otherwise surface.
 */
const TOKEN_LIKE_REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // A value assigned to a credential-named field is a secret whatever its length (JSON or HTML), so
  // it is redacted by name before the length-based rules ever see it.
  [
    /(["'])([A-Za-z0-9_-]*(?:token|secret|password|authorization|cookie|api[-_]?key))\1(\s*[:=]\s*)(["'])([^"']*)\4/gi,
    "$1$2$1$3$4[redacted]$4",
  ],
  [
    /\b([A-Za-z0-9_-]*(?:token|secret|password|authorization|cookie|api[-_]?key))\s*=\s*(["'])([^"']*)\2/gi,
    "$1=$2[redacted]$2",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g, "[redacted]"],
  [/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[redacted]"],
];

/** Redact bearer/JWT/long-token shapes before a value is allowed into a diagnostic. */
function redactTokenLike(value: string): string {
  let text = value;
  for (const [pattern, replacement] of TOKEN_LIKE_REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

/**
 * One bounded, credential-free fragment of the provider's answer.
 *
 * The body is first stripped of control characters, then token-shaped runs are redacted, and only then
 * is it bounded. Truncation always happens last so a token can never be cut into a shorter run that
 * the redaction patterns no longer recognise. URLs and repeated whitespace are left to the one
 * sanitizer (`nonSecretDiagnosticText`) that already owns that policy.
 */
function sanitizedBodyFragment(value: string): string {
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (stripped.length === 0) return "";
  return nonSecretDiagnosticText(redactTokenLike(stripped)).slice(0, REFUSAL_BODY_CHARS);
}

/** Whether a body is a document rather than the JSON the API is expected to answer. */
function looksLikeHtmlDocument(text: string): boolean {
  const head = text.slice(0, 512);
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<\?xml)/i.test(head)
    || /<html[\s>]/i.test(head)
    || /<title[\s>]/i.test(text);
}

/** The `title` or first line of a non-JSON document, sanitized and bounded. */
function htmlDocumentFragment(text: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text);
  if (title) {
    const name = sanitizedBodyFragment(title[1].replace(/<[^>]*>/g, " ").trim()).replace(/"/g, "'");
    if (name.length > 0) return `title "${name}"`;
  }
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? text;
  return sanitizedBodyFragment(firstLine);
}

/** One distinguishable rendering of the body, ordered from most to least useful. */
interface QwenAnswerBodyShape {
  /** What the body is, in the operator's words. */
  readonly tag: string;
  /** The same fact without the explanatory words, when the budget is tight. */
  readonly shortTag: string;
  /** The shortest possible label, when even {@link shortTag} does not fit. */
  readonly minimalTag: string;
  /** Distinguishing fragments, best first; each is already sanitized. */
  readonly details: readonly string[];
}

/** The raw text of an answer, whether the sender observed it or only the parsed payload survives. */
function qwenAnswerBodyText(payload: unknown, bodyText: string | undefined): string {
  if (typeof bodyText === "string") return bodyText;
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload) ?? String(payload);
  } catch {
    return String(payload);
  }
}

/** Whether the body was the JSON the API is expected to answer (even if its envelope is unfamiliar). */
function qwenAnswerIsJson(payload: unknown, bodyText: string | undefined): boolean {
  if (typeof bodyText === "string") {
    if (bodyText.trim().length === 0) return false;
    try {
      JSON.parse(bodyText);
      return true;
    } catch {
      return false;
    }
  }
  // A seam that only handed over a payload: an object/array/primitive is parsed JSON, a string is the
  // legacy "non-JSON body" representation and must not be re-labelled as JSON.
  return payload !== undefined && typeof payload !== "string";
}

/**
 * Classify a body this module does not recognise, keeping the evidence that identifies it.
 *
 * Every branch names what actually arrived instead of pretending it was JSON: an empty body, a
 * non-JSON document (an HTML block/challenge page is a real possibility), an unfamiliar JSON envelope,
 * or some other non-JSON text.
 */
function qwenAnswerBodyShape(
  payload: unknown,
  bodyText: string | undefined,
): QwenAnswerBodyShape {
  const text = qwenAnswerBodyText(payload, bodyText).trim();
  if (text.length === 0) {
    return {
      tag: "the provider answered with an empty body",
      shortTag: "empty body",
      minimalTag: "empty",
      details: [],
    };
  }

  if (qwenAnswerIsJson(payload, bodyText)) {
    const snippet = sanitizedBodyFragment(text);
    return {
      tag: "body snippet",
      shortTag: "unknown JSON",
      minimalTag: "JSON",
      details: snippet.length === 0 ? [] : [snippet],
    };
  }

  if (looksLikeHtmlDocument(text)) {
    const fragment = htmlDocumentFragment(text);
    return {
      tag: "the provider answered with a non-JSON document",
      shortTag: "non-JSON document",
      minimalTag: "HTML",
      details: fragment.length === 0 ? [] : [fragment],
    };
  }

  const snippet = sanitizedBodyFragment(text);
  return {
    tag: "the provider answered with a non-JSON body",
    shortTag: "non-JSON body",
    minimalTag: "text",
    details: snippet.length === 0 ? [] : [snippet],
  };
}

/** Cut `text` to `max` characters with an ellipsis, so a truncation is visibly a truncation. */
function truncateWithEllipsis(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Render the body shape into whatever the message budget allows.
 *
 * Order of preference: the full explanation plus the complete distinguishing fragment; then a shorter
 * label plus the complete fragment; then the leading fragment (visibly cut) under the descriptive
 * label; then a label alone. Nothing is invented when the budget runs out: an empty string simply
 * leaves the status and content-type to identify the answer, which is the documented priority.
 */
function qwenShapeFragment(shape: QwenAnswerBodyShape, budget: number): string {
  if (budget <= 0) return "";
  for (const detail of shape.details) {
    for (const label of [shape.tag, shape.shortTag]) {
      const candidate = `; ${label}: ${detail}`;
      if (candidate.length <= budget) return candidate;
    }
  }
  const preferred = shape.details[0];
  if (preferred !== undefined) {
    const prefix = `; ${shape.tag}: `;
    const room = budget - prefix.length;
    if (room >= REFUSAL_MIN_FRAGMENT_CHARS) return `${prefix}${truncateWithEllipsis(preferred, room)}`;
  }
  for (const label of [shape.tag, shape.shortTag, shape.minimalTag]) {
    const candidate = `; ${label}`;
    if (candidate.length <= budget) return candidate;
  }
  return "";
}

/** The provider code/details, reduced to non-secret bounded text. */
function qwenProviderCode(value: string): string {
  return nonSecretDiagnosticText(redactTokenLike(value.trim()));
}

/** What one body said, as the diagnostic vocabulary reads it. */
interface QwenTaskListRefusalRead {
  /** The non-secret rendering of the answer, without the HTTP status. */
  readonly text: string;
  /**
   * Whether the body matched a shape this module already understands (the provider's `data.code`, or a
   * free-text `message`/`detail`/`error`). An unrecognised body is what triggers the content-type and
   * body-shape reporting.
   */
  readonly recognised: boolean;
  /** The classified body shape, present only when {@link recognised} is `false`. */
  readonly shape?: QwenAnswerBodyShape;
}

/**
 * Read one `task/list` body for diagnostics.
 *
 * The provider's own vocabulary is preferred when present (`data.code` + `data.details`, then a
 * free-text `message`/`detail`/`error`). Those are the shapes the capture and the sign-in path already
 * understand, so their text is unchanged. Everything else is classified into an
 * {@link QwenAnswerBodyShape}: the refusal then reports what actually arrived instead of guessing.
 */
function readQwenTaskListRefusal(
  payload: unknown,
  answer: Pick<QwenTaskListAnswer, "bodyText"> = {},
): QwenTaskListRefusalRead {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
    const code = data["code"];
    const details = data["details"];
    if (typeof code === "string") {
      const safeCode = qwenProviderCode(code);
      const safeDetails = typeof details === "string" ? qwenProviderCode(details) : undefined;
      return { recognised: true, text: safeDetails === undefined ? safeCode : `${safeCode} ${safeDetails}` };
    }
    for (const key of REFUSAL_MESSAGE_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        const text = nonSecretDiagnosticText(redactTokenLike(value.trim()));
        return {
          recognised: true,
          text: `${key}: ${truncateWithEllipsis(text, REFUSAL_MESSAGE_CHARS)}`,
        };
      }
    }
  }

  const shape = qwenAnswerBodyShape(payload, answer.bodyText);
  const rendering = qwenShapeFragment(shape, Number.POSITIVE_INFINITY).replace(/^; /, "");
  return {
    recognised: false,
    text: rendering.length === 0 ? "an unrecognised body" : `an unrecognised body (${rendering})`,
    shape,
  };
}

/**
 * The non-secret reason a probe payload means "not authenticated" (diagnostics only).
 *
 * The provider's own words are preferred (`code` + `details`, the shape the captured service uses).
 * Anything else still reports what arrived — bounded to a snippet — because "an unrecognised body"
 * alone is exactly the guessing this task set out to remove. Pass the observed answer when it is
 * available: its `contentType`/`bodyText` are what identify a body that is not the expected JSON.
 */
export function qwenTaskListRefusal(
  payload: unknown,
  answer: Pick<QwenTaskListAnswer, "contentType" | "bodyText"> = {},
): string {
  return readQwenTaskListRefusal(payload, answer).text;
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
    // The page's answer is kept whole: the parsed payload for the predicate, and the content type
    // plus raw text so an unrecognised body can be reported instead of thrown away.
    return {
      status: answer.status,
      payload: answer.payload ?? answer.text,
      contentType: answer.contentType,
      bodyText: answer.text,
    };
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
    ...(answer.contentType === undefined ? {} : { contentType: answer.contentType }),
    ...(answer.bodyText === undefined ? {} : { bodyText: answer.bodyText }),
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
 * The answer's content type, reduced to what the refusal can afford to show.
 *
 * The media type is preferred over its parameters when the full header does not fit, and the value is
 * bounded and control-character-free. An injected probe that could not observe headers says so
 * (`(none)`) instead of implying the provider sent none.
 */
function qwenContentTypePart(contentType: string | undefined): string {
  const raw = typeof contentType === "string"
    ? contentType.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (raw.length === 0) return ", content-type: (none)";
  if (raw.length <= REFUSAL_CONTENT_TYPE_CHARS) return `, content-type: ${raw}`;
  const mediaType = raw.split(";")[0]!.trim();
  const fitted = mediaType.length > 0 && mediaType.length <= REFUSAL_CONTENT_TYPE_CHARS
    ? mediaType
    : truncateWithEllipsis(raw, REFUSAL_CONTENT_TYPE_CHARS);
  return `, content-type: ${fitted}`;
}

/**
 * The shortest honest "what to do" clause for an answer this module cannot interpret.
 *
 * An unrecognised body is not proof that the session was revoked, so the old interpretation ("the
 * session itself is no longer accepted") is deliberately not asserted here: the body evidence is the
 * diagnosis. Only the page verdict — when there was no token at all — is a fact this refusal owns.
 */
function qwenUnrecognisedAction(
  observation: Pick<QwenTaskListObservation, "sentAuthorization" | "pageSession">,
): string {
  if (observation.sentAuthorization === false) {
    if (observation.pageSession !== undefined && !observation.pageSession.hydrated) {
      return `; after ${observation.pageSession.waitedMs}ms the page is still signed out, so no page `
        + "token was sent — sign in again, then re-export and re-import";
    }
    return "; no page token was sent — sign in again, then re-export and re-import";
  }
  return "; sign in again, then re-export and re-import";
}

/**
 * The honest, specific refusal for a probe that did not authenticate.
 *
 * It always reports what the provider answered. When the body is one of the shapes this adapter
 * already understands (the provider's `data.code`, or a free-text message), the text is unchanged.
 * When it is **not**, the refusal reports the HTTP status, the `content-type` and a redacted snippet
 * of the actual body — an HTML block page is named as a non-JSON document with its title/first line —
 * because discarding that body is exactly the blindness this refusal exists to remove.
 *
 * When the request went out without a token it says which fact decided that: the live page was still
 * signed out at the deadline of the bounded wait, or (for a caller that reads the page once) the page
 * simply had no token at that instant. It never claims a captured token was the authority. The whole
 * message is composed to the pipeline's 300-character inner diagnostic bound, so the sanitizer never
 * has to cut it and no identifying field is lost. No URL is embedded: the sanitizer would rewrite it,
 * and the operator knows where they signed in.
 */
export function qwenTaskListProbeRefusal(
  observation: Pick<
    QwenTaskListObservation,
    "status" | "payload" | "contentType" | "bodyText" | "sentAuthorization" | "tokenProblem" | "pageSession"
  >,
): string {
  const read = readQwenTaskListRefusal(observation.payload, {
    ...(observation.bodyText === undefined ? {} : { bodyText: observation.bodyText }),
  });

  if (read.recognised) {
    const answered = `the task list answered HTTP ${observation.status} with ${read.text}`;
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

  // The answer did not match a known shape. Report the identifying fields in priority order: HTTP
  // status, content-type, then as much of the actual body as the remaining budget allows.
  const head = `the task list answered HTTP ${observation.status}`;
  const contentType = qwenContentTypePart(observation.contentType);
  const action = qwenUnrecognisedAction(observation);
  const shapeBudget = PROBE_REFUSAL_MAX_CHARS - head.length - contentType.length - action.length;
  const shape = qwenShapeFragment(
    read.shape ?? qwenAnswerBodyShape(observation.payload, observation.bodyText),
    shapeBudget,
  );
  return `${head}${contentType}${shape}${action}`;
}
