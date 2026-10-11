/**
 * ChatGPT → WebChat Core exchange bridge (issue #191).
 *
 * The provider-neutral exchange lifecycle, retry authority and transport lease live in
 * `src/web-chat/{core,transport}`; this module expresses the *existing* ChatGPT lifecycle in them,
 * without changing its behaviour and without moving ChatGPT code (issue #192 / PR 4 owns the
 * migration).
 *
 * Every projection is a pure mapping over vocabulary the ChatGPT path already owns, so the parity
 * test can hold the two implementations against each other and a later migration can be a
 * substitution rather than a reinterpretation.
 */
import type {
  WebChatExchangeState,
  WebChatLogicalSettlement,
  WebChatPhysicalSettlement,
  WebChatRetryRefusal,
  WebChatSubmissionPhase,
} from "../../web-chat/core";
import type {
  LogicalSettlementOutcome,
  PhysicalSettlementOutcome,
  ProviderRetryDecision,
  ProviderTurnState,
  SubmissionPhase,
} from "./provider-core";

/**
 * The facts the ChatGPT lifecycle actually holds.
 *
 * Its state alone cannot express the shared exchange: `SUBMITTED` means "confirmed" or "only
 * activated" depending on the submission phase, and `SETTLING`/`RETIRED` say nothing about how the
 * turn ended. The projection therefore reads state, submission phase and both outcomes together.
 */
export interface ChatGptWebChatExchangeFacts {
  readonly state: ProviderTurnState;
  readonly submission: SubmissionPhase;
  readonly logicalOutcome: LogicalSettlementOutcome;
  readonly physicalOutcome: PhysicalSettlementOutcome;
}

/** The core exchange state for the ChatGPT lifecycle facts. */
export function chatGptWebChatExchangeStateOf(facts: ChatGptWebChatExchangeFacts): WebChatExchangeState {
  /** How the end of the turn reads in the core: the logical outcome decides, and an outcome that was
   * never published stays explicit instead of being invented. */
  const atEnd = (): WebChatExchangeState => {
    switch (facts.logicalOutcome) {
      case "completed":
        return "COMPLETED";
      case "cancelled":
        return "CANCELLED";
      case "failed":
        return "FAILED";
      default:
        return "SUBMISSION_AMBIGUOUS";
    }
  };
  switch (facts.state) {
    case "PREPARING":
    case "LEASED":
      return "PREPARING";
    case "SURFACE_READY":
      return "TRANSPORT_READY";
    case "SUBMITTED":
      if (facts.submission === "accepted") return "SUBMITTED";
      if (facts.submission === "send_activated") return "SUBMISSION_AMBIGUOUS";
      return "SUBMITTING";
    case "RUNNING":
      return "STREAMING";
    case "SETTLING":
    case "RETIRED":
      return atEnd();
    default:
      return "CREATED";
  }
}

/** The submission phases are the same vocabulary; this validates rather than translates. */
export function chatGptWebChatSubmissionPhaseOf(phase: SubmissionPhase): WebChatSubmissionPhase {
  return phase satisfies WebChatSubmissionPhase;
}

/** The core logical settlement for one ChatGPT logical outcome. */
export function chatGptWebChatLogicalSettlementOf(outcome: LogicalSettlementOutcome): WebChatLogicalSettlement {
  return outcome satisfies WebChatLogicalSettlement;
}

/** The core physical settlement for one ChatGPT physical outcome. */
export function chatGptWebChatPhysicalSettlementOf(outcome: PhysicalSettlementOutcome): WebChatPhysicalSettlement {
  return outcome satisfies WebChatPhysicalSettlement;
}

/** The core retry refusal for one ChatGPT retry refusal reason. */
export function chatGptWebChatRetryRefusalOf(
  reason: ProviderRetryDecision["reason"],
): WebChatRetryRefusal | undefined {
  switch (reason) {
    case "submitted":
      return "submitted";
    case "budget_exhausted":
      return "budget_exhausted";
    case "retired":
      return "retired";
    case "policy":
      return "policy";
    default:
      return undefined;
  }
}

/**
 * The core lease shape of one retained physical surface.
 *
 * The ChatGPT registry owns exclusivity with a busy flag and a tombstone; the core lease owns the
 * same three observable facts (leased, settling, retired).
 */
export function chatGptWebChatLeaseShapeOf(observation: {
  readonly present: boolean;
  readonly busy: boolean;
  readonly lost: boolean;
  /** Whether the physical settlement of the operation that held it has been published. */
  readonly settled: boolean;
}): { readonly leased: boolean; readonly settling: boolean; readonly settled: boolean; readonly retired: boolean } {
  if (observation.lost) return { leased: false, settling: false, settled: false, retired: true };
  if (observation.busy) return { leased: true, settling: false, settled: observation.settled, retired: false };
  if (observation.present) {
    // Present and free of an operation, but not reusable until its settlement is known.
    return { leased: false, settling: !observation.settled, settled: observation.settled, retired: false };
  }
  return { leased: false, settling: false, settled: false, retired: false };
}
