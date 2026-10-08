/**
 * Provider-neutral selection policy for browser-backed web-chat composers.
 *
 * Browser providers own discovery (selectors and DOM inspection); this helper
 * owns only the shared safety rule: choose one usable editor from duplicate,
 * stale, or overlapping DOM candidates without treating cardinality as health.
 */

export interface WebComposerCandidate {
  /** Stable key assigned by the provider while inspecting one DOM candidate. */
  id: string;
  /** Provider selector priority; lower values are preferred when otherwise equal. */
  selectorPriority: number;
  /** Whether the candidate is rendered and usable in the current viewport. */
  visible: boolean;
  /** Whether the candidate accepts user text input. */
  editable: boolean;
  /** Whether the candidate is currently enabled for input. */
  enabled: boolean;
  /** Rendered area in CSS pixels; zero-area placeholders are not usable. */
  area: number;
}

/**
 * Return the id of the canonical composer candidate, if one exists.
 *
 * Candidate discovery remains provider-specific so another web chat can use
 * its own selectors and DOM semantics. The selection contract is shared:
 * disabled, non-editable, invisible, and zero-area placeholders are rejected.
 * Duplicate matches from different selectors are safe only when the highest
 * priority selector identifies one candidate. Multiple usable candidates from
 * that same selector remain ambiguous and fail closed: area is not evidence
 * of conversation ownership.
 */
export function selectCanonicalWebComposer(
  candidates: readonly WebComposerCandidate[],
): string | undefined {
  const usable = candidates.filter(candidate =>
    candidate.visible && candidate.editable && candidate.enabled && candidate.area > 0,
  );
  if (usable.length === 0) return undefined;
  const bestPriority = Math.min(...usable.map(candidate => candidate.selectorPriority));
  const best = usable.filter(candidate => candidate.selectorPriority === bestPriority);
  return best.length === 1 ? best[0]!.id : undefined;
}
