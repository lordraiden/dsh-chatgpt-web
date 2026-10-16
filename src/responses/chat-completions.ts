/**
 * OpenAI-compatible chat surface for the containerised service (issue #248).
 *
 * This module owns one thing: translating the OpenAI wire shape into the *existing* internal turn and
 * shaping the answer back. It deliberately contains no execution: the caller hands the translated body
 * to the same `responseRequest` path `/v1/responses` uses, so there is no second engine, no second
 * ProviderCore and no second retry authority (architecture §18, §26).
 *
 * Two rules it must not weaken:
 * - **text-only**: unsupported features are refused through the common layer's own admission
 *   (`rejectUnsupportedWebChatFeatures`), never silently dropped (architecture §1.2, §8.3, §16);
 * - **only messages**: the turn is projected through `projectApiConversation` (issue #253), so a
 *   harness's session context does not become part of the provider turn.
 */
import { rejectUnsupportedWebChatFeatures } from "../web-chat/core";
import {
  projectApiConversation,
  normalizeApiSessionId,
  type ApiConversationMessage,
} from "../web-chat/host/api-projection";

/** A request the surface cannot serve. The server maps it to a typed 400. */
export class ChatCompletionsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatCompletionsRequestError";
  }
}

export interface ChatCompletionsTranslation {
  /** The internal Responses-shaped body to execute. */
  readonly body: Record<string, unknown>;
  readonly model: string;
  readonly stream: boolean;
  readonly mode: "session" | "stateless";
  readonly droppedRoles: readonly string[];
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
    // is unsupported lives in exactly one place.
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

/** Refuse the OpenAI fields this text-only surface cannot carry, using the common layer's list. */
function rejectUnsupportedTopLevelFields(body: Record<string, unknown>): void {
  rejectUnsupportedWebChatFeatures({
    tools: body.tools ?? body.functions,
    toolChoice: body.tool_choice ?? body.function_call,
    files: body.files,
    images: body.images,
    audio: body.audio,
    video: body.video,
    attachments: body.attachments,
    mcp: body.mcp,
  });

  // Not part of the common layer's vocabulary, so this surface owns the refusal.
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
}

/**
 * Translate an OpenAI chat request into the internal turn.
 *
 * @throws {ChatCompletionsRequestError} for anything the surface refuses — always before any provider
 * work, so a refused request submits nothing.
 */
export function translateChatCompletionsRequest(raw: unknown): ChatCompletionsTranslation {
  const body = asRecord(raw, "request body");
  rejectUnsupportedTopLevelFields(body);

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
  let projected;
  try {
    projected = projectApiConversation({ messages, ...(sessionId !== undefined ? { sessionId } : {}) });
  } catch (error) {
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
  };
  if (typeof body.temperature === "number") internal.temperature = body.temperature;
  if (typeof body.max_tokens === "number") internal.max_output_tokens = body.max_tokens;
  if (typeof body.top_p === "number") internal.top_p = body.top_p;

  return {
    body: internal,
    model,
    stream,
    mode: projected.mode,
    droppedRoles: projected.droppedRoles,
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

/** The failure carried by one internal Responses payload, if any. */
export function responseFailure(payload: Record<string, unknown>): { message: string; code?: string } | undefined {
  const error = payload.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "The provider turn failed.";
  return { message, ...(typeof record.code === "string" ? { code: record.code } : {}) };
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
 * Re-shape the internal Responses SSE stream into OpenAI `chat.completion.chunk` events.
 *
 * The upstream stream is consumed as-is: this function adds no retry, no buffering policy of its own
 * and no second interpretation of the turn — it only renames events.
 */
export function toChatCompletionStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let sawText = false;
  let finished = false;

  const chunk = (delta: Record<string, unknown>, finish: string | null): string => sseLine({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" }, null)));
      try {
        for (;;) {
          const { done, value } = await reader.read();
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
              if (type === "response.output_text.delta" && typeof event.delta === "string") {
                sawText = true;
                controller.enqueue(encoder.encode(chunk({ content: event.delta }, null)));
              } else if (type === "response.failed") {
                finished = true;
                const failure = responseFailure({ error: (event.response as Record<string, unknown> | undefined)?.error });
                controller.enqueue(encoder.encode(sseLine({
                  error: { message: failure?.message ?? "The provider turn failed.", type: "server_error" },
                })));
              } else if (type === "response.completed" || type === "response.incomplete") {
                finished = true;
                controller.enqueue(encoder.encode(chunk({}, sawText ? "stop" : "stop")));
              }
            }
          }
        }
      } catch (error) {
        controller.enqueue(encoder.encode(sseLine({
          error: { message: error instanceof Error ? error.message : String(error), type: "server_error" },
        })));
      } finally {
        if (!finished) controller.enqueue(encoder.encode(chunk({}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        reader.releaseLock();
      }
    },
  });
}
