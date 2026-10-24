import { describe, expect, test } from "bun:test";

import {
  DEEPSEEK_TERMINATIONS,
  DeepSeekDeltaParser,
  DeepSeekFragmentAssembler,
  DeepSeekProtocolError,
  DeepSeekSseReader,
  createDeepSeekCompletionAccumulator,
  normaliseDeepSeekPatch,
  parseDeepSeekSseEvent,
  type DeepSeekSseFrame,
  type DeepSeekSseRawEvent,
} from "../src/adapters/deepseek-web";

/**
 * The `chat.deepseek.com` completion vocabulary — **recorded shape, synthetic content**.
 *
 * Every frame shape below is measured from the signed-in capture the operator supplied on 2026-10-24
 * (two completions, 115 frames):
 *
 * - named SSE (`ready`, `update_session`, `title`, `close`), with the bulk of the turn carried by
 *   **unnamed** `data:` frames — the app's `if (!e.event && e.data)` delta case;
 * - the first delta is the whole `{response: …}` document (no `p`, no `o`);
 * - later deltas are `{p, o, v}`, `{p, v}` (operation inherited) and `{v}` (both inherited);
 * - paths address the last fragment as `-1` (`response/fragments/-1/content`);
 * - `BATCH` children are **relative** to the batch path (`p:"response"`, children `p:"status"`);
 * - the answer is the `RESPONSE` fragment, the reasoning is the `THINK` fragment, and a normal turn
 *   ends with `close` (`click_behavior: "none"`) after `response/status: FINISHED`.
 *
 * Every text, id and title here is synthetic; no captured prompt, answer, id, header or credential
 * appears in this file.
 */

