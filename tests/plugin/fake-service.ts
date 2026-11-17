/**
 * Test harness for the DSH plugin (doc/plugin.md §13).
 *
 * The plugin's only external dependency is the container service's HTTP API, so every contract test
 * here runs against a **real** `Bun.serve` instance on an ephemeral loopback port: the adapter uses
 * its production `fetch`, URL joining, header set and SSE reader, and the test observes the exact
 * bytes that would reach the service. Nothing touches a real network, a browser or a data volume.
 *
 * The helpers below deliberately stay dumb: they record requests, render SSE frames and hand back
 * responses. Every assertion about the plugin's behaviour lives in the `*.test.ts` files.
 */
import {
  createAssistantMessage,
  createSystemMessage,
  LlmError,
  type ContentBlock,
  type GenerateOptions,
  type LlmAdapter,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { createChatGptWebAdapter } from '../../src/plugin/adapter'
import type { AdapterDeps, PluginConfig, PluginLogger } from '../../src/plugin/contract'

/** One request the fake service received, already decoded. */
export interface RecordedRequest {
  /** HTTP method, e.g. `POST`. */
  readonly method: string
  /** Path only, so a `/p/<profile>` prefix is asserted without the origin. */
  readonly path: string
  /** Full URL including the ephemeral port. */
  readonly url: string
  /** Request headers exactly as the adapter sent them. */
  readonly headers: Headers
  /** Parsed JSON body, or `{}` when the body was empty or not a JSON object. */
  readonly body: Record<string, unknown>
  /** Raw body text, for byte-level assertions. */
  readonly rawBody: string
}

/** Produce the response for one recorded request. */
export type FakeHandler = (request: RecordedRequest) => Response | Promise<Response>

/** A loopback fake of the container service. */
export class FakeService {
  /** Every request received so far, in arrival order. */
  readonly requests: RecordedRequest[] = []

  private handler: FakeHandler
  private readonly server: ReturnType<typeof Bun.serve>

  private constructor(handler: FakeHandler) {
    this.handler = handler
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        const rawBody = request.method === 'POST' || request.method === 'PUT' ? await request.text() : ''
        const recorded: RecordedRequest = {
          method: request.method,
          path: new URL(request.url).pathname,
          url: request.url,
          headers: request.headers,
          body: parseJsonObject(rawBody),
          rawBody,
        }
        this.requests.push(recorded)
        return await this.handler(recorded)
      },
    })
  }

  /**
   * Start a fake service.
   * @param handler - the response producer for every request.
   * @returns the running fake, bound to an ephemeral loopback port.
   */
  static start(handler: FakeHandler): FakeService {
    return new FakeService(handler)
  }

  /** The service root the adapter should be configured with. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  /** The most recent request; fails the test when the adapter never sent one. */
  get lastRequest(): RecordedRequest {
    const request = this.requests.at(-1)
    if (request === undefined) throw new Error('the fake service received no request')
    return request
  }

  /** Replace the response producer, so one test can script several calls. */
  setHandler(handler: FakeHandler): void {
    this.handler = handler
  }

  /** Stop listening and drop every open connection (including a held SSE stream). */
  stop(): void {
    this.server.stop(true)
  }
}

/** Parse a body into a plain record, tolerating an empty or non-object body. */
function parseJsonObject(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Encode one JSON response. */
export function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Encode the service's `{error:{message,type,code}}` envelope with one HTTP status. */
export function errorResponse(
  status: number,
  error: { readonly message: string; readonly type?: string; readonly code?: string },
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error }, headers)
}

/** The `text/event-stream` content type every streaming response must carry. */
const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
}

/** Encode one SSE `data:` frame for a JSON payload. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Encode one SSE comment line (the service's `: keep-alive` heartbeat). */
export function sseComment(text = 'keep-alive'): string {
  return `: ${text}\n\n`
}

/** The terminal sentinel frame. */
export const SSE_DONE = 'data: [DONE]\n\n'

/** One text delta frame in the service's OpenAI-compatible shape. */
export function sseDelta(text: string): string {
  return sseData({ choices: [{ delta: { content: text } }] })
}

/** The empty role frame the service emits before the first delta. */
export function sseRole(): string {
  return sseData({ choices: [{ delta: { role: 'assistant' } }] })
}

/** The terminal frame: an empty delta plus `finish_reason`. */
export function sseTerminal(reason = 'stop'): string {
  return sseData({ choices: [{ delta: {}, finish_reason: reason }] })
}

/** A mid-stream failure frame: HTTP 200, no `code`, only `message`/`type`. */
export function sseError(message: string, type?: string): string {
  return sseData({ error: { message, ...(type === undefined ? {} : { type }) } })
}

/** A complete, well-formed streaming completion for the given text deltas. */
export function sseCompletion(
  deltas: readonly string[],
  options: { readonly keepAlive?: boolean; readonly role?: boolean; readonly done?: boolean } = {},
): string[] {
  const frames: string[] = []
  if (options.keepAlive === true) frames.push(sseComment())
  if (options.role !== false) frames.push(sseRole())
  for (const delta of deltas) frames.push(sseDelta(delta))
  frames.push(sseTerminal())
  if (options.done !== false) frames.push(SSE_DONE)
  return frames
}

