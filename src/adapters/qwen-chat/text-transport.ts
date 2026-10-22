/**
 * The Qwen Chat text transport: one turn of the measured protocol.
 *
 * ```text
 * POST /api/v2/chats/new                                 -> { success, request_id, data: { id } }
 * POST /api/v2/chat/completions?chat_id=<id>              -> text/event-stream
 *        {"response.created":{chat_id,parent_id,response_id,response_index}}
 *        {"choices":[{"delta":{role,content,phase,status}}],"response_id",…}
 *        {"selected_model_id":"…","choices":[{"delta":{"role"}}],"response_id"}
 *        {"response.stopped":{"response_id}}
 *        data: [DONE]
 * ```
 *
 * ## What this transport owns, and what it must not own
 *
 * It owns: readiness (the session's, before anything is sent), the provider's admission of the
 * submission, the normalized event vocabulary, and physical settlement. It does **not** own retry
 * policy, conversation identity, ephemeral classification or continuity persistence — the exchange
 * decides retry safety, the runtime decides continuity, and the core owns "what makes a turn
 * ephemeral".
 *
 * ## The mode travels per message
 *
 * The caller-selected mode is passed to {@link qwenChatCompletionRequest}, which writes it into
 * `messages[0].feature_config` as the literal label plus the two derived booleans (recon §1.5). It is
 * **not** a top-level body key and not `chat_mode`; those are different fields.
 *
 * ## Continuity and the ephemeral rule
 *
 * A conversational turn continues the chat its conversation already recorded, and creates one (with
 * `chats/new`) only when the conversation has none. The chat id and the **response cursor** the turn
 * ended on are handed back through {@link QwenChatTextTransportOptions.onAnswer} so the runtime can
 * persist them.
 *
 * An **ephemeral** turn (the caller declared a housekeeping `purpose`) must leave the operator's
 * account untouched: it sends **no** `chats/new` and records nothing, so no chat of the caller's
 * conversation is created, continued or claimed. It streams its answer into a chat id this process
 * generated, which is the only way this protocol can answer without creating a chat — and whether
 * the provider accepts a chat id it did not create is **not measured** (recon §1.9). If it refuses,
 * the turn fails with the provider's own typed category; it never falls back to creating a chat,
 * because that is exactly the bug this rule exists to prevent.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  isWebChatError,
  webChatError,
  type WebChatError,
  type WebChatExchangeEvent,
  type WebChatPhysicalSettlement,
} from "../../web-chat/core";
import type { WebChatTextTransport, WebChatTextTransportContext } from "../../web-chat/transport";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import type { QwenChatRequestSession } from "./browser-session";
import {
  QWEN_CHAT_CHATS_NEW_PATH,
  QWEN_CHAT_PROVIDER_ID,
  type QwenChatMode,
} from "./provider";
import {
  qwenChatChatNewRequest,
  qwenChatCompletionPath,
  qwenChatCompletionRequest,
  qwenChatRefusal,
  qwenChatTransportFailure,
  readQwenChatCreatedChatId,
  type QwenChatTurnRequestFacility,
} from "./network-turn";
import {
  QwenChatSseParser,
  createQwenChatCompletionAccumulator,
  type QwenChatCompletionResult,
  type QwenChatSseFrame,
} from "./sse";

/**
 * How long a turn may run end to end.
 *
 * The same 15-minute ceiling the ChatGPT browser turn and the Qwen Code turn apply, enforced here by
 * cancelling the exchange (so settlement is published) instead of leaving a stream open forever.
 */
export const QWEN_CHAT_TURN_TIMEOUT_MS = 15 * 60_000;

/**
 * How long physical settlement may wait for the turn's own network work to end.
 *
 * Settlement is the provider's promise that nothing of this turn can still produce output. The only
 * physical object is the page request, so it ends with it; if it does not end within this bound, the
 * session page is torn down (which provably ends every stream in it) and the resource is reported
 * settled rather than left `pending` forever.
 */
export const QWEN_CHAT_SETTLE_TIMEOUT_MS = 5_000;

