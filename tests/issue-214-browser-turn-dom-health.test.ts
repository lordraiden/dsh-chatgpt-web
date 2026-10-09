import { describe, expect, test } from "bun:test";

import { ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

/**
 * Issue #214 — a visible generation must suspend the browser worker's "missing response" window.
 *
 * The reported failure (`diagnostics/browser-turns/b3176f2ccc12-28d16de5/12-turn-failed.json`):
 * ChatGPT was still working, its work/commentary phase re-rendered the assistant turn element
 * away, and 60 s later the turn was failed with "ChatGPT response DOM disappeared while the
 * browser turn was active" — even though the answer was on screen and the Stop button proved the
 * model was still generating. The tracker already had the `running` evidence in every call site
 * and used it only for the completion conclusions.
 */

const OBSERVATION = {
  responsePresent: true,
  running: true,
  currentText: "trabajando",
  completionActionVisible: false,
};

describe("issue #214 — the missing-response window", () => {
  test("a visible generation suspends the window indefinitely (the reported failure)", () => {
    const tracker = new ChatGptTurnDomHealthTracker(1_000);
    // The turn started and ChatGPT exposed an assistant turn once.
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    // Then the work/commentary phase replaced it: the element is gone, but generation is visible.
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 5_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 60_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false }, 900_000)).toBeUndefined();
    // When the answer finally renders, the turn is healthy again.
    expect(tracker.update({ ...OBSERVATION, responsePresent: true }, 901_000)).toBeUndefined();
  });

  test("without a visible generation the disappeared response is still diagnosed", () => {
    const tracker = new ChatGptTurnDomHealthTracker(1_000);
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    // The Stop button is gone: this is no longer a re-render.
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 2_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 3_001))
      .toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });

  test("a send that never produced a response is still diagnosed", () => {
    const tracker = new ChatGptTurnDomHealthTracker(1_000);
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 0)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 1_001))
      .toBe("ChatGPT did not create a response DOM after the message was sent");
  });

  test("the window restarts after the generation stops rather than concluding on stale time", () => {
    const tracker = new ChatGptTurnDomHealthTracker(1_000);
    // The turn did expose an assistant turn before the work phase replaced it.
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: true }, 1_000)).toBeUndefined();
    // 10 minutes of visible generation, then the button disappears with no response in the DOM.
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 600_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 600_500)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 601_001))
      .toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });

  test("proven external progress keeps its own suspension", () => {
    const tracker = new ChatGptTurnDomHealthTracker(1_000);
    // A response was seen once, then external tool work suspended the DOM checks.
    expect(tracker.update({ ...OBSERVATION }, 0)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false, externalProgressLive: true }, 1_000))
      .toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false, externalProgressLive: true }, 60_000))
      .toBeUndefined();
    // Progress ends: the window starts from that observation, not from the first one.
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 61_000)).toBeUndefined();
    expect(tracker.update({ ...OBSERVATION, responsePresent: false, running: false }, 62_001))
      .toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });
});

describe("issue #214 — the completion conclusions are unchanged", () => {
  test("an empty completed turn is still diagnosed", () => {
    const tracker = new ChatGptTurnDomHealthTracker(60_000, 1_000, 60_000);
    const empty = { responsePresent: true, running: false, currentText: "", completionActionVisible: true };
    expect(tracker.update(empty, 0)).toBeUndefined();
    expect(tracker.update(empty, 1_001)).toBe("ChatGPT browser turn completed without a final answer");
  });

  test("an empty turn that is still generating is not concluded", () => {
    const tracker = new ChatGptTurnDomHealthTracker(60_000, 1_000, 60_000);
    const empty = { responsePresent: true, running: true, currentText: "", completionActionVisible: true };
    expect(tracker.update(empty, 0)).toBeUndefined();
    expect(tracker.update(empty, 60_000)).toBeUndefined();
  });

  test("a completed turn with text but no completion action is still diagnosed", () => {
    const tracker = new ChatGptTurnDomHealthTracker(60_000, 1_000, 1_000);
    const stalled = { responsePresent: true, running: false, currentText: "respuesta", completionActionVisible: false };
    expect(tracker.update(stalled, 0)).toBeUndefined();
    expect(tracker.update(stalled, 1_001))
      .toBe("ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed");
  });
});
