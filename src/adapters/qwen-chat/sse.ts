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
 * ## Which `status` closes the turn, and which only closes a phase
 *
 * Recon §1.4 lists the status enum as `typing|waiting_input|finished|error|pause` and names
 * `finished` as the terminal one. The vendor bundle (`main.js` 0.3.20) and the operator's recorded
 * turn (28 frames: 25 `typing`, 2 `finished`; 5 `thinking_summary` deltas followed by 22 `answer`
 * deltas) are more precise, and the difference is what used to end a turn before its answer arrived:
 *
 * - the vendor's stream generator yields `done` only for `[DONE]`, `response.stopped`, an in-band
 *   `error` and the reader closing — never for a delta `status` (`tH`, `pX`);
 * - a delta `status` closes the **phase the delta belongs to**, not the turn: the merge rules stop
 *   merging a phase's frames once its status leaves `typing` (`or.shouldMerge`, `cr.shouldMerge`),
 *   and the UI's own `FINISHED` state is read from the stream's `done`, not from a delta status;
 * - the recorded turn's **first `finished` closes `thinking_summary`**, before any `answer` delta:
 *   the reasoning phase's status is a phase close, and the answer follows it;
 * - `waiting_input` frames are dropped outright (`ar`: `phase` valid && `status === waiting_input`
 *   → no content entry), i.e. they are not content and not terminal either.
 *
 * ## Which content is the answer
 *
 * The answer is the `answer` phase's text (and a phase-less delta's, which the app appends straight
 * to the message content). The reasoning phases (`think`, `thinking_summary`) stream the model
 * thinking aloud, and the tool/search phases stream their own progress; those characters are counted
 * for the turn's diagnostics and are **not** returned as the caller's answer. The recorded turn
 * carried five empty `thinking_summary` deltas before the answer, so this distinction is what keeps
 * a reasoning phase from being mistaken for the reply.
 *
 * This module is pure: no browser, no network, no provider page. It is testable against a recorded
 * chunked fixture without Chromium.
 */
import { sanitizedBodyFragment, truncateWithEllipsis } from "../refusal-evidence";

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

/**
 * The one delta `status` that can close a turn, of the enum recons §1.4 records
 * (`typing|waiting_input|finished|error|pause`).
 */
export const QWEN_CHAT_TERMINAL_STATUS = "finished";

/**
 * The phases whose `finished` closes the turn, and whose content is the caller's answer.
 *
 * The vendor bundle's own answer phases (`Oi = [answer, slides]`); every other phase it streams
 * (`think`, `thinking_summary`, `web_search`, the tool phases) closes mid-turn.
 */
export const QWEN_CHAT_ANSWER_PHASES: readonly string[] = ["answer", "slides"];

/**
 * The phases that carry the model's reasoning rather than its answer (bundle `Di`).
 *
 * The operator's recorded turn (28 frames) streams five `thinking_summary` deltas and then the
 * twenty-two `answer` deltas; the summary is the model thinking aloud, not the reply.
 */
export const QWEN_CHAT_REASONING_PHASES: readonly string[] = ["think", "thinking_summary"];

/**
 * Whether a delta's `status` closes the **turn** rather than only the phase it belongs to.
 *
 * `turnHasContent` is whether this turn has already produced any answer text, this frame's own
 * content included: a phase-less `finished` is trusted only once content has actually arrived, so a
 * role-only opening frame can never end the stream with nothing in it.
 */
export function qwenChatDeltaClosesTurn(
  delta: { readonly phase?: string; readonly status?: string },
  turnHasContent: boolean,
): boolean {
  if (delta.status !== QWEN_CHAT_TERMINAL_STATUS) return false;
  if (delta.phase !== undefined) return QWEN_CHAT_ANSWER_PHASES.includes(delta.phase);
  return turnHasContent;
}

/**
 * Whether a delta's content is the caller's **answer**.
 *
 * Only the answer phases (`answer`/`slides`) and a phase-less delta (which the app appends straight
 * to the message content) are the reply. A reasoning phase's text is the model thinking aloud and a
 * tool/search phase's text is its own progress: both are counted for the turn's diagnostics and
 * never returned as the answer. That is a product decision (text-only chat), and it is the rule the
 * recorded turn needs — the reasoning phase's `finished` closes that phase, and the answer follows.
 */
export function qwenChatDeltaCarriesAnswer(delta: { readonly phase?: string }): boolean {
  return delta.phase === undefined || QWEN_CHAT_ANSWER_PHASES.includes(delta.phase);
}

