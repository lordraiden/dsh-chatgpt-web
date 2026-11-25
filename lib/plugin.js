// src/plugin.ts
import { basename } from "node:path";

// src/plugin/adapter.ts
import {
  LlmAdapter,
  LlmError as LlmError2,
  ReasoningEffortId,
  attributionHeaders,
  resolveRetryPolicy
} from "@deepseek-ai/dsh-llm";

// src/conversation-sanitizer.ts
var TRANSPORT_BLOCKS = [
  ["<system-reminder>", "</system-reminder>"],
  ["<environment_context>", "</environment_context>"],
  ["<dsh_transport_resume>", "</dsh_transport_resume>"],
  ["<AEGIS_DSH_ROUTING_BOOTSTRAP>", "</AEGIS_DSH_ROUTING_BOOTSTRAP>"]
];
var HINDSIGHT_OPEN_TAG = /<(hindsight_[a-z0-9_-]+)(?:\s[^<>]*?)?\s*\/?>/i;
var OPERATIONAL_LINE_PREFIXES = [
  "Time sampled while preparing turn ",
  "Browser time zone for this request:",
  "Elapsed since the preceding model-visible message:"
];
var RUNTIME_CONTEXT_PREAMBLE = /^Current runtime context\b/;
var RUNTIME_CONTEXT_SECTION_LINE = /^(?:Current\b|Approval\b|Delegation depth\b)/;
var PRIVATE_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2";
function sanitizeConversationText(text) {
  let sanitized = stripTaggedBlocks(text);
  sanitized = stripRuntimeContextSnapshot(sanitized);
  if (sanitized.includes(PRIVATE_CHECKPOINT_MARKER)) {
    sanitized = sanitized.slice(0, sanitized.indexOf(PRIVATE_CHECKPOINT_MARKER));
  }
  sanitized = sanitized.split(/\r?\n/).filter((line) => !OPERATIONAL_LINE_PREFIXES.some((prefix) => line.trimStart().startsWith(prefix))).join(`
`);
  return sanitized.trim();
}
function stripRuntimeContextSnapshot(text) {
  const kept = [];
  let inSnapshot = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inSnapshot) {
      if (RUNTIME_CONTEXT_PREAMBLE.test(line.trimStart())) {
        inSnapshot = true;
        continue;
      }
      kept.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || RUNTIME_CONTEXT_SECTION_LINE.test(trimmed))
      continue;
    inSnapshot = false;
    kept.push(line);
  }
  return kept.join(`
`);
}
function stripTaggedBlocks(text) {
  let current = text;
  for (const [open, close] of TRANSPORT_BLOCKS) {
    for (;; ) {
      const start = current.indexOf(open);
      if (start < 0)
        break;
      const end = current.indexOf(close, start + open.length);
      current = end < 0 ? current.slice(0, start) : current.slice(0, start) + current.slice(end + close.length);
    }
  }
  return stripHindsightElements(current);
}
function stripHindsightElements(text) {
  let current = text;
  for (;; ) {
    const opening = HINDSIGHT_OPEN_TAG.exec(current);
    if (!opening || opening.index === undefined)
      break;
    const tagName = opening[1];
    const start = opening.index;
    const closing = new RegExp(`</${tagName}\\s*>`, "i").exec(current.slice(start + opening[0].length));
    if (!closing || closing.index === undefined) {
      current = current.slice(0, start);
      break;
    }
    const end = start + opening[0].length + closing.index + closing[0].length;
    current = current.slice(0, start) + current.slice(end);
  }
  return current;
}

// src/plugin/contract.ts
var PROVIDERS = ["chatgpt-web", "qwen-chat"];

// src/plugin/errors.ts
import {
  LlmError,
  ProviderRequestId,
  isContextWindowExceededError,
  isQuotaExceededError
} from "@deepseek-ai/dsh-llm";
var PKG = "dsh-chatgpt-web";
var DETAIL_LIMIT = 300;
var MODEL_NOT_FOUND_CODE = "UNKNOWN_MODEL";
var PROTOCOL_ERROR_CODE = "MALFORMED_RESPONSE";
function readErrorEnvelope(body) {
  if (body.trim() === "")
    return;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }
  const error = asRecord(asRecord(payload)?.error);
  if (error === undefined)
    return;
  const message = typeof error.message === "string" ? error.message : "";
  const type = typeof error.type === "string" && error.type.trim() !== "" ? error.type.trim() : undefined;
  const code = typeof error.code === "string" && error.code.trim() !== "" ? error.code.trim() : undefined;
  return {
    message,
    ...type === undefined ? {} : { type },
    ...code === undefined ? {} : { code }
  };
}
function parseRetryAfterMs(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim();
  if (trimmed === "")
    return;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const delay2 = Number(trimmed) * 1000;
    return Number.isFinite(delay2) && delay2 > 0 ? delay2 : undefined;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at))
    return;
  const delay = at - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
