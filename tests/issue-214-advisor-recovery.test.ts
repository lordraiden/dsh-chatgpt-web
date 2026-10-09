import { describe, expect, test } from "bun:test";

import {
  ADVISOR_RECOVERY_TIMEOUT_MAX_MS,
  ADVISOR_RECOVERY_UNAVAILABLE_CODE,
  ADVISOR_SYSTEM_PROMPT,
  advisorConversationThread,
  buildAdvisorRecoveryRequest,
  buildAdvisorTurnRequest,
  runAdvisorRecovery,
  validateAdvisorRecoveryInput,
  type AdvisorRecoveryInput,
  type AdvisorRecoveryRunner,
  type AdvisorRoute,
} from "../src/adapters/chatgpt-web/advisor";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import type { CodexParsedRequest } from "../src/types";

/**
 * Issue #214 — the read-only recovery of a finished Advisor answer.
 *
 * The reported failure is a review that ChatGPT finished while the plugin had already given up on
 * the browser turn. The recovery must read the answer back from the *same* retained Advisor
 * conversation the review turn used, without ever submitting, navigating or creating anything.
 */

const SESSION = "dsh-session-recovery";
const NAMESPACE = "dsh-chatgpt-web";
const ROUTE: AdvisorRoute = { slug: "chatgpt-web/luna", backendModel: "gpt-5.6-luna", effort: "low" };

const REVIEW_INPUT = {
  sessionId: SESSION,
  humanRequest: "Add a retry to the login flow",
  dshResponse: "I added a retry with exponential backoff",
  instructions: "Review the retry implementation",
  mode: "normal" as const,
};

function recoveryInput(overrides: Partial<AdvisorRecoveryInput> = {}): AdvisorRecoveryInput {
  return { sessionId: SESSION, ...overrides };
}

function runner(behaviour: AdvisorRecoveryRunner["recoverAnswer"]): {
  runner: AdvisorRecoveryRunner;
  calls: Array<{ parsed: CodexParsedRequest; timeoutMs?: number; signal?: AbortSignal }>;
} {
  const calls: Array<{ parsed: CodexParsedRequest; timeoutMs?: number; signal?: AbortSignal }> = [];
  return {
    calls,
    runner: {
      recoverAnswer: async (parsed, options) => {
        calls.push({ parsed, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.signal ? { signal: options.signal } : {}) });
        return behaviour(parsed, options);
      },
    },
  };
}

describe("issue #214 — the recovery reads the same retained conversation as the review", () => {
  test("the recovery request resolves to the review turn's conversationKey, for the same session", () => {
    const reviewParsed = buildAdvisorTurnRequest(REVIEW_INPUT, ROUTE, "review-1");
    const recoveryParsed = buildAdvisorRecoveryRequest(recoveryInput(), ROUTE, "recover-1");
    expect(chatGptConversationKey(recoveryParsed, NAMESPACE))
      .toBe(chatGptConversationKey(reviewParsed, NAMESPACE));
    // The identity is the synthetic Advisor thread of this session, not the review id.
    expect(recoveryParsed._dshContext?.threadId).toBe(advisorConversationThread(SESSION));
    expect(recoveryParsed._advisorReview).toEqual({ reviewId: "recover-1" });
  });

  test("another DSH session resolves to its own conversation", () => {
    const other = buildAdvisorRecoveryRequest(recoveryInput({ sessionId: "another-session" }), ROUTE, "recover-1");
    expect(chatGptConversationKey(other, NAMESPACE))
      .not.toBe(chatGptConversationKey(buildAdvisorRecoveryRequest(recoveryInput(), ROUTE, "recover-1"), NAMESPACE));
  });

  test("the recovery request carries no message, tools or system prompt: it can only read", () => {
    const parsed = buildAdvisorRecoveryRequest(recoveryInput(), ROUTE, "recover-1");
    expect(parsed.context.messages).toEqual([]);
    expect(parsed.context.systemPrompt).toEqual([]);
    expect(parsed.context.systemPrompt).not.toContain(ADVISOR_SYSTEM_PROMPT);
    expect(parsed.context.tools).toBeUndefined();
    expect(parsed.stream).toBe(false);
  });
});