/** How deep a frame's structural shape descends before it is cut. */
const QWEN_CHAT_FRAME_SHAPE_DEPTH = 4;
/** How many keys of one object the shape names before it is cut. */
const QWEN_CHAT_FRAME_SHAPE_KEYS = 12;
/** The longest one frame's shape may be. */
export const QWEN_CHAT_FRAME_SHAPE_CHARS = 120;
/** The longest one shape may be inside a diagnostic sentence. */
const QWEN_CHAT_SHAPE_IN_MESSAGE_CHARS = 60;
/** How many distinct shapes one diagnostic names (the rest are counted, not listed). */
export const QWEN_CHAT_SHAPES_SHOWN = 6;
/** How many shapes' worth of structure one diagnostic sentence may spend. */
const QWEN_CHAT_EMPTY_STREAM_MESSAGE_CHARS = 760;
/** How much raw payload a shape/fragment keeps before it is reduced. */
const QWEN_CHAT_SHAPE_PAYLOAD_CHARS = 2_000;

/** A JSON key name the shape may print; anything else is anonymised. */
function printableShapeKey(key: string): string {
  return /^[A-Za-z0-9_.$-]{1,48}$/.test(key) ? key : "?";
}

/**
 * One frame's structural shape: **key paths and value kinds only, never a value**.
 *
 * The same idea as `scripts/har-shape.mjs`'s SSE frame shapes (leaf names, nested structure, array
 * element kinds; values never stored), small enough to ride inside one diagnostic sentence. A
 * credential cannot appear here because no value does.
 */
export function qwenChatFrameShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (depth >= QWEN_CHAT_FRAME_SHAPE_DEPTH) return "[…]";
    const elements = [...new Set(value.slice(0, 3).map(element => qwenChatFrameShape(element, depth + 1)))];
    return `[${elements.join("|")}]`;
  }
  if (typeof value === "object") {
    if (depth >= QWEN_CHAT_FRAME_SHAPE_DEPTH) return "{…}";
    const entries = Object.entries(value as Record<string, unknown>);
    const parts: string[] = [];
    for (const [key, child] of entries.slice(0, QWEN_CHAT_FRAME_SHAPE_KEYS)) {
      const nested = child !== null && typeof child === "object";
      parts.push(nested ? `${printableShapeKey(key)}: ${qwenChatFrameShape(child, depth + 1)}` : printableShapeKey(key));
    }
    if (entries.length > QWEN_CHAT_FRAME_SHAPE_KEYS) parts.push("…");
    return `{${parts.join(", ")}}`;
  }
  return typeof value;
}

/** One distinct frame shape and how many frames had it. */
export interface QwenChatFrameShapeCount {
  /** Key paths and value kinds only; never a value. */
  readonly shape: string;
  readonly count: number;
}

/**
 * What one stream's frames looked like, structurally — the evidence an empty answer needs.
 *
 * `shapes` is ordered by how often a shape occurred, so the shape that dominated the turn is named
 * first. `fragment` is the one short, redacted payload allowed beside the shape names: the last frame
 * the parser could not model at all — the frame a reader cannot interpret — and nothing when every
 * frame was understood (a modelled frame's values are never echoed).
 */
export interface QwenChatStreamObservation {
  /** Frames the parser completed. */
  readonly frames: number;
  /** Distinct structural shapes with their counts. */
  readonly shapes: readonly QwenChatFrameShapeCount[];
  /** Delta frames seen at all. */
  readonly deltaFrames: number;
  /** Delta frames that carried a `content` field at all, of any type. */
  readonly contentDeltas: number;
  /** Delta frames whose `content` was present but not a string. */
  readonly contentNonString: number;
  /** Characters that arrived in phases that are not the answer (reasoning, tools, search). */
  readonly excludedChars: number;
  /** Of {@link excludedChars}, the characters that arrived in a reasoning phase. */
  readonly reasoningChars: number;
  /** One short, redacted payload of the last frame the parser could not model. */
  readonly fragment?: string;
}

/** One payload read into a frame, plus the shape facts the stream observation keeps. */
interface QwenChatReadFrame {
  readonly frame: QwenChatSseFrame;
  /** The payload's structural shape, from {@link qwenChatFrameShape}. */
  readonly shape: string;
  /** Whether the delta carried a `content` field at all (any type). */
  readonly contentField: boolean;
  /** Whether that `content` field held a string. */
  readonly contentIsString: boolean;
}

