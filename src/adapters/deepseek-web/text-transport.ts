/**
 * The DeepSeek Web text transport: one turn of the measured protocol.
 *
 * ```text
 * POST /api/v0/chat/create_pow_challenge  { target_path:"/api/v0/chat/completion" }
 *        -> {code:0, data:{biz_data:{challenge:{challenge,difficulty,…}}}}
 * POST /api/v0/chat_session/create        {}                      (only when this conversation has none)
 * POST /api/v0/chat/completion            { chat_session_id, parent_message_id, model_type, prompt, … }
 *        -> named SSE: ready | delta(JSON patch) | … | finish | close
 * ```
 *
 * ## What this transport owns, and what it must not own
 *
 * It owns: readiness (the session's, before anything is sent), the provider's admission of the
 * submission (**the proof of work**), the normalized event vocabulary, and physical settlement. It
 * does **not** own retry policy, conversation identity, ephemeral classification or continuity
 * persistence — the exchange decides retry safety, the runtime decides continuity, and the core owns
 * "what makes a turn ephemeral".
 *
 * ## Order, and why the proof comes first
 *
 * The proof of work is fetched and solved **before** the chat session is created. A proof this build
 * cannot produce then fails the turn with nothing created and nothing sent — no empty session left in
 * the operator's account by a build limitation. The recorded `target_path` is the completion route, not
 * a session, so the proof does not depend on the session existing (recon §2.6).
 *
 * ## The one unproven step fails as a typed refusal
 *
 * `facility.requestProofOfWork` is the seam (`network-turn.ts`). Its default throws a typed
 * `TRANSPORT_UNAVAILABLE`; this transport reports it as a pre-submission failure (`prepared`), never as
 * an ambiguous send, and never retries it. No branch of this file fabricates a clearance.
 *
 * ## Continuity and the ephemeral rule
 *
 * A conversational turn continues the session its conversation recorded and creates one only when the
 * conversation has none. The session id and the **parent message id** the turn ended on are handed back
 * through {@link DeepSeekWebTextTransportOptions.onAnswer} so the runtime can persist them.
 *
 * An **ephemeral** turn (the caller declared a housekeeping `purpose`) must leave the operator's
 * account untouched: it sends **no** `chat_session/create` and records nothing, so no session of the
 * caller's conversation is created, continued or claimed. It streams its answer into a session id this
 * process generated — whether the provider accepts an id it did not create is **not measured**
 * (doc/deepseek-web.md §6). If it refuses, the turn fails with the provider's own typed category; it
 * never falls back to creating a session.
 */
import { randomUUID } from "node:crypto";

import {
  isWebChatError,
  webChatError,
  type WebChatError,
  type WebChatExchangeEvent,
  type WebChatPhysicalSettlement,
} from "../../web-chat/core";
import type { WebChatTextTransport, WebChatTextTransportContext } from "../../web-chat/transport";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import type { DeepSeekRequestSession } from "./session";
import {
  DEEPSEEK_WEB_COMPLETION_PATH,
  DEEPSEEK_WEB_POW_CHALLENGE_PATH,
  DEEPSEEK_WEB_PROVIDER_ID,
  DEEPSEEK_WEB_SESSION_CREATE_PATH,
  deepSeekCompletionRequest,
  deepSeekRefusal,
  deepSeekSessionCreateRequest,
  deepSeekSessionDigest,
  deepSeekTransportFailure,
  type DeepSeekMessageId,
  readDeepSeekCreatedSessionId,
  readDeepSeekProofChallenge,
} from "./provider";
import type {
  DeepSeekProofOfWork,
  DeepSeekProofOfWorkSolver,
  DeepSeekTurnRequestFacility,
} from "./network-turn";
import {
  DeepSeekProtocolError,
  DeepSeekSseReader,
  createDeepSeekCompletionAccumulator,
  parseDeepSeekSseEvent,
  type DeepSeekCompletionResult,
  type DeepSeekSseFrame,
  type DeepSeekSseRawEvent,
} from "./sse";

