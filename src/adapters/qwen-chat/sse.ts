/**
 * The `text/event-stream` vocabulary of a `chat.qwen.ai` turn.
 *
 * ## What the stream is, as measured
 *
 * Recon §1.4 records a **`data:`-only** SSE stream (the app parses it by hand, there is no
 * `EventSource`), with this frame set:
 *
 * ```text
 * data: {"response.created":{chat_id,parent_id,response_id,response_index}}
 * data: {"response.stopped":{response_id}}
 * data: {"response.info":{action,response_id}}                 // action "skip_think" is special-cased
 * data: {"choices":[{"delta":{role,content,phase,status,extra}}],"response_id","timestamp","usage"?}
 * data: {"sources":[…],"choices":[{"delta":{"role"}}],"response_id"}
 * data: {"selected_model_id":"…","choices":[{"delta":{"role"}}],"response_id"}
 * data: {"error":{…},"response_id"}
 * data: [DONE]
 * ```
 *
 * ## The four termination signals, and what is *not* one
 *
 * | Signal | Rule implemented |
 * | --- | --- |
 * | `done` | the literal `data: [DONE]` frame |
 * | `response_stopped` | a `response.stopped` frame |
 * | `delta_status` | an assistant delta whose `status` is present and not `typing` (`finished`) |
 * | `stream_end` | the stream closes with none of the above |
 *
 * `phase:"KeepAlive"` is **not content and not a terminator** (the app's keep-alive handler returns
 * null); `response.info` is a control frame, not a terminal one (only `response.stopped` is listed as
 * terminal in the recon), and `sources` is the web-search citation envelope.
 *
 * ## The model can change under us
 *
 * Recon §1.4 records `selected_model_id`: the server may re-route the turn to a different model.
 * This parser surfaces it as data. It never rewrites the requested model — the transport logs the
 * divergence and reports it in the turn result, because silently pretending the requested model
 * answered would be a lie.
 *
 * This module is pure: no browser, no network, no provider page. It is testable against a recorded
 * chunked fixture without Chromium.
 */

/** One parsed frame of a Qwen Chat turn stream. */
export type QwenChatSseFrame =
  /** The stream announced its response (`chat_id`, parent cursor, response id, index). */
  | {
    readonly kind: "created";
    readonly chatId?: string;
    readonly parentId?: string;
    readonly responseId?: string;
    readonly responseIndex?: number;
  }
  /** One incremental output delta. `content` is `""` when the frame carries none. */
  | {
    readonly kind: "delta";
    readonly responseId?: string;
    readonly role?: string;
    readonly content: string;
    readonly status?: string;
    readonly phase?: string;
    /** The server re-routed the turn; present only when it said so. */
    readonly selectedModelId?: string;
  }
  /** The server stopped the response. */
  | { readonly kind: "stopped"; readonly responseId?: string }
  /** A control frame (`skip_think`, and any other action the service may send). */
  | { readonly kind: "info"; readonly action: string; readonly responseId?: string }
  /** The server re-routed the turn without carrying content. */
  | { readonly kind: "selected_model"; readonly selectedModelId: string; readonly responseId?: string }
  /** Web-search citations. Not content; kept so the turn can report it. */
  | { readonly kind: "sources"; readonly responseId?: string }
  /** The provider reported an error in-band. */
  | {
    readonly kind: "error";
    readonly responseId?: string;
    readonly message?: string;
    readonly code?: string;
    readonly status?: number;
  }
  /** The literal `data: [DONE]` sentinel. */
  | { readonly kind: "done" }
  /** A `data:` payload this parser does not model. Kept so a new frame cannot be silently dropped. */
  | { readonly kind: "unknown"; readonly payload: string };

/** Why the completion loop stopped. Each value is a distinct observable signal. */
export const QWEN_CHAT_TERMINATIONS = [
  "done",
  "response_stopped",
  "delta_status",
  "stream_end",
  "error",
] as const;

