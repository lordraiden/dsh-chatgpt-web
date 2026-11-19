/**
 * Issue #699 (T3.1) / D1.3 — the 504 `turn_timeout` path: which clock it is, what it publishes.
 *
 * The bridge's own absolute turn ceiling (issue #329) is deliberately distinguishable from every
 * other failure: it names itself in the log line and in the error body. Two invariants were only
 * implicit before this suite:
 *
 * - the clock starts **at the turn**, never at request arrival, admission or account-slot wait, so a
 *   turn that queued for minutes still receives its whole budget; and
 * - the typed failure is what the caller's error event carries (status 504, `turn_timeout`, not
 *   retryable), so the Responses SSE failure and the chat-completions relay publish the same verdict.
 *
 * The loop's decision itself is covered through the two exported helpers the loop calls, because the
 * alternative — driving a real browser turn past the ceiling — is neither deterministic nor cheap.
 */
import { describe, expect, test } from "bun:test";

import {
  chatGptBrowserTurnDeadline,
  chatGptBrowserTurnDeadlineExceeded,
  chatGptBrowserTurnTimeoutFailure,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_TURN_TIMEOUT_CODE,
  chatGptTurnTimeoutError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptWebFailure } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { classifyError, httpStatusFromTerminalError } from "../src/lib/errors";

/** The deployed ceiling (see `console-content.ts`): below Hindsight's 600 s LLM timeout. */
const DEPLOYED_TURN_TIMEOUT_MS = 540_000;

describe("issue #699 — the turn clock starts at the turn, not at arrival", () => {
  test("a turn that waited for a slot still receives its whole budget", () => {
    const arrival = 1_000_000;
    const queueWaitMs = 300_000;
    const turnStart = arrival + queueWaitMs;

    const deadline = chatGptBrowserTurnDeadline(DEPLOYED_TURN_TIMEOUT_MS, turnStart);

    // The budget runs from the turn's own start.
    expect(deadline).toBe(turnStart + DEPLOYED_TURN_TIMEOUT_MS);
    // It is NOT measured from arrival: that would have given the turn 240 s less, and the queue wait
    // is exactly the time the browser never spent.
    expect(deadline).not.toBe(arrival + DEPLOYED_TURN_TIMEOUT_MS);
    expect(deadline - queueWaitMs - arrival).toBe(DEPLOYED_TURN_TIMEOUT_MS);
  });

  test("the clock is expired at the deadline and not one millisecond before", () => {
    const deadline = chatGptBrowserTurnDeadline(1_000, 0);
    expect(chatGptBrowserTurnDeadlineExceeded(deadline, 999)).toBe(false);
    expect(chatGptBrowserTurnDeadlineExceeded(deadline, 1_000)).toBe(true);
    expect(chatGptBrowserTurnDeadlineExceeded(deadline, 1_001)).toBe(true);
  });

  test("an unset deadline never expires (the historical `deadline !== undefined` guard)", () => {
    expect(chatGptBrowserTurnDeadlineExceeded(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(chatGptBrowserTurnDeadlineExceeded(undefined, 0)).toBe(false);
  });
});

describe("issue #699 — the 504 publishes the bridge's own clock", () => {
  test("the log line names the clock, the ceiling and the detail", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      chatGptBrowserTurnTimeoutFailure(DEPLOYED_TURN_TIMEOUT_MS, "ChatGPT web turn timed out");
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[chatgpt-web] turn_timeout");
    expect(warnings[0]).toContain(`limitMs=${DEPLOYED_TURN_TIMEOUT_MS}`);
    expect(warnings[0]).toContain('detail="ChatGPT web turn timed out"');
  });

  test("the error body is a 504 turn_timeout, not a provider failure and not retryable", () => {
    const error = chatGptBrowserTurnTimeoutFailure(DEPLOYED_TURN_TIMEOUT_MS, "ChatGPT web turn timed out");
    expect(error.status).toBe(504);
    expect(error.errorType).toBe("server_error");
    expect(error.code).toBe(CHATGPT_TURN_TIMEOUT_CODE);
    expect(error.code).toBe("turn_timeout");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(`${DEPLOYED_TURN_TIMEOUT_MS} ms`);
    expect(error.message).toContain("bridge's own turn clock");
    expect(error.message).toContain("not a ChatGPT failure");
  });

  test("the payload the failure event carries is the same typed error", () => {
    // The SSE `error` / failed-response payload is a projection of exactly these fields
    // (`bridge.ts` copies message/type/code/retryable from the adapter event), so pinning them here
    // pins what both public ingresses publish.
    const error = chatGptTurnTimeoutError(DEPLOYED_TURN_TIMEOUT_MS);
    const payload = classifyError(error.status, error.errorType, error.message, error.code);
    expect(payload).toEqual({
      message: error.message,
      type: "server_error",
      code: "turn_timeout",
    });
    // The chat-completions relay derives the HTTP status from that payload: still a 504.
    expect(httpStatusFromTerminalError(payload)).toBe(504);
    // And the WebChat vocabulary calls this a response timeout, never an upstream error.
    expect(classifyChatGptWebFailure(payload.code)).toBe("RESPONSE_TIMEOUT");
    expect(classifyChatGptWebFailure(payload.code)).not.toBe("UPSTREAM_ERROR");
  });
});