/**
 * How long a turn may run end to end.
 *
 * The same 15-minute ceiling the other WebChat transports apply, enforced here by cancelling the
 * exchange (so settlement is published) instead of leaving a stream open forever.
 */
export const DEEPSEEK_WEB_TURN_TIMEOUT_MS = 15 * 60_000;

/**
 * How long physical settlement may wait for the turn's own network work to end.
 *
 * The only physical object is the page request, so it ends with it; if it does not end within this
 * bound, the session page is torn down (which provably ends every stream in it) and the resource is
 * reported settled rather than left `pending` forever.
 */
export const DEEPSEEK_WEB_SETTLE_TIMEOUT_MS = 5_000;

/** What a completed DeepSeek Web turn established, for the runtime to persist. */
export interface DeepSeekTurnAnswer {
  /** The chat session the answer came from (or the generated id of an ephemeral turn). */
  readonly chatSessionId: string;
  /** The cursor the **next** turn sends as `parent_message_id` (kept with the provider's own scalar). */
  readonly parentMessageId?: DeepSeekMessageId;
  /** The response message id the stream announced, kept for diagnosis. */
  readonly responseMessageId?: DeepSeekMessageId;
  /** The model the provider says answered (`ready.model_type`), when it said. */
  readonly modelType?: string;
  readonly text: string;
  /** The model's reasoning (`THINK` fragments), excluded from {@link text} and kept only as a count. */
  readonly reasoningChars: number;
  /** Every character the stream carried that is not the answer (reasoning plus unmodelled types). */
  readonly excludedChars: number;
  readonly termination: DeepSeekCompletionResult["termination"];
  /** The `close.click_behavior`, when a `close` frame ended the turn. */
  readonly clickBehavior?: string;
  /** Fragment types the stream declared, for diagnosis. */
  readonly fragmentTypes: readonly string[];
  /** How often a patch rewrote already-streamed content. */
  readonly rewrites: number;
  readonly frames: number;
  readonly elapsedMs: number;
  /** Whether the turn was ephemeral (answered, kept nowhere). */
  readonly ephemeral: boolean;
}

/** One non-secret diagnostic line this transport emits. */
export interface DeepSeekTurnDiagnostic {
  /** A named turn stage. Never a token, cookie, prompt or session id. */
  readonly stage:
    | "ready"
    | "session-reused"
    | "session-created"
    | "ephemeral"
    | "pow-solved"
    | "submitted"
    | "streaming"
    | "model-rerouted"
    | "fragment-rewritten"
    | "completed"
    | "failed"
    | "cancelled";
  /** Short digest of the session, when one is involved. Never the id itself. */
  readonly sessionDigest?: string;
  /** Which termination signal fired, on `completed`. */
  readonly termination?: DeepSeekCompletionResult["termination"];
  /** The requested and reported model types on `model-rerouted` (model types are not secrets). */
  readonly requestedModel?: string;
  readonly reportedModel?: string;
  /** The fragment index, on `fragment-rewritten`. */
  readonly fragmentIndex?: number;
  readonly frames?: number;
  readonly chars?: number;
  /** Answer characters, on `completed`; reasoning is counted separately and never returned. */
  readonly reasoningChars?: number;
  readonly excludedChars?: number;
  readonly elapsedMs?: number;
  readonly ephemeral?: boolean;
  /** The typed failure category, on `failed`. */
  readonly category?: string;
  /** The provider's own code, on `failed`. */
  readonly providerCode?: string;
}