function mapServiceFailureCode(code, type, message) {
  const normalizedCode = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (normalizedCode.startsWith("endpoint_profile_"))
    return "UNSUPPORTED_OPTION";
  const explicit = SERVICE_CODE_MAP[normalizedCode];
  if (explicit !== undefined && normalizedCode !== "invalid_request_error")
    return explicit;
  const detail = [code, type, message].filter((part) => typeof part === "string").join(" ");
  if (isContextWindowExceededError(detail))
    return "CONTEXT_WINDOW_EXCEEDED";
  if (isQuotaExceededError(detail))
    return "QUOTA";
  if (UNKNOWN_MODEL_PATTERN.test(detail))
    return "UNKNOWN_MODEL";
  if (explicit !== undefined)
    return explicit;
  switch (typeof type === "string" ? type.trim().toLowerCase() : "") {
    case "authentication_error":
      return "AUTH";
    case "rate_limit_error":
      return "RATE_LIMIT";
    case "server_error":
      return "SERVER";
    case "invalid_request_error":
      return "INVALID_REQUEST";
    default:
      return;
  }
}
function httpErrorFromService(status, body, headers) {
  const envelope = readErrorEnvelope(body);
  const detail = (envelope?.message ?? body).trim();
  const mapped = mapServiceFailureCode(envelope?.code, envelope?.type, detail);
  const code = status === 401 || status === 403 ? "AUTH" : mapped !== undefined ? mapped : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : fallbackCodeForStatus(status);
  const options = { status };
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));
  if (retryAfterMs !== undefined)
    options.providerRetryAfterMs = retryAfterMs;
  const requestId = headers.get("x-request-id")?.trim();
  if (requestId !== undefined && requestId !== "")
    options.requestId = ProviderRequestId(requestId);
  return new LlmError(`${PKG}: service request failed (HTTP ${status})${detailSuffix(detail)}`, code, options);
}
function streamErrorFromService(error) {
  const record = asRecord(error);
  const message = typeof record?.message === "string" ? record.message : "";
  const type = typeof record?.type === "string" && record.type.trim() !== "" ? record.type.trim() : undefined;
  const code = mapServiceFailureCode(undefined, type, message) ?? "SERVER";
  return new LlmError(`${PKG}: service stream failed${detailSuffix(message)}`, code);
}
function fallbackCodeForStatus(status) {
  if (status === 408)
    return "TIMEOUT";
  if (status === 499)
    return "ABORTED";
  if (status >= 500)
    return "SERVER";
  return "INVALID_REQUEST";
}
function detailSuffix(detail) {
  const trimmed = detail.trim();
  if (trimmed === "")
    return "";
  const bounded = trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT)}…` : trimmed;
  return `: ${bounded}`;
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
var SERVICE_CODE_MAP = Object.freeze({
  context_exhausted: "CONTEXT_WINDOW_EXCEEDED",
  context_length_exceeded: "CONTEXT_WINDOW_EXCEEDED",
  turn_queue_timeout: "RATE_LIMIT",
  turn_queue_full: "RATE_LIMIT",
  rate_limit_exceeded: "RATE_LIMIT",
  endpoint_profile_concurrency_exceeded: "RATE_LIMIT",
  retained_surface_lost: "SERVER",
  retained_surface_busy: "SERVER",
  retained_delta_empty: "SERVER",
  continuation_prompt_missing: "SERVER",
  answer_recovery_unavailable: "SERVER",
  settlement_wait_timeout: "SERVER",
  turn_timeout: "SERVER",
  upstream_server_error: "SERVER",
  server_is_overloaded: "SERVER",
  qwen_chat_lost: "SERVER",
  compaction_source_unavailable: "INVALID_REQUEST",
  request_too_large: "INVALID_REQUEST",
  invalid_response_format: "INVALID_REQUEST",
  conflicting_max_tokens: "INVALID_REQUEST",
  host_context_only_turn: "INVALID_REQUEST",
  no_user_message: "INVALID_REQUEST",
  invalid_request_error: "INVALID_REQUEST",
  unknown_model: "UNKNOWN_MODEL",
  unknown_reasoning_mode: "UNSUPPORTED_OPTION",
  chatgpt_session_expired: "AUTH",
  qwen_session_missing: "AUTH",
  invalid_api_key: "AUTH",
  insufficient_quota: "QUOTA",
  client_cancelled: "ABORTED",
  client_closed_request: "ABORTED"
});
var UNKNOWN_MODEL_PATTERN = /\bunknown model\b/i;

// src/plugin/sse.ts
class SseDecoder {
  buffer = "";
  dataLines = [];
  eventName;
  id;
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    for (;; ) {
      const terminator = findLineTerminator(this.buffer);
      if (terminator === undefined)
        break;
      const line = this.buffer.slice(0, terminator.index);
      this.buffer = this.buffer.slice(terminator.index + terminator.length);
      this.consumeLine(line, events);
    }
    return events;
  }
  end() {
    const events = [];
    if (this.buffer.endsWith("\r")) {
      const line = this.buffer.slice(0, -1);
      this.buffer = "";
      this.consumeLine(line, events);
    } else if (this.buffer !== "") {
      const line = this.buffer;
      this.buffer = "";
      this.consumeLine(line, events);
    }
    this.dispatch(events);
    return events;
  }
  consumeLine(line, events) {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":"))
      return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" "))
      value = value.slice(1);
    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventName = value;
        break;
      case "id":
        this.id = value;
        break;
      default:
        break;
    }
  }
  dispatch(events) {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      this.id = undefined;
      return;
    }
    const data = this.dataLines.join(`
