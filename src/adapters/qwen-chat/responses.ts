/**
 * The Qwen Chat Responses route.
 *
 * `/v1/responses` and `/v1/chat/completions` are one engine in this product: the chat-completions
 * surface translates its wire shape into the internal Responses body and hands it to the same path.
 * Adding a provider therefore means adding **one** ingress for the internal body, which is this
 * module: it resolves the provider's own turn, runs it through the shared exchange and shapes the
 * answer with the bridge's existing Responses vocabulary.
 *
 * Nothing here is a second engine:
 *
 * - the turn identity, the declared purpose and "what makes a turn ephemeral" come from the host's
 *   one reader (`src/web-chat/host/turn-identity.ts`);
 * - the exchange lifecycle, retry authority and settlement come from
 *   `src/web-chat/transport/exchange-runner.ts`;
 * - the keep-alive clock, stall budget and `response.*` framing come from `bridge.ts`, so a Qwen Chat
 *   turn is framed exactly like the other providers' turns and no client learns a second dialect.
 *
 * The one thing this module owns is the provider's own error translation: a typed WebChat category
 * becomes a stable `error.code` a caller can act on (an `AUTH_REQUIRED` turn is a 401 with the
 * sign-in instruction, never a generic 500), and its own request refusal stays a typed 400.
 */
import type { AdapterEvent } from "../../types";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../../bridge";
import { rejectUnsupportedWebChatFeatures, type WebChatCapabilityFeature } from "../../web-chat/core";
import type { QwenChatProviderComposition } from "./provider-runtime";
import { QwenChatRequestError } from "./provider-runtime";

/** Options for {@link qwenChatResponsesRequest}. */
export interface QwenChatResponsesRequestOptions {
  /** The internal Responses request (already authenticated and admitted). */
  readonly request: Request;
  /** Its parsed body. */
  readonly body: unknown;
  /** The provider composition this deployment routed the model to. */
  readonly provider: QwenChatProviderComposition;
  /** Observe the exact adapter stream, like the native path does. */
  readonly onAdapterEvent?: (event: AdapterEvent) => void;
}

/**
 * The capability declarations this turn carries and this provider cannot execute.
 *
 * A `tools` / `tool_choice` / `mcp` declaration is protocol noise for a consumer web chat with no
 * execution path, so it is discarded — never forwarded — and **declared**, exactly like every other
 * surface does. The list and the refusal rule come from the Core (`rejectUnsupportedWebChatFeatures`);
 * this module keeps no second copy.
 */
function droppedCapabilities(body: Record<string, unknown>): readonly WebChatCapabilityFeature[] {
  return rejectUnsupportedWebChatFeatures({
    tools: body["tools"] ?? body["functions"],
    toolChoice: body["tool_choice"] ?? body["function_call"],
    mcp: body["mcp"],
  });
}

/** The body of one Responses request, as a record. */
function bodyRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/**
 * Serve one Responses request for a route this provider owns.
 *
 * @param options - the request, its body and the provider composition.
 * @returns the Responses payload (JSON or SSE), or a typed refusal.
 */
export async function qwenChatResponsesRequest(
  options: QwenChatResponsesRequestOptions,
): Promise<Response> {
  const body = bodyRecord(options.body);
  if (!body) {
    return formatErrorResponse(400, "invalid_request_error", "Request body must be a JSON object");
  }
  // This provider publishes no continuation state (`previous_response_id`), and this service does not
  // keep a second transcript for it: refusing is the honest answer, and it matches the other
  // providers' refusal so a caller sees one rule, not one per provider.
  const previous = body["previous_response_id"];
  if (typeof previous === "string" && previous.length > 0) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable for this provider; send the "
      + "conversation's messages, or start a new conversation.",
    );
  }

  const dropped = droppedCapabilities(body);
  if (dropped.length > 0) {
    console.warn(
      `[dsh-chatgpt-web] web_chat_dropped_capabilities ${JSON.stringify({
        endpoint: "responses",
        provider: options.provider.providerId,
        dropped,
      })}`,
    );
  }
  const declare = (response: Response): Response => {
    if (dropped.length > 0) response.headers.set("x-dsh-chatgpt-web-ignored-features", dropped.join(","));
    return response;
  };

  let turn;
  try {
    turn = options.provider.resolveTurn(options.body, options.request.headers);
  } catch (error) {
    if (error instanceof QwenChatRequestError) {
      return formatErrorResponse(400, "invalid_request_error", error.message, error.code);
    }
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : String(error),
    );
  }

  const events = options.provider.turnEvents(turn, options.request.signal);
  const observable: AsyncIterable<AdapterEvent> = options.onAdapterEvent === undefined
    ? events
    : (async function* () {
      for await (const event of events) {
        options.onAdapterEvent?.(event);
        yield event;
      }
    })();

  if (body["stream"] === true) {
    return declare(new Response(
      bridgeToResponsesSSE(
        observable,
        turn.route,
        undefined,
        undefined,
        undefined,
        () => undefined,
        2_000,
        {},
      ),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    ));
  }
  const collected: AdapterEvent[] = [];
  for await (const event of observable) collected.push(event);
  const payload = buildResponseJSON(collected, turn.route);
  return declare(Response.json(payload));
}