/** Construction options for {@link createDeepSeekWebTextTransport}. */
export interface DeepSeekWebTextTransportOptions {
  /** The session that holds the provider page. */
  readonly session: DeepSeekRequestSession;
  /** Provider-local `model_type` sent in the body. */
  readonly modelType: string;
  /** `thinking_enabled` for this turn (the recorded boolean toggle). */
  readonly thinking: boolean;
  /** `search_enabled` for this turn. */
  readonly search: boolean;
  /** The recorded session of this conversation, when it has one. */
  readonly chat?: { readonly chatSessionId: string; readonly parentMessageId?: DeepSeekMessageId };
  /**
   * Answer without creating, continuing or recording any provider conversation.
   *
   * The caller's housekeeping work: no `chat_session/create`, no recorded session, no cursor.
   */
  readonly ephemeral?: boolean;
  /** Called once on a completed conversational turn, with the session and cursor to persist. */
  readonly onAnswer?: (answer: DeepSeekTurnAnswer) => Promise<void> | void;
  /** Called when the provider proved the recorded session is gone, before the turn fails. */
  readonly onChatLost?: (reason: string) => Promise<void> | void;
  /** Diagnostic sink. Defaults to one structured log line per event. */
  readonly onDiagnostic?: (event: DeepSeekTurnDiagnostic) => void;
  /** The proof solver, when the session does not own one (test/composition seam). */
  readonly proofOfWork?: DeepSeekProofOfWorkSolver;
  /** Clock seam. */
  readonly now?: () => number;
  /** Id seam (the ephemeral session id). */
  readonly newId?: () => string;
  /** The turn's own ceiling. Defaults to {@link DEEPSEEK_WEB_TURN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Settlement bound. Defaults to {@link DEEPSEEK_WEB_SETTLE_TIMEOUT_MS}. */
  readonly settleTimeoutMs?: number;
}

/**
 * A deferred: one promise plus its resolvers.
 *
 * Used for the two boundaries the transport must report precisely — "the chat session exists" and "the
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
function defaultDiagnostic(event: DeepSeekTurnDiagnostic): void {
  console.info(`[deepseek-web] deepseek_web_turn ${JSON.stringify({ provider: DEEPSEEK_WEB_PROVIDER_ID, ...event })}`);
}

/** The categories a failure can have and still prove nothing of the caller's text was sent. */
const PRE_SUBMISSION_CATEGORIES = new Set(["AUTH_REQUIRED", "AUTH_EXPIRED", "UPSTREAM_ERROR", "TRANSPORT_UNAVAILABLE"]);

/**
 * One turn's transport.
 *
 * The class is per exchange: `submit` starts the provider work and reports the phase it proved;
 * `stream` yields the normalized events; `settle` reports the physical settlement. Nothing here
 * retries, and nothing here decides whether a turn belongs to a conversation.
 */
class DeepSeekWebTextTransport implements WebChatTextTransport {
  readonly id = "deepseek-web-network";

  readonly #options: DeepSeekWebTextTransportOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #diagnose: (event: DeepSeekTurnDiagnostic) => void;
  readonly #channel = createEventChannel<WebChatExchangeEvent>();
  readonly #abort = new AbortController();
  readonly #opened = deferred<void>();
  /** Resolves when the turn is decided: the proof is in hand and the session exists (or is unnecessary). */
  readonly #prepared = deferred<void>();
  readonly #reader = new DeepSeekSseReader();

  #turn: Promise<void> | undefined;
  #epoch = 0;
  #chatSessionId: string | undefined;
  #parentMessageId: DeepSeekMessageId | undefined;
  #continuedSession = false;
  #startedAt = 0;
  #started = false;
  #terminal = false;
  /** A parse failure captured inside the page callback, rethrown with its type intact in Node. */
  #failure: unknown;

