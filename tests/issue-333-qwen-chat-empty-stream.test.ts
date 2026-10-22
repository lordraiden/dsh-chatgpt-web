import { describe, expect, test } from "bun:test";

import {
  QWEN_CHAT_PROVIDER_ID,
  QWEN_CHAT_REASONING_PHASES,
  QWEN_CHAT_TERMINAL_STATUS,
  QwenChatSseParser,
  createQwenChatCompletionAccumulator,
  createQwenChatTextTransport,
  qwenChatDeltaCarriesAnswer,
  qwenChatDeltaClosesTurn,
  qwenChatEmptyStream,
  qwenChatEmptyStreamSummary,
  type QwenChatCompletionResult,
  type QwenChatRequestSession,
  type QwenChatSseFrame,
  type QwenChatStreamObservation,
  type QwenChatTurnRequestFacility,
} from "../src/adapters/qwen-chat";
import type { WebChatExchangeEvent } from "../src/web-chat/core";
import type { WebChatTextTransportContext } from "../src/web-chat/transport";

/**
 * Issue #333 — the recorded turn's phase order, and the diagnostic of an empty answer.
 *
 * ## Measured, not inferred
 *
 * The operator's real HAR of one `chat.qwen.ai` turn (2026-10-22) is 28 frames and fixes every shape
 * these tests use (frame indices 0-based, `frame 0` being `response.created`):
 *
 * ```text
 * statuses: typing ×25, finished ×2      phases: thinking_summary ×5 (frames 1-5), answer ×22 (6-27)
 * roles: assistant ×27                    frame 0: {response.created: {chat_id, parent_id,
 *                                          response_id, response_index}}
 * 19 of 27 delta frames carried non-empty content
 * content lengths by frame: [0,0,0,0,0, 6,2,13,21,10,16,28,26,24,5,26,12,18,11,23,13,6,7,11, 0,0,0]
 * ```
 *
 * The 5 leading `thinking_summary` frames are empty, the 5th delta is that phase's **`finished`**, and
 * the 22 `answer` frames carry the reply (278 characters). The live failure was exactly this: a
 * `status ≠ typing` rule, inherited from the Qwen Code parser, ended the turn after frame 5 — before
 * any `answer` content — and the harness reported `EMPTY_RESPONSE`.
 *
 * The **structure, counts, phases, statuses and chunk lengths** below are the measured ones. The
 * payload *values* are synthetic (`x`-runs of the measured lengths), and no captured prompt, id or
 * credential appears in this file. The one thing a second capture would still settle is whether a
 * continuation cursor must be `response_id` rather than `response_index`.
 */

const MODEL_ID = "qwen3.7-plus";

/** A synthetic 34-character token. It must never appear in an error or in the log line. */
const SECRET = "SECRETQWENSESSION0123456789abcdef0123456789";

/** The measured content length of each of the 27 delta frames. */
const MEASURED_CONTENT_LENGTHS = [
  0, 0, 0, 0, 0,
  6, 2, 13, 21, 10, 16, 28, 26, 24, 5, 26, 12, 18, 11, 23, 13, 6, 7, 11,
  0, 0, 0,
] as const;

/** The 19 content-bearing chunks, in order: `x`-runs of their measured lengths. */
const ANSWER_CHUNKS = MEASURED_CONTENT_LENGTHS
  .slice(5, 24)
  .map((length, index) => `${String.fromCharCode(97 + (index % 26))}${"x".repeat(Math.max(0, length - 1))}`);
const ANSWER_TEXT = ANSWER_CHUNKS.join("");

const CREATED = frame({
  "response.created": {
    chat_id: "chat-fixture",
    parent_id: "parent-fixture",
    response_id: "response-fixture",
    response_index: 1,
  },
});

/** One `data:` payload line for a JSON frame. */
function frame(payload: unknown): string {
  return JSON.stringify(payload);
}

/** One assistant delta with exactly the fields given. */
function delta(fields: Record<string, unknown>): string {
  return frame({ choices: [{ delta: fields }], response_id: "response-fixture", timestamp: 2 });
}

