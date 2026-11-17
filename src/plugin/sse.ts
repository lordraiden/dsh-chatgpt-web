/**
 * Server-sent-events framing for the service's `/v1/chat/completions` stream.
 *
 * The service speaks OpenAI-compatible SSE: `: keep-alive` comments during long browser turns,
 * `data: <json>` frames, a terminal `data: [DONE]`, and — once a turn has been accepted — a failure
 * as `data: {"error":{"message","type"}}` with HTTP 200. This module owns only the framing: it turns
 * arbitrary byte chunks into complete events, tolerating a frame split across chunks, CRLF/CR/LF
 * line endings, comment lines, multi-line `data:` fields and a missing trailing blank line. It never
 * interprets the payload: the adapter owns the JSON and the chunk vocabulary.
 *
 * The decoder is deliberately incremental. A browser turn can run for many minutes, and the service
 * interleaves keep-alive comments with the text deltas, so buffering the whole response would defeat
 * streaming and a line-oriented reader that assumes one chunk equals one line would drop frames.
 */

/** One complete SSE event, after framing and before any payload interpretation. */
export interface SseEvent {
  /** The `event:` field, when the sender declared one. */
  readonly event?: string
  /** The `data:` field(s), joined with `\n` exactly as the SSE specification requires. */
  readonly data: string
  /** The `id:` field, when the sender declared one. */
  readonly id?: string
}

/**
 * Incremental SSE decoder.
 *
 * Feed it decoded text chunks with {@link push} and flush the tail with {@link end}; it returns the
 * events that became complete. A comment line (`:` …) is ignored, a blank line dispatches the
 * pending event, and a field line without a colon is a field with an empty value, as the SSE
 * specification defines.
 */
export class SseDecoder {
  private buffer = ''
  private dataLines: string[] = []
  private eventName: string | undefined
  private id: string | undefined

  /**
   * Consume one decoded text chunk.
   * @param chunk - any slice of the stream; it may end in the middle of a line or of a CRLF pair.
   * @returns every event completed by this chunk, in stream order.
   */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    for (;;) {
      const terminator = findLineTerminator(this.buffer)
      if (terminator === undefined) break
      const line = this.buffer.slice(0, terminator.index)
      this.buffer = this.buffer.slice(terminator.index + terminator.length)
      this.consumeLine(line, events)
    }
    return events
  }

  /**
   * Flush the decoder at end of stream.
   *
   * The SSE specification dispatches the last pending event at EOF even without a trailing blank
   * line, and a trailing lone `\r` is a line terminator at EOF rather than the first half of a
   * CRLF pair.
   * @returns the events still pending, in stream order.
   */
  end(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer.endsWith('\r')) {
      const line = this.buffer.slice(0, -1)
      this.buffer = ''
      this.consumeLine(line, events)
    } else if (this.buffer !== '') {
      const line = this.buffer
      this.buffer = ''
      this.consumeLine(line, events)
    }
    this.dispatch(events)
    return events
  }

  /** Apply one complete line to the pending event state. */
  private consumeLine(line: string, events: SseEvent[]): void {
    if (line === '') {
      this.dispatch(events)
      return
    }
    // A line starting with a colon is a comment (the service's `: keep-alive` heartbeat).
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    // The specification strips exactly one leading space from the value, not all whitespace.
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'data':
        this.dataLines.push(value)
        break
      case 'event':
        this.eventName = value
        break
      case 'id':
        this.id = value
        break
      default:
        // `retry:` and unknown fields carry nothing this adapter needs.
        break
    }
  }

  /** Emit the pending event, if it carries data, and reset the per-event state. */
  private dispatch(events: SseEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = undefined
      this.id = undefined
      return
    }
    const data = this.dataLines.join('\n')
    const event = this.eventName
    const id = this.id
    this.dataLines = []
    this.eventName = undefined
    this.id = undefined
    events.push({
      data,
      ...(event === undefined ? {} : { event }),
      ...(id === undefined ? {} : { id }),
    })
  }
}

/**
 * Read one SSE response body as a sequence of framed events.
 *
 * The reader is cancelled when the consumer stops early (a terminal frame is enough) or when the
 * body fails, so a caller that breaks out of the loop never leaks the underlying connection.
 * Transport and cancellation failures surface as the reader's own rejection; the adapter maps them
 * onto the DSH failure taxonomy.
 * @param body - the response body of a `text/event-stream` response.
 * @returns the framed events, in stream order.
 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield* parser.push(decoder.decode(value, { stream: true }))
    }
    // Flush the decoder's internal state (a multi-byte character split across chunks).
    yield* parser.push(decoder.decode())
    yield* parser.end()
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The reader is already closed, errored or cancelled; there is nothing left to release.
    }
  }
}

/** Locate the next line terminator, holding back a trailing `\r` that may start a CRLF pair. */
function findLineTerminator(text: string): { index: number; length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') return { index, length: 1 }
    if (char === '\r') {
      // A CR at the very end of the buffer may be the first half of a CRLF split across chunks.
      if (index + 1 >= text.length) return undefined
      return { index, length: text[index + 1] === '\n' ? 2 : 1 }
    }
  }
  return undefined
}