`);
    const event = this.eventName;
    const id = this.id;
    this.dataLines = [];
    this.eventName = undefined;
    this.id = undefined;
    events.push({
      data,
      ...event === undefined ? {} : { event },
      ...id === undefined ? {} : { id }
    });
  }
}
async function* readSseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder;
  const parser = new SseDecoder;
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.end();
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}
function findLineTerminator(text) {
  for (let index = 0;index < text.length; index += 1) {
    const char = text[index];
    if (char === `
`)
      return { index, length: 1 };
    if (char === "\r") {
      if (index + 1 >= text.length)
        return;
      return { index, length: text[index + 1] === `
` ? 2 : 1 };
    }
  }
  return;
}

// src/plugin/adapter.ts
var PKG2 = "dsh-chatgpt-web";
var CATALOGUE_TTL_MS = 30000;
var CATALOGUE_TIMEOUT_MS = 1e4;
var MAX_ERROR_BODY = 4096;
var PROVIDER_NAMES = Object.freeze({
  "chatgpt-web": "ChatGPT Web",
  "qwen-chat": "Qwen Chat"
});
function createChatGptWebAdapter(deps) {
  return new ChatGptWebAdapter(deps);
}

class ChatGptWebAdapter extends LlmAdapter {
  deps;
  catalogue;
  catalogueFailure;
  constructor(deps) {
    super();
    this.deps = deps;
  }
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAMES[provider] ?? provider };
  }
  providerRetryPolicy(provider) {
    return resolveRetryPolicy({ mode: "normal", maxRetries: 0 }, `${PKG2}: ${provider}.retryPolicy`);
  }
  async listModels(provider) {
    if (!isProviderId(provider))
      return [];
    try {
      const config = this.deps.config();
      const rows = await this.readCatalogue(config);
      if (rows === undefined)
        return [];
      const prefix = `${provider}/`;
      return rows.filter((row) => row.slug.startsWith(prefix)).map((row) => ({ provider, id: row.slug, name: row.name, inputModalities: ["text"] }));
    } catch (error) {
      this.reportCatalogueFailure(errorName(error));
      return [];
    }
  }
  async resolveModel(provider, model, signal) {
    return this.resolveModelWithConfig(provider, model, this.readConfigOrThrow(), signal);
  }
  async prepareCall(provider, model, signal) {
    const config = this.readConfigOrThrow();
    const info = await this.resolveModelWithConfig(provider, model, config, signal);
    const snapshot = snapshotConfig(config);
    return { model: info, stream: (options) => this.streamInternal(options, snapshot) };
  }
  stream(options) {
    return this.streamInternal(options);
  }
  async resolveModelWithConfig(provider, model, config, signal) {
    if (signal?.aborted === true)
      throw abortedError(signal);
    if (!isProviderId(provider)) {
      throw modelNotFound(provider, model, "the provider route is not registered by this plugin");
    }
    if (typeof model !== "string" || !model.startsWith(`${provider}/`)) {
      throw modelNotFound(provider, model, `the model id does not belong to provider "${provider}"`);
    }
    validateBaseUrl(config);
    const rows = await this.readCatalogue(config, signal);
    if (rows === undefined)
      throw modelNotFound(provider, model, "the service model catalogue is unavailable");
    const row = rows.find((entry) => entry.slug === model);
    if (row === undefined) {
      throw modelNotFound(provider, model, "the service model catalogue does not list it");
    }
    if (row.contextWindow === undefined) {
      throw modelNotFound(provider, model, "the service model catalogue does not declare a context_window");
    }
    const reasoning = provider === "qwen-chat" ? reasoningInfo(row.reasoning) : undefined;
    return {
      provider,
      id: model,
      name: row.name,
      inputModalities: ["text"],
      context: { contextWindow: row.contextWindow },
      ...reasoning === undefined ? {} : { reasoning }
    };
  }
  async readCatalogue(config, signal) {
    const cached = this.catalogue;
    if (cached !== undefined && cached.baseUrl === config.baseUrl && Date.now() - cached.fetchedAt < CATALOGUE_TTL_MS) {
      return cached.rows;
    }
    const timeoutMs = config.requestTimeoutMs > 0 ? config.requestTimeoutMs : CATALOGUE_TIMEOUT_MS;
    const controller = new AbortController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("catalogue timeout"));
    }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw abortedError(signal);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetch(endpointUrl(config.baseUrl, "/v1/models"), {
        method: "GET",
        headers: requestHeaders(config, false),
        signal: controller.signal
      });
      if (!response.ok) {
        this.reportCatalogueFailure(`HTTP ${response.status}`);
        return;
      }
      const payload = await response.json();
      const rows = parseCatalogue(payload);
      this.catalogue = { baseUrl: config.baseUrl, fetchedAt: Date.now(), rows };
      this.catalogueFailure = undefined;
      return rows;
    } catch (error) {
      if (signal?.aborted === true)
        throw abortedError(signal);
      this.reportCatalogueFailure(timedOut ? "timeout" : errorName(error));
      return;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  reportCatalogueFailure(signature) {
    if (this.catalogueFailure === signature)
      return;
    this.catalogueFailure = signature;
    this.deps.logger?.warn(`${PKG2}: the service model catalogue is unavailable (${signature}); model resolution fails until it recovers`);
  }
  readConfigOrThrow() {
    try {
      return this.deps.config();
    } catch (error) {
      throw new LlmError2(`${PKG2}: the plugin configuration cannot be read`, "INVALID_CONFIG", { cause: error });
    }
  }
  async* streamInternal(options, captured) {
    let config;
    if (captured !== undefined) {
      config = captured;
    } else {
      try {
        config = this.deps.config();
      } catch (error) {
        throw new LlmError2(`${PKG2}: the plugin configuration cannot be read`, "INVALID_CONFIG", { cause: error });
      }
    }
    validateBaseUrl(config);
    const body = buildRequestBody(options, this.deps);
    const controller = new AbortController;
    let timedOut = false;
    let timer;
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal !== undefined) {
      if (options.signal.aborted)
        throw abortedError(options.signal);
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (config.requestTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("request timeout"));
      }, config.requestTimeoutMs);
    }
    try {
      let response;
      try {
        response = await fetch(endpointUrl(config.baseUrl, "/v1/chat/completions"), {
          method: "POST",
          headers: requestHeaders(config, true),
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        throw transportError(error, options.signal, timedOut, config);
      }
      if (!response.ok) {
        const text = await readErrorBody(response);
        throw httpErrorFromService(response.status, text, response.headers);
      }
      if (response.body === null) {
        throw new LlmError2(`${PKG2}: the service returned no response body`, "EMPTY_RESPONSE", {
          status: response.status
        });
      }
      yield* this.readCompletionStream(response.body, options, () => timedOut);
    } finally {
      if (timer !== undefined)
        clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  async* readCompletionStream(body, options, timedOut) {
    let text = "";
    let started = false;
    let usage;
    let finishReason;
    let sawDone = false;
    let sawTerminal = false;
    try {
      for await (const event of readSseEvents(body)) {
        if (options.signal?.aborted === true)
          throw abortedError(options.signal);
        const data = event.data.trim();
        if (data === "")
          continue;
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let payload;
        try {
          payload = JSON.parse(data);
        } catch (error) {
          throw new LlmError2(`${PKG2}: the service sent a malformed SSE frame`, PROTOCOL_ERROR_CODE, {
            cause: error
          });
        }
        const errorFrame = asRecord2(asRecord2(payload)?.error);
        if (errorFrame !== undefined)
          throw streamErrorFromService(errorFrame);
        const parsedUsage = usageFromPayload(payload);
        if (parsedUsage !== undefined)
          usage = parsedUsage;
        const choice = firstChoice(payload);
        if (choice === undefined)
          continue;
        const deltaText = deltaTextOf(choice.delta);
        if (deltaText !== "") {
          if (!started) {
            started = true;
            yield { type: "block-start", index: 0, blockType: "text" };
          }
          text += deltaText;
          yield { type: "text-delta", index: 0, text: deltaText };
        }
        const reason = choice.finish_reason;
        if (reason !== null && reason !== undefined) {
          finishReason = typeof reason === "string" ? reason : String(reason);
          sawTerminal = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof LlmError2)
        throw error;
      if (options.signal?.aborted === true)
        throw abortedError(options.signal);
      if (timedOut()) {
        throw new LlmError2(`${PKG2}: the service stream timed out`, "TIMEOUT", { cause: error });
      }
      throw new LlmError2(`${PKG2}: the service stream failed`, "TRANSPORT", { cause: error });
    }
    if (text === "") {
      throw new LlmError2(`${PKG2}: the service completed without producing any text`, "EMPTY_RESPONSE");
    }
    if (!sawTerminal && !sawDone) {
      throw new LlmError2(`${PKG2}: the service stream ended before a terminal frame`, "TRANSPORT");
    }
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    if (usage !== undefined)
      yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: finishReason === "length" ? "max-tokens" : "stop" } };
  }
}
function buildRequestBody(options, deps) {
  const purpose = requestPurpose(options);
  const messages = purpose === undefined ? normalTurnMessages(options.messages) : auxiliaryTurnMessages(options);
  const metadata = turnMetadata(options, deps, purpose);
  const body = {
    model: options.model,
    messages,
    stream: true
  };
  if (metadata !== undefined)
    body.client_metadata = { "x-codex-turn-metadata": JSON.stringify(metadata) };
  if (options.provider === "qwen-chat" && options.reasoningEffort !== undefined) {
    body.reasoning_effort = String(options.reasoningEffort);
  }
  return body;
}
function turnMetadata(options, deps, purpose) {
  const metadata = {};
  if (options.sessionId !== undefined)
    metadata.dsh_session_id = String(options.sessionId);
  if (purpose !== undefined) {
    metadata.purpose = purpose;
  } else {
    const workspace = deps.workspaceFor(options.sessionId);
    if (typeof workspace === "string" && workspace.trim() !== "")
      metadata.workspace = workspace.trim();
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}
function requestPurpose(options) {
  const purpose = options.purpose;
  return typeof purpose === "string" && purpose.trim() !== "" ? purpose.trim() : undefined;
}
function normalTurnMessages(messages) {
  for (let index = messages.length - 1;index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user")
      continue;
    const text = userTextOf(message.content);
    if (sanitizeConversationText(text) !== "")
      return [{ role: "user", content: text }];
  }
  throw new LlmError2(`${PKG2}: the request carries no human user message to send`, "INVALID_REQUEST");
}
function auxiliaryTurnMessages(options) {
  const conversation = [];
  for (const message of options.messages) {
    if (message.role === "user") {
      conversation.push({ role: "user", content: userTextOf(message.content) });
    } else if (message.role === "assistant") {
      conversation.push({ role: "assistant", content: textOf(message.content) });
    }
  }
  let lastUser = -1;
  for (let index = conversation.length - 1;index >= 0; index -= 1) {
    if (conversation[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) {
    throw new LlmError2(`${PKG2}: the auxiliary request carries no user message`, "INVALID_REQUEST");
  }
  if (lastUser !== conversation.length - 1) {
    throw new LlmError2(`${PKG2}: the auxiliary request must end with a user message`, "INVALID_REQUEST");
  }
  const systemText = systemTextOf(options);
  if (systemText !== "") {
    const user = conversation[lastUser];
    conversation[lastUser] = {
      role: "user",
      content: user.content.trim() === "" ? systemText : `${systemText}

