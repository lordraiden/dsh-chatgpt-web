/**
 * The stream vocabulary of a `chat.deepseek.com` turn: **named SSE events** carrying **JSON patches**.
 *
 * ## What the stream is, as measured
 *
 * Recon §2.4 records the bundle's own `onServerEvent` switch, and that switch is the specification:
 *
 * ```js
 * switch (e.event) {
 *   case "delta":  this.deltaParser.parse(e.data).forEach(…)     // JSON patch frames
 *   case "ready":  {response_message_id, request_message_id, model_type}
 *   case "close":  {click_behavior}                              // "retry" | "none"
 *   case "finish": {…}                                          // terminal
 *   case "title":  {…}
 *   case "toast":  {type, content, finish_reason}
 *   case "update_session":       {updated_at}
 *   case "hint":                 {content, type, clear_response, finish_reason}
 *   case "update_parent_message": {chat_message}
 *   case "update_file":           {…}
 * }
 * // and: if (!e.event && e.data) → treated as an unnamed "delta"
 * ```
 *
 * A `delta` payload is a JSON patch validated by the bundle's own schema:
 *
 * ```js
 * So = Ikc({ p: lqM(YjP()),                                  // path, e.g. "response/fragments/0/content"
 *            o: lqM(KCZ([euz("SET"), euz("BATCH"), euz("APPEND")])),
 *            v: bzn() })
 * ```
 *
 * and applied by `case "SET": d.set(t,l,i)`, `case "APPEND": d.append(t,l,i)`, default → the batch
 * branch. Message content therefore arrives as patches against `response.fragments[i].content`, and
 * the answer is the content of fragments whose `type` is `RESPONSE` (bundle evidence, *not* yet
 * validated on the wire — see `doc/deepseek-web.md` §6).
 *
 * ## The three terminators, and what is *not* one
 *
 * | Signal | Rule implemented |
 * | --- | --- |
 * | `finish` | the named `finish` event |
 * | `close` | the named `close` event, with its `click_behavior` kept |
 * | `stream_end` | the stream ends with neither of the above |
 *
 * There is **no `[DONE]` sentinel anywhere in the bundle** (0 occurrences, recon §2.4). Silence is not
 * a termination signal either: the recorded client runs an `x-ds-sse-heartbeat-timeout-secs`
 * watchdog, so this parser has no "empty for a while means done" rule. `ready`, `title`, `toast`,
 * `hint`, `update_session`, `update_parent_message` and `update_file` are control frames: none of
 * them is content and none of them terminates the turn.
 *
 * ## Refusal, not recovery
 *
 * A malformed patch (a missing path, an unknown operation, a `BATCH` that is not an array, an
 * `APPEND` of a number to text) is a {@link DeepSeekProtocolError}. It is thrown, never skipped and
 * never coerced: skipping a patch corrupts the answer silently, and the answer would then be a
 * plausible-looking lie. The transport turns that error into a typed turn failure.
 *
 * This module is pure: no browser, no network, no provider page. It is testable against a recorded
 * chunked fixture without Chromium.
 */
import {
  DEEPSEEK_WEB_PATCH_OPERATIONS,
  DEEPSEEK_WEB_REASONING_FRAGMENT_TYPE,
  DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE,
  isDeepSeekMessageId,
  isDeepSeekPatchOperation,
  type DeepSeekMessageId,
  type DeepSeekPatchOperation,
} from "./provider";