/** One termination signal. */
export type QwenChatTermination = (typeof QWEN_CHAT_TERMINATIONS)[number];

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse one already-assembled `data:` payload. Exported for frame-by-frame fixtures. */
export function parseQwenChatSsePayload(payload: string): QwenChatSseFrame {
  const trimmed = payload.trim();
  if (trimmed === "[DONE]") return { kind: "done" };
  if (trimmed.length === 0) return { kind: "unknown", payload: "" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    // A truncated payload is reported, never guessed. The stream ending is a termination signal of
    // its own, so an unmodelled payload does not have to be fatal.
    return { kind: "unknown", payload: trimmed };
  }
  if (!decoded || typeof decoded !== "object") return { kind: "unknown", payload: trimmed };
  const frame = decoded as Record<string, unknown>;
  const responseId = stringField(frame["response_id"]);

  const error = frame["error"];
  if (error !== undefined && error !== null) {
    const record = (typeof error === "object" && !Array.isArray(error) ? error : {}) as Record<string, unknown>;
    return {
      kind: "error",
      ...(responseId === undefined ? {} : { responseId }),
      ...(stringField(record["message"]) === undefined ? {} : { message: stringField(record["message"]) }),
      ...(stringField(record["code"]) === undefined ? {} : { code: stringField(record["code"]) }),
      ...(numberField(record["status"]) === undefined ? {} : { status: numberField(record["status"]) }),
    };
  }

  const created = frame["response.created"];
  if (created && typeof created === "object" && !Array.isArray(created)) {
    const record = created as Record<string, unknown>;
    return {
      kind: "created",
      ...(stringField(record["chat_id"]) === undefined ? {} : { chatId: stringField(record["chat_id"]) }),
      ...(stringField(record["parent_id"]) === undefined ? {} : { parentId: stringField(record["parent_id"]) }),
      ...(stringField(record["response_id"]) === undefined ? {} : { responseId: stringField(record["response_id"]) }),
      ...(numberField(record["response_index"]) === undefined
        ? {}
        : { responseIndex: numberField(record["response_index"]) }),
    };
  }

  const stopped = frame["response.stopped"];
  if (stopped && typeof stopped === "object" && !Array.isArray(stopped)) {
    const record = stopped as Record<string, unknown>;
    return {
      kind: "stopped",
      ...(stringField(record["response_id"]) === undefined ? {} : { responseId: stringField(record["response_id"]) }),
    };
  }

  const info = frame["response.info"];
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const record = info as Record<string, unknown>;
    return {
      kind: "info",
      action: stringField(record["action"]) ?? "unknown",
      ...(stringField(record["response_id"]) === undefined ? {} : { responseId: stringField(record["response_id"]) }),
    };
  }

  const selectedModelId = stringField(frame["selected_model_id"]);
  // A citations frame also carries a role-only choice (recon §1.4); it is not content and has its
  // own kind, so it is classified before the generic delta branch.
  const choices = frame["choices"];
  const sources = frame["sources"] !== undefined;
  if (sources && Array.isArray(choices)) {
    const only = choices[0];
    const delta = (only && typeof only === "object" ? (only as Record<string, unknown>)["delta"] : undefined);
    const record = (delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {}) as Record<string, unknown>;
    const carriesOutput = (stringField(record["content"]) ?? "").length > 0
      || record["phase"] !== undefined
      || record["status"] !== undefined;
    if (!carriesOutput && selectedModelId === undefined) {
      return { kind: "sources", ...(responseId === undefined ? {} : { responseId }) };
    }
  }
  if (sources && !Array.isArray(choices)) {
    return { kind: "sources", ...(responseId === undefined ? {} : { responseId }) };
  }
  if (Array.isArray(choices) && choices.length > 0) {
    // The recorded stream carries one choice per frame; a second choice would be another
    // completion's output, which this product does not ask for.
    const choice = choices[0];
    const delta = (choice && typeof choice === "object" ? (choice as Record<string, unknown>)["delta"] : undefined);
    const record = (delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {}) as Record<string, unknown>;
    const content = stringField(record["content"]) ?? "";
    const phase = stringField(record["phase"]);
    const status = stringField(record["status"]);
    const role = stringField(record["role"]);
    // `selected_model_id` + a role-only choice is the app's re-route envelope; a frame that carries
    // content is a delta even when it also names the model, so no output is ever lost.
    if (selectedModelId !== undefined && content.length === 0 && phase === undefined && status === undefined) {
      return { kind: "selected_model", selectedModelId, ...(responseId === undefined ? {} : { responseId }) };
    }
    return {
      kind: "delta",
      ...(responseId === undefined ? {} : { responseId }),
      ...(role === undefined ? {} : { role }),
      content,
      ...(status === undefined ? {} : { status }),
      ...(phase === undefined ? {} : { phase }),
      ...(selectedModelId === undefined ? {} : { selectedModelId }),
    };
  }

  if (selectedModelId !== undefined) {
    return { kind: "selected_model", selectedModelId, ...(responseId === undefined ? {} : { responseId }) };
  }
  if (frame["sources"] !== undefined) {
    return { kind: "sources", ...(responseId === undefined ? {} : { responseId }) };
  }

  // A frame with a `timestamp`/`usage` only, or a future sibling of the modelled kinds.
  return { kind: "unknown", payload: trimmed };
}

