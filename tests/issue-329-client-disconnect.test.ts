/**
 * Issue #329 — a client that goes away must abort the turn, and a slow but healthy turn must not look
 * dead to the client.
 *
 * The measured failure: the first `pi-ai` attempt gave up with
 * `stream idle timeout after 300000ms`; the bridge never learned the client was gone, the provider
 * turn kept running and kept the conversation's admission slot, and the retry 30.6 s later was refused
 * with `Another turn is already using this ChatGPT Web conversation`.
 *
 * Two owners are exercised here:
 *
 * 1. **The chat-completions SSE writer** (`toChatCompletionStream`): it must forward cancellation to
 *    the upstream Responses stream (whose `cancel` aborts the provider turn), and it must translate
 *    the existing internal `response.heartbeat` keep-alive into an SSE comment — never a `data:` frame
 *    — until the first real delta or a terminal event.
 * 2. **The HTTP request lifetime** (`HttpTurnCounter` + the real `/v1/chat/completions` route): a
 *    client disconnect aborts the tracked turn, the provider turn settles, and the same conversation
 *    then accepts the next request instead of refusing it as busy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig, saveConfig } from "../src/config";
import { AsyncEventQueue } from "../src/event-queue";
import { HttpClientDisconnectedError, isHttpClientDisconnectedReason } from "../src/lib/errors";
import { HttpTurnCounter, startServer, type RunningServer } from "../src/server";
import {
  CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT,
  toChatCompletionStream,
} from "../src/responses/chat-completions";
import type { AdapterEvent } from "../src/types";
import { chatGptBrowserTurnRetiresRetainedSurface } from "../src/adapters/chatgpt-web/browser-worker";
import { retainedSurfaceSettlementForTurn } from "../src/adapters/chatgpt-web/retained-surface";
import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { BrowserAccountLeaseRegistry, ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  CONTROLLED_ACCOUNT,
  captureConsole,
  controlledProviderConfig,
} from "./support/chatgpt-web-surface";

const API_KEY = "issue-329-test-api-key-0123456789";

let home: string;
let savedHome: SavedChatGptWebHome;
const servers: RunningServer[] = [];

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-329-", { clearFreeHome: true });
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  while (servers.length > 0) {
    const server = servers.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
const READ_TIMEOUT = Symbol("read-timeout");

/** Read until `predicate` accepts the accumulated text, or fail with what arrived. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  label: string,
  budgetMs = 3_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let pending: Promise<ReadResult> | undefined;
  const deadline = Date.now() + budgetMs;
  while (!predicate(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${label}; collected: ${JSON.stringify(text)}`);
    // Keep ONE pending read across timeouts: cancelling a race does not cancel `reader.read()`, and a
    // second read would leave the first one's chunk unclaimed when it finally arrives.
    pending ??= reader.read();
    const next = await Promise.race([
      pending,
      new Promise<typeof READ_TIMEOUT>(resolve => setTimeout(() => resolve(READ_TIMEOUT), remaining)),
    ]);
    if (next === READ_TIMEOUT) continue;
    pending = undefined;
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

const dataLines = (text: string): string[] =>
  text.split("\n").filter(line => line.startsWith("data: "));

const parsedFrames = (text: string): Array<Record<string, unknown>> =>
  dataLines(text)
    .map(line => line.slice("data: ".length).trim())
    .filter(payload => payload !== "" && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);

/** The stream has exactly the standard role chunk and no other `data:` frame yet. */
function onlyRoleFrame(text: string): boolean {
  const frames = dataLines(text);
  return frames.length === 1 && frames[0]!.includes('"role":"assistant"');
}