/** A protocol violation this build refuses to paper over. Always typed, never a silent skip. */
export class DeepSeekProtocolError extends Error {
  /** A stable machine code, so a caller and a test can act on the exact violation. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeepSeekProtocolError";
    this.code = code;
  }
}

/** Build the typed refusal. */
function protocol(code: string, message: string): DeepSeekProtocolError {
  return new DeepSeekProtocolError(code, message);
}

/** One raw SSE event, before it is classified. */
export interface DeepSeekSseRawEvent {
  /** The `event:` field. Absent means the recorded unnamed/unframed delta case. */
  readonly event?: string;
  /** The `id:` field, when the stream carried one. */
  readonly id?: string;
  /** Every `data:` line, joined with `\n` exactly as SSE specifies. */
  readonly data: string;
}

/** The frame vocabulary of one turn. */
export type DeepSeekSseFrame =
  /** One incremental patch. */
  | { readonly kind: "delta"; readonly patch: DeepSeekDeltaPatch }
  /** The stream announced the turn's own message ids and the model that answered. */
  | {
    readonly kind: "ready";
    /** The answer's own id, kept with the scalar the provider sent it as (measured: a number). */
    readonly responseMessageId?: DeepSeekMessageId;
    readonly requestMessageId?: DeepSeekMessageId;
    readonly modelType?: string;
  }
  /** The provider closed the turn and said what the app's retry button should do. */
  | { readonly kind: "close"; readonly clickBehavior?: string }
  /** The provider finished the turn. */
  | { readonly kind: "finish" }
  /** A title frame. Control only: never content. */
  | { readonly kind: "title"; readonly payload: unknown }
  /** A toast. Control only: recorded so a provider message cannot be lost. */
  | {
    readonly kind: "toast";
    readonly type?: string;
    readonly content?: string;
    readonly finishReason?: string;
  }
  /** The provider touched the session's updated-at stamp. Control only. */
  | { readonly kind: "update_session"; readonly updatedAt?: string | number }
  /** A hint. Control only (recon lists no content semantics for it). */
  | {
    readonly kind: "hint";
    readonly type?: string;
    readonly content?: string;
    readonly clearResponse?: boolean;
    readonly finishReason?: string;
  }
  /** The parent message changed. Control only. */
  | { readonly kind: "update_parent_message"; readonly payload: unknown }
  /** A file was touched. Control only (this bridge carries no files). */
  | { readonly kind: "update_file"; readonly payload: unknown }
  /** An in-band error, read from the provider's own envelope. */
  | {
    readonly kind: "error";
    readonly code?: number;
    readonly msg?: string;
    readonly bizCode?: number;
    readonly bizMsg?: string;
    readonly eventName?: string;
  }
  /** A frame this parser does not model. Kept so a new event cannot be silently dropped. */
  | { readonly kind: "unknown"; readonly event?: string; readonly data: string };

/** Why the completion loop stopped. Each value is a distinct observable signal. */
export const DEEPSEEK_TERMINATIONS = ["finish", "close", "stream_end", "error"] as const;

/** One termination signal. */
export type DeepSeekTermination = (typeof DEEPSEEK_TERMINATIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A message id as the wire carries it: a non-empty string or a finite number, never coerced. */
function messageIdField(value: unknown): DeepSeekMessageId | undefined {
  return isDeepSeekMessageId(value) ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * One raw delta frame, after the bundle's schema has accepted it.
 *
 * **Both `p` and `o` are optional on the wire.** The page's own delta parser (`SI` in the bundle)
 * keeps the previous operation and path as defaults (`op = e.o ?? op`, `path = e.p ?? path`, starting
 * at `SET` and `""`), so the recorded stream legitimately sends:
 *
 * ```text
 * {"v":{"response":{…}}}                          first frame: SET the whole document
 * {"v":" need"}                                    APPEND to the path of the previous frame
 * {"p":"response/fragments/-1/content","v":"H"}     APPEND with a new path, inherited operation
 * {"p":"response/fragments/-1/content","o":"APPEND","v":"ola"}
 * ```
 *
 * `v` is always present (JSON `null` is a value; a missing key is a protocol error).
 */
export interface DeepSeekDeltaPatch {
  /** The slash path, when the frame carries one. `""` addresses the whole document. */
  readonly p?: string;
  /** One of `SET`, `BATCH`, `APPEND`, when the frame carries one. */
  readonly o?: DeepSeekPatchOperation;
  /** The value the operation carries. Always present. */
  readonly v: unknown;
}

/** One delta after the sticky/default rules have resolved its path and operation. */
export interface DeepSeekResolvedDeltaPatch {
  /** The resolved path; `""` is the response document itself. */
  readonly path: string;
  readonly operation: DeepSeekPatchOperation;
  readonly value: unknown;
}

/**
 * Validate one delta frame against the bundle's schema, keeping `p`/`o` optional.
 *
 * The bundle validates `{p?, o?, v}` (`So`/`Sv`: `lqM(...)` for `p` and `o`, required `v`), so a frame
 * without a path or operation is valid and is resolved against the previous frame by
 * {@link DeepSeekDeltaParser}. Everything structural beyond that is checked where it is applied.
 */
export function normaliseDeepSeekPatch(value: unknown): DeepSeekDeltaPatch {
  if (!isRecord(value)) {
    throw protocol("DEEPSEEK_PATCH_NOT_OBJECT", "A DeepSeek delta must be a JSON object `{p?, o?, v}`");
  }
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
  if (!has("v")) {
    throw protocol("DEEPSEEK_PATCH_VALUE_MISSING", "A DeepSeek delta carries no value");
  }
  const p = value["p"];
  if (p !== undefined) {
    if (typeof p !== "string") {
      throw protocol("DEEPSEEK_PATCH_PATH_INVALID", "A DeepSeek delta path `p` must be a string");
    }
    if (p.length > 0 && (p.startsWith("/") || p.endsWith("/") || p.includes("//"))) {
      throw protocol(
        "DEEPSEEK_PATCH_PATH_INVALID",
        `A DeepSeek delta path must be a slash-separated path with no empty segments, not ${JSON.stringify(p)}`,
      );
    }
  }
  const o = value["o"];
  if (o !== undefined && !isDeepSeekPatchOperation(o)) {
    throw protocol(
      "DEEPSEEK_PATCH_OPERATION_INVALID",
      `A DeepSeek delta operation must be one of ${DEEPSEEK_WEB_PATCH_OPERATIONS.join(", ")}, not ${JSON.stringify(o)}`,
    );
  }
  return {
    ...(p === undefined ? {} : { p }),
    ...(o === undefined ? {} : { o }),
    v: value["v"],
  };
}

/**
 * The app's own delta parser: sticky `SET`/`""` defaults and **relative** `BATCH` children.
 *
 * This mirrors the bundle's `SI` exactly, because the recorded stream depends on it:
 *
 * - `op` and `path` are remembered across frames of one turn;
 * - `BATCH` children are resolved by a **fresh** parser and then re-rooted under the batch's path
 *   (`(s ? s + "/" : "") + child.path`), which is what makes `p:"response", o:"BATCH", v:[{p:"status",…}]`
 *   address `response/status` rather than a top-level `status`;
 * - an operation/path pair the app could not express is refused, never guessed.
 *
 * The parser is stateful **per turn**, which is why the assembler owns one.
 */
export class DeepSeekDeltaParser {
  #operation: DeepSeekPatchOperation = "SET";
  #path = "";

  /** Resolve one raw frame into the patch(es) it applies. */
  parse(value: unknown, depth = 0): readonly DeepSeekResolvedDeltaPatch[] {
    const patch = normaliseDeepSeekPatch(value);
    const operation = patch.o ?? this.#operation;
    const path = patch.p ?? this.#path;
    this.#operation = operation;
    this.#path = path;
    if (operation !== "BATCH") return [{ path, operation, value: patch.v }];
    if (!Array.isArray(patch.v)) {
      throw protocol(
        "DEEPSEEK_PATCH_BATCH_INVALID",
        `A DeepSeek BATCH delta at ${JSON.stringify(path)} must carry an array of patches`,
      );
    }
    if (depth >= MAX_PATCH_DEPTH) {
      throw protocol(
        "DEEPSEEK_PATCH_BATCH_DEPTH",
        `A DeepSeek BATCH delta at ${JSON.stringify(path)} nests deeper than ${MAX_PATCH_DEPTH}`,
      );
    }
    const children: DeepSeekResolvedDeltaPatch[] = [];
    const nested = new DeepSeekDeltaParser();
    for (const child of patch.v) {
      for (const resolved of nested.parse(child, depth + 1)) {
        children.push({
          path: path.length === 0 ? resolved.path : resolved.path.length === 0 ? path : `${path}/${resolved.path}`,
          operation: resolved.operation,
          value: resolved.value,
        });
      }
    }
    return children;
  }
}

/**
 * One path segment: an array index when it is an integer (including `-1`), a key otherwise.
 *
 * The recorded stream addresses the last fragment as `response/fragments/-1/content`; the app's own
 * writer resolves a negative index as `length + index`, so `-1` is the last element — not an array
 * property named `"-1"`.
 */
type PathSegment = string | number;

/** The deepest a BATCH may nest before it is refused. */
const MAX_PATCH_DEPTH = 8;

/** The prefix every recorded path carries; it names the app's response document root. */
const RESPONSE_ROOT = "response";

function pathSegments(path: string): readonly PathSegment[] {
  if (path.length === 0) return [];
  const segments = path.split("/");
  if (segments[0] !== RESPONSE_ROOT) {
    throw protocol(
      "DEEPSEEK_PATCH_ROOT_INVALID",
      `A DeepSeek delta path must start with ${JSON.stringify(RESPONSE_ROOT)}, not ${JSON.stringify(segments[0])}`,
    );
  }
  return segments.slice(1).map(segment => (/^-?\d+$/.test(segment) ? Number(segment) : segment));
}

/** One fragment of the provider's streamed response document. */
export interface DeepSeekFragment {
  readonly index: number;
  /** The recorded `type`, when the stream declared one. `RESPONSE` carries the answer. */
  readonly type?: string;
  readonly content: string;
}

/**
 * The fragment assembler: the app's `set`/`append` writer over a provider response document.
 *
 * It applies the **resolved** patches from {@link DeepSeekDeltaParser} and mirrors the vendor's
 * `Sn.write` semantics where the recorded stream depends on them:
 *
 * - a path starting with `response` is rooted at the response document; `""` replaces the whole
 *   document (the recorded first frame does exactly that);
 * - `-1` (any negative integer) resolves as `length + index`, both while traversing and at the final
 *   assignment (the recorded `response/fragments/-1/content` depends on it);
 * - `SET` writes any JSON value at the path (an index equal to the array length appends);
 * - `APPEND` of a string requires an existing string and concatenates; `APPEND` of an array pushes
 *   onto an existing array (or splices at an array index);
 * - anything the writer could not express faithfully is a {@link DeepSeekProtocolError}.
 *
 * Content is keyed by its **index in the document**, never by arrival order, so a patch that fills
 * `fragments/1` before `fragments/0` cannot shift the answer.
 */
export class DeepSeekFragmentAssembler {
  #document: unknown = {};
  readonly #parser = new DeepSeekDeltaParser();

  /** Apply one raw delta frame. Throws {@link DeepSeekProtocolError} when it cannot be applied. */
  apply(patch: unknown): void {
    for (const resolved of this.#parser.parse(patch)) this.#applyResolved(resolved);
  }

  #applyResolved(patch: DeepSeekResolvedDeltaPatch): void {
    const segments = pathSegments(patch.path);
    if (segments.length === 0) {
      if (patch.operation !== "SET") {
        throw protocol(
          "DEEPSEEK_PATCH_ROOT_INVALID",
          `A DeepSeek ${patch.operation} delta cannot address the whole response document`,
        );
      }
      this.#document = patch.value;
      return;
    }
    if (patch.operation === "SET") {
      this.#setAt(segments, patch.value);
      return;
    }
    if (patch.operation === "APPEND") {
      this.#appendAt(segments, patch.value);
      return;
    }
    throw protocol(
      "DEEPSEEK_PATCH_OPERATION_INVALID",
      `A resolved DeepSeek patch cannot be ${patch.operation}; BATCH is expanded by the parser`,
    );
  }

  /** Every fragment the document holds, in document order (holes and non-objects skipped). */
  fragments(): readonly DeepSeekFragment[] {
    if (!isRecord(this.#document)) return [];
    const response = this.#document["response"];
    if (!isRecord(response)) return [];
    const fragments = response["fragments"];
    if (!Array.isArray(fragments)) return [];
    const collected: DeepSeekFragment[] = [];
    for (let index = 0; index < fragments.length; index += 1) {
      const entry = fragments[index];
      if (!isRecord(entry)) continue;
      const type = stringField(entry["type"]);
      const content = stringField(entry["content"]) ?? "";
      collected.push({ index, ...(type === undefined ? {} : { type }), content });
    }
    return collected;
  }

  /**
   * The assistant's answer: the content of `RESPONSE` fragments, in document order.
   *
   * `RESPONSE` is the only type that carries the answer. `THINK` is the model's reasoning and is
   * excluded (it is counted by {@link reasoningText}); any other type is *unknown* content and is
   * reported by {@link unattributedText} so the transport can refuse a turn whose only content it
   * cannot honestly attribute.
   */
  text(): string {
    return this.fragments()
      .filter(fragment => fragment.type === DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE)
      .map(fragment => fragment.content)
      .join("");
  }

  /**
   * The reasoning the model streamed in `THINK` fragments.
   *
   * Excluded from the answer, never returned to the caller: the same rule the other providers apply to
   * a reasoning phase. It is exposed so the transport can report how much was excluded.
   */
  reasoningText(): string {
    return this.fragments()
      .filter(fragment => fragment.type === DEEPSEEK_WEB_REASONING_FRAGMENT_TYPE)
      .map(fragment => fragment.content)
      .join("");
  }

  /** Content that arrived on fragment types this build does not model at all. */
  unattributedText(): string {
    return this.fragments()
      .filter(fragment => fragment.type !== DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE
        && fragment.type !== DEEPSEEK_WEB_REASONING_FRAGMENT_TYPE)
      .map(fragment => fragment.content)
      .join("");
  }

  /** The types this stream declared, for diagnostics (never content). */
  fragmentTypes(): readonly string[] {
    return [...new Set(this.fragments().flatMap(fragment => (fragment.type === undefined ? [] : [fragment.type])))];
  }

  /**
   * The `response` member every stripped path is rooted at.
   *
   * The recorded first frame is `{v:{response:…}}` (a whole-document SET), so paths like
   * `response/fragments/-1/content` are rooted at `document.response`, exactly as the app's writer
   * strips the `response` prefix and then walks the message object. A SET may create that member; an
   * APPEND may not (there is nothing to append to).
   */
  #responseRoot(create: boolean): unknown {
    if (!isRecord(this.#document)) {
      throw protocol(
        "DEEPSEEK_PATCH_PATH_TRAVERSAL",
        "A DeepSeek response path addresses a document that is not an object",
      );
    }
    const current = this.#document["response"];
    if (current === undefined || current === null) {
      if (!create) {
        throw protocol(
          "DEEPSEEK_PATCH_APPEND_INVALID",
          "A DeepSeek APPEND addresses the response document before it exists",
        );
      }
      const created: Record<string, unknown> = {};
      this.#document["response"] = created;
      return created;
    }
    return current;
  }

  #at(container: unknown, segment: PathSegment): unknown {
    if (typeof segment === "number") {
      if (!Array.isArray(container)) return undefined;
      return segment < 0 ? container.at(segment) : container[segment];
    }
    return isRecord(container) ? container[segment] : undefined;
  }

  #setAt(segments: readonly PathSegment[], value: unknown): void {
    const last = segments[segments.length - 1]!;
    let container: unknown = this.#responseRoot(true);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const next = segments[index + 1]!;
      const existing = this.#at(container, segment);
      if (existing === undefined || existing === null) {
        // Only a positive object key/array tail can be created; a negative index addresses an element
        // that must already exist (the app's writer cannot create an element at `-1`).
        if (typeof segment === "number" && segment < 0) {
          throw protocol(
            "DEEPSEEK_PATCH_PATH_TRAVERSAL",
            `A DeepSeek delta addresses ${JSON.stringify(segments.slice(0, index + 1).join("/"))}, which does not exist`,
          );
        }
        const created: unknown = typeof next === "number" && next >= 0 ? [] : {};
        this.#assign(container, segment, created);
        container = created;
        continue;
      }
      if (typeof existing !== "object") {
        throw protocol(
          "DEEPSEEK_PATCH_PATH_TRAVERSAL",
          `A DeepSeek delta addresses ${JSON.stringify(segments.slice(0, index + 1).join("/"))}, which is a `
          + `${typeof existing} value and cannot hold ${JSON.stringify(segments.slice(0, index + 2).join("/"))}`,
        );
      }
      container = existing;
    }
    this.#assign(container, last, value);
  }

  #assign(container: unknown, segment: PathSegment, value: unknown): void {
    if (typeof segment === "number") {
      if (!Array.isArray(container)) {
        throw protocol(
          "DEEPSEEK_PATCH_PATH_TRAVERSAL",
          `A DeepSeek delta addresses index ${segment} of a value that is not an array`,
        );
      }
      const index = segment < 0 ? container.length + segment : segment;
      if (index < 0 || index > container.length) {
        throw protocol(
          "DEEPSEEK_PATCH_PATH_TRAVERSAL",
          `A DeepSeek delta addresses index ${segment} of an array of length ${container.length}`,
        );
      }
      container[index] = value;
      return;
    }
    if (!isRecord(container)) {
      throw protocol(
        "DEEPSEEK_PATCH_PATH_TRAVERSAL",
        `A DeepSeek delta addresses ${JSON.stringify(segment)}, which is not an object`,
      );
    }
    container[segment] = value;
  }

  #appendAt(segments: readonly PathSegment[], value: unknown): void {
    const last = segments[segments.length - 1]!;
    let container: unknown = this.#responseRoot(false);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const existing = this.#at(container, segment);
      if (existing === undefined || existing === null) {
        throw protocol(
          "DEEPSEEK_PATCH_APPEND_INVALID",
          `A DeepSeek APPEND addresses ${JSON.stringify(segments.slice(0, index + 1).join("/"))}, which does not exist`,
        );
      }
      if (typeof existing !== "object") {
        throw protocol(
          "DEEPSEEK_PATCH_PATH_TRAVERSAL",
          `A DeepSeek APPEND addresses ${JSON.stringify(segments.slice(0, index + 1).join("/"))}, which is a `
          + `${typeof existing} value`,
        );
      }
      container = existing;
    }