/** One named SSE event block. */
function named(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** One unnamed `data:` block — the recorded delta case. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** One fully-specified patch block (the form the app also uses). */
function delta(p: string, o: string, v: unknown): string {
  return frame({ p, o, v });
}

const READY = named("ready", {
  response_message_id: "message-fixture",
  request_message_id: "request-fixture",
  model_type: "default",
});

/** The measured first delta: the complete response document, with a `THINK` fragment already open. */
const SNAPSHOT = frame({
  v: {
    response: {
      message_id: 2,
      parent_id: 1,
      model: "",
      role: "ASSISTANT",
      thinking_enabled: true,
      ban_edit: false,
      ban_regenerate: false,
      status: "WIP",
      incomplete_message: null,
      accumulated_token_usage: 0,
      feedback: null,
      inserted_at: 1_700_000_000,
      search_enabled: true,
      fragments: [{ id: 2, type: "THINK", content: "We", elapsed_secs: null, references: [], stage_id: 1 }],
      conversation_mode: "DEFAULT",
      has_pending_fragment: false,
      auto_continue: false,
      search_triggered: false,
      extra_search_providers: [],
    },
  },
});

/**
 * The measured frame sequence of one normal turn, with synthetic text.
 *
 * Order, event names, patch forms and paths are the capture's; only the strings differ.
 */
const MEASURED_TURN = [
  READY,
  named("update_session", { updated_at: 1_700_000_001 }),
  SNAPSHOT,
  delta("response/fragments/-1/content", "APPEND", " reason"),
  frame({ v: " quietly" }),
  delta("response/fragments/-1/elapsed_secs", "SET", 0.5),
  delta("response/fragments", "APPEND", [
    { id: 3, type: "RESPONSE", content: "H", references: [], stage_id: 1 },
  ]),
  // The operation is inherited (`APPEND`) and the path is the last fragment's content.
  frame({ p: "response/fragments/-1/content", v: "i" }),
  frame({ v: " there" }),
  // The recorded BATCH is re-rooted under `response`, so its children are relative.
  delta("response", "BATCH", [
    { p: "accumulated_token_usage", v: 7 },
    { p: "quasi_status", v: "FINISHED" },
  ]),
  delta("response/status", "SET", "FINISHED"),
  named("title", { content: "synthetic title" }),
  named("close", { click_behavior: "none", auto_resume: false }),
].join("");

/** Classify the single event one block contains. */
function parseDeepSseFrameOf(block: string): DeepSeekSseFrame {
  const reader = new DeepSeekSseReader();
  const events = [...reader.push(block), ...reader.end()];
  expect(events).toHaveLength(1);
  return parseDeepSeekSseEvent(events[0]!);
}

describe("deepseek-web — named SSE frames are classified structurally", () => {
  test("the recorded event names parse", () => {
    expect(parseDeepSeekSseEvent({ event: "ready", data: JSON.stringify({
      response_message_id: "message-fixture",
      request_message_id: "request-fixture",
      model_type: "default",
    }) })).toEqual({
      kind: "ready",
      responseMessageId: "message-fixture",
      requestMessageId: "request-fixture",
      modelType: "default",
    });
    expect(parseDeepSeekSseEvent({ event: "close", data: JSON.stringify({ click_behavior: "retry" }) }))
      .toEqual({ kind: "close", clickBehavior: "retry" });
    expect(parseDeepSeekSseEvent({ event: "finish", data: "{}" })).toEqual({ kind: "finish" });
    expect(parseDeepSseFrameOf(named("update_session", { updated_at: 1_700_000_000 })))
      .toMatchObject({ kind: "update_session", updatedAt: 1_700_000_000 });
    expect(parseDeepSseFrameOf(named("toast", { type: "error", content: "synthetic", finish_reason: "stop" })))
      .toEqual({ kind: "toast", type: "error", content: "synthetic", finishReason: "stop" });
    expect(parseDeepSseFrameOf(named("hint", { content: "synthetic", type: "tip", clear_response: true })))
      .toEqual({ kind: "hint", content: "synthetic", type: "tip", clearResponse: true });
    expect(parseDeepSseFrameOf(named("title", { title: "synthetic" }))).toMatchObject({ kind: "title" });
    expect(parseDeepSseFrameOf(named("update_parent_message", { chat_message: {} })))
      .toMatchObject({ kind: "update_parent_message" });
    expect(parseDeepSseFrameOf(named("update_file", {}))).toMatchObject({ kind: "update_file" });
  });

  test("an unnamed data frame is the delta case, and p/o are optional on it", () => {
    // All three measured forms classify as a delta; inheritance is applied by the parser.
    expect(parseDeepSseFrameOf(delta("response/fragments/0/content", "APPEND", "Hello"))).toEqual({
      kind: "delta",
      patch: { p: "response/fragments/0/content", o: "APPEND", v: "Hello" },
    });
    expect(parseDeepSseFrameOf(frame({ p: "response/fragments/-1/content", v: "H" }))).toEqual({
      kind: "delta",
      patch: { p: "response/fragments/-1/content", v: "H" },
    });
    expect(parseDeepSseFrameOf(frame({ v: " there" }))).toEqual({ kind: "delta", patch: { v: " there" } });
    expect(normaliseDeepSeekPatch({ v: { response: {} } })).toEqual({ v: { response: {} } });
  });

  test("an unmodelled event is reported, not guessed and not fatal", () => {
    expect(parseDeepSseFrameOf(named("future_event", { x: 1 }))).toEqual({
      kind: "unknown",
      event: "future_event",
      data: JSON.stringify({ x: 1 }),
    });
  });
});

describe("deepseek-web — the reader is incremental and framing-only", () => {
  test("comments are ignored, data lines are joined, and an event without data is not a frame", () => {
    const reader = new DeepSeekSseReader();
    const events = reader.push(
      ": heartbeat\n\n"
      + "event: ready\n"
      + 'data: {"response_message_id":\n'
      + 'data: "message-fixture"}\n\n',
    );
    expect(events).toEqual([{ event: "ready", data: '{"response_message_id":\n"message-fixture"}' }]);
    expect(parseDeepSeekSseEvent(events[0]!)).toEqual({ kind: "ready", responseMessageId: "message-fixture" });
    // A block with no event name and no data is a heartbeat, not a frame.
    expect(reader.push(": ping\n\n")).toEqual([]);
  });

  test("chunk boundaries are irrelevant: a character-at-a-time feed yields the same frames", () => {
    const whole = new DeepSeekSseReader();
    const expected = [...whole.push(MEASURED_TURN), ...whole.end()];
    expect(expected.length).toBe(13);

    const chunked = new DeepSeekSseReader();
    const actual: DeepSeekSseRawEvent[] = [];
    for (const character of MEASURED_TURN) actual.push(...chunked.push(character));
    actual.push(...chunked.end());
    expect(actual).toEqual(expected);
  });

  test("a CRLF pair split across two chunks is still one line ending", () => {
    const reader = new DeepSeekSseReader();
    const body = `event: ready\r\ndata: {"model_type":"default"}\r\n\r\n`;
    const events: DeepSeekSseRawEvent[] = [];
    for (const chunk of [body.slice(0, 20), body.slice(20, 21), body.slice(21)]) events.push(...reader.push(chunk));
    events.push(...reader.end());
    expect(events).toEqual([{ event: "ready", data: '{"model_type":"default"}' }]);
  });

  test("a trailing event without its blank line is flushed exactly once", () => {
    const reader = new DeepSeekSseReader();
    expect(reader.push('data: {"p":"response/status","o":"SET","v":"FINISHED"}')).toEqual([]);
    expect(reader.end()).toHaveLength(1);
    expect(reader.end()).toEqual([]);
  });
});

describe("deepseek-web — the delta parser applies the app's sticky defaults and relative BATCH", () => {
  test("the first frame defaults to SET at the document root", () => {
    expect(new DeepSeekDeltaParser().parse({ v: { response: { status: "WIP" } } }))
      .toEqual([{ path: "", operation: "SET", value: { response: { status: "WIP" } } }]);
  });

  test("an operation and a path are inherited until replaced", () => {
    const parser = new DeepSeekDeltaParser();
    expect(parser.parse({ p: "response/fragments/-1/content", o: "APPEND", v: "We" }))
      .toEqual([{ path: "response/fragments/-1/content", operation: "APPEND", value: "We" }]);
    // `{v}` keeps both.
    expect(parser.parse({ v: " think" }))
      .toEqual([{ path: "response/fragments/-1/content", operation: "APPEND", value: " think" }]);
    // `{p, v}` keeps the operation, changes the path.
    expect(parser.parse({ p: "response/fragments/-1/elapsed_secs", v: 1 }))
      .toEqual([{ path: "response/fragments/-1/elapsed_secs", operation: "APPEND", value: 1 }]);
    // An explicit operation wins.
    expect(parser.parse({ p: "response/status", o: "SET", v: "FINISHED" }))
      .toEqual([{ path: "response/status", operation: "SET", value: "FINISHED" }]);
    // The new operation/path become the defaults for the next frame.
    expect(parser.parse({ v: "x" }))
      .toEqual([{ path: "response/status", operation: "SET", value: "x" }]);
  });

  test("BATCH children are relative to the batch path, and nest the same way", () => {
    const parser = new DeepSeekDeltaParser();
    expect(parser.parse({
      p: "response",
      o: "BATCH",
      v: [
        { p: "accumulated_token_usage", v: 7 },
        { p: "status", o: "SET", v: "FINISHED" },
        { p: "quasi_status", o: "BATCH", v: [{ p: "x", v: 1 }] },
      ],
    })).toEqual([
      { path: "response/accumulated_token_usage", operation: "SET", value: 7 },
      { path: "response/status", operation: "SET", value: "FINISHED" },
      { path: "response/quasi_status/x", operation: "SET", value: 1 },
    ]);
  });

  test("a batch child without a path addresses the batch node itself", () => {
    expect(new DeepSeekDeltaParser().parse({ p: "response/status", o: "BATCH", v: [{ v: "FINISHED" }] }))
      .toEqual([{ path: "response/status", operation: "SET", value: "FINISHED" }]);
  });
});

describe("deepseek-web — the fragment assembler applies the measured patch forms", () => {
  test("a whole response document can be SET, and `-1` addresses its last fragment", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ v: { response: { fragments: [
      { id: 1, type: "THINK", content: "We" },
      { id: 2, type: "RESPONSE", content: "a" },
    ] } } });
    assembler.apply({ p: "response/fragments/-1/content", o: "APPEND", v: "nswer" });
    expect(assembler.text()).toBe("answer");
    expect(assembler.reasoningText()).toBe("We");
    // `-1` never becomes an object key named "-1".
    expect(assembler.fragments().map(fragment => fragment.index)).toEqual([0, 1]);
  });

  test("APPEND of an array appends fragments; APPEND of text requires an existing string", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "a" }] } } });
    assembler.apply({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "b" }] });
    assembler.apply({ p: "response/fragments/0/content", o: "APPEND", v: "!" });
    expect(assembler.text()).toBe("a!b");
    // The app's own writer refuses text APPEND to a missing/non-string target; so does this.
    expect(() => assembler.apply({ p: "response/fragments/1/content", o: "SET", v: 7 }))
      .not.toThrow();
    expect(() => assembler.apply({ p: "response/fragments/2/content", o: "APPEND", v: "x" }))
      .toThrow(DeepSeekProtocolError);
  });

  test("arrival order is not document order: a later fragment cannot shift an earlier one", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "first " }] } } });
    // A second fragment arrives before the first one finishes streaming.
    assembler.apply({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "second" }] });
    assembler.apply({ p: "response/fragments/0/content", o: "APPEND", v: "one" });
    expect(assembler.text()).toBe("first onesecond");
  });

  test("a repeated APPEND is applied as recorded, and a SET converges", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ p: "response/fragments/0", o: "SET", v: { type: "RESPONSE", content: "" } });
    for (const piece of ["a", "b", "c", "d"]) {
      assembler.apply({ p: "response/fragments/0/content", o: "APPEND", v: piece });
    }
    expect(assembler.text()).toBe("abcd");
    assembler.apply({ p: "response/fragments/0/content", o: "SET", v: "abcd" });
    expect(assembler.text()).toBe("abcd");
  });

  test("a negative index works while traversing, not only at the final assignment", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ v: { response: { fragments: [
      { type: "THINK", content: "We" },
      { type: "RESPONSE", content: "Hi" },
    ] } } });
    assembler.apply({ p: "response/fragments/-1/elapsed_secs", o: "SET", v: 0.25 });
    expect(assembler.text()).toBe("Hi");
    // A fragment element cannot be created through `-1`: the element must exist.
    expect(() => assembler.apply({ p: "response/fragments/-9/content", o: "SET", v: "x" }))
      .toThrow(DeepSeekProtocolError);
  });

  test("only RESPONSE content is the answer; THINK is reasoning; anything else is unattributed", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ v: { response: { fragments: [
      { type: "THINK", content: "a thought" },
      { type: "RESPONSE", content: "the answer" },
      { type: "SEARCH", content: "a citation card" },
    ] } } });
    expect(assembler.text()).toBe("the answer");
    expect(assembler.reasoningText()).toBe("a thought");
    expect(assembler.unattributedText()).toBe("a citation card");
    expect(assembler.fragmentTypes()).toEqual(["THINK", "RESPONSE", "SEARCH"]);
  });
});

