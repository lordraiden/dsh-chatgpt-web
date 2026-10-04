/**
 * Native DSH LLM provider boundary for ChatGPT Web (issue #8).
 *
 * `ChatGptWebLlmAdapter` is the only new DSH-facing seam. It registers the
 * `chatgpt-web` provider through `ctx.llm.registerAdapter`, resolves models
 * through the existing `chatgpt-web-models` catalogue (no second catalogue),
 * and streams turns through the authenticated local execution sidecar. The sidecar owns the
 * single ChatGPT Web ProviderCore used by both native DSH and Responses execution paths.
 * The DSH-facing adapter never touches DOM selectors or Playwright objects.
 *
 * Registration is lazy: the constructor performs no I/O, so loading the
 * plugin and registering the provider never requires a logged-in browser.
 * Missing configuration/auth are surfaced at call time as stable, typed
 * `LlmError`s translated into terminal `error`/`aborted` StreamChunks.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolSchema,
  type ResolvedRetryPolicy,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { resolveChatGptWebContextLimits } from "../../chatgpt-web-models";
import {
  availableChatGptWebRoutes,
  createChatGptWebRouteAuthorityFromProvider,
  requireChatGptWebRoute,
} from "../../chatgpt-web-authority";
import { loadConfig, providerConfig } from "../../config";
import { COMPACT_PROMPT } from "../../lib/compaction";
import {
  type AdapterEvent,
  type CodexAssistantContentPart,
  type CodexContentPart,
  type CodexMessage,
  type CodexParsedRequest,
  type CodexTool,
  type CodexUsage,
  type DshNativeTurnContext,
} from "../../types";
import type { ProviderAdapter } from "../base";
import { createChatGptWebAdapter } from "./index";

export const CHATGPT_WEB_PROVIDER_ID = "chatgpt-web";

export interface LlmAdapterDeps {
  /** Build the provider configuration. Defaults to `loadConfig() + providerConfig()`. */
  loadProvider?: () => ReturnType<typeof providerConfig>;
  /** Build the provider backend. Defaults to `createChatGptWebAdapter`. */
  createBackend?: (provider: ReturnType<typeof providerConfig>) => ProviderAdapter;
  /** Resolve the authenticated local sidecar transport used by production native DSH turns. */
  resolveNativeDshTransport?: () => { baseUrl: string; controlToken: string };
  /**
   * Resolve trusted DSH session/sandbox context for the current native LLM call.
   * The resolver is supplied by the plugin boundary, not by the backend.
   */
  resolveNativeDshContext?: (
    options: GenerateOptions,
    turnId: string,
    threadId: string,
  ) => DshNativeTurnContext;
}

export class ChatGptWebLlmAdapter extends LlmAdapter {
  private readonly loadProvider: () => ReturnType<typeof providerConfig>;
  private readonly createBackend: (provider: ReturnType<typeof providerConfig>) => ProviderAdapter;
  private readonly resolveNativeDshTransport?: () => { baseUrl: string; controlToken: string };
  private readonly resolveNativeDshContext: NonNullable<LlmAdapterDeps["resolveNativeDshContext"]>;
  private providerMemo: ReturnType<typeof providerConfig> | undefined;
  private backendMemo: ProviderAdapter | undefined;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(deps: LlmAdapterDeps = {}) {
    super();
    this.loadProvider = deps.loadProvider ?? (() => providerConfig(loadConfig()));
    this.createBackend = deps.createBackend ?? (provider => createChatGptWebAdapter(provider));
    this.resolveNativeDshTransport = deps.resolveNativeDshTransport;
    this.resolveNativeDshContext = deps.resolveNativeDshContext ?? ((options, turnId, threadId) => ({
      ...(options.sessionId !== undefined ? { dshSessionId: String(options.sessionId) } : {}),
      threadId,
      turnId,
      ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
    }));
  }

  private resolveProvider(): ReturnType<typeof providerConfig> {
    if (!this.providerMemo) {
      try {
        this.providerMemo = this.loadProvider();
      } catch (error) {
        throw new LlmError(
          `ChatGPT Web provider configuration is unavailable: ${errorMessage(error)}`,
          "PROVIDER_CONFIG",
          { cause: error },
        );
      }
    }
    return this.providerMemo;
  }

