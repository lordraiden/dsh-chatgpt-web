import { describe, expect, test } from "bun:test";

import {
  QWEN_CODE_COMPLETIONS_PATH,
  QWEN_CODE_DEFAULT_MODEL,
  QWEN_CODE_TASK_NEW_PATH,
  QwenSseParser,
  createQwenCompletionAccumulator,
  parseQwenSsePayload,
  qwenCodeCompletionRequest,
  runQwenNetworkTurn,
  type QwenSseFrame,
  type QwenTurnRequestFacility,
} from "../src/adapters/qwen-code";
import { isWebChatError } from "../src/web-chat/core";

/**
 * Issue #299, slice 1 — the Qwen Code completion vocabulary and the one-turn round trip.
 *
 * Browser-free by construction: the transport is a fixture. The fixture reproduces the **recorded
 * shape** of a real task stream (frame kinds, key names, role/status/phase vocabulary) with entirely
 * synthetic content, so no captured prompt, id or credential appears in this file.
 */

/** One synthetic assistant delta. */
function assistantDelta(content: string, status = "typing", phase = "code_working"): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { role: "assistant", content, phase, status, extra: {} } }],
    response_id: "response-fixture",
    usage: {},
    timestamp: 1_792_000_000,
  })}`;
}

/** One synthetic `function` (agent environment) delta — never the answer, never terminal. */
function functionDelta(content: string, status: "typing" | "finished"): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        role: "function",
        content,
        phase: "code_working",
        status,
        extra: { function: { function_id: "create_env", status: "running", function_type: "Shell" } },
      },
    }],
    response_id: "response-fixture",
    usage: {},
    timestamp: 1_792_000_000,
  })}`;
}

const CREATED = `data: ${JSON.stringify({
  "response.created": { chat_id: "chat-fixture", parent_id: "parent-fixture", response_id: "response-fixture" },
})}`;

const KEEP_ALIVE = `data: ${JSON.stringify({
  "response.info": { action: "keep_alive", chat_id: "chat-fixture", response_id: "response-fixture", timestamp: 1 },
})}`;

/** A streamed answer whose phases interleave the agent's own environment progress. */
function streamBody(terminator: string | undefined): string {
  return [
    CREATED,
    "",
    functionDelta("Synthetic environment bootstrap", "typing"),
    "",
    KEEP_ALIVE,
    "",
    functionDelta("Synthetic environment ready", "finished"),
    "",
    assistantDelta("Hello", "typing", "think"),
    "",
    assistantDelta(" from", "typing", "think"),
    "",
    assistantDelta(" the recorded shape."),
    "",
    ...(terminator === undefined ? ["", ""] : [terminator, "", ""]),
  ].join("\n");
}

const TERMINATORS = {
  deltaStatus: `data: ${JSON.stringify({
    choices: [{ delta: { role: "assistant", content: "", phase: "code_working", status: "finished", extra: {} } }],
    response_id: "response-fixture",
    usage: {},
    timestamp: 1_792_000_003,
  })}`,
  responseInfo: `data: ${JSON.stringify({
    "response.info": {
      action: "finished",
      chat_id: "chat-fixture",
      response_id: "response-fixture",
      timestamp: 1_792_000_003,
    },
  })}`,
} as const;

