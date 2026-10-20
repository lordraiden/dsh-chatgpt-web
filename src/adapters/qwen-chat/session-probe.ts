/**
 * The authenticated-session predicate for `chat.qwen.ai`.
 *
 * ## The one endpoint that decides it
 *
 * `GET /api/v2/chats` answers an anonymous caller **HTTP 200** with
 * `{"success":false,"data":{"code":"Unauthorized"}}` (recon §1.2). The status code therefore proves
 * nothing; the envelope does. A signed-in caller is authenticated when the same call answers
 * `success:true`. That is the predicate this module implements — no DOM scraping, no "is the avatar
 * visible", no invented "who am I" endpoint.
 *
 * ## The credential is the page's, read at call time
 *
 * The Qwen web app is not cookie-only: its API calls carry `authorization: Bearer <token>` built from
 * `localStorage["qwen_access_token_state"]`, the **same key** `coder.qwen.ai` uses (recon §1.8). This
 * module reuses the sibling adapter's token reader and bounded hydration wait rather than keeping a
 * second implementation of a value the vendor shares:
 *
 * 1. wait — bounded, on the app's own observable token state — for the page to restore its session;
 * 2. read the token from the live page at call time;
 * 3. issue `GET /api/v2/chats` from inside the same page through the provider-neutral
 *    `requestInPageContext`, with the app's header shape.
 *
 * No token is ever read from configuration or a fixture, and none is logged or returned.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

import { requestInPageContext } from "../page-context-request";
import {
  awaitQwenPageSession,
  qwenAccessTokenFromPersistedValue,
  readQwenAccessTokenFromPage,
  type QwenAccessTokenProblem,
  type QwenAccessTokenRead,
  type QwenAccessTokenSource,
  type QwenPageHydrationOptions,
  type QwenPageSessionWait,
} from "../qwen-code/session-probe";
import {
  QWEN_CHAT_AUTH_PROBE_TIMEOUT_MS,
  QWEN_CHAT_CHATS_MAX_ANSWER_CHARS,
  QWEN_CHAT_CHATS_PATH,
  QWEN_CHAT_PROVIDER_ID,
  qwenChatApiHeaders,
  qwenChatUrl,
} from "./provider";

// The hydration wait and the persisted-token parser are the vendor's, not this site's: both Qwen
// apps write the same `qwen_access_token_state` shape. Re-exported so this provider's public surface
// names its own dependency without copying it.
export { awaitQwenPageSession, qwenAccessTokenFromPersistedValue, readQwenAccessTokenFromPage };
export type { QwenAccessTokenProblem, QwenAccessTokenRead, QwenAccessTokenSource, QwenPageHydrationOptions, QwenPageSessionWait };

/** One assembled probe request. */
export interface QwenChatProbeRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** What one probe call observed. Credential-free by construction. */
export interface QwenChatProbeObservation {
  readonly status: number;
  /** The parsed body, or the raw text when it was not JSON. */
  readonly payload: unknown;
  readonly contentType?: string;
  /** The (bounded) raw body text, so a cut body can be explained instead of thrown away. */
  readonly bodyText?: string;
  /** Whether the transport cut the body at its bound. */
  readonly truncated?: boolean;
  /** Whether the provider's own `authorization` header accompanied the request. */
  readonly sentAuthorization?: boolean;
  readonly tokenSource?: QwenAccessTokenSource;
  readonly tokenProblem?: QwenAccessTokenProblem;
  readonly pageSession?: { readonly hydrated: boolean; readonly waitedMs: number };
}

/** Sends one assembled request. Production binds this to the provider's page. */
export type QwenChatProbeSender = (request: QwenChatProbeRequest) => Promise<{
  readonly status: number;
  readonly payload: unknown;
  readonly contentType?: string;
  readonly bodyText?: string;
  readonly truncated?: boolean;
}>;

/**
 * Whether a `/api/v2/chats` payload means "authenticated".
 *
 * The recorded anonymous answer is `success:false` with `data.code:"Unauthorized"`, so `success:true`
 * is the provider's own positive signal. `data.code:"Unauthorized"` is rejected defensively even if a
 * future envelope sets `success` inconsistently.
 */
export function qwenChatAuthenticated(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record["success"] !== true) return false;
  const data = record["data"];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const code = (data as Record<string, unknown>)["code"];
    if (code === "Unauthorized" || code === 401 || code === "401") return false;
  }
  return true;
}

/** How the verdict was read: a complete JSON body, or the leading envelope of a cut one. */
export type QwenChatProbeReadSource = "parsed-body" | "truncated-envelope";

/**
 * Decide the verdict from a complete body or from the envelope prefix of a cut one.
 *
 * `/api/v2/chats` returns the account's chat list, which can exceed the transport's bound; a cut
 * body must not be read as "the provider answered garbage". When the body was cut, the leading
 * `{"success":true` is the only part that matters, exactly like the Qwen Code probe's envelope
 * reading.
 */
