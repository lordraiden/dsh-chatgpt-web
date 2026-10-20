/**
 * The Qwen Chat provider composition: driver + one text exchange per turn.
 *
 * ## What a turn does, end to end
 *
 * ```text
 * public route "qwen-chat/<model>" + the caller's reasoning selection (Auto|Thinking|Fast)
 *         ↓  (this module: the service's catalogue already chose the route)
 * provider-local model id, mode, current user text, turn identity, declared purpose
 *         ↓  (the core decides continuity — never this module)
 * resolveWebChatContinuation  ->  new_conversation | exact_resume | replay | failed
 *         ↓
 * beginWebChatConversationAttempt  (the record becomes unconfirmed)
 *         ↓  (the shared exchange owns readiness, submission, streaming, settlement)
 * createWebChatExchange + the Qwen Chat transport (chats/new when the conversation has no chat,
 * then chat/completions?chat_id=… with the mode in messages[0].feature_config)
 *         ↓  (on a completed turn)
 * record the chat + response cursor, confirmWebChatConversation
 * ```
 *
 * Two rules this composition exists to keep:
 *
 * - **The provider does not decide continuity.** It states its intent from provider facts (a recorded
 *   chat is a continuation; a lost one is an explicit replay from canonical history; nothing is a new
 *   conversation except a first turn) and hands the decision to the core. A refusal is a refusal.
 * - **An ephemeral turn touches nothing.** No store read, no store write, no chat, no cursor: the
 *   caller's housekeeping is answered and kept nowhere (`turn-delivery.ts`), which is why a session
 *   title can never show up as a chat in the operator's account.
 *
 * ## The mode is chosen once, here
 *
 * The catalogue publishes a model's supported modes; the caller may select one with any of the three
 * channels the product's surfaces already use (`reasoningMode`, OpenAI's `reasoning_effort`, or
 * Responses' `reasoning.effort`). This module resolves that selection against the model's measured
 * abilities **once**, and the transport sends exactly that mode. A mode the model does not offer is a
 * typed 400, never a silent fallback.
 *
 * Everything provider-private stays here: the chat id, the cursor, the request shapes, the replay
 * prompt and the fact that the route is qualified by this provider's id. No rule here enters
 * `src/web-chat/core/**`.
 */
import type { AdapterEvent } from "../../types";
import type { AppConfig } from "../../config";
import {
  ApiProjectionRefusalError,
  contentConversationIdentity,
  normalizeApiSessionId,
  projectApiConversation,
  type ApiConversationMessage,
} from "../../web-chat/host/api-projection";
import {
  declaredTurnChannels,
  nativeTurnMetadataFromBody,
  nativeTurnMetadataString,
  resolveNativeTurnIdentity,
} from "../../web-chat/host/turn-identity";
import {
  beginWebChatConversationAttempt,
  confirmWebChatConversation,
  isEphemeralWebChatTurn,
  isWebChatError,
  resolveWebChatContinuation,
  webChatAccountBindingId,
  webChatContinuationIdentity,
  webChatError,
  type WebChatAccountBinding,
  type WebChatConversation,
  type WebChatConversationIdentity,
  type WebChatConversationStore,
  type WebChatContinuationIntent,
  type WebChatProviderDriver,
  type WebChatReplayMessage,
} from "../../web-chat/core";
import {
  createWebChatExchange,
  createWebChatTransportLeaseRegistry,
  type WebChatTextTransport,
  type WebChatTransportLeaseRegistry,
} from "../../web-chat/transport";
import type { WebChatTextExchangeHandoff } from "../../web-chat/host/text-exchange";
import type {
  WebChatProviderRuntime,
  WebChatTextRecoveryRequest,
  WebChatTextTurnOutcome,
  WebChatTextTurnRequest,
} from "../../web-chat/host/text-turn";
import { ADVISOR_RECOVERY_UNAVAILABLE_CODE } from "../../advisor/message";
import { resolveSharedConversationStore } from "../../web-chat/host/provider-host";
import { webChatPublicRoute } from "../../web-chat/host/text-turn";
import { parseRequest } from "../../responses/parser";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { createQwenChatDriver, qwenChatAffinityKey } from "./driver";
import {
  createFileQwenChatConversationState,
  createMemoryQwenChatConversationState,
  type QwenChatConversationState,
} from "./chat-state";
import { createQwenChatBrowserSession, type QwenChatRequestSession } from "./browser-session";
import { createQwenChatTextTransport, type QwenChatTurnAnswer } from "./text-transport";
import {
  qwenChatAccountBinding,
  qwenChatCatalogueRows,
  qwenChatModelDescriptors,
  resolveQwenChatProviderConfig,
  type QwenChatProviderConfig,
} from "./provider-config";
import { qwenChatEntryModes, type QwenChatModelEntry } from "./models";
import {
  isQwenChatMode,
  qwenChatDefaultMode,
  type QwenChatMode,
} from "./provider";