const STOPPED = frame({ "response.stopped": { response_id: "response-fixture" } });
const DONE = "[DONE]";

/** The measured turn: 5 empty `thinking_summary` deltas (the last one `finished`), then 22 answers. */
function measuredTurn(): string[] {
  const frames: string[] = [CREATED];
  for (let index = 0; index < 5; index += 1) {
    frames.push(delta({
      role: "assistant",
      content: "",
      phase: "thinking_summary",
      status: index === 4 ? "finished" : "typing",
    }));
  }
  ANSWER_CHUNKS.forEach((content, index) => {
    frames.push(delta({ role: "assistant", content, phase: "answer", status: "typing" }));
  });
  // Three trailing empty deltas (two `typing`, one closing `finished`), as measured.
  frames.push(delta({ role: "assistant", content: "", phase: "answer", status: "typing" }));
  frames.push(delta({ role: "assistant", content: "", phase: "answer", status: "typing" }));
  frames.push(delta({ role: "assistant", content: "", phase: "answer", status: "finished" }));
  return frames;
}

/** Feed payloads through the real parser into the real accumulator, recording what happened. */
function run(payloads: readonly string[]): {
  readonly result: QwenChatCompletionResult;
  readonly doneAtFrame: number | undefined;
  readonly observation: QwenChatStreamObservation;
  readonly frames: readonly QwenChatSseFrame[];
} {
  const parser = new QwenChatSseParser();
  const accumulator = createQwenChatCompletionAccumulator();
  const frames: QwenChatSseFrame[] = [];
  let doneAtFrame: number | undefined;
  for (const payload of payloads) {
    for (const item of parser.push(`data: ${payload}\n\n`)) {
      frames.push(item);
      if (accumulator.push(item) && doneAtFrame === undefined) doneAtFrame = frames.length;
    }
  }
  for (const item of parser.end()) {
    frames.push(item);
    if (accumulator.push(item) && doneAtFrame === undefined) doneAtFrame = frames.length;
  }
  return { result: accumulator.finish(), doneAtFrame, observation: parser.observation(), frames };
}

describe("issue #333 — the measured turn produces its answer, not an empty string", () => {
  test("thinking_summary(5, closing finished) then answer(22) yields all 278 characters", () => {
    const { result, doneAtFrame, observation } = run(measuredTurn());

    // The live bug ended the turn at the thinking_summary close (frame 6 of 28).
    expect(doneAtFrame).toBe(28);
    expect(result.text).toBe(ANSWER_TEXT);
    expect(result.text.length).toBe(278);
    expect(result.termination).toBe("delta_status");
    expect(result.terminalStatus).toBe("finished");
    expect(observation.frames).toBe(28);
    expect(observation.deltaFrames).toBe(27);
    expect(observation.contentDeltas).toBe(27);
    // The reasoning phase's five frames were empty, so nothing was excluded as reasoning.
    expect(observation.excludedChars).toBe(0);
    expect(observation.reasoningChars).toBe(0);
  });

  test("a stream that closes without any terminator still returns the answer", () => {
    // The recorded capture ends on the answer phase's `finished`; a provider that simply closes
    // after the answer is the same answer with `stream_end` as the signal.
    const withoutFinalStatus = measuredTurn().slice(0, -1).concat([
      delta({ role: "assistant", content: "", phase: "answer", status: "typing" }),
    ]);
    const { result } = run(withoutFinalStatus);
    expect(result.text).toBe(ANSWER_TEXT);
    expect(result.termination).toBe("stream_end");
  });

  test("a `finished` that closes the reasoning phase is a phase close, not a turn close", () => {
    for (const phase of ["thinking_summary", "think", "local_tool", "web_search"] as const) {
      const { result, doneAtFrame } = run([
        CREATED,
        delta({ role: "assistant", content: "", phase, status: "typing" }),
        delta({ role: "assistant", content: "", phase, status: "finished" }),
        delta({ role: "assistant", content: "the answer", phase: "answer", status: "typing" }),
        STOPPED,
      ]);

      expect(doneAtFrame).toBe(5);
      expect(result.text).toBe("the answer");
      expect(result.termination).toBe("response_stopped");
    }
  });

  test("a role-only opening delta whose status looks terminal does not end the stream", () => {
    for (const status of ["finished", "waiting_input", "pause", "error"] as const) {
      const { result, doneAtFrame, frames } = run([
        CREATED,
        delta({ role: "assistant", content: "", status }),
        delta({ role: "assistant", content: "La respuesta", phase: "answer", status: "typing" }),
        delta({ role: "assistant", content: "", phase: "answer", status: "finished" }),
      ]);

      expect(frames.length).toBeGreaterThan(2);
      expect(doneAtFrame).toBe(4);
      expect(result.text).toBe("La respuesta");
      expect(result.termination).toBe("delta_status");
    }
  });
});

