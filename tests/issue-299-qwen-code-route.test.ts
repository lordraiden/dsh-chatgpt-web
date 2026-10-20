import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import type { AdapterEvent } from "../src/types";
import type { QwenTurnRequestFacility } from "../src/adapters/qwen-code/network-turn";
import { createQwenCodeProvider, type QwenCodeProviderComposition } from "../src/adapters/qwen-code/provider-runtime";
import { qwenCodeResponsesRequest } from "../src/adapters/qwen-code/responses";
import type { QwenCodeRequestSession } from "../src/adapters/qwen-code/browser-session";
import {
  createMemoryQwenCodeConversationState,
  type QwenCodeConversationState,
} from "../src/adapters/qwen-code/chat-state";
import { QWEN_CODE_PROVIDER_ID } from "../src/adapters/qwen-code/provider";
import {
  createMemoryConversationStore,
  webChatAccountBindingId,
  webChatContinuationIdentity,
  type WebChatConversationStore,
} from "../src/web-chat/core";

/**
 * Issue #299, slice 2 — the Qwen Code route.
 *
 * The unit half drives the real composition (continuity decision, exchange, durable record, chat
 * state) with a controlled network; the integration half runs the **real listener** and proves the
 * two claims a caller cares about: `/v1/chat/completions` streams a `qwen-code/<model>` answer in the
 * OpenAI wire shape, and a declared housekeeping turn leaves no chat behind.
 */
const CONTROL_TOKEN = "issue-299-qwen-route-control-token";
const MODEL_ID = "qwen3-coder-plus";
const MODEL_ROUTE = `${QWEN_CODE_PROVIDER_ID}/${MODEL_ID}`;
const ACCOUNT = "issue-299-qwen-route-account";

let home: string;
let savedHome: SavedChatGptWebHome;

const running: RunningServer[] = [];

afterEach(async () => {
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
});

/** One recorded-shape SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The controlled network: the recorded shapes, driven by a queue of per-turn scripts. */
class ControlledNetwork {
  chats = 0;
  taskNewCalls = 0;
  completionCalls = 0;
  readonly completionPaths: string[] = [];
  readonly prompts: string[] = [];
  /** One script per completion request, in order. */
  readonly scripts: Array<{ readonly answer?: string; readonly chatId?: string; readonly rejectChat?: boolean }> = [];
  /** Overrides the next `task/new` answer. */
  rejectTaskNew: { status: number; body: unknown } | undefined;

  reset(): void {
    this.chats = 0;
    this.taskNewCalls = 0;
    this.completionCalls = 0;
    this.completionPaths.length = 0;
    this.prompts.length = 0;
    this.scripts.length = 0;
    this.rejectTaskNew = undefined;
  }

  readonly facility: QwenTurnRequestFacility = {
    postJson: async (): Promise<{ status: number; body: unknown }> => {
      this.taskNewCalls += 1;
      if (this.rejectTaskNew) return this.rejectTaskNew;
      this.chats += 1;
      return { status: 200, body: { success: true, data: { id: `chat-${this.chats}` } } };
    },
    postEventStream: async (path, body, onChunk, options = {}) => {
      this.completionCalls += 1;
      this.completionPaths.push(path);
      const chatId = new URL(path, "https://coder.qwen.ai").searchParams.get("chat_id") ?? "";
      const prompt = (body as { messages?: { content?: unknown }[] }).messages?.[0]?.content;
      if (typeof prompt === "string") this.prompts.push(prompt);
      const script = this.scripts.shift() ?? { answer: "controlled answer" };
      if (script.rejectChat) {
        // A recorded-shape refusal: the chat the caller asked to continue does not exist any more.
        return {
          status: 404,
          contentType: "application/json",
          bodyText: JSON.stringify({ success: false, data: { code: "ChatNotFound" } }),
        };
      }
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      onChunk(frame({ "response.created": { chat_id: chatId, parent_id: `parent:${chatId}`, response_id: `resp:${chatId}` } }));
      onChunk(frame({
        choices: [{
          delta: { role: "assistant", content: script.answer ?? "controlled answer", phase: "answer", status: "typing" },
        }],
        response_id: `resp:${chatId}`,
      }));
      onChunk(frame({
        choices: [{ delta: { role: "assistant", content: "", phase: "answer", status: "finished" } }],
        response_id: `resp:${chatId}`,
      }));
      return { status: 200, contentType: "text/event-stream" };
    },
  } as QwenTurnRequestFacility;
}

