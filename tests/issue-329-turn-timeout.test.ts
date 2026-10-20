/**
 * Issue #329 — the bridge's own turn ceiling is explicit, configurable and distinguishable.
 *
 * The failed session showed a legitimate turn running for 4 m 21 s (sometimes more than 10 minutes).
 * Raising any *client* timeout is not the fix: the client's 300 s idle timer is satisfied by the SSE
 * keep-alive, and the only remaining clock is the bridge's own "this turn is taking too long" bound.
 * That bound must exist (a provider turn can hang forever), must be deployable without editing JSON,
 * and must say in the error and the log that it was the bridge's clock — not ChatGPT.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_TURN_TIMEOUT_MS,
  MAX_TURN_TIMEOUT_MS,
  TURN_TIMEOUT_ENV,
  resolveBrowserConfig,
  resolveTurnTimeoutMs,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_TURN_TIMEOUT_CODE,
  chatGptTurnTimeoutError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptWebFailure } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { httpStatusFromTerminalError } from "../src/lib/errors";
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

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[TURN_TIMEOUT_ENV];
  delete process.env[TURN_TIMEOUT_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[TURN_TIMEOUT_ENV];
  else process.env[TURN_TIMEOUT_ENV] = saved;
});

describe("issue #329 — the bridge turn ceiling", () => {
  test("defaults to 15 minutes, which is longer than the measured 10+ minute turns but still bounded", () => {
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(15 * MINUTES);
    expect(resolveTurnTimeoutMs(undefined, {})).toBe(15 * MINUTES);
    // The worker carries the resolved ceiling, so there is no "no deadline" state left.
    expect(resolveBrowserConfig(provider()).turnTimeoutMs).toBe(15 * MINUTES);
  });

  test("the environment override is accepted, and an explicit configuration wins over it", () => {
    expect(resolveTurnTimeoutMs(undefined, { [TURN_TIMEOUT_ENV]: "1200000" })).toBe(20 * MINUTES);
    expect(resolveBrowserConfig(provider()).turnTimeoutMs).toBe(15 * MINUTES);
    process.env[TURN_TIMEOUT_ENV] = "1800000";
    expect(resolveBrowserConfig(provider()).turnTimeoutMs).toBe(30 * MINUTES);
    // A deliberate provider configuration is the more specific authority.
    expect(resolveBrowserConfig(provider({ turnTimeoutMs: 25 * MINUTES })).turnTimeoutMs).toBe(25 * MINUTES);
  });

  test("a malformed or out-of-range environment value fails closed with an actionable message", () => {
    // An empty value is "unset" (the default applies); anything else must be a valid integer.
    expect(resolveTurnTimeoutMs(undefined, { [TURN_TIMEOUT_ENV]: "   " })).toBe(15 * MINUTES);
    for (const raw of ["0", "-1", "1.5", "abc", "15m", String(MAX_TURN_TIMEOUT_MS + 1)]) {
      expect(() => resolveTurnTimeoutMs(undefined, { [TURN_TIMEOUT_ENV]: raw }))
        .toThrow(new RegExp(TURN_TIMEOUT_ENV));
    }
    expect(() => resolveTurnTimeoutMs(undefined, { [TURN_TIMEOUT_ENV]: "abc" }))
      .toThrow(/positive integer number of milliseconds/);
    // The accepted upper bound itself is valid.
    expect(resolveTurnTimeoutMs(undefined, { [TURN_TIMEOUT_ENV]: String(MAX_TURN_TIMEOUT_MS) }))
      .toBe(MAX_TURN_TIMEOUT_MS);
  });

  test("a malformed configured value keeps the existing fail-closed behaviour", () => {
    expect(() => resolveBrowserConfig(provider({ turnTimeoutMs: 0 }))).toThrow(/turnTimeoutMs/);
    expect(() => resolveBrowserConfig(provider({ turnTimeoutMs: Number.NaN }))).toThrow(/turnTimeoutMs/);
  });

  test("the timeout is its own failure code, classified as a response timeout, never a provider failure", () => {
    const error = chatGptTurnTimeoutError(15 * MINUTES);
    expect(error.code).toBe(CHATGPT_TURN_TIMEOUT_CODE);
    expect(error.code).toBe("turn_timeout");
    expect(error.retryable).toBe(false);
    // The message names the bridge's clock, so a caller/operator is not told ChatGPT failed.
    expect(error.message).toMatch(/bridge's own turn clock/);
    expect(error.message).toContain("900000");
    // The common classification treats it as a response timeout, not an upstream/provider error.
    expect(classifyChatGptWebFailure(error.code)).toBe("RESPONSE_TIMEOUT");
    // The HTTP status mapping: a timeout is 504, not a generic 502 upstream failure.
    expect(httpStatusFromTerminalError({
      type: error.errorType,
      code: error.code,
      message: error.message,
    })).toBe(504);
  });
});