/** Assemble one read frame; only the delta branch passes content facts. */
function readFrame(
  frame: QwenChatSseFrame,
  shape: string,
  contentField = false,
  contentIsString = false,
): QwenChatReadFrame {
  return { frame, shape, contentField, contentIsString };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse one already-assembled `data:` payload. Exported for frame-by-frame fixtures. */
export function parseQwenChatSsePayload(payload: string): QwenChatSseFrame {
  return readQwenChatPayload(payload).frame;
}

/**
 * Read one payload into its frame **and** the shape facts a stream observation keeps.
 *
 * The shape is computed from the raw decoded payload, so a frame whose answer text lives somewhere
 * this vocabulary does not model is still describable by its key paths.
 */
function readQwenChatPayload(payload: string): QwenChatReadFrame {
  const trimmed = payload.trim();
  if (trimmed === "[DONE]") return readFrame({ kind: "done" }, "[DONE]");
  if (trimmed.length === 0) return readFrame({ kind: "unknown", payload: "" }, "<empty>");
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    // A truncated payload is reported, never guessed. The stream ending is a termination signal of
    // its own, so an unmodelled payload does not have to be fatal.
    return readFrame({ kind: "unknown", payload: trimmed }, "<unparsable>");
  }
  if (!decoded || typeof decoded !== "object") return readFrame({ kind: "unknown", payload: trimmed }, "<non-object>");
  const shape = truncateWithEllipsis(qwenChatFrameShape(decoded), QWEN_CHAT_FRAME_SHAPE_CHARS);
  const frame = decoded as Record<string, unknown>;
  const responseId = stringField(frame["response_id"]);

  const error = frame["error"];
  if (error !== undefined && error !== null) {
    const record = (typeof error === "object" && !Array.isArray(error) ? error : {}) as Record<string, unknown>;
    return readFrame({
      kind: "error",
      ...(responseId === undefined ? {} : { responseId }),
      ...(stringField(record["message"]) === undefined ? {} : { message: stringField(record["message"]) }),
      ...(stringField(record["code"]) === undefined ? {} : { code: stringField(record["code"]) }),
      ...(numberField(record["status"]) === undefined ? {} : { status: numberField(record["status"]) }),
    }, shape);
  }

  const created = frame["response.created"];
  if (created && typeof created === "object" && !Array.isArray(created)) {
    const record = created as Record<string, unknown>;
    return readFrame({
      kind: "created",
      ...(stringField(record["chat_id"]) === undefined ? {} : { chatId: stringField(record["chat_id"]) }),
      ...(stringField(record["parent_id"]) === undefined ? {} : { parentId: stringField(record["parent_id"]) }),
      ...(stringField(record["response_id"]) === undefined ? {} : { responseId: stringField(record["response_id"]) }),
      ...(numberField(record["response_index"]) === undefined
        ? {}
        : { responseIndex: numberField(record["response_index"]) }),
    }, shape);
  }

  const stopped = frame["response.stopped"];
  if (stopped && typeof stopped === "object" && !Array.isArray(stopped)) {
    const record = stopped as Record<string, unknown>;
    return readFrame({
      kind: "stopped",
      ...(stringField(record["response_id"]) === undefined ? {} : { responseId: stringField(record["response_id"]) }),
    }, shape);
  }

  const info = frame["response.info"];
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const record = info as Record<string, unknown>;
    return readFrame({
      kind: "info",
      action: stringField(record["action"]) ?? "unknown",
      ...(stringField(record["response_id"]) === undefined ? {} : { responseId: stringField(record["response_id"]) }),
    }, shape);
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
      return readFrame({ kind: "sources", ...(responseId === undefined ? {} : { responseId }) }, shape);
    }
  }
  if (sources && !Array.isArray(choices)) {
    return readFrame({ kind: "sources", ...(responseId === undefined ? {} : { responseId }) }, shape);
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
      return readFrame({ kind: "selected_model", selectedModelId, ...(responseId === undefined ? {} : { responseId }) }, shape);
    }
    // "The delta carried a content field at all" is a shape fact, not a text fact: a delta whose
    // `content` is an array, a number or `null` has content the vocabulary could not read, and the
    // empty-answer diagnostic has to be able to say so.
    return readFrame(
      {
        kind: "delta",
        ...(responseId === undefined ? {} : { responseId }),
        ...(role === undefined ? {} : { role }),
        content,
        ...(status === undefined ? {} : { status }),
        ...(phase === undefined ? {} : { phase }),
        ...(selectedModelId === undefined ? {} : { selectedModelId }),
      },
      shape,
      Object.prototype.hasOwnProperty.call(record, "content"),
      typeof record["content"] === "string",
    );
  }

  if (selectedModelId !== undefined) {
    return readFrame({ kind: "selected_model", selectedModelId, ...(responseId === undefined ? {} : { responseId }) }, shape);
  }
  if (frame["sources"] !== undefined) {
    return readFrame({ kind: "sources", ...(responseId === undefined ? {} : { responseId }) }, shape);
  }

  // A frame with a `timestamp`/`usage` only, or a future sibling of the modelled kinds.
  return readFrame({ kind: "unknown", payload: trimmed }, shape);
}