/** The session over a controlled network. */
function controlledSession(network: ControlledNetwork): QwenCodeRequestSession {
  return {
    id: "issue-299-qwen-route-session",
    async ready() {},
    async run<T>(body: (facility: QwenTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(network.facility);
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

/** Build one composition over a controlled network and in-memory durable state. */
function composition(): Composition {
  const network = new ControlledNetwork();
  const store = createMemoryConversationStore();
  const state = createMemoryQwenCodeConversationState();
  const provider = createQwenCodeProvider({
    config: {
      ...defaultConfig(),
      webChat: {
        providers: {
          [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] },
        },
      },
    } as never,
    session: controlledSession(network),
    store,
    state,
  });
  return { provider, store, state, network };
}

/** The internal Responses body of one conversational turn. */
function body(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly userText: string;
  readonly history?: readonly { role: "user" | "assistant"; text: string }[];
  readonly purpose?: string;
  readonly stream?: boolean;
}): Record<string, unknown> {
  const history = input.history ?? [{ role: "user" as const, text: input.userText }];
  return {
    model: MODEL_ROUTE,
    stream: input.stream === true,
    input: history.map(message => ({
      type: "message",
      role: message.role,
      content: [{ type: "text", text: message.text }],
    })),
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

/** Run one turn through the real ingress and return its normalized events. */
async function runTurn(
  provider: QwenCodeProviderComposition,
  requestBody: Record<string, unknown>,
): Promise<{ readonly events: AdapterEvent[]; readonly status: number; readonly payload: Record<string, unknown> }> {
  const events: AdapterEvent[] = [];
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const response = await qwenCodeResponsesRequest({
    request,
    body: requestBody,
    provider,
    onAdapterEvent: event => events.push(event),
  });
  const payload = await response.json() as Record<string, unknown>;
  return { events, status: response.status, payload };
}

describe("issue #299 — Qwen Code route: one conversation key, one chat", () => {
  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-299-qwen-route-", { clearFreeHome: true });
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("a second turn of the same conversation continues the same chat, and its cursor", async () => {
    const { provider, store, network } = composition();
    network.scripts.push({ answer: "first answer" }, { answer: "second answer" });

    const first = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-1",
      userText: "hola",
    }));
    expect(first.events.at(-1)?.type).toBe("done");
    expect(network.taskNewCalls).toBe(1);
    expect(network.completionPaths[0]).toContain("chat_id=chat-1");

    const second = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-2",
      userText: "again",
    }));
    expect(second.events.at(-1)?.type).toBe("done");
    // No second chat: the recorded one was continued, in the same conversation.
    expect(network.taskNewCalls).toBe(1);
    expect(network.completionPaths[1]).toContain("chat_id=chat-1");
    // Only the new user text is compiled on a continuation: the provider chat is the history.
    expect(network.prompts).toEqual(["hola", "again"]);

    const identity = webChatContinuationIdentity({
      binding: { providerId: QWEN_CODE_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    const record = await store.read(identity);
    expect(record?.checkpoint).toBe("confirmed");
    expect(record?.generation).toBe(1);
    expect(record?.lastConfirmedTurn?.turnId).toBe("turn-2");
  });

  test("a different conversation gets a different chat", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "a" }, { answer: "b" }, { answer: "c" });

    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "t1", userText: "one" }));
    await runTurn(provider, body({ sessionId: "session-b", threadId: "thread-b", turnId: "t2", userText: "two" }));
    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "t3", userText: "three" }));

    expect(network.taskNewCalls).toBe(2);
    expect(network.completionPaths[0]).toContain("chat_id=chat-1");
    expect(network.completionPaths[1]).toContain("chat_id=chat-2");
    expect(network.completionPaths[2]).toContain("chat_id=chat-1");
  });

  test("a chat the provider no longer accepts is a typed loss, and recovery is an explicit replay", async () => {
    const { provider, store, state, network } = composition();
    network.scripts.push({ answer: "first" }, { rejectChat: true }, { answer: "rebuilt" });

    const first = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-1",
      userText: "hola",
    }));
    expect(first.events.at(-1)?.type).toBe("done");

    const lost = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-2",
      userText: "again",
    }));
    expect(lost.events.at(-1)?.type).toBe("error");
    const failure = lost.events.at(-1) as Extract<AdapterEvent, { type: "error" }>;
    expect(failure.code).toBe("QWEN_CHAT_LOST");
    expect(failure.status).toBe(409);
    // The chat is recorded as lost; nothing silently continues it.
    const identity = webChatContinuationIdentity({
      binding: { providerId: QWEN_CODE_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    expect(state.read(identity.key)?.chat?.status).toBe("lost");

    const recovered = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-3",
      userText: "again please",
      history: [
        { role: "user", text: "hola" },
        { role: "assistant", text: "first" },
        { role: "user", text: "again please" },
      ],
    }));
    expect(recovered.events.at(-1)?.type).toBe("done");
    // The recovery is explicit and visible: a NEW chat, and a generation that advanced by one.
    expect(network.taskNewCalls).toBe(2);
    expect(network.completionPaths[2]).toContain("chat_id=chat-2");
    // The canonical history was compiled into the rebuilt conversation.
    expect(network.prompts[2]).toContain("User: hola\nAssistant: first\nUser: again please");
    const record = await store.read(identity);
    expect(record?.generation).toBe(2);
    expect(record?.checkpoint).toBe("confirmed");
  });

  test("an attempt the provider cannot reconcile is rebuilt by an explicit replay", async () => {
    const { provider, store, network } = composition();
    network.scripts.push({ answer: "first" }, { answer: "rebuilt" });
    const identity = webChatContinuationIdentity({
      binding: { providerId: QWEN_CODE_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });

    const first = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-1",
      userText: "hola",
    }));
    expect(first.events.at(-1)?.type).toBe("done");

    // What a crash mid-turn leaves behind: the record was attempted and never confirmed. This provider
    // cannot prove from provider state which message the chat holds, so the core refuses to resume it.
    await store.update(identity, current => ({
      identity: current!.identity,
      generation: current!.generation,
      ...(current!.handle ? { handle: current!.handle } : {}),
      status: current!.status,
      checkpoint: "unconfirmed",
    }));

    const recovered = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-2",
      userText: "again",
      history: [
        { role: "user", text: "hola" },
        { role: "assistant", text: "first" },
        { role: "user", text: "again" },
      ],
    }));

    expect(recovered.events.at(-1)?.type).toBe("done");
    // Explicit, visible recovery: a new chat and a generation that advanced by one.
    expect(network.taskNewCalls).toBe(2);
    expect(network.completionPaths[1]).toContain("chat_id=chat-2");
    expect(network.prompts[1]).toContain("User: hola\nAssistant: first\nUser: again");
    const record = await store.read(identity);
    expect(record?.generation).toBe(2);
    expect(record?.checkpoint).toBe("confirmed");
  });

  test("a declared housekeeping purpose is answered without creating or recording any conversation", async () => {
    const { provider, store, network } = composition();
    network.scripts.push({ answer: "Session about Qwen" });

    const ephemeral = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "title-1",
      userText: "name this session",
      purpose: "session-title",
    }));

    expect(ephemeral.events.at(-1)?.type).toBe("done");
    // The rule: housekeeping never creates a chat, so it never appears in the operator's account.
    expect(network.taskNewCalls).toBe(0);
    expect(network.completionCalls).toBe(1);
    // …and it leaves no conversation record this deployment could ever continue.
    expect(await store.list()).toEqual([]);
    const payload = ephemeral.payload as { status?: string };
    expect(payload.status).toBe("completed");
  });

  test("a capability declaration is discarded and declared, never forwarded", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "no tools here" });
    const requestBody = body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-tools",
      userText: "use the weather tool",
    });
    requestBody["tools"] = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }];

    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await qwenCodeResponsesRequest({ request, body: requestBody, provider });

    expect(response.status).toBe(200);
    // Declared on the response, exactly like the chat-completions surface reports it…
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBe("tools");
    // …and never forwarded: the provider received the user's text only.
    expect(network.prompts).toEqual(["use the weather tool"]);
    const forwarded = JSON.stringify(network.completionPaths);
    expect(forwarded).not.toContain("weather");
  });

  test("a caller that already has no identity still gets a stable content-derived conversation", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "one" }, { answer: "two" });
    const impossible = () => ({ ...body({ sessionId: "", threadId: "", turnId: "t", userText: "same text" }) });
    const first = impossible();
    delete (first.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"];
    const second = impossible();
    delete (second.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"];

    const one = await runTurn(provider, first);
    const two = await runTurn(provider, second);

    expect(one.events.at(-1)?.type).toBe("done");
    expect(two.events.at(-1)?.type).toBe("done");
    // Identical content without a declared identity keeps its conversation — never one per request.
    expect(network.taskNewCalls).toBe(1);
  });

  test("an unknown model names the models this deployment serves", async () => {
    const { provider } = composition();
    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-code/nope", input: [] }),
    });
    const response = await qwenCodeResponsesRequest({ request, body: { model: "qwen-code/nope", input: [] }, provider });
    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toContain("qwen-code/qwen3-coder-plus");
  });
});