  /**
   * The frame vocabulary and its rules.
   *
   * `onText` is how the answer streams out; `onRewrite` reports a patch that replaced already-sent
   * text (which cannot be unsaid on an append-only wire).
   */
  readonly #accumulator = createDeepSeekCompletionAccumulator({
    onText: (text) => this.#channel.push({ type: "text_delta", epoch: this.#epoch, text }),
    onRewrite: (fragmentIndex) => {
      this.#diagnose({ stage: "fragment-rewritten", fragmentIndex });
      console.warn(
        `[deepseek-web] deepseek_web_fragment_rewritten ${JSON.stringify({
          provider: DEEPSEEK_WEB_PROVIDER_ID,
          fragmentIndex,
        })}`,
      );
    },
  });

  constructor(options: DeepSeekWebTextTransportOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#diagnose = options.onDiagnostic ?? defaultDiagnostic;
    this.#chatSessionId = options.chat?.chatSessionId;
    this.#parentMessageId = options.chat?.parentMessageId;
    this.#continuedSession = options.chat?.chatSessionId !== undefined;
  }

  /** Feed raw events to the vocabulary. `onText` publishes the answer as it arrives. */
  #consume(raw: readonly DeepSeekSseRawEvent[]): void {
    for (const event of raw) {
      const frame: DeepSeekSseFrame = parseDeepSeekSseEvent(event);
      if (this.#accumulator.push(frame)) return;
    }
  }

  async ready(context: WebChatTextTransportContext): Promise<void> {
    if (context.signal.aborted) throw this.#cancelled();
    await this.#options.session.ready();
    this.#diagnose({ stage: "ready" });
  }

  async submit(context: WebChatTextTransportContext): Promise<"prepared" | "send_activated" | "accepted"> {
    if (this.#started) {
      throw webChatError("CONVERSATION_STATE_MISMATCH", "This DeepSeek Web transport already submitted its turn");
    }
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
      this.#abort.abort(webChatError("RESPONSE_TIMEOUT", "The DeepSeek Web turn exceeded its time ceiling", {
        providerId: DEEPSEEK_WEB_PROVIDER_ID,
        providerCode: "DEEPSEEK_TURN_TIMEOUT",
      }));
    }, this.#options.timeoutMs ?? DEEPSEEK_WEB_TURN_TIMEOUT_MS);
    timeout.unref?.();
    this.#abort.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });

    this.#turn = this.#options.session.run(facility => this.#execute(facility, context, ephemeral));
    this.#turn.catch(() => undefined);

    // Phase 1: the proof and the session. A failure here proved nothing reached the caller's
    // conversation, so the turn is retry-safe and is reported as `prepared` — never as a thrown
    // ambiguity.
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
      ...(this.#chatSessionId === undefined ? {} : { sessionDigest: deepSeekSessionDigest(this.#chatSessionId) }),
      elapsedMs: this.#now() - this.#startedAt,
      ephemeral,
    });
    return "accepted";
  }

  /**
   * Whether a prepared-phase failure provably happened before anything was sent.
   *
   * Both steps before the completion POST are admission/bookkeeping — a challenge, a proof, a session
   * create — so a refused or unreachable step left the caller's turn unsent. Everything after the
   * string "the completion POST began" may have reached the provider, so it is not in this set.
   */
  #preparedFailureIsPreSubmission(error: unknown): boolean {
    if (isWebChatError(error)) return PRE_SUBMISSION_CATEGORIES.has(error.category);
    return true;
  }

  /**
   * Fetch and solve the proof of work.
   *
   * The challenge is read from its recorded location (`data.biz_data.challenge`); a refusal there is
   * classified before anything is sent. The solver is the one seam; a solver that answers something
   * that is not a header/value pair is refused with a typed error instead of being attached anyway.
   */
  async #prove(facility: DeepSeekTurnRequestFacility): Promise<DeepSeekProofOfWork> {
    const targetPath = DEEPSEEK_WEB_COMPLETION_PATH;
    const answer = await facility.postJson(DEEPSEEK_WEB_POW_CHALLENGE_PATH, { target_path: targetPath });
    const challenge = readDeepSeekProofChallenge({ status: answer.status, body: answer.body });
    const solver = this.#options.proofOfWork;
    const proof = solver === undefined
      ? await facility.requestProofOfWork({ targetPath, challenge })
      : await solver({ targetPath, challenge });
    if (!proof || typeof proof.header !== "string" || proof.header.trim().length === 0
      || typeof proof.value !== "string" || proof.value.length === 0) {
      throw webChatError(
        "TRANSPORT_UNAVAILABLE",
        "The DeepSeek proof-of-work solver returned no usable header/value pair, so the turn was not sent. "
        + "The solver seam is documented in doc/deepseek-web.md §6.",
        { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_POW_INVALID" },
      );
    }
    this.#diagnose({ stage: "pow-solved", elapsedMs: this.#now() - this.#startedAt });
    return proof;
  }

  /** The turn itself: prove, decide the session, then stream the completion. */
  async #execute(
    facility: DeepSeekTurnRequestFacility,
    context: WebChatTextTransportContext,
    ephemeral: boolean,
  ): Promise<void> {
    try {
      // The proof comes first, so a build that cannot produce one leaves no session behind.
      const proof = await this.#prove(facility);
      const chatSessionId = await this.#resolveSession(facility, ephemeral);
      this.#chatSessionId = chatSessionId;
      this.#prepared.resolve();
      const body = deepSeekCompletionRequest({
        chatSessionId,
        ...(this.#parentMessageId === undefined ? {} : { parentMessageId: this.#parentMessageId }),
        // A session's first turn declares the deployment's model_type; a continuation sends `null`,
        // exactly as the captured app does — the session owns the model and the provider echoes the
        // answering one in `ready.model_type` (surfaced by the re-route diagnostic below).
        modelType: this.#continuedSession ? null : this.#options.modelType,
        prompt: context.turn.userText,
        thinkingEnabled: this.#options.thinking,
        searchEnabled: this.#options.search,
      });
      const streaming = (): void => {
        if (this.#terminal) return;
        this.#diagnose({
          stage: "streaming",
          ...(this.#chatSessionId === undefined ? {} : { sessionDigest: deepSeekSessionDigest(chatSessionId) }),
          elapsedMs: this.#now() - this.#startedAt,
        });
      };
      let sawChunk = false;
      let result;
      try {
        result = await facility.postEventStream(
          DEEPSEEK_WEB_COMPLETION_PATH,
          body,
          chunk => {
            if (this.#failure !== undefined) return true;
            if (!sawChunk) {
              sawChunk = true;
              streaming();
            }
            try {
              this.#consume(this.#reader.push(chunk));
            } catch (error) {
              // Kept and rethrown in Node: a typed protocol error must not cross the page boundary as
              // a stringified page error.
              this.#failure = error;
              return true;
            }
            return this.#terminal || this.#accumulator.done;
          },
          { onOpen: () => this.#opened.resolve(), signal: this.#abort.signal, proof },
        );
      } catch (error) {
        // The POST itself failed. The session creation succeeded, so the request may have been sent.
        this.#opened.reject(error);
        throw deepSeekTransportFailure(error, "stream the completion", nonSecretDiagnosticText(error));
      }
      try {
        this.#consume(this.#reader.end());
      } catch (error) {
        this.#failure ??= error;
      }
      if (this.#failure !== undefined) throw this.#failure;
      if (result.bodyText !== undefined) {
        throw deepSeekRefusal({
          status: result.status,
          contentType: result.contentType,
          bodyText: result.bodyText,
          what: "stream-a-completion",
          continuedSession: this.#continuedSession,
        });
      }
      // A stream that ended without a terminal signal while a cancellation was requested is a
      // cancellation, not a completed answer.
      if (this.#abort.signal.aborted) throw this.#cancelled();
      const completion = this.#accumulator.finish();
      if (completion.termination === "error") {
        throw this.#inBandFailure(completion, result.status);
      }
      // The answer is the `RESPONSE` fragments' content; `THINK` is reasoning and is counted, never
      // returned. A stream whose only text is reasoning (or a fragment type this build does not model)
      // is a failed turn, never an empty successful answer.
      if (completion.text.length === 0 && completion.excludedChars > 0) {
        const reasoning = completion.reasoningChars;
        throw webChatError(
          "UPSTREAM_ERROR",
          "DeepSeek answered without a `RESPONSE` fragment: "
          + `${reasoning} reasoning character(s) and `
          + `${completion.unattributedText.length} character(s) on unmodelled fragment types `
          + `(types: ${completion.fragmentTypes.join(", ") || "none declared"}). Reasoning is never `
          + "returned as the answer, so this turn is reported as a failure rather than empty text.",
          { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_UNATTRIBUTED_ANSWER" },
        );
      }
      if (completion.termination === "close"
        && completion.clickBehavior === "retry"
        && completion.text.length === 0) {
        // The provider closed the turn and asked the app to offer a retry, without an answer. This
        // transport does not retry by itself; it reports what happened.
        throw webChatError(
          "UPSTREAM_ERROR",
          "DeepSeek closed the turn with click_behavior \"retry\" and no answer text. This build does not "
          + "retry a confirmed submission by itself; the caller may replay the turn.",
          { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_CLOSE_RETRY" },
        );
      }
      const termination = completion.termination;
      this.#terminal = true;
      const cursor = completion.responseMessageId ?? this.#parentMessageId;
      const answer: DeepSeekTurnAnswer = {
        chatSessionId,
        ...(cursor === undefined ? {} : { parentMessageId: cursor }),
        ...(completion.responseMessageId === undefined ? {} : { responseMessageId: completion.responseMessageId }),
        ...(completion.modelType === undefined ? {} : { modelType: completion.modelType }),
        text: completion.text,
        reasoningChars: completion.reasoningChars,
        excludedChars: completion.excludedChars,
        termination,
        ...(completion.clickBehavior === undefined ? {} : { clickBehavior: completion.clickBehavior }),
        fragmentTypes: completion.fragmentTypes,
        rewrites: completion.rewrites,
        frames: completion.frames,
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        ephemeral,
      };
      if (completion.modelType !== undefined && completion.modelType !== this.#options.modelType) {
        // The `ready` event echoes the model that actually answered. Surface it — the operator asked
        // for one model_type and another answered, and pretending otherwise would be a quiet lie.
        this.#diagnose({
          stage: "model-rerouted",
          requestedModel: this.#options.modelType,
          reportedModel: completion.modelType,
          sessionDigest: deepSeekSessionDigest(chatSessionId),
        });
        console.warn(
          `[deepseek-web] deepseek_web_model_rerouted ${JSON.stringify({
            provider: DEEPSEEK_WEB_PROVIDER_ID,
            requestedModel: this.#options.modelType,
            reportedModel: completion.modelType,
          })}`,
        );
      }
      this.#diagnose({
        stage: "completed",
        sessionDigest: deepSeekSessionDigest(chatSessionId),
        termination,
        frames: completion.frames,
        chars: completion.text.length,
        reasoningChars: completion.reasoningChars,
        excludedChars: completion.excludedChars,
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
        : deepSeekTransportFailure(error, "complete the turn", nonSecretDiagnosticText(error));
      this.#diagnose({
        stage: this.#abort.signal.aborted ? "cancelled" : "failed",
        ...(this.#chatSessionId === undefined ? {} : { sessionDigest: deepSeekSessionDigest(this.#chatSessionId) }),
        category: failure.category,
        ...(failure.providerCode === undefined ? {} : { providerCode: failure.providerCode }),
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        ephemeral,
      });
      if (failure.category === "CONVERSATION_LOST" && !ephemeral && this.#chatSessionId !== undefined) {
        // The provider proved the session is gone: record that fact so no later turn silently
        // continues it. An explicit replay is the only way out, and it is the caller's decision.
        await this.#options.onChatLost?.(failure.message);
      }
      if (this.#abort.signal.aborted) {
        this.#channel.push({ type: "cancelled", epoch: context.epoch, reason: "The DeepSeek Web turn was cancelled" });
      } else {
        this.#channel.push({ type: "error", epoch: context.epoch, error: failure });
      }
      this.#channel.finish();
    }
  }

  /**
   * Map an in-band error frame to the shared category through the provider's own envelope.
   *
   * A frame that carries no code at all is still a provider error — it is reported as such, never as
   * "no answer".
   */
  #inBandFailure(completion: DeepSeekCompletionResult, status: number): WebChatError {
    const error = completion.error;
    const hasCode = error?.code !== undefined || error?.bizCode !== undefined
      || (error?.msg !== undefined && error.msg.length > 0)
      || (error?.bizMsg !== undefined && error.bizMsg.length > 0);
    if (!hasCode) {
      return webChatError(
        "UPSTREAM_ERROR",
        "DeepSeek reported an in-band error during the turn without a code this build can read",
        { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_STREAM_ERROR" },
      );
    }
    return deepSeekRefusal({
      status,
      body: {
        ...(error?.code === undefined ? { code: 0 } : { code: error.code }),
        ...(error?.msg === undefined ? {} : { msg: error.msg }),
        ...(error?.bizCode === undefined && error?.bizMsg === undefined
          ? {}
          : {
            data: {
              ...(error?.bizCode === undefined ? {} : { biz_code: error.bizCode }),
              ...(error?.bizMsg === undefined ? {} : { biz_msg: error.bizMsg }),
            },
          }),
      },
      what: "stream-a-completion",
      continuedSession: this.#continuedSession,
    });
  }

  /** Decide the session of this turn: the recorded one, a newly created one, or none (ephemeral). */
  async #resolveSession(facility: DeepSeekTurnRequestFacility, ephemeral: boolean): Promise<string> {
    if (ephemeral) {
      // No `chat_session/create`: housekeeping must not leave a session in the operator's account.
      this.#diagnose({ stage: "ephemeral" });
      return this.#newId();
    }
    if (this.#chatSessionId !== undefined) {
      this.#diagnose({ stage: "session-reused", sessionDigest: deepSeekSessionDigest(this.#chatSessionId) });
      return this.#chatSessionId;
    }
    const created = await facility.postJson(DEEPSEEK_WEB_SESSION_CREATE_PATH, deepSeekSessionCreateRequest());
    // A refusal here is the provider's own category (auth, access verification or upstream); the
    // caller's text was never sent, which is what makes the turn retry-safe.
    const chatSessionId = readDeepSeekCreatedSessionId({
      status: created.status,
      body: created.body,
      bodyText: created.bodyText,
      contentType: created.contentType,
    });
    this.#diagnose({ stage: "session-created", sessionDigest: deepSeekSessionDigest(chatSessionId) });
    return chatSessionId;
  }

  /** The turn's own cancellation, reported as the shared category. */
  #cancelled(): WebChatError {
    return webChatError("CANCELLED", "The DeepSeek Web turn was cancelled", {
      providerId: DEEPSEEK_WEB_PROVIDER_ID,
      providerCode: "DEEPSEEK_TURN_CANCELLED",
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
    // page was torn down below), so nothing of this turn can still produce output.
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
    const bound = this.#options.settleTimeoutMs ?? DEEPSEEK_WEB_SETTLE_TIMEOUT_MS;
    const outcome = await Promise.race([
      turn.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timed-out">(resolve => {
        const timer = setTimeout(() => resolve("timed-out"), bound);
        timer.unref?.();
      }),
    ]);
    if (outcome === "timed-out") {
      console.warn(
        `[deepseek-web] deepseek_web_turn_settle_timeout ${JSON.stringify({ provider: DEEPSEEK_WEB_PROVIDER_ID, boundMs: bound })}`,
      );
      await this.#options.session.close();
    }
  }
}

/**
 * The provider's text transport for one exchange.
 *
 * @param options - the session, the model_type, the two toggles, the recorded session and the
 *   retention callbacks.
 * @returns the transport the shared exchange drives.
 */
export function createDeepSeekWebTextTransport(options: DeepSeekWebTextTransportOptions): WebChatTextTransport {
  if (options.modelType.trim().length === 0) {
    throw new TypeError("A DeepSeek Web transport requires a provider-local model_type");
  }
  return new DeepSeekWebTextTransport(options);
}

/** Whether a value is this provider's protocol failure (exported for the ingress and the tests). */
export function isDeepSeekProtocolError(value: unknown): value is DeepSeekProtocolError {
  return value instanceof DeepSeekProtocolError;
}
