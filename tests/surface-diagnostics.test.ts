/**
 * Issue #360 follow-up — the surface diagnostics that will decide the truncation and quota mappings.
 *
 * The bridge cannot prove why a turn ended, so it reports `"stop"` and a generic `429`. Two facts are
 * missing and only the real page can supply them: whether ChatGPT left a "continue generating"
 * affordance behind (a truncated generation), and what a quota dialog actually says (its reset time).
 * These probes record exactly that, as one sanitized line per event, without changing any behaviour.
 *
 * The tests pin the parts that are deterministic here: the line shape, that a diagnostic can never
 * fail a turn, and that the affordance pattern matches the localised labels without matching an
 * ordinary button.
 */
import { describe, expect, test } from "bun:test";
import {
  CHATGPT_TRUNCATION_AFFORDANCE,
  logChatGptSurfaceDiagnostic,
} from "../src/adapters/chatgpt-web/browser-worker";
import { safeErrorMessage } from "../src/lib/safe-diagnostics";

describe("surface diagnostics", () => {
  test("one sanitized line per event, with the event name and its detail", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(value => String(value)).join(" "));
    };
    try {
      logChatGptSurfaceDiagnostic("truncation-affordance", { trace: "abc123", present: true, candidates: 1 });
    } finally {
      console.info = original;
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[chatgpt-web] truncation-affordance");
    expect(lines[0]).toContain('"present":true');
    expect(lines[0]).toContain('"candidates":1');
  });

  test("a detail that cannot be serialized never fails a turn", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logChatGptSurfaceDiagnostic("rate-limit-dialog", circular)).not.toThrow();
  });

  test("a failure log carries a sanitized message, not just a name", () => {
    // The descriptor alone says "name=Error code=unknown" and cannot be diagnosed.
    expect(safeErrorMessage(new Error("ChatGPT completed with visible text that could not be serialized as Markdown")))
      .toContain("could not be serialized");
    // A URL is redacted and the text is cut to 300 characters.
    expect(safeErrorMessage(new Error("see https://example.test/x for details"))).toContain("[url]");
    expect(safeErrorMessage(new Error("x".repeat(400))).length).toBe(300);
    expect(safeErrorMessage(null)).toBe("");
  });

  test("the truncation affordance matches the localised labels and nothing else", () => {
    for (const label of ["Continue generating", "Seguir generando", "继续生成", "続きを生成", "계속 생성"]) {
      expect(CHATGPT_TRUNCATION_AFFORDANCE.test(label)).toBe(true);
    }
    for (const label of ["Send", "Stop generating", "Regenerate", "Got it"]) {
      expect(CHATGPT_TRUNCATION_AFFORDANCE.test(label)).toBe(false);
    }
  });
});
