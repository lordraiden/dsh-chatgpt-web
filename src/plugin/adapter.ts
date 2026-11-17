/**
 * Text-only DSH LLM adapter over the container service's HTTP API.
 *
 * This is the only place the plugin touches the service wire format. It owns:
 *
 * - the streaming request (`POST {baseUrl}/v1/chat/completions`, SSE) and its message projection;
 * - the model catalogue (`GET {baseUrl}/v1/models`) and the declared `contextWindow` DSH compaction
 *   depends on;
 * - the mapping from service failures onto DSH's provider-neutral failure taxonomy.
 *
 * It owns none of the product's conversation state: the service keeps the browser, the provider
 * conversations, continuity, retries and concurrency (doc/plugin.md §2). The adapter sends the DSH
 * session identity as native turn metadata on every turn, sends only the current human turn in a
 * normal conversation (the service projects the same message when it has identity), and sends the
 * full conversation only for auxiliary calls, whose system instruction is prepended to the last user
 * message because the service has no system slot (doc/plugin.md §5).
 *
 * Retries are deliberately disabled here: the service already owns transport retry and turn
 * settlement, and a turn that was submitted must never be resent because its response was not
 * observed (AGENTS.md, "Retry boundary"). DSH's retry layer must not become a second authority.
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  resolveRetryPolicy,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmModelReasoningInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { PROVIDERS, type AdapterDeps, type PluginConfig, type ProviderId } from './contract'
import {
  MODEL_NOT_FOUND_CODE,
  PROTOCOL_ERROR_CODE,
  httpErrorFromService,
  streamErrorFromService,
} from './errors'
import { readSseEvents } from './sse'

/** Prefix shared by every diagnostic this plugin raises. */
const PKG = 'dsh-chatgpt-web'

/** How long a successful catalogue read stays usable; short so a model change is observed quickly. */
const CATALOGUE_TTL_MS = 30_000

/** Bound for a catalogue read when the configured request timeout is `0` (no turn timeout). */
const CATALOGUE_TIMEOUT_MS = 10_000

/** Bound on a service error body before it enters a diagnostic. */
const MAX_ERROR_BODY = 4096

/** Display names for the two routes this adapter registers. */
const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = Object.freeze({
  'chatgpt-web': 'ChatGPT Web',
  'qwen-chat': 'Qwen Chat',
})

/** The service-facing configuration facts one prepared call freezes across a settings change. */
type ServiceConfig = Pick<PluginConfig, 'baseUrl' | 'apiKey' | 'requestTimeoutMs'>

/** One selectable reasoning effort read from the service catalogue. */
interface CatalogueEffort {
  readonly id: string
  readonly name: string
}

/** Reasoning metadata as the service catalogue declares it. */
interface CatalogueReasoning {
  readonly efforts: readonly CatalogueEffort[]
  readonly defaultEffort?: string
}

/** One model row of the service catalogue, reduced to the facts the adapter serves. */
interface CatalogueRow {
  readonly slug: string
  readonly name: string
  readonly contextWindow?: number
  readonly reasoning?: CatalogueReasoning
}

/** One successful catalogue read, cached by service root. Secrets are never part of it. */
interface CatalogueCache {
  readonly baseUrl: string
  readonly fetchedAt: number
  readonly rows: readonly CatalogueRow[]
}

/** One message of the service's chat-completions wire format. */
interface WireMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/**
 * Create the plugin's text-only LLM adapter.
 *
 * The adapter reads configuration through {@link AdapterDeps.config} on every call, so a live
 * settings change is observed without a restart; {@link ChatGptWebAdapter.prepareCall} freezes one
 * read for the duration of a call so a model and its endpoint cannot come from different generations.
 * @param deps - the host-owned configuration, workspace resolver and sanitized logger.
 * @returns the adapter to register for {@link PROVIDERS}.
 */
export function createChatGptWebAdapter(deps: AdapterDeps): LlmAdapter {
  return new ChatGptWebAdapter(deps)
}

/** The adapter implementation behind {@link createChatGptWebAdapter}. */
class ChatGptWebAdapter extends LlmAdapter {
  private catalogue: CatalogueCache | undefined
  private catalogueFailure: string | undefined

  constructor(private readonly deps: AdapterDeps) {
    super()
  }

