import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import { buildPublicModelCatalog } from "../src/model-catalog";
import type { AdapterEvent } from "../src/types";
import {
  DEEPSEEK_WEB_COMPLETION_PATH,
  DEEPSEEK_WEB_POW_CHALLENGE_PATH,
  DEEPSEEK_WEB_PROVIDER_ID,
  DEEPSEEK_WEB_SESSION_CREATE_PATH,
  createDeepSeekWebProvider,
  createDeepSeekWebTextTransport,
  createMemoryDeepSeekConversationState,
  deepSeekWebResponsesRequest,
  unprovenDeepSeekProofOfWork,
  type DeepSeekProofOfWork,
  type DeepSeekProofOfWorkSolver,
  type DeepSeekRequestSession,
  type DeepSeekTurnAnswer,
  type DeepSeekTurnDiagnostic,
  type DeepSeekTurnRequestFacility,
  type DeepSeekWebProviderComposition,
} from "../src/adapters/deepseek-web";
import {
  createMemoryConversationStore,
  webChatContinuationIdentity,
  type WebChatConversationStore,
} from "../src/web-chat/core";
import type { WebChatTextTransportContext } from "../src/web-chat/transport";

/**
 * The DeepSeek Web route.
 *
 * The unit half drives the real composition (continuity decision, exchange, durable record, session
 * state) with a controlled network and an **injected proof-of-work solver** — production drives the
 * page's own worker (`tests/deepseek-web-pow.test.ts`), and the fixture here keeps the route test
 * offline. The integration half runs the real listener and proves what a caller observes: the
 * configured slug streams in the OpenAI wire shape, an unconfigured provider answers with its honest
 * typed error, and `/v1/models` lists the rows only when configured.
 *
 * No test claims a live authenticated DeepSeek turn works: that needs a verified session
 * (`doc/deepseek-web.md` §7), which this repository cannot fabricate.
 */
const CONTROL_TOKEN = "deepseek-web-route-control-token";
const MODEL_TYPE = "default";
const MODEL_ROUTE = `${DEEPSEEK_WEB_PROVIDER_ID}/${MODEL_TYPE}`;
const ACCOUNT = "deepseek-web-route-account";
/**
 * The measured proof header (one signed-in completion). The value is still a fixture — the solver
 * seam is injected here — but the *name* is the capture's, so the route pins the real wiring point.
 */
const POW_HEADER = "x-ds-pow-response";

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

/** One named SSE event block. */
function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** One unnamed `data:` block — the recorded delta case. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** One scripted turn. */
interface Script {
  readonly answer?: string;
  /** The provider refuses the recorded session: it no longer exists. */
  readonly rejectSession?: boolean;
  /** The `model_type` the provider says answered (a re-route). */
  readonly reportedModel?: string;
}

/**
 * The controlled network: the recorded shapes, driven by a queue of per-turn scripts.
 *
 * `requestProofOfWork` is the injected seam. Its presence is what makes the protocol observable at
 * all; production has no implementation of it.
 */
class ControlledNetwork {
  sessionCreates = 0;
  completionCalls = 0;
  powChallenges = 0;
  readonly bodies: Record<string, unknown>[] = [];
  readonly prompts: string[] = [];
  readonly proofs: (DeepSeekProofOfWork | undefined)[] = [];
  readonly scripts: Script[] = [];

  private readonly proof: DeepSeekProofOfWorkSolver;

  constructor(proof?: DeepSeekProofOfWorkSolver) {
    this.proof = proof ?? (async () => ({
      header: POW_HEADER,
      value: `proof-${this.completionCalls + 1}`,
    }));
  }