  private resolveBackend(): ProviderAdapter {
    if (this.shuttingDown) {
      throw new LlmError("ChatGPT Web provider is shutting down.", "PROVIDER_CONFIG");
    }
    if (!this.backendMemo) {
      this.backendMemo = this.createBackend(this.resolveProvider());
    }
    return this.backendMemo;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "ChatGPT Web" };
  }

  /**
   * ChatGPT Web owns browser submission/recovery authority. Disable the optional
   * DSH provider retry executor so a browser turn cannot be retried by two
   * independent authorities.
   */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(
      {
        mode: "normal",
        maxRetries: 0,
      },
      `llm.provider.${provider}.retryPolicy`,
    );
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.resolveProvider();
    const models = new Map<string, LlmModelInfo>();
    for (const route of requireRouteList(config)) {
      models.set(route.slug, {
        provider,
        id: route.slug,
        name: route.displayName,
        description: route.description,
        inputModalities: ["text"],
      });
    }
    return [...models.values()];
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const config = this.resolveProvider();
    let route;
    try {
      const authority = createChatGptWebRouteAuthorityFromProvider(config);
      route = requireChatGptWebRoute(model, authority);
    } catch (error) {
      throw new LlmError(
        `ChatGPT Web model is not available: ${model} (${errorMessage(error)})`,
        "NO_MODEL",
        { cause: error },
      );
    }
    const authority = createChatGptWebRouteAuthorityFromProvider(config);
    const limits = resolveChatGptWebContextLimits(
      route.backendModel,
      route.adapterEffort,
      {
        solAvailable: authority.capabilities.solAvailable === "supported",
        proAvailable: authority.capabilities.proAvailable === "supported",
        experimentalBiggerContext: authority.browserInteractionMode === "automatic"
          ? config.chatgptWeb?.experimentalBiggerContext
          : false,
        browserInteractionMode: authority.browserInteractionMode,
        zeroRiskProEnabled: authority.zeroRiskProEnabled,
      },
    );
    return {
      provider,
      id: route.slug,
      name: route.displayName,
      description: route.description,
      inputModalities: ["text"],
      context: { contextWindow: limits.contextWindow },
      // Every catalog row is pinned to exactly one reasoning effort, mirroring
      // the Responses ingress (server.ts forces `route.adapterEffort`).
      reasoning: {
        efforts: [{ id: ReasoningEffortId(route.adapterEffort), name: route.displayName }],
        defaultEffort: ReasoningEffortId(route.adapterEffort),
      },
    };
  }

  /** Whether `model` is a resolvable ChatGPT Web model (slug or backend id). */
  isSupportedModel(model: string): boolean {
    try {
      requireChatGptWebRoute(model, createChatGptWebRouteAuthorityFromProvider(this.resolveProvider()));
      return true;
    } catch {
      return false;
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Resolution is deferred into the stream so missing config/auth become a
    // terminal `finish` chunk with a stable code, never a synchronous throw.
    return mapStream(
      () => {
        const transport = this.resolveNativeDshTransport?.();
        return transport
          ? createNativeDshRemoteBackend(options.model, transport)
          : this.resolveBackend();
      },
      options,
      () => {
        try {
          return toCodexParsedRequest(options, this.resolveProvider(), this.resolveNativeDshContext);
        } catch (error) {
          if (error instanceof LlmError) throw error;
          throw new LlmError(
            `ChatGPT Web cannot represent this request: ${errorMessage(error)}`,
            "UNSUPPORTED_OPTION",
            { cause: error },
          );
        }
      },
      { usageMode: "omit" },
    );
  }

  /** Dispose the lazily-created browser provider without creating one during shutdown. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const backend = this.backendMemo;
    this.backendMemo = undefined;
    this.shutdownPromise = backend?.shutdown
      ? Promise.resolve(backend.shutdown())
      : Promise.resolve();
    await this.shutdownPromise;
  }
}

/** Resolve the resolvable model routes for a provider configuration. */
function requireRouteList(provider: ReturnType<typeof providerConfig>) {
  return availableChatGptWebRoutes(createChatGptWebRouteAuthorityFromProvider(provider));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function createNativeDshRemoteBackend(
  publicModel: string,
  transport: { baseUrl: string; controlToken: string },
): ProviderAdapter {
  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const response = await fetch(transport.baseUrl.replace(/\/$/, "") + "/internal/native-llm", {
        method: "POST",
        headers: {
          authorization: "Bearer " + transport.controlToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: publicModel, request: parsed }),
        signal: incoming.abortSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(body || ("ChatGPT Web sidecar rejected native DSH turn (HTTP " + response.status + ")."));
      }
      if (!response.body) throw new Error("ChatGPT Web sidecar returned an empty native DSH stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            emit(JSON.parse(line) as AdapterEvent);
          }
        }
        buffer += decoder.decode();
        const tail = buffer.trim();
        if (tail) emit(JSON.parse(tail) as AdapterEvent);
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}

/**
 * Project a DSH `GenerateOptions` request into the existing internal backend request shape.
 * `CodexParsedRequest` is transport compatibility only; native DSH authority is carried
 * separately in `_dshContext`.
 */
export function toCodexParsedRequest(
  options: GenerateOptions,
  provider: ReturnType<typeof providerConfig>,
  resolveNativeDshContext: NonNullable<LlmAdapterDeps["resolveNativeDshContext"]> = (request, turnId, threadId) => ({
    ...(request.sessionId !== undefined ? { dshSessionId: String(request.sessionId) } : {}),
    threadId,
    turnId,
    ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
  }),
): CodexParsedRequest {
  const authority = createChatGptWebRouteAuthorityFromProvider(provider);
  let route;
  try {
    route = requireChatGptWebRoute(options.model, authority);
  } catch (error) {
    throw new LlmError(`ChatGPT Web model is not available: ${options.model} (${errorMessage(error)})`, "NO_MODEL", { cause: error });
  }
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== route.adapterEffort) {
    throw new LlmError(
      `ChatGPT Web model ${route.slug} is pinned to reasoning effort "${route.adapterEffort}"; "${options.reasoningEffort}" is not supported for this route.`,
      "UNSUPPORTED_OPTION",
    );
  }

  const nativeOptions = options as GenerateOptions & Record<string, unknown>;
  const unsupportedOptions: string[] = [];
  for (const key of [
    "maxTokens",
    "temperature",
    "stop",
    "topP",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
    "toolChoice",
    "parallelToolCalls",
    "verbosity",
    "responseFormat",
  ]) {
    if (nativeOptions[key] !== undefined) unsupportedOptions.push(key);
  }
  if (unsupportedOptions.length > 0) {
    throw new LlmError(
      `ChatGPT Web browser transport cannot faithfully apply GenerateOptions: ${unsupportedOptions.join(", ")}. Refusing to silently discard unsupported options.`,
      "UNSUPPORTED_OPTION",
    );
  }

  if (options.tools?.some(tool => {
    const extended = tool as ToolSchema & { freeform?: boolean; toolSearch?: boolean };
    return extended.freeform === true || extended.toolSearch === true;
  })) {
    throw new LlmError(
      "ChatGPT Web native provider does not support freeform or tool-search tool semantics in this phase.",
      "UNSUPPORTED_OPTION",
    );
  }
  if (options.tools?.some(tool => tool.deferLoading === true)) {
    throw new LlmError(
      "ChatGPT Web native provider does not support deferred tool loading in this phase; refusing to discard deferLoading.",
      "UNSUPPORTED_OPTION",
    );
  }

  const systemPrompt: string[] = [];
  if (options.system && options.system.trim()) systemPrompt.push(options.system);

  const toolCallsById = new Map<string, { name: string; namespace?: string }>();
  for (const message of options.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "tool-call") continue;
      const namespace = (block as unknown as { namespace?: string }).namespace;
      toolCallsById.set(String(block.id), {
        name: block.name,
        ...(typeof namespace === "string" && namespace.length > 0 ? { namespace } : {}),
      });
    }
  }

  const messages: CodexMessage[] = [];
  for (const message of options.messages) {
    const mapped = mapRequestMessage(message, toolCallsById);
    if (mapped === "system") {
      const text = (message.content ?? [])
        .filter(block => block.type === "text")
        .map(block => (block as { text: string }).text)
        .join("\n");
      if (text) systemPrompt.push(text);
      continue;
    }
    messages.push(mapped);
  }
  if (messages.length === 0) {
    throw new LlmError("ChatGPT Web requires at least one user message.", "UNSUPPORTED_OPTION");
  }

  const tools: CodexTool[] | undefined = options.tools?.length
    ? options.tools.map((tool: ToolSchema) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
      }))
    : undefined;

  const turnId = randomUUID();
  const dshSessionId = options.sessionId !== undefined ? String(options.sessionId) : undefined;
  const threadId = dshSessionId
    ? `dsh-${createHash("sha256").update(dshSessionId).digest("hex").slice(0, 24)}`
    : `dsh-request-${turnId}`;
  const purpose = options.purpose;
  const dshContext = resolveNativeDshContext(options, turnId, threadId);
  const input = nativeInputFromMessages(messages, systemPrompt, turnId, purpose);

  const contextMessages = [...messages];
  if (purpose === "compaction") {
    if (tools?.length) {
      throw new LlmError("ChatGPT Web compaction requests cannot include tools.", "UNSUPPORTED_OPTION");
    }
    contextMessages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const reasoning = purpose === "session-title" || purpose === "compaction" ? undefined : route.adapterEffort;
  return {
    modelId: route.backendModel,
    context: {
      ...(systemPrompt.length ? { systemPrompt } : {}),
      messages: contextMessages,
      ...(tools ? { tools } : {}),
    },
    stream: true,
    options: {
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(purpose === "session-title" || purpose === "compaction" ? { hideThinkingSummary: true } : {}),
    },
    _dshContext: dshContext,
    // Internal transport projection for the existing browser backend. It is deliberately
    // metadata-free: DSH authority comes from `_dshContext`, never from this raw body.
    _rawBody: { input },
    ...(purpose === "compaction" ? { _compactionRequest: true } : {}),
  };
}