describe("deepseek-web — a malformed patch is refused with a typed error", () => {
  const cases: readonly { readonly name: string; readonly patch: unknown; readonly code: string }[] = [
    { name: "not an object", patch: "nope", code: "DEEPSEEK_PATCH_NOT_OBJECT" },
    { name: "empty segment", patch: { p: "response//content", o: "SET", v: "x" }, code: "DEEPSEEK_PATCH_PATH_INVALID" },
    { name: "non-string path", patch: { p: 7, o: "SET", v: "x" }, code: "DEEPSEEK_PATCH_PATH_INVALID" },
    { name: "unknown operation", patch: { p: "response/x", o: "MERGE", v: "x" }, code: "DEEPSEEK_PATCH_OPERATION_INVALID" },
    { name: "missing value", patch: { p: "response/x", o: "SET" }, code: "DEEPSEEK_PATCH_VALUE_MISSING" },
    { name: "a root other than the response document", patch: { p: "other/x", o: "SET", v: 1 }, code: "DEEPSEEK_PATCH_ROOT_INVALID" },
    { name: "a non-SET operation at the document root", patch: { p: "", o: "APPEND", v: "x" }, code: "DEEPSEEK_PATCH_ROOT_INVALID" },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      const assembler = new DeepSeekFragmentAssembler();
      let thrown: unknown;
      try {
        assembler.apply(entry.patch);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DeepSeekProtocolError);
      expect((thrown as DeepSeekProtocolError).code).toBe(entry.code);
      // Nothing was corrupted on the way out.
      expect(assembler.text()).toBe("");
    });
  }

  test("BATCH must carry an array of patches", () => {
    const assembler = new DeepSeekFragmentAssembler();
    expect(() => assembler.apply({ p: "response/fragments/0/content", o: "BATCH", v: { p: "x", o: "SET", v: 1 } }))
      .toThrow(DeepSeekProtocolError);
  });

  test("BATCH nesting is bounded", () => {
    const assembler = new DeepSeekFragmentAssembler();
    let nested: unknown = { p: "response/fragments/0/content", o: "SET", v: "deep" };
    for (let index = 0; index < 12; index += 1) {
      nested = { p: "response/fragments/0/content", o: "BATCH", v: [nested] };
    }
    expect(() => assembler.apply(nested)).toThrow(DeepSeekProtocolError);
  });

  test("APPEND of a number to text, and APPEND to a number, are refused", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ p: "response/fragments/0", o: "SET", v: { type: "RESPONSE", content: "text" } });
    expect(() => assembler.apply({ p: "response/fragments/0/content", o: "APPEND", v: 5 }))
      .toThrow(DeepSeekProtocolError);
    assembler.apply({ p: "response/status", o: "SET", v: 7 });
    expect(() => assembler.apply({ p: "response/status", o: "APPEND", v: "x" }))
      .toThrow(DeepSeekProtocolError);
  });

  test("a path that traverses a scalar is refused instead of overwriting it", () => {
    const assembler = new DeepSeekFragmentAssembler();
    assembler.apply({ p: "response/fragments/0", o: "SET", v: { type: "RESPONSE", content: "text" } });
    let thrown: unknown;
    try {
      assembler.apply({ p: "response/fragments/0/content/deeper", o: "SET", v: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeepSeekProtocolError);
    expect((thrown as DeepSeekProtocolError).code).toBe("DEEPSEEK_PATCH_PATH_TRAVERSAL");
    expect(assembler.text()).toBe("text");
  });

  test("a delta whose data is not JSON is a typed protocol error, never text", () => {
    expect(() => parseDeepSeekSseEvent({ event: "delta", data: "not json" })).toThrow(DeepSeekProtocolError);
  });
});