/** A listener configuration that declares the provider, exactly like a real deployment. */
function listenerConfig(): never {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    webChat: {
      providers: {
        [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] },
      },
    },
  } as never;
}

describe("issue #299 — Qwen Code through the real listener", () => {
  let network: ControlledNetwork;
  let provider: QwenCodeProviderComposition;

  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-299-qwen-listener-", { clearFreeHome: true });
    network = new ControlledNetwork();
    provider = createQwenCodeProvider({
      config: {
        ...defaultConfig(),
        webChat: {
          providers: {
            [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] },
          },
        },
      } as never,
      session: controlledSession(network),
      store: createMemoryConversationStore(),
      state: createMemoryQwenCodeConversationState(),
    });
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("POST /v1/chat/completions streams a qwen-code answer in the OpenAI wire shape", async () => {
    network.scripts.push({ answer: "Hola desde Qwen" });
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-affinity": "issue-299-listener-session",
      },
      body: JSON.stringify({
        model: MODEL_ROUTE,
        stream: true,
        messages: [{ role: "user", content: "hola" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const frames = text.split("\n\n").filter(line => line.startsWith("data: "));
    const chunks = frames
      .map(line => line.slice("data: ".length))
      .filter(payload => payload !== "[DONE]")
      .map(payload => JSON.parse(payload) as {
        choices?: { delta?: { role?: string; content?: string }; finish_reason?: string | null }[];
      });
    // The OpenAI shape a stock client parses: a role delta, the content deltas, then a finish.
    expect(chunks[0]?.choices?.[0]?.delta?.role).toBe("assistant");
    expect(chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.content ?? "").join(""))
      .toBe("Hola desde Qwen");
    expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // The provider really ran the turn: one chat, one completion, one prompt.
    expect(network.taskNewCalls).toBe(1);
    expect(network.prompts).toEqual(["hola"]);
  });

  test("a declared purpose header answers the turn without creating a chat", async () => {
    network.scripts.push({ answer: "A title" });
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-affinity": "issue-299-listener-session",
        "x-dsh-turn-purpose": "session-title",
      },
      body: JSON.stringify({
        model: MODEL_ROUTE,
        messages: [{ role: "user", content: "name this session" }],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    expect(payload.choices?.[0]?.message?.content).toBe("A title");
    // The housekeeping turn was answered and kept nowhere.
    expect(network.taskNewCalls).toBe(0);
    expect(network.completionCalls).toBe(1);
  });

  test("GET /v1/models lists the composed catalogue with the qwen-code rows", async () => {
    const server = startServer(
      {
        ...defaultConfig(),
        port: 0,
        host: "127.0.0.1",
        controlToken: CONTROL_TOKEN,
        webChat: {
          providers: {
            [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] },
          },
        },
      } as never,
      { webChatProviders: [provider] } as never,
    );
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { models?: { slug?: string }[]; data?: { id?: string }[] };
    expect(payload.models?.some(row => row.slug === MODEL_ROUTE)).toBe(true);
    // The OpenAI `data` array is additive and carries the same route id.
    expect(payload.data?.some(entry => entry.id === MODEL_ROUTE)).toBe(true);
  });

  test("POST /v1/chat/completions refuses an unknown model with the available ids", async () => {
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-code/nope", messages: [{ role: "user", content: "hola" }] }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toContain(MODEL_ROUTE);
    expect(network.completionCalls).toBe(0);
  });

  test("an unauthenticated Qwen session is a 401 naming the sign-in surface", async () => {
    const session: QwenCodeRequestSession = {
      id: "issue-299-unauthenticated",
      async ready() {
        const { webChatError } = await import("../src/web-chat/core");
        throw webChatError(
          "AUTH_REQUIRED",
          "Qwen Code has no verified session on this deployment. Sign in to Qwen Code at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Code\").",
          { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_SESSION_MISSING" },
        );
      },
      async run<T>(body: (facility: QwenTurnRequestFacility) => Promise<T>): Promise<T> {
        return await body(network.facility);
      },
      async close() {},
    };
    const unauthenticated = createQwenCodeProvider({
      config: {
        ...defaultConfig(),
        webChat: {
          providers: { [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] } },
        },
      } as never,
      session,
      store: createMemoryConversationStore(),
      state: createMemoryQwenCodeConversationState(),
    });
    const server = startServer(listenerConfig(), { webChatProviders: [unauthenticated] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ROUTE, messages: [{ role: "user", content: "hola" }] }),
    });

    expect(response.status).toBe(401);
    const payload = await response.json() as { error?: { message?: string; code?: string } };
    expect(payload.error?.message).toContain("/v1/control/auth/");
    expect(payload.error?.code).toBe("QWEN_SESSION_MISSING");
    // A refusal before submission sends nothing and creates nothing.
    expect(network.taskNewCalls).toBe(0);
    expect(network.completionCalls).toBe(0);
  });
});
