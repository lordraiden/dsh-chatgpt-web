import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { createChatGptWebTextTransport } from "../src/adapters/chatgpt-web/webchat-transport";
import type { ChatGptWebTextTurn } from "../src/adapters/chatgpt-web/text-turn";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import { runWebChatTextExchange } from "../src/web-chat/host/text-exchange";
import { advisorConversationAffinity, advisorConversationThread } from "../src/advisor";
import type { AdapterEvent, CodexMessage, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import {
  createWebChatTransportLeaseRegistry,
  type WebChatTextTransport,
  type WebChatTextTransportContext,
} from "../src/web-chat/transport";

/**
 * Issue #236 — ChatGPT's phased turn projected onto the shared exchange.
 *
 * What is real: the provider adapter, the turn runtime, retention/continuity decisions, prompt
 * compilation, submission hooks, settlement, the new phased opener, the transport projection and the
 * host exchange driver. What is simulated: only the browser I/O (`RecordingSurface`).
 */

const ACCOUNT_FINGERPRINT = "account-236-exchange";

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    browserInteractionMode: "automatic",
    browserHost: "managed-chrome",
    storageStatePath: "/tmp/chatgpt-236-state.json",
    chromeExecutablePath: "/usr/bin/chromium",
    brokerSocketPath: "/tmp/chatgpt-236-broker.sock",
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
    experimentalBiggerContext: false,
  },
} as unknown as CodexProviderConfig;

const SESSION = "session-236-exchange";

/** Records the exact hook order the browser surface observes, and can gate or fail the turn. */
class RecordingSurface {
  readonly milestones: string[] = [];
  readonly payloads: string[] = [];
  private runs = 0;
  gate?: Promise<void>;
  failWith?: Error;
  failAfterSubmitWith?: Error;

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        this.runs += 1;
        this.milestones.push("run");
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
        this.milestones.push("ready");
        if (this.gate) await this.gate;
        if (this.failWith) {
          this.milestones.push("failed");
          throw this.failWith;
        }
        await turn.onSendActivated?.();
        this.milestones.push("send_activated");
        turn.onSubmitted?.();
        this.milestones.push("submitted");
        if (this.failAfterSubmitWith) {
          this.milestones.push("failed_after_submit");
          throw this.failAfterSubmitWith;
        }
        const answer = "respuesta del turno 236";
        turn.onTextDelta(answer);
        return answer;
      },
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

/** The portable review text one review submits (the provider only sees ordinary user text). */
const REVIEW_TEXT = "WebChat Advisor review:\n\nreview me";

/** One Advisor-shaped turn request: retained, no tools, portable review text. */
function advisorTurn(turnId: string, reviewText = "review me"): CodexParsedRequest {
  const message: CodexMessage = { role: "user", content: `WebChat Advisor review:\n\n${reviewText}`, timestamp: 1 };
  return {
    modelId: "gpt-5.6-sol",
    context: { messages: [message] },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: { dshSessionId: SESSION, threadId: advisorConversationThread(SESSION), turnId },
    _advisorReview: { reviewId: turnId },
  } as unknown as CodexParsedRequest;
}

async function openTurn(adapter: ReturnType<typeof createChatGptWebAdapter>, turnId: string, reviewText?: string): Promise<ChatGptWebTextTurn> {
  const open = adapter.openTextTurn;
  if (!open) throw new Error("the adapter did not expose the phased opener");
  return open.call(adapter, advisorTurn(turnId, reviewText), { headers: new Headers() });
}

/** Wrap the transport to record exactly what the host asked it. */
function recordingTransport(turn: ChatGptWebTextTurn) {
  const seen: { ready?: boolean; submit?: string; settle?: string; abort?: boolean } = {};
  const base = createChatGptWebTextTransport(turn);
  const transport: WebChatTextTransport = {
    id: base.id,
    async ready(context: WebChatTextTransportContext) {
      await base.ready(context);
      seen.ready = true;
    },
    async submit(context: WebChatTextTransportContext) {
      const phase = await base.submit(context);
      seen.submit = phase;
      return phase;
    },
    stream: context => base.stream(context),
    async settle(context: WebChatTextTransportContext) {
      const outcome = await base.settle(context);
      seen.settle = outcome;
      return outcome;
    },
    async abort(context: WebChatTextTransportContext, reason?: unknown) {
      seen.abort = true;
      await base.abort?.(context, reason);
    },
  };
  return { transport, seen };
}

function handoffFor(transport: WebChatTextTransport, turnId: string) {
  return {
    transport,
    identity: {
      bindingId: "binding-236",
      conversationKey: "conversation-236",
      turnId,
      dshSessionId: SESSION,
    },
    turn: { userText: REVIEW_TEXT, model: "chatgpt-web/light" },
    leases: createWebChatTransportLeaseRegistry(),
    createResource: async () => ({ id: "resource-236", conversationKey: "conversation-236", epoch: 1 }),
  };
}

let home: string;
let previousWebHome: string | undefined;

beforeEach(async () => {
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "issue-236-"));
  process.env.DSH_CHATGPT_WEB_HOME = home;
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
  rmSync(home, { recursive: true, force: true });
});

