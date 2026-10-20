import { describe, expect, test } from "bun:test";

import {
  createQwenCodeTextTransport,
  type QwenCodeTurnAnswer,
} from "../src/adapters/qwen-code/text-transport";
import { qwenCodeCompletionRequest, qwenTaskNewRequest } from "../src/adapters/qwen-code/network-turn";
import type { QwenTurnRequestFacility } from "../src/adapters/qwen-code/network-turn";
import type { QwenCodeRequestSession } from "../src/adapters/qwen-code/browser-session";
import type { QwenTurnMessage } from "../src/adapters/qwen-code/network-turn";
import {
  createWebChatExchange,
  createWebChatTransportLeaseRegistry,
  type WebChatExchangeRunner,
} from "../src/web-chat/transport";
import type { WebChatExchangeEvent } from "../src/web-chat/core";
import { QWEN_CODE_COMPLETIONS_PATH, QWEN_CODE_TASK_NEW_PATH } from "../src/adapters/qwen-code/provider";

/**
 * Issue #299, slice 2 — the Qwen Code text transport.
 *
 * Every stream here is a **recorded-shape fixture**: the three frame kinds from the capture
 * (`doc/qwen-code.md` §2), chunked so a frame boundary falls inside a `data:` line. What is asserted
 * is the transport's real reporting — the ordered answer, the termination signal that actually fired,
 * the submission phase it proved and the physical settlement — not a mock's bookkeeping.
 */

/** One `data:` frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The `response.created` frame the real stream opens with. */
function created(chatId: string, parentId = `parent:${chatId}`): string {
  return frame({ "response.created": { chat_id: chatId, parent_id: parentId, response_id: `resp:${chatId}` } });
}

/** One assistant delta frame. */
function delta(content: string, extra: { role?: string; status?: string; phase?: string } = {}): string {
  return frame({
    choices: [{
      delta: {
        role: extra.role ?? "assistant",
        content,
        phase: extra.phase ?? "answer",
        ...(extra.status !== undefined ? { status: extra.status } : {}),
      },
    }],
    response_id: "resp",
    timestamp: 1,
  });
}

/** A `response.info` control frame. */
function info(action: string): string {
  return frame({ "response.info": { action, chat_id: "chat", response_id: "resp", timestamp: 2 } });
}

/** What one controlled network recorded. */
interface Recorded {
  taskNewCalls: number;
  taskNewBodies: Record<string, unknown>[];
  completionPaths: string[];
  completionBodies: Record<string, unknown>[];
  streamOptions: { onOpenSeen: boolean }[];
}

/** A controlled network over one facility: it plays the recorded shapes, in order. */
function network(script: {
  readonly chunks: readonly string[] | ((emit: (chunk: string) => void) => Promise<void>);
  readonly taskNew?: { status: number; body: unknown };
  readonly openStatus?: number;
  readonly openContentType?: string;
  readonly bodyText?: string;
  readonly throwBeforeOpen?: Error;
  readonly throwAfterChunks?: Error;
  readonly onChunk?: (chunk: string, index: number) => void;
}): { facility: QwenTurnRequestFacility; recorded: Recorded; sinks: { late?: (chunk: string) => boolean } } {
  const recorded: Recorded = {
    taskNewCalls: 0,
    taskNewBodies: [],
    completionPaths: [],
    completionBodies: [],
    streamOptions: [],
  };
  const sinks: { late?: (chunk: string) => boolean } = {};
  const facility: QwenTurnRequestFacility = {
    async postJson(path, body) {
      expect(path).toBe(QWEN_CODE_TASK_NEW_PATH);
      recorded.taskNewCalls += 1;
      recorded.taskNewBodies.push(body as Record<string, unknown>);
      const answer = script.taskNew ?? { status: 200, body: { success: true, data: { id: "chat-1" } } };
      return { status: answer.status, body: answer.body };
    },
    async postEventStream(path, body, onChunk, options = {}) {
      recorded.completionPaths.push(path);
      recorded.completionBodies.push(body as Record<string, unknown>);
      const opened = { onOpenSeen: false };
      recorded.streamOptions.push(opened);
      sinks.late = onChunk;
      if (script.throwBeforeOpen) throw script.throwBeforeOpen;
      options.onOpen?.({ status: script.openStatus ?? 200, contentType: script.openContentType ?? "text/event-stream" });
      opened.onOpenSeen = true;
      let index = 0;
      if (typeof script.chunks === "function") {
        await script.chunks(chunk => { script.onChunk?.(chunk, index++); onChunk(chunk); });
      } else {
        for (const chunk of script.chunks) {
          script.onChunk?.(chunk, index++);
          if (onChunk(chunk)) break;
        }
      }
      if (script.throwAfterChunks) throw script.throwAfterChunks;
      return {
        status: script.openStatus ?? 200,
        contentType: script.openContentType ?? "text/event-stream",
        ...(script.bodyText !== undefined ? { bodyText: script.bodyText } : {}),
      };
    },
  };
  return { facility, recorded, sinks };
}