describe("issue #333 — the answer is the `answer` phase, not the reasoning", () => {
  test("reasoning content is not the reply; the answer phase after it still is", () => {
    const { result, observation } = run([
      CREATED,
      delta({ role: "assistant", content: "RAZONAMIENTO-INTERNO", phase: "thinking_summary", status: "typing" }),
      delta({ role: "assistant", content: "", phase: "thinking_summary", status: "finished" }),
      delta({ role: "assistant", content: "respuesta", phase: "answer", status: "typing" }),
      DONE,
    ]);

    expect(result.text).toBe("respuesta");
    expect(result.text).not.toContain("RAZONAMIENTO-INTERNO");
    // Not dropped silently: the characters are counted, with the reasoning subset named.
    expect(observation.excludedChars).toBe("RAZONAMIENTO-INTERNO".length);
    expect(observation.reasoningChars).toBe("RAZONAMIENTO-INTERNO".length);
  });

  test("a phase-less delta is content (the app appends it straight to the message)", () => {
    const { result } = run([
      CREATED,
      delta({ role: "assistant", content: "sin fase", status: "typing" }),
      DONE,
    ]);
    expect(result.text).toBe("sin fase");
  });

  test("the content rule and the status rule, named", () => {
    expect(qwenChatDeltaCarriesAnswer({ phase: "answer" })).toBe(true);
    expect(qwenChatDeltaCarriesAnswer({ phase: "slides" })).toBe(true);
    expect(qwenChatDeltaCarriesAnswer({})).toBe(true);
    for (const phase of QWEN_CHAT_REASONING_PHASES) {
      expect(qwenChatDeltaCarriesAnswer({ phase })).toBe(false);
    }
    expect(qwenChatDeltaCarriesAnswer({ phase: "local_tool" })).toBe(false);

    expect(qwenChatDeltaClosesTurn({ status: "finished", phase: "answer" }, false)).toBe(true);
    // A phase-less `finished` is trusted only once the answer actually produced content.
    expect(qwenChatDeltaClosesTurn({ status: "finished" }, false)).toBe(false);
    expect(qwenChatDeltaClosesTurn({ status: "finished" }, true)).toBe(true);
    for (const status of ["typing", "waiting_input", "pause", "error"]) {
      expect(qwenChatDeltaClosesTurn({ status }, true)).toBe(false);
    }
    expect(qwenChatDeltaClosesTurn({ status: "finished", phase: "thinking_summary" }, true)).toBe(false);
    expect(QWEN_CHAT_TERMINAL_STATUS).toBe("finished");
  });
});

