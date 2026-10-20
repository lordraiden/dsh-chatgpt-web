/**
 * OpenAI-compatible chat surface for the containerised service (issue #248).
 *
 * This module owns one thing: translating the OpenAI wire shape into the *existing* internal turn and
 * shaping the answer back. It deliberately contains no execution: the caller hands the translated body
 * to the same `responseRequest` path `/v1/responses` uses, so there is no second engine, no second
 * ProviderCore and no second retry authority (architecture §18, §26).
 *
 * Two rules it must not weaken:
 * - **text-only**: content features are refused through the common layer's own admission
 *   (`rejectUnsupportedWebChatFeatures`), never silently dropped (architecture §1.2, §8.3, §16);
 * - **only messages**: the turn is projected through `projectApiConversation` (issue #253), so a
 *   harness's session context does not become part of the provider turn.
 *
 * A third rule it used to compute and then drop: the **caller's conversation identity**. `mode` and
 * the resolved session id were computed but never reached the turn, so every caller without turn
 * metadata collapsed onto one constant provider conversation. The identity now travels on the channel
 * the turn identity extractor already reads (`client_metadata`), so this surface adds no second
 * identity channel, and the provider still sees only message text — the identity is never part of a
 * message. See `src/web-chat/host/api-projection.ts` for the rule and its documented limit.
 *
 * A fourth, added with issue #307: **which identity counts**. The channel was already read, but this
 * surface used to read identity only from `body.user`/`body.session_id` and then *replace* the caller's
 * `client_metadata` with what it derived — so a caller that sent the native shape had its
 * `dsh_session_id` and its turn `purpose` erased here. The derivation now goes through the host's one
 * reader (`src/web-chat/host/turn-identity.ts`), which resolves the native metadata first and keeps the
 * caller's fields on the way through, so this surface and `/v1/responses` agree about who is talking
 * and about which turns are housekeeping.
 *
 * Capability declarations are the deliberate exception, by product design and not by configuration:
 * `tools`, `tool_choice`/`function_call` and `mcp`/`functions` are accepted and discarded, because
 * this bridge is a text chat with no execution or return channel to the caller's harness. Nothing
 * here reads a capability field when it builds the turn, so they cannot be forwarded even by
 * accident; what was discarded is declared on the response (`x-dsh-chatgpt-web-ignored-features`)
 * and in the log. Attached *content* still refuses — that distinction is not a policy.
 */
import {
  rejectUnsupportedWebChatFeatures,
  type WebChatCapabilityFeature,
} from "../web-chat/core";
import {
  ApiProjectionRefusalError,
  projectApiConversation,
  normalizeApiSessionId,
  type ApiConversationMessage,
} from "../web-chat/host/api-projection";
import {
  declaredTurnChannels,
  nativeTurnMetadataFor,
  nativeTurnMetadataFromBody,
  resolveNativeTurnIdentity,
  type NativeTurnHeaderSource,
} from "../web-chat/host/turn-identity";

/** A request the surface cannot serve. The server maps it to a typed 400. */
export class ChatCompletionsRequestError extends Error {
  /**
   * A stable refusal code, when this surface (or an owner it delegates to) has one. The server
   * publishes it as the response's `error.code`, so a caller can act on the refusal without matching
   * message text. Absent for the surface's generic validation refusals, which keep the existing
   * `invalid_request_error` code.
   */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ChatCompletionsRequestError";
    if (code !== undefined) this.code = code;
  }
}

export interface ChatCompletionsTranslation {
  /** The internal Responses-shaped body to execute. */
  readonly body: Record<string, unknown>;
  readonly model: string;
  readonly stream: boolean;
  readonly mode: "session" | "stateless";
  /**
   * The provider conversation identity this turn belongs to (the caller's `user`/`session_id`, or a
   * content-derived identity for a stateless caller). Carried to the turn through `client_metadata`;
   * never part of the messages, so it stays invisible to the provider.
   */
  readonly conversationIdentity: string;
  readonly droppedRoles: readonly string[];
  /**
   * Capability declarations the request carried and this surface discarded.
   *
   * They are accepted and never executed (the internal turn is built from messages only), so the
   * caller gets them back to declare: the route names them on the response
   * (`x-dsh-chatgpt-web-ignored-features`) and in one log line, so a dropped tool definition is
   * never a silent drop. Empty when the request carried none.
   */
  readonly droppedCapabilities: readonly WebChatCapabilityFeature[];
}

const MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatCompletionsRequestError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Text of one message, refusing anything the text-only contract cannot carry. */
function messageText(message: unknown, index: number): string {
  const record = asRecord(message, `messages[${index}]`);
  const content = record.content;
  if (typeof content === "string") return assertSize(content, index);
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) {
    throw new ChatCompletionsRequestError(`messages[${index}].content must be a string or an array of parts`);
  }
  const parts: string[] = [];
  for (const part of content) {
    const block = asRecord(part, `messages[${index}].content[]`);
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" || type === "input_text") {
      if (typeof block.text !== "string") {
        throw new ChatCompletionsRequestError(`messages[${index}].content[] of type ${type} needs a "text" string`);
      }
      parts.push(block.text);
      continue;
    }
    // Non-text parts are refused through the common layer's canonical admission, so the list of what
    // is unsupported lives in exactly one place. Every mapped feature here is a *content* feature, so
    // this call can only ever refuse: discarding capability declarations must never become a way to
    // drop an attachment, and a capability-shaped part (an unknown type) is refused below.
    const feature = type === "image_url" || type === "input_image"
      ? "images"
      : type === "input_audio" || type === "audio"
        ? "audio"
        : type === "input_file" || type === "file"
          ? "files"
          : null;
    if (feature === null) {
      throw new ChatCompletionsRequestError(
        `messages[${index}].content[] has unsupported part type ${JSON.stringify(type)}; this API is text-only`,
      );
    }
    rejectUnsupportedWebChatFeatures({ [feature]: [block] });
  }
  return assertSize(parts.join(""), index);
}

function assertSize(text: string, index: number): string {
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new ChatCompletionsRequestError(`messages[${index}] is larger than ${MAX_MESSAGE_CHARS} characters`);
  }
  return text;
}

/**
 * Apply the common layer's admission to the OpenAI top-level fields and return the capability
 * declarations it discarded.
 *
 * The legacy aliases (`functions`, `function_call`) are folded into the same canonical vocabulary,
 * so a legacy tool request is discarded and declared exactly like the modern shape.
 */
function applyTopLevelAdmission(body: Record<string, unknown>): readonly WebChatCapabilityFeature[] {
  const dropped = rejectUnsupportedWebChatFeatures({
    tools: body.tools ?? body.functions,
    toolChoice: body.tool_choice ?? body.function_call,
    files: body.files,
    images: body.images,
    audio: body.audio,
    video: body.video,
    attachments: body.attachments,
    mcp: body.mcp,
  });

  // Not part of the common layer's vocabulary, so this surface owns the refusal. These are surface
  // options, not content: a refusal here is unchanged by the capability policy above.
  const n = body.n;
  if (n !== undefined && n !== null && n !== 1) {
    throw new ChatCompletionsRequestError("`n` greater than 1 is not supported; the API returns one choice");
  }
  for (const field of ["logprobs", "top_logprobs"] as const) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== false) {
      throw new ChatCompletionsRequestError(`\`${field}\` is not supported`);
    }
  }
  const responseFormat = body.response_format;
  if (responseFormat !== undefined && responseFormat !== null) {
    const type = asRecord(responseFormat, "response_format").type;
    if (type !== undefined && type !== "text") {
      throw new ChatCompletionsRequestError("`response_format` is only supported as plain text");
    }
  }
  return dropped;
}

