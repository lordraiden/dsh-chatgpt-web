/** Prefix used by Codex for a human-readable remote-compaction summary. */
export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";

/** True when a user-visible message carries the readable Codex compaction summary envelope. */
export function isReadableCompactionSummaryText(value: unknown): value is string {
  // The newline is REAL, not an escape: the producer (`compactionItemToText`) writes
  // `${SUMMARY_PREFIX}\n\n${decoded}`, so a doubled backslash here would make this guard unable to ever
  // match (issue #262). The regression test pins the producer's shape against this predicate.
  return typeof value === "string" && value.startsWith(`${SUMMARY_PREFIX}\n`);
}


/** Prompt used by routed providers for Codex-compatible remote compaction. */
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
