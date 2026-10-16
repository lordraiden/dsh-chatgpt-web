import { describe, expect, test } from "bun:test";
import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE, SUMMARY_PREFIX } from "../src/lib/compaction";

/**
 * Issue #262 — the readable Codex compaction envelope.
 *
 * The guard used a DOUBLED backslash inside a template literal, so its needle was the two characters
 * `\` and `n` while the producer writes a real newline. It could never match, and because it fails
 * silently the defect survived review. These tests pin the producer's shape against the predicate so
 * the escape cannot come back unnoticed.
 */
describe("issue #262 — the readable-compaction envelope", () => {
  test("what the producer emits is recognised", () => {
    // Exactly how `compactionItemToText` builds it: a real newline after the prefix.
    expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nThe summary body.`)).toBe(true);
    expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nbody`)).toBe(true);
  });

  test("a literal backslash-n is NOT the envelope (the regression that hid the bug)", () => {
    // This is what the guard used to look for. If someone reintroduces the escaped needle, the
    // "recognised" test above fails instead of the failure staying silent.
    expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\\nbody`)).toBe(false);
  });

  test("anything else is not the envelope", () => {
    expect(isReadableCompactionSummaryText(OPAQUE_COMPACTION_NOTE)).toBe(false);
    expect(isReadableCompactionSummaryText(SUMMARY_PREFIX)).toBe(false);
    expect(isReadableCompactionSummaryText("just a user message")).toBe(false);
    expect(isReadableCompactionSummaryText(undefined)).toBe(false);
    expect(isReadableCompactionSummaryText(42)).toBe(false);
  });

  test("the opaque note and the prefix are distinct, non-empty strings", () => {
    expect(SUMMARY_PREFIX.length).toBeGreaterThan(0);
    expect(OPAQUE_COMPACTION_NOTE).not.toBe(SUMMARY_PREFIX);
  });
});