function nativeInputFromMessages(
  messages: readonly CodexMessage[],
  systemPrompt: readonly string[],
  turnId: string,
  purpose?: GenerateOptions["purpose"],
): unknown[] {
  const input: unknown[] = [];

  for (const prompt of systemPrompt) {
    input.push({ type: "message", role: "system", content: [{ type: "input_text", text: prompt }] });
  }

  for (const message of messages) {
    if (message.role === "user" || message.role === "developer") {
      const id = (message as unknown as { id?: string }).id;
      input.push({
        type: "message",
        ...(id ? { id } : {}),
        role: message.role,
        content: nativeInputContent(message.content),
      });
      continue;
    }
    if (message.role === "agentMessage") {
      input.push({
        type: "agent_message",
        ...(message.author ? { author: message.author } : {}),
        ...(message.recipient ? { recipient: message.recipient } : {}),
        content: nativeInputContent(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      const textContent: unknown[] = [];
      for (const block of message.content) {
        if (block.type === "text") textContent.push({ type: "output_text", text: block.text });
        else if (block.type === "thinking") input.push({ type: "reasoning", summary: [{ type: "summary_text", text: block.thinking }] });
        else if (block.type === "toolCall") {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
            ...(block.namespace ? { namespace: block.namespace } : {}),
          });
        }
      }
      if (textContent.length > 0) input.push({ type: "message", role: "assistant", content: textContent });
      continue;
    }
    if (message.role === "toolResult") {
      const output = typeof message.content === "string"
        ? message.content
        : message.content.map(block => block.type === "text" ? { type: "output_text", text: block.text } : { type: "output_text", text: String((block as { thinking?: unknown }).thinking ?? "") });
      input.push({ type: "function_call_output", call_id: message.toolCallId, output, is_error: message.isError === true });
    }
  }

  const lastUser = [...input].reverse().find(item =>
    item && typeof item === "object" && !Array.isArray(item)
    && (item as { type?: unknown }).type === "message"
    && (item as { role?: unknown }).role === "user"
  ) as Record<string, unknown> | undefined;
  if (!lastUser) throw new LlmError("ChatGPT Web requires a native user input item.", "UNSUPPORTED_OPTION");
  lastUser.internal_chat_message_metadata_passthrough = { turn_id: turnId };
  if (purpose === "compaction") input.push({ type: "compaction_trigger" });
  return input;
}

function nativeInputContent(content: string | readonly CodexContentPart[]): unknown[] | string {
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "input_text", text: block.text });
    else throw new LlmError(`ChatGPT Web cannot build native Responses input for content block "${String(block.type)}".`, "UNSUPPORTED_OPTION");
  }
  return parts.length === 1 && (parts[0] as { type?: string }).type === "input_text"
    ? (parts[0] as { text: string }).text
    : parts;
}