/**
 * An incremental SSE parser.
 *
 * `push(chunk)` accepts one network chunk at a time — chunk boundaries fall anywhere, including in
 * the middle of `data:` — and returns every frame completed by that chunk. `end()` flushes a final
 * event that arrived without its trailing blank line. Nothing here is stateful across turns.
 *
 * It is also the turn's **frame witness**: {@link QwenChatSseParser.observation} reports the frame
 * count, the distinct structural shapes, the delta/content facts and one redacted fragment of the
 * frame it could not model. That is what makes a completed-but-empty answer diagnosable without a
 * second capture.
 */
export class QwenChatSseParser {
  #buffer = "";
  /** A chunk may end in the middle of a CRLF; the CR is held until the next chunk decides it. */
  #pendingCarriageReturn = false;
  #frames = 0;
  #deltaFrames = 0;
  #contentDeltas = 0;
  #contentNonString = 0;
  #excludedChars = 0;
  #reasoningChars = 0;
  readonly #shapes = new Map<string, number>();
  /** The last payload this parser could not model, bounded; the one permitted fragment. */
  #unread: string | undefined;

  /** What this stream's frames looked like so far, structurally and without values. */
  observation(): QwenChatStreamObservation {
    const shapes = [...this.#shapes.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([shape, count]) => ({ shape, count }));
    const fragment = this.#unread === undefined ? undefined : sanitizedBodyFragment(this.#unread);
    return {
      frames: this.#frames,
      shapes,
      deltaFrames: this.#deltaFrames,
      contentDeltas: this.#contentDeltas,
      contentNonString: this.#contentNonString,
      excludedChars: this.#excludedChars,
      reasoningChars: this.#reasoningChars,
      ...(fragment === undefined || fragment.length === 0 ? {} : { fragment }),
    };
  }

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
    const payload = dataLines.join("\n");
    const read = readQwenChatPayload(payload);
    this.#witness(payload, read);
    return [read.frame];
  }