/** A request this provider cannot serve. The server maps it to a typed 400. */
export class QwenChatRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "QwenChatRequestError";
    if (code !== undefined) this.code = code;
  }
}

/** Everything one turn needs, resolved from a provider-neutral request body. */
export interface QwenChatResolvedTurn {
  /** Public route the caller selected. */
  readonly route: string;
  /** Provider-local model id sent to the provider. */
  readonly model: string;
  /** The resolved mode, or `undefined` for a model whose abilities hide the selection entirely. */
  readonly mode?: QwenChatMode;
  /** `info.meta.thinking_format` of the selected model, when it published one. */
  readonly thinkingFormat?: string;
  /** The current turn's human text (the only message a conversational turn sends). */
  readonly userText: string;
  /** Canonical history the caller sent, for an explicit replay. */
  readonly history: readonly WebChatReplayMessage[];
  /** Canonical DSH session identity, when the caller declared one. */
  readonly dshSessionId?: string;
  /** The identity this turn is addressed by (session, thread, or content-derived). */
  readonly threadId: string;
  /** Host turn identity. */
  readonly turnId: string;
  /** The caller's declared turn purpose, when it sent one. */
  readonly purpose?: string;
  /** Whether this turn is housekeeping: answered, kept nowhere. */
  readonly ephemeral: boolean;
}

/** The public composition the server routes `qwen-chat/<model>` requests to. */
export interface QwenChatProviderComposition {
  readonly providerId: string;
  readonly provider: QwenChatProviderConfig;
  readonly driver: WebChatProviderDriver;
  readonly runtime: WebChatProviderRuntime;
  /** The public catalogue rows (`providerId/modelId`) this deployment serves. */
  readonly catalogue: readonly Record<string, unknown>[];
  /** The provider-local model id of a public route this deployment serves, or `undefined`. */
  modelOf(route: string): string | undefined;
  /** Resolve the provider-neutral body into this provider's turn. Throws `QwenChatRequestError`. */
  resolveTurn(raw: unknown, headers: Headers): QwenChatResolvedTurn;
  /** The normalized adapter events of one turn, for the shared Responses/chat-completions shaping. */
  turnEvents(turn: QwenChatResolvedTurn, signal?: AbortSignal): AsyncIterable<AdapterEvent>;
  /** Release the session page and the durable state. Idempotent. */
  close(): Promise<void>;
}

/** Construction options for {@link createQwenChatProvider}. */
export interface QwenChatProviderOptions {
  /** The deployment configuration. */
  readonly config: AppConfig;
  /** Resolved provider facts; derived from `config` when omitted. */
  readonly provider?: QwenChatProviderConfig;
  /** Durable continuity store; the deployment's shared one when omitted. */
  readonly store?: WebChatConversationStore;
  /** Chat state; the durable one under the provider directory when omitted. */
  readonly state?: QwenChatConversationState;
  /** Session page seam (tests); the real Chromium-backed session when omitted. */
  readonly session?: QwenChatRequestSession;
  /** Clock seam. */
  readonly now?: () => number;
  /** Id seam. */
  readonly newId?: () => string;
}

/** Read one message's text, text parts only. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

/** The conversational messages of a request, as the replay input. */
export function qwenChatReplayHistory(messages: readonly ApiConversationMessage[]): readonly WebChatReplayMessage[] {
  const history: WebChatReplayMessage[] = [];
  for (const message of messages) {
    const text = message.content.trim();
    if (text.length === 0) continue;
    const role = message.role;
    if (role === "user") history.push({ role: "user", text });
    else if (role === "assistant") history.push({ role: "assistant", text });
    else if (role === "system") history.push({ role: "system", text });
    else if (role === "developer") history.push({ role: "developer", text });
    // Every other role (`tool`, `toolResult`, a harness-only kind) is transport state, not text.
  }
  return history;
}

/**
 * Compile canonical history into the one prompt a replay sends.
 *
 * A replay creates a **new** chat, so the rebuilt conversation has to arrive as text: `User:` /
 * `Assistant:` lines, the same convention the ChatGPT and Qwen Code compilers use, built only from
 * the canonical messages the caller sent (never from provider state and never from a stored
 * transcript).
 */
export function compileQwenChatReplayPrompt(history: readonly WebChatReplayMessage[]): string {
  const lines: string[] = [];
  for (const message of history) {
    if (message.text.trim().length === 0) continue;
    const label = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : message.role === "system" ? "System" : "Developer";
    lines.push(`${label}: ${message.text}`);
  }
  return lines.join("\n");
}

