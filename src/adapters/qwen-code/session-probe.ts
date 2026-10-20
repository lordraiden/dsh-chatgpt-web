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
 * - **A transport bound never decides authentication.** `task/list` answers the account's own chat
 *   list, which can be far larger than any diagnostic snippet; the page transport therefore reads it
 *   up to a provider-owned bound and reports when it had to cut. A cut body is read structurally from
 *   its leading `{success, data}` envelope ({@link readQwenTruncatedEnvelope}), so "the transport
 *   stopped reading" can never again be reported as "the provider answered garbage" — the live
 *   `import_predicate_failed` of issue #299, where a `{"success":true,"data":[…]}` answer was cut at
 *   20 000 characters and refused as a non-JSON body.
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
  QWEN_CODE_TASK_LIST_MAX_ANSWER_CHARS,
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
  /**
   * Whether the transport had to **cut** the body at its own bound before the body ended.
   *
   * A cut body is not a provider failure: `task/list` answers an account-sized chat list, so a large
   * answer is normal and possibly a successful one. When this is `true` the parsed `payload` cannot
   * exist, and the answer is read structurally from its leading envelope
   * ({@link qwenTaskListVerdict}). Absent (or `false`) means "the whole body arrived", which is what
   * every injected seam that hands over a complete body means.
   */
  readonly truncated?: boolean;
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

/**
 * What the leading `{ success, data }` envelope of a **cut** body says.
 *
 * `unreadable` is not "garbage": it means the cut landed before the envelope's own verdict was
 * legible, so the honest answer is that this adapter could not read it.
 */
type QwenTruncatedEnvelopeRead =
  | { readonly verdict: "authenticated" }
  | { readonly verdict: "refused"; readonly reason?: string }
  | { readonly verdict: "unreadable" };

/** A cursor into a JSON document's leading bytes, which may end in the middle of a value. */
interface QwenJsonCursor {
  position: number;
}

/** A nesting bound, so a hostile body cannot turn a prefix read into unbounded recursion. */
const ENVELOPE_MAX_DEPTH = 32;

/** Skip the whitespace JSON allows between tokens. */
function skipEnvelopeWhitespace(text: string, cursor: QwenJsonCursor): void {
  while (cursor.position < text.length) {
    const code = text.charCodeAt(cursor.position);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) cursor.position += 1;
    else return;
  }
}

/**
 * Read one JSON string at the cursor, or `undefined` when the prefix ends inside it.
 *
 * Escapes are kept verbatim: the only consumer is a diagnostic reason, so decoding every escape
 * would be more parser than this read needs.
 */
function readEnvelopeString(text: string, cursor: QwenJsonCursor): string | undefined {
  if (text[cursor.position] !== '"') return undefined;
  cursor.position += 1;
  let value = "";
  while (cursor.position < text.length) {
    const ch = text[cursor.position]!;
    if (ch === "\\") {
      const escaped = text[cursor.position + 1];
      if (escaped === undefined) return undefined;
      value += ch + escaped;
      cursor.position += 2;
      continue;
    }
    cursor.position += 1;
    if (ch === '"') return value;
    value += ch;
  }
  return undefined;
}