describe("the chat-completions SSE writer", () => {
  test("translates the existing Responses heartbeat into SSE comments, and stops at the first real delta", async () => {
    const queue = new AsyncEventQueue<AdapterEvent>();
    // The real bridge keep-alive mechanism, at a deliberately short interval so the test is fast.
    // 25 ms is the same clock production runs at 2 s; the writer must not own a second one.
    const upstream = bridgeToResponsesSSE(
      queue,
      "gpt-5.6-luna",
      undefined,
      undefined,
      undefined,
      () => {},
      25,
    );
    const reader = toChatCompletionStream(upstream, "gpt-5.6-luna").getReader();
    try {
      const waiting = await readUntil(reader, text => text.includes(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT), "keep-alive");
      // A comment is not a data frame: a client that ignores comments sees only the standard role
      // chunk, never a fake choice, an empty delta or an invented event.
      expect(waiting).toContain(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT);
      expect(onlyRoleFrame(waiting)).toBe(true);
      expect(JSON.stringify(parsedFrames(waiting))).not.toContain("keep-alive");

      queue.push({ type: "text_delta", text: "hola" });
      const withDelta = await readUntil(
        reader,
        text => text.includes('"content":"hola"'),
        "the first real answer delta",
      );
      // Let the bridge heartbeat fire several times *after* the delta. The writer must not turn them
      // into comments any more: the answer is visible, so the idle-timer problem is over.
      await Bun.sleep(100);
      queue.push({ type: "done" });
      const terminal = await readUntil(reader, text => text.includes("data: [DONE]"), "the terminal frame");
      expect(terminal).toContain('"finish_reason":"stop"');
      const afterDeltaStart = withDelta.indexOf('"content":"hola"');
      expect(withDelta.slice(afterDeltaStart) + terminal).not.toContain(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT);
      // The terminal frame is last: the controller is closed and nothing else can be written.
      const end = await reader.read();
      expect(end.done).toBe(true);

      // A client that ignores comments parses exactly the same frames as one that does not: the
      // `data:` sequence is the canonical four frames, with no keep-alive payload smuggled into one.
      const combined = waiting + withDelta + terminal;
      const lines = dataLines(combined);
      expect(lines).toHaveLength(4);
      expect(lines.filter(line => line.includes("keep-alive"))).toHaveLength(0);
      const frames = parsedFrames(combined);
      expect(frames).toHaveLength(3);
      expect(frames[0]).toMatchObject({ object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] });
      expect(frames[1]).toMatchObject({ object: "chat.completion.chunk", choices: [{ delta: { content: "hola" }, finish_reason: null }] });
      expect(frames[2]).toMatchObject({ object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] });
    } finally {
      await reader.cancel().catch(() => undefined);
      queue.close();
    }
  });

  test("cancelling the converted stream forwards cancellation upstream (so the provider turn is aborted)", async () => {
    const queue = new AsyncEventQueue<AdapterEvent>();
    let cancelled = 0;
    const upstream = bridgeToResponsesSSE(
      queue,
      "gpt-5.6-luna",
      undefined,
      undefined,
      undefined,
      () => { cancelled += 1; },
      25,
    );
    const reader = toChatCompletionStream(upstream, "gpt-5.6-luna").getReader();
    await readUntil(reader, text => text.includes(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT), "keep-alive");
    await reader.cancel(new Error("client disconnected"));
    // The upstream Responses stream's own cancel hook is what aborts the provider turn.
    expect(cancelled).toBe(1);
    queue.close();
  });
});

describe("the HTTP request lifetime", () => {
  test("a request-signal abort aborts the tracked turn with the disconnect marker and releases it", async () => {
    const counter = new HttpTurnCounter();
    const client = new AbortController();
    let turnSignal: AbortSignal | undefined;
    const logs = captureConsole();
    try {
      const response = await counter.track(async signal => {
        turnSignal = signal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }));
      }, client.signal, "linux", "chat-completions");
      expect(response.status).toBe(200);
      expect(counter.count()).toBe(1);

      client.abort();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(turnSignal?.aborted).toBe(true);
      // The provider can tell "the consumer vanished" apart from an explicit cancel.
      expect(isHttpClientDisconnectedReason(turnSignal?.reason)).toBe(true);
      // The tracked turn released its slot and logged the one distinguishing line.
      expect(counter.count()).toBe(0);
      expect(logs.text()).toContain("http_client_disconnected");
      expect(logs.text()).not.toContain("http_stream_failed");
    } finally {
      logs.restore();
    }
  });

  test("cancelling the response body (the Node writer's disconnect signal) does the same", async () => {
    const counter = new HttpTurnCounter();
    const logs = captureConsole();
    try {
      let turnSignal: AbortSignal | undefined;
      const response = await counter.track(async signal => {
        turnSignal = signal;
        return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      }, new AbortController().signal, "linux", "chat-completions");
      expect(counter.count()).toBe(1);
      await response.body!.cancel(new Error("client closed the socket"));
      expect(turnSignal?.aborted).toBe(true);
      expect(isHttpClientDisconnectedReason(turnSignal?.reason)).toBe(true);
      expect(counter.count()).toBe(0);
      expect(logs.text()).toContain("http_client_disconnected");
    } finally {
      logs.restore();
    }
  });
});

