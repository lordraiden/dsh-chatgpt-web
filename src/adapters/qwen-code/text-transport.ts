/**
 * The Qwen Code text transport: one turn of the measured protocol (issue #299, slice 2).
 *
 * ## The protocol, as measured
 *
 * `doc/qwen-code.md` §2 records it, and slice 1 already parses it:
 *
 * ```text
 * POST /coder/api/v2/task/new                       -> { success, request_id, data: { id } }
 * POST /coder/api/v2/task/completions?chat_id=<id>  -> text/event-stream
 *        {"response.created": { chat_id, parent_id, response_id }}
 *        {"choices": [{ "delta": { role, content, phase, status, extra } }], response_id, timestamp }
 *        {"response.info": { action, chat_id, response_id, timestamp }}
 * ```
 *
 * The stream ends on one of **three** separately observable signals (`sse.ts`): a non-`function`
 * delta leaving `typing`, a `response.info` whose action is not `keep_alive`, or the stream closing.
 * `role:"function"` frames are the agent environment's own progress, never the model's answer, and
 * can never terminate the turn.
 *
 * ## What this transport owns, and what it must not own
 *
 * It owns: readiness (the session's, before anything is sent), the provider's admission of the
 * submission, the normalized event vocabulary, and physical settlement. It does **not** own retry
 * policy, conversation identity, ephemeral classification or continuity persistence — the exchange
 * decides retry safety, the runtime decides continuity, and the core owns "what makes a turn
 * ephemeral".
 *
 * ## Conversation continuity, and the ephemeral rule
 *
 * A conversational turn continues the chat its conversation already recorded, and creates one (with
 * `task/new`) only when the conversation has none. The chat id and the cursor the turn ended on are
 * handed back through {@link QwenCodeTextTransportOptions.onAnswer} so the runtime can persist them.
 *
 * An **ephemeral** turn (the caller declared a housekeeping `purpose`) must leave the operator's
 * account untouched: it sends **no** `task/new` and records nothing, so no chat of the caller's
 * conversation is created, continued or claimed. It streams its answer into a chat id this process
 * generated, which is the only way this protocol can answer without creating a chat — and whether
 * the provider accepts a chat id it did not create is **not yet measured** (see
 * `doc/qwen-code.md`). If it refuses, the turn fails with the provider's own typed category; it never
 * falls back to creating a chat, because that is exactly the bug this rule exists to prevent.
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
import type { QwenTurnRequestFacility } from "./network-turn";
import {
  qwenCodeCompletionRequest,
  qwenTaskNewRequest,
  readQwenCreatedChatId,
} from "./network-turn";
import {
  QWEN_CODE_COMPLETIONS_PATH,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CODE_TASK_NEW_PATH,
} from "./provider";
import type { QwenCodeRequestSession } from "./browser-session";
import {
  QwenSseParser,
  createQwenCompletionAccumulator,
  type QwenCompletionResult,
  type QwenSseFrame,
} from "./sse";

/**
 * How long a turn may run end to end.
 *
 * The same 15-minute ceiling the ChatGPT browser turn uses (`DEFAULT_TURN_TIMEOUT_MS`), applied
 * here as this provider's own bound: a Qwen turn is bounded too, and the bound cancels the turn
 * through the exchange (so settlement is published) instead of leaving a stream open forever.
 */
export const QWEN_CODE_TURN_TIMEOUT_MS = 15 * 60_000;

/**
 * How long physical settlement may wait for the turn's own network work to end.
 *
 * Settlement is the provider's promise that nothing of this turn can still produce output. The only
 * physical object is the page request, so it ends with it; if it does not end within this bound, the
 * session page is torn down (which provably ends every stream in it) and the resource is reported
 * settled rather than left `pending` forever.
 */
export const QWEN_CODE_SETTLE_TIMEOUT_MS = 5_000;