describe("issue #333 — every genuine terminator is still a terminator", () => {
  test("[DONE], response.stopped, an in-band error and the stream closing", () => {
    const answer = delta({ role: "assistant", content: "x", phase: "answer", status: "typing" });
    const cases: readonly { readonly payloads: readonly string[]; readonly termination: string }[] = [
      { payloads: [answer, DONE], termination: "done" },
      { payloads: [answer, STOPPED], termination: "response_stopped" },
      { payloads: [answer, frame({ error: { code: "pow" }, response_id: "r" })], termination: "error" },
      { payloads: [answer], termination: "stream_end" },
      { payloads: [answer, delta({ role: "assistant", content: "", phase: "answer", status: "finished" })], termination: "delta_status" },
    ];
    for (const item of cases) {
      expect(run(item.payloads).result.termination).toBe(item.termination as never);
    }
  });

  test("the bundle reads `delta.content` as a string: a non-string content is evidence, not text", () => {
    // The vendor mapper is `value: a?.content ?? ""`, so an array ("parts") would be empty for the
    // app too — a refutation of that hypothesis, while the observation still records that content
    // arrived in a shape this vocabulary cannot read.
    const { result, observation } = run([
      CREATED,
      delta({ role: "assistant", content: [{ type: "text", text: "parts?" }], phase: "answer", status: "typing" }),
      STOPPED,
    ]);

    expect(result.text).toBe("");
    expect(observation.deltaFrames).toBe(1);
    expect(observation.contentDeltas).toBe(1);
    expect(observation.contentNonString).toBe(1);
  });
});

describe("issue #333 — the frame observation behind an empty answer", () => {
  test("it counts frames, shapes, content-bearing deltas and which signal ended the stream", () => {
    const { observation } = run([
      CREATED,
      delta({ role: "assistant", status: "finished" }),
      delta({ role: "assistant", content: "text", phase: "answer", status: "typing" }),
      delta({ role: "assistant", content: "text", phase: "answer", status: "typing" }),
      STOPPED,
    ]);

    expect(observation.frames).toBe(5);
    expect(observation.deltaFrames).toBe(3);
    // Two of the three deltas carried a `content` field at all; the role-only one did not.
    expect(observation.contentDeltas).toBe(2);
    expect(observation.contentNonString).toBe(0);
    expect(observation.shapes.map(entry => entry.count)).toEqual([2, 1, 1, 1]);
    const shapes = observation.shapes.map(entry => entry.shape);
    expect(shapes.some(shape => shape.includes("response.created"))).toBe(true);
    expect(shapes.some(shape => shape.includes("response.stopped"))).toBe(true);
    expect(shapes.some(shape => shape.includes("choices: [{delta:"))).toBe(true);
    // Key paths only: no value of any frame appears in a shape.
    for (const shape of shapes) expect(shape).not.toContain("chat-fixture");
  });

  test("an unmodelled payload is named by shape and by one redacted fragment", () => {
    const { observation } = run([
      CREATED,
      frame({ response_id: "response-fixture", future_frame: { access_token: SECRET, mode: "x" } }),
      STOPPED,
    ]);

    expect(observation.shapes.some(entry => entry.shape.includes("future_frame: {access_token, mode}"))).toBe(true);
    expect(observation.fragment).toContain("[redacted]");
    expect(observation.fragment).not.toContain(SECRET);
  });

  test("the empty-stream summary states the four facts, redacted and bounded", () => {
    const { observation } = run([
      CREATED,
      delta({ role: "assistant", status: "waiting_input" }),
      frame({ response_id: "response-fixture", unknown_frame: { session_token: SECRET } }),
      STOPPED,
    ]);

    const read = qwenChatEmptyStreamSummary({ observation, termination: "response_stopped" });

    expect(read.message).toContain("4 frames seen");
    expect(read.message).toContain("4 distinct shapes");
    expect(read.message).toContain("response.created");
    expect(read.message).toContain("the stream ended by response_stopped");
    expect(read.message).toContain("0 of 1 delta frames carried a content field");
    expect(read.message).toContain("[redacted]");
    expect(read.message).not.toContain(SECRET);
    expect(read.message.length).toBeLessThan(800);

    expect(read.detail).toMatchObject({
      kind: "empty-stream",
      termination: "response_stopped",
      frames: 4,
      shapesTotal: 4,
      deltaFrames: 1,
      contentDeltas: 0,
      contentNonString: 0,
    });
    expect(JSON.stringify(read.detail)).not.toContain(SECRET);
    expect(JSON.stringify(read.detail)).toContain("[redacted]");
  });

  test("a safety-net empty answer that carried only reasoning says so", () => {
    const reasoningText = "solo razonamiento";
    const { observation } = run([
      CREATED,
      delta({ role: "assistant", content: reasoningText, phase: "thinking_summary", status: "finished" }),
      STOPPED,
    ]);

    const read = qwenChatEmptyStreamSummary({ observation, termination: "response_stopped" });
    expect(read.message).toContain(`${reasoningText.length} characters arrived in phases that are not the answer`);
    expect(read.message).toContain(`(${reasoningText.length} of them reasoning)`);
    expect(read.detail).toMatchObject({ excludedChars: reasoningText.length, reasoningChars: reasoningText.length });
  });

  test("the ending signal is named with the status it closed on", () => {
    const { observation } = run([
      CREATED,
      delta({ role: "assistant", content: "", phase: "answer", status: "finished" }),
    ]);
    const read = qwenChatEmptyStreamSummary({
      observation,
      termination: "delta_status",
      terminalStatus: "finished",
    });
    expect(read.message).toContain('the stream ended by delta_status ("finished")');
    expect(read.detail).toMatchObject({ termination: "delta_status", terminalStatus: "finished" });
  });
});