describe("client-disconnect classification", () => {
  test("a disconnect is an ordinary failed attempt, not an explicit teardown, so the conversation is not retired", () => {
    const abort = new DOMException("ChatGPT web turn aborted", "AbortError");
    // Explicit teardown (an interrupt, a closed tab) keeps its existing meaning...
    expect(chatGptBrowserTurnRetiresRetainedSurface(abort)).toBe(true);
    expect(chatGptBrowserTurnRetiresRetainedSurface(abort, new DOMException("cancelled", "AbortError"))).toBe(true);
    // ...but an HTTP client going away is not an explicit cancel: the surface stays and the next
    // turn reconciles it instead of failing `retained_surface_lost`.
    expect(isHttpClientDisconnectedReason(new HttpClientDisconnectedError())).toBe(true);
    expect(chatGptBrowserTurnRetiresRetainedSurface(abort, new HttpClientDisconnectedError())).toBe(false);
    // Post-submission, the failed attempt is marked for reconciliation (a failure is not a death).
    expect(retainedSurfaceSettlementForTurn("failed", "confirmed")).toBe("unreconciled");
    // Pre-submission it is an ordinary retry and marks nothing.
    expect(retainedSurfaceSettlementForTurn("failed", "unconfirmed")).toBe("not_started");
  });
});

/**
 * The controlled browser I/O for the regression: the first turn reaches its confirmed submission and
 * then holds until *the client's disconnect* aborts it, exactly like the real worker. The second turn
 * answers normally, provided the conversation was released and reconciled.
 */
class DisconnectSurface {
  readonly runs: Array<{ readonly turn: WebSurfaceTurn }> = [];
  aborted = 0;
  /** The abort reason the *provider transport* received, to prove the marker reached it intact. */
  abortReason: unknown;
  private abortObserved!: () => void;
  private readonly abortObservedPromise = new Promise<void>(resolve => { this.abortObserved = resolve; });