describe("issue #299 — the SSE frame vocabulary", () => {
  test("the three recorded frame kinds are classified structurally", () => {
    const created = parseQwenSsePayload(CREATED.slice("data: ".length));
    expect(created).toEqual({
      kind: "created",
      chatId: "chat-fixture",
      parentId: "parent-fixture",
      responseId: "response-fixture",
    });

    const delta = parseQwenSsePayload(assistantDelta("text").slice("data: ".length));
    expect(delta).toMatchObject({ kind: "delta", role: "assistant", content: "text", status: "typing", phase: "code_working" });

    const info = parseQwenSsePayload(KEEP_ALIVE.slice("data: ".length));
    expect(info).toMatchObject({ kind: "info", action: "keep_alive" });
  });

  test("an unmodelled payload is reported, not guessed and not fatal", () => {
    expect(parseQwenSsePayload("[DONE]")).toEqual({ kind: "unknown", payload: "[DONE]" });
    expect(parseQwenSsePayload("{}")).toEqual({ kind: "unknown", payload: "{}" });
    expect(parseQwenSsePayload("   ")).toEqual({ kind: "unknown", payload: "" });
  });

  test("chunk boundaries are irrelevant: a byte-at-a-time feed yields the same frames", () => {
    const body = streamBody(TERMINATORS.deltaStatus);
    const whole = new QwenSseParser();
    const expected = [...whole.push(body), ...whole.end()];
    expect(expected.length).toBeGreaterThan(5);

    const chunked = new QwenSseParser();
    const actual: QwenSseFrame[] = [];
    for (const character of body) actual.push(...chunked.push(character));
    actual.push(...chunked.end());
    expect(actual).toEqual(expected);
  });

  test("a CRLF pair split across two chunks is still one line ending", () => {
    const parser = new QwenSseParser();
    const body = `${CREATED}\r\n\r\n${assistantDelta("split")}\r\n\r\n`;
    const frames: QwenSseFrame[] = [];
    for (const chunk of [body.slice(0, 40), body.slice(40, 41), body.slice(41)]) frames.push(...parser.push(chunk));
    frames.push(...parser.end());
    expect(frames.map(frame => frame.kind)).toEqual(["created", "delta"]);
  });

  test("a CRLF stream and a final event without its blank line are both parsed", () => {
    const crlf = new QwenSseParser();
    const frames = crlf.push(`${CREATED}\r\n\r\n${assistantDelta("x").slice("data: ".length)}`);
    expect(frames.map(frame => frame.kind)).toEqual(["created"]);
    // The trailing `data:`-less fragment is not an event; an explicit end flushes only real events.
    crlf.end();

    const flush = new QwenSseParser();
    flush.push(assistantDelta("tail"));
    expect(flush.end().map(frame => frame.kind)).toEqual(["delta"]);
  });
});

describe("issue #299 — the three termination signals are distinguishable", () => {
  function resultFor(terminator: string | undefined) {
    const parser = new QwenSseParser();
    const accumulator = createQwenCompletionAccumulator();
    const body = streamBody(terminator);
    for (const frame of parser.push(body)) {
      if (accumulator.push(frame)) break;
    }
    if (!accumulator.done) {
      for (const frame of parser.end()) {
        if (accumulator.push(frame)) break;
      }
    }
    return accumulator.finish();
  }

  test("delta_status: a non-typing assistant delta ends the turn", () => {
    const result = resultFor(TERMINATORS.deltaStatus);
    expect(result.termination).toBe("delta_status");
    expect(result.terminalStatus).toBe("finished");
    expect(result.text).toBe("Hello from the recorded shape.");
    expect(result.chatId).toBe("chat-fixture");
    expect(result.responseId).toBe("response-fixture");
  });

  test("response_info: a non-keep_alive control frame ends the turn", () => {
    const result = resultFor(TERMINATORS.responseInfo);
    expect(result.termination).toBe("response_info");
    expect(result.terminalAction).toBe("finished");
    expect(result.text).toBe("Hello from the recorded shape.");
  });

  test("stream_end: a stream that stops while still typing ends on the stream itself", () => {
    const result = resultFor(undefined);
    expect(result.termination).toBe("stream_end");
    expect(result.text).toBe("Hello from the recorded shape.");
  });

  test("a function-role delta leaving typing never ends the turn and never enters the answer", () => {
    const result = resultFor(TERMINATORS.deltaStatus);
    expect(result.text).not.toContain("Synthetic environment");
    expect(result.termination).toBe("delta_status");

    const includeEnvironment = (() => {
      const parser = new QwenSseParser();
      const accumulator = createQwenCompletionAccumulator({ includeFunctionOutput: true });
      for (const frame of parser.push(streamBody(TERMINATORS.deltaStatus))) {
        if (accumulator.push(frame)) break;
      }
      return accumulator.finish();
    })();
    expect(includeEnvironment.text).toContain("Synthetic environment bootstrap");
  });

  test("a keep_alive control frame is never a termination", () => {
    const parser = new QwenSseParser();
    const accumulator = createQwenCompletionAccumulator();
    const frames = parser.push(streamBody(TERMINATORS.deltaStatus));
    // A keep_alive arrives in the middle of this body; the loop must still end on the delta status.
    for (const frame of frames) if (accumulator.push(frame)) break;
    expect(accumulator.finish()).toMatchObject({ termination: "delta_status" });
  });
});

