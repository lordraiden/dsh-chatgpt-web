import { afterEach, beforeEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chatGptWebChatAccountBindingFor,
  chatGptWebExecutionNamespace,
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import { createChatGptWebDriver } from "../src/adapters/chatgpt-web/chatgpt-driver";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_PROVIDER_ID } from "../src/adapters/chatgpt-web/llm-adapter";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { webChatAccountBindingId, webChatContinuationIdentity, type WebChatReplayMessage } from "../src/web-chat/core";
import { defaultConfig, saveConfig } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import {
  defineWebChatProviderConformanceSuite,
  type WebChatProviderConformanceHarness,
  type WebChatProviderConformanceScenario,
  type WebChatProviderConformanceTurn,
} from "./web-chat-provider-conformance";

const ACCOUNT = "issue-194-conformance-account";
const MODEL_ROUTE = "chatgpt-web/luna";
const MODEL_ID = "luna";

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

function providerConfig(): CodexProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:17841",
    chatgptWeb: {
      accountIdentityFingerprint: ACCOUNT,
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      storageStatePath: join(home, "browser-state.json"),
      chromeExecutablePath: "/usr/bin/chromium",
      brokerSocketPath: join(home, "turn-broker.sock"),
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
      capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
      experimentalBiggerContext: false,
    },
  } as unknown as CodexProviderConfig;
}

interface SurfaceRun {
  readonly turn: WebSurfaceTurn;
  readonly turnId?: string;
  readonly prompt: string;
  readonly lineageToken?: string;
  readonly remoteConversationReused: boolean;
  sendAttempts: number;
  confirmedSubmissions: number;
}

interface SurfacePlan {
  readonly scenario: WebChatProviderConformanceScenario;
  readonly turnId?: string;
  readonly answer: string;
  readonly error?: ChatGptWebAdapterError;
  readonly abortController?: AbortController;
}

/** Browser I/O only; adapter hooks, prompt compilation and continuity remain production code. */
class ControlledSurface {
  readonly runs: SurfaceRun[] = [];
  private readonly plans: SurfacePlan[] = [];
  private previousConversationKey: string | undefined;