function mapRequestMessage(
  message: RequestMessage,
  toolCallsById: ReadonlyMap<string, { name: string; namespace?: string }>,
): "system" | CodexMessage {
  const role = message.role;
  const timestamp = Date.now();
  if (role === "system") return "system";
  if (role === "developer") {
    return {
      role: "developer",
      ...(typeof (message as unknown as { id?: string }).id === "string"
        ? { id: (message as unknown as { id: string }).id }
        : {}),
      content: toCodexContent(message.content),
      timestamp,
    } as unknown as CodexMessage;
  }
  if (role === "user") {
    return {
      role: "user",
      ...(typeof (message as unknown as { id?: string }).id === "string"
        ? { id: (message as unknown as { id: string }).id }
        : {}),
      content: toCodexContent(message.content),
      timestamp,
    } as unknown as CodexMessage;
  }
  if (role === "tool") {
    const source = message.source;
    if (source?.kind !== "tool") throw new LlmError("ChatGPT Web requires a tool source for tool messages.", "UNSUPPORTED_OPTION");
    const tool = toolCallsById.get(String(source.callId));
    if (!tool) {
      throw new LlmError(`ChatGPT Web cannot match tool result "${String(source.callId)}" to a prior assistant tool call.`, "UNSUPPORTED_OPTION");
    }
    return {
      role: "toolResult",
      toolCallId: source.callId,
      toolName: tool.name,
      ...(tool.namespace ? { toolNamespace: tool.namespace } : {}),
      content: toCodexContent(message.content),
      isError: message.isError === true,
      timestamp,
    };
  }

  const parts: CodexAssistantContentPart[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    else if (block.type === "reasoning") parts.push({ type: "thinking", thinking: block.text });
    else if (block.type === "tool-call") {
      const namespace = (block as unknown as { namespace?: string }).namespace;
      parts.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        ...(typeof namespace === "string" && namespace.length > 0 ? { namespace } : {}),
        arguments: parseRawArguments(block.arguments, block.name),
      });
    }
  }
  return { role: "assistant", content: parts, timestamp };
}