/** A session whose `run` hands the given facility to the turn. */
function sessionWith(facility: QwenTurnRequestFacility, options: { ready?: () => Promise<void> } = {}): QwenCodeRequestSession {
  return {
    id: "issue-299-transport-session",
    ready: options.ready ?? (async () => undefined),
    async run<T>(body: (f: QwenTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(facility);
    },
    async close() {},
  };
}

/** One turn driven through the shared exchange, with everything the transport reported. */
async function runTurn(input: {
  readonly facility: QwenTurnRequestFacility;
  readonly session?: QwenCodeRequestSession;
  readonly chat?: { chatId: string; parentId?: string };
  readonly ephemeral?: boolean;
  readonly userText?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly events: WebChatExchangeEvent[];
  readonly answer?: QwenCodeTurnAnswer;
  readonly exchange: WebChatExchangeRunner;
  readonly error?: unknown;
}> {
  const answers: QwenCodeTurnAnswer[] = [];
  const session = input.session ?? sessionWith(input.facility);
  const transport = createQwenCodeTextTransport({
    session,
    model: input.model ?? "qwen3-coder-plus",
    ...(input.chat ? { chat: input.chat } : {}),
    ...(input.ephemeral ? { ephemeral: true } : {}),
    onAnswer: answer => { answers.push(answer); },
    onDiagnostic: () => undefined,
  });
  const leases = createWebChatTransportLeaseRegistry();
  const conversationKey = input.ephemeral ? "ephemeral:turn" : "conversation:key";
  const exchange = createWebChatExchange({
    identity: {
      bindingId: "binding",
      conversationKey,
      turnId: "turn-id",
      ...(input.ephemeral ? {} : {}),
    },
    turn: { userText: input.userText ?? "hola", model: input.model ?? "qwen3-coder-plus" },
    transport,
    leases,
    epoch: 1,
    createResource: async () => ({ id: `resource:${conversationKey}`, conversationKey, epoch: 1 }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const events: WebChatExchangeEvent[] = [];
  let error: unknown;
  try {
    await exchange.prepare();
    await exchange.submit();
    for await (const event of exchange.stream()) events.push(event);
  } catch (thrown) {
    error = thrown;
  }
  await exchange.awaitSettlement().catch(() => undefined);
  return {
    events,
    ...(answers.length > 0 ? { answer: answers[0]! } : {}),
    exchange,
    ...(error !== undefined ? { error } : {}),
  };
}

describe("issue #299 — Qwen Code text transport: the recorded stream vocabulary", () => {
  test("the answer arrives in order, chunked across frame boundaries, and reports the signal that ended it", async () => {
    // The answer is split mid-`data:` line on purpose: the parser must not assume chunk == frame.
    const full = [
      created("chat-1"),
      delta("¡Hol"),
      delta("a!"),
      delta("", { status: "finished" }),
    ].join("");
    const chunks = [full.slice(0, 12), full.slice(12, 60), full.slice(60)];
    const { facility, recorded } = network({ chunks });

    const run = await runTurn({ facility });

    expect(run.error).toBeUndefined();
    const text = run.events
      .filter((event): event is Extract<WebChatExchangeEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map(event => event.text)
      .join("");
    expect(text).toBe("¡Hola!");
    expect(run.events.at(-1)?.type).toBe("completed");
    expect(run.answer?.text).toBe("¡Hola!");
    // The three termination signals are separate; this fixture closes on `delta.status`.
    expect(run.answer?.termination).toBe("delta_status");
    expect(run.answer?.frames).toBe(4);
    // The client-generated ids are the app's own convention, and the chat id is in the query string.
    const body = recorded.completionBodies[0]!;
    expect(body["chat_id"]).toBe("chat-1");
    expect(body["chatId"]).toBe("chat-1");
    expect(recorded.completionPaths[0]).toBe(`${QWEN_CODE_COMPLETIONS_PATH}?chat_id=chat-1`);
    const message = (body["messages"] as QwenTurnMessage[])[0]!;
    expect(message.content).toBe("hola");
    expect(message.childrenIds).toHaveLength(1);
    // A first turn of a fresh chat has no parent cursor, exactly like the captured body.
    expect(body["parentId"]).toBe("");
    expect(body["parent_id"]).toBeNull();
    // `task/new` is the recorded shape, with the provider-local model in its `models` list.
    expect(recorded.taskNewBodies[0]!["models"]).toEqual(["qwen3-coder-plus"]);
    expect(recorded.taskNewBodies[0]!["chatId"]).toBe("");
    expect(recorded.taskNewBodies[0]!["chat_type"]).toBe("code");
  });

  test("role:function chatter is excluded and can never end the turn", async () => {
    const { facility } = network({
      chunks: [
        created("chat-1"),
        // The agent environment's own progress: not the model's answer, and `finished` here must not
        // terminate the turn.
        delta("Initializing environment…", { role: "function", status: "finished" }),
        delta("The answer", { status: "typing" }),
        delta(" is this", { status: "typing" }),
        // The turn itself closes on a non-function delta leaving `typing`.
        delta("", { status: "finished" }),
        // Everything after the terminal signal is ignored, whatever it says.
        delta("too late"),
      ],
    });

    const run = await runTurn({ facility });

    expect(run.answer?.text).toBe("The answer is this");
    expect(run.answer?.termination).toBe("delta_status");
    const text = run.events
      .filter((event): event is Extract<WebChatExchangeEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map(event => event.text)
      .join("");
    expect(text).not.toContain("Initializing environment");
    expect(text).not.toContain("too late");
  });

  test("a response.info action other than keep_alive ends the turn", async () => {
    const { facility } = network({
      chunks: [
        created("chat-1"),
        delta("partial", { status: "typing" }),
        info("keep_alive"),
        delta(" answer", { status: "typing" }),
        info("turn_end"),
      ],
    });

    const run = await runTurn({ facility });

    expect(run.answer?.text).toBe("partial answer");
    expect(run.answer?.termination).toBe("response_info");
    expect(run.answer?.terminalAction).toBe("turn_end");
    expect(run.events.at(-1)?.type).toBe("completed");
  });

  test("a stream that closes with no terminal frame is terminated by the stream's own end", async () => {
    const { facility } = network({
      chunks: [created("chat-1"), delta("an answer that never closed", { status: "typing" })],
    });

    const run = await runTurn({ facility });

    expect(run.answer?.text).toBe("an answer that never closed");
    expect(run.answer?.termination).toBe("stream_end");
    expect(run.events.at(-1)?.type).toBe("completed");
  });

  test("a non-stream answer is a typed refusal, never an empty answer", async () => {
    const { facility } = network({
      chunks: [],
      openStatus: 200,
      openContentType: "text/html; charset=utf-8",
      bodyText: "<!DOCTYPE html><html><head><title>Access Verification</title></head></html>",
    });

    const run = await runTurn({ facility });

    expect(run.events.at(-1)?.type).toBe("error");
    const failure = run.events.at(-1) as Extract<WebChatExchangeEvent, { type: "error" }>;
    expect(failure.error.category).toBe("UPSTREAM_ERROR");
    expect(run.exchange.retrySafety()).toBe("not_retry_safe");
  });
});

describe("issue #299 — Qwen Code text transport: the ephemeral rule", () => {
  test("an ephemeral turn answers without creating a chat and records nothing", async () => {
    const { facility, recorded } = network({
      chunks: [created("generated-chat"), delta("a session title"), delta("", { status: "finished" })],
    });

    const run = await runTurn({ facility, ephemeral: true, userText: "name this session" });

    expect(run.error).toBeUndefined();
    expect(run.events.at(-1)?.type).toBe("completed");
    // The whole point: housekeeping never creates a chat in the operator's account.
    expect(recorded.taskNewCalls).toBe(0);
    expect(recorded.completionBodies[0]!["messages"]).toBeDefined();
    // …and it is never recorded as a conversation this deployment could later continue.
    expect(run.answer).toBeUndefined();
    // The chat id it streamed into is one this process generated, not one the provider handed back.
    const chatId = new URL(recorded.completionPaths[0]!, "https://coder.qwen.ai").searchParams.get("chat_id");
    expect(chatId).not.toBe("chat-1");
    expect(chatId?.length ?? 0).toBeGreaterThan(10);
  });

  test("two ephemeral turns are answered independently and leave no chat behind", async () => {
    const first = network({ chunks: [created("a"), delta("title one"), delta("", { status: "finished" })] });
    const second = network({ chunks: [created("b"), delta("title two"), delta("", { status: "finished" })] });

    const one = await runTurn({ facility: first.facility, ephemeral: true, userText: "one" });
    const two = await runTurn({ facility: second.facility, ephemeral: true, userText: "two" });

    expect(first.recorded.taskNewCalls).toBe(0);
    expect(second.recorded.taskNewCalls).toBe(0);
    const firstChat = new URL(first.recorded.completionPaths[0]!, "https://coder.qwen.ai").searchParams.get("chat_id");
    const secondChat = new URL(second.recorded.completionPaths[0]!, "https://coder.qwen.ai").searchParams.get("chat_id");
    expect(firstChat).not.toBe(secondChat);
    expect(one.answer).toBeUndefined();
    expect(two.answer).toBeUndefined();
  });
});

describe("issue #299 — Qwen Code text transport: authentication and continuity", () => {
  test("an unauthenticated session is refused before anything is sent", async () => {
    const { facility, recorded } = network({ chunks: [] });
    const session = sessionWith(facility, {
      ready: async () => {
        const { webChatError } = await import("../src/web-chat/core");
        throw webChatError(
          "AUTH_REQUIRED",
          "Qwen Code has no verified session on this deployment. Sign in to Qwen Code at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Code\").",
          { providerId: "qwen-code", providerCode: "QWEN_SESSION_MISSING" },
        );
      },
    });

    const run = await runTurn({ facility, session });

    expect(run.error).toBeDefined();
    expect((run.error as { category?: string }).category).toBe("AUTH_REQUIRED");
    // Nothing reached the provider: no chat was created and no completion was attempted.
    expect(recorded.taskNewCalls).toBe(0);
    expect(recorded.completionPaths).toHaveLength(0);
    // Readiness precedes the submission boundary, so the turn is provably retry-safe.
    expect(run.exchange.retrySafety()).toBe("retry_safe");
    expect(run.exchange.snapshot().state).toBe("FAILED");
    // The message is actionable and carries no credential.
    expect((run.error as Error).message).toContain("/v1/control/auth/");
  });

  test("a recorded chat is reused, with the cursor the previous turn ended on", async () => {
    const { facility, recorded } = network({
      chunks: [created("chat-9", "parent:chat-9"), delta("second turn"), delta("", { status: "finished" })],
    });

    const run = await runTurn({ facility, chat: { chatId: "chat-9", parentId: "parent:previous" } });

    expect(run.error).toBeUndefined();
    expect(recorded.taskNewCalls).toBe(0);
    expect(recorded.completionPaths[0]).toBe(`${QWEN_CODE_COMPLETIONS_PATH}?chat_id=chat-9`);
    const body = recorded.completionBodies[0]!;
    expect(body["parentId"]).toBe("parent:previous");
    expect(body["parent_id"]).toBe("parent:previous");
    const message = (body["messages"] as QwenTurnMessage[])[0]!;
    expect(message.parentId).toBe("parent:previous");
    expect(run.answer?.chatId).toBe("chat-9");
    expect(run.answer?.parentId).toBe("parent:chat-9");
  });

  test("a rejected chat is a typed continuity loss, never a silent new chat", async () => {
    const { facility, recorded } = network({
      chunks: [],
      openStatus: 404,
      openContentType: "application/json",
      bodyText: JSON.stringify({ success: false, data: { code: "ChatNotFound" } }),
    });
    const lost: string[] = [];
    const answers: QwenCodeTurnAnswer[] = [];
    const transport = createQwenCodeTextTransport({
      session: sessionWith(facility),
      model: "qwen3-coder-plus",
      chat: { chatId: "chat-gone" },
      onAnswer: answer => { answers.push(answer); },
      onChatLost: reason => { lost.push(reason); },
      onDiagnostic: () => undefined,
    });
    const leases = createWebChatTransportLeaseRegistry();
    const exchange = createWebChatExchange({
      identity: { bindingId: "binding", conversationKey: "conversation:lost", turnId: "turn" },
      turn: { userText: "continue please", model: "qwen3-coder-plus" },
      transport,
      leases,
      epoch: 1,
      createResource: async () => ({ id: "r", conversationKey: "conversation:lost", epoch: 1 }),
    });
    await exchange.prepare();
    await exchange.submit();
    const events: WebChatExchangeEvent[] = [];
    for await (const event of exchange.stream()) events.push(event);
    await exchange.awaitSettlement().catch(() => undefined);

    const failure = events.at(-1) as Extract<WebChatExchangeEvent, { type: "error" }>;
    expect(failure.type).toBe("error");
    expect(failure.error.category).toBe("CONVERSATION_LOST");
    expect(lost).toHaveLength(1);
    // The record keeps the chat and marks it lost: a later turn must rebuild explicitly, never fork.
    expect(answers).toHaveLength(0);
    // The provider was asked to continue the recorded chat and refused it; no new chat was created.
    expect(recorded.taskNewCalls).toBe(0);
    expect(recorded.completionPaths[0]).toBe(`${QWEN_CODE_COMPLETIONS_PATH}?chat_id=chat-gone`);
  });

  test("a chat that cannot be created is retry-safe: the caller's text was never sent", async () => {
    const { facility, recorded } = network({
      chunks: [],
      taskNew: { status: 200, body: { success: false, data: { code: "Unauthorized" } } },
    });

    const run = await runTurn({ facility });

    // The transport reported `prepared` (nothing was sent), so the exchange failed the turn through
    // its stream rather than at the submission boundary — and the failure keeps the provider's
    // category.
    const failure = run.events.at(-1) as Extract<WebChatExchangeEvent, { type: "error" }>;
    expect(failure.type).toBe("error");
    expect(failure.error.category).toBe("AUTH_REQUIRED");
    // `task/new` carries no user text, so failing it proves the turn was never submitted.
    expect(recorded.taskNewCalls).toBe(1);
    expect(recorded.completionPaths).toHaveLength(0);
    expect(run.exchange.retrySafety()).toBe("retry_safe");
  });

  test("the physical settlement is fulfilled once the turn's own stream has ended", async () => {
    const { facility } = network({
      chunks: [created("chat-1"), delta("settled"), delta("", { status: "finished" })],
    });

    const run = await runTurn({ facility });

    expect(await run.exchange.awaitSettlement()).toBe("fulfilled");
    expect(run.events.at(-1)?.type).toBe("completed");
  });
});

describe("issue #299 — Qwen Code request shapes", () => {
  test("the creation and continuation bodies are the captured shapes", () => {
    const create = qwenTaskNewRequest({ model: "qwen3-coder-plus", timestampMs: 1_700_000_000_000 });
    expect(create).toEqual({
      chatId: "",
      models: ["qwen3-coder-plus"],
      chat_type: "code",
      title: "New Chat",
      chat_mode: "normal",
      timestamp: 1_700_000_000_000,
      sub_chat_type: "web_dev",
    });

    const first = qwenCodeCompletionRequest({
      chatId: "chat-1",
      prompt: "hola",
      model: "qwen3-coder-plus",
      timestampSeconds: 1_700_000_000,
      messageId: "message-1",
      assistantId: "assistant-1",
    });
    expect(first.parentId).toBe("");
    expect(first.parent_id).toBeNull();
    expect(first.messages[0]!.childrenIds).toEqual(["assistant-1"]);

    const next = qwenCodeCompletionRequest({
      chatId: "chat-1",
      prompt: "again",
      model: "qwen3-coder-plus",
      timestampSeconds: 1_700_000_100,
      messageId: "message-2",
      assistantId: "assistant-2",
      parentId: "parent-1",
    });
    expect(next.parentId).toBe("parent-1");
    expect(next.parent_id).toBe("parent-1");
    expect(next.messages[0]!.parentId).toBe("parent-1");
  });
});