    if (Array.isArray(value)) {
      // The app's writer splices an array onto an array *index*, and pushes onto an array *key*.
      if (typeof last === "number" && Array.isArray(container)) {
        container.splice(last, 0, ...value);
        return;
      }
      const target = typeof last === "number" ? this.#at(container, last) : (container as Record<string, unknown>)[last];
      if (!Array.isArray(target)) {
        throw protocol(
          "DEEPSEEK_PATCH_APPEND_INVALID",
          `A DeepSeek APPEND at ${JSON.stringify(segments.join("/"))} targets no array`,
        );
      }
      target.push(...value);
      return;
    }
    if (typeof value !== "string") {
      throw protocol(
        "DEEPSEEK_PATCH_APPEND_INVALID",
        `A DeepSeek APPEND at ${JSON.stringify(segments.join("/"))} carries ${typeof value}, not text`,
      );
    }
    const target = typeof last === "number" ? this.#at(container, last) : (container as Record<string, unknown>)[last];
    if (typeof target !== "string") {
      throw protocol(
        "DEEPSEEK_PATCH_APPEND_INVALID",
        `A DeepSeek APPEND at ${JSON.stringify(segments.join("/"))} targets ${typeof target}, not text`,
      );
    }
    this.#assign(container, last, `${target}${value}`);
  }
}