describe("deepseek-web — the accumulator: content, control frames and terminators", () => {
  /** Feed one whole stream body and return the result. */
  function run(body: string) {
    const reader = new DeepSeekSseReader();
    const accumulator = createDeepSeekCompletionAccumulator();
    for (const event of reader.push(body)) {
      if (accumulator.push(parseDeepSeekSseEvent(event))) break;
    }
    if (!accumulator.done) {
      for (const event of reader.end()) {
        if (accumulator.push(parseDeepSeekSseEvent(event))) break;
      }
    }
    return accumulator.finish();
  }

  test("the measured turn assembles the answer, excludes THINK and ends on close", () => {
    const result = run(MEASURED_TURN);
    expect(result.text).toBe("Hi there");
    expect(result.reasoningText).toBe("We reason quietly");
    expect(result.reasoningChars).toBe("We reason quietly".length);
    expect(result.excludedChars).toBe("We reason quietly".length);
    expect(result.fragmentTypes).toEqual(["THINK", "RESPONSE"]);
    expect(result.termination).toBe("close");
    expect(result.clickBehavior).toBe("none");
    expect(result.responseMessageId).toBe("message-fixture");
    expect(result.requestMessageId).toBe("request-fixture");
    expect(result.modelType).toBe("default");
    expect(result.sessionUpdated).toBe(true);
    expect(result.controlFrames).toMatchObject({ update_session: 1, title: 1 });
    expect(result.frames).toBe(13);
  });

  test("the recorded BATCH is applied at the path it is rooted on", () => {
    const parser = new DeepSeekDeltaParser();
    const resolved = parser.parse({
      p: "response", o: "BATCH", v: [{ p: "status", v: "FINISHED" }, { p: "accumulated_token_usage", v: 7 }],
    });
    // The batch re-rooted `status` under `response`; the old absolute reading produced a root `status`.
    expect(resolved.map(patch => patch.path)).toEqual([
      "response/status",
      "response/accumulated_token_usage",
    ]);
  });

  test("update_session mid-stream changes nothing about the content and does not terminate", () => {
    const result = run([
      delta("response/fragments/0", "SET", { type: "RESPONSE", content: "" }),
      delta("response/fragments/0/content", "APPEND", "before "),
      named("update_session", { updated_at: 1_700_000_000 }),
      delta("response/fragments/0/content", "APPEND", "after"),
      named("finish", {}),
    ].join(""));
    expect(result.text).toBe("before after");
    expect(result.sessionUpdated).toBe(true);
    expect(result.controlFrames["update_session"]).toBe(1);
    expect(result.termination).toBe("finish");
  });

  test("each terminator is distinguishable, and the measured turn uses close", () => {
    const body = [
      delta("response/fragments/0", "SET", { type: "RESPONSE", content: "" }),
      delta("response/fragments/0/content", "APPEND", "Hello"),
    ];
    const finish = run([...body, named("finish", {})].join(""));
    expect(finish.termination).toBe("finish");
    const close = run([...body, named("close", { click_behavior: "none" })].join(""));
    expect(close.termination).toBe("close");
    expect(close.clickBehavior).toBe("none");
    // A stream that simply stops is its own signal.
    const ended = run(body.join(""));
    expect(ended.termination).toBe("stream_end");
    expect(DEEPSEEK_TERMINATIONS).toEqual(["finish", "close", "stream_end", "error"]);
  });

  test("an in-band envelope error terminates and is never empty successful text", () => {
    const topLevel = run(`event: delta\ndata: ${JSON.stringify({ code: 40003, msg: "INVALID_TOKEN" })}\n\n`);
    expect(topLevel.termination).toBe("error");
    expect(topLevel.error).toMatchObject({ code: 40003, msg: "INVALID_TOKEN" });
    // The nested business layer is read too (recon §2.2).
    const nested = run(`data: ${JSON.stringify({ code: 0, data: { biz_code: 40003, biz_msg: "INVALID_TOKEN" } })}\n\n`);
    expect(nested.termination).toBe("error");
    expect(nested.error).toMatchObject({ bizCode: 40003, bizMsg: "INVALID_TOKEN" });
  });

  test("toast, hint and title are control frames, not content", () => {
    const result = run([
      delta("response/fragments/0", "SET", { type: "RESPONSE", content: "answer" }),
      named("toast", { type: "info", content: "synthetic" }),
      named("hint", { type: "tip", content: "synthetic" }),
      named("title", { title: "synthetic" }),
      named("finish", {}),
    ].join(""));
    expect(result.text).toBe("answer");
    expect(result.controlFrames).toMatchObject({ toast: 1, hint: 1, title: 1 });
  });

  test("a delta that arrives after a terminal signal is ignored", () => {
    const accumulator = createDeepSeekCompletionAccumulator();
    accumulator.push(parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0", o: "SET", v: { type: "RESPONSE", content: "" },
    }) }));
    accumulator.push(parseDeepSeekSseEvent({ event: "finish", data: "{}" }));
    const late = parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0/content", o: "APPEND", v: "late",
    }) });
    expect(accumulator.push(late)).toBe(true);
    expect(accumulator.finish().text).toBe("");
  });

  test("THINK is counted as reasoning, never returned; a THINK-only turn has no answer", () => {
    const result = run([
      delta("response/fragments/0", "SET", { type: "THINK", content: "only a thought" }),
      named("close", { click_behavior: "none" }),
    ].join(""));
    expect(result.text).toBe("");
    expect(result.reasoningText).toBe("only a thought");
    expect(result.reasoningChars).toBe("only a thought".length);
    expect(result.unattributedText).toBe("");
    expect(result.fragmentTypes).toEqual(["THINK"]);
  });

  test("an unmodelled fragment type is reported as unattributed, not as the answer", () => {
    const result = run([
      delta("response/fragments/0", "SET", { type: "SEARCH", content: "only a card" }),
      named("finish", {}),
    ].join(""));
    expect(result.text).toBe("");
    expect(result.unattributedText).toBe("only a card");
    expect(result.fragmentTypes).toEqual(["SEARCH"]);
  });

  test("streamed text is the incremental suffix, and a rewrite is counted", () => {
    const assembled: string[] = [];
    const accumulator = createDeepSeekCompletionAccumulator({ onText: text => assembled.push(text) });
    accumulator.push(parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0", o: "SET", v: { type: "RESPONSE", content: "" },
    }) }));
    accumulator.push(parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0/content", o: "APPEND", v: "Hel",
    }) }));
    accumulator.push(parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0/content", o: "APPEND", v: "lo",
    }) }));
    expect(assembled).toEqual(["Hel", "lo"]);
    // A SET that *extends* what was already streamed is indistinguishable from an APPEND of the
    // suffix, so only the suffix is sent.
    accumulator.push(parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0/content", o: "SET", v: "Hello there",
    }) }));
    expect(assembled).toEqual(["Hel", "lo", " there"]);
    // A SET that replaces it cannot be unsaid: it is counted, not retracted.
    accumulator.push(parseDeepSeekSseEvent({ event: "delta", data: JSON.stringify({
      p: "response/fragments/0/content", o: "SET", v: "Goodbye",
    }) }));
    const result = accumulator.finish();
    expect(result.rewrites).toBe(1);
    expect(result.text).toBe("Goodbye");
  });
});