/** What a completed Qwen turn established, for the runtime to persist. */
export interface QwenCodeTurnAnswer {
  readonly chatId: string;
  /** The parent cursor the stream reported, when it reported one. */
  readonly parentId?: string;
  readonly responseId?: string;
  readonly text: string;
  readonly termination: QwenCompletionResult["termination"];
  /** The `status` that closed the turn, when `delta_status` ended it. */
  readonly terminalStatus?: string;
  /** The terminal `response.info` action, when `response_info` ended it. */
  readonly terminalAction?: string;
  readonly frames: number;
  readonly elapsedMs: number;
  /** Whether the turn was ephemeral (answered, kept nowhere). */
  readonly ephemeral: boolean;
}

/** One non-secret diagnostic line this transport emits. */
export interface QwenCodeTurnDiagnostic {
  /** A named turn stage. Never a token, cookie, prompt or chat id. */
  readonly stage:
    | "ready"
    | "chat-reused"
    | "chat-created"
    | "ephemeral"
    | "submitted"
    | "streaming"
    | "completed"
    | "failed"
    | "cancelled";
  /** Short digest of the chat, when one is involved. Never the id itself. */
  readonly chatDigest?: string;
  /** Which termination signal fired, on `completed`. */
  readonly termination?: QwenCompletionResult["termination"];
  readonly frames?: number;
  readonly chars?: number;
  readonly elapsedMs?: number;
  readonly ephemeral?: boolean;
  /** The typed failure category, on `failed`. */
  readonly category?: string;
  /** The provider's own code, on `failed`. */
  readonly providerCode?: string;
}

/** Construction options for {@link createQwenCodeTextTransport}. */
export interface QwenCodeTextTransportOptions {
  /** The session that holds the authenticated page. */
  readonly session: QwenCodeRequestSession;
  /** Provider-local model id sent in both bodies. */
  readonly model: string;
  /** The recorded chat of this conversation, when it has one. */
  readonly chat?: { readonly chatId: string; readonly parentId?: string };
  /**
   * Answer without creating, continuing or recording any provider conversation.
   *
   * The caller's housekeeping work: no `task/new`, no recorded chat, no cursor.
   */
  readonly ephemeral?: boolean;
  /** Called once on a completed conversational turn, with the chat and cursor to persist. */
  readonly onAnswer?: (answer: QwenCodeTurnAnswer) => Promise<void> | void;
  /** Called when the provider proved the recorded chat id is gone, before the turn fails. */
  readonly onChatLost?: (reason: string) => Promise<void> | void;
  /** Diagnostic sink. Defaults to one structured log line per event. */
  readonly onDiagnostic?: (event: QwenCodeTurnDiagnostic) => void;
  /** Clock seam. */
  readonly now?: () => number;
  /** Id seam (client-generated message/assistant ids, and the ephemeral chat id). */
  readonly newId?: () => string;
  /** The turn's own ceiling. Defaults to {@link QWEN_CODE_TURN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Settlement bound. Defaults to {@link QWEN_CODE_SETTLE_TIMEOUT_MS}. */
  readonly settleTimeoutMs?: number;
}