/**
 * An incremental named-SSE reader.
 *
 * `push(chunk)` accepts one decoded network chunk at a time — chunk boundaries fall anywhere,
 * including inside an `event:` line, inside a JSON payload and between a CR and its LF — and returns
 * every event completed by that chunk. `end()` flushes a trailing event that arrived without its
 * blank line. Nothing here is stateful across turns.
 */
export class DeepSeekSseReader {
  #buffer = "";
  /** A chunk may end in the middle of a CRLF; the CR is held until the next chunk decides it. */
  #pendingCarriageReturn = false;
  #event: string | undefined;
  #id: string | undefined;
  #data: string[] = [];

  /** Feed one decoded chunk; returns the raw events it completed. */
  push(chunk: string): DeepSeekSseRawEvent[] {
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
    const events: DeepSeekSseRawEvent[] = [];
    for (;;) {
      const boundary = this.#buffer.indexOf("\n");
      if (boundary < 0) break;
      const line = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      this.#line(line, events);
    }
    return events;
  }

  /** Flush the trailing line and event, if the stream ended without a blank line. Idempotent. */
  end(): DeepSeekSseRawEvent[] {
    if (this.#pendingCarriageReturn) {
      this.#pendingCarriageReturn = false;
      this.#buffer += "\n";
    }
    const events: DeepSeekSseRawEvent[] = [];
    if (this.#buffer.length > 0) {
      const line = this.#buffer;
      this.#buffer = "";
      this.#line(line, events);
    }
    this.#dispatch(events);
    return events;
  }