describe("issue #236 — the ChatGPT turn runs through the shared exchange", () => {
  test("a review completes with the provider's text, submission phase and settlement", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const turn = await openTurn(adapter, "turn-236-ok");
    const { transport, seen } = recordingTransport(turn);

    const outcome = await runWebChatTextExchange(handoffFor(transport, "turn-236-ok"));

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("respuesta del turno 236");
    // The submission boundary and the settlement are the provider's own facts.
    expect(seen.submit).toBe("accepted");
    expect(seen.settle).toBe("fulfilled");
    expect(outcome.settlement).toBe("fulfilled");
    // Readiness precedes submission in the provider's own pipeline, and the exchange drove both.
    expect(seen.ready).toBe(true);
    expect(surface.milestones).toEqual(["run", "ready", "send_activated", "submitted"]);
    expect(turn.submissionPhase()).toBe("accepted");
    expect(surface.payloads[0]).toContain("WebChat Advisor review:");
  });

  test("the host's exchange uses the provider's proven phase, not a guess", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const turn = await openTurn(adapter, "turn-236-phase");
    const transport = createChatGptWebTextTransport(turn);

    // The phase is asked for directly as well: it is the same fact the transport reports.
    const outcome = await runWebChatTextExchange(handoffFor(transport, "turn-236-phase"));
    expect(outcome.ok).toBe(true);
    expect(turn.submissionPhase()).toBe("accepted");
  });

  test("a provider failure after submission is reported and never retry-safe", async () => {
    const surface = new RecordingSurface();
    surface.failAfterSubmitWith = new Error("the ChatGPT DOM disappeared");
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const turn = await openTurn(adapter, "turn-236-fail");
    const { transport } = recordingTransport(turn);

    const outcome = await runWebChatTextExchange(handoffFor(transport, "turn-236-fail"));

    expect(outcome.ok).toBe(false);
    // The provider's own post-submission failure shape reaches the exchange, and the failure is
    // observable as such.
    expect(surface.milestones).toContain("failed_after_submit");
    expect(typeof outcome.message).toBe("string");
    expect((outcome.message ?? "").length).toBeGreaterThan(0);
    // The provider accepted the prompt, so the exchange refuses an automatic retry.
    expect(outcome.retrySafety).not.toBe("retry_safe");
    expect(outcome.retrySafety).toBe("not_retry_safe");
  });

  test("cancelling the exchange aborts the provider turn", async () => {
    const surface = new RecordingSurface();
    let release: () => void = () => {};
    surface.gate = new Promise<void>(resolve => { release = resolve; });
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const turn = await openTurn(adapter, "turn-236-abort");
    const { transport, seen } = recordingTransport(turn);
    const controller = new AbortController();

    const pending = runWebChatTextExchange(
      { ...handoffFor(transport, "turn-236-abort") },
      { signal: controller.signal },
    );
    controller.abort(new Error("operator cancelled"));
    release();
    const outcome = await pending;

    // The exchange cancelled the turn through the transport, which reached the provider's own turn.
    expect(seen.abort).toBe(true);
    expect(outcome.ok).toBe(false);
  });

  test("the provider conversation stays the Advisor's own affinity", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const turn = await openTurn(adapter, "turn-236-affinity");
    const transport = createChatGptWebTextTransport(turn);
    const outcome = await runWebChatTextExchange(handoffFor(transport, "turn-236-affinity"));

    expect(outcome.ok).toBe(true);
    // The affinity the Advisor asked for is the one the provider's conversation identity derives from.
    const affinity = advisorConversationAffinity({
      providerId: "chatgpt-web",
      bindingId: "binding-236",
      sessionId: SESSION,
    });
    expect(affinity.threadId).toBe(advisorConversationThread(SESSION));
    expect(surface.payloads).toHaveLength(1);
  });

  test("a second exchange on the same conversation is admitted after the first settled", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const leases = createWebChatTransportLeaseRegistry();

    const first = await openTurn(adapter, "turn-236-first");
    const firstTransport = createChatGptWebTextTransport(first);
    const firstOutcome = await runWebChatTextExchange({
      ...handoffFor(firstTransport, "turn-236-first"),
      leases,
    });
    expect(firstOutcome.ok).toBe(true);

    const second = await openTurn(adapter, "turn-236-second");
    const secondTransport = createChatGptWebTextTransport(second);
    const secondOutcome = await runWebChatTextExchange({
      ...handoffFor(secondTransport, "turn-236-second"),
      leases,
    });
    expect(secondOutcome.ok).toBe(true);
    expect(surface.payloads).toHaveLength(2);
  });

  test("the adapter still exposes the native runTurn path unchanged", async () => {
    const surface = new RecordingSurface();
    const adapter = createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
    const events: AdapterEvent[] = [];
    await adapter.runTurn(advisorTurn("turn-236-native"), { headers: new Headers() }, event => events.push(event));
    // The native call path is untouched: it emits its own terminal event and needs no reporter.
    expect(events.some(event => event.type === "done")).toBe(true);
    expect(surface.milestones).toEqual(["run", "ready", "send_activated", "submitted"]);
  });
});
