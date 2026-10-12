/**
 * The ChatGPT provider composition for the provider-neutral text-turn port (issue #224).
 *
 * This is the ChatGPT-specific half of the staged Advisor seam: it maps one already-selected public
 * route and one ordinary user text onto the provider's existing turn execution, and it keeps every
 * ChatGPT-specific fact — route authority, backend model, adapter effort, retained-conversation
 * marker, response parsing and completion detection — inside this provider, where the architecture
 * requires it (architecture §4.2, §12, §20).
 *
 * It is not a second routing authority: the route it receives was already selected by the caller,
 * and it only resolves that route through the provider's existing authority. A route this deployment
 * does not serve fails explicitly instead of being substituted.
 */
import type { CodexMessage, CodexParsedRequest, CodexProviderConfig } from "../../types";
import {
  createChatGptWebRouteAuthorityFromProvider,
  requireChatGptWebRoute,
} from "../../chatgpt-web-authority";
import {
  ADVISOR_RECOVERY_UNAVAILABLE_CODE,
  ADVISOR_TURN_FAILED_CODE,
} from "../../advisor/message";
import type { ChatGptWebProviderAdapter } from "./index";
import type {
  WebChatTextRecoveryRequest,
  WebChatTextTurnOutcome,
  WebChatTextTurnRequest,
  WebChatProviderRuntime,
} from "../../web-chat/host/text-turn";
import type { WebChatProviderDriver } from "../../web-chat/core";
import { createChatGptWebDriver } from "./chatgpt-driver";

/** What the ChatGPT runtime needs to serve a text turn. */
export interface ChatGptWebProviderRuntimeOptions {
  readonly provider: CodexProviderConfig;
  /** The adapter that executes ChatGPT turns; the server's shared instance in production. */
  readonly adapter: ChatGptWebProviderAdapter;
  /** Provider label a provider-qualified choice is presented with. */
  readonly providerLabel?: string;
}

/**
 * Build the ChatGPT provider composition.
 *
 * @param options - provider configuration and the adapter that executes its turns.
 * @returns the driver plus the text-turn seam that serves it.
 */
export function createChatGptWebProviderRuntime(
  options: ChatGptWebProviderRuntimeOptions,
): WebChatProviderRuntime {
  const { provider, adapter } = options;
  const authority = createChatGptWebRouteAuthorityFromProvider(provider);
  const driver: WebChatProviderDriver = createChatGptWebDriver({ provider });

  /**
   * The provider request of one Advisor turn.
   *
   * Exactly one user message (the portable review text), the provider-resolved backend model and
   * effort, the host turn identity and the provider's retained-conversation marker. No system block:
   * the review is portable ordinary text (issue #224), so the provider is never asked to install a
   * hidden prefix.
   */
  const toTurnRequest = (request: WebChatTextTurnRequest): CodexParsedRequest => {
    const route = requireChatGptWebRoute(request.route, authority);
    const message: CodexMessage = {
      role: "user",
      content: request.userText,
      timestamp: Date.now(),
    };
    return {
      modelId: route.backendModel,
      context: { messages: [message] },
      stream: true,
      options: { reasoning: request.reasoningMode ?? route.adapterEffort },
      _dshContext: {
        dshSessionId: request.dshSession.sessionId,
        threadId: request.affinity.threadId,
        turnId: request.turnId,
      },
      // The provider's own marker: it retains this turn's independent Advisor conversation.
      _advisorReview: { reviewId: request.turnId },
    };
  };

  /**
   * The identity-only request a recovery reads through.
   *
   * It carries the same synthetic Advisor identity as the review turn — so both address the one
   * retained Advisor conversation of a session — and no message at all: a recovery reads, it never
   * submits.
   */
  const toRecoveryRequest = (request: WebChatTextRecoveryRequest): CodexParsedRequest => {
    const route = requireChatGptWebRoute(request.route, authority);
    return {
      modelId: route.backendModel,
      context: { messages: [] },
      stream: false,
      options: { reasoning: route.adapterEffort },
      _dshContext: {
        dshSessionId: request.dshSession.sessionId,
        threadId: request.affinity.threadId,
        turnId: request.turnId,
      },
      _advisorReview: { reviewId: request.turnId },
    };
  };

  return {
    driver,
    providerLabel: options.providerLabel ?? "ChatGPT Web",

    async runTextTurn(request: WebChatTextTurnRequest): Promise<WebChatTextTurnOutcome> {
      let parsed: CodexParsedRequest;
      try {
        parsed = toTurnRequest(request);
      } catch (error) {
        return {
          ok: false,
          code: ADVISOR_TURN_FAILED_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      let text = "";
      let terminal: "done" | "incomplete" | "error" | undefined;
      let failure: { code?: string; message?: string } | undefined;
      try {
        await adapter.runTurn(
          parsed,
          { headers: new Headers(), ...(request.signal ? { abortSignal: request.signal } : {}) },
          event => {
            switch (event.type) {
              case "text_delta":
                text += event.text;
                break;
              case "done":
                terminal = "done";
                break;
              case "incomplete":
                terminal = "incomplete";
                failure = {
                  code: ADVISOR_TURN_FAILED_CODE,
                  message: event.reason ?? "The review turn ended incomplete",
                };
                break;
              case "error":
                terminal = "error";
                failure = {
                  code: event.code ?? ADVISOR_TURN_FAILED_CODE,
                  message: event.message ?? "The review turn failed",
                };
                break;
              default:
                break;
            }
          },
        );
      } catch (error) {
        terminal = "error";
        failure = {
          code: ADVISOR_TURN_FAILED_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (terminal === "done" && text.trim().length > 0) {
        return { ok: true, text: text.trim() };
      }
      return {
        ok: false,
        code: failure?.code ?? ADVISOR_TURN_FAILED_CODE,
        message: failure?.message ?? "The review turn produced no text",
      };
    },

    async recoverTextTurn(request: WebChatTextRecoveryRequest): Promise<WebChatTextTurnOutcome> {
      const recover = adapter.recoverRetainedAnswer;
      if (typeof recover !== "function") {
        return {
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: "This ChatGPT Web adapter cannot read a retained conversation",
        };
      }
      let parsed: CodexParsedRequest;
      try {
        parsed = toRecoveryRequest(request);
      } catch (error) {
        return {
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        const recovered = await recover.call(adapter, parsed, {
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        const text = typeof recovered?.text === "string" ? recovered.text.trim() : "";
        if (!text) {
          return {
            ok: false,
            code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
            message: "The retained Advisor conversation exposed an empty answer",
          };
        }
        return { ok: true, text, capturedAt: recovered.capturedAt };
      } catch (error) {
        return {
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
