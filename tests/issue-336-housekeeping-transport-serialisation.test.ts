import { describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/config";
import type { AdapterEvent } from "../src/types";
import type { QwenTurnRequestFacility } from "../src/adapters/qwen-code/network-turn";
import { createQwenCodeProvider, type QwenCodeProviderComposition } from "../src/adapters/qwen-code/provider-runtime";
import type { QwenCodeRequestSession } from "../src/adapters/qwen-code/browser-session";
import {
  createMemoryQwenCodeConversationState,
  type QwenCodeConversationState,
} from "../src/adapters/qwen-code/chat-state";
import { QWEN_CODE_PROVIDER_ID } from "../src/adapters/qwen-code/provider";
import { createMemoryConversationStore, type WebChatConversationStore } from "../src/web-chat/core";
import {
  createWebChatTransportLeaseRegistry,
  type WebChatTransportLeaseRegistry,
} from "../src/web-chat/transport";

/**
 * Issue #336 — a housekeeping call and a real turn of the same conversation must be **serialised**,
 * not refused.
 *
 * The operator's first real message to `qwen-code/qwen3-coder-plus` failed with
 *
 *   Another exchange still owns this conversation's transport resource
 *
 * because the harness's session-title call reaches this service with **no declared purpose**
 * (`@earendil-works/pi-ai` never maps `GenerateOptions.purpose` onto the OpenAI wire), so the
 * service classifies it as a conversational turn: it takes the conversation's single transport
 * resource, and the user's turn — arriving during that window — is refused by the shared transport
 * lease (`src/web-chat/transport/transport-lease.ts`).
 *
 * The rule the fix must satisfy: **a housekeeping call must never fail a user's turn, and a user's
 * turn must never fail the housekeeping call.** The mechanism is a bounded, event-driven admission
 * wait at the shared transport owner (the same shape the ChatGPT owner already ships in
 * `ChatGPTWebProviderCore.acquireConversationAdmission`), so the second arrival waits instead of
 * being refused. Exclusivity is preserved: two turns of one conversation never run concurrently.
 */
const MODEL_ID = "qwen3-coder-plus";
const MODEL_ROUTE = `${QWEN_CODE_PROVIDER_ID}/${MODEL_ID}`;
const ACCOUNT = "issue-336-account";

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A controlled network whose first completion can be held, so an overlap is deterministic. */
class ControlledNetwork {
  taskNewCalls = 0;
  completionCalls = 0;
  chats = 0;
  maxConcurrentCompletions = 0;
  private inFlight = 0;
  private holdBeforeAnswer = false;
  private release!: () => void;
  private firstStarted!: () => void;
  readonly firstCompletionStarted: Promise<void>;

  constructor() {
    this.firstCompletionStarted = new Promise<void>(resolve => { this.firstStarted = resolve; });
  }

  /** Hold the first completion until {@link open}. */
  holdFirstCompletion(): void {
    this.holdBeforeAnswer = true;
  }

  open(): void {
    this.holdBeforeAnswer = false;
    this.release?.();
  }

  readonly facility: QwenTurnRequestFacility = {
    postJson: async () => {
      this.taskNewCalls += 1;
      await sleep(5);
      this.chats += 1;
      return { status: 200, body: { success: true, data: { id: `chat-${this.chats}` } } };
    },
    postEventStream: async (path, _body, onChunk, options = {}) => {
      this.completionCalls += 1;
      const chatId = new URL(path, "https://coder.qwen.ai").searchParams.get("chat_id") ?? "";
      this.inFlight += 1;
      this.maxConcurrentCompletions = Math.max(this.maxConcurrentCompletions, this.inFlight);
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      onChunk(frame({ "response.created": { chat_id: chatId, parent_id: `p:${chatId}`, response_id: `r:${chatId}` } }));
      this.firstStarted();
      if (this.holdBeforeAnswer) {
        await new Promise<void>(resolve => { this.release = resolve; });
      }
      onChunk(frame({
        choices: [{ delta: { role: "assistant", content: "answer", phase: "answer", status: "typing" } }],
        response_id: `r:${chatId}`,
      }));
      onChunk(frame({
        choices: [{ delta: { role: "assistant", content: "", phase: "answer", status: "finished" } }],
        response_id: `r:${chatId}`,
      }));
      this.inFlight -= 1;
      return { status: 200, contentType: "text/event-stream" };
    },
  } as QwenTurnRequestFacility;
}

/** Mirrors the real session: one page, turns serialised through a queue. */
function serialSession(network: ControlledNetwork): QwenCodeRequestSession {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    id: "issue-336-session",
    async ready() {},
    async run<T>(body: (facility: QwenTurnRequestFacility) => Promise<T>): Promise<T> {
      const turn = queue.then(() => body(network.facility));
      queue = turn.then(() => undefined, () => undefined);
      return await turn;
    },
    async close() {},
  };
}

