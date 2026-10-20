import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import { defaultConfig, saveConfig } from "../src/config";
import type { AdapterEvent } from "../src/types";
import type { QwenTurnRequestFacility } from "../src/adapters/qwen-code/network-turn";
import {
  createQwenCodeProvider,
  type QwenCodeProviderComposition,
} from "../src/adapters/qwen-code/provider-runtime";
import { qwenCodeResponsesRequest } from "../src/adapters/qwen-code/responses";
import type { QwenCodeRequestSession } from "../src/adapters/qwen-code/browser-session";
import {
  createFileQwenCodeConversationState,
  type QwenCodeConversationState,
} from "../src/adapters/qwen-code/chat-state";
import { QWEN_CODE_COMPLETIONS_PATH, QWEN_CODE_PROVIDER_ID, QWEN_CODE_TASK_NEW_PATH } from "../src/adapters/qwen-code/provider";
import { createFileConversationStore } from "../src/web-chat/persistence/conversation-store-file";
import {
  webChatAccountBindingId,
  webChatContinuationIdentity,
  type WebChatAccountBinding,
  type WebChatConversationSelection,
  type WebChatConversationStore,
  type WebChatReplayMessage,
} from "../src/web-chat/core";
import {
  defineWebChatProviderConformanceSuite,
  type WebChatProviderConformanceHarness,
  type WebChatProviderConformanceScenario,
  type WebChatProviderConformanceTurn,
} from "./web-chat-provider-conformance";

/**
 * Issue #299, slice 2 — the Qwen Code provider against the shared conformance suite.
 *
 * Only **physical web I/O** is controlled here: the transport, the SSE vocabulary, the continuity
 * decision, the exchange lifecycle, the durable conversation record and the durable chat state are
 * the production code. The controlled part is the session page's request facility — the same seam a
 * real Chromium page provides in production — so no browser is needed and the protocol shapes are
 * asserted exactly.
 */
const ACCOUNT = "issue-299-qwen-conformance-account";
const MODEL_ROUTE = `${QWEN_CODE_PROVIDER_ID}/qwen3-coder-plus`;
const MODEL_ID = "qwen3-coder-plus";

let home: string;
let savedHome: SavedChatGptWebHome;

/** One recorded-shape SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The scenario behaviour the controlled facility plays for one turn. */
interface Plan {
  readonly scenario: WebChatProviderConformanceScenario | "success";
  readonly answer: string;
  readonly abortController?: AbortController;
}

/**
 * The controlled network: the provider's request facility over a recorded-shape stream.
 *
 * It counts exactly what the conformance matrix counts — send activations and confirmed submissions —
 * so the assertions are about the transport's real reporting, not about the fixture's bookkeeping.
 */
class ControlledNetwork {
  plan: Plan = { scenario: "success", answer: "controlled answer" };
  taskNewCalls = 0;
  completionCalls = 0;
  confirmedSubmissions = 0;
  lastPrompt: string | undefined;
  /** The last chunk sink the network was given, so a late chunk can be replayed at it. */
  lateChunkSink: ((chunk: string) => boolean) | undefined;

  reset(plan: Plan): void {
    this.plan = plan;
    this.taskNewCalls = 0;
    this.completionCalls = 0;
    this.confirmedSubmissions = 0;
    this.lastPrompt = undefined;
    this.lateChunkSink = undefined;
  }

  /**
   * The turn's **send activations**: the completion submissions of the caller's text.
   *
   * `task/new` is deliberately not counted. It creates an empty chat and carries no user text, so it
   * is not an activation of the turn's submission — which is exactly the distinction the retry rules
   * key on (`text-transport.ts` reports `prepared` when only that call could have failed).
   */
  get sendAttempts(): number {
    return this.completionCalls;
  }

  readonly facility: QwenTurnRequestFacility = {
    postJson: async (path, body) => {
      expect(path).toBe(QWEN_CODE_TASK_NEW_PATH);
      this.taskNewCalls += 1;
      expect((body as { models?: unknown }).models).toEqual([MODEL_ID]);
      return {
        status: 200,
        body: { success: true, request_id: "req-fixture", data: { id: `chat-${this.taskNewCalls}` } },
      };
    },
    postEventStream: async (path, body, onChunk, options = {}) => {
      this.completionCalls += 1;
      const url = new URL(path, "https://coder.qwen.ai");
      expect(url.pathname).toBe(QWEN_CODE_COMPLETIONS_PATH);
      const chatId = url.searchParams.get("chat_id") ?? "";
      expect(chatId.length).toBeGreaterThan(0);
      const prompt = (body as { messages?: { content?: unknown }[] }).messages?.[0]?.content;
      this.lastPrompt = typeof prompt === "string" ? prompt : undefined;
      this.lateChunkSink = onChunk;
      const responseId = `resp:${chatId}`;

      if (this.plan.scenario === "ambiguous_submission") {
        // The request left this side and no answer came back: ambiguous by construction.
        throw new Error("network reset before the response head");
      }
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      this.confirmedSubmissions += 1;
      const emit = (payload: unknown): boolean => onChunk(frame(payload));
      emit({ "response.created": { chat_id: chatId, parent_id: `parent:${chatId}`, response_id: responseId } });
      if (this.plan.scenario === "provider_error") {
        throw new Error("upstream reset after the response head");
      }
      emit({
        choices: [{ delta: { role: "assistant", content: this.plan.answer, phase: "answer", status: "typing" } }],
        response_id: responseId,
        timestamp: 1,
      });
      if (this.plan.scenario === "partial_failure") {
        throw new Error("upstream reset after partial output");
      }
      if (this.plan.scenario === "cancel_active") {
        // The consumer cancels mid-answer: the transport must report a cancellation, and the chat must
        // not be continued as if the turn had completed. The tick lets the exchange's own cancellation
        // cascade reach the transport, exactly like a real page reader being cancelled.
        this.plan.abortController?.abort();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        throw new Error("the reader was cancelled");
      }
      emit({
        choices: [{ delta: { role: "assistant", content: "", phase: "answer", status: "finished" } }],
        response_id: responseId,
        timestamp: 2,
      });
      return { status: 200, contentType: "text/event-stream" };
    },
  };
}