  readonly facility: DeepSeekTurnRequestFacility = {
    postJson: async (path, body) => {
      if (path === DEEPSEEK_WEB_POW_CHALLENGE_PATH) {
        this.powChallenges += 1;
        expect(body).toEqual({ target_path: DEEPSEEK_WEB_COMPLETION_PATH });
        return {
          status: 200,
          contentType: "application/json",
          body: {
            code: 0,
            msg: "",
            data: { biz_data: { challenge: { challenge: "synthetic", difficulty: 4, expire_after: 300 } } },
          },
          bodyText: "",
          truncated: false,
        };
      }
      if (path === DEEPSEEK_WEB_SESSION_CREATE_PATH) {
        this.sessionCreates += 1;
        // The measured create shape: the id lives at `data.biz_data.chat_session.id`.
        return {
          status: 200,
          contentType: "application/json",
          body: {
            code: 0,
            msg: "",
            data: {
              biz_code: 0,
              biz_msg: "",
              biz_data: { chat_session: { id: `session-${this.sessionCreates}`, model_type: MODEL_TYPE } },
            },
          },
          bodyText: "",
          truncated: false,
        };
      }
      throw new Error(`unexpected DeepSeek JSON path ${path}`);
    },

    postEventStream: async (_path, body, onChunk, options = {}) => {
      this.completionCalls += 1;
      this.bodies.push(body as Record<string, unknown>);
      this.proofs.push(options.proof);
      const prompt = (body as { prompt?: unknown }).prompt;
      if (typeof prompt === "string") this.prompts.push(prompt);
      const script = this.scripts.shift() ?? { answer: "controlled answer" };
      if (script.rejectSession === true) {
        // A recorded-shape refusal: the session the caller asked to continue does not exist any more.
        return {
          status: 404,
          contentType: "application/json",
          bodyText: JSON.stringify({ code: 0, msg: "", data: { biz_code: 404, biz_msg: "SESSION_NOT_FOUND" } }),
        };
      }
      const messageId = `message-${this.completionCalls}`;
      const reportedModel = script.reportedModel ?? MODEL_TYPE;
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      onChunk(event("ready", {
        response_message_id: messageId,
        request_message_id: `request-${this.completionCalls}`,
        model_type: reportedModel,
      }));
      onChunk(event("update_session", { updated_at: 1_700_000_000 }));
      // The measured shape: the whole response document first (a THINK fragment already open), then
      // an unnamed `{v}` patch, then the RESPONSE fragment appended to `fragments`, then its content
      // addressed as `-1` — and the turn ends on `close`, not `finish`.
      onChunk(frame({
        v: {
          response: {
            message_id: 2,
            parent_id: 1,
            model: "",
            role: "ASSISTANT",
            thinking_enabled: false,
            status: "WIP",
            fragments: [{ id: 1, type: "THINK", content: "private reasoning", elapsed_secs: null }],
          },
        },
      }));
      // The operation/path are inherited only after a frame sets them (the capture's order).
      onChunk(frame({ p: "response/fragments/-1/content", o: "APPEND", v: " private" }));
      onChunk(frame({ v: " reasoning" }));
      onChunk(frame({
        p: "response/fragments",
        o: "APPEND",
        v: [{ id: 2, type: "RESPONSE", content: "", references: [], stage_id: 1 }],
      }));
      const answer = script.answer ?? "controlled answer";
      const half = Math.max(1, Math.floor(answer.length / 2));
      onChunk(frame({ p: "response/fragments/-1/content", o: "APPEND", v: answer.slice(0, half) }));
      onChunk(frame({ p: "response/fragments/-1/content", o: "APPEND", v: answer.slice(half) }));
      onChunk(event("close", { click_behavior: "none", auto_resume: false }));
      return { status: 200, contentType: "text/event-stream" };
    },

    requestProofOfWork: request => this.proof(request),
  };
}