/**
 * An incremental SSE parser.
 *
 * `push(chunk)` accepts one network chunk at a time — chunk boundaries fall anywhere, including in
 * the middle of `data:` — and returns every frame completed by that chunk. `end()` flushes a final
 * event that arrived without its trailing blank line. Nothing here is stateful across turns.
 */
export class QwenChatSseParser {
  #buffer = "";
  /** A chunk may end in the middle of a CRLF; the CR is held until the next chunk decides it. */
  #pendingCarriageReturn = false;

  /** Feed one decoded chunk; returns the frames it completed. */
  push(chunk: string): QwenChatSseFrame[] {
    let text = chunk;
    if (this.#pendingCarriageReturn) {
      text = `\r${text}`;
      this.#pendingCarriageReturn = false;
    }
    if (text.endsWith("\r")) {
      this.#pendingCarriageReturn = true;
      text = text.slice(0, -1);
    }
    this.#buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: QwenChatSseFrame[] = [];
    for (;;) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const event = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      frames.push(...this.#parseEvent(event));
    }
    return frames;
  }

  /** Flush the trailing event, if the stream ended without a blank line. Idempotent. */
  end(): QwenChatSseFrame[] {
    if (this.#pendingCarriageReturn) {
      this.#pendingCarriageReturn = false;
      this.#buffer += "\n";
    }
    const event = this.#buffer;
    this.#buffer = "";
    return this.#parseEvent(event);
  }

  #parseEvent(event: string): QwenChatSseFrame[] {
    // An event may carry several `data:` lines, which SSE joins with a newline. Field lines other
    // than `data:` (id/event/comment) are not part of this vocabulary and are ignored.
    const dataLines: string[] = [];
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      // One optional space after the colon is part of the SSE framing, not the payload.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return [];
    return [parseQwenChatSsePayload(dataLines.join("\n"))];
  }
}

/** The accumulated answer of one streamed turn, plus the signal that ended it. */
export interface QwenChatCompletionResult {
  /** The `response.created` chat id, when the stream announced one. */
  readonly chatId?: string;
  /**
   * The `response.created` parent cursor, when the stream announced one.
   *
   * It is the message this response hangs off; {@link responseId} is the cursor the **next** turn
   * should use, which is why both are kept instead of collapsed.
   */
  readonly parentId?: string;
  /** The response id the deltas belong to (the assistant message id the next turn hangs off). */
  readonly responseId?: string;
  /** The response index, when the stream announced one. Diagnostics and continuity only. */
  readonly responseIndex?: number;
  /**
   * The model the server actually used, when it re-routed the turn.
   *
   * `undefined` means the server never said, i.e. the requested model is the one that answered.
   */
  readonly selectedModelId?: string;
  /** The concatenated answer text (assistant deltas only; see `includeFunctionOutput`). */
  readonly text: string;
  /** Which signal ended the loop. */
  readonly termination: QwenChatTermination;
  /** The `status` that closed the turn, when `termination` is `delta_status`. */
  readonly terminalStatus?: string;
  /** The provider's in-band error, when `termination` is `error`. Never a credential. */
  readonly error?: { readonly message?: string; readonly code?: string; readonly status?: number };
  /** Whether the stream carried at least one `sources` frame (web-search citations). */
  readonly sources: boolean;
  /** Frames consumed, for diagnostics. */
  readonly frames: number;
}

/** Construction options for {@link createQwenChatCompletionAccumulator}. */
export interface QwenChatCompletionAccumulatorOptions {
  /** Called with each piece of content that enters the answer, in order. */
  readonly onDelta?: (text: string) => void;
  /**
   * Whether `role:"function"` output is part of the answer. Default `false`.
   *
   * The same rule the Qwen Code adapter applies: agent-environment chatter is not the caller's
   * answer. For a plain chat turn the role is normally `assistant`, so this only matters if the
   * server ever interleaves a tool/function frame.
   */
  readonly includeFunctionOutput?: boolean;
}