  /** Describe one route; the id must equal the registered provider. */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAMES[provider as ProviderId] ?? provider }
  }

  /**
   * Do not let DSH retry a service turn.
   *
   * The service owns browser-turn retry, settlement and its own bounded queue. A turn that reached
   * the service may already have been submitted to the provider, and resending it because its
   * response was not observed is exactly the duplicate the architecture forbids. A pre-turn 429 is
   * backpressure the caller should surface, not a retry this layer should absorb.
   */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, `${PKG}: ${provider}.retryPolicy`)
  }

  /**
   * List the models of one provider route from the service catalogue.
   *
   * Advisory only, and it must never fail: a DSH settings or model picker refresh cannot be allowed
   * to throw because the service is restarting. An unavailable catalogue yields an empty list and a
   * sanitized diagnostic; no secret, token or message body is logged.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (!isProviderId(provider)) return []
    try {
      const config = this.deps.config()
      const rows = await this.readCatalogue(config)
      if (rows === undefined) return []
      const prefix = `${provider}/`
      return rows
        .filter(row => row.slug.startsWith(prefix))
        .map(row => ({ provider, id: row.slug, name: row.name, inputModalities: ['text'] as const }))
    } catch (error) {
      this.reportCatalogueFailure(errorName(error))
      return []
    }
  }

  /**
   * Resolve one exact model route.
   *
   * The service catalogue is the only source of `context.contextWindow`; when it is unavailable or
   * does not declare a window, resolution fails with {@link MODEL_NOT_FOUND_CODE} instead of
   * inventing a value, because DSH compaction uses the declared window to decide when a session is
   * under pressure (doc/plugin.md §6).
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.resolveModelWithConfig(provider, model, this.readConfigOrThrow(), signal)
  }

  /**
   * Bind one model resolution and its eventual request dispatch to the same configuration read.
   *
   * Without this, a settings change between DSH's capability lookup and the stream call could pair
   * one generation's `contextWindow` with another generation's endpoint.
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const config = this.readConfigOrThrow()
    const info = await this.resolveModelWithConfig(provider, model, config, signal)
    const snapshot = snapshotConfig(config)
    return { model: info, stream: options => this.streamInternal(options, snapshot) }
  }

  /** Stream one model call using the configuration as it is read when the stream starts. */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamInternal(options)
  }

  /** Resolve one model against an already-read configuration. */
  private async resolveModelWithConfig(
    provider: string,
    model: string,
    config: PluginConfig,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted === true) throw abortedError(signal)
    if (!isProviderId(provider)) {
      throw modelNotFound(provider, model, 'the provider route is not registered by this plugin')
    }
    if (typeof model !== 'string' || !model.startsWith(`${provider}/`)) {
      throw modelNotFound(provider, model, `the model id does not belong to provider "${provider}"`)
    }
    validateBaseUrl(config)
    const rows = await this.readCatalogue(config, signal)
    if (rows === undefined) throw modelNotFound(provider, model, 'the service model catalogue is unavailable')
    const row = rows.find(entry => entry.slug === model)
    if (row === undefined) {
      throw modelNotFound(provider, model, 'the service model catalogue does not list it')
    }
    if (row.contextWindow === undefined) {
      throw modelNotFound(provider, model, 'the service model catalogue does not declare a context_window')
    }
    const reasoning = provider === 'qwen-chat' ? reasoningInfo(row.reasoning) : undefined
    return {
      provider,
      id: model,
      name: row.name,
      inputModalities: ['text'],
      context: { contextWindow: row.contextWindow },
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * Read the service catalogue, reusing a successful read for {@link CATALOGUE_TTL_MS}.
   *
   * A failed refresh reports a sanitized diagnostic and returns `undefined`; it never falls back to
   * a stale catalogue, because a model that disappeared must fail resolution rather than be served
   * from a previous generation.
   */
  private async readCatalogue(
    config: PluginConfig,
    signal?: AbortSignal,
  ): Promise<readonly CatalogueRow[] | undefined> {
    const cached = this.catalogue
    if (
      cached !== undefined &&
      cached.baseUrl === config.baseUrl &&
      Date.now() - cached.fetchedAt < CATALOGUE_TTL_MS
    ) {
      return cached.rows
    }

    const timeoutMs = config.requestTimeoutMs > 0 ? config.requestTimeoutMs : CATALOGUE_TIMEOUT_MS
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('catalogue timeout'))
    }, timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer)
        throw abortedError(signal)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const response = await fetch(endpointUrl(config.baseUrl, '/v1/models'), {
        method: 'GET',
        headers: requestHeaders(config, false),
        signal: controller.signal,
      })
      if (!response.ok) {
        this.reportCatalogueFailure(`HTTP ${response.status}`)
        return undefined
      }
      const payload: unknown = await response.json()
      const rows = parseCatalogue(payload)
      this.catalogue = { baseUrl: config.baseUrl, fetchedAt: Date.now(), rows }
      this.catalogueFailure = undefined
      return rows
    } catch (error) {
      if (signal?.aborted === true) throw abortedError(signal)
      this.reportCatalogueFailure(timedOut ? 'timeout' : errorName(error))
      return undefined
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Log one catalogue failure per distinct signature, so a polling settings page cannot spam. */
  private reportCatalogueFailure(signature: string): void {
    if (this.catalogueFailure === signature) return
    this.catalogueFailure = signature
    this.deps.logger?.warn(
      `${PKG}: the service model catalogue is unavailable (${signature}); model resolution fails until it recovers`,
    )
  }

  /** Read the plugin configuration or fail with a typed configuration error. */
  private readConfigOrThrow(): PluginConfig {
    try {
      return this.deps.config()
    } catch (error) {
      throw new LlmError(`${PKG}: the plugin configuration cannot be read`, 'INVALID_CONFIG', { cause: error })
    }
  }

  /**
   * Stream one turn.
   *
   * Cancellation is honoured at every boundary: the caller's signal aborts the fetch and the body
   * reader, and the resulting failure is `ABORTED` so DSH settles the turn as aborted rather than as
   * a provider error. A configured `requestTimeoutMs` is a total request deadline (the service's
   * keep-alive comments keep a long turn alive at the HTTP level, so `0` is the normal setting).
   */
  private async *streamInternal(
    options: GenerateOptions,
    captured?: ServiceConfig,
  ): AsyncGenerator<StreamChunk, void, void> {
    let config: ServiceConfig
    if (captured !== undefined) {
      config = captured
    } else {
      try {
        config = this.deps.config()
      } catch (error) {
        throw new LlmError(`${PKG}: the plugin configuration cannot be read`, 'INVALID_CONFIG', { cause: error })
      }
    }
    validateBaseUrl(config)
    const body = buildRequestBody(options, this.deps)

    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal !== undefined) {
      if (options.signal.aborted) throw abortedError(options.signal)
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (config.requestTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('request timeout'))
      }, config.requestTimeoutMs)
    }

    try {
      let response: Response
      try {
        response = await fetch(endpointUrl(config.baseUrl, '/v1/chat/completions'), {
          method: 'POST',
          headers: requestHeaders(config, true),
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        throw transportError(error, options.signal, timedOut, config)
      }

      if (!response.ok) {
        const text = await readErrorBody(response)
        throw httpErrorFromService(response.status, text, response.headers)
      }
      if (response.body === null) {
        throw new LlmError(`${PKG}: the service returned no response body`, 'EMPTY_RESPONSE', {
          status: response.status,
        })
      }

      yield* this.readCompletionStream(response.body, options, () => timedOut)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Translate the service's SSE frames into DSH's canonical chunk order.
   *
   * The service emits an empty role frame, text deltas, a terminal `delta: {}` with `finish_reason`,
   * and `data: [DONE]`; it never emits `usage` today, so a usage chunk is forwarded only if a future
   * service includes one. A frame split across reads is handled by the decoder, and a mid-stream
   * `{"error":{…}}` frame is a typed failure, never a silent end.
   */
  private async *readCompletionStream(
    body: ReadableStream<Uint8Array>,
    options: GenerateOptions,
    timedOut: () => boolean,
  ): AsyncGenerator<StreamChunk, void, void> {
    let text = ''
    let started = false
    let usage: TokenUsage | undefined
    let finishReason: string | undefined
    let sawDone = false
    let sawTerminal = false

    try {
      for await (const event of readSseEvents(body)) {
        if (options.signal?.aborted === true) throw abortedError(options.signal)
        const data = event.data.trim()
        if (data === '') continue
        if (data === '[DONE]') {
          sawDone = true
          break
        }

        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch (error) {
          throw new LlmError(`${PKG}: the service sent a malformed SSE frame`, PROTOCOL_ERROR_CODE, {
            cause: error,
          })
        }

        const errorFrame = asRecord(asRecord(payload)?.error)
        if (errorFrame !== undefined) throw streamErrorFromService(errorFrame)

        const parsedUsage = usageFromPayload(payload)
        if (parsedUsage !== undefined) usage = parsedUsage

        const choice = firstChoice(payload)
        if (choice === undefined) continue

        const deltaText = deltaTextOf(choice.delta)
        if (deltaText !== '') {
          if (!started) {
            started = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          text += deltaText
          yield { type: 'text-delta', index: 0, text: deltaText }
        }

        const reason = choice.finish_reason
        if (reason !== null && reason !== undefined) {
          finishReason = typeof reason === 'string' ? reason : String(reason)
          sawTerminal = true
          break
        }
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (options.signal?.aborted === true) throw abortedError(options.signal)
      if (timedOut()) {
        throw new LlmError(`${PKG}: the service stream timed out`, 'TIMEOUT', { cause: error })
      }
      throw new LlmError(`${PKG}: the service stream failed`, 'TRANSPORT', { cause: error })
    }

    // A stop with zero blocks is EMPTY_RESPONSE, not an empty assistant message (dsh-llm's rule).
    if (text === '') {
      throw new LlmError(`${PKG}: the service completed without producing any text`, 'EMPTY_RESPONSE')
    }
    // Content without a terminal frame means the connection was cut mid-generation. Reporting a
    // clean stop would silently accept a partial answer; the turn is not retried, but it is an error.
    if (!sawTerminal && !sawDone) {
      throw new LlmError(`${PKG}: the service stream ended before a terminal frame`, 'TRANSPORT')
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: finishReason === 'length' ? 'max-tokens' : 'stop' } }
  }
}

/**
 * Build the service request body.
 *
 * Normal turns carry only the newest user message that still has human text: the service projects
 * exactly that message when the turn has identity, so sending the whole history would be redundant.
 * Auxiliary calls (`purpose`) carry the whole user/assistant conversation because the service treats
 * a declared purpose as an ephemeral turn and forwards every conversational message; their system
 * instruction is prepended to the last user message because the service has no system slot.
 *
 * `options.tools` is intentionally never read: this provider is text-only and never emits a tool
 * call. Sampling controls are not forwarded either — the service's web providers ignore them.
 */
function buildRequestBody(options: GenerateOptions, deps: AdapterDeps): Record<string, unknown> {
  const purpose = requestPurpose(options)
  const messages =
    purpose === undefined ? normalTurnMessages(options.messages) : auxiliaryTurnMessages(options)
  const metadata = turnMetadata(options, deps, purpose)

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
  }
  if (metadata !== undefined) body.client_metadata = { 'x-codex-turn-metadata': JSON.stringify(metadata) }
  if (options.provider === 'qwen-chat' && options.reasoningEffort !== undefined) {
    body.reasoning_effort = String(options.reasoningEffort)
  }
  return body
}

/**
 * Native turn metadata: the DSH session identity on every turn, the workspace only on a normal turn.
 *
 * A declared `purpose` makes the service treat the turn as ephemeral, which is what lets an
 * auxiliary call forward its full conversation. The workspace is conversation-initialization
 * context (the first-message header), so an auxiliary call never declares it: prepending
 * `Project: "…"` to a compaction instruction would pollute the summary prompt.
 */
function turnMetadata(
  options: GenerateOptions,
  deps: AdapterDeps,
  purpose: string | undefined,
): Record<string, string> | undefined {
  const metadata: Record<string, string> = {}
  if (options.sessionId !== undefined) metadata.dsh_session_id = String(options.sessionId)
  if (purpose !== undefined) {
    metadata.purpose = purpose
  } else {
    const workspace = deps.workspaceFor(options.sessionId)
    if (typeof workspace === 'string' && workspace.trim() !== '') metadata.workspace = workspace.trim()
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

/** The declared purpose of a request, normalized; a blank value is not a declaration. */
function requestPurpose(options: GenerateOptions): string | undefined {
  const purpose: unknown = (options as { purpose?: unknown }).purpose
  return typeof purpose === 'string' && purpose.trim() !== '' ? purpose.trim() : undefined
}

/** Project a normal turn onto the single newest user message that still carries human text. */
function normalTurnMessages(messages: readonly RequestMessage[]): WireMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = userTextOf(message.content)
    if (text.trim() !== '') return [{ role: 'user', content: text }]
  }
  throw new LlmError(`${PKG}: the request carries no human user message to send`, 'INVALID_REQUEST')
}

/**
 * Project an auxiliary call onto the full user/assistant conversation, with the system instruction
 * prepended to the last user message.
 *
 * The service's stateless projection requires the last conversational message to be a user message,
 * so a call that ends with an assistant message is refused here instead of becoming a 400.
 */
function auxiliaryTurnMessages(options: GenerateOptions): WireMessage[] {
  const conversation: WireMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'user') {
      conversation.push({ role: 'user', content: userTextOf(message.content) })
    } else if (message.role === 'assistant') {
      conversation.push({ role: 'assistant', content: textOf(message.content) })
    }
  }

  let lastUser = -1
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index].role === 'user') {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) {
    throw new LlmError(`${PKG}: the auxiliary request carries no user message`, 'INVALID_REQUEST')
  }
  if (lastUser !== conversation.length - 1) {
    throw new LlmError(`${PKG}: the auxiliary request must end with a user message`, 'INVALID_REQUEST')
  }

  const systemText = systemTextOf(options)
  if (systemText !== '') {
    const user = conversation[lastUser]
    conversation[lastUser] = {
      role: 'user',
      content: user.content.trim() === '' ? systemText : `${systemText}\n\n${user.content}`,
    }
  }
  return conversation
}