/** The session over a controlled network. */
function controlledSession(network: ControlledNetwork): DeepSeekRequestSession {
  return {
    id: "deepseek-web-route-session",
    async ready() {},
    async run<T>(body: (facility: DeepSeekTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(network.facility);
    },
    async close() {},
  };
}

interface Composition {
  readonly provider: DeepSeekWebProviderComposition;
  readonly store: WebChatConversationStore;
  readonly state: ReturnType<typeof createMemoryDeepSeekConversationState>;
  readonly network: ControlledNetwork;
}

/** The configuration block a real deployment would use. */
function providerBlock(): Record<string, unknown> {
  return {
    accountIdentityFingerprint: ACCOUNT,
    modelTypes: [{ id: MODEL_TYPE, label: "DeepSeek Default" }],
  };
}

/** A configuration that declares the provider with NO model_type: the honest "serve nothing". */
function emptyConfig(): never {
  return { ...defaultConfig() } as never;
}

/** Build one composition over a controlled network and in-memory durable state. */
function composition(
  network = new ControlledNetwork(),
  config: never = {
    ...defaultConfig(),
    webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: providerBlock() } },
  } as never,
): Composition {
  const store = createMemoryConversationStore();
  const state = createMemoryDeepSeekConversationState();
  const provider = createDeepSeekWebProvider({
    config,
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
  readonly model?: string;
}): Record<string, unknown> {
  const history = input.history ?? [{ role: "user" as const, text: input.userText }];
  return {
    model: input.model ?? MODEL_ROUTE,
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
  provider: DeepSeekWebProviderComposition,
  requestBody: Record<string, unknown>,
): Promise<{ readonly events: AdapterEvent[]; readonly status: number; readonly payload: Record<string, unknown> }> {
  const events: AdapterEvent[] = [];
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const response = await deepSeekWebResponsesRequest({
    request,
    body: requestBody,
    provider,
    onAdapterEvent: adapterEvent => events.push(adapterEvent),
  });
  const payload = await response.json() as Record<string, unknown>;
  return { events, status: response.status, payload };
}

describe("deepseek-web — one conversation key, one chat session and one parent cursor", () => {
  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("deepseek-web-route-", { clearFreeHome: true });
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("a second turn continues the same session and sends the previous answer as parent_message_id", async () => {
    const { provider, store, state, network } = composition();
    network.scripts.push({ answer: "first answer" }, { answer: "second answer" });

    const first = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola",
    }));
    expect(first.events.at(-1)?.type).toBe("done");
    expect(network.sessionCreates).toBe(1);
    expect(network.powChallenges).toBe(1);
    expect(network.bodies[0]).toMatchObject({
      chat_session_id: "session-1",
      parent_message_id: null,
      model_type: MODEL_TYPE,
      prompt: "hola",
      thinking_enabled: false,
      search_enabled: false,
    });
    // The injected proof really travelled with the completion — and only with it.
    expect(network.proofs[0]).toEqual({ header: POW_HEADER, value: "proof-1" });

    const second = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-2", userText: "again",
    }));
    expect(second.events.at(-1)?.type).toBe("done");
    // No second session: the recorded one was continued, in the same conversation.
    expect(network.sessionCreates).toBe(1);
    expect(network.bodies[1]).toMatchObject({
      chat_session_id: "session-1",
      parent_message_id: "message-1",
      prompt: "again",
    });
    // Only the new user text is sent on a continuation: the provider session is the history.
    expect(network.prompts).toEqual(["hola", "again"]);

    const identity = webChatContinuationIdentity({
      binding: { providerId: DEEPSEEK_WEB_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    const record = await store.read(identity);
    expect(record?.checkpoint).toBe("confirmed");
    expect(record?.generation).toBe(1);
    expect(record?.lastConfirmedTurn?.turnId).toBe("turn-2");
    expect(state.read(identity.key)?.session).toMatchObject({
      chatSessionId: "session-1",
      parentMessageId: "message-2",
      responseMessageId: "message-2",
      modelType: MODEL_TYPE,
      status: "active",
    });
  });

  test("a different conversation gets a different session", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "a" }, { answer: "b" }, { answer: "c" });

    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "t1", userText: "one" }));
    await runTurn(provider, body({ sessionId: "session-b", threadId: "thread-b", turnId: "t2", userText: "two" }));
    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "t3", userText: "three" }));

    expect(network.sessionCreates).toBe(2);
    expect(network.bodies.map(entry => entry["chat_session_id"])).toEqual(["session-1", "session-2", "session-1"]);
    expect(network.bodies.map(entry => entry["parent_message_id"])).toEqual([null, null, "message-1"]);
  });

  test("a session the provider no longer accepts is a typed loss, and recovery is an explicit replay", async () => {
    const { provider, store, state, network } = composition();
    network.scripts.push({ answer: "first" }, { rejectSession: true }, { answer: "rebuilt" });

    const first = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola",
    }));
    expect(first.events.at(-1)?.type).toBe("done");

    const lost = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-2", userText: "again",
    }));
    expect(lost.events.at(-1)?.type).toBe("error");
    const failure = lost.events.at(-1) as Extract<AdapterEvent, { type: "error" }>;
    expect(failure.code).toBe("DEEPSEEK_SESSION_LOST");
    expect(failure.status).toBe(409);

    const identity = webChatContinuationIdentity({
      binding: { providerId: DEEPSEEK_WEB_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    // The session is recorded as lost; nothing silently continues it.
    expect(state.read(identity.key)?.session?.status).toBe("lost");

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
    // The recovery is explicit and visible: a NEW session, and a generation that advanced by one.
    expect(network.sessionCreates).toBe(2);
    expect(network.bodies[2]?.["chat_session_id"]).toBe("session-2");
    // The canonical history was compiled into the rebuilt conversation.
    expect(network.prompts[2]).toContain("User: hola\nAssistant: first\nUser: again please");
    const record = await store.read(identity);
    expect(record?.generation).toBe(2);
    expect(record?.checkpoint).toBe("confirmed");
  });

  test("a declared housekeeping purpose is answered without creating or recording any session", async () => {
    const { provider, store, state, network } = composition();
    network.scripts.push({ answer: "Session about DeepSeek" });

    const ephemeral = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "title-1",
      userText: "name this session",
      purpose: "session-title",
    }));

    expect(ephemeral.events.at(-1)?.type).toBe("done");
    // The rule: housekeeping never creates a session, so it never appears in the operator's account.
    expect(network.sessionCreates).toBe(0);
    expect(network.completionCalls).toBe(1);
    // The proof is still required — the provider admits the turn, not the session.
    expect(network.powChallenges).toBe(1);
    // The answer streamed into a process-generated session id, not the caller's conversation.
    expect(network.bodies[0]?.["chat_session_id"]).not.toBe("session-1");
    expect(typeof network.bodies[0]?.["chat_session_id"]).toBe("string");
    // …and it leaves no conversation record this deployment could ever continue.
    expect(await store.list()).toEqual([]);
    expect(state.entries()).toEqual([]);
    expect((ephemeral.payload as { status?: string }).status).toBe("completed");
  });

  test("a proof of work this build cannot produce fails the turn before anything is created", async () => {
    const network = new ControlledNetwork(unprovenDeepSeekProofOfWork());
    network.scripts.push({ answer: "never sent" });
    const { provider, store, state } = composition(network);

    const result = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola",
    }));

    expect(result.events.at(-1)?.type).toBe("error");
    const failure = result.events.at(-1) as Extract<AdapterEvent, { type: "error" }>;
    expect(failure.code).toBe("DEEPSEEK_POW_UNAVAILABLE");
    expect(failure.status).toBe(503);
    expect(failure.message).toContain("proof of work");
    // Nothing of the caller's turn was sent, and no provider session was left behind.
    expect(network.powChallenges).toBe(1);
    expect(network.sessionCreates).toBe(0);
    expect(network.completionCalls).toBe(0);
    // The core created a conversation epoch, but no provider session was ever recorded for it.
    expect(state.entries().every(entry => entry.session === undefined)).toBe(true);
    // The core's own record stays visibly unconfirmed (it is never dressed up as a confirmed turn),
    // which is what makes the next turn an explicit replay instead of a silent reuse.
    const identity = webChatContinuationIdentity({
      binding: { providerId: DEEPSEEK_WEB_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    expect((await store.read(identity))?.checkpoint).toBe("unconfirmed");
  });

  test("an authentication refusal is the provider's own category, mapped from the envelope", async () => {
    const network = new ControlledNetwork();
    const { provider, store, state } = composition(network);
    // The session create answers the recorded anonymous shape.
    network.facility.postJson = async path => {
      if (path === DEEPSEEK_WEB_POW_CHALLENGE_PATH) {
        return {
          status: 200,
          contentType: "application/json",
          body: { code: 0, data: { biz_data: { challenge: { challenge: "synthetic", difficulty: 4 } } } },
          bodyText: "",
          truncated: false,
        };
      }
      return {
        status: 200,
        contentType: "application/json",
        body: { code: 40003, msg: "INVALID_TOKEN", data: null },
        bodyText: "",
        truncated: false,
      };
    };

    const result = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola",
    }));

    expect(result.events.at(-1)?.type).toBe("error");
    const failure = result.events.at(-1) as Extract<AdapterEvent, { type: "error" }>;
    expect(failure.status).toBe(401);
    expect(failure.errorType).toBe("authentication_error");
    expect(failure.code).toBe("DEEPSEEK_INVALID_TOKEN");
    expect(failure.message).toContain("auth import --provider deepseek-web");
    expect(network.completionCalls).toBe(0);
    expect(state.entries().every(entry => entry.session === undefined)).toBe(true);
    const identity = webChatContinuationIdentity({
      binding: { providerId: DEEPSEEK_WEB_PROVIDER_ID, accountFingerprint: ACCOUNT },
      dshSession: { sessionId: "session-a" },
      threadId: "thread-a",
      namespace: provider.provider.namespace,
    });
    expect((await store.read(identity))?.checkpoint).toBe("unconfirmed");
  });

  test("a selected reasoning level is a 400 that says this provider has none", async () => {
    const { provider, network } = composition();
    const result = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola", reasoningEffort: "Thinking",
    }));
    expect(result.status).toBe(400);
    const error = result.payload["error"] as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("unknown_reasoning_mode");
    expect(error?.message).toContain("thinking_enabled");
    expect(network.powChallenges).toBe(0);
    expect(network.completionCalls).toBe(0);
  });

  test("a capability declaration is discarded and declared, never forwarded", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "no tools here" });
    const requestBody = body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-tools", userText: "use the weather tool",
    });
    requestBody["tools"] = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }];

    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await deepSeekWebResponsesRequest({ request, body: requestBody, provider });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBe("tools");
    expect(network.prompts).toEqual(["use the weather tool"]);
    expect(JSON.stringify(network.bodies)).not.toContain("parameters");
  });

  test("with nothing configured the provider answers with its honest typed error", async () => {
    const network = new ControlledNetwork();
    const { provider } = composition(network, emptyConfig());
    expect(provider.catalogue).toEqual([]);
    expect(provider.modelOf(MODEL_ROUTE)).toBe(MODEL_TYPE);

    const result = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola",
    }));

    expect(result.status).toBe(400);
    const error = result.payload["error"] as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("not_configured");
    expect(error?.message).toContain("modelTypes");
    expect(error?.message).toContain("signed-in session");
    expect(network.powChallenges).toBe(0);
    expect(network.sessionCreates).toBe(0);
  });

  test("an unknown model_type on a configured deployment names the ones it serves", async () => {
    const { provider, network } = composition();
    const result = await runTurn(provider, body({
      sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola",
      model: `${DEEPSEEK_WEB_PROVIDER_ID}/nope`,
    }));
    expect(result.status).toBe(400);
    const error = result.payload["error"] as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("unknown_model");
    expect(error?.message).toContain(MODEL_ROUTE);
    expect(network.completionCalls).toBe(0);
  });
});

