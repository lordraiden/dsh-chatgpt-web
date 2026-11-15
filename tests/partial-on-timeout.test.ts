/**
 * Opt-in partial answer when the bridge's own turn clock expires (issue #360 follow-up).
 *
 * Observed live: a generation that hits the provider's output budget never completes on this account.
 * The bridge waits for a completion action that never arrives, the turn dies on its own 540 s clock and
 * returns `504 turn_timeout`, discarding 14 000+ visible characters. A chat caller would rather receive
 * that partial text with `finish_reason: "length"`.
 *
 * The change is opt-in and off by default: a deployment that does not ask for it keeps the existing
 * 504 behaviour exactly. These tests pin the three deterministic pieces, with no browser involved:
 *
 * 1. the switch resolution (config wins over env, env `1`/`true` enables, absent/`0`/`false` disables,
 *    a malformed value fails closed and names the variable);
 * 2. the deadline decision (off ⇒ the existing `turn_timeout` error; on + visible text ⇒ partial);
 * 3. the truncation signal's route to the caller (`max_tokens` → the bridge's existing
 *    `finish_reason: "length"` mapping, issue #354, which this change deliberately does not duplicate).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PARTIAL_ON_TIMEOUT_ENV,
  chatGptTurnTimeoutAction,
  resolveBrowserConfig,
  resolvePartialOnTurnTimeout,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_TURN_TIMEOUT_CODE,
  chatGptTurnTimeoutError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  chatGptBrowserStopReason,
  type ChatGptBrowserOutcome,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import { buildResponseJSON } from "../src/bridge";
import { chatFinishReason } from "../src/responses/chat-completions";
import type { CodexProviderConfig } from "../src/types";

const MINUTES = 60_000;

/** The browser provider envelope the resolver needs. */
function provider(chatgptWeb: Record<string, unknown> = {}): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "http://127.0.0.1:17841",
    chatgptWeb,
  } as unknown as CodexProviderConfig;
}

/** A `final` browser outcome, the only variant the stop-reason mapping accepts. */
function finalOutcome(
  answer: string,
  truncated?: boolean,
): Extract<ChatGptBrowserOutcome, { type: "final" }> {
  return { type: "final", answer, ...(truncated === undefined ? {} : { truncated }) };
}

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[PARTIAL_ON_TIMEOUT_ENV];
  delete process.env[PARTIAL_ON_TIMEOUT_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[PARTIAL_ON_TIMEOUT_ENV];
  else process.env[PARTIAL_ON_TIMEOUT_ENV] = saved;
});

describe("the partial-on-timeout switch is opt-in and off by default", () => {
  test("absent configuration and absent environment resolve to false", () => {
    expect(resolvePartialOnTurnTimeout(undefined, {})).toBe(false);
    // The worker carries the resolved switch, so there is no "maybe" state at the deadline check.
    expect(resolveBrowserConfig(provider()).partialOnTurnTimeout).toBe(false);
  });

  test("the environment accepts 1/true as enable and 0/false/blank as disable", () => {
    for (const raw of ["1", "true", "TRUE", "  true  ", "True"]) {
      expect(resolvePartialOnTurnTimeout(undefined, { [PARTIAL_ON_TIMEOUT_ENV]: raw })).toBe(true);
    }
    for (const raw of ["0", "false", "FALSE", "", "   "]) {
      expect(resolvePartialOnTurnTimeout(undefined, { [PARTIAL_ON_TIMEOUT_ENV]: raw })).toBe(false);
    }
  });

  test("an explicit configuration wins over the environment", () => {
    expect(resolvePartialOnTurnTimeout(false, { [PARTIAL_ON_TIMEOUT_ENV]: "1" })).toBe(false);
    expect(resolvePartialOnTurnTimeout(true, { [PARTIAL_ON_TIMEOUT_ENV]: "0" })).toBe(true);
    process.env[PARTIAL_ON_TIMEOUT_ENV] = "1";
    expect(resolveBrowserConfig(provider()).partialOnTurnTimeout).toBe(true);
    expect(resolveBrowserConfig(provider({ partialOnTurnTimeout: false })).partialOnTurnTimeout).toBe(false);
    expect(resolveBrowserConfig(provider({ partialOnTurnTimeout: true })).partialOnTurnTimeout).toBe(true);
  });

  test("a malformed environment value fails closed and names the variable", () => {
    for (const raw of ["yes", "on", "enabled", "2"]) {
      expect(() => resolvePartialOnTurnTimeout(undefined, { [PARTIAL_ON_TIMEOUT_ENV]: raw }))
        .toThrow(new RegExp(PARTIAL_ON_TIMEOUT_ENV));
    }
    expect(() => resolvePartialOnTurnTimeout(undefined, { [PARTIAL_ON_TIMEOUT_ENV]: "yes" }))
      .toThrow(/expected 1 or true/);
    // The configuration resolver is the single validation point, so a bad deployment value is
    // refused before any turn starts rather than silently choosing one behaviour.
    process.env[PARTIAL_ON_TIMEOUT_ENV] = "yes";
    expect(() => resolveBrowserConfig(provider())).toThrow(new RegExp(PARTIAL_ON_TIMEOUT_ENV));
  });

  test("a non-boolean configured value is refused", () => {
    expect(() => resolvePartialOnTurnTimeout("true" as unknown as boolean, {}))
      .toThrow(/partialOnTurnTimeout/);
    expect(() => resolveBrowserConfig(provider({ partialOnTurnTimeout: "true" })))
      .toThrow(/partialOnTurnTimeout/);
  });
});