  #line(line: string, out: DeepSeekSseRawEvent[]): void {
    if (line.length === 0) {
      this.#dispatch(out);
      return;
    }
    // A comment line (`: heartbeat`) is the only thing this stream sends when it has nothing to say.
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    // One optional space after the colon is SSE framing, not payload.
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    else if (field === "id") this.#id = value;
    // `retry` and any unmodelled field are framing only; this vocabulary has no use for them.
  }

  #dispatch(out: DeepSeekSseRawEvent[]): void {
    const event = this.#event;
    const id = this.#id;
    const data = this.#data.join("\n");
    this.#event = undefined;
    this.#id = undefined;
    this.#data = [];
    // A block with neither an event name nor data is a heartbeat/comment: not a frame.
    if (event === undefined && data.length === 0) return;
    out.push({ ...(event === undefined ? {} : { event }), ...(id === undefined ? {} : { id }), data });
  }
}

/**
 * The provider's error envelope, when a *stream frame* carries one.
 *
 * Recon §2.4 records no dedicated error event for the stream, while §2.2 records that every DeepSeek
 * answer carries `{code, msg, data:{biz_code, biz_msg}}`. The only measured error shape is therefore
 * the envelope, and it is applied to any frame that declares one — including an `error`-named event,
 * which the recon does not list and which is accepted here rather than dropped if the provider ever
 * sends it (documented as unproven in `doc/deepseek-web.md` §6).
 */