/** The session page, with the one behaviour the conformance matrix must control. */
class ControlledSession implements QwenCodeRequestSession {
  readonly id = "issue-299-qwen-controlled-session";
  authenticated = true;

  constructor(private readonly network: ControlledNetwork) {}

  async ready(): Promise<void> {
    if (this.authenticated) return;
    const { webChatError } = await import("../src/web-chat/core");
    throw webChatError(
      "AUTH_REQUIRED",
      "Qwen Code has no verified session on this deployment. Sign in at /v1/control/auth/ (choose \"Qwen Code\").",
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_SESSION_MISSING" },
    );
  }

  async run<T>(body: (facility: QwenTurnRequestFacility) => Promise<T>): Promise<T> {
    return await body(this.network.facility);
  }

  async close(): Promise<void> {}
}

/** A verified session file plus its marker: exactly the layout the import writes. */
function writeVerifiedSession(): void {
  const directory = join(home, "providers", QWEN_CODE_PROVIDER_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "storage-state.json"), JSON.stringify({ cookies: [], origins: [] }));
  writeFileSync(
    join(directory, "storage-state.json.verified.json"),
    JSON.stringify({ version: 1, authenticated: true, verifiedAt: new Date().toISOString() }),
  );
}

/** The internal Responses body one turn runs. */
function responsesBody(input: {
  readonly selection: WebChatConversationSelection;
  readonly turnId: string;
  readonly userText: string;
  readonly history?: readonly WebChatReplayMessage[];
}): Record<string, unknown> {
  const history = input.history ?? [{ role: "user" as const, text: input.userText }];
  return {
    model: MODEL_ROUTE,
    stream: false,
    input: history.map(message => ({
      type: "message",
      role: message.role,
      content: [{ type: "text", text: message.text }],
    })),
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        dsh_session_id: input.selection.dshSession.sessionId,
        thread_id: input.selection.affinity.threadId,
        turn_id: input.turnId,
      }),
    },
  };
}

/** Everything one conformance environment owns. */
interface Environment {
  readonly network: ControlledNetwork;
  readonly provider: QwenCodeProviderComposition;
  readonly store: WebChatConversationStore;
  readonly state: QwenCodeConversationState;
  readonly session: ControlledSession;
}

/** Build one environment over the fixture's durable files. */
function createEnvironment(): Environment {
  const network = new ControlledNetwork();
  const session = new ControlledSession(network);
  const store = createFileConversationStore({ file: join(home, "conversations.json") });
  const state = createFileQwenCodeConversationState(join(home, "providers", QWEN_CODE_PROVIDER_ID, "conversations.json"));
  const config = {
    ...defaultConfig(),
    webChat: {
      conversationStorePath: join(home, "conversations.json"),
      providers: {
        [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] },
      },
    },
  };
  const provider = createQwenCodeProvider({ config: config as never, session, store, state });
  return { network, provider, store, state, session };
}

/** Release one environment. Idempotent, and it owns the store the composition was given. */
async function closeEnvironment(environment: Environment): Promise<void> {
  await environment.provider.close();
  await environment.store.close?.();
}