/**
 * A streaming response that emits `chunks` and then closes.
 * @param chunks - raw SSE text chunks; a frame may be split across several of them.
 * @param options - optional delay between chunks, to force separate reads.
 * @returns the streaming response.
 */
export function sseResponse(chunks: readonly string[], options: { readonly delayMs?: number } = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
        if (options.delayMs !== undefined && options.delayMs > 0) await Bun.sleep(options.delayMs)
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}

/**
 * A streaming response that emits `chunks` and then stays open, so a test can cancel or time out a
 * turn that is still running.
 * @param chunks - raw SSE text chunks to emit before holding.
 * @returns the response plus the `release` callback that lets the server close the stream.
 */
export function heldSseResponse(chunks: readonly string[]): { response: Response; release(): void } {
  const encoder = new TextEncoder()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      await gate
      try {
        controller.close()
      } catch {
        // The client already cancelled the body; there is nothing left to close.
      }
    },
    cancel() {
      release()
    },
  })
  return { response: new Response(stream, { status: 200, headers: SSE_HEADERS }), release }
}

/** Build a plugin configuration for one fake service. */
export function pluginConfig(baseUrl: string, overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { baseUrl, model: 'chatgpt-web/luna', requestTimeoutMs: 0, ...overrides }
}

/** Build the adapter under test with the production factory and a test-owned dependency set. */
export function adapterFor(deps: AdapterDeps): LlmAdapter {
  return createChatGptWebAdapter(deps)
}

/** A logger that records every message, so tests can assert what was and was not logged. */
export interface RecordingLogger extends PluginLogger {
  /** Every message, in call order, prefixed by its level. */
  readonly messages: string[]
}

/** Create a logger that records sanitized messages instead of printing them. */
export function recordingLogger(): RecordingLogger {
  const messages: string[] = []
  const record = (level: string) => (message: string) => {
    messages.push(`${level}: ${message}`)
  }
  return { messages, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
}

/** One text user message. */
export function userMessage(text: string): RequestMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** One assistant message, with the identity `RequestMessage` requires of a durable message. */
export function assistantMessage(text: string): RequestMessage {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    // `createAssistantMessage` stamps the `model` source kind itself.
    source: { provider: 'chatgpt-web', model: 'chatgpt-web/luna' },
  })
}

/** One system message, as the loop's leading system prompt arrives. */
export function systemMessage(text: string): RequestMessage {
  return createSystemMessage(text)
}

/** A user message carrying a non-text block, which this text-only provider must refuse. */
export function imageUserMessage(): RequestMessage {
  const image = { type: 'image', attachment: { id: 'attachment-1' } } as unknown as ContentBlock
  return { role: 'user', content: [image] }
}

/** Options for one request, with the fields a test does not care about defaulted. */
export interface TurnOptions {
  readonly messages: GenerateOptions['messages']
  readonly provider?: string
  readonly model?: string
  readonly sessionId?: string
  readonly purpose?: string
  readonly system?: string
  readonly tools?: GenerateOptions['tools']
  readonly reasoningEffort?: string
  readonly signal?: AbortSignal
}

/**
 * Build one `GenerateOptions` for the adapter under test.
 *
 * The adapter's `stream()` takes the default `GenerateOptions`, whose `purpose` is the (here empty)
 * purpose map; a test declares an auxiliary purpose by name, so the value is branded back.
 */
export function turn(options: TurnOptions): GenerateOptions {
  const provider = options.provider ?? 'chatgpt-web'
  return {
    provider,
    model: options.model ?? `${provider}/luna`,
    messages: options.messages,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId as unknown as GenerateOptions['sessionId'] }),
    ...(options.purpose === undefined
      ? {}
      : { purpose: options.purpose as unknown as GenerateOptions['purpose'] }),
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: options.reasoningEffort as unknown as GenerateOptions['reasoningEffort'] }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** Drain a chunk stream into an array. */
export async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Concatenate every `text-delta` of a chunk list, in order. */
export function textOf(chunks: readonly StreamChunk[]): string {
  let text = ''
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/** The `type` of every chunk, in order: a compact assertion of the canonical chunk sequence. */
export function chunkTypes(chunks: readonly StreamChunk[]): string[] {
  return chunks.map(chunk => chunk.type)
}

/**
 * Run a call that must fail and return its typed `LlmError`.
 * @param run - the failing call.
 * @returns the `LlmError` it raised.
 */
export async function captureFailure(run: () => Promise<unknown>): Promise<LlmError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof LlmError) return error
    throw error
  }
  throw new Error('expected the call to fail, but it succeeded')
}

/** Read the decoded native turn metadata of one recorded request. */
export function turnMetadataOf(request: RecordedRequest): Record<string, string> {
  const metadata = request.body.client_metadata
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('the request carries no client_metadata object')
  }
  const raw = (metadata as Record<string, unknown>)['x-codex-turn-metadata']
  if (typeof raw !== 'string') throw new Error('the request carries no x-codex-turn-metadata string')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the turn metadata is not a JSON object')
  }
  return parsed as Record<string, string>
}

/** Read the wire messages of one recorded request. */
export function messagesOf(request: RecordedRequest): Array<{ role: string; content: string }> {
  const messages = request.body.messages
  if (!Array.isArray(messages)) throw new Error('the request carries no messages array')
  return messages as Array<{ role: string; content: string }>
}
