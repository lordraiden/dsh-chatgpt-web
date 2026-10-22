/**
 * Provider-neutral refusal evidence: what a provider's own answer looked like, reduced to something a
 * refusal message and a log line may carry.
 *
 * ## Why this module exists
 *
 * Both Qwen products answer a refusal with **HTTP 200** and a body that is the diagnosis: the Qwen
 * Code probe discovered that (issue #299, `src/adapters/qwen-code/session-probe.ts`) and the Qwen Chat
 * write path needs exactly the same discipline — a thrown-away body is a refusal nobody can act on.
 * The Qwen Code probe built the machinery, and the Qwen Chat transport needs the identical rules, so
 * it lives here once instead of twice: the operator-facing snippet, the credential redaction, the
 * body-shape classification and the content-type rendering.
 *
 * ## The rules it owns
 *
 * - **Redaction by name first, then by shape.** A value assigned to a credential-named field is a
 *   secret whatever its length; a long alphanumeric run is redacted on purpose even when it is not a
 *   known token format, because a session token does not advertise itself and a snippet is exactly
 *   where one would otherwise surface.
 * - **Control characters are stripped, and bounding happens last.** A token must never be cut into a
 *   shorter run that the redaction patterns no longer recognise.
 * - **The shape is named, never guessed.** An empty body, a non-JSON document (an anti-bot HTML page
 *   is a real possibility), a cut body and ordinary text each get their own description, so "I cannot
 *   parse this" is never reported as "the provider answered garbage".
 *
 * Every consumer composes its own sentence; this module only decides what may appear inside it.
 */
import { nonSecretDiagnosticText } from "../lib/safe-diagnostics";

/** How much of the body a snippet may consider before the message budget cuts it. */
export const REFUSAL_BODY_CHARS = 200;

/** The longest `content-type` value a refusal will spend characters on; the rest is dropped. */
export const REFUSAL_CONTENT_TYPE_CHARS = 32;

/** A body fragment shorter than this is not worth spending the budget on. */
export const REFUSAL_MIN_FRAGMENT_CHARS = 8;

/** The provider's own free-text explanation, when the body carries one. */
export const REFUSAL_MESSAGE_KEYS = ["message", "detail", "error", "msg"] as const;

/** Bounds a provider's own free-text message so it stays one readable fragment. */
export const REFUSAL_MESSAGE_CHARS = 60;

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
export function redactTokenLike(value: string): string {
  let text = value;
  for (const [pattern, replacement] of TOKEN_LIKE_REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

/** A provider's own code/detail text, reduced to non-secret bounded text. */
export function sanitizedProviderText(value: string): string {
  return nonSecretDiagnosticText(redactTokenLike(value.trim()));
}

/**
 * One bounded, credential-free fragment of the provider's answer.
 *
 * The body is first stripped of control characters, then token-shaped runs are redacted, and only then
 * is it bounded. Truncation always happens last so a token can never be cut into a shorter run that
 * the redaction patterns no longer recognise. URLs and repeated whitespace are left to the one
 * sanitizer (`nonSecretDiagnosticText`) that already owns that policy.
 */
export function sanitizedBodyFragment(value: string): string {
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (stripped.length === 0) return "";
  return nonSecretDiagnosticText(redactTokenLike(stripped)).slice(0, REFUSAL_BODY_CHARS);
}

/** Whether a body is a document rather than the JSON the API is expected to answer. */
export function looksLikeHtmlDocument(text: string): boolean {
  const head = text.slice(0, 512);
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<\?xml)/i.test(head)
    || /<html[\s>]/i.test(head)
    || /<title[\s>]/i.test(text);
}

/** The `title` or first line of a non-JSON document, sanitized and bounded. */
export function htmlDocumentFragment(text: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text);
  if (title) {
    const name = sanitizedBodyFragment(title[1].replace(/<[^>]*>/g, " ").trim()).replace(/"/g, "'");
    if (name.length > 0) return `title "${name}"`;
  }
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? text;
  return sanitizedBodyFragment(firstLine);
}

/** Cut `text` to `max` characters with an ellipsis, so a truncation is visibly a truncation. */
export function truncateWithEllipsis(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * The provider's own vocabulary for a refusal, when the body carries it (`data.code` + `data.details`,
 * then a free-text `message`/`detail`/`error`/`msg`), or `undefined` when the body does not.
 *
 * `undefined` is not "no reason": it means the body is not a shape this module already understands,
 * which is exactly when the caller must fall back to reporting the body itself.
 */
export function providerAnswerReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
  const code = data["code"];
  if (typeof code === "string") {
    const safeCode = sanitizedProviderText(code);
    const details = data["details"];
    const safeDetails = typeof details === "string" ? sanitizedProviderText(details) : undefined;
    return safeDetails === undefined ? safeCode : `${safeCode} ${safeDetails}`;
  }
  for (const key of REFUSAL_MESSAGE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return `${key}: ${truncateWithEllipsis(sanitizedProviderText(value), REFUSAL_MESSAGE_CHARS)}`;
    }
  }
  return undefined;
}

/** The raw text of an answer, whether the caller observed it or only the parsed payload survives. */
export function answerBodyText(payload: unknown, bodyText: string | undefined): string {
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
export function answerIsJson(payload: unknown, bodyText: string | undefined): boolean {
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

/** One distinguishable rendering of the body, ordered from most to least useful. */
export interface AnswerBodyShape {
  /** What the body is, in the operator's words. */
  readonly tag: string;
  /** The same fact without the explanatory words, when the budget is tight. */
  readonly shortTag: string;
  /** The shortest possible label, when even {@link shortTag} does not fit. */
  readonly minimalTag: string;
  /** Distinguishing fragments, best first; each is already sanitized. */
  readonly details: readonly string[];
}

/**
 * Classify a body the caller does not recognise, keeping the evidence that identifies it.
 *
 * Every branch names what actually arrived instead of pretending it was JSON: an empty body, a
 * non-JSON document (an HTML block/challenge page is a real possibility), an unfamiliar JSON envelope,
 * or some other non-JSON text. A **cut** body is its own branch, before the generic text one: "the
 * transport stopped reading" is a different fact from "this is not JSON". A cut HTML document is still
 * named as the document it is, because that is the more actionable fact.
 */
export function answerBodyShape(
  payload: unknown,
  bodyText: string | undefined,
  truncated = false,
): AnswerBodyShape {
  const text = answerBodyText(payload, bodyText).trim();
  if (text.length === 0) {
    return {
      tag: "the provider answered with an empty body",
      shortTag: "empty body",
      minimalTag: "empty",
      details: [],
    };
  }

  if (answerIsJson(payload, bodyText)) {
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

/**
 * Render the body shape into whatever the message budget allows.
 *
 * Order of preference: the full explanation plus the complete distinguishing fragment; then a shorter
 * label plus the complete fragment; then the leading fragment (visibly cut) under the descriptive
 * label; then a label alone. Nothing is invented when the budget runs out: an empty string simply
 * leaves the status and content-type to identify the answer, which is the documented priority.
 */
export function shapeFragment(shape: AnswerBodyShape, budget: number): string {
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

/**
 * The answer's content type, reduced to what a refusal can afford to show.
 *
 * The media type is preferred over its parameters when the full header does not fit, and the value is
 * bounded and control-character-free. An injected seam that could not observe headers says so
 * (`(none)`) instead of implying the provider sent none.
 */
export function contentTypePart(contentType: string | undefined): string {
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
