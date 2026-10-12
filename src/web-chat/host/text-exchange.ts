/**
 * Provider-neutral exchange driver (issue #236).
 *
 * This is the host-boundary owner that runs **one text turn through the shared WebChat exchange**
 * (architecture §8.3, §9): it composes the provider's transport with the core's exchange lifecycle,
 * collects the normalized answer, and reports the exchange's own retry verdict and physical
 * settlement to its caller.
 *
 * It replaces the interim per-provider `runTextTurn` seam, whose contract could not express the
 * submission boundary: a provider that only offered "run the whole turn" could never answer
 * `submit()` truthfully (it would have to report `send_activated` for every success path, weakening
 * the retry authority) nor report settlement from provider-owned facts (architecture §9.3).
 *
 * The driver owns no policy: the provider resolves the route, the model, the conversation affinity
 * and the transport, and the core decides what each state means. Nothing here knows a provider, a
 * browser object, a selector or an endpoint.
 */
import { isWebChatError, type WebChatPhysicalSettlement, type WebChatRetrySafety, type WebChatTurnIdentity, type WebChatTurnInput } from "../core";
import {
  createWebChatExchange,
  createWebChatTransportLeaseRegistry,
  type WebChatTextTransport,
  type WebChatTransportLeaseRegistry,
  type WebChatTransportResource,
} from "../transport";

/**
 * What a provider hands the host to run one exchange.
 *
 * `identity`, `turn` and `transport` are the provider's answer to "what conversation, what text and
 * what UI seam"; the host supplies the exchange lifecycle around them. `leases` is shared by a
 * provider composition so the one-active-exchange-per-conversation rule spans exchanges, and
 * `dispose` releases whatever the handoff acquired (a retained surface, for instance) after the
 * exchange has settled.
 */
export interface WebChatTextExchangeHandoff {
  readonly transport: WebChatTextTransport;
  readonly identity: WebChatTurnIdentity;
  readonly turn: WebChatTurnInput;
  /** Conversation epoch this exchange runs in; results from another epoch are stale. */
  readonly epoch?: number;
  /** Lease registry shared by the provider composition; one is created when the provider has none. */
  readonly leases?: WebChatTransportLeaseRegistry;
  /** Create the transport resource when the conversation has none. */
  readonly createResource?: () => Promise<WebChatTransportResource>;
  /** Release what this handoff acquired. Called once, after the exchange has settled. */
  readonly dispose?: () => Promise<void> | void;
}

/** The outcome of one text turn run through the exchange. */
export interface WebChatTextExchangeOutcome {
  readonly ok: boolean;
  /** The answer text, on success. */
  readonly text?: string;
  /** Stable failure code, on failure. */
  readonly code?: string;
  /** Human-readable failure message, on failure. */
  readonly message?: string;
  /**
   * What the caller may do with the failed turn, decided by the exchange.
   *
   * `retry_safe` is the only case an automatic retry is allowed; a confirmed or ambiguous
   * submission never is (architecture §9.4).
   */
  readonly retrySafety?: WebChatRetrySafety;
  /** The last physical settlement the exchange published, when it published one. */
  readonly settlement?: WebChatPhysicalSettlement;
}

/** Options for {@link runWebChatTextExchange}. */
export interface WebChatTextExchangeOptions {
  /** Cancellation of the whole turn. */
  readonly signal?: AbortSignal;
  /** Submission attempts this logical turn may make; defaults to the exchange's own budget. */
  readonly maxSubmits?: number;
  readonly now?: () => number;
}

/** The stable code of a failure that carries no typed WebChat category. */
export const WEB_CHAT_EXCHANGE_FAILED_CODE = "webchat_exchange_failed";
/** The stable code of an exchange that completed without producing any answer text. */
export const WEB_CHAT_EXCHANGE_EMPTY_CODE = "webchat_exchange_empty";
/** The stable code of a cancelled exchange. */
export const WEB_CHAT_EXCHANGE_CANCELLED_CODE = "webchat_exchange_cancelled";

/** The typed category of a failure, or the stable fallback. */
function failureCode(error: unknown): string {
  return isWebChatError(error) ? error.category : WEB_CHAT_EXCHANGE_FAILED_CODE;
}