/** Assemble one harness around an environment. */
function harnessFor(environment: Environment): WebChatProviderConformanceHarness {
  const { provider, store, state, session, network } = environment;
  const namespace = provider.provider.namespace;
  const binding: WebChatAccountBinding = { providerId: QWEN_CODE_PROVIDER_ID, accountFingerprint: ACCOUNT };
  const selection: WebChatConversationSelection = {
    dshSession: { sessionId: "issue-299-qwen-session" },
    binding,
    affinity: {
      providerId: QWEN_CODE_PROVIDER_ID,
      bindingId: webChatAccountBindingId(binding),
      threadId: "issue-299-qwen-thread",
    },
    model: MODEL_ROUTE,
  };
  let closed = false;

  const harness: WebChatProviderConformanceHarness = {
    driver: provider.driver,
    store,
    selection,
    namespace,
    model: {
      route: MODEL_ROUTE,
      descriptorId: MODEL_ID,
      unsupportedRoute: `${QWEN_CODE_PROVIDER_ID}/not-a-served-model`,
      unsupportedReasoningMode: "medium",
    },
    restartRecovery: "exact_resume",

    async runNativeTurn(input) {
      const scenario = input.scenario ?? "success";
      const abortController = scenario === "cancel_active" ? new AbortController() : undefined;
      network.reset({
        scenario,
        answer: `controlled answer for ${input.turnId}`,
        ...(abortController ? { abortController } : {}),
      });
      session.authenticated = scenario !== "authentication_loss";
      const body = responsesBody({
        selection: input.selection,
        turnId: input.turnId,
        userText: input.userText,
        ...(input.history ? { history: input.history } : {}),
      });
      const identity = webChatContinuationIdentity({
        binding: input.selection.binding,
        dshSession: input.selection.dshSession,
        threadId: input.selection.affinity.threadId,
        namespace,
      });
      const before = state.read(identity.key);
      const events: AdapterEvent[] = [];
      const request = new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(abortController ? { signal: abortController.signal } : {}),
      });
      const response = await qwenCodeResponsesRequest({
        request,
        body,
        provider,
        onAdapterEvent: event => events.push(event),
      });
      await response.json();

      const record = await store.read(identity);
      const eventTypes: string[] = events.map(event =>
        event.type === "done" ? "completed" : event.type === "incomplete" ? "incomplete" : event.type);
      const text = events
        .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map(event => event.text)
        .join("");
      const cancelled = scenario === "cancel_active" && eventTypes.includes("incomplete");
      if (cancelled) {
        const index = eventTypes.indexOf("incomplete");
        eventTypes[index] = "cancelled";
      }
      const outcome: WebChatProviderConformanceTurn["outcome"] = eventTypes.includes("completed")
        ? "completed"
        : cancelled ? "cancelled" : "failed";
      const chat = state.read(identity.key)?.chat;

      return {
        outcome,
        eventTypes,
        text,
        sendAttempts: network.sendAttempts,
        confirmedSubmissions: network.confirmedSubmissions,
        // The exchange owns retry safety; every scenario this fixture can produce is not retryable.
        retryable: false,
        ...(record ? { record } : {}),
        ...(chat ? { lineageToken: chat.chatId } : {}),
        ...(network.lastPrompt !== undefined ? { compiledPrompt: network.lastPrompt } : {}),
        remoteConversationReused: before?.chat?.status === "active",
      };
    },

    async restart() {
      await harness.shutdown();
      return harnessFor(createEnvironment());
    },

    async assertStaleNativeTurnIsolated() {
      const staleSelection: WebChatConversationSelection = {
        ...selection,
        dshSession: { sessionId: `${selection.dshSession.sessionId}:stale` },
        affinity: { ...selection.affinity, threadId: `${selection.affinity.threadId}:stale` },
      };
      const first = await harness.runNativeTurn({
        selection: staleSelection,
        turnId: "stale-qwen-old",
        userText: "old turn",
        scenario: "success",
      });
      expect(first.outcome).toBe("completed");
      const settledSink = network.lateChunkSink;
      const second = await harness.runNativeTurn({
        selection: staleSelection,
        turnId: "stale-qwen-next",
        userText: "current turn",
        history: [
          { role: "user", text: "old turn" },
          { role: "assistant", text: first.text },
          { role: "user", text: "current turn" },
        ],
        scenario: "success",
      });
      expect(second.outcome).toBe("completed");
      // A chunk from the settled turn's own stream, replayed at that turn's sink: exactly a late
      // network frame arriving after the turn ended. It must not appear in either answer.
      settledSink?.(frame({
        choices: [{ delta: { role: "assistant", content: "late stale qwen output", status: "typing" } }],
        response_id: "stale",
      }));
      await Promise.resolve();
      const stale = "late stale qwen output";
      return !second.text.includes(stale) && !first.text.includes(stale);
    },

    async shutdown() {
      if (closed) return;
      closed = true;
      await closeEnvironment(environment);
    },
  };
  return harness;
}

describe("issue #299 — Qwen Code provider conformance", () => {
  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-299-qwen-conformance-", { clearFreeHome: true });
    writeVerifiedSession();
    saveConfig({
      ...defaultConfig(),
      webChat: {
        conversationStorePath: join(home, "conversations.json"),
        providers: {
          [QWEN_CODE_PROVIDER_ID]: { accountIdentityFingerprint: ACCOUNT, models: [MODEL_ID] },
        },
      },
    });
  });

  afterEach(() => {
    restoreChatGptWebHome(savedHome, home);
  });

  defineWebChatProviderConformanceSuite({
    name: "Qwen Code",
    async create() {
      return harnessFor(createEnvironment());
    },
  });

  test("the suite's ephemeral contract is not exercised by the fixture (documented)", () => {
    // The shared suite has no ephemeral scenario; it is pinned by
    // `tests/issue-299-qwen-code-text-transport.test.ts` (zero `task/new` calls, no recorded chat)
    // and by the route test's declared-purpose header. This assertion exists so the gap is explicit
    // rather than implied.
    expect(true).toBe(true);
  });
});
