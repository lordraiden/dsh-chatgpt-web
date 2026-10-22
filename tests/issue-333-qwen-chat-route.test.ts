import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import type { AdapterEvent } from "../src/types";
import {
  QWEN_CHAT_PROVIDER_ID,
  createMemoryQwenChatConversationState,
  createQwenChatProvider,
  createQwenChatTextTransport,
  qwenChatResponsesRequest,
  type QwenChatProviderComposition,
  type QwenChatRequestSession,
  type QwenChatTurnAnswer,
  type QwenChatTurnDiagnostic,
  type QwenChatTurnRequestFacility,
} from "../src/adapters/qwen-chat";
import {
  createMemoryConversationStore,
  webChatContinuationIdentity,
  type WebChatConversationStore,
} from "../src/web-chat/core";
import { projectIdentityHeader } from "../src/project-identity";
import type { WebChatTextTransportContext } from "../src/web-chat/transport";

/**
 * Issue #333 — the Qwen Chat route.
 *
 * The unit half drives the real composition (continuity decision, exchange, durable record, chat
 * state) with a controlled network; the integration half runs the **real listener** and proves the
 * claims a caller cares about: `/v1/chat/completions` streams a `qwen-chat/<model>` answer in the
 * OpenAI wire shape, an unsupported mode is refused before submission, and a declared housekeeping
 * turn leaves no chat behind.
 */
const CONTROL_TOKEN = "issue-333-qwen-chat-route-control-token";
const MODEL_ID = "qwen3.7-plus";
const MODEL_ROUTE = `${QWEN_CHAT_PROVIDER_ID}/${MODEL_ID}`;
const ACCOUNT = "issue-333-qwen-chat-route-account";

/**
 * The deterministic header a **new** conversation installs (the package's own identity). Taken from
 * the neutral owner rather than copied, so this suite pins the install shape without restating the
 * identity - the identity itself is pinned by the ChatGPT suite and the qwen-chat project-header one.
 */
const INSTALL_HEADER = projectIdentityHeader();

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

/** A scripted turn answer. */
interface Script {
  readonly answer?: string;
  readonly selectedModelId?: string;
  readonly rejectChat?: boolean;
}

/** The controlled network: the recorded shapes, driven by a queue of per-turn scripts. */
class ControlledNetwork {
  chats = 0;
  chatNewCalls = 0;
  completionCalls = 0;
  readonly completionPaths: string[] = [];
  readonly prompts: string[] = [];
  readonly bodies: Record<string, unknown>[] = [];
  readonly scripts: Script[] = [];

  reset(): void {
    this.chats = 0;
    this.chatNewCalls = 0;
    this.completionCalls = 0;
    this.completionPaths.length = 0;
    this.prompts.length = 0;
    this.bodies.length = 0;
    this.scripts.length = 0;
  }

  readonly facility: QwenChatTurnRequestFacility = {
    postJson: async (): Promise<{ status: number; body: unknown }> => {
      this.chatNewCalls += 1;
      this.chats += 1;
      return { status: 200, body: { success: true, request_id: "req-fixture", data: { id: `chat-${this.chats}` } } };
    },
    postEventStream: async (path, body, onChunk, options = {}) => {
      this.completionCalls += 1;
      this.completionPaths.push(path);
      this.bodies.push(body as Record<string, unknown>);
      const chatId = new URL(path, "https://chat.qwen.ai").searchParams.get("chat_id") ?? "";
      const messages = (body as { messages?: { content?: unknown }[] }).messages;
      const prompt = messages?.[0]?.content;
      if (typeof prompt === "string") this.prompts.push(prompt);
      const script = this.scripts.shift() ?? { answer: "controlled answer" };
      const responseId = `response-${this.completionCalls}`;
      if (script.rejectChat) {
        // A recorded-shape refusal: the chat the caller asked to continue does not exist any more.
        return {
          status: 404,
          contentType: "application/json",
          bodyText: JSON.stringify({ success: false, data: { code: "ChatNotFound" } }),
        };
      }
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      onChunk(frame({
        "response.created": {
          chat_id: chatId,
          parent_id: `parent-${this.completionCalls}`,
          response_id: responseId,
          response_index: this.completionCalls,
        },
      }));
      onChunk(frame({
        choices: [{
          delta: {
            role: "assistant",
            content: script.answer ?? "controlled answer",
            phase: "answer",
            status: "typing",
          },
        }],
        response_id: responseId,
      }));
      if (script.selectedModelId !== undefined) {
        onChunk(frame({
          selected_model_id: script.selectedModelId,
          choices: [{ delta: { role: "assistant" } }],
          response_id: responseId,
        }));
      }
      onChunk(frame({
        choices: [{ delta: { role: "assistant", content: "", phase: "answer", status: "finished" } }],
        response_id: responseId,
      }));
      return { status: 200, contentType: "text/event-stream" };
    },
  } as QwenChatTurnRequestFacility;
}

