/**
 * The `text/event-stream` vocabulary of a Qwen Code task (issue #299, slice 1).
 *
 * Captured shape (keys only; the capture's own values are not reproduced here):
 *
 * ```text
 * data: {"response.created":{"chat_id","parent_id","response_id"}}
 * data: {"choices":[{"delta":{"role","content","phase","status","extra"}}],"response_id","timestamp"}
 * data: {"response.info":{"action","chat_id","response_id","timestamp"}}
 * ```
 *
 * Two facts from the capture drive the rules below:
 *
 * 1. `delta.status` is `"typing"` while a phase is producing and leaves it (`"finished"`) when that
 *    phase is done — but **every phase** ends that way, and `role:"function"` frames are the agent's
 *    environment chatter (`create_env`, shell actions), not the answer. So a `function` frame leaving
 *    `typing` is *not* the turn's completion, and its content is excluded from the answer text.
 * 2. `response.info` is mostly `keep_alive`; any other action is terminal.
 *
 * Termination is therefore three distinct, separately observable signals — `delta_status`,
 * `response_info` and `stream_end` — and the accumulator reports which one fired instead of
 * pretending they are interchangeable.
 *
 * This module is pure (no browser, no network, no provider page) so the parser is testable against a
 * chunked fixture without Chromium.
 */

/** One parsed frame of a task stream. */
export type QwenSseFrame =
  /** The stream announced the turn it is answering (`chat_id`, parent cursor, response id). */
  | { readonly kind: "created"; readonly chatId?: string; readonly parentId?: string; readonly responseId?: string }
  /** One incremental output delta. `content` is '' when the frame carries none. */
  | {
    readonly kind: "delta";
    readonly responseId?: string;
    readonly role?: string;
    readonly content: string;
    readonly status?: string;
    readonly phase?: string;
  }
  /** A control frame (`keep_alive`, and any terminal action the service may send). */
  | { readonly kind: "info"; readonly action: string; readonly chatId?: string; readonly responseId?: string }
  /** A `data:` payload this parser does not model. Kept so a new frame cannot be silently dropped. */
  | { readonly kind: "unknown"; readonly payload: string };

/** Why the completion loop stopped. Each value is a distinct observable signal. */
export const QWEN_COMPLETION_TERMINATIONS = ["delta_status", "response_info", "stream_end"] as const;

/** One termination signal. */
export type QwenCompletionTermination = (typeof QWEN_COMPLETION_TERMINATIONS)[number];

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse one already-assembled `data:` payload.
 *
 * Exported because a recorded fixture can be asserted frame by frame without the chunking logic.
 */
export function parseQwenSsePayload(payload: string): QwenSseFrame {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return { kind: "unknown", payload: "" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    // A `[DONE]` sentinel or a truncated payload: never guessed, never fatal. Stream end is a
    // termination signal of its own, so an unmodelled payload is reported and the loop continues.
    return { kind: "unknown", payload: trimmed };
  }
  if (!decoded || typeof decoded !== "object") return { kind: "unknown", payload: trimmed };
  const frame = decoded as Record<string, unknown>;

  const created = frame["response.created"];
  if (created && typeof created === "object") {
    const record = created as Record<string, unknown>;
    return {
      kind: "created",
      chatId: stringField(record["chat_id"]),
      parentId: stringField(record["parent_id"]),
      responseId: stringField(record["response_id"]),
    };
  }

  const info = frame["response.info"];
  if (info && typeof info === "object") {
    const record = info as Record<string, unknown>;
    return {
      kind: "info",
      action: stringField(record["action"]) ?? "unknown",
      chatId: stringField(record["chat_id"]),
      responseId: stringField(record["response_id"]),
    };
  }

  const choices = frame["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    // The captured stream carries exactly one choice per frame; the first one is the turn's output
    // and the rest would be another completion's delta, which this product does not ask for.
    const choice = choices[0];
    const delta = (choice && typeof choice === "object" ? (choice as Record<string, unknown>)["delta"] : undefined);
    const record = (delta && typeof delta === "object" ? delta : {}) as Record<string, unknown>;
    return {
      kind: "delta",
      responseId: stringField(frame["response_id"]),
      role: stringField(record["role"]),
      content: stringField(record["content"]) ?? "",
      status: stringField(record["status"]),
      phase: stringField(record["phase"]),
    };
  }

  // A frame with a `timestamp`/`usage` only, or a future sibling of the three modelled kinds.
  return { kind: "unknown", payload: trimmed };
}

/**
 * An incremental SSE parser.
 *
 * `push(chunk)` accepts one network chunk at a time — chunk boundaries fall anywhere, including in
 * the middle of `data:` — and returns every frame completed by that chunk. `end()` flushes a final
 * event that arrived without its trailing blank line. Nothing here is stateful across turns.
 */
export class QwenSseParser {
  #buffer = "";
  /** A chunk may end in the middle of a CRLF; the CR is held until the next chunk decides it. */
  #pendingCarriageReturn = false;