describe("the deadline decision keeps the existing failure unless the switch is on", () => {
  test("with the switch off the timeout path still raises the 504 turn_timeout error", () => {
    // The decision is what the main turn loop applies at its deadline: with the switch off it is
    // always "timeout", so the visible text is discarded exactly as before.
    expect(chatGptTurnTimeoutAction(false, "14 000 visible characters")).toBe("timeout");
    const error = chatGptTurnTimeoutError(15 * MINUTES);
    expect(error.code).toBe(CHATGPT_TURN_TIMEOUT_CODE);
    expect(error.code).toBe("turn_timeout");
    expect(error.status).toBe(504);
    expect(error.retryable).toBe(false);
  });

  test("with the switch on and visible text the turn concludes with the partial answer", () => {
    expect(chatGptTurnTimeoutAction(true, "the visible partial answer")).toBe("partial");
    // There is nothing to return without visible text, so the honest failure stays.
    expect(chatGptTurnTimeoutAction(true, "")).toBe("timeout");
    expect(chatGptTurnTimeoutAction(true, "   \n\t ")).toBe("timeout");
  });
});

describe("the truncation signal reaches the caller", () => {
  test("a truncated final outcome reports max_tokens; an ordinary one reports stop", () => {
    expect(chatGptBrowserStopReason(finalOutcome("partial answer", true))).toBe("max_tokens");
    expect(chatGptBrowserStopReason(finalOutcome("complete answer"))).toBe("stop");
    expect(chatGptBrowserStopReason(finalOutcome("complete answer", false))).toBe("stop");
  });

  test("the turn session carries the worker's truncation signal into its final outcome", async () => {
    const runtime = {
      mode: "read-only",
      capabilitySnapshot: {},
      browser: Promise.resolve("the visible partial answer"),
      truncated: () => true,
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    } as unknown as ChatGptTurnRuntime;
    const truncatedOutcome = await new ChatGptTurnSession(runtime).browserOutcome;
    expect(truncatedOutcome).toEqual({
      type: "final",
      answer: "the visible partial answer",
      truncated: true,
    });

    const completeRuntime = { ...runtime, truncated: () => false } as unknown as ChatGptTurnRuntime;
    const completeOutcome = await new ChatGptTurnSession(completeRuntime).browserOutcome;
    expect(completeOutcome).toEqual({ type: "final", answer: "the visible partial answer" });
  });

  test("the bridge already maps max_tokens to finish_reason length, so it is not duplicated", () => {
    // This is the existing issue #354 path the adapter relies on: `stopReason: "max_tokens"` becomes
    // an incomplete Responses payload whose reason is `max_output_tokens`, and the chat-completions
    // surface proves `finish_reason: "length"` from exactly that.
    const truncated = buildResponseJSON(
      [{ type: "done", stopReason: "max_tokens", endTurn: true }],
      "gpt-5",
    );
    expect(truncated.status).toBe("incomplete");
    expect(truncated.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(chatFinishReason(truncated)).toBe("length");

    const complete = buildResponseJSON(
      [{ type: "done", stopReason: "stop", endTurn: true }],
      "gpt-5",
    );
    expect(complete.status).toBe("completed");
    expect(chatFinishReason(complete)).toBe("stop");
  });
});
