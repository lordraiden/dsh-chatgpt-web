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
 * - **The token is read at call time from the session that was captured** (or, for the sign-in
 *   controller and the turn facility, from the live page's own `localStorage`) — never from a
 *   constant, a config value or a fixture.
 * - **The header shape is the app's**, assembled by {@link qwenTaskListRequest} and asserted against
 *   the recorded shape in the suite.
 * - **The request is issued from inside the provider's page** through the provider-neutral
 *   `requestInPageContext`, so origin, referer, cookies and `Sec-Fetch-*` are the page's.
 * - **The token never crosses into a log or a refusal**: the observation carries only whether one was
 *   sent, and the refusal names why it was not.
 *
 * The two payload predicates ({@link qwenTaskListAuthenticated} / {@link qwenTaskListRefusal}) live
 * here because this is the module that reads the answer; `auth-controller.ts` re-exports them so no
 * caller has to move.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { requestInPageContext } from "../page-context-request";
import {
  QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CODE_AUTH_PROBE_TIMEOUT_MS,
  QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CODE_TASK_LIST_PATH,
  qwenCodeApiHeaders,
  qwenCodeUrl,
} from "./provider";
import { QWEN_CODE_STORAGE_ORIGINS } from "./session-store";

/** How a token was (or was not) found; diagnostics only, never the token itself. */
export type QwenAccessTokenProblem = "absent" | "logged-out" | "unreadable";

/** What reading the session's own token produced. `accessToken` is never logged. */
export interface QwenAccessTokenRead {
  /** The token to send, when there is one. */
  readonly accessToken?: string;
  /** Why there is not one; absent when {@link accessToken} is set. */
  readonly problem?: QwenAccessTokenProblem;
}

/** Where a token came from: the imported capture, the live page, or nowhere. */
export type QwenAccessTokenSource = "capture" | "page" | "none";

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
 */
export function qwenAccessTokenFromPersistedValue(value: unknown): QwenAccessTokenRead {
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
  return typeof token === "string" && token.trim().length > 0
    ? { accessToken: token.trim() }
    : { problem: "absent" };
}

/** The `localStorage` entries of a captured storage state, flattened, for this provider's origins. */
function qwenStorageEntries(storageState: unknown): { name: string; value: string }[] {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as {
    origins?: readonly { origin?: unknown; localStorage?: readonly unknown[] }[];
  };
  const entries: { name: string; value: string }[] = [];
  for (const origin of state.origins ?? []) {
    if (typeof origin?.origin !== "string"
      || !(QWEN_CODE_STORAGE_ORIGINS as readonly string[]).includes(origin.origin)) continue;
    for (const entry of origin.localStorage ?? []) {
      const record = entry as { name?: unknown; value?: unknown } | null;
      if (typeof record?.name === "string" && typeof record.value === "string") {
        entries.push({ name: record.name, value: record.value });
      }
    }
  }
  return entries;
}

/**
 * Read the provider's token from an **imported capture**, at call time.
 *
 * This is the whole point of the fix: the token comes from the session the operator captured, not
 * from anything this repository holds.
 */
export function qwenAccessTokenFromStorageState(storageState: unknown): QwenAccessTokenRead {
  const entries = qwenStorageEntries(storageState);
  const persisted = entries.find(entry => entry.name === QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY);
  if (persisted !== undefined) return qwenAccessTokenFromPersistedValue(persisted.value);
  const legacy = entries.find(entry => entry.name === QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY);
  if (legacy !== undefined) return qwenAccessTokenFromPersistedValue(legacy.value);
  return { problem: "absent" };
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
 * Split from the two sources below so a test can drive the *production* assembly — the same
 * {@link qwenTaskListRequest} and the same observation — with a recording sender and a fixture
 * capture, and assert the exact header that was sent.
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

/** Probe with the token carried by an imported capture. */
export function probeQwenTaskListFromCapture(
  storageState: unknown,
  send: QwenTaskListSender,
): Promise<QwenTaskListObservation> {
  return probeQwenTaskList(qwenAccessTokenFromStorageState(storageState), "capture", send);
}

/** Probe with the token the live page keeps in its own localStorage. */
export async function probeQwenTaskListFromPage(page: Page): Promise<QwenTaskListObservation> {
  const read = await readQwenAccessTokenFromPage(page);
  return await probeQwenTaskList(read, "page", createQwenPageTaskListSender(page));
}

/** How the absence of a token is described to a human, without ever showing one. */
function qwenTokenProblemText(problem: QwenAccessTokenProblem): string {
  switch (problem) {
    case "logged-out":
      return "the captured token state says the page is signed out";
    case "unreadable":
      return "the captured token state is not the JSON the page writes";
    default:
      return "the capture has no token entry at all";
  }
}

/**
 * The honest, specific refusal for a probe that did not authenticate.
 *
 * It always reports what the provider answered (status + its own code, or a bounded body snippet),
 * and — when the request went out without the page's token — says exactly that: the capture has no
 * page token, so the request was cookie-only, and that is not how this provider authenticates. The
 * whole message is kept under the pipeline's 300-character diagnostic bound, so no part of the cause
 * or its fix is truncated away. No URL is embedded: the sanitizer would rewrite it, and the operator
 * knows where they signed in.
 */
export function qwenTaskListProbeRefusal(
  observation: Pick<QwenTaskListObservation, "status" | "payload" | "sentAuthorization" | "tokenProblem">,
): string {
  const answered = `the task list answered HTTP ${observation.status} with `
    + `${qwenTaskListRefusal(observation.payload)}`;
  if (observation.sentAuthorization === false) {
    const problem = qwenTokenProblemText(observation.tokenProblem ?? "absent");
    return `${answered}; the provider's API rejected the cookie-only request: it needs the token the `
      + `page uses (${problem}) — sign in again so the capture includes it, then re-export and re-import`;
  }
  if (observation.sentAuthorization === true) {
    return `${answered}; the request carried the page's own token and was still refused, so the session `
      + "itself is no longer accepted — sign in again, then re-export and re-import";
  }
  return `${answered}; sign in to Qwen Code again, export the session again, and re-run the import`;
}