/** The system instruction of an auxiliary call: `options.system` first, then system messages. */
function systemTextOf(options: GenerateOptions): string {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system.trim())
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = textOf(message.content).trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

/** Concatenate the text blocks of a message. */
function textOf(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Concatenate the text blocks of a user message, refusing any non-text block.
 *
 * DSH projects images and files to text before calling a model that declares `inputModalities:
 * ['text']`, so a non-text block here means the projection did not happen. Dropping it would be
 * silent content loss, so the turn fails explicitly instead.
 */
function userTextOf(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') {
      text += block.text
      continue
    }
    throw new LlmError(
      `${PKG}: the request contains unsupported ${block.type} content; this provider is text-only`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return text
}

/** Map the catalogue's reasoning levels onto DSH's reasoning metadata. */
function reasoningInfo(reasoning: CatalogueReasoning | undefined): LlmModelReasoningInfo | undefined {
  if (reasoning === undefined || reasoning.efforts.length === 0) return undefined
  return {
    efforts: reasoning.efforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
    ...(reasoning.defaultEffort === undefined
      ? {}
      : { defaultEffort: ReasoningEffortId(reasoning.defaultEffort) }),
  }
}

/**
 * Reduce the service catalogue to the rows this plugin serves.
 *
 * `models[]` is the authoritative catalogue and the only source of `context_window`; `data[]` is
 * accepted only when `models[]` is absent, and rows read from it have no window (so resolution
 * fails closed rather than guessing).
 */
function parseCatalogue(payload: unknown): readonly CatalogueRow[] {
  const record = asRecord(payload)
  const models = Array.isArray(record?.models) && record.models.length > 0
    ? record.models
    : Array.isArray(record?.data)
      ? record.data
      : []

  const rows: CatalogueRow[] = []
  const seen = new Set<string>()
  for (const entry of models) {
    const row = asRecord(entry)
    if (row === undefined) continue
    const slug =
      typeof row.slug === 'string'
        ? row.slug.trim()
        : typeof row.id === 'string'
          ? row.id.trim()
          : ''
    if (slug === '' || seen.has(slug)) continue
    if (!slug.startsWith('chatgpt-web/') && !slug.startsWith('qwen-chat/')) continue
    seen.add(slug)

    const name =
      typeof row.display_name === 'string' && row.display_name.trim() !== ''
        ? row.display_name.trim()
        : typeof row.name === 'string' && row.name.trim() !== ''
          ? row.name.trim()
          : slug
    const contextWindow =
      typeof row.context_window === 'number' && Number.isInteger(row.context_window) && row.context_window > 0
        ? row.context_window
        : undefined
    const reasoning = reasoningFromRow(row)

    rows.push({
      slug,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(reasoning === undefined ? {} : { reasoning }),
    })
  }
  return rows
}

/** Read the reasoning levels of one catalogue row, if it declares any. */
function reasoningFromRow(row: Record<string, unknown>): CatalogueReasoning | undefined {
  const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : []
  const efforts: CatalogueEffort[] = []
  const seen = new Set<string>()
  for (const level of levels) {
    const record = asRecord(level)
    const id = typeof record?.effort === 'string' ? record.effort.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name =
      typeof record?.description === 'string' && record.description.trim() !== ''
        ? record.description.trim()
        : id
    efforts.push({ id, name })
  }
  if (efforts.length === 0) return undefined
  const declaredDefault =
    typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level.trim() : ''
  return {
    efforts,
    ...(declaredDefault !== '' && seen.has(declaredDefault) ? { defaultEffort: declaredDefault } : {}),
  }
}

/** Extract the first choice of a chat-completions frame. */
function firstChoice(payload: unknown): Record<string, unknown> | undefined {
  const choices = asRecord(payload)?.choices
  return Array.isArray(choices) ? asRecord(choices[0]) : undefined
}

/** Extract the text of a delta, tolerating both a string and OpenAI's content-part array. */
function deltaTextOf(delta: unknown): string {
  const record = asRecord(delta)
  if (record === undefined) return ''
  const content = record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const recordPart = asRecord(part)
    if (recordPart?.type === 'text' && typeof recordPart.text === 'string') text += recordPart.text
  }
  return text
}