function frameEnvelopeError(payload: unknown, eventName: string | undefined): DeepSeekSseFrame | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload["data"]) ? payload["data"] : undefined;
  const declaresCode = payload["code"] !== undefined || data?.["biz_code"] !== undefined;
  if (!declaresCode) return undefined;
  const code = numberField(payload["code"]);
  const bizCode = numberField(data?.["biz_code"]);
  const accepted = (code === undefined || code === 0) && (bizCode === undefined || bizCode === 0);
  if (accepted) return undefined;
  const msg = stringField(payload["msg"]);
  const bizMsg = stringField(data?.["biz_msg"]);
  return {
    kind: "error",
    ...(code === undefined ? {} : { code }),
    ...(msg === undefined ? {} : { msg }),
    ...(bizCode === undefined ? {} : { bizCode }),
    ...(bizMsg === undefined ? {} : { bizMsg }),
    ...(eventName === undefined ? {} : { eventName }),
  };
}

/**
 * Classify one raw SSE event into the turn's frame vocabulary.
 *
 * `delta` is the default for an unnamed frame — the recorded `if (!e.event && e.data)` branch — and an
 * unnamed frame that is neither a valid patch nor an envelope error is a typed protocol failure: this
 * parser refuses to guess that unknown JSON is text.
 */
export function parseDeepSeekSseEvent(raw: DeepSeekSseRawEvent): DeepSeekSseFrame {
  const eventName = raw.event;
  const trimmed = raw.data.trim();
  let payload: unknown;
  if (trimmed.length === 0) {
    // An event with no data is either a data-less control frame or a malformed delta.
    payload = {};
  } else {
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      if (eventName === undefined || eventName === "delta") {
        throw protocol(
          "DEEPSEEK_MALFORMED_DELTA",
          "A DeepSeek delta frame did not carry JSON; a patch this build cannot parse is refused rather "
          + "than treated as text",
        );
      }
      return { kind: "unknown", ...(eventName === undefined ? {} : { event: eventName }), data: trimmed };
    }
  }

  const envelopeError = frameEnvelopeError(payload, eventName);
  if (envelopeError !== undefined) return envelopeError;

  switch (eventName) {
    case undefined:
    case "delta":
      return { kind: "delta", patch: normaliseDeepSeekPatch(payload) };
    case "ready": {
      const record = isRecord(payload) ? payload : {};
      // The captured ids are JSON numbers; the scalar is kept as sent, because the continuation has to
      // send the very same value back as `parent_message_id`.
      const responseMessageId = messageIdField(record["response_message_id"]);
      const requestMessageId = messageIdField(record["request_message_id"]);
      const modelType = stringField(record["model_type"]);
      return {
        kind: "ready",
        ...(responseMessageId === undefined ? {} : { responseMessageId }),
        ...(requestMessageId === undefined ? {} : { requestMessageId }),
        ...(modelType === undefined ? {} : { modelType }),
      };
    }
    case "close": {
      const record = isRecord(payload) ? payload : {};
      const clickBehavior = stringField(record["click_behavior"]);
      return { kind: "close", ...(clickBehavior === undefined ? {} : { clickBehavior }) };
    }
    case "finish":
      return { kind: "finish" };
    case "title":
      return { kind: "title", payload };
    case "toast": {
      const record = isRecord(payload) ? payload : {};
      const type = stringField(record["type"]);
      const content = stringField(record["content"]);
      const finishReason = stringField(record["finish_reason"]);
      return {
        kind: "toast",
        ...(type === undefined ? {} : { type }),
        ...(content === undefined ? {} : { content }),
        ...(finishReason === undefined ? {} : { finishReason }),
      };
    }
    case "update_session": {
      const record = isRecord(payload) ? payload : {};
      const updatedAt = numberField(record["updated_at"]) ?? stringField(record["updated_at"]);
      return { kind: "update_session", ...(updatedAt === undefined ? {} : { updatedAt }) };
    }
    case "hint": {
      const record = isRecord(payload) ? payload : {};
      const type = stringField(record["type"]);
      const content = stringField(record["content"]);
      const clearResponse = booleanField(record["clear_response"]);
      const finishReason = stringField(record["finish_reason"]);
      return {
        kind: "hint",
        ...(type === undefined ? {} : { type }),
        ...(content === undefined ? {} : { content }),
        ...(clearResponse === undefined ? {} : { clearResponse }),
        ...(finishReason === undefined ? {} : { finishReason }),
      };
    }
    case "update_parent_message":
      return { kind: "update_parent_message", payload };
    case "update_file":
      return { kind: "update_file", payload };
    default:
      return { kind: "unknown", ...(eventName === undefined ? {} : { event: eventName }), data: trimmed };
  }
}

