import { describe, expect, test } from "bun:test";

import {
  QWEN_CHAT_TERMINATIONS,
  QwenChatSseParser,
  createQwenChatCompletionAccumulator,
  parseQwenChatSsePayload,
  type QwenChatSseFrame,
} from "../src/adapters/qwen-chat";

/**
 * The `chat.qwen.ai` completion vocabulary — recorded shape, synthetic content.
 *
 * Frames, keys and enums come from `doc/provider-recon.md` §1.4; every value here is synthetic, and
 * no captured prompt, id or credential appears in this file.
 */

/** One `data:` line for a payload. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

const CREATED = frame({
  "response.created": {
    chat_id: "chat-fixture",
    parent_id: "parent-fixture",
    response_id: "response-fixture",
    response_index: 1,
  },
});

const KEEP_ALIVE = frame({
  choices: [{
    delta: { role: "assistant", content: "", phase: "KeepAlive", status: "typing", extra: {} },
  }],
  response_id: "response-fixture",
  timestamp: 1,
});

const SKIP_THINK = frame({
  "response.info": { action: "skip_think", response_id: "response-fixture" },
});

const SOURCES = frame({
  sources: [{ title: "synthetic", url: "https://example.invalid/" }],
  choices: [{ delta: { role: "assistant" } }],
  response_id: "response-fixture",
});

const REROUTED = frame({
  selected_model_id: "qwen3.8-max",
  choices: [{ delta: { role: "assistant" } }],
  response_id: "response-fixture",
});

/** One assistant delta. */
function delta(content: string, input: { status?: string; phase?: string; role?: string } = {}): string {
  return frame({
    choices: [{
      delta: {
        role: input.role ?? "assistant",
        content,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
        ...(input.status === undefined ? {} : { status: input.status }),
        extra: {},
      },
    }],
    response_id: "response-fixture",
    timestamp: 2,
  });
}

/** An assistant delta that closes the turn, in each of the recorded shapes. */
const TERMINATORS = {
  deltaStatus: delta("", { phase: "answer", status: "finished" }),
  responseStopped: frame({ "response.stopped": { response_id: "response-fixture" } }),
  done: "data: [DONE]",
} as const;

/** A stream body: created, keep-alive, skip_think, two content deltas, then the given terminator. */
function streamBody(terminator?: string): string {
  return [
    CREATED,
    KEEP_ALIVE,
    SKIP_THINK,
    delta("Hello", { phase: "answer", status: "typing" }),
    delta(" from", { phase: "answer", status: "typing" }),
    delta(" the recorded shape.", { phase: "answer", status: "typing" }),
    ...(terminator === undefined ? [] : [terminator]),
    "",
    "",
  ].join("\n\n");
}

describe("issue #333 — Qwen Chat SSE frames are classified structurally", () => {
  test("the recorded frame kinds parse", () => {
    expect(parseQwenChatSsePayload(CREATED.slice("data: ".length))).toEqual({
      kind: "created",
      chatId: "chat-fixture",
      parentId: "parent-fixture",
      responseId: "response-fixture",
      responseIndex: 1,
    });
    expect(parseQwenChatSsePayload(delta("text", { status: "typing", phase: "answer" }).slice("data: ".length)))
      .toMatchObject({ kind: "delta", role: "assistant", content: "text", status: "typing", phase: "answer" });
    expect(parseQwenChatSsePayload(SKIP_THINK.slice("data: ".length)))
      .toMatchObject({ kind: "info", action: "skip_think" });
    expect(parseQwenChatSsePayload(TERMINATORS.responseStopped.slice("data: ".length)))
      .toMatchObject({ kind: "stopped", responseId: "response-fixture" });
    expect(parseQwenChatSsePayload(TERMINATORS.done.slice("data: ".length))).toEqual({ kind: "done" });
    expect(parseQwenChatSsePayload(SOURCES.slice("data: ".length))).toMatchObject({ kind: "sources" });
    expect(parseQwenChatSsePayload(REROUTED.slice("data: ".length))).toEqual({
      kind: "selected_model",
      selectedModelId: "qwen3.8-max",
      responseId: "response-fixture",
    });
  });

  test("an in-band error frame is surfaced, never turned into empty text", () => {
    expect(parseQwenChatSsePayload(frame({ error: { code: "rate_limited", message: "slow down" }, response_id: "r" })
      .slice("data: ".length))).toEqual({
      kind: "error",
      responseId: "r",
      code: "rate_limited",
      message: "slow down",
    });
  });

  test("an unmodelled payload is reported, not guessed and not fatal", () => {
    expect(parseQwenChatSsePayload("{}")).toMatchObject({ kind: "unknown" });
    expect(parseQwenChatSsePayload("not json")).toEqual({ kind: "unknown", payload: "not json" });
  });

  test("chunk boundaries are irrelevant: a byte-at-a-time feed yields the same frames", () => {
    const body = streamBody(TERMINATORS.done);
    const whole = new QwenChatSseParser();
    const expected = [...whole.push(body), ...whole.end()];
    expect(expected.length).toBeGreaterThan(5);

    const chunked = new QwenChatSseParser();
    const actual: QwenChatSseFrame[] = [];
    for (const character of body) actual.push(...chunked.push(character));
    actual.push(...chunked.end());
    expect(actual).toEqual(expected);
  });

  test("a CRLF pair split across two chunks is still one line ending", () => {
    const parser = new QwenChatSseParser();
    const body = `${CREATED}\r\n\r\n${delta("split")}\r\n\r\n`;
    const frames: QwenChatSseFrame[] = [];
    for (const chunk of [body.slice(0, 40), body.slice(40, 41), body.slice(41)]) frames.push(...parser.push(chunk));
    frames.push(...parser.end());
    expect(frames.map(item => item.kind)).toEqual(["created", "delta"]);
  });
});