  get firstAborted(): Promise<void> {
    return this.abortObservedPromise;
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const index = this.runs.length + 1;
        this.runs.push({ turn });
        await turn.onPreparedSelected?.(false);
        const prepare = turn.prepare;
        if (!prepare) throw new Error("the disconnect fixture was asked to resume without a prompt");
        const compiled = await prepare();
        try {
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `surface-${index}`,
            browserContextId: "controlled-context",
            pageId: `controlled-page-${index}`,
            profileId: "controlled-profile",
            accountId: `chatgpt-account:${CONTROLLED_ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();
          await turn.onSendActivated?.();
          turn.onSubmitted?.();
          if (index === 1) {
            // The browser worker's own abort semantics: the signal stops the turn with an AbortError.
            await new Promise<void>((resolve, reject) => {
              const signal = turn.abortSignal;
              if (!signal) { reject(new Error("the first turn did not receive an abort signal")); return; }
              if (signal.aborted) { resolve(); return; }
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            this.aborted += 1;
            this.abortReason = turn.abortSignal?.reason;
            this.abortObserved();
            throw new DOMException("ChatGPT web turn aborted", "AbortError");
          }
          turn.onTextDelta(`answer-${index}`);
          return `answer-${index}`;
        } finally {
          compiled.release();
        }
      },
      async verifyConnector() { return "controlled"; },
      async inspectSession() { return { authenticated: true, temporary: false, url: "https://chatgpt.com" }; },
      async smokeTest() { return { effort: "low", response: "controlled" }; },
      async recoverRetainedAnswer() { throw new Error("no retained answer in the disconnect fixture"); },
      // The failed attempt left an unconfirmed record; this provider can prove the conversation is
      // coherent, which is what lets the retry continue instead of being refused.
      async proveRetainedCoherence() {
        return { kind: "reconciled" as const, reason: "the controlled conversation is coherent" };
      },
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

function serve(surface: { readonly transport: ChatGptWebSurfaceTransport }, core: ChatGptWebProviderCore): RunningServer {
  const server = startServer(
    { ...defaultConfig(), port: 0, host: "127.0.0.1" } as never,
    {
      providerCore: core,
      adapterFactory: (_provider: unknown, providerCore: ChatGptWebProviderCore) => createChatGptWebAdapter(
        controlledProviderConfig(home),
        { providerCore, surfaceTransport: surface.transport },
      ),
    } as never,
  );
  servers.push(server);
  return server;
}

async function waitFor(predicate: () => boolean, label: string, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * A surface that answers normally but holds its first turn until the test opens the gate — the shape of
 * a healthy provider turn that takes minutes before its first visible token.
 */
class HoldingSurface {
  private release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  private submitted!: () => void;
  private readonly submittedSignal = new Promise<void>(resolve => { this.submitted = resolve; });
  runs = 0;

  get firstSubmitted(): Promise<void> {
    return this.submittedSignal;
  }

  open(): void {
    this.release();
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const index = this.runs + 1;
        this.runs += 1;
        await turn.onPreparedSelected?.(false);
        const compiled = await turn.prepare();
        try {
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `holding-surface-${index}`,
            browserContextId: "controlled-context",
            pageId: `holding-page-${index}`,
            profileId: "controlled-profile",
            accountId: `chatgpt-account:${CONTROLLED_ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();
          await turn.onSendActivated?.();
          turn.onSubmitted?.();
          this.submitted();
          await this.gate;
          turn.onTextDelta(`answer-${index}`);
          return `answer-${index}`;
        } finally {
          compiled.release();
        }
      },
      async verifyConnector() { return "controlled"; },
      async inspectSession() { return { authenticated: true, temporary: false, url: "https://chatgpt.com" }; },
      async smokeTest() { return { effort: "low", response: "controlled" }; },
      async recoverRetainedAnswer() { throw new Error("no retained answer in the holding fixture"); },
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

describe("a healthy slow turn does not look dead to the client (issue #329)", () => {
  test("while the provider works, the real chat-completions stream emits keep-alive comments and no data frames", async () => {
    const core = new ChatGptWebProviderCore("chatgpt-web", new BrowserAccountLeaseRegistry(), 5_000, 250);
    const surface = new HoldingSurface();
    const server = serve(surface, core);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, connection: "close" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        stream: true,
        user: "issue-329-slow-conversation",
        messages: [{ role: "user", content: "una pregunta lenta" }],
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await surface.firstSubmitted;

    // The bridge's production heartbeat interval is 2 s; allow it to fire twice.
    const waiting = await readUntil(
      reader,
      text => text.includes(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT),
      "an SSE keep-alive comment",
      4_000,
    );
    // The only data frame so far is the standard role chunk: comments add no choices, no deltas.
    expect(onlyRoleFrame(waiting)).toBe(true);

    surface.open();
    const rest = await readUntil(reader, text => text.includes("data: [DONE]"), "the answer", 4_000);
    const combined = waiting + rest;
    expect(combined).toContain('"content":"answer-1"');
    expect(combined).toContain('"finish_reason":"stop"');
    const afterDelta = combined.slice(combined.indexOf('"content":"answer-1"'));
    expect(afterDelta).not.toContain(CHAT_COMPLETIONS_KEEP_ALIVE_COMMENT);
  });
});

describe("a client disconnect releases the conversation (issue #329)", () => {
  test("attempt 1 abandoned mid-turn → attempt 2 on the same conversation is accepted", async () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases, 5_000, 250);
    const surface = new DisconnectSurface();
    const server = serve(surface, core);
    const logs = captureConsole();

    try {
      const controller = new AbortController();
      const first = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
          connection: "close",
        },
        body: JSON.stringify({
          model: "chatgpt-web/luna",
          stream: true,
          user: "issue-329-one-conversation",
          messages: [{ role: "user", content: "primera pregunta" }],
        }),
        signal: controller.signal,
      });
      expect(first.status).toBe(200);
      expect(first.body).not.toBeNull();
      const reader = first.body!.getReader();
      // Read the role frame so the turn is genuinely streaming, then disappear.
      await reader.read();

      controller.abort();
      await reader.cancel().catch(() => undefined);

      // The abort reached the provider turn and the turn let go of its conversation.
      await Promise.race([
        surface.firstAborted,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the disconnect never reached the provider turn")), 3_000)),
      ]);
      expect(surface.aborted).toBe(1);
      // The request-lifetime marker reached the provider transport unchanged, so its teardown path
      // can tell an abandoned request from an explicit cancel.
      expect(isHttpClientDisconnectedReason(surface.abortReason)).toBe(true);
      await waitFor(() => leases.activeCount() === 0, "the provider turn to release its lease");

      // The next request on the same identity must be admitted and answer, not be refused as busy.
      const second = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
          connection: "close",
        },
        body: JSON.stringify({
          model: "chatgpt-web/luna",
          user: "issue-329-one-conversation",
          messages: [{ role: "user", content: "segunda pregunta" }],
        }),
      });
      const payload = await second.json() as Record<string, unknown>;
      const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
      expect(second.status).toBe(200);
      expect(payload.error).toBeUndefined();
      expect(choices?.[0]?.message?.content).toBe("answer-2");
      expect(surface.runs).toHaveLength(2);

      // One line distinguishes "the client disconnected" from "the turn failed", and the abort was
      // never published as a conversation loss.
      expect(logs.text()).toContain("http_client_disconnected");
      expect(logs.text()).not.toContain("retained_surface_lost");
      expect(logs.text()).not.toContain("another turn is already using");
    } finally {
      logs.restore();
    }
  });
});