/** Capture `console.warn` for one call, and hand back what was written. */
async function captureWarnings<T>(body: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    return { value: await body(), lines };
  } finally {
    console.warn = original;
  }
}

describe("issue #333 — the empty answer is a typed failure, in one log line", () => {
  test("the error and the log line carry the same evidence, and no secret", async () => {
    const { observation } = run([
      CREATED,
      delta({ role: "assistant", status: "finished" }),
      frame({ response_id: "response-fixture", future_frame: { access_token: SECRET } }),
      STOPPED,
    ]);

    const { value: error, lines } = await captureWarnings(() => qwenChatEmptyStream({
      observation,
      termination: "response_stopped",
    }));

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("qwen_chat_empty_stream");
    expect(line).toContain(QWEN_CHAT_PROVIDER_ID);
    expect(line).toContain('"kind":"empty-stream"');
    expect(line).toContain('"termination":"response_stopped"');
    expect(line).toContain('"frames":4');
    expect(line).toContain('"contentDeltas":0');
    expect(line).not.toContain(SECRET);
    expect(line).toContain("[redacted]");

    expect(error.providerCode).toBe("QWEN_CHAT_EMPTY_STREAM");
    expect(error.category).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("4 frames seen");
    expect(error.message).toContain("response_stopped");
    expect(error.message).not.toContain(SECRET);
    expect(error.providerDetail).toMatchObject({ kind: "empty-stream", frames: 4, deltaFrames: 1, contentDeltas: 0 });
  });
});

/** A session that runs the turn on one injected facility. */
function sessionOver(facility: QwenChatTurnRequestFacility): QwenChatRequestSession {
  return {
    id: "issue-333-qwen-chat-empty-stream-session",
    async ready() {},
    async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(facility);
    },
    async close() {},
  };
}

/** A facility whose completion stream is exactly the recorded payloads it was given. */
function streamingFacility(payloads: readonly string[]): QwenChatTurnRequestFacility {
  return {
    async postJson() {
      return {
        status: 200,
        body: { success: true, request_id: "req", data: { id: "chat-1" } },
        contentType: "application/json",
        bodyText: "{}",
      };
    },
    async postEventStream(_path, _body, onChunk, options = {}) {
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      for (const payload of payloads) {
        if (onChunk(`data: ${payload}\n\n`)) break;
      }
      return { status: 200, contentType: "text/event-stream" };
    },
  };
}

const CONTEXT: WebChatTextTransportContext = {
  identity: { bindingId: "binding", conversationKey: "conversation", turnId: "turn" },
  turn: { userText: "hola", model: MODEL_ID },
  epoch: 1,
  signal: new AbortController().signal,
};