/** The accumulated answer of one streamed turn, plus the signal that ended it. */
export interface DeepSeekCompletionResult {
  /** The `ready` response message id: the assistant message the **next** turn hangs off. */
  readonly responseMessageId?: DeepSeekMessageId;
  /** The `ready` request message id, kept for diagnosis. */
  readonly requestMessageId?: DeepSeekMessageId;
  /** The model the provider says answered (`ready.model_type`). */
  readonly modelType?: string;
  /** The answer text: `RESPONSE` fragment content, in document order. */
  readonly text: string;
  /** The model's reasoning (`THINK` fragments). Excluded from the answer, never returned. */
  readonly reasoningText: string;
  /** Characters that were excluded from the answer (reasoning + unmodelled fragments). */
  readonly excludedChars: number;
  /** Of {@link excludedChars}, the characters that arrived as reasoning. */
  readonly reasoningChars: number;
  /** Content the stream carried on fragments this build cannot attribute to the answer. */
  readonly unattributedText: string;
  /** The fragment types the stream declared, for diagnostics. */
  readonly fragmentTypes: readonly string[];
  /** Which signal ended the loop. */
  readonly termination: DeepSeekTermination;
  /** The `close.click_behavior`, when a `close` frame ended the turn. */
  readonly clickBehavior?: string;
  /** The provider's in-band error, when `termination` is `error`. Never a credential. */
  readonly error?: {
    readonly code?: number;
    readonly msg?: string;
    readonly bizCode?: number;
    readonly bizMsg?: string;
  };
  /** The last `title` frame's payload, kept for diagnosis only. */
  readonly title?: unknown;
  /** Whether the stream announced `update_session`. */
  readonly sessionUpdated: boolean;
  /** Every non-content control frame observed, by kind. Diagnostics only. */
  readonly controlFrames: Readonly<Record<string, number>>;
  /**
   * How many times a patch **rewrote** already-streamed content.
   *
   * A rewrite cannot be unsaid on an append-only wire, so the assembler records it instead of
   * pretending the streamed text is the final one. The `completed` text is authoritative.
   */
  readonly rewrites: number;
  /** Frames consumed, for diagnostics. */
  readonly frames: number;
}

/** Construction options for {@link createDeepSeekCompletionAccumulator}. */
export interface DeepSeekCompletionAccumulatorOptions {
  /** Called with each piece of text that enters the answer, in order. */
  readonly onText?: (text: string) => void;
  /** Called once per fragment whose streamed text was rewritten by a later patch. */
  readonly onRewrite?: (fragmentIndex: number) => void;
}

/** The accumulator: push frames, learn whether the turn ended, read the result at any time. */
export interface DeepSeekCompletionAccumulator {
  /** Consume one frame. Returns `true` once a terminal signal was observed. */
  push(frame: DeepSeekSseFrame): boolean;
  /** Consume the stream's end. Returns the result; idempotent. */
  finish(): DeepSeekCompletionResult;
  /** The result so far, without terminating the loop. */
  snapshot(): DeepSeekCompletionResult;
  /** Whether a terminal signal was already observed. */
  readonly done: boolean;
  /** The assembler, for a caller that needs the raw fragments. */
  readonly fragments: readonly DeepSeekFragment[];
}