/** The session over a controlled network. */
function controlledSession(network: ControlledNetwork): QwenChatRequestSession {
  return {
    id: "issue-333-qwen-chat-route-session",
    async ready() {},
    async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(network.facility);
    },
    async close() {},
  };
}

interface Composition {
  readonly provider: QwenChatProviderComposition;
  readonly store: WebChatConversationStore;
  readonly state: ReturnType<typeof createMemoryQwenChatConversationState>;
  readonly network: ControlledNetwork;
}

/** The configuration block a real deployment would use. */
function providerBlock(): Record<string, unknown> {
  return {
    accountIdentityFingerprint: ACCOUNT,
    models: [{ id: MODEL_ID, label: "Qwen3.7-Plus", thinking: 1, autoThinking: true, thinkingFormat: "summary" }],
  };
}

/** Build one composition over a controlled network and in-memory durable state. */
function composition(network = new ControlledNetwork()): Composition {
  const store = createMemoryConversationStore();
  const state = createMemoryQwenChatConversationState();
  const provider = createQwenChatProvider({
    config: {
      ...defaultConfig(),
      webChat: { providers: { [QWEN_CHAT_PROVIDER_ID]: providerBlock() } },
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
  readonly reasoningEffort?: string;
}): Record<string, unknown> {
  const history = input.history ?? [{ role: "user" as const, text: input.userText }];
  return {
    model: MODEL_ROUTE,
    stream: input.stream === true,
    ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
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
  provider: QwenChatProviderComposition,
  requestBody: Record<string, unknown>,
): Promise<{ readonly events: AdapterEvent[]; readonly status: number; readonly payload: Record<string, unknown> }> {
  const events: AdapterEvent[] = [];
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const response = await qwenChatResponsesRequest({
    request,
    body: requestBody,
    provider,
    onAdapterEvent: event => events.push(event),
  });
  const payload = await response.json() as Record<string, unknown>;
  return { events, status: response.status, payload };
}

describe("issue #333 — Qwen Chat: one conversation key, one chat", () => {
  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-333-qwen-chat-route-", { clearFreeHome: true });
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("a second turn continues the same chat and puts the response id on the wire as the cursor", async () => {
    const { provider, store, state, network } = composition();
    network.scripts.push({ answer: "first answer" }, { answer: "second answer" });

    const first = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-1",
      userText: "hola",
    }));
    expect(first.events.at(-1)?.type).toBe("done");
    expect(network.chatNewCalls).toBe(1);
    expect(network.completionPaths[0]).toContain("chat_id=chat-1");

    const second = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-2",
      userText: "again",
    }));
    expect(second.events.at(-1)?.type).toBe("done");
    // No second chat: the recorded one was continued, in the same conversation.
    expect(network.chatNewCalls).toBe(1);
    expect(network.completionPaths[1]).toContain("chat_id=chat-1");
    // Only the new user text is compiled on a continuation: the provider chat is the history. The
    // FIRST turn of the conversation installed the deterministic project header plus only the user's
    // message, so the provider knows the project without any DSH context travelling with it.
    expect(INSTALL_HEADER).toBeDefined();
    expect(network.prompts).toEqual([`${INSTALL_HEADER}\n\nhola`, "again"]);
    // The second turn names the first response's id as its parent cursor, in both recorded places.
    expect(network.bodies[1]!["parentId"]).toBe("response-1");
    expect(network.bodies[1]!["parent_id"]).toBe("response-1");
    expect((network.bodies[1]!["messages"] as Record<string, unknown>[])[0]!["parentId"]).toBe("response-1");

    const identity = webChatContinuationIdentity({
      binding: { providerId: QWEN_CHAT_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    const record = await store.read(identity);
    expect(record?.checkpoint).toBe("confirmed");
    expect(record?.generation).toBe(1);
    expect(record?.lastConfirmedTurn?.turnId).toBe("turn-2");
    expect(state.read(identity.key)?.chat).toMatchObject({
      chatId: "chat-1",
      parentId: "response-2",
      responseId: "response-2",
      status: "active",
    });
  });

  test("a different conversation gets a different chat", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "a" }, { answer: "b" }, { answer: "c" });

    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "t1", userText: "one" }));
    await runTurn(provider, body({ sessionId: "session-b", threadId: "thread-b", turnId: "t2", userText: "two" }));
    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "t3", userText: "three" }));

    expect(network.chatNewCalls).toBe(2);
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
    expect(failure.code).toBe("QWEN_CHAT_CHAT_LOST");
    expect(failure.status).toBe(409);
    const identity = webChatContinuationIdentity({
      binding: { providerId: QWEN_CHAT_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    // The chat is recorded as lost; nothing silently continues it.
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
    expect(network.chatNewCalls).toBe(2);
    expect(network.completionPaths[2]).toContain("chat_id=chat-2");
    // The canonical history was compiled into the rebuilt conversation. A replay is not an install:
    // the header is initialization metadata of a brand-new conversation, so the rebuilt prompt is the
    // canonical history alone and never a second copy of the header.
    expect(network.prompts[2]).toContain("User: hola\nAssistant: first\nUser: again please");
    expect(network.prompts[2]!.match(/Project: /g)).toBeNull();
    const record = await store.read(identity);
    expect(record?.generation).toBe(2);
    expect(record?.checkpoint).toBe("confirmed");
  });

  test("a declared housekeeping purpose is answered without creating or recording any conversation", async () => {
    const { provider, store, state, network } = composition();
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
    expect(network.chatNewCalls).toBe(0);
    expect(network.completionCalls).toBe(1);
    // The answer streamed into a process-generated chat id, not the caller's conversation.
    expect(network.completionPaths[0]).not.toContain("chat_id=chat-1");
    // A housekeeping turn is not a conversation install, so it carries no project header: the title
    // request is exactly the caller's text.
    expect(network.prompts).toEqual(["name this session"]);
    // …and it leaves no conversation record this deployment could ever continue.
    expect(await store.list()).toEqual([]);
    expect(state.entries()).toEqual([]);
    expect((ephemeral.payload as { status?: string }).status).toBe("completed");
  });

  test("the requested mode is the mode sent, one feature_config per turn", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "auto" }, { answer: "thinking" }, { answer: "fast" });

    for (const [index, mode] of (["Auto", "Thinking", "Fast"] as const).entries()) {
      const result = await runTurn(provider, body({
        sessionId: "session-modes",
        threadId: "thread-modes",
        turnId: `turn-${index}`,
        userText: `turn ${index}`,
        reasoningEffort: mode,
      }));
      expect(result.events.at(-1)?.type).toBe("done");
      const message = (network.bodies[index]!["messages"] as Record<string, unknown>[])[0]!;
      expect(message["feature_config"]).toEqual({
        thinking_enabled: mode !== "Fast",
        auto_thinking: mode === "Auto",
        thinking_mode: mode,
        ...(mode !== "Fast" ? { thinking_format: "summary" } : {}),
        output_schema: "phase",
      });
    }
  });

  test("a mode the model does not offer is a 400 before anything is sent", async () => {
    const { provider, network } = composition();
    const result = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-bad-mode",
      userText: "hola",
      reasoningEffort: "Turbo",
    }));
    expect(result.status).toBe(400);
    const error = result.payload["error"] as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("unknown_reasoning_mode");
    expect(error?.message).toContain("Auto, Thinking, Fast");
    expect(network.chatNewCalls).toBe(0);
    expect(network.completionCalls).toBe(0);
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
    const response = await qwenChatResponsesRequest({ request, body: requestBody, provider });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBe("tools");
    // The tool definition is dropped; the one user turn is this conversation's install (header + text).
    expect(network.prompts).toEqual([`${INSTALL_HEADER}\n\nuse the weather tool`]);
    // The tool definition is nowhere in the provider payload; only the user's own text is.
    expect(JSON.stringify(network.bodies)).not.toContain("parameters");
  });

  test("an unknown model names the models this deployment serves", async () => {
    const { provider } = composition();
    const requestBody = { model: "qwen-chat/nope", input: [] };
    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await qwenChatResponsesRequest({ request, body: requestBody, provider });
    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toContain(MODEL_ROUTE);
  });
});