describe("issue #299 — the one-turn round trip over a recorded-shape stream", () => {
  interface Recorded {
    readonly paths: string[];
    readonly bodies: unknown[];
    readonly stopSignals: boolean[];
  }

  function fixture(options: {
    terminator?: string | undefined;
    createBody?: unknown;
    createStatus?: number;
    streamBodyText?: string;
    streamContentType?: string;
    streamStatus?: number;
  } = {}): { readonly request: QwenTurnRequestFacility; readonly seen: Recorded } {
    const seen: Recorded = { paths: [], bodies: [], stopSignals: [] };
    const body = options.streamBodyText ?? streamBody(options.terminator);
    return {
      seen,
      request: {
        async postJson(path, payload) {
          seen.paths.push(path);
          seen.bodies.push(payload);
          return {
            status: options.createStatus ?? 200,
            body: options.createBody ?? { success: true, request_id: "request-fixture", data: { id: "chat-fixture" } },
          };
        },
        async postEventStream(path, payload, onChunk) {
          seen.paths.push(path);
          seen.bodies.push(payload);
          const chunks: string[] = [];
          // Six uneven chunks, so a delta landing on a boundary is exercised by the real parser.
          for (let index = 0; index < body.length; index += 53) chunks.push(body.slice(index, index + 53));
          for (const chunk of chunks) seen.stopSignals.push(onChunk(chunk));
          return {
            status: options.streamStatus ?? 200,
            contentType: options.streamContentType ?? "text/event-stream; charset=utf-8",
            ...(options.streamBodyText === undefined ? {} : { bodyText: options.streamBodyText }),
          };
        },
      },
    };
  }

  test("task/new + completions produce text and report the signal that ended the stream", async () => {
    const { request, seen } = fixture({ terminator: TERMINATORS.deltaStatus });
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    let cursor = 0;
    const result = await runQwenNetworkTurn({
      request,
      prompt: "Reply with a short greeting.",
      now: () => 1_792_000_000_500,
      newId: () => ids[cursor++] ?? "00000000-0000-4000-8000-0000000000ff",
    });

    expect(result.text).toBe("Hello from the recorded shape.");
    expect(result.termination).toBe("delta_status");
    expect(result.terminalStatus).toBe("finished");
    expect(result.chatId).toBe("chat-fixture");
    expect(result.responseId).toBe("response-fixture");
    expect(result.model).toBe(QWEN_CODE_DEFAULT_MODEL);
    // The reader was told to stop as soon as the terminal frame arrived.
    expect(seen.stopSignals.some(Boolean)).toBe(true);

    expect(seen.paths).toEqual([
      QWEN_CODE_TASK_NEW_PATH,
      `${QWEN_CODE_COMPLETIONS_PATH}?chat_id=chat-fixture`,
    ]);
    // The chat-creation body is the captured shape, not an invented one.
    expect(seen.bodies[0]).toEqual({
      chatId: "",
      models: [QWEN_CODE_DEFAULT_MODEL],
      chat_type: "code",
      title: "New Chat",
      chat_mode: "normal",
      timestamp: 1_792_000_000_500,
      sub_chat_type: "web_dev",
    });
    expect(seen.bodies[1]).toEqual(qwenCodeCompletionRequest({
      chatId: "chat-fixture",
      prompt: "Reply with a short greeting.",
      model: QWEN_CODE_DEFAULT_MODEL,
      timestampSeconds: 1_792_000_000,
      messageId: "00000000-0000-4000-8000-000000000001",
      assistantId: "00000000-0000-4000-8000-000000000002",
    }));
  });

  test("the completion body keeps the captured message shape and carries only the new text", () => {
    const request = qwenCodeCompletionRequest({
      chatId: "chat-fixture",
      prompt: "only this text",
      model: QWEN_CODE_DEFAULT_MODEL,
      timestampSeconds: 1_792_000_000,
      messageId: "00000000-0000-4000-8000-000000000002",
      assistantId: "00000000-0000-4000-8000-000000000003",
    });
    expect(request).toMatchObject({
      stream: true,
      version: "2.1",
      incremental_output: true,
      chatId: "chat-fixture",
      chat_id: "chat-fixture",
      parentId: "",
      parent_id: null,
      chat_mode: "normal",
      model: QWEN_CODE_DEFAULT_MODEL,
      timestamp: 1_792_000_000,
    });
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({
      id: null,
      fid: "00000000-0000-4000-8000-000000000002",
      childrenIds: ["00000000-0000-4000-8000-000000000003"],
      role: "user",
      content: "only this text",
      user_action: "chat",
      files: [],
      chat_type: "code",
      sub_chat_type: "web_dev",
      model: "",
      extra: { meta: { subChatType: "web_dev" } },
      feature_config: { thinking_enabled: false, output_schema: "phase" },
    });
  });

  test("stream_end is reported when the answer just stops", async () => {
    const { request } = fixture({ terminator: undefined });
    const result = await runQwenNetworkTurn({ request, prompt: "x" });
    expect(result.termination).toBe("stream_end");
    expect(result.text).toBe("Hello from the recorded shape.");
  });

  test("response_info is reported when the service closes the turn with a control frame", async () => {
    const { request } = fixture({ terminator: TERMINATORS.responseInfo });
    const result = await runQwenNetworkTurn({ request, prompt: "x" });
    expect(result.termination).toBe("response_info");
    expect(result.terminalAction).toBe("finished");
  });

  test("an anonymous task creation is a typed AUTH_REQUIRED refusal, never empty text", async () => {
    const { request } = fixture({
      createBody: { success: false, request_id: "request-fixture", data: { code: "Unauthorized", details: "401 Unauthorized" } },
    });
    const failure = await runQwenNetworkTurn({ request, prompt: "x" }).catch(error => error);
    expect(isWebChatError(failure)).toBe(true);
    expect((failure as { category?: string }).category).toBe("AUTH_REQUIRED");
    expect((failure as { providerCode?: string }).providerCode).toBe("QWEN_SESSION_UNAUTHORIZED");
    expect((failure as { providerId?: string }).providerId).toBe("qwen-code");
  });

  test("a non-stream refusal is a typed upstream failure, never empty text", async () => {
    const { request } = fixture({
      streamBodyText: "<html>portal error</html>",
      streamContentType: "text/html",
    });
    const failure = await runQwenNetworkTurn({ request, prompt: "x" }).catch(error => error);
    expect(isWebChatError(failure)).toBe(true);
    expect((failure as { category?: string }).category).toBe("UPSTREAM_ERROR");
    expect((failure as { providerCode?: string }).providerCode).toBe("QWEN_COMPLETION_REFUSED");
  });

  test("an HTTP refusal to create a chat is typed and keeps the status out of the payload", async () => {
    const { request } = fixture({ createStatus: 401, createBody: { success: false } });
    const failure = await runQwenNetworkTurn({ request, prompt: "x" }).catch(error => error);
    expect((failure as { category?: string }).category).toBe("AUTH_REQUIRED");
    expect((failure as { providerCode?: string }).providerCode).toBe("QWEN_SESSION_UNAUTHORIZED");
  });

  test("a chat id that never comes back is a typed failure, not a guessed id", async () => {
    const { request } = fixture({ createBody: { success: true, request_id: "r", data: {} } });
    const failure = await runQwenNetworkTurn({ request, prompt: "x" }).catch(error => error);
    expect((failure as { category?: string }).category).toBe("UPSTREAM_ERROR");
    expect((failure as { providerCode?: string }).providerCode).toBe("QWEN_TASK_CREATE_INVALID");
  });

  test("a transport rejection while creating the chat is a typed transport failure", async () => {
    const request: QwenTurnRequestFacility = {
      async postJson() { throw new Error("connect ECONNREFUSED at https://coder.qwen.ai/?code=abc"); },
      async postEventStream() { throw new Error("must not be reached"); },
    };
    const failure = await runQwenNetworkTurn({ request, prompt: "x" }).catch(error => error);
    expect((failure as { category?: string }).category).toBe("TRANSPORT_UNAVAILABLE");
    expect((failure as { providerCode?: string }).providerCode).toBe("QWEN_TASK_CREATE_TRANSPORT");
    // The failure is a diagnostic, not a place a URL query can ride along.
    expect((failure as Error).message).toContain("[url]");
    expect((failure as Error).message).not.toContain("abc");
  });

  test("a transport rejection while streaming is a typed transport failure", async () => {
    const request: QwenTurnRequestFacility = {
      async postJson() { return { status: 200, body: { success: true, data: { id: "chat-fixture" } } }; },
      async postEventStream() { throw new Error("stream reset"); },
    };
    const failure = await runQwenNetworkTurn({ request, prompt: "x" }).catch(error => error);
    expect((failure as { category?: string }).category).toBe("TRANSPORT_UNAVAILABLE");
    expect((failure as { providerCode?: string }).providerCode).toBe("QWEN_COMPLETION_TRANSPORT");
  });

  test("empty prompt or model is refused before any request is made", async () => {
    const { request, seen } = fixture({});
    await expect(runQwenNetworkTurn({ request, prompt: "   " })).rejects.toBeInstanceOf(TypeError);
    await expect(runQwenNetworkTurn({ request, prompt: "x", model: " " })).rejects.toBeInstanceOf(TypeError);
    expect(seen.paths).toEqual([]);
  });
});