/**
 * Build one turn's completion accumulator.
 *
 * The rules below are the recon's, not a preference:
 *
 * - `delta` patches are applied in order; the answer is the `RESPONSE` fragments' content;
 * - `finish` and `close` are terminal, and a stream that just ends is `stream_end`;
 * - `ready`, `title`, `toast`, `hint`, `update_session`, `update_parent_message` and `update_file` are
 *   control frames: counted, never content, never terminal;
 * - an in-band envelope error is terminal and never becomes empty successful text;
 * - a malformed patch throws: corrupt content is worse than a failed turn.
 */
export function createDeepSeekCompletionAccumulator(
  options: DeepSeekCompletionAccumulatorOptions = {},
): DeepSeekCompletionAccumulator {
  const onText = options.onText;
  const onRewrite = options.onRewrite;
  const assembler = new DeepSeekFragmentAssembler();
  /** What has already been streamed out, per fragment index. */
  const emitted = new Map<number, string>();
  const controlFrames: Record<string, number> = {};
  let responseMessageId: DeepSeekMessageId | undefined;
  let requestMessageId: DeepSeekMessageId | undefined;
  let modelType: string | undefined;
  let termination: DeepSeekTermination | undefined;
  let clickBehavior: string | undefined;
  let error: DeepSeekCompletionResult["error"];
  let title: unknown;
  let sessionUpdated = false;
  let rewrites = 0;
  let frames = 0;

  const count = (kind: string): void => {
    controlFrames[kind] = (controlFrames[kind] ?? 0) + 1;
  };

  const result = (): DeepSeekCompletionResult => ({
    ...(responseMessageId === undefined ? {} : { responseMessageId }),
    ...(requestMessageId === undefined ? {} : { requestMessageId }),
    ...(modelType === undefined ? {} : { modelType }),
    text: assembler.text(),
    reasoningText: assembler.reasoningText(),
    excludedChars: assembler.reasoningText().length + assembler.unattributedText().length,
    reasoningChars: assembler.reasoningText().length,
    unattributedText: assembler.unattributedText(),
    fragmentTypes: assembler.fragmentTypes(),
    termination: termination ?? "stream_end",
    ...(clickBehavior === undefined ? {} : { clickBehavior }),
    ...(error === undefined ? {} : { error }),
    ...(title === undefined ? {} : { title }),
    sessionUpdated,
    controlFrames: { ...controlFrames },
    rewrites,
    frames,
  });

  /**
   * Stream the increment each `RESPONSE` fragment gained.
   *
   * A patch that *extends* a fragment streams its suffix. A patch that rewrites content already sent
   * cannot be undone here, so it is counted and reported; the final `completed` text stays
   * authoritative rather than being silently replaced by a broken preview.
   */
  const publish = (): void => {
    for (const fragment of assembler.fragments()) {
      if (fragment.type !== DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE) continue;
      const already = emitted.get(fragment.index) ?? "";
      if (fragment.content === already) continue;
      if (fragment.content.startsWith(already)) {
        const suffix = fragment.content.slice(already.length);
        emitted.set(fragment.index, fragment.content);
        if (suffix.length > 0) onText?.(suffix);
        continue;
      }
      emitted.set(fragment.index, fragment.content);
      rewrites += 1;
      onRewrite?.(fragment.index);
    }
  };

  return {
    get done() {
      return termination !== undefined;
    },
    get fragments() {
      return assembler.fragments();
    },
    push(frame: DeepSeekSseFrame): boolean {
      if (termination !== undefined) return true;
      frames += 1;
      switch (frame.kind) {
        case "delta":
          assembler.apply(frame.patch);
          publish();
          return false;
        case "ready":
          responseMessageId ??= frame.responseMessageId;
          requestMessageId ??= frame.requestMessageId;
          modelType ??= frame.modelType;
          return false;
        case "update_session":
          sessionUpdated = true;
          count("update_session");
          return false;
        case "title":
          title ??= frame.payload;
          count("title");
          return false;
        case "toast":
          count("toast");
          return false;
        case "hint":
          count("hint");
          return false;
        case "update_parent_message":
          count("update_parent_message");
          return false;
        case "update_file":
          count("update_file");
          return false;
        case "unknown":
          count(frame.event === undefined ? "unknown" : `unknown:${frame.event}`);
          return false;
        case "close":
          termination = "close";
          clickBehavior = frame.clickBehavior;
          return true;
        case "finish":
          termination = "finish";
          return true;
        case "error":
          error = {
            ...(frame.code === undefined ? {} : { code: frame.code }),
            ...(frame.msg === undefined ? {} : { msg: frame.msg }),
            ...(frame.bizCode === undefined ? {} : { bizCode: frame.bizCode }),
            ...(frame.bizMsg === undefined ? {} : { bizMsg: frame.bizMsg }),
          };
          termination = "error";
          return true;
      }
    },
    finish(): DeepSeekCompletionResult {
      termination ??= "stream_end";
      return result();
    },
    snapshot(): DeepSeekCompletionResult {
      return result();
    },
  };
}
