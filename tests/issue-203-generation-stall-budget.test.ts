import { describe, expect, test } from "bun:test";

import {
  CHATGPT_WEB_TUNING_DEFAULTS,
  resolveChatGptWebTuning,
  validateChatGptWebTuning,
} from "../src/config";
import {
  chatGptGenerationRunningStallExceeded,
  resolveBrowserConfig,
} from "../src/adapters/chatgpt-web/browser-worker";
import type { CodexProviderConfig } from "../src/types";

/**
 * Issue #203 — the generation-running stall budget.
 *
 * The worker fails a turn whose assistant material never appeared once ChatGPT has kept its
 * Stop button visible (generation running) for a fixed budget. That budget used to be a
 * hardcoded 5 minutes, which failed turns ChatGPT was still legitimately running (long
 * reasoning, long answers, connector waits) and could not be tuned. It now lives in the
 * browser transport tuning with a 15-minute default.
 */

const MINUTES = 60_000;

/** The browser provider envelope the resolver needs; only transport tuning matters here. */
function provider(tuning?: Record<string, number>): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "http://127.0.0.1:17841",
    chatgptWeb: tuning ? { tuning } : {},
  };
}

describe("issue #203 — the stall budget default is tolerant and tunable", () => {
  test("the default budget no longer fails a five-minute generation", () => {
    const tuning = resolveChatGptWebTuning();
    expect(tuning.generationRunningStallMs).toBe(CHATGPT_WEB_TUNING_DEFAULTS.generationRunningStallMs);
    expect(tuning.generationRunningStallMs).toBe(15 * MINUTES);
    // The reported failure: ChatGPT was still generating at five minutes.
    expect(chatGptGenerationRunningStallExceeded(0, 5 * MINUTES, tuning)).toBe(false);
  });

  test("only a window past the configured budget is treated as stuck", () => {
    const tuning = resolveChatGptWebTuning();
    expect(chatGptGenerationRunningStallExceeded(0, tuning.generationRunningStallMs, tuning)).toBe(false);
    expect(chatGptGenerationRunningStallExceeded(0, tuning.generationRunningStallMs + 1, tuning)).toBe(true);
  });

  test("an absent generation window is never a stall", () => {
    const tuning = resolveChatGptWebTuning();
    // The Stop button disappeared (or was never visible): nothing is generating.
    expect(chatGptGenerationRunningStallExceeded(undefined, 10 * MINUTES, tuning)).toBe(false);
  });

  test("the previous five-minute behaviour stays available and any value is honored", () => {
    const strict = resolveChatGptWebTuning({ generationRunningStallMs: 5 * MINUTES });
    expect(strict.generationRunningStallMs).toBe(5 * MINUTES);
    expect(chatGptGenerationRunningStallExceeded(0, 5 * MINUTES + 1, strict)).toBe(true);

    const tolerant = resolveChatGptWebTuning({ generationRunningStallMs: 30 * MINUTES });
    expect(tolerant.generationRunningStallMs).toBe(30 * MINUTES);
    expect(chatGptGenerationRunningStallExceeded(0, 20 * MINUTES, tolerant)).toBe(false);
  });

  test("invalid values fall back to the default instead of disabling the budget", () => {
    const tuning = resolveChatGptWebTuning({ generationRunningStallMs: 0 });
    expect(tuning.generationRunningStallMs).toBe(CHATGPT_WEB_TUNING_DEFAULTS.generationRunningStallMs);
  });

  test("a browser provider config carries the resolved budget to the worker", () => {
    expect(resolveBrowserConfig(provider()).tuning.generationRunningStallMs).toBe(15 * MINUTES);
    expect(resolveBrowserConfig(provider({ generationRunningStallMs: 20 * MINUTES })).tuning.generationRunningStallMs)
      .toBe(20 * MINUTES);
  });

  test("the tuning validator accepts the key and still rejects unknown keys", () => {
    expect(validateChatGptWebTuning({ generationRunningStallMs: 600_000 })).toEqual({ generationRunningStallMs: 600_000 });
    expect(() => validateChatGptWebTuning({ generationRunningStall: 600_000 })).toThrow(/Unknown tuning key/);
    expect(() => validateChatGptWebTuning({ generationRunningStallMs: 0 })).toThrow(/Invalid tuning/);
  });
});