/** The human message of a failure. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one text turn through the shared exchange.
 *
 * The exchange owns readiness, the submission boundary, streaming, cancellation and physical
 * settlement; this function only collects the answer and translates the terminal state into a
 * stable outcome. Every path reports the exchange's retry verdict when it has one, so no caller
 * re-derives retryability from an error message.
 */
export async function runWebChatTextExchange(
  handoff: WebChatTextExchangeHandoff,
  options: WebChatTextExchangeOptions = {},
): Promise<WebChatTextExchangeOutcome> {
  const leases = handoff.leases ?? createWebChatTransportLeaseRegistry();
  const exchange = createWebChatExchange({
    identity: handoff.identity,
    turn: handoff.turn,
    transport: handoff.transport,
    leases,
    ...(handoff.epoch !== undefined ? { epoch: handoff.epoch } : {}),
    ...(handoff.createResource ? { createResource: handoff.createResource } : {}),
    ...(options.maxSubmits !== undefined ? { maxSubmits: options.maxSubmits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  /**
   * The exchange's retry verdict plus its settled verdict, awaited.
   *
   * The settlement is published asynchronously, so it must be asked for rather than read.
   */
  const settledReport = async (): Promise<{ readonly retrySafety: WebChatRetrySafety; readonly settlement?: WebChatPhysicalSettlement }> => {
    let settlement: WebChatPhysicalSettlement | undefined;
    try {
      settlement = await exchange.awaitSettlement();
    } catch {
      // A transport that cannot report settlement leaves the resource unsettled; the exchange has
      // already retired it, and inventing a verdict here would be worse than omitting one.
      settlement = exchange.settlement();
    }
    return {
      retrySafety: exchange.retrySafety(),
      ...(settlement !== undefined ? { settlement } : {}),
    };
  };

  try {
    try {
      await exchange.prepare();
    } catch (error) {
      // Readiness precedes the submission boundary, so this failure never reached the provider: the
      // exchange proves the turn is retry-safe and the resource was never used.
      const settled = await settledReport();
      return {
        ok: false,
        code: failureCode(error),
        message: failureMessage(error),
        // Readiness precedes the submission boundary, so the exchange's own verdict is provable:
        // nothing reached the provider and the resource was never used.
        retrySafety: "retry_safe",
        ...(settled.settlement !== undefined ? { settlement: settled.settlement } : {}),
      };
    }

    try {
      await exchange.submit();
    } catch (error) {
      // A thrown submission failure is ambiguous by construction: the runner marks the exchange and
      // settles the resource through the transport rather than declaring it free.
      return {
        ok: false,
        code: failureCode(error),
        message: failureMessage(error),
        ...(await settledReport()),
      };
    }

    let text = "";
    let terminal: { ok: boolean; code?: string; message?: string; text?: string } | undefined;
    // The terminal state is recorded and the loop is left, never returned from: leaving the loop
    // awaits the exchange's own `finally`, which is what publishes the physical settlement.
    for await (const event of exchange.stream()) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "completed":
          if (event.text.trim().length > 0) text = event.text;
          terminal = text.trim().length > 0
            ? { ok: true, text: text.trim() }
            : {
              ok: false,
              code: WEB_CHAT_EXCHANGE_EMPTY_CODE,
              message: "The exchange completed without producing any answer text",
            };
          break;
        case "cancelled":
          terminal = {
            ok: false,
            code: WEB_CHAT_EXCHANGE_CANCELLED_CODE,
            message: event.reason ?? "The exchange was cancelled",
          };
          break;
        case "error":
          terminal = { ok: false, code: event.error.category, message: event.error.message };
          break;
        default:
          break;
      }
      if (terminal) break;
    }
    // The runner synthesizes a terminal event for a stream that ends without one, so reaching this
    // point with nothing recorded means the exchange produced no usable answer.
    const outcome: WebChatTextExchangeOutcome = terminal ?? {
      ok: false,
      code: WEB_CHAT_EXCHANGE_EMPTY_CODE,
      message: "The exchange ended without a terminal event",
    };
    return { ...outcome, ...(await settledReport()) };
  } finally {
    try {
      await handoff.dispose?.();
    } catch {
      // Releasing is best effort: the exchange's own outcome is already decided and a release
      // failure must not replace it.
    }
  }
}