describe("deepseek-web — the transport surfaces a re-routed model", () => {
  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("deepseek-web-route-reroute-", { clearFreeHome: true });
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("a ready.model_type that differs from the requested one is logged, never hidden", async () => {
    const network = new ControlledNetwork();
    network.scripts.push({ answer: "answered", reportedModel: "expert" });
    const diagnostics: DeepSeekTurnDiagnostic[] = [];
    const answers: DeepSeekTurnAnswer[] = [];
    const transport = createDeepSeekWebTextTransport({
      session: controlledSession(network),
      modelType: MODEL_TYPE,
      thinking: false,
      search: false,
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      onAnswer: answer => { answers.push(answer); },
    });
    const context: WebChatTextTransportContext = {
      identity: { bindingId: "binding", conversationKey: "conversation", turnId: "turn" },
      turn: { userText: "hola", model: MODEL_TYPE },
      epoch: 1,
      signal: new AbortController().signal,
    };
    await transport.ready(context);
    expect(await transport.submit(context)).toBe("accepted");
    const events = [];
    for await (const adapterEvent of transport.stream(context)) events.push(adapterEvent);
    expect(events.at(-1)?.type).toBe("completed");
    expect(answers[0]?.modelType).toBe("expert");
    expect(answers[0]?.termination).toBe("close");
    expect(diagnostics.some(diagnostic => diagnostic.stage === "model-rerouted")).toBe(true);
  });
});

