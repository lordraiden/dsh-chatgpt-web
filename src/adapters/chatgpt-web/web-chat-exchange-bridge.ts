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

/** The ChatGPT turn state that corresponds to one core exchange state. */
const CORE_STATE_BY_PROVIDER_STATE: Readonly<Record<ProviderTurnState, WebChatExchangeState>> = {
  PREPARING: "PREPARING",
  LEASED: "PREPARING",
  SURFACE_READY: "TRANSPORT_READY",
  SUBMITTED: "SUBMITTED",
  RUNNING: "STREAMING",
  SETTLING: "COMPLETED",
  RETIRED: "COMPLETED",
};

/** The core exchange state for one ChatGPT turn state. */
export function chatGptWebChatExchangeStateOf(state: ProviderTurnState): WebChatExchangeState {
  return CORE_STATE_BY_PROVIDER_STATE[state];
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
}): { readonly leased: boolean; readonly settling: boolean; readonly retired: boolean } {
  if (observation.lost) return { leased: false, settling: false, retired: true };
  if (observation.busy) return { leased: true, settling: false, retired: false };
  if (observation.present) return { leased: false, settling: false, retired: false };
  return { leased: false, settling: false, retired: false };
}