  /** Feed one decoded chunk; returns the frames it completed. */
  push(chunk: string): QwenSseFrame[] {
    let text = chunk;
    if (this.#pendingCarriageReturn) {
      text = `\r${text}`;
      this.#pendingCarriageReturn = false;
    }
    if (text.endsWith("\r")) {
      this.#pendingCarriageReturn = true;
      text = text.slice(0, -1);
    }
    // Both CRLF and a lone CR are SSE line endings; normalising once keeps the split below single-form.
    this.#buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: QwenSseFrame[] = [];
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
  end(): QwenSseFrame[] {
    if (this.#pendingCarriageReturn) {
      this.#pendingCarriageReturn = false;
      this.#buffer += "\n";
    }
    const event = this.#buffer;
    this.#buffer = "";
    return this.#parseEvent(event);
  }

  #parseEvent(event: string): QwenSseFrame[] {
    // An event may carry several `data:` lines, which SSE joins with a newline. Field lines other
    // than `data:` (id/event/comment) are not part of this vocabulary and are ignored.
    const dataLines: string[] = [];
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      // One optional space after the colon is part of the SSE framing, not the payload.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return [];
    return [parseQwenSsePayload(dataLines.join("\n"))];
  }
}

/** The accumulated answer of one streamed turn, plus the signal that ended it. */
export interface QwenCompletionResult {
  /** The `response.created` chat id, when the stream announced one. */
  readonly chatId?: string;
  /** The response id the deltas belong to. */
  readonly responseId?: string;
  /** The concatenated answer text (assistant deltas only; see `includeFunctionOutput`). */
  readonly text: string;
  /** Which signal ended the loop. */
  readonly termination: QwenCompletionTermination;
  /** The `status` that left `typing`, when `termination` is `delta_status`. */
  readonly terminalStatus?: string;
  /** The terminal `response.info` action, when `termination` is `response_info`. */
  readonly terminalAction?: string;
  /** Frames consumed, for diagnostics. */
  readonly frames: number;
}

/** Construction options for {@link createQwenCompletionAccumulator}. */
export interface QwenCompletionAccumulatorOptions {
  /**
   * Whether `role:"function"` output is part of the answer.
   *
   * Default `false`: the captured stream interleaves the agent environment's own progress
   * ("Initializing environment…", shell actions) with the assistant's answer. This product is a
   * text chat, so that scaffolding is not content the caller asked for, and a function frame can
   * never terminate the turn either way.
   */
  readonly includeFunctionOutput?: boolean;
}

/** The accumulator: push frames, learn whether the turn ended, read the result at any time. */
export interface QwenCompletionAccumulator {
  /** Consume one frame. Returns `true` once a terminal signal was observed. */
  push(frame: QwenSseFrame): boolean;
  /** Consume the stream's end. Returns the result; idempotent. */
  finish(): QwenCompletionResult;
  /** The result so far, without terminating the loop. */
  snapshot(): QwenCompletionResult;
  /** Whether a terminal signal was already observed. */
  readonly done: boolean;
}

/**
 * Build one turn's completion accumulator.
 *
 * `delta_status` is decided on the shape, not on a phase: a non-`function` delta whose `status` is
 * present and not `"typing"` ends the turn, because that is the only place the capture shows a phase
 * (and, at the end of the turn, the turn itself) being closed.
 */
export function createQwenCompletionAccumulator(
  options: QwenCompletionAccumulatorOptions = {},
): QwenCompletionAccumulator {
  const includeFunctionOutput = options.includeFunctionOutput === true;
  const parts: string[] = [];
  let chatId: string | undefined;
  let responseId: string | undefined;
  let termination: QwenCompletionTermination | undefined;
  let terminalStatus: string | undefined;
  let terminalAction: string | undefined;
  let frames = 0;

  const result = (): QwenCompletionResult => ({
    ...(chatId === undefined ? {} : { chatId }),
    ...(responseId === undefined ? {} : { responseId }),
    text: parts.join(""),
    termination: termination ?? "stream_end",
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    ...(terminalAction === undefined ? {} : { terminalAction }),
    frames,
  });

  return {
    get done() {
      return termination !== undefined;
    },
    push(frame: QwenSseFrame): boolean {
      if (termination !== undefined) return true;
      frames += 1;
      switch (frame.kind) {
        case "created":
          chatId ??= frame.chatId;
          responseId ??= frame.responseId;
          return false;
        case "info":
          if (frame.action !== "keep_alive") {
            termination = "response_info";
            terminalAction = frame.action;
            return true;
          }
          return false;
        case "delta": {
          const isFunction = frame.role === "function";
          if (!isFunction || includeFunctionOutput) parts.push(frame.content);
          if (frame.responseId !== undefined) responseId ??= frame.responseId;
          if (!isFunction && frame.status !== undefined && frame.status !== "typing") {
            termination = "delta_status";
            terminalStatus = frame.status;
            return true;
          }
          return false;
        }
        default:
          return false;
      }
    },
    finish(): QwenCompletionResult {
      termination ??= "stream_end";
      return result();
    },
    snapshot(): QwenCompletionResult {
      return result();
    },
  };
}