/** A chat id's short diagnostic digest: enough to correlate two log lines, useless as a lookup key. */
export function qwenCodeChatDigest(chatId: string): string {
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

/** The provider's own answer when it did not stream one. Never treated as an empty answer. */
function classifyRefusal(input: {
  readonly status: number;
  readonly contentType: string;
  readonly bodyText: string | undefined;
  /** What was being attempted, for the message. */
  readonly what: "create-a-chat" | "stream-a-completion";
  /** Whether a conversation's recorded chat was the target (a refusal then means "lost"). */
  readonly continuedChat: boolean;
}): Error {
  const { status, contentType, bodyText, what, continuedChat } = input;
  const text = bodyText ?? "";
  const unauthorized = status === 401 || status === 403 || /"?Unauthorized"?/i.test(text) || /"success"\s*:\s*false/i.test(text);
  const missing = status === 404 || /chat[^a-z]{0,4}not[^a-z]{0,4}found/i.test(text);
  if (missing && continuedChat) {
    return webChatError(
      "CONVERSATION_LOST",
      `Qwen Code no longer has the chat this conversation was continuing (HTTP ${status}), so it was not reused; a new chat requires an explicit replay`,
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_CHAT_LOST" },
    );
  }
  if (unauthorized) {
    return webChatError(
      "AUTH_REQUIRED",
      `Qwen Code refused to ${what}: the stored session is no longer accepted (HTTP ${status}). `
      + "Sign in again at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Code\").",
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_SESSION_UNAUTHORIZED" },
    );
  }
  return webChatError(
    "UPSTREAM_ERROR",
    `Qwen Code refused to ${what} (HTTP ${status}, ${contentType || "no content type"})`,
    { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_COMPLETION_REFUSED" },
  );
}

/** The default diagnostic sink: one structured, credential-free line per stage. */
function defaultDiagnostic(event: QwenCodeTurnDiagnostic): void {
  console.info(`[qwen-code] qwen_turn ${JSON.stringify({ provider: QWEN_CODE_PROVIDER_ID, ...event })}`);
}

/**
 * One turn's transport.
 *
 * The class is per exchange: `submit` starts the provider work and reports the phase it proved;
 * `stream` yields the normalized events; `settle` reports the physical settlement. Nothing here
 * retries, and nothing here decides whether a turn belongs to a conversation.
 */
class QwenCodeTextTransport implements WebChatTextTransport {
  readonly id = "qwen-code-network";

  readonly #options: QwenCodeTextTransportOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #diagnose: (event: QwenCodeTurnDiagnostic) => void;
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
   * `onDelta` is how the answer streams out: which frames count as the model's answer (and the
   * `function`-role exclusion) stays owned by `sse.ts`, so nothing here reimplements it.
   */
  readonly #accumulator = createQwenCompletionAccumulator({
    onDelta: (text) => this.#channel.push({ type: "text_delta", epoch: this.#epoch, text }),
  });
  readonly #parser = new QwenSseParser();
  #startedAt = 0;
  #started = false;
  #terminal = false;

  constructor(options: QwenCodeTextTransportOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#diagnose = options.onDiagnostic ?? defaultDiagnostic;
    this.#chatId = options.chat?.chatId;
    this.#parentId = options.chat?.parentId;
    this.#continuedChat = options.chat?.chatId !== undefined;
  }

  /** Feed frames to the vocabulary. `onDelta` publishes the answer as it arrives. */
  #consume(frames: readonly QwenSseFrame[]): void {
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
    if (this.#started) throw webChatError("CONVERSATION_STATE_MISMATCH", "This Qwen Code transport already submitted its turn");
    this.#started = true;
    this.#epoch = context.epoch;
    this.#startedAt = this.#now();
    const ephemeral = this.#options.ephemeral === true;
    if (context.signal.aborted) throw this.#cancelled();
    context.signal.addEventListener("abort", () => {
      this.#abort.abort(context.signal.reason);
    }, { once: true });
    // The turn's own ceiling: the same explicit bound the ChatGPT browser turn applies, enforced
    // here by cancelling the exchange (which publishes settlement) instead of abandoning a stream.
    const timeout = setTimeout(() => {
      this.#abort.abort(webChatError("RESPONSE_TIMEOUT", "The Qwen Code turn exceeded its time ceiling", {
        providerId: QWEN_CODE_PROVIDER_ID,
        providerCode: "QWEN_TURN_TIMEOUT",
      }));
    }, this.#options.timeoutMs ?? QWEN_CODE_TURN_TIMEOUT_MS);
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
      ...(this.#chatId !== undefined ? { chatDigest: qwenCodeChatDigest(this.#chatId) } : {}),
      elapsedMs: this.#now() - this.#startedAt,
      ephemeral,
    });
    return "accepted";
  }

  /**
   * Whether a prepared-phase failure provably happened before anything was sent.
   *
   * Only a failure while *deciding the chat* qualifies: `task/new` is not the caller's message, so a
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
    facility: QwenTurnRequestFacility,
    context: WebChatTextTransportContext,
    ephemeral: boolean,
  ): Promise<void> {
    try {
      const chatId = await this.#resolveChat(facility, ephemeral);
      this.#chatId = chatId;
      this.#prepared.resolve();
      const timestampSeconds = Math.floor(this.#startedAt / 1_000);
      const body = qwenCodeCompletionRequest({
        chatId,
        prompt: context.turn.userText,
        model: this.#options.model,
        timestampSeconds,
        messageId: this.#newId(),
        assistantId: this.#newId(),
        ...(this.#parentId !== undefined ? { parentId: this.#parentId } : {}),
      });
      const streaming = (): void => {
        if (this.#terminal) return;
        this.#diagnose({
          stage: "streaming",
          ...(this.#chatId !== undefined ? { chatDigest: qwenCodeChatDigest(this.#chatId) } : {}),
          elapsedMs: this.#now() - this.#startedAt,
        });
      };
      let sawChunk = false;
      let result;
      try {
        result = await facility.postEventStream(
          `${QWEN_CODE_COMPLETIONS_PATH}?chat_id=${encodeURIComponent(chatId)}`,
          body,
          chunk => {
            if (!sawChunk) {
              sawChunk = true;
              streaming();
            }
            this.#consume(this.#parser.push(chunk));
            return this.#terminal || this.#accumulator.done;
          },
          {
            onOpen: () => this.#opened.resolve(),
            signal: this.#abort.signal,
          },
        );
      } catch (error) {
        // The POST itself failed. If the chat creation succeeded, the request may have been sent.
        this.#opened.reject(error);
        throw this.#transportFailure(error, "stream the completion");
      }
      this.#consume(this.#parser.end());
      if (result.bodyText !== undefined) {
        throw classifyRefusal({
          status: result.status,
          contentType: result.contentType,
          bodyText: result.bodyText,
          what: "stream-a-completion",
          continuedChat: this.#continuedChat,
        });
      }
      // A stream that ended without one of the three terminal signals while a cancellation was
      // requested is a cancellation, not a completed answer.
      if (this.#abort.signal.aborted) throw this.#cancelled();
      const completion = this.#accumulator.finish();
      const termination = completion.termination;
      this.#terminal = true;
      const chatIdOfAnswer = completion.chatId ?? chatId;
      const parentId = completion.parentId;
      const answer: QwenCodeTurnAnswer = {
        chatId: chatIdOfAnswer,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(completion.responseId !== undefined ? { responseId: completion.responseId } : {}),
        text: completion.text,
        termination,
        ...(completion.terminalStatus !== undefined ? { terminalStatus: completion.terminalStatus } : {}),
        ...(completion.terminalAction !== undefined ? { terminalAction: completion.terminalAction } : {}),
        frames: completion.frames,
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        ephemeral,
      };
      this.#diagnose({
        stage: "completed",
        chatDigest: qwenCodeChatDigest(chatIdOfAnswer),
        termination,
        frames: completion.frames,
        chars: completion.text.length,
        elapsedMs: answer.elapsedMs,
        ephemeral,
      });
      this.#channel.push({ type: "completed", epoch: context.epoch, text: completion.text });
      if (!ephemeral) await this.#options.onAnswer?.(answer);
      this.#channel.finish();
    } catch (error) {
      this.#prepared.reject(error);
      this.#opened.reject(error);
      if (this.#terminal) return;
      this.#terminal = true;
      const failure: WebChatError = isWebChatError(error)
        ? error
        : this.#transportFailure(error, "complete the turn");
      this.#diagnose({
        stage: this.#abort.signal.aborted ? "cancelled" : "failed",
        ...(this.#chatId !== undefined ? { chatDigest: qwenCodeChatDigest(this.#chatId) } : {}),
        category: failure.category,
        ...(failure.providerCode !== undefined ? { providerCode: failure.providerCode } : {}),
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        ephemeral,
      });
      if (failure.category === "CONVERSATION_LOST" && !ephemeral && this.#chatId !== undefined) {
        // The provider proved the chat is gone: record that fact so no later turn silently
        // continues it. An explicit replay is the only way out, and it is the caller's decision.
        await this.#options.onChatLost?.(failure.message);
      }
      if (this.#abort.signal.aborted) {
        this.#channel.push({ type: "cancelled", epoch: context.epoch, reason: "The Qwen Code turn was cancelled" });
      } else {
        this.#channel.push({ type: "error", epoch: context.epoch, error: failure });
      }
      this.#channel.finish();
    }
  }

  /** Decide the chat of this turn: the recorded one, a newly created one, or none (ephemeral). */
  async #resolveChat(facility: QwenTurnRequestFacility, ephemeral: boolean): Promise<string> {
    if (ephemeral) {
      // No `task/new`: housekeeping must not leave a chat in the operator's account.
      this.#diagnose({ stage: "ephemeral" });
      return this.#newId();
    }
    if (this.#chatId !== undefined) {
      this.#diagnose({
        stage: "chat-reused",
        chatDigest: qwenCodeChatDigest(this.#chatId),
      });
      return this.#chatId;
    }
    const created = await facility.postJson(
      QWEN_CODE_TASK_NEW_PATH,
      qwenTaskNewRequest({ model: this.#options.model, timestampMs: this.#startedAt }),
    );
    // A refusal here is the provider's own category (auth or upstream); the caller's text was never
    // sent, which is what makes the turn retry-safe.
    const chatId = readQwenCreatedChatId(created.body, created.status);
    this.#diagnose({ stage: "chat-created", chatDigest: qwenCodeChatDigest(chatId) });
    return chatId;
  }

  /** Wrap a non-WebChat failure in this provider's transport category, without leaking a page error. */
  #transportFailure(error: unknown, what: string): WebChatError {
    if (isWebChatError(error)) return error;
    if (this.#abort.signal.aborted) return this.#cancelled();
    return webChatError(
      "TRANSPORT_UNAVAILABLE",
      `Qwen Code could not ${what}: ${nonSecretDiagnosticText(error)}`,
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_TURN_TRANSPORT", cause: error },
    );
  }

  /** The turn's own cancellation, reported as the shared category. */
  #cancelled(): WebChatError {
    return webChatError("CANCELLED", "The Qwen Code turn was cancelled", {
      providerId: QWEN_CODE_PROVIDER_ID,
      providerCode: "QWEN_TURN_CANCELLED",
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
    const bound = this.#options.settleTimeoutMs ?? QWEN_CODE_SETTLE_TIMEOUT_MS;
    const outcome = await Promise.race([
      turn.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timed-out">(resolve => {
        const timer = setTimeout(() => resolve("timed-out"), bound);
        timer.unref?.();
      }),
    ]);
    if (outcome === "timed-out") {
      console.warn(
        `[qwen-code] qwen_turn_settle_timeout ${JSON.stringify({ provider: QWEN_CODE_PROVIDER_ID, boundMs: bound })}`,
      );
      await this.#options.session.close();
    }
  }
}

/**
 * The provider's text transport for one exchange.
 *
 * @param options - the session, the model, the recorded chat and the retention callbacks.
 * @returns the transport the shared exchange drives.
 */
export function createQwenCodeTextTransport(options: QwenCodeTextTransportOptions): WebChatTextTransport {
  if (options.model.trim().length === 0) {
    throw new TypeError("A Qwen Code transport requires a provider-local model id");
  }
  return new QwenCodeTextTransport(options);
}
