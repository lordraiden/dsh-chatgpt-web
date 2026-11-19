/**
 * Issue #699 (T3.1) — the browser transport's two false diagnoses and their public error contract.
 *
 * Two failures observed on 2026-11-19 drove this change:
 *
 * - 33 of 36 large-prompt turns failed with "ChatGPT response DOM disappeared" 63–74 s after the
 *   send, while ChatGPT was still working. The answer loop was the only DOM-health consumer still
 *   using the flat `CHATGPT_RESPONSE_DOM_GRACE_MS` floor: the first-token wait already used the
 *   size-scaled grace (`chatGptResponseDomGraceMs`). The loop now uses the same bound.
 * - The send control that never arms was a bare `Error`, so it reached the caller as a generic
 *   `502 upstream_server_error`. Nothing had been submitted, so it is a retry-safe surface state,
 *   and it is not — and must never become — an input-size refusal.
 *
 * The composer refusal is also pinned here: it stays a 400 and names the bound it exceeded in a
 * machine-readable clause.
 */
import { describe, expect, test } from "bun:test";

import { resolveChatGptWebTuning } from "../src/config";
import {
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptTurnDomHealthTracker,
  assertChatGptWebInputWithinLimits,
  chatGptResponseDomGraceMs,
  createChatGptTurnDomHealthTracker,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_SEND_NOT_ARMED_CODE,
  CHATGPT_COMPOSER_SEND_RETRY_AFTER_SECONDS,
  ChatGptWebAdapterError,
  chatGptComposerSendNotArmedError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptWebFailure } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { chatGptWebModelRoute } from "../src/chatgpt-web-models";
import { httpStatusFromTerminalError } from "../src/lib/errors";

const TUNING = resolveChatGptWebTuning();
const CHARS = 100_000;
/** The window a 100k-character prompt earns: 100k × 2.5 ms, below the 240 s ceiling. */
const SCALED_GRACE = chatGptResponseDomGraceMs(CHARS, TUNING);

/** The shape every DOM observation in the loop has when ChatGPT is working but re-rendering. */
const OBSERVATION = {
  responsePresent: true,
  running: false,
  currentText: "",
  completionActionVisible: false,
};

describe("issue #699 — the answer loop's DOM window scales with the prompt", () => {
  test("the grace keeps the configured floor for a small prompt", () => {
    expect(chatGptResponseDomGraceMs(1_000, TUNING)).toBe(CHATGPT_RESPONSE_DOM_GRACE_MS);
    expect(CHATGPT_RESPONSE_DOM_GRACE_MS).toBe(60_000);
  });

  test("the grace grows with the prompt size and stays under the configured ceiling", () => {
    expect(chatGptResponseDomGraceMs(CHARS, TUNING)).toBe(SCALED_GRACE);
    expect(SCALED_GRACE).toBeGreaterThan(CHATGPT_RESPONSE_DOM_GRACE_MS);
    expect(chatGptResponseDomGraceMs(10_000_000, TUNING)).toBe(TUNING.responseDomGraceMaxMs);
    expect(TUNING.responseDomGraceMaxMs).toBe(240_000);
  });

  test("a large prompt is no longer failed at the flat 60 s (the reported live failure)", () => {
    const tracker = createChatGptTurnDomHealthTracker(CHARS, TUNING);
    // ChatGPT exposed the assistant turn once, then its work/commentary phase replaced it — with no
    // Stop control visible, which is what the live Free-account surface showed.
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 1_000)).toBeUndefined();
    // The flat floor would have failed here. The scaled window must not.
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 61_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 240_999)).toBeUndefined();
    // The bound is still bounded: it expires exactly at the scaled grace.
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 1_000 + SCALED_GRACE))
      .toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });

  test("a small prompt keeps the flat floor, because it does not earn a larger window", () => {
    const tracker = createChatGptTurnDomHealthTracker(1_000, TUNING);
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 1_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 61_000))
      .toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });

  test("the tracker still clears its window when the response comes back", () => {
    const tracker = new ChatGptTurnDomHealthTracker(SCALED_GRACE);
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 1_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 100_000)).toBeUndefined();
    // The turn re-rendered: healthy again, and the next window starts over.
    expect(tracker.update({ ...OBSERVATION }, 101_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 150_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 150_000 + SCALED_GRACE))
      .toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });
});