/**
 * Read a usage object from a stream frame, when a future service includes one.
 *
 * DSH's token buckets are disjoint; this wire reports plain prompt/completion counts, so they map
 * one-to-one. The service does not emit usage in streaming today, so this is normally unused.
 */
function usageFromPayload(payload: unknown): TokenUsage | undefined {
  const usage = asRecord(asRecord(payload)?.usage)
  if (usage === undefined) return undefined
  const input = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens)
  const output = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens)
  if (input === undefined && output === undefined) return undefined
  const total = numberOrUndefined(usage.total_tokens)
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

/** Build the failure for a request that never reached the service. */
function transportError(
  error: unknown,
  signal: AbortSignal | undefined,
  timedOut: boolean,
  config: ServiceConfig,
): LlmError {
  if (signal?.aborted === true) return abortedError(signal)
  if (timedOut) {
    return new LlmError(`${PKG}: the service request timed out after ${config.requestTimeoutMs} ms`, 'TIMEOUT', {
      cause: error,
    })
  }
  return new LlmError(
    `${PKG}: cannot reach the service at ${displayBaseUrl(config.baseUrl)} (${errorName(error)})`,
    'TRANSPORT',
    { cause: error },
  )
}

/** Build the failure for a caller-cancelled request. */
function abortedError(signal: AbortSignal): LlmError {
  return new LlmError(`${PKG}: the request was aborted by the caller`, 'ABORTED', { cause: signal.reason })
}