function parseRawArguments(raw: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmError(
      `ChatGPT Web received invalid JSON arguments for tool "${toolName}".`,
      "PROTOCOL_ERROR",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LlmError(
      `ChatGPT Web received non-object arguments for tool "${toolName}".`,
      "PROTOCOL_ERROR",
    );
  }
  return parsed as Record<string, unknown>;
}

function toCodexContent(content: readonly unknown[]): string | CodexContentPart[] {
  const parts: CodexContentPart[] = [];
  for (const block of content) {
    const typed = block as { type: string; text?: string; imageUrl?: string };
    if (typed.type === "text") {
      parts.push({ type: "text", text: typed.text ?? "" });
    } else if (typed.type === "image") {
      // Image input is not supported in the Phase 1 pilot; reject explicitly.
      throw new LlmError(
        "ChatGPT Web native provider does not accept image input in this phase.",
        "UNSUPPORTED_OPTION",
      );
    } else if (typed.type === "file") {
      throw new LlmError(
        "ChatGPT Web native provider does not accept file input in this phase.",
        "UNSUPPORTED_OPTION",
      );
    }
  }
  return parts.length === 0 ? "" : parts;
}

function toTokenUsage(usage: CodexUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cacheRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const inputTokens = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
    ...(usage.reasoningOutputTokens ? { reasoningTokens: usage.reasoningOutputTokens } : {}),
  };
}