/** Read the bare literal token at the cursor (`true`, `false`, `null`, a number), or `undefined`. */
function readEnvelopeLiteral(text: string, cursor: QwenJsonCursor): string | undefined {
  const start = cursor.position;
  while (cursor.position < text.length) {
    const ch = text[cursor.position]!;
    if (ch === "," || ch === "}" || ch === "]" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
    cursor.position += 1;
  }
  return cursor.position === start ? undefined : text.slice(start, cursor.position);
}

/**
 * Skip one JSON value, returning `false` when the prefix ends inside it.
 *
 * Used only to step over members this read does not need. A cut inside a skipped value is the normal
 * case for a large `data` array, so failing here is information, not an error.
 */
function skipEnvelopeValue(text: string, cursor: QwenJsonCursor, depth = 0): boolean {
  if (depth > ENVELOPE_MAX_DEPTH) return false;
  skipEnvelopeWhitespace(text, cursor);
  const opening = text[cursor.position];
  if (opening === undefined) return false;
  if (opening === '"') return readEnvelopeString(text, cursor) !== undefined;
  if (opening === "{" || opening === "[") {
    const closing = opening === "{" ? "}" : "]";
    cursor.position += 1;
    for (;;) {
      skipEnvelopeWhitespace(text, cursor);
      if (text[cursor.position] === closing) {
        cursor.position += 1;
        return true;
      }
      if (text[cursor.position] === undefined) return false;
      if (opening === "{") {
        if (readEnvelopeString(text, cursor) === undefined) return false;
        skipEnvelopeWhitespace(text, cursor);
        if (text[cursor.position] !== ":") return false;
        cursor.position += 1;
      }
      if (!skipEnvelopeValue(text, cursor, depth + 1)) return false;
      skipEnvelopeWhitespace(text, cursor);
      if (text[cursor.position] === ",") {
        cursor.position += 1;
        continue;
      }
      if (text[cursor.position] === closing) {
        cursor.position += 1;
        return true;
      }
      return false;
    }
  }
  const literal = readEnvelopeLiteral(text, cursor);
  return literal !== undefined && /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(literal);
}

/**
 * Read the string members of the object at the cursor that this module cares about.
 *
 * A cut inside the object simply yields the members that were visible; the caller decides whether
 * that is enough to report a reason.
 */
function readEnvelopeStringMembers(
  text: string,
  cursor: QwenJsonCursor,
  wanted: readonly string[],
): Record<string, string> {
  const found: Record<string, string> = {};
  if (text[cursor.position] !== "{") return found;
  cursor.position += 1;
  for (;;) {
    skipEnvelopeWhitespace(text, cursor);
    const next = text[cursor.position];
    if (next !== '"') break;
    const key = readEnvelopeString(text, cursor);
    if (key === undefined) break;
    skipEnvelopeWhitespace(text, cursor);
    if (text[cursor.position] !== ":") break;
    cursor.position += 1;
    skipEnvelopeWhitespace(text, cursor);
    if (wanted.includes(key) && text[cursor.position] === '"') {
      const value = readEnvelopeString(text, cursor);
      if (value === undefined) break;
      found[key] = value;
    } else if (!skipEnvelopeValue(text, cursor, 1)) {
      break;
    }
    skipEnvelopeWhitespace(text, cursor);
    if (text[cursor.position] === ",") {
      cursor.position += 1;
      continue;
    }
    break;
  }
  return found;
}

/** The provider's own vocabulary for a refusal read from a cut body's envelope. */
function qwenEnvelopeRefusalReason(
  code: string | undefined,
  details: string | undefined,
  freeText: { readonly key: string; readonly value: string } | undefined,
): string | undefined {
  if (code !== undefined && code.trim().length > 0) {
    const safeCode = qwenProviderCode(code);
    const safeDetails = details === undefined ? undefined : qwenProviderCode(details);
    return safeDetails === undefined ? safeCode : `${safeCode} ${safeDetails}`;
  }
  if (freeText !== undefined) {
    const text = nonSecretDiagnosticText(redactTokenLike(freeText.value.trim()));
    return `${freeText.key}: ${truncateWithEllipsis(text, REFUSAL_MESSAGE_CHARS)}`;
  }
  return undefined;
}

/**
 * Read the verdict out of the leading `{ success, data }` envelope of a body this adapter had to cut.
 *
 * ## The rule, deliberately narrow
 *
 * This is used **only** for a body the transport reported as truncated — such a body cannot be
 * parsed, so the ordinary predicate (`success === true && Array.isArray(data)`) has nothing to
 * inspect. The rule is:
 *
 * 1. the body must **begin** with a JSON object (an optional byte-order mark and whitespace are
 *    allowed). A body that starts with a document (`<!DOCTYPE html>`, `<html>`) is not this shape and
 *    is never read this way, so an HTML block page still refuses as the document it is;
 * 2. `success` must be a **top-level member of that object** whose value is the literal `true` or
 *    `false`. A `"success":true` anywhere else — nested deeper, inside a string, in the middle of the
 *    text — is not an envelope and never authenticates. This is the whole reason the read is a small
 *    scanner instead of a regex over the snippet;
 * 3. `success:false` refuses, citing the provider's own reason from the prefix when it is legible
 *    (`data.code`/`data.details`, then a free-text `message`/`detail`/`error`/`msg`), because that
 *    reason is the operator's diagnosis;
 * 4. `success:true` authenticates. The provider has answered its own authorization question, and the
 *    cut removed the `data` payload that only the *content* predicate would need. If the prefix does
 *    show a `data` member and it does not open an array, this is not the list envelope this module
 *    knows: no verdict is taken rather than authenticating a shape nobody has evidence for;
 * 5. anything else (no object, no boolean `success`, a cut inside the key or the literal) is
 *    `unreadable`, and the refusal says the body was cut instead of guessing.
 */
function readQwenTruncatedEnvelope(text: string): QwenTruncatedEnvelopeRead {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const cursor: QwenJsonCursor = { position: 0 };
  skipEnvelopeWhitespace(body, cursor);
  if (body[cursor.position] !== "{") return { verdict: "unreadable" };
  cursor.position += 1;

  let success: boolean | undefined;
  let dataOpening: string | undefined;
  let dataMembers: Record<string, string> = {};
  let freeText: { key: string; value: string } | undefined;

  for (;;) {
    skipEnvelopeWhitespace(body, cursor);
    const next = body[cursor.position];
    // The prefix ended between members, or the object closed: either way, scan no further.
    if (next === undefined || next === "}") break;
    if (next !== '"') return { verdict: "unreadable" };
    const key = readEnvelopeString(body, cursor);
    if (key === undefined) break;
    skipEnvelopeWhitespace(body, cursor);
    if (body[cursor.position] !== ":") return { verdict: "unreadable" };
    cursor.position += 1;
    skipEnvelopeWhitespace(body, cursor);

    if (key === "success") {
      const literal = readEnvelopeLiteral(body, cursor);
      if (literal === "true") success = true;
      else if (literal === "false") success = false;
      // A cut inside the literal, or a non-boolean value, is not this envelope's success flag.
      else return { verdict: "unreadable" };
    } else if (key === "data") {
      dataOpening = body[cursor.position];
      if (dataOpening === "{") {
        dataMembers = readEnvelopeStringMembers(body, cursor, ["code", "details"]);
      } else if (!skipEnvelopeValue(body, cursor)) {
        // The array the list envelope answers is cut: expected, and its opening character is all the
        // rule needs. Nothing after it can change the verdict.
        break;
      }
    } else if (freeText === undefined && (REFUSAL_MESSAGE_KEYS as readonly string[]).includes(key)
      && body[cursor.position] === '"') {
      const value = readEnvelopeString(body, cursor);
      if (value !== undefined && value.trim().length > 0) freeText = { key, value };
    } else if (!skipEnvelopeValue(body, cursor)) {
      break;
    }

    skipEnvelopeWhitespace(body, cursor);
    if (body[cursor.position] === ",") {
      cursor.position += 1;
      continue;
    }
    break;
  }

  if (success === undefined) return { verdict: "unreadable" };
  if (success === false) {
    const reason = qwenEnvelopeRefusalReason(dataMembers["code"], dataMembers["details"], freeText);
    return reason === undefined ? { verdict: "refused" } : { verdict: "refused", reason };
  }
  if (dataOpening !== undefined && dataOpening !== "[") return { verdict: "unreadable" };
  return { verdict: "authenticated" };
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
 * or some other non-JSON text. A **cut** body is its own branch, before the generic text one: "the
 * transport stopped reading" is a different fact from "this is not JSON", and reporting the first as
 * the second is exactly the misdiagnosis this module had to stop making. A cut HTML document is still
 * named as the document it is, because that is the more actionable fact.
 */
function qwenAnswerBodyShape(
  payload: unknown,
  bodyText: string | undefined,
  truncated = false,
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

  if (truncated) {
    const snippet = sanitizedBodyFragment(text);
    return {
      tag: `the provider's answer was cut at ${text.length} characters before its JSON envelope was complete`,
      shortTag: `cut at ${text.length} characters`,
      minimalTag: "truncated",
      details: snippet.length === 0 ? [] : [snippet],
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
 * understand, so their text is unchanged. A body the transport had to **cut** cannot be parsed, so its
 * leading envelope is read instead; a refused envelope reports the provider's own reason exactly like
 * a parsed one. Everything else is classified into an {@link QwenAnswerBodyShape}: the refusal then
 * reports what actually arrived instead of guessing.
 */
function readQwenTaskListRefusal(
  payload: unknown,
  answer: Pick<QwenTaskListAnswer, "bodyText" | "truncated"> = {},
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

  if (answer.truncated === true && typeof answer.bodyText === "string") {
    const envelope = readQwenTruncatedEnvelope(answer.bodyText);
    if (envelope.verdict === "refused") {
      return { recognised: true, text: envelope.reason ?? "an envelope reporting success:false" };
    }
  }

  const shape = qwenAnswerBodyShape(payload, answer.bodyText, answer.truncated === true);
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
  answer: Pick<QwenTaskListAnswer, "contentType" | "bodyText" | "truncated"> = {},
): string {
  return readQwenTaskListRefusal(payload, answer).text;
}

/** Which reading decided a task-list answer. Diagnostics only: the verdict is `authenticated`. */
export type QwenTaskListReadSource = "parsed-body" | "truncated-envelope";

/** What one task-list answer decided, and which reading decided it. */
export interface QwenTaskListVerdict {
  readonly authenticated: boolean;
  /**
   * How the answer was read, present only when a reading authenticated it.
   *
   * `parsed-body` is the ordinary predicate over a complete body; `truncated-envelope` means the
   * transport cut the body and its leading envelope (`success:true`) decided. Naming it is what makes
   * the next truncation diagnosable from a success line, not only from a refusal.
   */
  readonly source?: QwenTaskListReadSource;
  /** A cut body's envelope refused: the provider's own reason, when the prefix carried one. */
  readonly reason?: string;
}

/**
 * The one verdict for a `task/list` answer, whether it arrived whole or cut.
 *
 * This is the authentication decision; {@link qwenTaskListAuthenticated} stays the content predicate
 * for a body that parsed. The order matters: a complete body is always decided by the predicate, and
 * only a body the transport reported as **truncated** may be decided structurally. A cut body that is
 * not the endpoint's envelope is neither authenticated nor explained away: the caller composes the
 * honest truncation refusal from {@link qwenTaskListProbeRefusal}.
 */
export function qwenTaskListVerdict(
  answer: Pick<QwenTaskListAnswer, "payload" | "bodyText" | "truncated">,
): QwenTaskListVerdict {
  if (qwenTaskListAuthenticated(answer.payload)) return { authenticated: true, source: "parsed-body" };
  if (answer.truncated === true && typeof answer.bodyText === "string") {
    const envelope = readQwenTruncatedEnvelope(answer.bodyText);
    if (envelope.verdict === "authenticated") return { authenticated: true, source: "truncated-envelope" };
    if (envelope.verdict === "refused") {
      return {
        authenticated: false,
        source: "truncated-envelope",
        ...(envelope.reason === undefined ? {} : { reason: envelope.reason }),
      };
    }
  }
  return { authenticated: false };
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
      // The list is account-sized, so this call raises the transport's default: the bound is the
      // answer's expected size, not a threshold at which a good session starts looking bad
      // ({@link QWEN_CODE_TASK_LIST_MAX_ANSWER_CHARS} explains the value, and the predicate tolerates
      // the cut when it is not enough).
      maxAnswerChars: QWEN_CODE_TASK_LIST_MAX_ANSWER_CHARS,
    });
    // The page's answer is kept whole: the parsed payload for the predicate, and the content type
    // plus raw text so an unrecognised body can be reported instead of thrown away. `truncated` is
    // kept too, because a cut body is a reading to explain, not a failure to report.
    return {
      status: answer.status,
      payload: answer.payload ?? answer.text,
      contentType: answer.contentType,
      bodyText: answer.text,
      truncated: answer.truncated,
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
    ...(answer.truncated === undefined ? {} : { truncated: answer.truncated }),
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
 * The "what to do" clause for a refusal the provider's own vocabulary explains.
 *
 * Kept byte-identical to the wording this refusal has always used: the operator-facing sentence is a
 * contract (`doc/qwen-code.md` §6), and only the truncation clause is ever inserted in front of it.
 */
function qwenProviderRefusalAction(
  observation: Pick<
    QwenTaskListObservation,
    "sentAuthorization" | "tokenProblem" | "pageSession"
  >,
): string {
  if (observation.sentAuthorization === false) {
    const problem = qwenTokenProblemText(observation.tokenProblem ?? "absent");
    if (observation.pageSession !== undefined && !observation.pageSession.hydrated) {
      return `; the captured session opened the page, but after `
        + `${observation.pageSession.waitedMs}ms it still does not consider itself signed in `
        + `(${problem}), so no page token was sent — sign in again, then re-export and re-import`;
    }
    return `; the provider's API rejected the cookie-only request: it needs the token the `
      + `page uses (${problem}) — sign in again so the page itself has one, then re-export and re-import`;
  }
  if (observation.sentAuthorization === true) {
    return "; the request carried the page's own token and was still refused, so the session "
      + "itself is no longer accepted — sign in again, then re-export and re-import";
  }
  return "; sign in to Qwen Code again, export the session again, and re-run the import";
}

/**
 * The clause that says the transport cut the body, and which reading won — fitted to the budget.
 *
 * This is the diagnostic the live failure lacked: "the body was bigger than the transport bound" and
 * "the envelope says `success:true`/`success:false`" are the two facts that decide the verdict, so the
 * refusal carries both (the full form is `; body truncated at 65536 chars; the envelope reports
 * success:false`). It is only ever emitted for a body the transport actually reported as truncated,
 * so a normal refusal's text does not change. Shorter forms exist only because the pipeline's inner
 * diagnostic bound is 300 characters; the last resort still says "truncated" rather than dropping the
 * fact that decided the message.
 */
function qwenTruncationClause(
  observation: Pick<QwenTaskListObservation, "payload" | "bodyText" | "truncated">,
  budget: number,
): string {
  if (observation.truncated !== true || budget <= 0) return "";
  const chars = typeof observation.bodyText === "string" ? observation.bodyText.length : undefined;
  const where = chars === undefined ? "body truncated" : `body truncated at ${chars} chars`;
  const success = qwenEnvelopeSuccessValue(observation.payload, observation);
  const candidates = success === undefined
    ? [`; ${where}`, "; body truncated", "; truncated"]
    : [
      `; ${where}; the envelope reports success:${success}`,
      `; ${where}; success:${success}`,
      "; truncated",
    ];
  return candidates.find(candidate => candidate.length <= budget) ?? "";
}

/**
 * The envelope's own `success` value, from whichever reading is available.
 *
 * A parsed body answers directly; a cut body's leading envelope is read structurally. `undefined`
 * means neither reading could produce it, and the refusal then says only that the body was cut.
 */
function qwenEnvelopeSuccessValue(
  payload: unknown,
  answer: Pick<QwenTaskListAnswer, "bodyText" | "truncated">,
): boolean | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const success = (payload as Record<string, unknown>)["success"];
    if (typeof success === "boolean") return success;
  }
  if (typeof answer.bodyText === "string") {
    const envelope = readQwenTruncatedEnvelope(answer.bodyText);
    if (envelope.verdict === "authenticated") return true;
    if (envelope.verdict === "refused") return false;
  }
  return undefined;
}

/**
 * The honest, specific refusal for a probe that did not authenticate.
 *
 * It always reports what the provider answered. When the body is one of the shapes this adapter
 * already understands (the provider's `data.code`, or a free-text message), the text is unchanged.
 * When it is **not**, the refusal reports the HTTP status, the `content-type` and a redacted snippet
 * of the actual body — an HTML block page is named as a non-JSON document with its title/first line,
 * and a body the transport had to cut is named as cut (with the length), never as "non-JSON" —
 * because discarding that body is exactly the blindness this refusal exists to remove.
 *
 * When the truncation mattered, the refusal says which reading won: a cut body whose envelope reports
 * `success:false` is refused *by that envelope*, and the message carries both facts, so the next
 * person to read the log can tell a transport bound from a provider refusal.
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
    | "status"
    | "payload"
    | "contentType"
    | "bodyText"
    | "truncated"
    | "sentAuthorization"
    | "tokenProblem"
    | "pageSession"
  >,
): string {
  const answer = {
    ...(observation.bodyText === undefined ? {} : { bodyText: observation.bodyText }),
    ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
  };
  const read = readQwenTaskListRefusal(observation.payload, answer);

  if (read.recognised) {
    const answered = `the task list answered HTTP ${observation.status} with ${read.text}`;
    const action = qwenProviderRefusalAction(observation);
    const note = qwenTruncationClause(
      observation,
      PROBE_REFUSAL_MAX_CHARS - answered.length - action.length,
    );
    return `${answered}${note}${action}`;
  }

  // The answer did not match a known shape. Report the identifying fields in priority order: HTTP
  // status, content-type, then as much of the actual body as the remaining budget allows.
  const head = `the task list answered HTTP ${observation.status}`;
  const contentType = qwenContentTypePart(observation.contentType);
  const action = qwenUnrecognisedAction(observation);
  const shapeBudget = PROBE_REFUSAL_MAX_CHARS - head.length - contentType.length - action.length;
  const shape = qwenShapeFragment(
    read.shape
      ?? qwenAnswerBodyShape(observation.payload, observation.bodyText, observation.truncated === true),
    shapeBudget,
  );
  return `${head}${contentType}${shape}${action}`;
}