/** The current turn's human text: the newest `user` line of the transmitted set. */
function currentUserText(messages: readonly ApiConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.content.trim().length > 0) return message.content;
  }
  return undefined;
}

/**
 * The reasoning selection a caller sent, on any of the product's three channels.
 *
 * The catalogue advertises the labels; this is where the public surfaces' spellings are understood.
 * Precedence is the native declaration first (`reasoningMode`, the Advisor's own channel), then the
 * OpenAI standard (`reasoning_effort`), then the Responses object (`reasoning.effort`) — a more
 * specific declaration always wins, exactly like the identity channels.
 */
export function qwenChatRequestedMode(body: Record<string, unknown>): string | undefined {
  const direct = body["reasoningMode"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const effort = body["reasoning_effort"];
  if (typeof effort === "string" && effort.trim().length > 0) return effort.trim();
  const reasoning = body["reasoning"];
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const nested = (reasoning as Record<string, unknown>)["effort"];
    if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
  }
  return undefined;
}

/**
 * Resolve the mode a turn sends for one model.
 *
 * The availability comes from the model's measured abilities (the bundle's `mv` rule, ported in
 * `provider.ts`). An explicit selection the model does not offer is refused with the valid labels; a
 * turn with no explicit selection uses the model's own default (`gv`). A model whose abilities hide
 * the selection entirely resolves to `undefined` — the recorded app then sends no thinking selection
 * rather than an invented one.
 *
 * @throws {QwenChatRequestError} when the explicit selection is not one this model offers.
 */
export function qwenChatTurnMode(
  entry: QwenChatModelEntry,
  requested: string | undefined,
): { readonly mode?: QwenChatMode; readonly thinkingFormat?: string } {
  const modes = qwenChatEntryModes(entry);
  if (requested !== undefined) {
    if (!isQwenChatMode(requested) || !modes.includes(requested)) {
      throw new QwenChatRequestError(
        `The Qwen Chat model ${JSON.stringify(entry.id)} does not offer reasoning mode `
        + `${JSON.stringify(requested)}${modes.length === 0
          ? "; this model hides the mode selection"
          : `; available modes: ${modes.join(", ")}`}.`,
        "unknown_reasoning_mode",
      );
    }
    return {
      mode: requested,
      ...(entry.thinkingFormat === undefined ? {} : { thinkingFormat: entry.thinkingFormat }),
    };
  }
  const mode = modes.length === 0 ? undefined : qwenChatDefaultMode(entry) ?? modes[0];
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(mode !== undefined && entry.thinkingFormat !== undefined ? { thinkingFormat: entry.thinkingFormat } : {}),
  };
}

/** The provider's own status/type for one shared category, so a client can act on it. */
function failureOf(error: unknown): Extract<AdapterEvent, { type: "error" }> {
  const category = isWebChatError(error) ? error.category : "UPSTREAM_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const providerCode = isWebChatError(error) ? error.providerCode : undefined;
  const mapped: Record<string, { status: number; errorType: string }> = {
    AUTH_REQUIRED: { status: 401, errorType: "authentication_error" },
    AUTH_EXPIRED: { status: 401, errorType: "authentication_error" },
    ACCOUNT_UNAVAILABLE: { status: 403, errorType: "permission_error" },
    MODEL_UNAVAILABLE: { status: 400, errorType: "invalid_request_error" },
    UNSUPPORTED_OPTION: { status: 400, errorType: "invalid_request_error" },
    CONVERSATION_LOST: { status: 409, errorType: "invalid_request_error" },
    CONVERSATION_STATE_MISMATCH: { status: 409, errorType: "invalid_request_error" },
    INPUT_TOO_LARGE: { status: 400, errorType: "invalid_request_error" },
    RESPONSE_TIMEOUT: { status: 504, errorType: "server_error" },
    TRANSPORT_UNAVAILABLE: { status: 503, errorType: "server_error" },
    UPSTREAM_RATE_LIMITED: { status: 429, errorType: "rate_limit_error" },
    CANCELLED: { status: 499, errorType: "client_closed_request" },
    SUBMISSION_AMBIGUOUS: { status: 502, errorType: "server_error" },
    SHUTDOWN: { status: 503, errorType: "server_error" },
  };
  const status = mapped[category] ?? { status: 502, errorType: "upstream_error" };
  return {
    type: "error",
    message,
    status: status.status,
    errorType: status.errorType,
    code: providerCode ?? category.toLowerCase(),
    // The exchange owns retry safety; an error event never invites an automatic retry.
    retryable: false,
  };
}