function failureFromEvent(message: string, code?: string, status?: number) {
  return {
    message,
    code: code ?? "PROVIDER_ERROR",
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Drive the existing backend and translate its `AdapterEvent` stream into
 * DSH `StreamChunk`s, preserving block ordering, terminal semantics, and the
 * usage-before-finish invariant.
 */
export function mapStream(
  resolveBackend: () => ProviderAdapter,
  options: GenerateOptions,
  toRequest: () => CodexParsedRequest,
  settings: { usageMode?: "emit" | "omit" } = {},
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) {
      yield { type: "finish", reason: { kind: "aborted", failure: failureFromEvent("ChatGPT Web turn aborted.", "aborted") } };
      return;
    }
    let parsed: CodexParsedRequest;
    try { parsed = toRequest(); } catch (error) { yield { type: "finish", reason: toFinishFailure(error, options.signal) }; return; }
    let backend: ProviderAdapter;
    try { backend = resolveBackend(); } catch (error) { yield { type: "finish", reason: toFinishFailure(error, options.signal) }; return; }

    const backendAbort = new AbortController();
    const onAbort = () => backendAbort.abort(options.signal?.reason);
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) backendAbort.abort(options.signal.reason);
    const queue: { push: (event: AdapterEvent) => void; close: () => void; next: () => Promise<AdapterEvent | undefined> } = createEventQueue();
    const runPromise = (async () => {
      try {
        await backend.runTurn!(parsed, { headers: new Headers(), abortSignal: backendAbort.signal }, event => queue.push(event));
      } catch (error) {
        queue.push({ type: "error", message: errorMessage(error), ...(isAbortLikeError(error) ? { code: "aborted" } : {}) });
      } finally {
        queue.close();
      }
    })();

    const emitUsage = settings.usageMode !== "omit";
    let blockIndex = 0;
    let openBlock: { index: number; kind: "text" | "reasoning"; text: string } | { index: number; kind: "tool"; id: string; name?: string; arguments: string } | undefined;
    let usageEmitted = false;
    let finishYielded = false;
    let outputObserved = false;
    const closeBlock = (): StreamChunk | undefined => {
      if (!openBlock) return undefined;
      const block = openBlock;
      openBlock = undefined;
      if (block.kind === "tool") return { type: "block-end", index: block.index, block: { type: "tool-call", id: ToolCallId(block.id), name: block.name ?? "", arguments: block.arguments } };
      return { type: "block-end", index: block.index, block: { type: block.kind, text: block.text } };
    };

    try {
      for (;;) {
        const event = await queue.next();
        if (event === undefined) break;
        switch (event.type) {
          case "text_delta": {
            if (openBlock?.kind !== "text") {
              const end = closeBlock(); if (end) yield end;
              openBlock = { index: blockIndex++, kind: "text", text: "" };
              yield { type: "block-start", index: openBlock.index, blockType: "text" };
            }
            if (event.text.length > 0) outputObserved = true;
            openBlock.text += event.text;
            yield { type: "text-delta", index: openBlock.index, text: event.text };
            break;
          }
          case "thinking_delta":
          case "reasoning_raw_delta": {
            const text = event.type === "thinking_delta" ? event.thinking : event.text;
            if (openBlock?.kind !== "reasoning") {
              const end = closeBlock(); if (end) yield end;
              openBlock = { index: blockIndex++, kind: "reasoning", text: "" };
              yield { type: "block-start", index: openBlock.index, blockType: "reasoning" };
            }
            if (text.length > 0) outputObserved = true;
            openBlock.text += text;
            yield { type: "reasoning-delta", index: openBlock.index, text };
            break;
          }
          case "tool_call_start": {
            const end = closeBlock(); if (end) yield end;
            outputObserved = true;
            openBlock = { index: blockIndex++, kind: "tool", id: event.id, name: event.name, arguments: "" };
            yield { type: "block-start", index: openBlock.index, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: openBlock.index, id: ToolCallId(event.id), name: event.name, argumentsDelta: "" };
            break;
          }
          case "tool_call_delta": {
            if (!openBlock || openBlock.kind !== "tool") {
              throw new LlmError("ChatGPT Web emitted tool arguments without an active tool-call block.", "PROTOCOL_ERROR");
              break;
            }
            openBlock.arguments += event.arguments;
            yield { type: "tool-call-delta", index: openBlock.index, id: ToolCallId(openBlock.id), argumentsDelta: event.arguments };
            break;
          }
          case "tool_call_end":
            if (openBlock?.kind === "tool") yield closeBlock()!;
            break;
          case "assistant_boundary": {
            const end = closeBlock(); if (end) yield end;
            break;
          }
          case "heartbeat":
            break;
          case "done": {
            const end = closeBlock(); if (end) yield end;
            const tokenUsage = emitUsage ? toTokenUsage(event.usage) : undefined;
            if (tokenUsage) { yield { type: "usage", usage: tokenUsage }; usageEmitted = true; }
            const kind = event.stopReason === "tool_use" ? "tool-calls" : event.stopReason === "max_tokens" ? "max-tokens" : "stop";
            if (kind === "stop" && !outputObserved) {
              yield {
                type: "finish",
                reason: {
                  kind: "error",
                  failure: failureFromEvent(
                    "ChatGPT Web completed without any response content.",
                    "EMPTY_RESPONSE",
                  ),
                },
              };
            } else {
              yield { type: "finish", reason: { kind } };
            }
            finishYielded = true;
            return;
          }
          case "incomplete": {
            const end = closeBlock(); if (end) yield end;
            const tokenUsage = emitUsage ? toTokenUsage(event.usage) : undefined;
            if (tokenUsage && !usageEmitted) { yield { type: "usage", usage: tokenUsage }; usageEmitted = true; }
            yield { type: "finish", reason: { kind: "error", failure: failureFromEvent(event.message ?? event.reason, "PROVIDER_ERROR") } };
            finishYielded = true;
            return;
          }
          case "error": {
            const end = closeBlock(); if (end) yield end;
            const tokenUsage = emitUsage ? toTokenUsage(event.usage) : undefined;
            if (tokenUsage && !usageEmitted) { yield { type: "usage", usage: tokenUsage }; usageEmitted = true; }
            const kind = isAbortError(event) && (options.signal?.aborted || backendAbort.signal.aborted) ? "aborted" : "error";
            yield { type: "finish", reason: { kind, failure: failureFromEvent(event.message, event.code ?? (kind === "aborted" ? "aborted" : "PROVIDER_ERROR"), event.status) } };
            finishYielded = true;
            return;
          }
        }
      }
      if (!finishYielded) {
        const end = closeBlock(); if (end) yield end;
        const aborted = options.signal?.aborted === true || backendAbort.signal.aborted;
        yield { type: "finish", reason: { kind: aborted ? "aborted" : "error", failure: failureFromEvent(aborted ? "ChatGPT Web turn aborted." : "ChatGPT Web turn ended without a terminal event.", aborted ? "aborted" : "PROVIDER_ERROR") } };
      }
    } finally {
      backendAbort.abort(options.signal?.reason ?? new DOMException("ChatGPT Web stream consumer stopped.", "AbortError"));
      options.signal?.removeEventListener("abort", onAbort);
      await runPromise.catch(() => {});
    }
  })();
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && /abort/i.test(error.message);
}