/** What a completed Qwen Chat turn established, for the runtime to persist. */
export interface QwenChatTurnAnswer {
  readonly chatId: string;
  /** The cursor the **next** turn hangs off (`response_id`, falling back to `parent_id`). */
  readonly parentId?: string;
  /** The response id, kept separately for diagnosis and as the preferred cursor. */
  readonly responseId?: string;
  /** The response index the stream announced, when it did. */
  readonly responseIndex?: number;
  readonly text: string;
  readonly termination: QwenChatCompletionResult["termination"];
  /** The `status` that closed the turn, when `delta_status` ended it. */
  readonly terminalStatus?: string;
  /** The model the server actually used, when it re-routed the turn. */
  readonly selectedModelId?: string;
  readonly sources: boolean;
  readonly frames: number;
  readonly elapsedMs: number;
  /** Whether the turn was ephemeral (answered, kept nowhere). */
  readonly ephemeral: boolean;
}

/** One non-secret diagnostic line this transport emits. */
export interface QwenChatTurnDiagnostic {
  /** A named turn stage. Never a token, cookie, prompt or chat id. */
  readonly stage:
    | "ready"
    | "chat-reused"
    | "chat-created"
    | "ephemeral"
    | "submitted"
    | "streaming"
    | "model-rerouted"
    | "completed"
    | "failed"
    | "cancelled";
  /** Short digest of the chat, when one is involved. Never the id itself. */
  readonly chatDigest?: string;
  /** Which termination signal fired, on `completed`. */
  readonly termination?: QwenChatCompletionResult["termination"];
  /** The requested and selected model ids on `model-rerouted` (model ids are not secrets). */
  readonly requestedModel?: string;
  readonly selectedModel?: string;
  readonly frames?: number;
  readonly chars?: number;
  readonly elapsedMs?: number;
  readonly ephemeral?: boolean;
  /** The typed failure category, on `failed`. */
  readonly category?: string;
  /** The provider's own code, on `failed`. */
  readonly providerCode?: string;
}

/** Construction options for {@link createQwenChatTextTransport}. */
export interface QwenChatTextTransportOptions {
  /** The session that holds the authenticated page. */
  readonly session: QwenChatRequestSession;
  /** Provider-local model id sent in both bodies. */
  readonly model: string;
  /** The mode this turn sends in `feature_config`; omitted for a model that hides the selection. */
  readonly mode?: QwenChatMode;
  /** `info.meta.thinking_format` of the model, when it published one. */
  readonly thinkingFormat?: string;
  /** The recorded chat of this conversation, when it has one. */
  readonly chat?: { readonly chatId: string; readonly parentId?: string };
  /**
   * Answer without creating, continuing or recording any provider conversation.
   *
   * The caller's housekeeping work: no `chats/new`, no recorded chat, no cursor.
   */
  readonly ephemeral?: boolean;
  /** Called once on a completed conversational turn, with the chat and cursor to persist. */
  readonly onAnswer?: (answer: QwenChatTurnAnswer) => Promise<void> | void;
  /** Called when the provider proved the recorded chat id is gone, before the turn fails. */
  readonly onChatLost?: (reason: string) => Promise<void> | void;
  /** Diagnostic sink. Defaults to one structured log line per event. */
  readonly onDiagnostic?: (event: QwenChatTurnDiagnostic) => void;
  /** Clock seam. */
  readonly now?: () => number;
  /** Id seam (client-generated message/assistant ids, and the ephemeral chat id). */
  readonly newId?: () => string;
  /** The turn's own ceiling. Defaults to {@link QWEN_CHAT_TURN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Settlement bound. Defaults to {@link QWEN_CHAT_SETTLE_TIMEOUT_MS}. */
  readonly settleTimeoutMs?: number;
}

/** A chat id's short diagnostic digest: enough to correlate two log lines, useless as a lookup key. */
export function qwenChatChatDigest(chatId: string): string {
  return createHash("sha256").update(chatId).digest("hex").slice(0, 12);
}

/**
 * A deferred: one promise plus its resolvers.
 *
 * Used for the two boundaries the transport must report precisely — "the chat exists" and "the
 * provider's response head arrived" — without turning either into a poll.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // A settlement that is observed by nobody yet must not become an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** The minimal single-consumer channel the transport streams through. */