describe("issue #214 — recovery input validation", () => {
  test("accepts a session and optional mode/timeout, trimming the session", () => {
    expect(validateAdvisorRecoveryInput({ sessionId: "  s-1  " })).toEqual({ sessionId: "s-1" });
    expect(validateAdvisorRecoveryInput({ sessionId: "s-1", mode: "think", timeoutMs: 1_000 }))
      .toEqual({ sessionId: "s-1", mode: "think", timeoutMs: 1_000 });
  });

  test("rejects a body that is not an object with a session identity", () => {
    expect(() => validateAdvisorRecoveryInput(null)).toThrow(/must be an object/);
    expect(() => validateAdvisorRecoveryInput([])).toThrow(/must be an object/);
    expect(() => validateAdvisorRecoveryInput({})).toThrow(/sessionId/);
    expect(() => validateAdvisorRecoveryInput({ sessionId: "   " })).toThrow(/sessionId/);
    expect(() => validateAdvisorRecoveryInput({ sessionId: 7 })).toThrow(/sessionId/);
  });

  test("rejects an invalid mode and a non-positive, non-finite or oversized timeout", () => {
    expect(() => validateAdvisorRecoveryInput({ sessionId: "s", mode: "deep" })).toThrow(/mode/);
    expect(() => validateAdvisorRecoveryInput({ sessionId: "s", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryInput({ sessionId: "s", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryInput({ sessionId: "s", timeoutMs: Number.POSITIVE_INFINITY })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryInput({ sessionId: "s", timeoutMs: ADVISOR_RECOVERY_TIMEOUT_MAX_MS + 1 }))
      .toThrow(/must not exceed/);
  });
});

describe("issue #214 — recovery results", () => {
  test("a read answer becomes an ok result marked as recovered", async () => {
    const { runner: fake, calls } = runner(async () => ({ text: "  **Verdict: request changes.**  ", capturedAt: 1_700_000_000_000, waitedMs: 4_200 }));
    const result = await runAdvisorRecovery(fake, recoveryInput({ mode: "think", timeoutMs: 60_000 }), ROUTE, "recover-ok");
    expect(result).toEqual({
      ok: true,
      reviewId: "recover-ok",
      mode: "think",
      model: ROUTE.slug,
      recovered: true,
      text: "**Verdict: request changes.**",
      capturedAt: 1_700_000_000_000,
    });
    expect(calls[0]?.timeoutMs).toBe(60_000);
  });

  test("nothing retained, a lost surface, a busy conversation and a timeout are all typed unavailable", async () => {
    for (const message of [
      "The retained ChatGPT conversation is no longer available.",
      "The retained ChatGPT Web conversation was lost and can no longer be continued.",
      "Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not allowed.",
      "The retained ChatGPT Web conversation did not expose a finalized answer within 900000 ms.",
    ]) {
      const { runner: fake } = runner(async () => { throw new Error(message); });
      const result = await runAdvisorRecovery(fake, recoveryInput(), ROUTE, "recover-fail");
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
      expect(result.message).toBe(message);
      expect(result.recovered).toBe(true);
      expect(result.text).toBeUndefined();
    }
  });

  test("an empty answer is a typed failure, never an empty success", async () => {
    const { runner: fake } = runner(async () => ({ text: "   ", capturedAt: 0, waitedMs: 0 }));
    const result = await runAdvisorRecovery(fake, recoveryInput(), ROUTE, "recover-empty");
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
  });

  test("the cancellation signal reaches the read", async () => {
    const controller = new AbortController();
    const { runner: fake, calls } = runner(async () => ({ text: "answer", capturedAt: 1, waitedMs: 1 }));
    await runAdvisorRecovery(fake, recoveryInput(), ROUTE, "recover-signal", { abortSignal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("the route is echoed without changing how the identity is resolved", async () => {
    const { runner: fake } = runner(async () => ({ text: "answer", capturedAt: 1, waitedMs: 1 }));
    const result = await runAdvisorRecovery(fake, recoveryInput(), { slug: "chatgpt-web/light", backendModel: "gpt-5.6-sol", effort: "low" }, "recover-route");
    expect(result.model).toBe("chatgpt-web/light");
    expect(result.mode).toBe("normal");
  });
});
