/**
 * Normalized WebChat exchange events (architecture §8.3).
 *
 * The vocabulary is deliberately small: `ready`, `submitted`, `text_delta`, `completed`,
 * `cancelled`, `error`. A driver may have much richer internal events, but only the semantics the
 * shared layer needs are normalized here — reasoning/commentary phases, provider DTOs, usage
 * shapes and transport frames stay provider-private.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import type { WebChatError } from "./errors";

/** The exchange is ready to accept its submit boundary. */
export interface WebChatExchangeReadyEvent {
  readonly type: "ready";
}

/**
 * The provider may have accepted the submission.
 *
 * This is the semantic boundary the retry rules key on (architecture §9.4): after it, an automatic
 * duplicate submission is forbidden unless the driver proves duplicate safety.
 */
export interface WebChatExchangeSubmittedEvent {
  readonly type: "submitted";
}

/** Incremental assistant text. Provider-specific phases are not part of the common vocabulary. */
export interface WebChatExchangeTextDeltaEvent {
  readonly type: "text_delta";
  readonly text: string;
}

/** The exchange produced its final text. */
export interface WebChatExchangeCompletedEvent {
  readonly type: "completed";
  readonly text: string;
}

/** The exchange was cancelled (idempotent, architecture §9.2). */
export interface WebChatExchangeCancelledEvent {
  readonly type: "cancelled";
  readonly reason?: string;
}

/** The exchange failed semantically. */
export interface WebChatExchangeErrorEvent {
  readonly type: "error";
  readonly error: WebChatError;
}

/** Every event the common layer may observe from an exchange. */
export type WebChatExchangeEvent =
  | WebChatExchangeReadyEvent
  | WebChatExchangeSubmittedEvent
  | WebChatExchangeTextDeltaEvent
  | WebChatExchangeCompletedEvent
  | WebChatExchangeCancelledEvent
  | WebChatExchangeErrorEvent;

/** The normalized event type discriminator. */
export type WebChatExchangeEventType = WebChatExchangeEvent["type"];

/** Every normalized event type, from one declaration. */
export const WEB_CHAT_EXCHANGE_EVENT_TYPES = [
  "ready",
  "submitted",
  "text_delta",
  "completed",
  "cancelled",
  "error",
] as const satisfies readonly WebChatExchangeEventType[];

/** Whether a value carries one of the normalized event discriminators. */
export function isWebChatExchangeEventType(value: unknown): value is WebChatExchangeEventType {
  return typeof value === "string"
    && (WEB_CHAT_EXCHANGE_EVENT_TYPES as readonly string[]).includes(value);
}