describe("issue #333 — the transport surfaces a model re-route", () => {
  test("a selected_model_id that differs from the requested model is logged, never hidden", async () => {
    const network = new ControlledNetwork();
    network.scripts.push({ answer: "answered", selectedModelId: "qwen3.8-max" });
    const diagnostics: QwenChatTurnDiagnostic[] = [];
    const answers: QwenChatTurnAnswer[] = [];
    const transport = createQwenChatTextTransport({
      session: controlledSession(network),
      model: MODEL_ID,
      mode: "Auto",
      onDiagnostic: event => diagnostics.push(event),
      onAnswer: answer => { answers.push(answer); },
    });
    const context: WebChatTextTransportContext = {
      identity: { bindingId: "binding", conversationKey: "conversation", turnId: "turn" },
      turn: { userText: "hola", model: MODEL_ID },
      epoch: 1,
      signal: new AbortController().signal,
    };
    await transport.ready(context);
    expect(await transport.submit(context)).toBe("accepted");
    const events = [];
    for await (const event of transport.stream(context)) events.push(event);
    expect(events.at(-1)?.type).toBe("completed");
    expect(answers[0]?.selectedModelId).toBe("qwen3.8-max");
    expect(diagnostics.some(event => event.stage === "model-rerouted")).toBe(true);
  });
});

