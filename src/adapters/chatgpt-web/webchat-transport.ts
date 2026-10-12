/**
 * The ChatGPT Web `WebChatTextTransport` (issue #236, architecture §8.3, §12.1).
 *
 * It projects the phased turn the provider already runs (`openTextTurn`) onto the shared exchange
 * contract. Every fact it reports is the provider's own:
 *
 * - `ready()` waits for the surface readiness the adapter establishes;
 * - `submit()` waits for and reports the provider's proven submission phase — the boundary the
 *   exchange's retry rules key on — instead of inferring it from an outcome;
 * - `stream()` normalizes the provider's `AdapterEvent`s (text, completion, failure, cancellation);
 * - `settle()` reports the provider's physical settlement through the existing ChatGPT→core bridge,
 *   so no lifecycle interpretation is duplicated here;
 * - `abort()` cancels this one turn.
 *
 * Nothing here reads a page, a selector or a provider DTO: those stay behind the adapter.
 */
import { WEB_CHAT_ERROR_CATEGORIES, webChatError, type WebChatErrorCategory, type WebChatExchangeEvent } from "../../web-chat/core";
import type { WebChatTextTransport, WebChatTextTransportContext } from "../../web-chat/transport";
import { chatGptWebChatPhysicalSettlementOf, chatGptWebChatSubmissionPhaseOf } from "./web-chat-exchange-bridge";
import type { ChatGptWebTextTurn } from "./text-turn";

/** The stable transport identity this projection reports. */
export const CHATGPT_WEB_TEXT_TRANSPORT_ID = "chatgpt-web-ui";

/** Whether a provider code is already one of the shared semantic categories. */
function sharedCategory(code: string | undefined): WebChatErrorCategory | undefined {
  return code !== undefined && (WEB_CHAT_ERROR_CATEGORIES as readonly string[]).includes(code)
    ? (code as WebChatErrorCategory)
    : undefined;
}

/** The semantic category of one failed turn event. */
function failureCategory(event: { readonly code?: string; readonly message?: string }): WebChatErrorCategory {
  if (event.code === "aborted" || (event.message ?? "").toLowerCase().includes("abort")) return "CANCELLED";
  return sharedCategory(event.code) ?? "UPSTREAM_ERROR";
}

/**
 * Build the ChatGPT transport over one phased turn.
 *
 * @param turn - the phased turn opened with `openTextTurn`.
 * @returns the transport the host runs through `createWebChatExchange`.
 */
export function createChatGptWebTextTransport(turn: ChatGptWebTextTurn): WebChatTextTransport {
  return {
    id: CHATGPT_WEB_TEXT_TRANSPORT_ID,

    async ready(_context: WebChatTextTransportContext): Promise<void> {
      await turn.ready;
    },

    async submit(_context: WebChatTextTransportContext) {
      // The provider's browser pipeline prepares the composer and activates Send inside one run; this
      // waits for the phase it proves rather than triggering a second send (see text-turn.ts).
      return chatGptWebChatSubmissionPhaseOf(await turn.awaitSubmission());
    },

    async *stream(context: WebChatTextTransportContext): AsyncIterable<WebChatExchangeEvent> {
      const epoch = context.epoch;
      let text = "";
      let readyReported = false;
      let submittedReported = false;
      let terminal = false;
      for await (const event of turn.events) {
        if (!readyReported) {
          readyReported = true;
          yield { type: "ready", epoch };
        }
        switch (event.type) {
          case "text_delta":
            text += event.text;
            yield { type: "text_delta", epoch, text: event.text };
            break;
          case "done":
            if (!submittedReported) {
              submittedReported = true;
              yield { type: "submitted", epoch };
            }
            terminal = true;
            yield { type: "completed", epoch, text };
            break;
          case "incomplete":
            terminal = true;
            yield {
              type: "error",
              epoch,
              error: webChatError("UPSTREAM_ERROR", event.message ?? event.reason, {
                providerDetail: { reason: event.reason, retryable: event.retryable === true },
              }),
            };
            break;
          case "error":
            if (failureCategory(event) === "CANCELLED") {
              terminal = true;
              yield { type: "cancelled", epoch, reason: event.message };
              break;
            }
            terminal = true;
            yield {
              type: "error",
              epoch,
              error: webChatError(failureCategory(event), event.message, {
                providerDetail: {
                  ...(event.code !== undefined ? { code: event.code } : {}),
                  ...(event.status !== undefined ? { status: event.status } : {}),
                  ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
                },
              }),
            };
            break;
          default:
            break;
        }
        if (terminal) return;
      }
      // The transport owes a terminal event: a turn that ended without one is an incomplete
      // exchange, never a completed answer.
      yield {
        type: "error",
        epoch,
        error: webChatError("UPSTREAM_ERROR", "The ChatGPT turn ended without a terminal event"),
      };
    },

    async settle(_context: WebChatTextTransportContext) {
      return chatGptWebChatPhysicalSettlementOf(await turn.settled());
    },

    async abort(_context: WebChatTextTransportContext, reason?: unknown): Promise<void> {
      await turn.abort(reason);
    },
  };
}