function createEventChannel<T>() {
  const items: T[] = [];
  let waiting: (() => void) | undefined;
  let finished = false;
  const wake = (): void => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.();
  };
  return {
    push(item: T): void {
      if (finished) return;
      items.push(item);
      wake();
    },
    finish(): void {
      finished = true;
      wake();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const item = items.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (finished) return;
        await new Promise<void>(resolve => { waiting = resolve; });
      }
    },
  };
}

/** The default diagnostic sink: one structured, credential-free line per stage. */
function defaultDiagnostic(event: QwenChatTurnDiagnostic): void {
  console.info(`[qwen-chat] qwen_chat_turn ${JSON.stringify({ provider: QWEN_CHAT_PROVIDER_ID, ...event })}`);
}

/**
 * One turn's transport.
 *
 * The class is per exchange: `submit` starts the provider work and reports the phase it proved;
 * `stream` yields the normalized events; `settle` reports the physical settlement. Nothing here
 * retries, and nothing here decides whether a turn belongs to a conversation.
 */
class QwenChatTextTransport implements WebChatTextTransport {
  readonly id = "qwen-chat-network";

  readonly #options: QwenChatTextTransportOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #diagnose: (event: QwenChatTurnDiagnostic) => void;
  readonly #channel = createEventChannel<WebChatExchangeEvent>();
  readonly #abort = new AbortController();
  readonly #opened = deferred<void>();
  /** Resolves when the turn is decided: the chat exists (or is unnecessary). */
  readonly #prepared = deferred<void>();

