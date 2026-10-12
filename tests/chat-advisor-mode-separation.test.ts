/**
 * Chat Mode and Advisor Mode are two features with different context
 * requirements. These tests capture the payload the adapter actually hands to
 * the browser transport boundary (`prepare()` / `prepareResume()`), not an
 * intermediate prompt string.
 *
 * What is real: the provider adapter, the turn runtime, retention/continuity
 * decisions, prompt compilation, submission hooks and settlement.
 * What is simulated: only the browser I/O (`RecordingSurface`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { ADVISOR_REVIEWER_PERSONA, advisorConversationThread, composeAdvisorReviewText, validateAdvisorReviewSource } from "../src/advisor";
import { createChatGptWebProviderRuntime } from "../src/adapters/chatgpt-web/provider-runtime";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import type { AdapterEvent, CodexMessage, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const ACCOUNT_FINGERPRINT = "account-chat-advisor-separation";

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    browserInteractionMode: "automatic",
    browserHost: "managed-chrome",
    storageStatePath: "/tmp/chatgpt-chat-advisor-state.json",
    chromeExecutablePath: "/usr/bin/chromium",
    brokerSocketPath: "/tmp/chatgpt-chat-advisor-broker.sock",
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
    experimentalBiggerContext: false,
  },
} as unknown as CodexProviderConfig;

const SESSION = "session-chat-advisor-separation";
const THREAD = "thread-chat-advisor-separation";

/** Records the exact composer payload the adapter hands to the browser turn. */
class RecordingSurface {
  readonly payloads: string[] = [];
  private runs = 0;

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        this.runs += 1;
        // A retained conversation is created on its first physical turn and
        // reused afterwards, where the worker asks for the resume payload.
        const compiled = this.runs === 1 || turn.prepareResume === undefined
          ? await turn.prepare()
          : await turn.prepareResume();
        this.payloads.push(compiled.text);
        await turn.onPhysicalSurfaceBound?.({
          resourceId: "surface-resource",
          browserContextId: "surface-context",
          pageId: "surface-page",
          profileId: "surface-profile",
          accountId: `chatgpt-account:${ACCOUNT_FINGERPRINT}`,
        });
        await turn.onSurfaceReady?.();
        await turn.onSendActivated?.();
        turn.onSubmitted?.();
        const answer = "respuesta del turno";
        turn.onTextDelta(answer);
        return answer;
      },
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

function solTurn(turnId: string, messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: { systemPrompt: ["eres un asistente de codigo"], messages },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: { dshSessionId: SESSION, threadId: THREAD, turnId },
  } as unknown as CodexParsedRequest;
}

const user = (content: string, timestamp: number): CodexMessage => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp: number): CodexMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  timestamp,
});

async function runTurn(
  adapter: ReturnType<typeof createChatGptWebAdapter>,
  request: CodexParsedRequest,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn(request, { headers: new Headers() }, event => events.push(event));
  // Let the settled-turn fingerprint write land before the next turn decides
  // install vs continue.
  await new Promise(resolve => setTimeout(resolve, 0));
  return events;
}

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

beforeEach(async () => {
  previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "chat-advisor-separation-"));
  delete process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = home;
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
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

const EXPECTED_HEADER =
  'Project: "dsh-chatgpt-web"\ngithub: "https://github.com/lordraiden/dsh-chatgpt-web"';

describe("Chat Mode at the browser transport boundary", () => {
  test("the first message is the project header plus the current user message", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    await runTurn(adapter, solTurn("turn-1", [user("primer mensaje", 1)]));

    expect(surface.payloads).toHaveLength(1);
    expect(surface.payloads[0]).toBe(`${EXPECTED_HEADER}\n\nprimer mensaje`);
    expect(surface.payloads[0]).not.toContain("eres un asistente de codigo");
  });

  test("subsequent messages carry only the current user message", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    await runTurn(adapter, solTurn("turn-1", [user("primer mensaje", 1)]));
    await runTurn(adapter, solTurn("turn-2", [
      user("primer mensaje", 1),
      assistant("primera respuesta", 2),
      user("segundo mensaje", 3),
    ]));

    expect(surface.payloads).toHaveLength(2);
    expect(surface.payloads[1]).toBe("segundo mensaje");
    for (const leaked of [
      "Project:",
      "github:",
      "primer mensaje",
      "primera respuesta",
      "eres un asistente de codigo",
      "<codex_context_json>",
      "<dsh_transport_resume>",
    ]) {
      expect(surface.payloads[1]).not.toContain(leaked);
    }
  });
});

describe("Advisor Mode at the browser transport boundary", () => {
  const ADVISOR_SOURCE = validateAdvisorReviewSource({
    sessionId: SESSION,
    reviewedTurnId: "dsh-turn:1",
    humanRequest: "Add a retry to the login flow",
    dshResponse: "I added a retry with exponential backoff in src/login.ts",
    instructions: "Review the retry implementation for correctness",
    project: "dsh-chatgpt-web",
  });

  /**
   * Run one review through the provider-neutral Advisor port over the real adapter (issue #224): the
   * review reaches the browser as one portable user-text prompt through the provider's own turn
   * execution, exactly like production.
   */
  async function runAdvisorReview(
    adapter: ReturnType<typeof createChatGptWebAdapter>,
    turnId: string,
  ): Promise<{ ok: boolean; text?: string }> {
    const runtime = createChatGptWebProviderRuntime({ provider: PROVIDER, adapter });
    const outcome = await runtime.runTextTurn({
      route: "chatgpt-web/light",
      model: "light",
      userText: composeAdvisorReviewText(ADVISOR_SOURCE),
      dshSession: { sessionId: SESSION },
      affinity: {
        providerId: "chatgpt-web",
        bindingId: "binding-chat-advisor-separation",
        threadId: advisorConversationThread(SESSION),
      },
      turnId,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    return outcome;
  }

  test("the Advisor turn keeps the reviewer prompt and the review message", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const outcome = await runAdvisorReview(adapter, "review-1");

    expect(outcome.ok).toBe(true);
    expect(surface.payloads).toHaveLength(1);
    const payload = surface.payloads[0]!;
    expect(payload).toContain(ADVISOR_REVIEWER_PERSONA);
    expect(payload).toContain("Review the retry implementation for correctness");
    expect(payload).toContain("Add a retry to the login flow");
    // The Advisor conversation never receives the normal Chat Mode project header.
    expect(payload).not.toContain(EXPECTED_HEADER);
  });

  test("an Advisor turn never uses the minimal Chat Mode payload", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const outcome = await runAdvisorReview(adapter, "review-2");
    expect(outcome.ok).toBe(true);
    expect(surface.payloads[0]).not.toBe(`${EXPECTED_HEADER}\n\nAdd a retry to the login flow`);
  });
});