function isAbortError(event: AdapterEvent): boolean {
  return event.type === "error" && (event.code === "aborted" || /abort/i.test(event.message));
}

function toFinishFailure(error: unknown, signal?: AbortSignal): { kind: "aborted" | "error"; failure: { message: string; code: string; status?: number } } {
  if (error instanceof LlmError) {
    return {
      kind: signal?.aborted ? "aborted" : "error",
      failure: { message: error.message, code: error.code, status: (error as { status?: number }).status },
    };
  }
  return {
    kind: signal?.aborted ? "aborted" : "error",
    failure: { message: errorMessage(error), code: signal?.aborted ? "aborted" : "PROVIDER_ERROR" },
  };
}

/** Minimal push-based async queue for bridging `emit` callbacks. */
function createEventQueue(): {
  push: (event: AdapterEvent) => void;
  close: () => void;
  next: () => Promise<AdapterEvent | undefined>;
} {
  const buffered: AdapterEvent[] = [];
  let closed = false;
  let resolveNext: ((value: AdapterEvent | undefined) => void) | undefined;
  return {
    push(event) {
      if (closed) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r(event);
      } else {
        buffered.push(event);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r(undefined);
      }
    },
    next() {
      const value = buffered.shift();
      if (value !== undefined) return Promise.resolve(value);
      if (closed) return Promise.resolve(undefined);
      return new Promise(resolve => {
        resolveNext = resolve;
      });
    },
  };
}