  enqueue(plan: SurfacePlan): void {
    this.plans.push(plan);
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const plan = this.plans.shift() ?? { scenario: "success", answer: "controlled answer" };
        const reused = !!turn.conversationKey && turn.conversationKey === this.previousConversationKey;
        await turn.onPreparedSelected?.(reused);
        const prepare = reused ? turn.prepareResume : turn.prepare;
        if (!prepare) throw new Error("reused ChatGPT surface has no continuation prompt");
        const compiled = await prepare();
        try {
          const run: SurfaceRun = {
            turn,
            ...(plan.turnId !== undefined ? { turnId: plan.turnId } : {}),
            prompt: compiled.text,
            ...(turn.conversationKey !== undefined ? { lineageToken: turn.conversationKey } : {}),
            remoteConversationReused: reused,
            sendAttempts: 0,
            confirmedSubmissions: 0,
          };
          this.runs.push(run);
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `surface:${turn.conversationKey ?? turn.traceId}`,
            browserContextId: "issue-194-context",
            pageId: "issue-194-page",
            profileId: "issue-194-profile",
            accountId: `chatgpt-account:${ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();

          if (plan.scenario === "authentication_loss") throw plan.error ?? new Error("unexpected missing auth scenario error");

          if (plan.scenario === "ambiguous_submission") {
            await turn.onSendActivated?.();
            run.sendAttempts += 1;
            throw plan.error ?? new Error("ambiguous provider submission");
          }

          if (plan.scenario === "provider_error" || plan.scenario === "partial_failure" || plan.scenario === "cancel_active") {
            await turn.onSendActivated?.();
            run.sendAttempts += 1;
            turn.onSubmitted?.();
            run.confirmedSubmissions += 1;
            if (plan.scenario !== "provider_error") turn.onTextDelta("partial provider output");
            if (plan.scenario === "cancel_active") {
              plan.abortController?.abort();
              await Promise.resolve();
              return "partial provider output";
            }
            throw plan.error ?? new Error("provider turn failed after submission");
          }

          await turn.onSendActivated?.();
          run.sendAttempts += 1;
          turn.onSubmitted?.();
          run.confirmedSubmissions += 1;
          const answer = plan.answer;
          turn.onTextDelta(answer);
          this.previousConversationKey = turn.conversationKey;
          return answer;
        } finally {
          compiled.release();
        }
      },
      async verifyConnector() { return "controlled"; },
      async inspectSession() { return { authenticated: true, temporary: false, url: "https://chatgpt.com" }; },
      async smokeTest() { return { effort: "low", response: "controlled" }; },
      async recoverRetainedAnswer() { throw new Error("no retained answer in controlled fixture"); },
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

function parsed(input: {
  selection: WebChatProviderConformanceHarness["selection"];
  turnId: string;
  userText: string;
  history?: readonly WebChatReplayMessage[];
}): CodexParsedRequest {
  const messages = input.history ?? [{ role: "user" as const, text: input.userText }];
  return {
    modelId: "gpt-5.6-luna",
    context: {
      systemPrompt: ["You are a provider conformance test assistant."],
      messages: messages.map(message => ({
        role: message.role,
        content: [{ type: "text", text: message.text }],
      })),
    },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: {
      dshSessionId: input.selection.dshSession.sessionId,
      threadId: input.selection.affinity.threadId,
      turnId: input.turnId,
    },
  } as unknown as CodexParsedRequest;
}

function createHarness(): WebChatProviderConformanceHarness {
  const provider = providerConfig();
  const namespace = chatGptWebExecutionNamespace(provider);
  const binding = chatGptWebChatAccountBindingFor(provider);
  const dshSession = { sessionId: "issue-194-session" };
  const affinity = {
    providerId: CHATGPT_WEB_PROVIDER_ID,
    bindingId: webChatAccountBindingId(binding),
    threadId: "issue-194-thread",
  };
  const model = {
    route: MODEL_ROUTE,
    descriptorId: MODEL_ID,
    unsupportedRoute: "api/gpt-5",
    supportedReasoningMode: "low",
    unsupportedReasoningMode: "medium",
  } as const;
  const selection = { dshSession, binding, affinity, model: model.route, reasoningMode: "low" };
  const surface = new ControlledSurface();
  const driver = createChatGptWebDriver({ provider, namespace, sessions: chatGptTurnSessions });
  const adapter = createChatGptWebAdapter(provider, { surfaceTransport: surface.transport });
  const store = resolveNativeChatGptContinuityStore();
  let closed = false;

  const harness: WebChatProviderConformanceHarness = {
    driver,
    store,
    selection,
    namespace,
    model,
    restartRecovery: "explicit_replay",
    async runNativeTurn(input) {
      const scenario = input.scenario ?? "success";
      const abortController = scenario === "cancel_active" ? new AbortController() : undefined;
      const answer = `provider answer for ${input.turnId}`;
      const errors: Partial<Record<WebChatProviderConformanceScenario, ChatGptWebAdapterError>> = {
        authentication_loss: new ChatGptWebAdapterError("ChatGPT session expired", {
          status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false,
        }),
        provider_error: new ChatGptWebAdapterError("provider unavailable after submission", {
          status: 503, errorType: "server_error", code: "upstream_unavailable", retryable: true,
        }),
        partial_failure: new ChatGptWebAdapterError("provider failed after partial output", {
          status: 503, errorType: "server_error", code: "upstream_unavailable", retryable: true,
        }),
        ambiguous_submission: new ChatGptWebAdapterError("submission confirmation lost", {
          status: 502, errorType: "server_error", code: "chatgpt_submission_ambiguous", retryable: true,
        }),
      };
      surface.enqueue({ scenario, turnId: input.turnId, answer, ...(errors[scenario] ? { error: errors[scenario] } : {}), ...(abortController ? { abortController } : {}) });
      const runStart = surface.runs.length;
      const events: AdapterEvent[] = [];
      let thrown: unknown;
      try {
        await adapter.runTurn(parsed(input), {
          headers: new Headers(),
          ...(abortController ? { abortSignal: abortController.signal } : {}),
        }, event => events.push(event));
      } catch (error) {
        thrown = error;
      }

      const identity = webChatContinuationIdentity({
        binding: input.selection.binding,
        dshSession: input.selection.dshSession,
        threadId: input.selection.affinity.threadId,
        namespace,
      });
      const record = await store.read(identity);
      const lastRun = surface.runs.at(-1);
      const failure = [...events].reverse().find(event => event.type === "error" || event.type === "incomplete");
      const eventTypes: string[] = events.map(event => event.type === "done" ? "completed" : event.type === "incomplete" || event.type === "error" ? "error" : event.type);
      if (thrown !== undefined && !eventTypes.includes("error")) eventTypes.push("error");
      const text = events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map(event => event.text).join("");
      const cancelled = scenario === "cancel_active" && (abortController?.signal.aborted === true)
        && (thrown !== undefined || events.some(event =>
          (event.type === "incomplete" && /cancel|abort/i.test(event.reason))
          || (event.type === "error" && /cancel|abort/i.test(`${event.code ?? ""} ${event.message}`))));
      if (cancelled && !eventTypes.includes("cancelled")) eventTypes.push("cancelled");
      const outcome: WebChatProviderConformanceTurn["outcome"] = events.some(event => event.type === "done")
        ? "completed"
        : cancelled ? "cancelled" : "failed";

      return {
        outcome,
        eventTypes,
        text,
        sendAttempts: surface.runs.slice(runStart).reduce((sum, run) => sum + run.sendAttempts, 0),
        confirmedSubmissions: surface.runs.slice(runStart).reduce((sum, run) => sum + run.confirmedSubmissions, 0),
        ...(failure && "retryable" in failure
          ? { retryable: failure.retryable }
          : cancelled ? { retryable: false } : {}),
        ...(record ? { record } : {}),
        ...(lastRun?.lineageToken !== undefined ? { lineageToken: lastRun.lineageToken } : {}),
        ...(lastRun ? { remoteConversationReused: lastRun.remoteConversationReused, compiledPrompt: lastRun.prompt } : {}),
      };
    },
    async restart() {
      await harness.shutdown();
      chatGptTurnSessions.clear();
      return createHarness();
    },
    async assertStaleNativeTurnIsolated() {
      const staleSelection = {
        ...selection,
        dshSession: { ...selection.dshSession, sessionId: `${selection.dshSession.sessionId}:stale-native` },
        affinity: { ...selection.affinity, threadId: `${selection.affinity.threadId}:stale-native` },
      };
      const firstEvents: AdapterEvent[] = [];
      surface.enqueue({ scenario: "success", turnId: "stale-native-old", answer: "settled old answer" });
      await adapter.runTurn(parsed({ selection: staleSelection, turnId: "stale-native-old", userText: "old turn" }),
        { headers: new Headers() }, event => firstEvents.push(event));
      const oldTurn = [...surface.runs].reverse().find(run => run.turnId === "stale-native-old")?.turn;
      if (!oldTurn) return false;

      const nextEvents: AdapterEvent[] = [];
      surface.enqueue({ scenario: "success", turnId: "stale-native-next", answer: "current answer" });
      await adapter.runTurn(parsed({
        selection: staleSelection,
        turnId: "stale-native-next",
        userText: "current turn",
        history: [
          { role: "user", text: "old turn" },
          { role: "assistant", text: "settled old answer" },
          { role: "user", text: "current turn" },
        ],
      }), { headers: new Headers() }, event => nextEvents.push(event));

      const firstEventCount = firstEvents.length;
      const nextEventSnapshot = nextEvents.map(event => ({ ...event }));
      try {
        oldTurn.onTextDelta("late stale native output");
      } catch {
        return false;
      }
      await Promise.resolve();
      const staleText = (events: readonly AdapterEvent[]) => events
        .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .some(event => event.text.includes("late stale native output"));
      return firstEvents.length === firstEventCount
        && JSON.stringify(nextEvents) === JSON.stringify(nextEventSnapshot)
        && !staleText(firstEvents)
        && !staleText(nextEvents);
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      await adapter.shutdown?.();
      await driver.shutdown?.();
      await closeNativeChatGptContinuityStores();
    },
  };
  return harness;
}

describe("issue #194 — ChatGPT provider fixture", () => {
  beforeEach(async () => {
    previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
    previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
    home = mkdtempSync(join(tmpdir(), "issue-194-provider-conformance-"));
    delete process.env.DSH_CHATGPT_FREE_HOME;
    process.env.DSH_CHATGPT_WEB_HOME = home;
    chatGptTurnSessions.clear();
    await closeNativeChatGptContinuityStores();
    saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
  });

  afterEach(async () => {
    await closeNativeChatGptContinuityStores();
    chatGptTurnSessions.clear();
    if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
    else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
    if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
    else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
    rmSync(home, { recursive: true, force: true });
  });

  defineWebChatProviderConformanceSuite({
    name: "ChatGPT Web",
    async create() { return createHarness(); },
  });

});