${user.content}`
    };
  }
  return conversation;
}
function systemTextOf(options) {
  const parts = [];
  if (typeof options.system === "string" && options.system.trim() !== "")
    parts.push(options.system.trim());
  for (const message of options.messages) {
    if (message.role !== "system")
      continue;
    const text = textOf(message.content).trim();
    if (text !== "")
      parts.push(text);
  }
  return parts.join(`

`);
}
function textOf(content) {
  let text = "";
  for (const block of content) {
    if (block.type === "text")
      text += block.text;
  }
  return text;
}
function userTextOf(content) {
  let text = "";
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
      continue;
    }
    throw new LlmError2(`${PKG2}: the request contains unsupported ${block.type} content; this provider is text-only`, "UNSUPPORTED_CONTENT");
  }
  return text;
}
function reasoningInfo(reasoning) {
  if (reasoning === undefined || reasoning.efforts.length === 0)
    return;
  return {
    efforts: reasoning.efforts.map((effort) => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
    ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(reasoning.defaultEffort) }
  };
}
function parseCatalogue(payload) {
  const record = asRecord2(payload);
  const models = Array.isArray(record?.models) && record.models.length > 0 ? record.models : Array.isArray(record?.data) ? record.data : [];
  const rows = [];
  const seen = new Set;
  for (const entry of models) {
    const row = asRecord2(entry);
    if (row === undefined)
      continue;
    const slug = typeof row.slug === "string" ? row.slug.trim() : typeof row.id === "string" ? row.id.trim() : "";
    if (slug === "" || seen.has(slug))
      continue;
    if (!slug.startsWith("chatgpt-web/") && !slug.startsWith("qwen-chat/"))
      continue;
    seen.add(slug);
    const name = typeof row.display_name === "string" && row.display_name.trim() !== "" ? row.display_name.trim() : typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : slug;
    const contextWindow = typeof row.context_window === "number" && Number.isInteger(row.context_window) && row.context_window > 0 ? row.context_window : undefined;
    const reasoning = reasoningFromRow(row);
    rows.push({
      slug,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...reasoning === undefined ? {} : { reasoning }
    });
  }
  return rows;
}
function reasoningFromRow(row) {
  const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : [];
  const efforts = [];
  const seen = new Set;
  for (const level of levels) {
    const record = asRecord2(level);
    const id = typeof record?.effort === "string" ? record.effort.trim() : "";
    if (id === "" || seen.has(id))
      continue;
    seen.add(id);
    const name = typeof record?.description === "string" && record.description.trim() !== "" ? record.description.trim() : id;
    efforts.push({ id, name });
  }
  if (efforts.length === 0)
    return;
  const declaredDefault = typeof row.default_reasoning_level === "string" ? row.default_reasoning_level.trim() : "";
  return {
    efforts,
    ...declaredDefault !== "" && seen.has(declaredDefault) ? { defaultEffort: declaredDefault } : {}
  };
}
function firstChoice(payload) {
  const choices = asRecord2(payload)?.choices;
  return Array.isArray(choices) ? asRecord2(choices[0]) : undefined;
}
function deltaTextOf(delta) {
  const record = asRecord2(delta);
  if (record === undefined)
    return "";
  const content = record.content;
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  let text = "";
  for (const part of content) {
    const recordPart = asRecord2(part);
    if (recordPart?.type === "text" && typeof recordPart.text === "string")
      text += recordPart.text;
  }
  return text;
}
function usageFromPayload(payload) {
  const usage = asRecord2(asRecord2(payload)?.usage);
  if (usage === undefined)
    return;
  const input = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens);
  const output = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens);
  if (input === undefined && output === undefined)
    return;
  const total = numberOrUndefined(usage.total_tokens);
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...total === undefined ? {} : { totalTokens: total }
  };
}
function transportError(error, signal, timedOut, config) {
  if (signal?.aborted === true)
    return abortedError(signal);
  if (timedOut) {
    return new LlmError2(`${PKG2}: the service request timed out after ${config.requestTimeoutMs} ms`, "TIMEOUT", {
      cause: error
    });
  }
  return new LlmError2(`${PKG2}: cannot reach the service at ${displayBaseUrl(config.baseUrl)} (${errorName(error)})`, "TRANSPORT", { cause: error });
}
function abortedError(signal) {
  return new LlmError2(`${PKG2}: the request was aborted by the caller`, "ABORTED", { cause: signal.reason });
}
function modelNotFound(provider, model, reason) {
  return new LlmError2(`${PKG2}: model "${model}" is not available on provider "${provider}": ${reason}`, MODEL_NOT_FOUND_CODE);
}
function validateBaseUrl(config) {
  if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
    throw new LlmError2(`${PKG2}: the service baseUrl is not configured`, "INVALID_CONFIG");
  }
}
function endpointUrl(baseUrl, path) {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}
function requestHeaders(config, stream) {
  const headers = { ...attributionHeaders() };
  if (stream) {
    headers["content-type"] = "application/json";
    headers.accept = "text/event-stream";
  } else {
    headers.accept = "application/json";
  }
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (apiKey !== "")
    headers.authorization = `Bearer ${apiKey}`;
  return headers;
}
function snapshotConfig(config) {
  return {
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    ...config.apiKey === undefined ? {} : { apiKey: config.apiKey }
  };
}
async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text;
  } catch {
    return "";
  }
}
function displayBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "the configured service";
  }
}
function errorName(error) {
  return error instanceof Error && error.name !== "" ? error.name : "unknown error";
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isProviderId(value) {
  return PROVIDERS.includes(value);
}

// src/plugin/config.ts
import z from "@deepseek-ai/schemastery";
var DEFAULT_BASE_URL = "http://127.0.0.1:17842";
var DEFAULT_MODEL = "chatgpt-web/luna";
var DEFAULT_REQUEST_TIMEOUT_MS = 0;
var Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).description("Service root; may include an endpoint profile: http://127.0.0.1:17842/p/<profile>.").volatile(),
  apiKey: z.string().role("secret").description("Service API key; optional on a loopback service.").volatile(),
  controlToken: z.string().role("secret").description("Service control token; used only for status and sign-in reads.").volatile(),
  model: z.string().default(DEFAULT_MODEL).description("Default catalogue model route served by the service.").volatile(),
  requestTimeoutMs: z.number().step(1).min(0).default(DEFAULT_REQUEST_TIMEOUT_MS).description("Client-side HTTP timeout in milliseconds; 0 disables it.").volatile()
});
function readValue(value) {
  if (value === undefined || value === null)
    return;
  if (typeof value === "object" && typeof value.get === "function") {
    return value.get();
  }
  return value;
}
function readText(value) {
  const raw = readValue(value);
  if (typeof raw !== "string")
    return;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}
function readTimeout(value) {
  const raw = readValue(value);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.floor(raw);
}
function resolvePluginConfig(input) {
  const apiKey = readText(input?.apiKey);
  const controlToken = readText(input?.controlToken);
  return {
    baseUrl: readText(input?.baseUrl) ?? DEFAULT_BASE_URL,
    model: readText(input?.model) ?? DEFAULT_MODEL,
    requestTimeoutMs: readTimeout(input?.requestTimeoutMs),
    ...apiKey === undefined ? {} : { apiKey },
    ...controlToken === undefined ? {} : { controlToken }
  };
}

// src/plugin/status.ts
var STATUS_ROUTE_PATH = "/plugins/dsh-chatgpt-web/status";
var STATUS_TIMEOUT_MS = 25000;
var MAX_TEXT = 200;
function createStatusHandler(deps) {
  const timeoutMs = deps.timeoutMs ?? STATUS_TIMEOUT_MS;
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let status;
    try {
      status = await readStatus(deps, timeoutMs);
    } catch (error) {
      deps.logger?.warn(`status route failed (${errorName2(error)})`);
      status = unavailableStatus("status unavailable");
    }
    const body = JSON.stringify(status);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
async function readStatus(deps, timeoutMs) {
  let config;
  try {
    config = deps.config();
  } catch {
    return unavailableStatus("invalid configuration");
  }
  const endpoints = endpointsFor(config.baseUrl);
  if (endpoints === undefined)
    return unavailableStatus("invalid baseUrl");
  const secrets = [config.apiKey, config.controlToken].filter((secret) => typeof secret === "string" && secret !== "");
  const signal = AbortSignal.timeout(timeoutMs);
  const bearer = config.controlToken === undefined ? undefined : { authorization: `Bearer ${config.controlToken}` };
  const [health, control, authHealth, models] = await Promise.all([
    fetchJson(`${endpoints.controlBase}/healthz`, {}, signal),
    bearer === undefined ? Promise.resolve(undefined) : fetchJson(`${endpoints.controlBase}/v1/control/status`, bearer, signal),
    bearer === undefined ? Promise.resolve(undefined) : fetchJson(`${endpoints.controlBase}/v1/control/auth/health`, bearer, signal),
    readCatalogue(endpoints, config.apiKey, signal)
  ]);
  return {
    service: serviceView(health, secrets),
    auth: authView(config.controlToken, control, authHealth, secrets),
    models: [...new Set(models)].map((model) => sanitize(model, secrets)),
    controlBase: endpoints.controlBase,
    authPageUrl: `${endpoints.controlBase}/v1/control/auth/`
  };
}
function serviceView(outcome, secrets) {
  if (!outcome.ok) {
    return { reachable: false, version: null, status: null, error: sanitize(outcome.error, secrets) };
  }
  const body = asRecord3(outcome.body);
  return {
    reachable: true,
    version: typeof body?.version === "string" ? sanitize(body.version, secrets) : null,
    status: typeof body?.status === "string" ? sanitize(body.status, secrets) : null,
    error: null
  };
}
function authView(controlToken, control, health, secrets) {
  if (controlToken === undefined)
    return null;
  const controlBody = control?.ok === true ? asRecord3(control.body) : undefined;
  const healthBody = health?.ok === true ? asRecord3(health.body) : undefined;
  const rows = healthBody !== undefined && Array.isArray(healthBody.providers) ? healthBody.providers.map(asRecord3).filter((row) => row !== undefined) : [];
  const configured = controlBody?.storageStatePresent === true || rows.some((row) => row.capturePresent === true);
  const primary = rows.find((row) => row.state === "verified") ?? rows[0];
  const state = primary !== undefined && typeof primary.state === "string" ? primary.state : null;
  const label = primary !== undefined && typeof primary.label === "string" ? primary.label.trim() : "";
  const reason = primary !== undefined && typeof primary.reason === "string" ? primary.reason.trim() : "";
  const detail = reason !== "" ? reason : label !== "" && state !== null ? `${label}: ${state}` : control?.ok === false ? `control token rejected or control status unavailable (${control.error})` : health?.ok === false ? `auth health unavailable (${health.error})` : null;
  return {
    configured,
    state: state === null ? null : sanitize(state, secrets),
    detail: detail === null ? null : sanitize(detail, secrets)
  };
}
function unavailableStatus(error) {
  return {
    service: { reachable: false, version: null, status: null, error },
    auth: null,
    models: [],
    controlBase: "",
    authPageUrl: ""
  };
}
function endpointsFor(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const apiPath = url.pathname.replace(/\/+$/, "");
  const profile = /^(.*)\/p\/[^/]+$/.exec(apiPath);
  const controlPath = profile === null ? apiPath : profile[1];
  return {
    controlBase: `${url.origin}${controlPath}`,
    apiBase: `${url.origin}${apiPath}`
  };
}
async function fetchJson(url, headers, signal) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {
        return;
      });
      return { ok: false, error: `HTTP ${response.status}` };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "invalid response" };
    }
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: describeFetchError(error) };
  }
}
function describeFetchError(error) {
  const name = errorName2(error);
  if (name === "TimeoutError" || name === "AbortError")
    return "timeout";
  return "unreachable";
}
function errorName2(error) {
  return error instanceof Error ? error.name : "unknown";
}
async function readCatalogue(endpoints, apiKey, signal) {
  const headers = apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
  const outcome = await fetchJson(`${endpoints.apiBase}/v1/models`, headers, signal);
  if (!outcome.ok)
    return [];
  const body = asRecord3(outcome.body);
  const rows = Array.isArray(body?.models) && body.models.length > 0 ? body.models : Array.isArray(body?.data) ? body.data : [];
  const slugs = [];
  const seen = new Set;
  for (const entry of rows) {
    const row = asRecord3(entry);
    if (row === undefined)
      continue;
    const slug = typeof row.slug === "string" ? row.slug.trim() : typeof row.id === "string" ? row.id.trim() : "";
    if (slug === "" || seen.has(slug))
      continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}
function asRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function sanitize(text, secrets) {
  let clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  for (const secret of secrets) {
    if (secret !== "")
      clean = clean.split(secret).join("[redacted]");
  }
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

// src/plugin.ts
var name = "dsh-chatgpt-web";
var inject = ["llm", "sessions"];
var LOG_TAG = "chatgpt-web";
function createLogger(ctx) {
  try {
    const logger = ctx.logger?.(LOG_TAG);
    if (logger !== undefined && typeof logger.info === "function") {
      return {
        info: (message) => logger.info(escapeFormat(message)),
        warn: (message) => logger.warn(escapeFormat(message)),
        error: (message) => logger.error(escapeFormat(message)),
        debug: (message) => logger.debug(escapeFormat(message))
      };
    }
  } catch {}
  return {
    info: (message) => console.info(`[${LOG_TAG}] ${message}`),
    warn: (message) => console.warn(`[${LOG_TAG}] ${message}`),
    error: (message) => console.error(`[${LOG_TAG}] ${message}`),
    debug: (message) => console.debug(`[${LOG_TAG}] ${message}`)
  };
}
function escapeFormat(message) {
  return message.replace(/%/g, "%%");
}
function describeEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "<invalid baseUrl>";
  }
}
function apply(ctx, config) {
  const logger = createLogger(ctx);
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  const currentConfig = () => resolvePluginConfig(config);
  const workspaceFor = (sessionId) => {
    if (sessionId === undefined || sessionId === "")
      return;
    let session;
    try {
      session = ctx.sessions.get(sessionId);
    } catch {
      return;
    }
    const cwd = session?.header?.cwd;
    if (typeof cwd !== "string")
      return;
    const workspace = basename(cwd);
    return workspace === "" ? undefined : workspace;
  };
  const adapter = createChatGptWebAdapter({ config: currentConfig, workspaceFor, logger });
  ctx.llm.registerAdapter([...PROVIDERS], adapter);
  ctx.inject(["webServer"], (child) => {
    const webServer = child.webServer;
    if (webServer === undefined)
      return;
    child.effect(() => webServer.register({
      kind: "exact",
      path: STATUS_ROUTE_PATH,
      handler: createStatusHandler({ config: currentConfig, logger })
    }));
  });
  ctx.inject(["settings"], (child) => {
    const settings = child.settings;
    if (settings === undefined)
      return;
    child.effect(() => settings.configure({ auto: false }, ctx.fiber));
  });
  const initial = currentConfig();
  logger.info(`registered ${PROVIDERS.map((provider) => `"${provider}"`).join(", ")} for model "${initial.model}"` + ` via ${describeEndpoint(initial.baseUrl)} (settings namespace "${settingsNs}")`);
}
var plugin_default = { name, inject, Config, apply };
export {
  Config,
  apply,
  plugin_default as default,
  inject,
  name
};