describe("issue #699 — the send control that never arms is its own retryable failure", () => {
  test("it carries its own code, a 503 and the retry-safe surface semantics", () => {
    const error = chatGptComposerSendNotArmedError();
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect(error.status).toBe(503);
    expect(error.errorType).toBe("server_error");
    expect(error.code).toBe(CHATGPT_COMPOSER_SEND_NOT_ARMED_CODE);
    expect(error.code).toBe("composer_send_not_armed");
    expect(error.retryable).toBe(true);
    // Actionable, and explicit that nothing was sent and that the prompt was not too large.
    expect(error.message).toContain("nothing was submitted");
    expect(error.message).toContain("not a prompt-size refusal");
  });

  test("the deferral hint is a positive number of seconds", () => {
    expect(Number.isSafeInteger(CHATGPT_COMPOSER_SEND_RETRY_AFTER_SECONDS)).toBe(true);
    expect(CHATGPT_COMPOSER_SEND_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });

  test("it is transport unavailability, never an input-size refusal", () => {
    expect(classifyChatGptWebFailure(CHATGPT_COMPOSER_SEND_NOT_ARMED_CODE)).toBe("TRANSPORT_UNAVAILABLE");
    expect(classifyChatGptWebFailure(CHATGPT_COMPOSER_SEND_NOT_ARMED_CODE)).not.toBe("INPUT_TOO_LARGE");
  });

  test("the public HTTP status is the surface's retryable 503, not the old generic 502", () => {
    expect(httpStatusFromTerminalError({
      type: "server_error",
      code: CHATGPT_COMPOSER_SEND_NOT_ARMED_CODE,
      message: chatGptComposerSendNotArmedError().message,
    })).toBe(503);
    // A 503 is what makes the retry-after header meaningful; a 400 would tell the caller to fix its
    // input, which is precisely the wrong instruction here.
    expect(httpStatusFromTerminalError({
      type: "server_error",
      code: CHATGPT_COMPOSER_SEND_NOT_ARMED_CODE,
    })).not.toBe(400);
  });
});

describe("issue #699 — the composer refusal names the bound it exceeded", () => {
  // The preflight takes the provider's backend model (the public slug resolves to it), exactly like
  // the browser turn that calls it.
  const LUNA = chatGptWebModelRoute("chatgpt-web/luna")!.backendModel;

  test("an over-limit prompt keeps the 400 and publishes limit_chars/actual_chars/next_action", () => {
    const promptChars = 136_991;
    let thrown: unknown;
    try {
      assertChatGptWebInputWithinLimits(
        47_449,
        39_257,
        LUNA,
        "low",
        promptChars,
        120_000,
        137_024,
        0,
        false,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChatGptWebAdapterError);
    const error = thrown as ChatGptWebAdapterError;
    expect(error.status).toBe(400);
    expect(error.errorType).toBe("invalid_request_error");
    expect(error.code).toBe("context_compaction_required");
    // Deterministic refusal: the identical prompt can never fit, so it is not retryable.
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("limit_chars=120000");
    expect(error.message).toContain(`actual_chars=${promptChars}`);
    expect(error.message).toContain("next_action=compact");
    // The human sentence the operator already knows must survive.
    expect(error.message).toContain("120,000-character ChatGPT composer boundary");
  });

  test("the same clause names the token bound when that is the one exceeded", () => {
    let thrown: unknown;
    try {
      assertChatGptWebInputWithinLimits(
        200_000,
        200_000,
        LUNA,
        "low",
        1_000,
        120_000,
        1_004,
        0,
        false,
      );
    } catch (error) {
      thrown = error;
    }
    const error = thrown as ChatGptWebAdapterError;
    expect(error.status).toBe(400);
    expect(error.message).toContain("limit_tokens=128000");
    expect(error.message).toContain("estimated_tokens=200000");
    expect(error.message).toContain("next_action=compact");
    // Never the character clause: that bound was not the one exceeded.
    expect(error.message).not.toContain("limit_chars=");
  });
});