/** Build the failure for a model the service catalogue cannot resolve. */
function modelNotFound(provider: string, model: string, reason: string): LlmError {
  return new LlmError(
    `${PKG}: model "${model}" is not available on provider "${provider}": ${reason}`,
    MODEL_NOT_FOUND_CODE,
  )
}

/** Refuse a configuration without a service root before a request is attempted. */
function validateBaseUrl(config: ServiceConfig): void {
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') {
    throw new LlmError(`${PKG}: the service baseUrl is not configured`, 'INVALID_CONFIG')
  }
}

/** Join the service root (which may include a `/p/<profile>` prefix) with one API path. */
function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

/**
 * Request headers for one service call.
 *
 * Every request carries DSH's attribution headers; the API key is optional because a loopback
 * service may run without one. The key is never logged and never enters a cache.
 */
function requestHeaders(config: ServiceConfig, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...attributionHeaders() }
  if (stream) {
    headers['content-type'] = 'application/json'
    headers.accept = 'text/event-stream'
  } else {
    headers.accept = 'application/json'
  }
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  return headers
}

/** Freeze the non-secret configuration facts a prepared call must keep using. */
function snapshotConfig(config: PluginConfig): ServiceConfig {
  return {
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
  }
}

/** Read a service error body, bounded; a body that cannot be read is simply absent. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text
  } catch {
    return ''
  }
}

/** Render a service root for a diagnostic without userinfo, query or fragment. */
function displayBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return 'the configured service'
  }
}

/** The error's class name, which is safe for a diagnostic (its message may contain a URL). */
function errorName(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'unknown error'
}

/** Narrow an unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Read a finite number, or `undefined`. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Whether a string is one of the plugin's registered provider routes. */
function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value)
}
