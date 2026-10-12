import { describe, expect, test } from "bun:test";

import {
  ADVISOR_RECOVERY_TIMEOUT_MAX_MS,
  ADVISOR_RECOVERY_UNAVAILABLE_CODE,
  advisorConversationThread,
  validateAdvisorRecoveryRequest,
  createAdvisorHost,
} from "../src/advisor";
import { createChatGptWebProviderRuntime } from "../src/adapters/chatgpt-web/provider-runtime";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import type { ChatGptWebProviderAdapter } from "../src/adapters/chatgpt-web/index";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import type { WebChatTextRecoveryRequest } from "../src/web-chat/host/text-turn";

/**
 * Issue #214 — the read-only recovery of a finished Advisor answer (kept by #224).
 *
 * The reported failure is a review the provider finished while the plugin had already given up on
 * the browser turn. The recovery must read the answer back from the *same* retained Advisor
 * conversation the review turn used, without ever submitting, navigating or creating anything.
 *
 * The recovery orchestration is now provider-neutral (the Advisor host asks the selected provider's
 * runtime), so what this suite proves is the provider-side invariant that makes it safe: the review
 * turn and the recovery resolve to one conversation, and a recovery carries no message at all.
 */

const SESSION = "dsh-session-recovery";
const NAMESPACE = "dsh-chatgpt-web";
const ROUTE = "chatgpt-web/light";

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-214",
    browserInteractionMode: "automatic",
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

interface CapturedAdapter {
  readonly adapter: ChatGptWebProviderAdapter;
  readonly turns: CodexParsedRequest[];
  readonly recoveries: Array<{ parsed: CodexParsedRequest; timeoutMs?: number; signal?: AbortSignal }>;
}

/** An adapter double that captures the provider requests the runtime builds. */
function capturingAdapter(options: { text?: string; failWith?: string } = {}): CapturedAdapter {
  const turns: CodexParsedRequest[] = [];
  const recoveries: Array<{ parsed: CodexParsedRequest; timeoutMs?: number; signal?: AbortSignal }> = [];
  const adapter = {
    name: "chatgpt-web",
    async runTurn(parsed: CodexParsedRequest, _incoming: unknown, emit: (event: AdapterEvent) => void) {
      turns.push(parsed);
      if (options.failWith) throw new Error(options.failWith);
      emit({ type: "text_delta", text: options.text ?? "the review" });
      emit({ type: "done" });
    },
    async recoverRetainedAnswer(parsed: CodexParsedRequest, recoverOptions: { timeoutMs?: number; signal?: AbortSignal } = {}) {
      recoveries.push({
        parsed,
        ...(recoverOptions.timeoutMs !== undefined ? { timeoutMs: recoverOptions.timeoutMs } : {}),
        ...(recoverOptions.signal ? { signal: recoverOptions.signal } : {}),
      });
      if (options.failWith) throw new Error(options.failWith);
      return { text: options.text ?? "the retained answer", capturedAt: 1_700_000_000_000 };
    },
  } as unknown as ChatGptWebProviderAdapter;
  return { adapter, turns, recoveries };
}

function runtimeWith(captured: CapturedAdapter) {
  return createChatGptWebProviderRuntime({
    provider: PROVIDER,
    adapter: captured.adapter,
  });
}