/** The affinity session identity: the declared session, else the caller's own thread identity. */
export function qwenChatAffinitySessionId(identity: {
  readonly dshSessionId?: string;
  readonly threadId: string;
}): string {
  return identity.dshSessionId !== undefined && identity.dshSessionId.length > 0
    ? identity.dshSessionId
    : identity.threadId;
}

/**
 * Create the Qwen Chat provider composition.
 *
 * @param options - the deployment configuration and the injectable seams.
 * @returns the driver, the provider runtime seam, the catalogue rows and the turn runner.
 */
export function createQwenChatProvider(options: QwenChatProviderOptions): QwenChatProviderComposition {
  const provider = options.provider ?? resolveQwenChatProviderConfig(options.config);
  const now = options.now ?? Date.now;
  // The deployment's one conversation store. The host owns the registry: the ChatGPT and Qwen Code
  // providers compose the same instance, and the durable backend allows exactly one writer per file.
  const store = options.store ?? resolveSharedConversationStore({
    ...(options.config.webChat !== undefined ? { webChat: options.config.webChat } : {}),
  });
  const state = options.state ?? createDefaultState(provider);
  const session: QwenChatRequestSession = options.session ?? createQwenChatBrowserSession({
    provider,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const leases: WebChatTransportLeaseRegistry = createWebChatTransportLeaseRegistry();
  const binding: WebChatAccountBinding = qwenChatAccountBinding(provider);
  const driver = createQwenChatDriver({
    provider,
    state,
    release: async () => { await session.close(); },
  });

  const modelOf = (route: string): string | undefined => {
    const prefix = `${provider.providerId}/`;
    if (!route.startsWith(prefix)) return undefined;
    const local = route.slice(prefix.length);
    return local.length > 0 && provider.models.some(model => model.id === local) ? local : undefined;
  };

  /** The catalogue entry of a provider-local model id. */
  const entryOf = (model: string): QwenChatModelEntry | undefined =>
    provider.models.find(candidate => candidate.id === model);

  /**
   * Open the shared exchange for one conversation state.
   *
   * `chat` is the recorded chat of a continuation, or `undefined` when this turn must create one or
   * must not have one (ephemeral). Nothing else varies: the transport always speaks the same protocol.
   */
  const exchangeFor = (input: {
    readonly conversationKey: string;
    readonly turnId: string;
    readonly epoch: number;
    readonly turn: { readonly model: string; readonly mode?: QwenChatMode; readonly thinkingFormat?: string; readonly userText: string };
    readonly chat?: { readonly chatId: string; readonly parentId?: string };
    readonly ephemeral: boolean;
    readonly onAnswer?: (answer: QwenChatTurnAnswer) => Promise<void> | void;
    readonly onChatLost?: (reason: string) => Promise<void> | void;
  }): WebChatTextExchangeHandoff => {
    const transport: WebChatTextTransport = createQwenChatTextTransport({
      session,
      model: input.turn.model,
      ...(input.turn.mode === undefined ? {} : { mode: input.turn.mode }),
      ...(input.turn.thinkingFormat === undefined ? {} : { thinkingFormat: input.turn.thinkingFormat }),
      ...(input.chat ? { chat: input.chat } : {}),
      ephemeral: input.ephemeral,
      ...(input.onAnswer ? { onAnswer: input.onAnswer } : {}),
      ...(input.onChatLost ? { onChatLost: input.onChatLost } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
    });
    return {
      transport,
      identity: {
        bindingId: webChatAccountBindingId(binding),
        conversationKey: input.conversationKey,
        turnId: input.turnId,
      },
      turn: { userText: input.turn.userText, model: input.turn.model },
      epoch: input.epoch,
      leases,
      createResource: async () => ({
        id: `${input.conversationKey}:${input.epoch}`,
        conversationKey: input.conversationKey,
        epoch: input.epoch,
      }),
    };
  };

  /** The continuity decision of one conversational turn, and the chat it will use. */
  const decideContinuity = async (
    turn: QwenChatResolvedTurn,
  ): Promise<{
    readonly identity: WebChatConversationIdentity;
    readonly conversation: WebChatConversation;
    readonly chat?: { readonly chatId: string; readonly parentId?: string };
    readonly replay: boolean;
  }> => {
    const dshSession = { sessionId: qwenChatAffinitySessionId(turn) };
    const scope = {
      binding,
      dshSession,
      threadId: turn.threadId,
      namespace: provider.namespace,
    };
    const identity = webChatContinuationIdentity(scope);
    const stored = await store.read(identity);
    const entry = state.read(identity.key);
    let intent: WebChatContinuationIntent;
    if (!stored) {
      intent = {
        kind: "new_conversation",
        expectedGeneration: 0,
        reason: "first turn of this chat",
      };
    } else if (stored.checkpoint !== "confirmed" && turn.history.length > 0) {
      // The recorded conversation's last attempt was never confirmed (a crashed, cancelled or
      // half-observed turn), and this provider has no measured way to reconcile it: it cannot prove
      // from provider state which message the chat actually holds. The honest recovery is the same one
      // the ChatGPT provider takes when it cannot prove its installation state — an **explicit**
      // replay from canonical history, which advances the generation and is recorded as such. The
      // alternative (omitting `reconcileConversation` and refusing forever) would strand the caller's
      // conversation with no way out of the API.
      intent = {
        kind: "replay",
        expectedGeneration: stored.generation,
        reason: "the last attempt on this conversation was never confirmed and the provider cannot reconcile it; it is rebuilt explicitly from canonical host history",
        history: turn.history,
      };
    } else if (entry?.chat?.status === "active") {
      intent = { kind: "continue" };
    } else if (turn.history.length > 0) {
      // The provider no longer holds this conversation's chat (never created, or rejected). The
      // rebuild is an **explicit** replay from canonical history: the generation advances and the
      // caller's conversation is preserved, which is the opposite of a silent new chat.
      intent = {
        kind: "replay",
        expectedGeneration: stored.generation,
        reason: entry?.chat?.status === "lost"
          ? "the provider no longer accepts this conversation's chat; it is rebuilt from canonical host history"
          : "the provider has no chat recorded for this conversation; it is rebuilt from canonical host history",
        history: turn.history,
      };
    } else {
      // Nothing canonical to rebuild from: keep the core's honest refusal instead of forking.
      intent = { kind: "continue" };
    }
    const plan = await resolveWebChatContinuation(
      { store, driver },
      { ...scope, model: turn.route, ...(turn.mode === undefined ? {} : { reasoningMode: turn.mode }), intent },
    );
    if (plan.outcome === "failed" || !plan.conversation || !plan.record) {
      throw plan.error ?? webChatError(
        "CONVERSATION_STATE_MISMATCH",
        "The WebChat Core refused continuity for this Qwen Chat turn",
      );
    }
    const recordedChat = state.read(identity.key)?.chat;
    // The cursor a continuation sends is the previous response's id; `parentId` is kept as the
    // fallback for a stream that never reported one.
    const cursor = recordedChat?.responseId ?? recordedChat?.parentId;
    const chat = plan.outcome === "replay"
      ? undefined
      // A continued or adopted conversation reuses the provider chat; anything else creates one.
      : recordedChat?.status === "active"
        ? { chatId: recordedChat.chatId, ...(cursor !== undefined ? { parentId: cursor } : {}) }
        : undefined;
    return { identity, conversation: plan.conversation, ...(chat ? { chat } : {}), replay: plan.outcome === "replay" };
  };

  /**
   * Run one exchange and translate it to the adapter's normalized event vocabulary.
   *
   * The exchange is the shared implementation (`createWebChatExchange`); this function only reports
   * its outcome in the vocabulary the Responses bridge already consumes, so the Qwen Chat route
   * reuses the product's one keep-alive, stall budget and terminal framing.
   */
  async function* runExchange(
    handoff: WebChatTextExchangeHandoff,
    signal: AbortSignal | undefined,
    onCompleted: () => Promise<void>,
  ): AsyncGenerator<AdapterEvent> {
    const exchange = createWebChatExchange({
      identity: handoff.identity,
      turn: handoff.turn,
      transport: handoff.transport,
      leases: handoff.leases ?? leases,
      ...(handoff.epoch !== undefined ? { epoch: handoff.epoch } : {}),
      ...(handoff.createResource ? { createResource: handoff.createResource } : {}),
      ...(signal ? { signal } : {}),
    });
    /** The cancellation outcome, as the exchange recorded it. */
    const cancelled = (): AdapterEvent => ({
      type: "incomplete",
      reason: "cancelled",
      message: "The Qwen Chat turn was cancelled",
    });
    /** Whether the turn reached its own terminal event (a completion or an explicit failure). */
    let terminal = false;
    try {
      try {
        await exchange.prepare();
      } catch (error) {
        // A caller that cancelled while the exchange was still getting ready is a cancellation, not a
        // provider failure: the exchange's own state is the authority on which one it was.
        yield exchange.snapshot().cancelRequested ? cancelled() : failureOf(error);
        return;
      }
      try {
        await exchange.submit();
      } catch (error) {
        yield exchange.snapshot().cancelRequested ? cancelled() : failureOf(error);
        return;
      }
      try {
        // `for await` (not a manually driven iterator) on purpose: leaving this loop — by `break`, by
        // an exception, or by the consumer cancelling — calls the runner's own `return()`, which is
        // what publishes the physical settlement and releases the conversation's lease. Driving the
        // iterator by hand would leave the next turn refused as "another exchange still owns it".
        for await (const event of exchange.stream()) {
          if (event.type === "text_delta") {
            yield { type: "text_delta", text: event.text };
            continue;
          }
          if (event.type === "completed") {
            terminal = true;
            await onCompleted();
            yield { type: "done", stopReason: "stop", endTurn: true };
            break;
          }
          if (event.type === "cancelled") {
            terminal = true;
            yield { type: "incomplete", reason: "cancelled", message: event.reason ?? "The turn was cancelled" };
            break;
          }
          if (event.type === "error") {
            terminal = true;
            yield failureOf(event.error);
            break;
          }
        }
      } catch (error) {
        // A cancellation that races an exchange transition surfaces as a state mismatch from the
        // shared runner; the cancelled exchange is what actually happened.
        yield exchange.snapshot().cancelRequested ? cancelled() : failureOf(error);
        return;
      }
      if (!terminal) {
        // The runner already settled the exchange logically; a stream that ends without a terminal
        // event is an incomplete answer, never a completed one. A cancelled exchange is reported as
        // the cancellation it is, exactly as the runner classifies it.
        yield exchange.snapshot().cancelRequested
          ? cancelled()
          : {
            type: "incomplete",
            reason: "stream_ended",
            message: "The Qwen Chat stream ended without a terminal event",
          };
      }
    } finally {
      if (!terminal) {
        // The consumer stopped reading before the turn ended (a client that disconnected, a caller
        // that only wanted the first events, a cancelled request). The provider turn must be aborted
        // — not left producing into a stream nobody reads — and that also publishes settlement, so
        // the conversation is usable again on the next turn (issue #329's rule, reused).
        try {
          await exchange.abort("the consumer stopped reading the turn");
        } catch {
          // Aborting is best effort: the exchange's own settlement is what the next turn needs.
        }
      }
      try {
        await handoff.dispose?.();
      } catch {
        // Releasing is best effort: the outcome is already decided.
      }
    }
  }

  /** The turn runner: continuity, then the exchange, then the durable confirmation. */
  async function* turnEventsInternal(
    turn: QwenChatResolvedTurn,
    signal?: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    if (turn.ephemeral) {
      // Housekeeping: no store read, no store write, no chat, no cursor. The conversation key is
      // turn-scoped so it can never collide with, or be adopted as, the caller's conversation.
      const handoff = exchangeFor({
        conversationKey: `qwen-chat-ephemeral:${turn.turnId}`,
        turnId: turn.turnId,
        epoch: 1,
        turn: {
          model: turn.model,
          ...(turn.mode === undefined ? {} : { mode: turn.mode }),
          ...(turn.thinkingFormat === undefined ? {} : { thinkingFormat: turn.thinkingFormat }),
          userText: turn.userText,
        },
        ephemeral: true,
      });
      yield* runExchange(handoff, signal, async () => undefined);
      return;
    }
    let planned: Awaited<ReturnType<typeof decideContinuity>>;
    try {
      planned = await decideContinuity(turn);
    } catch (error) {
      yield failureOf(error);
      return;
    }
    const { identity, conversation } = planned;
    const generation = conversation.generation;
    let attempt;
    try {
      attempt = await beginWebChatConversationAttempt(store, identity, { generation });
    } catch (error) {
      yield failureOf(error);
      return;
    }
    const prompt = planned.replay ? compileQwenChatReplayPrompt(turn.history) : turn.userText;
    const handoff = exchangeFor({
      conversationKey: identity.key,
      turnId: turn.turnId,
      epoch: generation,
      turn: {
        model: turn.model,
        ...(turn.mode === undefined ? {} : { mode: turn.mode }),
        ...(turn.thinkingFormat === undefined ? {} : { thinkingFormat: turn.thinkingFormat }),
        userText: prompt.length > 0 ? prompt : turn.userText,
      },
      ...(planned.chat ? { chat: planned.chat } : {}),
      ephemeral: false,
      onAnswer: (answer) => {
        // The provider's own continuation state: the chat and the response cursor the next turn
        // hangs off.
        state.recordChat(identity.key, {
          chatId: answer.chatId,
          ...(answer.parentId !== undefined ? { parentId: answer.parentId } : {}),
          ...(answer.responseId !== undefined ? { responseId: answer.responseId } : {}),
          ...(answer.responseIndex !== undefined ? { responseIndex: answer.responseIndex } : {}),
          status: "active",
          updatedAt: now(),
        });
      },
      onChatLost: (reason) => {
        state.markLost(identity.key, reason);
      },
    });
    yield* runExchange(handoff, signal, async () => {
      try {
        await confirmWebChatConversation(store, identity, {
          generation: attempt.generation,
          turnId: turn.turnId,
          at: now(),
        });
      } catch (error) {
        // The turn's answer is already delivered; failing it here would not make the state truer.
        console.warn(
          `[qwen-chat] qwen_chat_turn_confirm_failed ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
        );
      }
    });
  }

  const runtime: WebChatProviderRuntime = {
    driver,
    providerLabel: "Qwen Chat",

    /**
     * Open one exchange for an already-selected route (the neutral in-process seam).
     *
     * It resolves the route, the model, the mode default and the affiliation's recorded chat and
     * hands the host a transport plus the semantic turn; the caller that owns durable continuity (the
     * API ingress) uses {@link QwenChatProviderComposition.turnEvents} instead, which also records the
     * chat and confirms the turn. A route this provider does not serve throws instead of being
     * substituted.
     */
    async openTextExchange(request: WebChatTextTurnRequest): Promise<WebChatTextExchangeHandoff> {
      const model = modelOf(request.route);
      if (model === undefined) {
        throw new QwenChatRequestError(
          `The Qwen Chat route ${JSON.stringify(request.route)} is not served by this deployment`,
          "unknown_model",
        );
      }
      const entry = entryOf(model);
      if (entry === undefined) {
        throw new QwenChatRequestError(`The Qwen Chat model ${JSON.stringify(model)} is not configured`, "unknown_model");
      }
      const mode = qwenChatTurnMode(entry, request.reasoningMode);
      const key = qwenChatAffinityKey({
        affinity: request.affinity,
        dshSession: { sessionId: request.dshSession.sessionId },
        namespace: provider.namespace,
      });
      if (key === undefined) {
        throw new QwenChatRequestError("A Qwen Chat turn requires a host session identity", "missing_identity");
      }
      const recorded = state.read(key)?.chat;
      const cursor = recorded?.responseId ?? recorded?.parentId;
      const chat = recorded?.status === "active"
        ? { chatId: recorded.chatId, ...(cursor !== undefined ? { parentId: cursor } : {}) }
        : undefined;
      return exchangeFor({
        conversationKey: key,
        turnId: request.turnId,
        epoch: state.generation(key),
        turn: {
          model,
          ...(mode.mode === undefined ? {} : { mode: mode.mode }),
          ...(mode.thinkingFormat === undefined ? {} : { thinkingFormat: mode.thinkingFormat }),
          userText: request.userText,
        },
        ...(chat ? { chat } : {}),
        ephemeral: false,
        onAnswer: (answer) => {
          state.recordChat(key, {
            chatId: answer.chatId,
            ...(answer.parentId !== undefined ? { parentId: answer.parentId } : {}),
            ...(answer.responseId !== undefined ? { responseId: answer.responseId } : {}),
            ...(answer.responseIndex !== undefined ? { responseIndex: answer.responseIndex } : {}),
            status: "active",
            updatedAt: now(),
          });
        },
        onChatLost: (reason) => {
          state.markLost(key, reason);
        },
      });
    },

    /**
     * A retained-answer read is **unavailable** for this provider, and says so.
     *
     * Nothing of a conversation is retained locally (continuity is the chat id and cursor), so there
     * is no surface to read a finalized answer from. The neutral contract lets a provider omit this;
     * it is implemented explicitly so a caller gets a typed "unavailable" instead of a silent absence.
     */
    async recoverTextTurn(_request: WebChatTextRecoveryRequest): Promise<WebChatTextTurnOutcome> {
      return {
        ok: false,
        code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
        message: "Qwen Chat retains no conversation surface, so a finalized answer cannot be read back",
      };
    },
  };

  return {
    providerId: provider.providerId,
    provider,
    driver,
    runtime,
    catalogue: qwenChatCatalogueRows(provider),
    modelOf,

    resolveTurn(raw: unknown, headers: Headers): QwenChatResolvedTurn {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new QwenChatRequestError("Request body must be a JSON object");
      }
      const body = raw as Record<string, unknown>;
      const route = body["model"];
      if (typeof route !== "string" || route.trim().length === 0) {
        throw new QwenChatRequestError("`model` is required and must be a catalogue model id");
      }
      const model = modelOf(route.trim());
      if (model === undefined) {
        throw new QwenChatRequestError(
          `Unknown model ${JSON.stringify(route)}. Available models: ${qwenChatCatalogueRows(provider).map(row => row.slug).join(", ")}.`,
          "unknown_model",
        );
      }
      const entry = entryOf(model);
      if (entry === undefined) {
        throw new QwenChatRequestError(`Unknown model ${JSON.stringify(route)}.`, "unknown_model");
      }
      const mode = qwenChatTurnMode(entry, qwenChatRequestedMode(body));
      let parsed;
      try {
        parsed = parseRequest(raw);
      } catch (error) {
        throw new QwenChatRequestError(error instanceof Error ? error.message : String(error));
      }
      const messages: ApiConversationMessage[] = parsed.context.messages.map(message => ({
        role: message.role,
        content: messageText(message.content),
      }));
      // The one host reader decides who is talking and which turns are housekeeping (issue #307):
      // a native `dsh_session_id` and a declared `purpose` are read exactly as every other surface
      // reads them, and an ephemeral turn resolves to no identity at all.
      const native = nativeTurnMetadataFromBody(raw);
      const resolved = resolveNativeTurnIdentity(
        native,
        normalizeApiSessionId(body["user"]) ?? normalizeApiSessionId(body["session_id"]),
        undefined,
        declaredTurnChannels(raw, headers),
      );
      const ephemeral = isEphemeralWebChatTurn(resolved.purpose);
      const history = qwenChatReplayHistory(messages);
      // The provider-private thread the caller declared, when it declared one. The host's resolver
      // reports "the identity this turn is addressed by" (which a `dsh_session_id` rightfully wins),
      // so the *thread* is read from the field that means a thread — exactly the distinction the
      // ChatGPT native path makes between its session and its thread. A caller that named no thread
      // keeps the resolver's identity, and a caller that named nothing at all gets the content-derived
      // identity, which is never per-request (`doc/provider-onboarding.md` §2.3).
      const contentIdentity = contentConversationIdentity(messages);
      const threadId = nativeTurnMetadataString(native, "thread_id")
        ?? resolved.threadId
        ?? contentIdentity;
      let transmitted: readonly ApiConversationMessage[];
      try {
        transmitted = projectApiConversation({
          messages,
          sessionId: ephemeral
            ? contentIdentity
            : qwenChatAffinitySessionId({
              ...(resolved.dshSessionId !== undefined ? { dshSessionId: resolved.dshSessionId } : {}),
              threadId,
            }),
        }).messages;
      } catch (error) {
        if (error instanceof ApiProjectionRefusalError) {
          throw new QwenChatRequestError(error.message, error.code);
        }
        throw new QwenChatRequestError(error instanceof Error ? error.message : String(error));
      }
      const userText = currentUserText(transmitted);
      if (userText === undefined) {
        throw new QwenChatRequestError("This turn carries no user message for Qwen Chat to answer", "no_user_message");
      }
      const turnId = nativeTurnMetadataString(native, "turn_id") ?? options.newId?.() ?? crypto.randomUUID();
      return {
        route: webChatPublicRoute(provider.providerId, model),
        model,
        ...(mode.mode === undefined ? {} : { mode: mode.mode }),
        ...(mode.thinkingFormat === undefined ? {} : { thinkingFormat: mode.thinkingFormat }),
        userText,
        history,
        ...(resolved.dshSessionId !== undefined ? { dshSessionId: resolved.dshSessionId } : {}),
        threadId,
        turnId,
        ...(resolved.purpose !== undefined ? { purpose: resolved.purpose } : {}),
        ephemeral,
      };
    },

    turnEvents(turn: QwenChatResolvedTurn, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
      return turnEventsInternal(turn, signal);
    },

    async close(): Promise<void> {
      // The session page and the durable chat state are this composition's. The conversation store is
      // **not**: it belongs to the deployment (one writer per file), so the listener's own shutdown
      // releases it together with the other providers' views of the same store.
      await driver.shutdown();
      state.close?.();
    },
  };
}

/** The durable chat state, or the in-memory one when the provider directory cannot be used. */
function createDefaultState(provider: QwenChatProviderConfig): QwenChatConversationState {
  try {
    return createFileQwenChatConversationState(provider.chatStatePath);
  } catch (error) {
    console.warn(
      `[qwen-chat] conversation state is not durable ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
    );
    return createMemoryQwenChatConversationState();
  }
}

/** The provider-local descriptor the route resolves to, for diagnostics and tests. */
export function qwenChatDescriptorOf(
  provider: QwenChatProviderConfig,
  route: string,
): { readonly model: string; readonly modes: readonly QwenChatMode[] } | undefined {
  const prefix = `${provider.providerId}/`;
  if (!route.startsWith(prefix)) return undefined;
  const model = route.slice(prefix.length);
  const entry = provider.models.find(candidate => candidate.id === model);
  if (!entry) return undefined;
  return { model, modes: qwenChatEntryModes(entry) };
}

/** The default model id this provider serves, for diagnostics only. */
export function qwenChatDefaultModel(provider: QwenChatProviderConfig): string | undefined {
  return qwenChatModelDescriptors(provider)[0]?.id ?? provider.models[0]?.id;
}
