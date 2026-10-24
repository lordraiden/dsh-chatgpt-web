/**
 * The DeepSeek Web provider composition: driver + one text exchange per turn.
 *
 * ## What a turn does, end to end
 *
 * ```text
 * public route "deepseek-web/<model_type>" + the caller's text
 *         ↓  (this module: the service's catalogue already chose the route)
 * provider-local model_type, the two toggles, the current user text, turn identity, declared purpose
 *         ↓  (the core decides continuity — never this module)
 * resolveWebChatContinuation  ->  new_conversation | exact_resume | replay | failed
 *         ↓
 * beginWebChatConversationAttempt  (the record becomes unconfirmed)
 *         ↓  (the shared exchange owns readiness, submission, streaming, settlement)
 * createWebChatExchange + the DeepSeek Web transport (proof of work, chat_session/create when the
 * conversation has none, then chat/completion with chat_session_id + parent_message_id)
 *         ↓  (on a completed turn)
 * record the chat_session_id + parent_message_id, confirmWebChatConversation
 * ```
 *
 * Two rules this composition exists to keep:
 *
 * - **The provider does not decide continuity.** It states its intent from provider facts (a recorded
 *   session is a continuation; a lost one is an explicit replay from canonical history; nothing is a
 *   new conversation except a first turn) and hands the decision to the core. A refusal is a refusal.
 * - **An ephemeral turn touches nothing.** No store read, no store write, no session, no cursor: the
 *   caller's housekeeping is answered and kept nowhere (`turn-delivery.ts`).
 *
 * ## There is no reasoning-mode menu here
 *
 * Recon §2.5 records `thinking_enabled` / `search_enabled` as plain booleans and `model_type` as the
 * model selector. No named mode labels were measured, so this composition publishes none: the two
 * toggles are deployment configuration per model (`provider-config.ts`), and a caller that *selects* a
 * reasoning level gets a typed 400 instead of a silent substitution.
 *
 * Everything provider-private stays here: the session id, the cursor, the request shapes and the
 * replay prompt. No rule here enters `src/web-chat/core/**`.
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
  DEFAULT_TRANSPORT_ADMISSION_WAIT_MS,
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
import { DEEPSEEK_WEB_PROVIDER_ID, type DeepSeekMessageId } from "./provider";
import { createDeepSeekDriver, deepSeekAffinityKey } from "./driver";
import {
  createFileDeepSeekConversationState,
  createMemoryDeepSeekConversationState,
  type DeepSeekConversationState,
} from "./chat-state";
import { createDeepSeekBrowserSession, type DeepSeekRequestSession } from "./session";
import { createDeepSeekWebTextTransport, type DeepSeekTurnAnswer } from "./text-transport";
import type { DeepSeekProofOfWorkSolver } from "./network-turn";
import {
  deepSeekAccountBinding,
  deepSeekCatalogueRows,
  deepSeekCatalogueNote,
  deepSeekModelDescriptors,
  resolveDeepSeekProviderConfig,
  type DeepSeekModelType,
  type DeepSeekProviderConfig,
} from "./provider-config";

/** A request this provider cannot serve. The server maps it to a typed 400. */
export class DeepSeekWebRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "DeepSeekWebRequestError";
    if (code !== undefined) this.code = code;
  }
}