describe("issue #214 — one retained conversation for review and recovery", () => {
  test("the recovery resolves to the review turn's conversation key for the same session", async () => {
    const captured = capturingAdapter();
    const runtime = runtimeWith(captured);
    const affinity = { providerId: "chatgpt-web", bindingId: "binding-1", threadId: advisorConversationThread(SESSION) };
    await runtime.runTextTurn({
      route: ROUTE,
      model: "light",
      userText: "review this",
      dshSession: { sessionId: SESSION },
      affinity,
      turnId: "review-1",
    });
    const recoveryRequest: WebChatTextRecoveryRequest = {
      route: ROUTE,
      model: "light",
      dshSession: { sessionId: SESSION },
      affinity,
      turnId: "recover-1",
    };
    await runtime.recoverTextTurn!(recoveryRequest);

    const reviewParsed = captured.turns[0]!;
    const recoveryParsed = captured.recoveries[0]!.parsed;
    expect(chatGptConversationKey(recoveryParsed, NAMESPACE))
      .toBe(chatGptConversationKey(reviewParsed, NAMESPACE));
    // The identity is the synthetic Advisor thread of this session, not the review id.
    expect(recoveryParsed._dshContext?.threadId).toBe(advisorConversationThread(SESSION));
    expect(recoveryParsed._advisorReview).toEqual({ reviewId: "recover-1" });
  });

  test("another DSH session resolves to its own conversation", () => {
    const captured = capturingAdapter();
    const runtime = runtimeWith(captured);
    void runtime;
    const build = (sessionId: string, turnId: string): CodexParsedRequest => ({
      modelId: "gpt-5.6-luna",
      context: { messages: [] },
      stream: false,
      options: {},
      _dshContext: { dshSessionId: sessionId, threadId: advisorConversationThread(sessionId), turnId },
      _advisorReview: { reviewId: turnId },
    });
    expect(chatGptConversationKey(build(SESSION, "r"), NAMESPACE))
      .not.toBe(chatGptConversationKey(build("another-session", "r"), NAMESPACE));
  });

  test("the recovery request carries no message, tools or system prompt: it can only read", async () => {
    const captured = capturingAdapter();
    const runtime = runtimeWith(captured);
    await runtime.recoverTextTurn!({
      route: ROUTE,
      model: "light",
      dshSession: { sessionId: SESSION },
      affinity: { providerId: "chatgpt-web", bindingId: "b", threadId: advisorConversationThread(SESSION) },
      turnId: "recover-1",
      timeoutMs: 5_000,
    });
    const parsed = captured.recoveries[0]!.parsed;
    expect(parsed.context.messages).toEqual([]);
    expect(parsed.context.systemPrompt).toBeUndefined();
    expect(parsed.context.tools).toBeUndefined();
    expect(parsed.stream).toBe(false);
    expect(captured.recoveries[0]!.timeoutMs).toBe(5_000);
  });

  test("the review turn submits one portable user message and never a system block", async () => {
    const captured = capturingAdapter();
    const runtime = runtimeWith(captured);
    await runtime.runTextTurn({
      route: ROUTE,
      model: "light",
      userText: "portable review text",
      dshSession: { sessionId: SESSION },
      affinity: { providerId: "chatgpt-web", bindingId: "b", threadId: advisorConversationThread(SESSION) },
      turnId: "review-1",
    });
    const parsed = captured.turns[0]!;
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]!.role).toBe("user");
    expect(parsed.context.messages[0]!.content).toBe("portable review text");
    expect(parsed.context.systemPrompt).toBeUndefined();
  });
});

describe("issue #214 — recovery input validation (control API contract)", () => {
  test("accepts a session and an optional route/timeout, trimming both", () => {
    expect(validateAdvisorRecoveryRequest({ sessionId: "  s-1  " })).toEqual({ sessionId: "s-1" });
    expect(validateAdvisorRecoveryRequest({ sessionId: "s-1", route: " chatgpt-web/light ", timeoutMs: 1_000 }))
      .toEqual({ sessionId: "s-1", route: "chatgpt-web/light", timeoutMs: 1_000 });
  });

  test("rejects a body that is not an object with a session identity", () => {
    expect(() => validateAdvisorRecoveryRequest(null)).toThrow(/must be an object/);
    expect(() => validateAdvisorRecoveryRequest([])).toThrow(/must be an object/);
    expect(() => validateAdvisorRecoveryRequest({})).toThrow(/sessionId/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "   " })).toThrow(/sessionId/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: 7 })).toThrow(/sessionId/);
  });

  test("rejects a blank route and a non-positive, non-finite or oversized timeout", () => {
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", route: "  " })).toThrow(/route/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: Number.POSITIVE_INFINITY })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: ADVISOR_RECOVERY_TIMEOUT_MAX_MS + 1 }))
      .toThrow(/must not exceed/);
  });
});

describe("issue #214 — recovery results through the Advisor host", () => {
  function hostWith(captured: CapturedAdapter) {
    return createAdvisorHost({ runtimes: [runtimeWith(captured)] });
  }

  test("a read answer becomes an ok result carrying its route and provider provenance", async () => {
    const captured = capturingAdapter({ text: "  **Verdict: request changes.**  " });
    const result = await hostWith(captured).recover({ sessionId: SESSION, route: ROUTE, timeoutMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("**Verdict: request changes.**");
    expect(result.capturedAt).toBe(1_700_000_000_000);
    expect(result.route).toBe(ROUTE);
    expect(result.providerId).toBe("chatgpt-web");
    expect(result.modelId).toBe("light");
    expect(captured.recoveries[0]!.timeoutMs).toBe(60_000);
  });

  test("nothing retained, a lost surface, a busy conversation and a timeout are all typed unavailable", async () => {
    for (const message of [
      "The retained ChatGPT conversation is no longer available.",
      "The retained ChatGPT Web conversation was lost and can no longer be continued.",
      "Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not allowed.",
      "The retained ChatGPT Web conversation did not expose a finalized answer within 900000 ms.",
    ]) {
      const result = await hostWith(capturingAdapter({ failWith: message }))
        .recover({ sessionId: SESSION, route: ROUTE });
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
      expect(result.message).toBe(message);
      expect(result.text).toBeUndefined();
    }
  });

  test("an empty answer is a typed failure, never an empty success", async () => {
    const result = await hostWith(capturingAdapter({ text: "   " })).recover({ sessionId: SESSION, route: ROUTE });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
  });

  test("the cancellation signal reaches the read", async () => {
    const controller = new AbortController();
    const captured = capturingAdapter();
    await hostWith(captured).recover({ sessionId: SESSION, route: ROUTE, signal: controller.signal });
    expect(captured.recoveries[0]!.signal).toBe(controller.signal);
  });
});