/** The accumulator: push frames, learn whether the turn ended, read the result at any time. */
export interface QwenChatCompletionAccumulator {
  /** Consume one frame. Returns `true` once a terminal signal was observed. */
  push(frame: QwenChatSseFrame): boolean;
  /** Consume the stream's end. Returns the result; idempotent. */
  finish(): QwenChatCompletionResult;
  /** The result so far, without terminating the loop. */
  snapshot(): QwenChatCompletionResult;
  /** Whether a terminal signal was already observed. */
  readonly done: boolean;
}

/**
 * Build one turn's completion accumulator.
 *
 * The rules below are the recon's, not a preference:
 *
 * - `phase:"KeepAlive"` is ignored completely (no content, no status, no termination);
 * - a non-`function` delta whose `status` is present and other than `typing` ends the turn;
 * - `response.stopped`, `[DONE]` and an in-band `error` are terminal;
 * - `response.info` is never terminal (only `response.stopped` is, in the recorded frame set);
 * - `selected_model_id` is surfaced, never used to rewrite the requested model.
 */
export function createQwenChatCompletionAccumulator(
  options: QwenChatCompletionAccumulatorOptions = {},
): QwenChatCompletionAccumulator {
  const includeFunctionOutput = options.includeFunctionOutput === true;
  const onDelta = options.onDelta;
  const parts: string[] = [];
  let chatId: string | undefined;
  let parentId: string | undefined;
  let responseId: string | undefined;
  let responseIndex: number | undefined;
  let selectedModelId: string | undefined;
  let termination: QwenChatTermination | undefined;
  let terminalStatus: string | undefined;
  let error: QwenChatCompletionResult["error"];
  let sources = false;
  let frames = 0;

  const result = (): QwenChatCompletionResult => ({
    ...(chatId === undefined ? {} : { chatId }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(responseIndex === undefined ? {} : { responseIndex }),
    ...(selectedModelId === undefined ? {} : { selectedModelId }),
    text: parts.join(""),
    termination: termination ?? "stream_end",
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    ...(error === undefined ? {} : { error }),
    sources,
    frames,
  });

  return {
    get done() {
      return termination !== undefined;
    },
    push(frame: QwenChatSseFrame): boolean {
      if (termination !== undefined) return true;
      frames += 1;
      switch (frame.kind) {
        case "created":
          chatId ??= frame.chatId;
          parentId ??= frame.parentId;
          responseId ??= frame.responseId;
          responseIndex ??= frame.responseIndex;
          return false;
        case "delta": {
          // The app's keep-alive handler returns null: this phase produces no content, closes
          // nothing, and must never be mistaken for a finished answer.
          if (frame.phase === "KeepAlive") return false;
          if (frame.selectedModelId !== undefined) selectedModelId ??= frame.selectedModelId;
          if (frame.responseId !== undefined) responseId ??= frame.responseId;
          const isFunction = frame.role === "function";
          if ((!isFunction || includeFunctionOutput) && frame.content.length > 0) {
            parts.push(frame.content);
            onDelta?.(frame.content);
          }
          if (!isFunction && frame.status !== undefined && frame.status !== "typing") {
            termination = "delta_status";
            terminalStatus = frame.status;
            return true;
          }
          return false;
        }
        case "selected_model":
          selectedModelId ??= frame.selectedModelId;
          if (frame.responseId !== undefined) responseId ??= frame.responseId;
          return false;
        case "info":
          // `skip_think` is the app's special-cased control action. No control frame terminates the
          // turn: the recorded terminators are `[DONE]`, `response.stopped` and `status:"finished"`.
          return false;
        case "sources":
          sources = true;
          if (frame.responseId !== undefined) responseId ??= frame.responseId;
          return false;
        case "stopped":
          if (frame.responseId !== undefined) responseId ??= frame.responseId;
          termination = "response_stopped";
          return true;
        case "done":
          termination = "done";
          return true;
        case "error":
          if (frame.responseId !== undefined) responseId ??= frame.responseId;
          error = {
            ...(frame.message === undefined ? {} : { message: frame.message }),
            ...(frame.code === undefined ? {} : { code: frame.code }),
            ...(frame.status === undefined ? {} : { status: frame.status }),
          };
          termination = "error";
          return true;
        default:
          return false;
      }
    },
    finish(): QwenChatCompletionResult {
      termination ??= "stream_end";
      return result();
    },
    snapshot(): QwenChatCompletionResult {
      return result();
    },
  };
}