  /** Record one completed frame's structural evidence. Values are never stored here. */
  #witness(payload: string, read: QwenChatReadFrame): void {
    this.#frames += 1;
    this.#shapes.set(read.shape, (this.#shapes.get(read.shape) ?? 0) + 1);
    if (read.frame.kind === "unknown") this.#unread = payload.slice(0, QWEN_CHAT_SHAPE_PAYLOAD_CHARS);
    if (read.frame.kind === "delta") {
      this.#deltaFrames += 1;
      if (read.contentField) this.#contentDeltas += 1;
      if (read.contentField && !read.contentIsString) this.#contentNonString += 1;
      // Content that is not the answer is counted, never dropped silently: an empty answer that
      // carried reasoning is a different failure from a stream that carried nothing at all.
      const content = read.frame.content;
      if (content.length > 0 && !qwenChatDeltaCarriesAnswer(read.frame)) {
        this.#excludedChars += content.length;
        if (read.frame.phase !== undefined && QWEN_CHAT_REASONING_PHASES.includes(read.frame.phase)) {
          this.#reasoningChars += content.length;
        }
      }
    }
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
 * The rules below are the recon's, the bundle's and the recorded turn's, not a preference:
 *
 * - `phase:"KeepAlive"` is ignored completely (no content, no status, no termination);
 * - only a `status:"finished"` delta can end the turn, and only when it closes the answer phase or
 *   (with no phase) once the answer has content — see {@link qwenChatDeltaClosesTurn};
 * - only the answer phases (`answer`/`slides`) and phase-less deltas contribute text — see
 *   {@link qwenChatDeltaCarriesAnswer};
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
          // The answer is the `answer` phase's text (and a phase-less delta's); the reasoning phases
          // stream the model thinking aloud, which this text-only bridge does not return.
          if ((!isFunction || includeFunctionOutput)
            && qwenChatDeltaCarriesAnswer(frame)
            && frame.content.length > 0) {
            parts.push(frame.content);
            onDelta?.(frame.content);
          }
          if (!isFunction && qwenChatDeltaClosesTurn(frame, parts.length > 0)) {
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
          // turn: the recorded terminators are `[DONE]`, `response.stopped` and an answer-closing
          // `status:"finished"` (see `qwenChatDeltaClosesTurn`).
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

/** The structured evidence an empty-answer failure carries, in the message and in its log line. */
export interface QwenChatEmptyStreamDetail {
  /** The operator-facing sentence: frame count, shapes with counts, the ending signal, content facts. */
  readonly message: string;
  /** The same facts as structured detail, already bounded and free of values. */
  readonly detail: Record<string, unknown>;
}

/**
 * Describe a stream that completed **without any extracted answer text**.
 *
 * Four facts, in the operator's words and in the structured detail, because each one eliminates a
 * different cause: how many frames arrived (a stream that ended immediately is not a parse bug), the
 * distinct shapes with their counts (key paths only — the answer may be in a shape this vocabulary
 * does not read), which signal ended the stream, and how many delta frames carried a `content` field
 * at all (content that arrived but was not a string is a different failure from content that never
 * arrived). At most one short, redacted payload fragment rides along: the last frame the parser could
 * not model.
 */
export function qwenChatEmptyStreamSummary(input: {
  readonly observation: QwenChatStreamObservation;
  readonly termination: QwenChatTermination;
  readonly terminalStatus?: string;
}): QwenChatEmptyStreamDetail {
  const { observation, termination, terminalStatus } = input;
  const shown = observation.shapes.slice(0, QWEN_CHAT_SHAPES_SHOWN);
  const hidden = observation.shapes.length - shown.length;
  const shapesInMessage = shown
    .map(entry => `${truncateWithEllipsis(entry.shape, QWEN_CHAT_SHAPE_IN_MESSAGE_CHARS)}×${entry.count}`)
    .join(", ");
  const ending = termination === "delta_status" && terminalStatus !== undefined
    ? `${termination} ("${truncateWithEllipsis(terminalStatus, 24)}")`
    : termination;
  const contentClause = observation.deltaFrames === 0
    ? "no delta frames arrived at all"
    : `${observation.contentDeltas} of ${observation.deltaFrames} delta frames carried a content field`
      + (observation.contentNonString === 0
        ? ""
        : `, and ${observation.contentNonString} of those held something that was not a string`)
      + (observation.excludedChars === 0
        ? ""
        : `; ${observation.excludedChars} characters arrived in phases that are not the answer`
          + (observation.reasoningChars === 0 ? "" : ` (${observation.reasoningChars} of them reasoning)`));

  const sentences = [
    `Qwen Chat completed the stream without extracting any answer text: ${observation.frames} frames seen`,
    observation.shapes.length === 0
      ? "and the stream carried no readable frames at all"
      : `in ${observation.shapes.length} distinct shape${observation.shapes.length === 1 ? "" : "s"}: ${shapesInMessage}${hidden > 0 ? ` (+${hidden} more)` : ""}`,
    `the stream ended by ${ending}`,
    contentClause,
  ];
  const fragment = observation.fragment;
  const message = truncateWithEllipsis(
    `${sentences.slice(0, 2).join(", ")}; ${sentences.slice(2).join("; ")}`
    + (fragment === undefined ? "" : `. Last unmodelled frame: ${fragment}`),
    QWEN_CHAT_EMPTY_STREAM_MESSAGE_CHARS,
  );

  return {
    message,
    detail: {
      kind: "empty-stream",
      termination,
      ...(terminalStatus === undefined ? {} : { terminalStatus }),
      frames: observation.frames,
      shapes: shown.map(entry => ({
        shape: truncateWithEllipsis(entry.shape, QWEN_CHAT_FRAME_SHAPE_CHARS),
        count: entry.count,
      })),
      shapesTotal: observation.shapes.length,
      deltaFrames: observation.deltaFrames,
      contentDeltas: observation.contentDeltas,
      contentNonString: observation.contentNonString,
      excludedChars: observation.excludedChars,
      reasoningChars: observation.reasoningChars,
      ...(fragment === undefined ? {} : { fragment }),
    },
  };
}