interface Composition {
  readonly provider: QwenCodeProviderComposition;
  readonly store: WebChatConversationStore;
  readonly state: QwenCodeConversationState;
  readonly network: ControlledNetwork;
}

function composition(): Composition {
  const network = new ControlledNetwork();
  const store = createMemoryConversationStore();
  const state = createMemoryQwenCodeConversationState();
  const provider = createQwenCodeProvider({
    config: {
      ...defaultConfig(),
      webChat: { providers: { [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] } } },
    } as never,
    session: serialSession(network),
    store,
    state,
  });
  return { provider, store, state, network };
}

function body(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly userText: string;
  readonly purpose?: string;
}): Record<string, unknown> {
  return {
    model: MODEL_ROUTE,
    input: [{ type: "message", role: "user", content: [{ type: "text", text: input.userText }] }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        dsh_session_id: input.sessionId,
        thread_id: input.threadId,
        turn_id: input.turnId,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      }),
    },
  };
}

async function runTurn(
  provider: QwenCodeProviderComposition,
  requestBody: Record<string, unknown>,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of provider.turnEvents(provider.resolveTurn(requestBody, new Headers()))) events.push(event);
  return events;
}

const terminalOf = (events: AdapterEvent[]): AdapterEvent | undefined => events.at(-1);