describe("issue #333 — the transport over the measured shape, and the empty safety net", () => {
  test("the measured turn streams its answer through the transport", async () => {
    const transport = createQwenChatTextTransport({
      session: sessionOver(streamingFacility(measuredTurn())),
      model: MODEL_ID,
      mode: "Auto",
    });

    await transport.ready(CONTEXT);
    expect(await transport.submit(CONTEXT)).toBe("accepted");

    const events: WebChatExchangeEvent[] = [];
    for await (const event of transport.stream(CONTEXT) as AsyncIterable<WebChatExchangeEvent>) events.push(event);

    // Every answer chunk streamed out, in order, and the turn completed with the full text.
    const streamed = events
      .filter((event): event is Extract<WebChatExchangeEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map(event => event.text)
      .join("");
    expect(streamed).toBe(ANSWER_TEXT);
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.type === "completed" ? completed.text : undefined).toBe(ANSWER_TEXT);
  });

  test("a completed stream with no text is a typed error carrying the frame evidence", async () => {
    const payloads = [
      CREATED,
      // The suspected live shape: a role-only opening delta whose status looks terminal, then the
      // provider's stop — with no content frame in between.
      delta({ role: "assistant", status: "finished" }),
      frame({ response_id: "response-fixture", future_frame: { access_token: SECRET } }),
      STOPPED,
    ];
    const transport = createQwenChatTextTransport({
      session: sessionOver(streamingFacility(payloads)),
      model: MODEL_ID,
      mode: "Auto",
    });

    // `submit` starts the provider work, so the whole turn is captured: the empty-stream line is
    // emitted by the transport's own task, not by `stream()`.
    const { value: events, lines } = await captureWarnings(async () => {
      await transport.ready(CONTEXT);
      expect(await transport.submit(CONTEXT)).toBe("accepted");
      const seen: WebChatExchangeEvent[] = [];
      for await (const event of transport.stream(CONTEXT) as AsyncIterable<WebChatExchangeEvent>) seen.push(event);
      return seen;
    });

    // No `completed` event with empty text: the turn fails with its evidence instead.
    expect(events.map(event => event.type)).toEqual(["error"]);
    const failure = events[0];
    if (failure?.type !== "error") throw new Error("the empty turn did not report an error event");
    expect(failure.error.providerCode).toBe("QWEN_CHAT_EMPTY_STREAM");
    expect(failure.error.category).toBe("UPSTREAM_ERROR");
    expect(failure.error.message).toContain("4 frames seen");
    expect(failure.error.message).toContain("response.created");
    expect(failure.error.message).toContain("the stream ended by response_stopped");
    expect(failure.error.message).toContain("0 of 1 delta frames carried a content field");
    expect(failure.error.message).not.toContain(SECRET);
    expect(failure.error.message).toContain("[redacted]");

    // Exactly one `qwen_chat_empty_stream` line, carrying the same structured facts.
    const emptyLines = lines.filter(line => line.includes("qwen_chat_empty_stream"));
    expect(emptyLines).toHaveLength(1);
    expect(emptyLines[0]).toContain('"frames":4');
    expect(emptyLines[0]).toContain('"contentDeltas":0');
    expect(emptyLines[0]).not.toContain(SECRET);
  });

  test("a stream with content is unaffected: it completes with its text and no empty-stream line", async () => {
    const payloads = [
      CREATED,
      delta({ role: "assistant", content: "hola", phase: "answer", status: "typing" }),
      delta({ role: "assistant", content: "", phase: "answer", status: "finished" }),
    ];
    const transport = createQwenChatTextTransport({
      session: sessionOver(streamingFacility(payloads)),
      model: MODEL_ID,
      mode: "Auto",
    });

    await transport.ready(CONTEXT);
    expect(await transport.submit(CONTEXT)).toBe("accepted");

    const { value: events, lines } = await captureWarnings(async () => {
      const seen: WebChatExchangeEvent[] = [];
      for await (const event of transport.stream(CONTEXT) as AsyncIterable<WebChatExchangeEvent>) seen.push(event);
      return seen;
    });

    expect(events.map(event => event.type)).toEqual(["text_delta", "completed"]);
    const completed = events.at(-1);
    expect(completed?.type === "completed" ? completed.text : undefined).toBe("hola");
    expect(lines.filter(line => line.includes("qwen_chat_empty_stream"))).toHaveLength(0);
  });
});