/**
 * Translate an OpenAI chat request into the internal turn.
 *
 * Capability declarations (`tools`, `tool_choice`/`function_call`, `mcp`/`functions`) are discarded
 * and reported in `droppedCapabilities`; they are never read into the internal body, which is built
 * from the projected messages only.
 *
 * @param raw - the caller's chat-completions body.
 * @param headers - the request headers, when the HTTP surface can supply them. They carry the declared
 *   identity channels an OpenAI-compatible caller may use instead of `user` / `session_id` — the
 *   session-affinity headers and a declared auxiliary purpose header — which the host's one reader
 *   resolves before this surface projects the identity onto the metadata channel the turn already
 *   travels on. A surface that cannot see headers passes nothing, and the body channel
 *   (`prompt_cache_key`) still applies.
 *
 * @throws {ChatCompletionsRequestError} for anything the surface refuses — always before any provider
 * work, so a refused request submits nothing. A refusal the message projection owns keeps that
 * owner's stable `code` (`host_context_only_turn`, `no_user_message`), so a caller can tell a turn
 * made only of host context from a request that carried no user message; every other refusal keeps
 * the generic invalid-request code.
 */
export function translateChatCompletionsRequest(
  raw: unknown,
  headers?: NativeTurnHeaderSource,
): ChatCompletionsTranslation {
  const body = asRecord(raw, "request body");
  const droppedCapabilities = applyTopLevelAdmission(body);

  const model = body.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new ChatCompletionsRequestError("`model` is required and must be a catalogue model id");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ChatCompletionsRequestError("`messages` must be a non-empty array");
  }

  const messages: ApiConversationMessage[] = body.messages.map((message, index) => {
    const record = asRecord(message, `messages[${index}]`);
    if (typeof record.role !== "string" || record.role.trim() === "") {
      throw new ChatCompletionsRequestError(`messages[${index}].role is required`);
    }
    return { role: record.role.trim().toLowerCase(), content: messageText(message, index) };
  });

  const sessionId = normalizeApiSessionId(body.user) ?? normalizeApiSessionId(body.session_id);
  // The native metadata shape a DSH caller can send (`client_metadata["x-codex-turn-metadata"]`) is
  // read through the host's one reader (issue #307), so this surface agrees with `/v1/responses`
  // instead of keeping a second, narrower idea of "identity": a declared `dsh_session_id` is the
  // conversation, and a declared auxiliary `purpose` makes the turn ephemeral (answered, kept nowhere)
  // rather than a turn of the caller's own chat.
  //
  // An OpenAI-compatible caller that sends no native metadata still declares an identity on the wire
  // this surface speaks: `prompt_cache_key` in the body and the session-affinity headers beside it. Both
  // are read through the same owner and sit below every identity this product already understands, so a
  // native declaration keeps winning. The resolved purpose is projected onto the metadata this surface
  // already emits, so `/v1/responses` and this route read one classification downstream.
  const native = nativeTurnMetadataFromBody(body);
  const resolved = resolveNativeTurnIdentity(native, sessionId, undefined, declaredTurnChannels(body, headers));
  // An ephemeral turn resolves to no identity by contract (`resolveNativeTurnIdentity`), so the
  // projection's own stateless branch gives it a content-derived identity: the provider still creates a
  // conversation surface for the answer, but nothing that could later be resolved as the caller's chat.
  let projected;
  try {
    projected = projectApiConversation({
      messages,
      ...(resolved.threadId !== undefined ? { sessionId: resolved.threadId } : {}),
    });
  } catch (error) {
    // A projection refusal is the projection's own typed decision (which `user` message is the turn,
    // and whether one exists at all); its code travels to the caller so "you sent only the host's own
    // context" is actionable instead of another generic invalid request. Everything else this surface
    // refuses keeps its existing shape.
    if (error instanceof ApiProjectionRefusalError) {
      throw new ChatCompletionsRequestError(error.message, error.code);
    }
    throw new ChatCompletionsRequestError(error instanceof Error ? error.message : String(error));
  }

  const stream = body.stream === true;
  const internal: Record<string, unknown> = {
    model,
    // Only the conversation crosses; the shared Responses parser turns these items into the turn.
    input: projected.messages.map((message) => ({
      type: "message",
      role: message.role,
      content: [{ type: "input_text", text: message.content }],
    })),
    stream,
    // The caller's conversation identity reaches the turn on the ONE channel the turn identity
    // extractor already reads (`client_metadata["x-codex-turn-metadata"].thread_id`), the same
    // channel the native Codex and compact surfaces use. It is a request-level field, never a
    // message: the provider-visible text stays message-only.
    //
    // The caller's own metadata fields are preserved rather than replaced (issue #307): a caller that
    // declared `dsh_session_id` and a turn `purpose` must not have them erased by this surface on the
    // way through, or the turn would arrive unaddressed and unclassified. `thread_id` carries the
    // identity this surface resolved, so the adapter's reader resolves the same conversation here as it
    // does on `/v1/responses`; a purpose declared only on a route header is written here so the turn
    // arrives classified on the same channel.
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify(
        nativeTurnMetadataFor(native, projected.conversationIdentity, resolved.purpose),
      ),
    },
  };
  if (typeof body.temperature === "number") internal.temperature = body.temperature;
  if (typeof body.max_tokens === "number") internal.max_output_tokens = body.max_tokens;
  if (typeof body.top_p === "number") internal.top_p = body.top_p;

  return {
    body: internal,
    model,
    stream,
    mode: projected.mode,
    conversationIdentity: projected.conversationIdentity,
    droppedRoles: projected.droppedRoles,
    droppedCapabilities,
  };
}