  #turn: Promise<void> | undefined;
  #epoch = 0;
  #chatId: string | undefined;
  #parentId: string | undefined;
  #continuedChat = false;
  /**
   * The frame vocabulary and its rules.
   *
   * `onDelta` is how the answer streams out: which frames count as the model's answer (KeepAlive and
   * function-role exclusion) stays owned by `sse.ts`, so nothing here reimplements it.
   */
  readonly #accumulator = createQwenChatCompletionAccumulator({
    onDelta: (text) => this.#channel.push({ type: "text_delta", epoch: this.#epoch, text }),
  });
  readonly #parser = new QwenChatSseParser();
  #startedAt = 0;
  #started = false;
  #terminal = false;

  constructor(options: QwenChatTextTransportOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#diagnose = options.onDiagnostic ?? defaultDiagnostic;
    this.#chatId = options.chat?.chatId;
    this.#parentId = options.chat?.parentId;
    this.#continuedChat = options.chat?.chatId !== undefined;
  }

  /** Feed frames to the vocabulary. `onDelta` publishes the answer as it arrives. */
  #consume(frames: readonly QwenChatSseFrame[]): void {
    for (const frame of frames) {
      if (this.#accumulator.push(frame)) return;
    }
  }

  async ready(context: WebChatTextTransportContext): Promise<void> {
    if (context.signal.aborted) throw this.#cancelled();
    await this.#options.session.ready();
    this.#diagnose({ stage: "ready" });
  }

  async submit(context: WebChatTextTransportContext): Promise<"prepared" | "send_activated" | "accepted"> {
    if (this.#started) throw webChatError("CONVERSATION_STATE_MISMATCH", "This Qwen Chat transport already submitted its turn");
    this.#started = true;
    this.#epoch = context.epoch;
    this.#startedAt = this.#now();
    const ephemeral = this.#options.ephemeral === true;
    if (context.signal.aborted) throw this.#cancelled();
    context.signal.addEventListener("abort", () => {
      this.#abort.abort(context.signal.reason);
    }, { once: true });
    // The turn's own ceiling: an explicit bound enforced by cancelling the exchange (which publishes
    // settlement) instead of abandoning a stream.
    const timeout = setTimeout(() => {
      this.#abort.abort(webChatError("RESPONSE_TIMEOUT", "The Qwen Chat turn exceeded its time ceiling", {
        providerId: QWEN_CHAT_PROVIDER_ID,
        providerCode: "QWEN_CHAT_TURN_TIMEOUT",
      }));
    }, this.#options.timeoutMs ?? QWEN_CHAT_TURN_TIMEOUT_MS);
    timeout.unref?.();
    this.#abort.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });

    this.#turn = this.#options.session.run(facility => this.#execute(facility, context, ephemeral));
    this.#turn.catch(() => undefined);

    // Phase 1: the chat. A failure here proved nothing reached the caller's chat, so the turn is
    // retry-safe and is reported as `prepared` — never as a thrown ambiguity.
    try {
      await this.#prepared.promise;
    } catch (error) {
      await this.#settleTurn();
      if (this.#preparedFailureIsPreSubmission(error)) return "prepared";
      throw error;
    }
    // Phase 2: the provider's response head. A failure here means the request may have reached the
    // provider, so it is ambiguous by construction: throw and let the exchange fail closed.
    await this.#opened.promise;
    this.#diagnose({
      stage: "submitted",
      ...(this.#chatId !== undefined ? { chatDigest: qwenChatChatDigest(this.#chatId) } : {}),
      elapsedMs: this.#now() - this.#startedAt,
      ephemeral,
    });
    return "accepted";
  }

  /**
   * Whether a prepared-phase failure provably happened before anything was sent.
   *
   * Only a failure while *deciding the chat* qualifies: `chats/new` is not the caller's message, so a
   * refused or unreachable chat creation left the caller's turn unsent. Everything after it (the
   * completion request) may have reached the provider.
   */
  #preparedFailureIsPreSubmission(error: unknown): boolean {
    if (isWebChatError(error)) {
      return error.category === "AUTH_REQUIRED" || error.category === "UPSTREAM_ERROR" || error.category === "TRANSPORT_UNAVAILABLE";
    }
    return true;
  }

  /** The turn itself: decide the chat, then stream the completion. */
  async #execute(
    facility: QwenChatTurnRequestFacility,
    context: WebChatTextTransportContext,
    ephemeral: boolean,
  ): Promise<void> {
    try {
      const chatId = await this.#resolveChat(facility, ephemeral);
      this.#chatId = chatId;
      this.#prepared.resolve();
      const timestampSeconds = Math.floor(this.#startedAt / 1_000);
      const completion = qwenChatCompletionRequest({
        chatId,
        prompt: context.turn.userText,
        model: this.#options.model,
        ...(this.#options.mode === undefined ? {} : { mode: this.#options.mode }),
        ...(this.#options.thinkingFormat === undefined ? {} : { thinkingFormat: this.#options.thinkingFormat }),
        timestampSeconds,
        messageId: this.#newId(),
        assistantId: this.#newId(),
        ...(this.#parentId !== undefined ? { parentId: this.#parentId } : {}),
      });
      const streaming = (): void => {
        if (this.#terminal) return;
        this.#diagnose({
          stage: "streaming",
          ...(this.#chatId !== undefined ? { chatDigest: qwenChatChatDigest(this.#chatId) } : {}),
          elapsedMs: this.#now() - this.#startedAt,
        });
      };
      let sawChunk = false;
      let result;
      try {
        result = await facility.postEventStream(
          qwenChatCompletionPath(chatId),
          completion.body,
          chunk => {
            if (!sawChunk) {
              sawChunk = true;
              streaming();
            }
            this.#consume(this.#parser.push(chunk));
            return this.#terminal || this.#accumulator.done;
          },
          {
            requestId: completion.requestId,
            onOpen: () => this.#opened.resolve(),
            signal: this.#abort.signal,
          },
        );
      } catch (error) {
        // The POST itself failed. If the chat creation succeeded, the request may have been sent.
        this.#opened.reject(error);
        throw qwenChatTransportFailure(error, "stream the completion");
      }
      this.#consume(this.#parser.end());
      if (result.bodyText !== undefined) {
        throw qwenChatRefusal({
          status: result.status,
          contentType: result.contentType,
          bodyText: result.bodyText,
          what: "stream-a-completion",
          continuedChat: this.#continuedChat,
        });
      }
      // A stream that ended without a terminal signal while a cancellation was requested is a
      // cancellation, not a completed answer.
      if (this.#abort.signal.aborted) throw this.#cancelled();
      const completionResult = this.#accumulator.finish();
      if (completionResult.termination === "error") {
        // The provider reported the failure in-band; partial output (if any) was already streamed, and
        // this is a failure, never an empty successful answer.
        const detail = completionResult.error?.message === undefined
          ? "the provider reported an error frame"
          : nonSecretDiagnosticText(completionResult.error.message);
        throw webChatError(
          "UPSTREAM_ERROR",
          `Qwen Chat reported an error during the turn: ${detail}`,
          {
            providerId: QWEN_CHAT_PROVIDER_ID,
            providerCode: completionResult.error?.code ?? "QWEN_CHAT_STREAM_ERROR",
          },
        );
      }
      const termination = completionResult.termination;
      this.#terminal = true;
      const chatIdOfAnswer = completionResult.chatId ?? chatId;
      // The next turn hangs off the assistant message this response produced. `response.created`'s
      // `parent_id` is the *request's* parent, so it is only a fallback when no response id arrived.
      const cursor = completionResult.responseId ?? completionResult.parentId;
      const answer: QwenChatTurnAnswer = {
        chatId: chatIdOfAnswer,
        ...(cursor !== undefined ? { parentId: cursor } : {}),
        ...(completionResult.responseId !== undefined ? { responseId: completionResult.responseId } : {}),
        ...(completionResult.responseIndex !== undefined ? { responseIndex: completionResult.responseIndex } : {}),
        text: completionResult.text,
        termination,
        ...(completionResult.terminalStatus !== undefined ? { terminalStatus: completionResult.terminalStatus } : {}),
        ...(completionResult.selectedModelId !== undefined ? { selectedModelId: completionResult.selectedModelId } : {}),
        sources: completionResult.sources,
        frames: completionResult.frames,
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        ephemeral,
      };
      if (completionResult.selectedModelId !== undefined
        && completionResult.selectedModelId !== this.#options.model) {
        // Recon §1.4: the server can re-route a turn. Surface it — the operator asked for one model
        // and a different one answered, and pretending otherwise would be a quiet lie.
        this.#diagnose({
          stage: "model-rerouted",
          requestedModel: this.#options.model,
          selectedModel: completionResult.selectedModelId,
          ...(this.#chatId !== undefined ? { chatDigest: qwenChatChatDigest(chatIdOfAnswer) } : {}),
        });
        console.warn(
          `[qwen-chat] qwen_chat_model_rerouted ${JSON.stringify({
            provider: QWEN_CHAT_PROVIDER_ID,
            requestedModel: this.#options.model,
            selectedModel: completionResult.selectedModelId,
          })}`,
        );
      }
      this.#diagnose({
        stage: "completed",
        chatDigest: qwenChatChatDigest(chatIdOfAnswer),
        termination,
        frames: completionResult.frames,
        chars: completionResult.text.length,
        elapsedMs: answer.elapsedMs,
        ephemeral,
      });
      this.#channel.push({ type: "completed", epoch: context.epoch, text: completionResult.text });
      if (!ephemeral) await this.#options.onAnswer?.(answer);
      this.#channel.finish();
    } catch (error) {
      this.#prepared.reject(error);
      this.#opened.reject(error);
      if (this.#terminal) return;
      this.#terminal = true;
      const failure: WebChatError = isWebChatError(error)
        ? error
        : qwenChatTransportFailure(error, "complete the turn");
      this.#diagnose({
        stage: this.#abort.signal.aborted ? "cancelled" : "failed",
        ...(this.#chatId !== undefined ? { chatDigest: qwenChatChatDigest(this.#chatId) } : {}),
        category: failure.category,
        ...(failure.providerCode !== undefined ? { providerCode: failure.providerCode } : {}),
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        ephemeral,
      });
      if (failure.category === "CONVERSATION_LOST" && !ephemeral && this.#chatId !== undefined) {
        // The provider proved the chat is gone: record that fact so no later turn silently continues
        // it. An explicit replay is the only way out, and it is the caller's decision.
        await this.#options.onChatLost?.(failure.message);
      }
      if (this.#abort.signal.aborted) {
        this.#channel.push({ type: "cancelled", epoch: context.epoch, reason: "The Qwen Chat turn was cancelled" });
      } else {
        this.#channel.push({ type: "error", epoch: context.epoch, error: failure });
      }
      this.#channel.finish();
    }
  }

  /** Decide the chat of this turn: the recorded one, a newly created one, or none (ephemeral). */
  async #resolveChat(facility: QwenChatTurnRequestFacility, ephemeral: boolean): Promise<string> {
    if (ephemeral) {
      // No `chats/new`: housekeeping must not leave a chat in the operator's account.
      this.#diagnose({ stage: "ephemeral" });
      return this.#newId();
    }
    if (this.#chatId !== undefined) {
      this.#diagnose({
        stage: "chat-reused",
        chatDigest: qwenChatChatDigest(this.#chatId),
      });
      return this.#chatId;
    }
    const created = await facility.postJson(
      QWEN_CHAT_CHATS_NEW_PATH,
      qwenChatChatNewRequest({ model: this.#options.model, timestampMs: this.#startedAt }),
    );
    // A refusal here is the provider's own category (auth, anti-bot or upstream); the caller's text
    // was never sent, which is what makes the turn retry-safe. The reader is handed the whole answer
    // so its refusal can carry the status, the content type and the body it actually received.
    const chatId = readQwenChatCreatedChatId(created);
    this.#diagnose({ stage: "chat-created", chatDigest: qwenChatChatDigest(chatId) });
    return chatId;
  }

  /** The turn's own cancellation, reported as the shared category. */
  #cancelled(): WebChatError {
    return webChatError("CANCELLED", "The Qwen Chat turn was cancelled", {
      providerId: QWEN_CHAT_PROVIDER_ID,
      providerCode: "QWEN_CHAT_TURN_CANCELLED",
    });
  }

  async *stream(): AsyncIterable<WebChatExchangeEvent> {
    for await (const event of this.#channel.drain()) yield event;
  }

  async abort(_context: WebChatTextTransportContext, _reason?: unknown): Promise<void> {
    if (this.#terminal) return;
    this.#abort.abort(this.#cancelled());
    await this.#settleTurn();
  }

  async settle(): Promise<WebChatPhysicalSettlement> {
    if (!this.#started) return "not_started";
    await this.#settleTurn();
    // The only physical object is this turn's page request. It has ended (the run settled, or the
    // page was torn down below), so nothing of this turn can still produce output. The provider may
    // still be generating server-side, but this provider retains no surface for it: a later turn is a
    // new stream on the same chat, exactly what the provider's own client does after Stop.
    return "fulfilled";
  }

  /**
   * Wait, bounded, for the turn's network work to end.
   *
   * A page that never answers cannot be proven idle, so it is torn down instead: closing the browsing
   * context provably ends every stream in it, which is a stronger fact than a timeout.
   */
  async #settleTurn(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    const bound = this.#options.settleTimeoutMs ?? QWEN_CHAT_SETTLE_TIMEOUT_MS;
    const outcome = await Promise.race([
      turn.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timed-out">(resolve => {
        const timer = setTimeout(() => resolve("timed-out"), bound);
        timer.unref?.();
      }),
    ]);
    if (outcome === "timed-out") {
      console.warn(
        `[qwen-chat] qwen_chat_turn_settle_timeout ${JSON.stringify({ provider: QWEN_CHAT_PROVIDER_ID, boundMs: bound })}`,
      );
      await this.#options.session.close();
    }
  }
}

/**
 * The provider's text transport for one exchange.
 *
 * @param options - the session, model, mode, recorded chat and the retention callbacks.
 * @returns the transport the shared exchange drives.
 */
export function createQwenChatTextTransport(options: QwenChatTextTransportOptions): WebChatTextTransport {
  if (options.model.trim().length === 0) {
    throw new TypeError("A Qwen Chat transport requires a provider-local model id");
  }
  return new QwenChatTextTransport(options);
}