/** Everything one turn needs, resolved from a provider-neutral request body. */
export interface DeepSeekWebResolvedTurn {
  /** Public route the caller selected. */
  readonly route: string;
  /** Provider-local `model_type` sent to the provider. */
  readonly modelType: string;
  /** `thinking_enabled` for this turn. */
  readonly thinking: boolean;
  /** `search_enabled` for this turn. */
  readonly search: boolean;
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

/** The public composition the server routes `deepseek-web/<model_type>` requests to. */
export interface DeepSeekWebProviderComposition {
  readonly providerId: string;
  readonly provider: DeepSeekProviderConfig;
  readonly driver: WebChatProviderDriver;
  readonly runtime: WebChatProviderRuntime;
  /** The public catalogue rows (`providerId/model_type`) this deployment serves. */
  readonly catalogue: readonly Record<string, unknown>[];
  /** The provider-local model_type of a public route this deployment serves, or `undefined`. */
  modelOf(route: string): string | undefined;
  /** Resolve the provider-neutral body into this provider's turn. Throws `DeepSeekWebRequestError`. */
  resolveTurn(raw: unknown, headers: Headers): DeepSeekWebResolvedTurn;
  /** The normalized adapter events of one turn, for the shared Responses/chat-completions shaping. */
  turnEvents(turn: DeepSeekWebResolvedTurn, signal?: AbortSignal): AsyncIterable<AdapterEvent>;
  /** Release the session page and the durable state. Idempotent. */
  close(): Promise<void>;
}

/** Construction options for {@link createDeepSeekWebProvider}. */
export interface DeepSeekWebProviderOptions {
  /** The deployment configuration. */
  readonly config: AppConfig;
  /** Resolved provider facts; derived from `config` when omitted. */
  readonly provider?: DeepSeekProviderConfig;
  /** Durable continuity store; the deployment's shared one when omitted. */
  readonly store?: WebChatConversationStore;
  /** Session state; the durable one under the provider directory when omitted. */
  readonly state?: DeepSeekConversationState;
  /** Session page seam (tests); the real Chromium-backed session when omitted. */
  readonly session?: DeepSeekRequestSession;
  /** The proof-of-work solver. Defaults to the page's own worker. */
  readonly proofOfWork?: DeepSeekProofOfWorkSolver;
  /** The `Authorization` reader. Defaults to the page's own `localStorage["userToken"]` at call time. */
  readonly authorization?: () => Promise<string | undefined>;
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
export function deepSeekWebReplayHistory(messages: readonly ApiConversationMessage[]): readonly WebChatReplayMessage[] {
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
 * A replay creates a **new** session, so the rebuilt conversation has to arrive as text: `User:` /
 * `Assistant:` lines, the same convention the other providers' compilers use, built only from the
 * canonical messages the caller sent (never from provider state and never from a stored transcript).
 */
export function compileDeepSeekWebReplayPrompt(history: readonly WebChatReplayMessage[]): string {
  const lines: string[] = [];
  for (const message of history) {
    if (message.text.trim().length === 0) continue;
    const label = message.role === "assistant"
      ? "Assistant"
      : message.role === "user"
        ? "User"
        : message.role === "system"
          ? "System"
          : "Developer";
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
 * It is read only in order to **refuse** it: this provider exposes no measured reasoning levels, so a
 * selection is answered with a typed 400 that says exactly that.
 */
export function deepSeekWebRequestedReasoning(body: Record<string, unknown>): string | undefined {
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
export function deepSeekWebAffinitySessionId(identity: {
  readonly dshSessionId?: string;
  readonly threadId: string;
}): string {
  return identity.dshSessionId !== undefined && identity.dshSessionId.length > 0
    ? identity.dshSessionId
    : identity.threadId;
}

/**
 * Create the DeepSeek Web provider composition.
 *
 * @param options - the deployment configuration and the injectable seams.
 * @returns the driver, the provider runtime seam, the catalogue rows and the turn runner.
 */
export function createDeepSeekWebProvider(options: DeepSeekWebProviderOptions): DeepSeekWebProviderComposition {
  const provider = options.provider ?? resolveDeepSeekProviderConfig(options.config);
  const now = options.now ?? Date.now;
  // The deployment's one conversation store. The host owns the registry: every provider composes the
  // same instance, and the durable backend allows exactly one writer per file.
  const store = options.store ?? resolveSharedConversationStore({
    ...(options.config.webChat !== undefined ? { webChat: options.config.webChat } : {}),
  });
  const state = options.state ?? createDefaultState(provider);
  const session: DeepSeekRequestSession = options.session ?? createDeepSeekBrowserSession({
    provider,
    ...(options.proofOfWork === undefined ? {} : { proofOfWork: options.proofOfWork }),
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // The shared transport leases plus the serialising admission (issue #336): a transient overlap on
  // one conversation waits for the current turn instead of failing the arriving one.
  const leases: WebChatTransportLeaseRegistry = createWebChatTransportLeaseRegistry({
    admissionWaitMs: DEFAULT_TRANSPORT_ADMISSION_WAIT_MS,
  });
  /** A unique holder identity per turn, so a repeated turn id cannot admit two distinct turns. */
  const newAdmissionHolder = (): string => crypto.randomUUID();
  const binding: WebChatAccountBinding = deepSeekAccountBinding(provider);
  const driver = createDeepSeekDriver({
    provider,
    state,
    release: async () => { await session.close(); },
  });

  /**
   * The local model_type of a route this provider owns.
   *
   * The **prefix** is claimed even when no model_type is configured, so a caller that asks this
   * provider for a model it does not serve gets this provider's honest typed error instead of being
   * forwarded to an unrelated backend. Serving an exact model still requires it to be configured.
   */
  const modelOf = (route: string): string | undefined => {
    const prefix = `${provider.providerId}/`;
    if (!route.startsWith(prefix)) return undefined;
    const local = route.slice(prefix.length);
    return local.length > 0 ? local : undefined;
  };

  /** The catalogue entry of a provider-local model_type. */
  const entryOf = (modelType: string): DeepSeekModelType | undefined =>
    provider.modelTypes.find(candidate => candidate.id === modelType);

  /** The typed refusal for a route this deployment does not serve. */
  const notServed = (route: string): DeepSeekWebRequestError => {
    if (provider.modelTypes.length === 0) {
      return new DeepSeekWebRequestError(
        `DeepSeek serves no route on this deployment, so ${JSON.stringify(route)} cannot be answered. `
        + 'webChat.providers["deepseek-web"].modelTypes was configured as an empty list; remove the '
        + 'entry to serve the measured default row (`default`), or list the model_type values a '
        + "signed-in capture shows. DeepSeek's model list is only available to a signed-in session, so "
        + "this service never discovers it, and the bundle's deep-link prefill literal is not a catalogue.",
        "not_configured",
      );
    }
    return new DeepSeekWebRequestError(
      `Unknown model ${JSON.stringify(route)}. Available models: `
      + `${deepSeekCatalogueRows(provider).map(row => row.slug).join(", ")}.`,
      "unknown_model",
    );
  };

  /**
   * Open the shared exchange for one conversation state.
   *
   * `chat` is the recorded session of a continuation, or `undefined` when this turn must create one or
   * must not have one (ephemeral). Nothing else varies: the transport always speaks the same protocol.
   */
  const exchangeFor = (input: {
    readonly conversationKey: string;
    readonly turnId: string;
    readonly epoch: number;
    readonly turn: {
      readonly modelType: string;
      readonly thinking: boolean;
      readonly search: boolean;
      readonly userText: string;
    };
    readonly chat?: { readonly chatSessionId: string; readonly parentMessageId?: DeepSeekMessageId };
    readonly ephemeral: boolean;
    readonly onAnswer?: (answer: DeepSeekTurnAnswer) => Promise<void> | void;
    readonly onChatLost?: (reason: string) => Promise<void> | void;
  }): WebChatTextExchangeHandoff => {
    const transport: WebChatTextTransport = createDeepSeekWebTextTransport({
      session,
      modelType: input.turn.modelType,
      thinking: input.turn.thinking,
      search: input.turn.search,
      ...(input.chat ? { chat: input.chat } : {}),
      ephemeral: input.ephemeral,
      ...(input.onAnswer ? { onAnswer: input.onAnswer } : {}),
      ...(input.onChatLost ? { onChatLost: input.onChatLost } : {}),
      ...(options.proofOfWork === undefined ? {} : { proofOfWork: options.proofOfWork }),
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
      turn: { userText: input.turn.userText, model: input.turn.modelType },
      epoch: input.epoch,
      leases,
      createResource: async () => ({
        id: `${input.conversationKey}:${input.epoch}`,
        conversationKey: input.conversationKey,
        epoch: input.epoch,
      }),
    };
  };

  /**
   * The continuity scope of one turn: who it is addressed by, before any store read.
   *
   * Computed before the continuity decision because the shared transport's admission slot is taken on
   * this identity's conversation key, so a transient overlap is serialised *before* the decision and a
   * waiting turn never reads (or writes) a half-observed conversation.
   */
  const continuityScopeOf = (turn: DeepSeekWebResolvedTurn) => ({
    binding,
    dshSession: { sessionId: deepSeekWebAffinitySessionId(turn) },
    threadId: turn.threadId,
    namespace: provider.namespace,
  });

  /** The continuity decision of one conversational turn, and the session it will use. */
  const decideContinuity = async (
    turn: DeepSeekWebResolvedTurn,
    scope: ReturnType<typeof continuityScopeOf>,
    identity: WebChatConversationIdentity,
  ): Promise<{
    readonly identity: WebChatConversationIdentity;
    readonly conversation: WebChatConversation;
    readonly chat?: { readonly chatSessionId: string; readonly parentMessageId?: DeepSeekMessageId };
    readonly replay: boolean;
  }> => {
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
      // from provider state which message the session actually holds. The honest recovery is an
      // **explicit** replay from canonical history, which advances the generation and is recorded as
      // such.
      intent = {
        kind: "replay",
        expectedGeneration: stored.generation,
        reason: "the last attempt on this conversation was never confirmed and the provider cannot reconcile it; it is rebuilt explicitly from canonical host history",
        history: turn.history,
      };
    } else if (entry?.session?.status === "active") {
      intent = { kind: "continue" };
    } else if (turn.history.length > 0) {
      intent = {
        kind: "replay",
        expectedGeneration: stored.generation,
        reason: entry?.session?.status === "lost"
          ? "the provider no longer accepts this conversation's chat session; it is rebuilt from canonical host history"
          : "the provider has no chat session recorded for this conversation; it is rebuilt from canonical host history",
        history: turn.history,
      };
    } else {
      // Nothing canonical to rebuild from: keep the core's honest refusal instead of forking.
      intent = { kind: "continue" };
    }
    const plan = await resolveWebChatContinuation(
      { store, driver },
      { ...scope, model: turn.route, intent },
    );
    if (plan.outcome === "failed" || !plan.conversation || !plan.record) {
      throw plan.error ?? webChatError(
        "CONVERSATION_STATE_MISMATCH",
        "The WebChat Core refused continuity for this DeepSeek Web turn",
      );
    }
    const recorded = state.read(identity.key)?.session;
    const cursor = recorded?.responseMessageId ?? recorded?.parentMessageId;
    const chat = plan.outcome === "replay"
      ? undefined
      // A continued or adopted conversation reuses the provider session; anything else creates one.
      : recorded?.status === "active"
        ? { chatSessionId: recorded.chatSessionId, ...(cursor !== undefined ? { parentMessageId: cursor } : {}) }
        : undefined;
    return { identity, conversation: plan.conversation, ...(chat ? { chat } : {}), replay: plan.outcome === "replay" };
  };

  /**
   * Run one exchange and translate it to the adapter's normalized event vocabulary.
   *
   * The exchange is the shared implementation (`createWebChatExchange`); this function only reports
   * its outcome in the vocabulary the Responses bridge already consumes.
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
      message: "The DeepSeek Web turn was cancelled",
    });
    /** Whether the turn reached its own terminal event (a completion or an explicit failure). */
    let terminal = false;
    try {
      try {
        await exchange.prepare();
      } catch (error) {
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
        // what publishes the physical settlement and releases the conversation's lease.
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
        yield exchange.snapshot().cancelRequested ? cancelled() : failureOf(error);
        return;
      }
      if (!terminal) {
        // The runner already settled the exchange logically; a stream that ends without a terminal
        // event is an incomplete answer, never a completed one.
        yield exchange.snapshot().cancelRequested
          ? cancelled()
          : {
            type: "incomplete",
            reason: "stream_ended",
            message: "The DeepSeek Web stream ended without a terminal event",
          };
      }
    } finally {
      if (!terminal) {
        // The consumer stopped reading before the turn ended. The provider turn must be aborted — not
        // left producing into a stream nobody reads — and that also publishes settlement.
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
    turn: DeepSeekWebResolvedTurn,
    signal?: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const turnInput = {
      modelType: turn.modelType,
      thinking: turn.thinking,
      search: turn.search,
      userText: turn.userText,
    };
    if (turn.ephemeral) {
      // Housekeeping: no store read, no store write, no session, no cursor. The conversation key is
      // turn-scoped so it can never collide with, or be adopted as, the caller's conversation.
      const handoff = exchangeFor({
        conversationKey: `deepseek-web-ephemeral:${turn.turnId}`,
        turnId: turn.turnId,
        epoch: 1,
        turn: turnInput,
        ephemeral: true,
      });
      yield* runExchange(handoff, signal, async () => undefined);
      return;
    }
    const scope = continuityScopeOf(turn);
    const identity = webChatContinuationIdentity(scope);
    const admissionHolder = newAdmissionHolder();
    // Admission first: a transient overlap with a housekeeping call on the same conversation waits
    // here instead of failing this turn, and the continuity decision below therefore never reads a
    // half-observed record.
    try {
      await leases.admitConversation({
        holder: admissionHolder,
        conversationKey: identity.key,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      yield failureOf(error);
      return;
    }
    try {
      let planned: Awaited<ReturnType<typeof decideContinuity>>;
      try {
        planned = await decideContinuity(turn, scope, identity);
      } catch (error) {
        yield failureOf(error);
        return;
      }
      const { conversation } = planned;
      const generation = conversation.generation;
      let attempt;
      try {
        attempt = await beginWebChatConversationAttempt(store, identity, { generation });
      } catch (error) {
        yield failureOf(error);
        return;
      }
      const prompt = planned.replay ? compileDeepSeekWebReplayPrompt(turn.history) : turn.userText;
      const handoff = exchangeFor({
        conversationKey: identity.key,
        turnId: turn.turnId,
        epoch: generation,
        turn: { ...turnInput, userText: prompt.length > 0 ? prompt : turn.userText },
        ...(planned.chat ? { chat: planned.chat } : {}),
        ephemeral: false,
        onAnswer: (answer) => {
          // The provider's own continuation state: the session and the cursor the next turn hangs off.
          state.recordSession(identity.key, {
            chatSessionId: answer.chatSessionId,
            ...(answer.parentMessageId !== undefined ? { parentMessageId: answer.parentMessageId } : {}),
            ...(answer.responseMessageId !== undefined ? { responseMessageId: answer.responseMessageId } : {}),
            ...(answer.modelType !== undefined ? { modelType: answer.modelType } : {}),
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
            `[deepseek-web] deepseek_web_turn_confirm_failed ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
          );
        }
      });
    } finally {
      // Released on every exit path — success, failure, cancellation, and a consumer that stops
      // reading (leaving the generator runs this `finally`).
      leases.releaseConversation(admissionHolder, identity.key);
    }
  }

  const runtime: WebChatProviderRuntime = {
    driver,
    providerLabel: "DeepSeek Web",

    /**
     * Open one exchange for an already-selected route (the neutral in-process seam).
     *
     * It resolves the route, the model_type and the affiliation's recorded session and hands the host
     * a transport plus the semantic turn; the caller that owns durable continuity (the API ingress)
     * uses {@link DeepSeekWebProviderComposition.turnEvents} instead, which also records the session
     * and confirms the turn.
     */
    async openTextExchange(request: WebChatTextTurnRequest): Promise<WebChatTextExchangeHandoff> {
      const modelType = modelOf(request.route);
      if (modelType === undefined) {
        throw new DeepSeekWebRequestError(
          `The DeepSeek Web route ${JSON.stringify(request.route)} is not served by this deployment`,
          "unknown_model",
        );
      }
      const entry = entryOf(modelType);
      if (entry === undefined) throw notServed(request.route);
      const key = deepSeekAffinityKey({
        affinity: request.affinity,
        dshSession: { sessionId: request.dshSession.sessionId },
        namespace: provider.namespace,
      });
      if (key === undefined) {
        throw new DeepSeekWebRequestError("A DeepSeek Web turn requires a host session identity", "missing_identity");
      }
      const recorded = state.read(key)?.session;
      const cursor = recorded?.responseMessageId ?? recorded?.parentMessageId;
      const chat = recorded?.status === "active"
        ? {
          chatSessionId: recorded.chatSessionId,
          ...(cursor !== undefined ? { parentMessageId: cursor } : {}),
        }
        : undefined;
      return exchangeFor({
        conversationKey: key,
        turnId: request.turnId,
        epoch: state.generation(key),
        turn: { modelType, thinking: entry.thinking, search: entry.search, userText: request.userText },
        ...(chat ? { chat } : {}),
        ephemeral: false,
        onAnswer: (answer) => {
          state.recordSession(key, {
            chatSessionId: answer.chatSessionId,
            ...(answer.parentMessageId !== undefined ? { parentMessageId: answer.parentMessageId } : {}),
            ...(answer.responseMessageId !== undefined ? { responseMessageId: answer.responseMessageId } : {}),
            ...(answer.modelType !== undefined ? { modelType: answer.modelType } : {}),
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
     * Nothing of a conversation is retained locally (continuity is the session id and cursor), so
     * there is no surface to read a finalized answer from. The neutral contract lets a provider omit
     * this; it is implemented explicitly so a caller gets a typed "unavailable" instead of a silent
     * absence.
     */
    async recoverTextTurn(_request: WebChatTextRecoveryRequest): Promise<WebChatTextTurnOutcome> {
      return {
        ok: false,
        code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
        message: "DeepSeek Web retains no conversation surface, so a finalized answer cannot be read back",
      };
    },
  };

  return {
    providerId: provider.providerId,
    provider,
    driver,
    runtime,
    catalogue: deepSeekCatalogueRows(provider),
    modelOf,

    resolveTurn(raw: unknown, headers: Headers): DeepSeekWebResolvedTurn {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new DeepSeekWebRequestError("Request body must be a JSON object");
      }
      const body = raw as Record<string, unknown>;
      const route = body["model"];
      if (typeof route !== "string" || route.trim().length === 0) {
        throw new DeepSeekWebRequestError("`model` is required and must be a catalogue model id");
      }
      const modelType = modelOf(route.trim());
      if (modelType === undefined) {
        throw new DeepSeekWebRequestError(
          `Unknown model ${JSON.stringify(route)}. Available models: `
          + `${deepSeekCatalogueRows(provider).map(row => row.slug).join(", ") || "none"}.`,
          "unknown_model",
        );
      }
      const entry = entryOf(modelType);
      if (entry === undefined) throw notServed(route.trim());
      const reasoning = deepSeekWebRequestedReasoning(body);
      if (reasoning !== undefined) {
        // No named reasoning levels were measured for this provider: `thinking_enabled` is a boolean
        // toggle set per model by the deployment, not a caller-selectable menu.
        throw new DeepSeekWebRequestError(
          `DeepSeek Web does not offer selectable reasoning levels (requested ${JSON.stringify(reasoning)}). `
          + "Its thinking option is the boolean `thinking_enabled` the deployment configures per "
          + "model_type; remove the reasoning selection to send the turn.",
          "unknown_reasoning_mode",
        );
      }
      let parsed;
      try {
        parsed = parseRequest(raw);
      } catch (error) {
        throw new DeepSeekWebRequestError(error instanceof Error ? error.message : String(error));
      }
      const messages: ApiConversationMessage[] = parsed.context.messages.map(message => ({
        role: message.role,
        content: messageText(message.content),
      }));
      // The one host reader decides who is talking and which turns are housekeeping (issue #307).
      const native = nativeTurnMetadataFromBody(raw);
      const resolved = resolveNativeTurnIdentity(
        native,
        normalizeApiSessionId(body["user"]) ?? normalizeApiSessionId(body["session_id"]),
        undefined,
        declaredTurnChannels(raw, headers),
      );
      const ephemeral = isEphemeralWebChatTurn(resolved.purpose);
      const history = deepSeekWebReplayHistory(messages);
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
            : deepSeekWebAffinitySessionId({
              ...(resolved.dshSessionId !== undefined ? { dshSessionId: resolved.dshSessionId } : {}),
              threadId,
            }),
        }).messages;
      } catch (error) {
        if (error instanceof ApiProjectionRefusalError) {
          throw new DeepSeekWebRequestError(error.message, error.code);
        }
        throw new DeepSeekWebRequestError(error instanceof Error ? error.message : String(error));
      }
      const userText = currentUserText(transmitted);
      if (userText === undefined) {
        throw new DeepSeekWebRequestError("This turn carries no user message for DeepSeek to answer", "no_user_message");
      }
      const turnId = nativeTurnMetadataString(native, "turn_id") ?? options.newId?.() ?? crypto.randomUUID();
      return {
        route: webChatPublicRoute(provider.providerId, modelType),
        modelType,
        thinking: entry.thinking,
        search: entry.search,
        userText,
        history,
        ...(resolved.dshSessionId !== undefined ? { dshSessionId: resolved.dshSessionId } : {}),
        threadId,
        turnId,
        ...(resolved.purpose !== undefined ? { purpose: resolved.purpose } : {}),
        ephemeral,
      };
    },

    turnEvents(turn: DeepSeekWebResolvedTurn, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
      return turnEventsInternal(turn, signal);
    },

    async close(): Promise<void> {
      // The session page and the durable session state are this composition's. The conversation store
      // is **not**: it belongs to the deployment (one writer per file), so the listener's own shutdown
      // releases it together with the other providers' views of the same store. Closing the leases
      // refuses any admission still waiting instead of leaving it to its bound.
      leases.close();
      await driver.shutdown();
      state.close?.();
    },
  };
}

/** The durable session state, or the in-memory one when the provider directory cannot be used. */
function createDefaultState(provider: DeepSeekProviderConfig): DeepSeekConversationState {
  try {
    return createFileDeepSeekConversationState(provider.chatStatePath);
  } catch (error) {
    console.warn(
      `[deepseek-web] conversation state is not durable ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
    );
    return createMemoryDeepSeekConversationState();
  }
}

/**
 * The one-line explanation this deployment's startup logs when a DeepSeek block exists but publishes no
 * rows. Kept here so "no rows" is never a silent absence.
 */
export function deepSeekWebCatalogueExplanation(config: AppConfig): string | undefined {
  const configured = config.webChat?.providers?.[DEEPSEEK_WEB_PROVIDER_ID] !== undefined;
  if (!configured) return undefined;
  const note = deepSeekCatalogueNote(config);
  return note;
}

/** The provider-local descriptor the route resolves to, for diagnostics and tests. */
export function deepSeekWebDescriptorOf(
  provider: DeepSeekProviderConfig,
  route: string,
): { readonly modelType: string; readonly thinking: boolean; readonly search: boolean } | undefined {
  const prefix = `${provider.providerId}/`;
  if (!route.startsWith(prefix)) return undefined;
  const modelType = route.slice(prefix.length);
  const entry = provider.modelTypes.find(candidate => candidate.id === modelType);
  if (!entry) return undefined;
  return { modelType, thinking: entry.thinking, search: entry.search };
}

/** The default model_type this provider serves, for diagnostics only. */
export function deepSeekWebDefaultModel(provider: DeepSeekProviderConfig): string | undefined {
  return deepSeekModelDescriptors(provider)[0]?.id ?? provider.modelTypes[0]?.id;
}