/**
 * The additive OpenAI `data` array for `GET /v1/models`.
 *
 * `models[]` (the Codex-shaped catalogue) is left untouched: the OpenAI shape is added beside it, so
 * neither consumer has to change.
 */
export function buildOpenAiModelsData(catalog: Record<string, unknown>): Array<Record<string, unknown>> {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.slug === "string" ? record.slug : typeof record.id === "string" ? record.id : undefined;
    if (!id) return [];
    return [{
      id,
      object: "model",
      created: 0,
      owned_by: typeof record.owned_by === "string" && record.owned_by
        ? record.owned_by
        : "dsh-chatgpt-web",
    }];
  });
}

/** The assistant text carried by one internal Responses payload. */
export function responseText(payload: Record<string, unknown>): string {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if ((record.type === "output_text" || record.type === "text") && typeof record.text === "string") {
        parts.push(record.text);
      }
    }
  }
  return parts.join("");
}

/**
 * The failure carried by one internal Responses payload, if any.
 *
 * The published `type` and `code` are carried through untouched: they are the provider's own
 * classification of the failure, and this surface must not re-infer one from the message text
 * (issue #305).
 */
export function responseFailure(
  payload: Record<string, unknown>,
): { message: string; type?: string; code?: string } | undefined {
  const error = payload.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "The provider turn failed.";
  return {
    message,
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}

/**
 * Rename the internal Responses `usage` to the OpenAI chat shape. The numbers are estimates (see
 * doc/container.md); this function renames them and never invents one.
 *
 * A turn with no usage (the adapter reported none: a failure before the first measurable round, an
 * adapter that does not account, the truncated `adapter_eof` path) yields `undefined`, and the caller
 * omits the field. A turn that really reported `0` keeps `0`.
 */
export function chatUsage(usage: unknown): Record<string, number> | undefined {
  const record = usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : undefined;
  const prompt = record?.input_tokens;
  const completion = record?.output_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number") return undefined;
  const total = record?.total_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: typeof total === "number" ? total : prompt + completion,
  };
}

/** Shape one internal Responses payload as an OpenAI `chat.completion`. */
export function toChatCompletion(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const failure = responseFailure(payload);
  const created = typeof payload.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000);
  const id = typeof payload.id === "string" && payload.id ? `chatcmpl-${payload.id}` : `chatcmpl-${created}`;
  const usage = chatUsage(payload.usage);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: failure ? "" : responseText(payload) },
      finish_reason: failure ? "stop" : "stop",
    }],
    // Absent usage means absent, not a zero block a billing client would read as a measurement.
    ...(usage ? { usage } : {}),
    ...(failure ? { error: { message: failure.message, ...(failure.code ? { code: failure.code } : {}) } } : {}),
  };
}

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The SSE comment written while the provider turn is alive but has not produced answer text yet.
 *
 * It is a **comment** (`:`) on purpose: SSE clients ignore it, so a client that understands only
 * `data:` frames parses exactly the same stream it parsed before. That is what makes it safe to
 * keep a long, healthy provider turn (minutes of reasoning before the first visible token) from
 * looking dead to a client's idle timer, without touching any client-side timeout.
 */
export const CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT = ": keep-alive\n\n";