/** A listener configuration that declares the provider, exactly like a real deployment. */
function listenerConfig(): never {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    webChat: { providers: { [QWEN_CHAT_PROVIDER_ID]: providerBlock() } },
  } as never;
}

describe("issue #333 — Qwen Chat through the real listener", () => {
  let network: ControlledNetwork;
  let provider: QwenChatProviderComposition;

  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-333-qwen-chat-listener-", { clearFreeHome: true });
    network = new ControlledNetwork();
    provider = composition(network).provider;
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("POST /v1/chat/completions streams a qwen-chat answer in the OpenAI wire shape", async () => {
    network.scripts.push({ answer: "Hola desde Qwen Chat" });
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-affinity": "issue-333-listener-session",
      },
      body: JSON.stringify({
        model: MODEL_ROUTE,
        stream: true,
        reasoning_effort: "Thinking",
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
      .toBe("Hola desde Qwen Chat");
    expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // The provider really ran the turn, and the caller's reasoning selection reached the payload. The
    // first physical message installed the deterministic project header plus only the user's text.
    expect(network.chatNewCalls).toBe(1);
    expect(network.prompts).toEqual([`${INSTALL_HEADER}\n\nhola`]);
    const message = (network.bodies[0]!["messages"] as Record<string, unknown>[])[0]!;
    expect((message["feature_config"] as Record<string, unknown>)["thinking_mode"]).toBe("Thinking");
  });

  test("a declared purpose header answers the turn without creating a chat", async () => {
    network.scripts.push({ answer: "A title" });
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-affinity": "issue-333-listener-session",
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
    expect(network.chatNewCalls).toBe(0);
    expect(network.completionCalls).toBe(1);
  });

  test("GET /v1/models lists the composed catalogue with the qwen-chat rows and modes", async () => {
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      models?: { slug?: string; supported_reasoning_levels?: { effort?: string }[] }[];
      data?: { id?: string }[];
    };
    const row = payload.models?.find(candidate => candidate.slug === MODEL_ROUTE);
    expect(row).toBeDefined();
    expect(row?.supported_reasoning_levels?.map(level => level.effort)).toEqual(["Auto", "Thinking", "Fast"]);
    // The OpenAI `data` array is additive and carries the same route id.
    expect(payload.data?.some(entry => entry.id === MODEL_ROUTE)).toBe(true);
  });

  test("POST /v1/chat/completions refuses an unknown mode with the valid labels", async () => {
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ROUTE,
        reasoning_effort: "Turbo",
        messages: [{ role: "user", content: "hola" }],
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toContain("Auto, Thinking, Fast");
    expect(network.chatNewCalls).toBe(0);
    expect(network.completionCalls).toBe(0);
  });

  test("an unauthenticated Qwen Chat session is a 401 naming the sign-in surface", async () => {
    const session: QwenChatRequestSession = {
      id: "issue-333-unauthenticated",
      async ready() {
        const { webChatError } = await import("../src/web-chat/core");
        throw webChatError(
          "AUTH_REQUIRED",
          "Qwen Chat has no verified session on this deployment. Sign in to Qwen Chat at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Chat\").",
          { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_SESSION_MISSING" },
        );
      },
      async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
        return await body(network.facility);
      },
      async close() {},
    };
    const unauthenticated = createQwenChatProvider({
      config: {
        ...defaultConfig(),
        webChat: { providers: { [QWEN_CHAT_PROVIDER_ID]: providerBlock() } },
      } as never,
      session,
      store: createMemoryConversationStore(),
      state: createMemoryQwenChatConversationState(),
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
    expect(payload.error?.code).toBe("QWEN_CHAT_SESSION_MISSING");
    // A refusal before submission sends nothing and creates nothing.
    expect(network.chatNewCalls).toBe(0);
    expect(network.completionCalls).toBe(0);
  });
});
