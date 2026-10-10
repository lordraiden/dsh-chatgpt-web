/**
 * Provider-neutral WebChat error contract (architecture §8.5).
 *
 * The shared **category** describes the semantic failure. Provider-specific diagnostic detail rides
 * along on the error (`providerId`, `providerCode`, `providerDetail`) without changing the
 * category, so the core can reason about a failure while the driver keeps its own vocabulary.
 *
 * Retry authority is deliberately NOT part of this contract: the exchange state machine owns it
 * (issue #191 / PR 3) and consumes these categories as its input.
 *
 * This module has no provider knowledge and no runtime dependency.
 */

/**
 * One owner for the vocabulary: the union is derived from the map so a new category cannot be
 * added to the list and forgotten in the type (or the other way around).
 */
const WEB_CHAT_ERROR_CATEGORY_MAP = {
  AUTH_REQUIRED: true,
  AUTH_EXPIRED: true,
  ACCOUNT_UNAVAILABLE: true,
  MODEL_UNAVAILABLE: true,
  CONVERSATION_LOST: true,
  CONVERSATION_STATE_MISMATCH: true,
  SUBMISSION_AMBIGUOUS: true,
  RESPONSE_TIMEOUT: true,
  UPSTREAM_RATE_LIMITED: true,
  UPSTREAM_ERROR: true,
  INPUT_TOO_LARGE: true,
  CANCELLED: true,
  TRANSPORT_UNAVAILABLE: true,
  UNSUPPORTED_OPTION: true,
  SHUTDOWN: true,
} as const;

/** Stable semantic failure categories (architecture §8.5, in that order). */
export type WebChatErrorCategory = keyof typeof WEB_CHAT_ERROR_CATEGORY_MAP;

/** Every category, for exhaustive checks and diagnostics. */
export const WEB_CHAT_ERROR_CATEGORIES = Object.keys(
  WEB_CHAT_ERROR_CATEGORY_MAP,
) as readonly WebChatErrorCategory[];

/** Provider diagnostic detail attached to a category without redefining it. */
export interface WebChatErrorOptions {
  /** Driver that produced the failure, when the failure crossed the driver boundary. */
  providerId?: string;
  /** Provider-private code, kept for diagnosis only. */
  providerCode?: string;
  /** Provider-private payload, kept for diagnosis only. Never required for the category. */
  providerDetail?: unknown;
  /** Underlying failure, preserved as the standard `cause`. */
  cause?: unknown;
}

/** A WebChat failure: a shared category plus optional provider detail. */
export class WebChatError extends Error {
  readonly category: WebChatErrorCategory;
  readonly providerId?: string;
  readonly providerCode?: string;
  readonly providerDetail?: unknown;

  constructor(category: WebChatErrorCategory, message: string, options: WebChatErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WebChatError";
    this.category = category;
    if (options.providerId !== undefined) this.providerId = options.providerId;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
    if (options.providerDetail !== undefined) this.providerDetail = options.providerDetail;
  }
}

/**
 * Build a WebChat failure. Kept beside the class so every producer constructs failures the same
 * way (including the `cause` link).
 */
export function webChatError(
  category: WebChatErrorCategory,
  message: string,
  options: WebChatErrorOptions = {},
): WebChatError {
  return new WebChatError(category, message, options);
}

/**
 * Whether a value is a WebChat failure.
 *
 * Deliberately structural (`category` + `Error`) rather than `instanceof`: a category-carrying
 * failure that crossed a module boundary or a serialization step must still be recognized.
 */
export function isWebChatError(value: unknown): value is WebChatError {
  if (!(value instanceof Error)) return false;
  const category = (value as unknown as { category?: unknown }).category;
  return typeof category === "string"
    && (WEB_CHAT_ERROR_CATEGORIES as readonly string[]).includes(category);
}