export function qwenChatProbeVerdict(observation: QwenChatProbeObservation): {
  readonly authenticated: boolean;
  readonly source?: QwenChatProbeReadSource;
} {
  if (qwenChatAuthenticated(observation.payload)) {
    return { authenticated: true, source: "parsed-body" };
  }
  if (observation.truncated === true && typeof observation.bodyText === "string") {
    const prefix = observation.bodyText.trimStart();
    if (/^\{\s*"success"\s*:\s*true\b/.test(prefix)) {
      return { authenticated: true, source: "truncated-envelope" };
    }
  }
  return { authenticated: false };
}

/** The token problem in human words, never a token. */
function tokenProblemText(problem: QwenAccessTokenProblem): string {
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

/** One non-secret refusal line naming the operator's next action. */
export function qwenChatProbeRefusal(observation: QwenChatProbeObservation): string {
  if (observation.sentAuthorization === false) {
    return `Qwen Chat is not signed in: ${tokenProblemText(observation.tokenProblem ?? "absent")}. `
      + "Sign in at /v1/control/auth/ (choose \"Qwen Chat\").";
  }
  const detail = observation.bodyText === undefined
    ? `HTTP ${observation.status} with no body`
    : `HTTP ${observation.status}`;
  return `Qwen Chat refused the session check (${detail}): ${QWEN_CHAT_CHATS_PATH} did not answer success:true. `
    + "Sign in at /v1/control/auth/ (choose \"Qwen Chat\").";
}

/**
 * Build the probe request in the app's own shape.
 *
 * Everything except `authorization` and the per-call `x-request-id` is the shared client header set;
 * the URL is the measured authenticated path with no invented query parameters.
 */
export function qwenChatProbeRequest(accessToken?: string): QwenChatProbeRequest {
  return {
    url: qwenChatUrl(QWEN_CHAT_CHATS_PATH),
    headers: qwenChatApiHeaders({
      ...(accessToken === undefined || accessToken.length === 0 ? {} : { authorization: `Bearer ${accessToken}` }),
      "x-request-id": randomUUID(),
    }),
  };
}

/** The page-bound sender: the request is issued from the page's own browsing context. */
export function createQwenChatPageProbeSender(page: Page): QwenChatProbeSender {
  return async request => {
    const answer = await requestInPageContext(page, {
      url: request.url,
      headers: request.headers,
      timeoutMs: QWEN_CHAT_AUTH_PROBE_TIMEOUT_MS,
      // The chat list is account-sized; the bound is the answer's expected size, and the predicate
      // reads the envelope when the bound is not enough.
      maxAnswerChars: QWEN_CHAT_CHATS_MAX_ANSWER_CHARS,
    });
    return {
      status: answer.status,
      payload: answer.payload ?? answer.text,
      contentType: answer.contentType,
      bodyText: answer.text,
      truncated: answer.truncated,
    };
  };
}

/** Probe with an explicit token read and a sender, so the header gate is testable without a browser. */
export async function probeQwenChat(
  read: QwenAccessTokenRead,
  source: QwenAccessTokenSource,
  send: QwenChatProbeSender,
): Promise<QwenChatProbeObservation> {
  const request = qwenChatProbeRequest(read.accessToken);
  const answer = await send(request);
  return {
    status: answer.status,
    payload: answer.payload,
    ...(answer.contentType === undefined ? {} : { contentType: answer.contentType }),
    ...(answer.bodyText === undefined ? {} : { bodyText: answer.bodyText }),
    ...(answer.truncated === undefined ? {} : { truncated: answer.truncated }),
    sentAuthorization: read.accessToken !== undefined,
    tokenSource: read.accessToken === undefined ? "none" : source,
    ...(read.accessToken === undefined && read.problem !== undefined ? { tokenProblem: read.problem } : {}),
  };
}

/** Probe from the live page, reading the token it keeps now. */
export async function probeQwenChatFromPage(page: Page): Promise<QwenChatProbeObservation> {
  const read = await readQwenAccessTokenFromPage(page);
  return await probeQwenChat(read, "page", createQwenChatPageProbeSender(page));
}

/** Probe after a bounded wait for the app's own session restore (the import path). */
export async function probeQwenChatFromPageAfterHydration(
  page: Page,
  options: QwenPageHydrationOptions = {},
): Promise<QwenChatProbeObservation> {
  const session = await awaitQwenPageSession(page, options);
  const observation = await probeQwenChat(session.read, "page", createQwenChatPageProbeSender(page));
  return {
    ...observation,
    pageSession: { hydrated: session.hydrated, waitedMs: session.waitedMs },
  };
}

/** The provider id this probe belongs to, exported for refusal messages. */
export const QWEN_CHAT_PROBE_PROVIDER_ID = QWEN_CHAT_PROVIDER_ID;
