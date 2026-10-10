/**
 * Provider-neutral text exchange transport seam (architecture §12, §18.1).
 *
 * The core sees only semantic operations: get ready, submit, stream, settle, abort. It never learns
 * how readiness, submission or completion are detected, how response text is extracted, or which
 * browser or network protocol is used — those are provider-local by construction (a DOM transport, a
 * browser-network transport, a hybrid, or a session resource that is not a page at all).
 *
 * Nothing in this contract may mention a browser page, a selector, an endpoint or a provider DTO.
 */
import type { WebChatExchangeEvent } from "../core/events";
import type { WebChatSubmissionPhase } from "../core/exchange-state";
import type { WebChatPhysicalSettlement } from "../core/exchange-state";
import type { WebChatTurnIdentity, WebChatTurnInput } from "../core/exchange";

/** Everything a transport gets for one exchange. It is not given policy. */
export interface WebChatTextTransportContext {
  /** Logical identity of the exchange (session, binding, conversation, turn). */
  readonly identity: WebChatTurnIdentity;
  /** The semantic turn to carry. */
  readonly turn: WebChatTurnInput;
  /** Cancellation signal for this exchange. */
  readonly signal: AbortSignal;
}

/**
 * One provider transport.
 *
 * Every method reports *semantic* facts the provider established; none of them tells the core how
 * the provider found them.
 */
export interface WebChatTextTransport {
  /** Stable transport identity, for diagnostics. */
  readonly id: string;
  /**
   * Reach transport readiness.
   *
   * A rejection is a pre-submission failure: nothing was submitted, so it is retry-safe.
   */
  ready(context: WebChatTextTransportContext): Promise<void>;
  /**
   * Attempt submission of the turn.
   *
   * The returned phase is the provider's own admission of what it proved:
   * `prepared` (nothing was sent — retry-safe), `send_activated` (it may have been sent — ambiguous),
   * or `accepted` (the provider confirmed acceptance — never automatically retried).
   */
  submit(context: WebChatTextTransportContext): Promise<WebChatSubmissionPhase>;
  /**
   * The provider's normalized events, until the exchange ends.
   *
   * A transport that cannot continue must end the stream (or yield an `error` event); it must not
   * silently stop producing while the core believes output is still coming.
   */
  stream(context: WebChatTextTransportContext): AsyncIterable<WebChatExchangeEvent>;
  /**
   * Establish or report physical settlement.
   *
   * An error or a timeout is never proof that the provider's operation stopped, so this is the only
   * authority on whether the transport resource is safe to reuse.
   */
  settle(context: WebChatTextTransportContext): Promise<WebChatPhysicalSettlement>;
  /** Abort the provider exchange. Idempotent from the caller's perspective. */
  abort?(context: WebChatTextTransportContext, reason?: unknown): Promise<void>;
}