/** A listener configuration that declares the provider, exactly like a real deployment. */
function listenerConfig(): never {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: providerBlock() } },
  } as never;
}

describe("deepseek-web — through the real listener", () => {
  let network: ControlledNetwork;
  let provider: DeepSeekWebProviderComposition;

  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("deepseek-web-listener-", { clearFreeHome: true });
    network = new ControlledNetwork();
    provider = composition(network).provider;
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  test("POST /v1/chat/completions streams a deepseek-web answer in the OpenAI wire shape", async () => {
    network.scripts.push({ answer: "Hola desde DeepSeek" });
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-affinity": "deepseek-listener-session" },
      body: JSON.stringify({ model: MODEL_ROUTE, stream: true, messages: [{ role: "user", content: "hola" }] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const chunks = text.split("\n\n")
      .filter(frame => frame.startsWith("data: "))
      .map(frame => frame.slice("data: ".length))
      .filter(payload => payload !== "[DONE]")
      .map(payload => JSON.parse(payload) as {
        choices?: { delta?: { role?: string; content?: string }; finish_reason?: string | null }[];
      });
    expect(chunks[0]?.choices?.[0]?.delta?.role).toBe("assistant");
    expect(chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.content ?? "").join(""))
      .toBe("Hola desde DeepSeek");
    expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(network.sessionCreates).toBe(1);
    expect(network.prompts).toEqual(["hola"]);
  });

  test("a declared purpose header answers the turn without creating a session", async () => {
    network.scripts.push({ answer: "A title" });
    const server = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-affinity": "deepseek-listener-session",
        "x-dsh-turn-purpose": "session-title",
      },
      body: JSON.stringify({ model: MODEL_ROUTE, messages: [{ role: "user", content: "name this session" }] }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    expect(payload.choices?.[0]?.message?.content).toBe("A title");
    expect(network.sessionCreates).toBe(0);
    expect(network.completionCalls).toBe(1);
  });

  test("GET /v1/models lists the configured rows only", async () => {
    const configured = startServer(listenerConfig(), { webChatProviders: [provider] } as never);
    running.push(configured);
    const listed = await (await fetch(`http://127.0.0.1:${configured.port}/v1/models`)).json() as {
      models?: { slug?: string; supported_reasoning_levels?: unknown[]; input_modalities?: string[] }[];
      data?: { id?: string }[];
    };
    const row = listed.models?.find(candidate => candidate.slug === MODEL_ROUTE);
    expect(row).toBeDefined();
    // No invented reasoning menu and no invented context window.
    expect(row?.supported_reasoning_levels).toEqual([]);
    expect(row?.input_modalities).toEqual(["text"]);
    expect(listed.data?.some(entry => entry.id === MODEL_ROUTE)).toBe(true);
  });

  test("nothing configured means no rows, and a request answers with the honest error", async () => {
    const unconfiguredNetwork = new ControlledNetwork();
    const unconfigured = composition(unconfiguredNetwork, emptyConfig()).provider;
    // The catalogue is composed from configuration, not from a session: no block, no rows.
    expect((buildPublicModelCatalog(emptyConfig()) as { models?: { slug?: string }[] }).models
      ?.some(row => row.slug?.startsWith(`${DEEPSEEK_WEB_PROVIDER_ID}/`))).toBe(false);

    const server = startServer(emptyConfig(), { webChatProviders: [unconfigured] } as never);
    running.push(server);

    const listed = await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json() as {
      models?: { slug?: string }[];
    };
    expect(listed.models?.some(row => row.slug?.startsWith(`${DEEPSEEK_WEB_PROVIDER_ID}/`))).toBe(false);

    // The chat-completions surface refuses at the service's own catalogue layer, which is the routing
    // authority: the model is not advertised, so it is not accepted.
    const chat = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ROUTE, messages: [{ role: "user", content: "hola" }] }),
    });
    expect(chat.status).toBe(400);
    const chatPayload = await chat.json() as { error?: { message?: string } };
    expect(chatPayload.error?.message).toContain("Unknown model");
    expect(chatPayload.error?.message).toContain(`${DEEPSEEK_WEB_PROVIDER_ID}/`);

    // `/v1/responses` resolves the route through the provider composition, so the provider itself
    // answers — with the reason no rows exist, not a generic refusal.
    const responsesSurface = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ROUTE, input: "hola" }),
    });
    expect(responsesSurface.status).toBe(400);
    const payload = await responsesSurface.json() as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe("not_configured");
    expect(payload.error?.message).toContain("modelTypes");
    expect(payload.error?.message).toContain("signed-in session");
    // Nothing was sent to the provider on either surface.
    expect(unconfiguredNetwork.powChallenges).toBe(0);
    expect(unconfiguredNetwork.completionCalls).toBe(0);
  });
});