describe("issue #336 — the shared transport admission is a bounded wait, not a refusal", () => {
  test("a second holder waits for the first to settle instead of being refused", async () => {
    const leases = createWebChatTransportLeaseRegistry({ admissionWaitMs: 5_000 });
    await leases.admitConversation({ holder: "title", conversationKey: "c1" });

    let admitted = false;
    const waiting = leases.admitConversation({ holder: "user", conversationKey: "c1" })
      .then(() => { admitted = true; });
    await sleep(10);
    // The second holder has not been refused and has not been admitted: it is waiting.
    expect(admitted).toBe(false);

    leases.releaseConversation("title", "c1");
    await waiting;
    expect(admitted).toBe(true);
    expect(leases.admissionWaiterCount()).toBe(0);
  });

  test("a registry without a bound keeps the historical immediate refusal", async () => {
    // Direct callers (and the existing exchange-lifecycle contract) see the original behaviour.
    const leases = createWebChatTransportLeaseRegistry();
    await leases.admitConversation({ holder: "title", conversationKey: "c1" });
    await expect(leases.admitConversation({ holder: "user", conversationKey: "c1" }))
      .rejects.toThrow(/still owns this conversation's transport resource/);
  });

  test("the wait is bounded: the same honest refusal arrives when the holder never settles", async () => {
    const leases = createWebChatTransportLeaseRegistry({ admissionWaitMs: 40 });
    await leases.admitConversation({ holder: "title", conversationKey: "c1" });
    const started = Date.now();
    await expect(leases.admitConversation({ holder: "user", conversationKey: "c1" }))
      .rejects.toThrow(/still owns this conversation's transport resource/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    // The expired waiter left nothing behind.
    expect(leases.admissionWaiterCount()).toBe(0);
  });

  test("the wait is cancellable, and a cancelled waiter leaves nothing behind", async () => {
    const leases = createWebChatTransportLeaseRegistry({ admissionWaitMs: 5_000 });
    await leases.admitConversation({ holder: "title", conversationKey: "c1" });
    const controller = new AbortController();
    const waiting = leases.admitConversation({ holder: "user", conversationKey: "c1", signal: controller.signal });
    controller.abort(new Error("the caller gave up"));
    await expect(waiting).rejects.toThrow();
    expect(leases.admissionWaiterCount()).toBe(0);
  });

  test("the slot is released on every exit path, including a shutdown", async () => {
    const leases = createWebChatTransportLeaseRegistry({ admissionWaitMs: 5_000 });
    await leases.admitConversation({ holder: "turn-a", conversationKey: "c1" });
    leases.releaseConversation("turn-a", "c1");
    // Released: the next holder is admitted immediately.
    await leases.admitConversation({ holder: "turn-b", conversationKey: "c1" });
    // Closing rejects a live waiter and clears the slot instead of leaving it owned.
    const waiting = leases.admitConversation({ holder: "turn-c", conversationKey: "c1" });
    leases.close();
    await expect(waiting).rejects.toThrow();
    expect(leases.admissionWaiterCount()).toBe(0);
    expect(leases.isConversationAdmitted("c1")).toBe(false);
  });
});

describe("issue #336 — the reported case: housekeeping racing the user's first message", () => {
  test("an undeclared housekeeping call and the user's first turn both complete", async () => {
    const { provider, network } = composition();
    network.holdFirstCompletion();

    // The harness's session-title call: same session identity, no declared purpose (pi-ai drops it).
    const title = runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "title-1", userText: "name this session",
    }));
    await network.firstCompletionStarted;

    const user = runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hello",
    }));
    await sleep(40);
    network.open();

    const [titleEvents, userEvents] = await Promise.all([title, user]);
    // The reported failure: the user's turn must return its answer, never the transport refusal.
    expect(terminalOf(userEvents)?.type).toBe("done");
    expect(terminalOf(titleEvents)?.type).toBe("done");
    // They were serialised, never concurrent.
    expect(network.maxConcurrentCompletions).toBe(1);
    // The user's turn is the user's conversation: it waits and then continues it, rather than
    // rebuilding a second chat from an unconfirmed record.
    expect(network.taskNewCalls).toBe(1);
    expect(network.chats).toBe(1);
  });

  test("a declared-purpose housekeeping call and a real turn both complete", async () => {
    const { provider, network } = composition();
    network.holdFirstCompletion();

    const title = runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "title-1",
      userText: "name this session", purpose: "session-title",
    }));
    await network.firstCompletionStarted;
    const user = runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hello",
    }));
    await sleep(40);
    network.open();

    const [titleEvents, userEvents] = await Promise.all([title, user]);
    expect(terminalOf(userEvents)?.type).toBe("done");
    expect(terminalOf(titleEvents)?.type).toBe("done");
    // A declared ephemeral turn still creates nothing.
    expect(network.taskNewCalls).toBe(1);
  });

  test("two real turns of one conversation are serialised, never concurrent", async () => {
    const { provider, network } = composition();
    network.holdFirstCompletion();

    const first = runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "one",
    }));
    await network.firstCompletionStarted;
    const second = runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-2", userText: "two",
    }));
    await sleep(40);
    network.open();

    const [firstEvents, secondEvents] = await Promise.all([first, second]);
    expect(terminalOf(firstEvents)?.type).toBe("done");
    expect(terminalOf(secondEvents)?.type).toBe("done");
    // Exclusivity is preserved: one conversation never runs two provider turns at once.
    expect(network.maxConcurrentCompletions).toBe(1);
  });

  test("a consumer that stops reading releases the admission for the next turn", async () => {
    const { provider, network } = composition();
    // Read exactly one event, then stop: the generator's own `return` is the disconnect path.
    for await (const _event of provider.turnEvents(provider.resolveTurn(
      body({ sessionId: "session-a", threadId: "thread-a", turnId: "turn-1/responses", userText: "one" }),
      new Headers(),
    ))) {
      break;
    }
    // The admission was released, so the next turn of the same conversation is admitted and answers.
    const next = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-2", userText: "two",
    }));
    expect(terminalOf(next)?.type).toBe("done");
    expect(network.maxConcurrentCompletions).toBe(1);
  });
});