describe("issue #333 — the answer, KeepAlive and the model re-route", () => {
  test("content deltas concatenate in order; KeepAlive is not content and never terminates", () => {
    const accumulator = createQwenChatCompletionAccumulator();
    const parser = new QwenChatSseParser();
    for (const item of parser.push(streamBody(TERMINATORS.deltaStatus))) accumulator.push(item);
    for (const item of parser.end()) accumulator.push(item);
    const result = accumulator.finish();
    expect(result.text).toBe("Hello from the recorded shape.");
    expect(result.termination).toBe("delta_status");
    expect(result.terminalStatus).toBe("finished");
    expect(result.chatId).toBe("chat-fixture");
    expect(result.parentId).toBe("parent-fixture");
    expect(result.responseId).toBe("response-fixture");
  });

  test("a KeepAlive delta carrying text is still ignored", () => {
    const accumulator = createQwenChatCompletionAccumulator();
    accumulator.push(parseQwenChatSsePayload(
      frame({
        choices: [{ delta: { role: "assistant", content: "KEEP-ALIVE-TEXT", phase: "KeepAlive", status: "finished" } }],
      }).slice("data: ".length),
    ));
    expect(accumulator.done).toBe(false);
    expect(accumulator.finish().text).toBe("");
    expect(accumulator.finish().termination).toBe("stream_end");
  });

  test("every recorded terminator is distinguishable", () => {
    const cases: readonly { readonly frame: QwenChatSseFrame; readonly termination: string; readonly done: boolean }[] = [
      { frame: parseQwenChatSsePayload(TERMINATORS.done.slice("data: ".length)), termination: "done", done: true },
      {
        frame: parseQwenChatSsePayload(TERMINATORS.responseStopped.slice("data: ".length)),
        termination: "response_stopped",
        done: true,
      },
      {
        frame: parseQwenChatSsePayload(TERMINATORS.deltaStatus.slice("data: ".length)),
        termination: "delta_status",
        done: true,
      },
    ];
    for (const item of cases) {
      const accumulator = createQwenChatCompletionAccumulator();
      expect(accumulator.push(item.frame)).toBe(true);
      expect(accumulator.finish().termination).toBe(item.termination as never);
      expect(accumulator.done).toBe(item.done);
    }
    // A stream that just stops is its own signal.
    const stopped = createQwenChatCompletionAccumulator();
    stopped.push(parseQwenChatSsePayload(delta("half an answer").slice("data: ".length)));
    expect(stopped.finish().termination).toBe("stream_end");
    expect(QWEN_CHAT_TERMINATIONS).toContain("stream_end");
  });

  test("an in-band error terminates and is not a completed answer", () => {
    const accumulator = createQwenChatCompletionAccumulator();
    expect(accumulator.push(parseQwenChatSsePayload(
      frame({ error: { code: "pow", message: "failed" }, response_id: "r" }).slice("data: ".length),
    ))).toBe(true);
    const result = accumulator.finish();
    expect(result.termination).toBe("error");
    expect(result.error?.code).toBe("pow");
  });

  test("selected_model_id is surfaced and never rewrites the answer", () => {
    const accumulator = createQwenChatCompletionAccumulator();
    accumulator.push(parseQwenChatSsePayload(REROUTED.slice("data: ".length)));
    accumulator.push(parseQwenChatSsePayload(delta("answered by whichever model ran").slice("data: ".length)));
    const result = accumulator.finish();
    expect(result.selectedModelId).toBe("qwen3.8-max");
    expect(result.text).toBe("answered by whichever model ran");
  });

  test("sources and response.info are not content and not terminators", () => {
    const accumulator = createQwenChatCompletionAccumulator();
    accumulator.push(parseQwenChatSsePayload(SOURCES.slice("data: ".length)));
    accumulator.push(parseQwenChatSsePayload(SKIP_THINK.slice("data: ".length)));
    expect(accumulator.done).toBe(false);
    const result = accumulator.finish();
    expect(result.sources).toBe(true);
    expect(result.text).toBe("");
    expect(result.termination).toBe("stream_end");
  });
});