/**
 * Re-shape the internal Responses SSE stream into OpenAI `chat.completion.chunk` events.
 *
 * The upstream stream is consumed as-is: this function adds no retry, no buffering policy of its own
 * and no second interpretation of the turn — it only renames events.
 *
 * **Keep-alive (issue #329).** The internal Responses bridge already owns the one keep-alive clock for
 * a turn: while the provider is working it emits a parser-ignored `response.heartbeat` event every
 * `heartbeatMs` (2 s at the call site) so a Codex/Responses client never trips its own idle timer.
 * This surface deliberately translates that *existing* event into an SSE comment instead of adding a
 * second timer: OpenAI-compatible clients ignore comments, so the wire protocol is unchanged, and
 * there is no timer here to clear, leak or race with the terminal frame. The comment stops at the
 * first real answer delta (the client is receiving content again) and never after a terminal event.
 *
 * **Cancellation.** The returned stream owns the upstream reader. When its consumer cancels it (the
 * HTTP client disconnected and the request-lifetime owner cancelled the response body), the
 * cancellation is forwarded upstream so the provider turn is aborted and its conversation released,
 * instead of a detached turn continuing to hold the admission slot.
 */
export function toChatCompletionStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let sawText = false;
  let finished = false;
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const chunk = (delta: Record<string, unknown>, finish: string | null): string => sseLine({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const upstreamReader = upstream.getReader();
      reader = upstreamReader;
      const write = (frame: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(frame));
          return true;
        } catch {
          // The consumer went away between our check and the enqueue: stop writing, never throw a
          // second time from inside start() (the RC2 double-throw the Request bridge already avoids).
          closed = true;
          return false;
        }
      };

      write(chunk({ role: "assistant", content: "" }, null));
      try {
        for (;;) {
          const { done, value } = await upstreamReader.read();
          if (closed) break;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf("\n\n");
          while (separator >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            separator = buffer.indexOf("\n\n");
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice("data:".length).trim();
              if (data === "" || data === "[DONE]") continue;
              let event: Record<string, unknown>;
              try {
                event = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }
              const type = typeof event.type === "string" ? event.type : "";
              if (type === "response.heartbeat") {
                // The internal keep-alive. Only before the first real delta and before any terminal
                // event, so a client never sees a comment once the answer (or the end) arrived.
                if (!sawText && !finished) write(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT);
              } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
                if (event.delta.length > 0) sawText = true;
                write(chunk({ content: event.delta }, null));
              } else if (type === "response.failed") {
                finished = true;
                const failure = responseFailure({ error: (event.response as Record<string, unknown> | undefined)?.error });
                write(sseLine({
                  error: { message: failure?.message ?? "The provider turn failed.", type: "server_error" },
                }));
              } else if (type === "response.completed" || type === "response.incomplete") {
                finished = true;
                write(chunk({}, sawText ? "stop" : "stop"));
              }
            }
          }
        }
      } catch (error) {
        if (!closed) {
          write(sseLine({
            error: { message: error instanceof Error ? error.message : String(error), type: "server_error" },
          }));
        }
      } finally {
        if (!closed) {
          if (!finished) write(chunk({}, "stop"));
          write("data: [DONE]\n\n");
          try {
            controller.close();
          } catch {
            // Already closed (the consumer cancelled): nothing left to close.
          }
        }
        try {
          upstreamReader.releaseLock();
        } catch {
          // A cancelled/locked reader is already released on the cancellation path.
        }
        reader = undefined;
      }
    },
    async cancel(reason) {
      // The response body was cancelled/aborted (client disconnect, or the request-lifetime owner
      // tearing the stream down). Forward it to the upstream Responses stream: its own cancel hook
      // aborts the provider turn, and this adapter's reader is released so no stream is left locked.
      closed = true;
      finished = true;
      const upstreamReader = reader;
      reader = undefined;
      if (!upstreamReader) return;
      try {
        await upstreamReader.cancel(reason);
      } catch {
        // Cancellation is best effort; the upstream owner reports its own settlement.
      } finally {
        try {
          upstreamReader.releaseLock();
        } catch {
          // Already released.
        }
      }
    },
  });
}
