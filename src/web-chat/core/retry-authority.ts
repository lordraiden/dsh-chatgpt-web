/**
 * Retry authority for one exchange (architecture §9.1, §9.4).
 *
 * There are two retry layers — the exchange's own retry inside one logical turn, and the host's
 * route-level retry around the adapter — and they must never both retry the same submitted turn.
 * This module is the single owner of the classification that keeps them apart: it turns the
 * exchange's lifecycle facts into
 *
 * - the **safety** the host layer is allowed to act on (`retry_safe`, `not_retry_safe`, `ambiguous`), and
 * - the **decision** the exchange itself may make (allowed or refused, with the reason).
 *
 * The rules are the semantic minimum of §9.4:
 *
 * - a pre-submission transport failure may be retry-safe;
 * - a confirmed submission is not automatically retry-safe;
 * - an ambiguous submission is never automatically retry-safe;
 * - receiving partial output is *not* evidence that the request was never submitted.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import { webChatError } from "./errors";
import type { WebChatExchangeSnapshot } from "./exchange-state";

/** What the host layer may do with a failed turn. */
export type WebChatRetrySafety = "retry_safe" | "not_retry_safe" | "ambiguous";

/** Why a retry was refused (or why it is not automatic). */
export type WebChatRetryRefusal =
  | "submitted"
  | "ambiguous"
  | "budget_exhausted"
  | "retired"
  | "cancelled"
  | "partial_output"
  | "policy";

/** The exchange's own decision for the next attempt. */
export interface WebChatRetryDecision {
  readonly allowed: boolean;
  readonly safety: WebChatRetrySafety;
  readonly reason?: WebChatRetryRefusal;
  /** Attempts already made. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** The lifecycle facts a retry decision is made from. */
export interface WebChatRetryObservation {
  readonly snapshot: WebChatExchangeSnapshot;
  /**
   * Whether any incremental output was observed for this turn.
   *
   * A delta is output: it proves the provider acted on the request, so it can never be treated as
   * evidence that nothing was submitted.
   */
  readonly partialOutputObserved?: boolean;
}

/** Retry policy of one exchange. */
export type WebChatRetryPolicy = "strict" | "side_effect_free";

/**
 * Classify what the host layer may do with this exchange.
 *
 * @param observation - the exchange snapshot and whether output was observed.
 * @returns the retry safety of the turn.
 */
export function webChatRetrySafetyOf(observation: WebChatRetryObservation): WebChatRetrySafety {
  const { snapshot } = observation;
  if (snapshot.retired) return "not_retry_safe";
  if (snapshot.state === "SUBMISSION_AMBIGUOUS" || snapshot.phase === "send_activated") return "ambiguous";
  if (snapshot.phase === "accepted") return "not_retry_safe";
  if (
    snapshot.state === "SUBMITTED"
    || snapshot.state === "STREAMING"
    || snapshot.state === "COMPLETED"
  ) {
    return "not_retry_safe";
  }
  if (observation.partialOutputObserved === true) return "not_retry_safe";
  if (snapshot.state === "CANCELLED") return "not_retry_safe";
  return "retry_safe";
}

/** The reason a refusal must carry, when one applies. */
function refusalReason(observation: WebChatRetryObservation): WebChatRetryRefusal | undefined {
  const { snapshot } = observation;
  if (snapshot.retired) return "retired";
  if (snapshot.state === "CANCELLED") return "cancelled";
  if (snapshot.state === "SUBMISSION_AMBIGUOUS" || snapshot.phase === "send_activated") return "ambiguous";
  if (observation.partialOutputObserved === true) return "partial_output";
  if (snapshot.phase === "accepted" || snapshot.state === "SUBMITTED" || snapshot.state === "STREAMING" || snapshot.state === "COMPLETED") {
    return "submitted";
  }
  return undefined;
}

/**
 * Decide whether the exchange may attempt the submission again.
 *
 * The budget is owned here so that the host's route-level retry and the exchange's internal retry
 * cannot both act on the same submitted turn.
 *
 * @param observation - the exchange snapshot and whether output was observed.
 * @param options - the exchange's retry policy.
 * @returns the decision, always carrying the reason when it refuses.
 * @throws {WebChatError} `UNSUPPORTED_OPTION` for an unknown policy.
 */
export function decideWebChatRetry(
  observation: WebChatRetryObservation,
  options: { readonly policy?: WebChatRetryPolicy } = {},
): WebChatRetryDecision {
  const policy = options.policy ?? "strict";
  if (policy !== "strict" && policy !== "side_effect_free") {
    throw webChatError("UNSUPPORTED_OPTION", `Unknown WebChat retry policy "${String(policy)}"`);
  }
  const { snapshot } = observation;
  const safety = webChatRetrySafetyOf(observation);
  const attempt = snapshot.submits;
  const maxAttempts = snapshot.maxSubmits;
  const reason = refusalReason(observation);
  if (reason !== undefined) {
    return { allowed: false, safety, reason, attempt, maxAttempts };
  }
  if (attempt >= maxAttempts) {
    return { allowed: false, safety, reason: "budget_exhausted", attempt, maxAttempts };
  }
  // A side-effect-free policy only ever retries what provably had no provider effect; a strict
  // policy adds no exceptions to the safety classification above.
  if (policy === "side_effect_free" && safety !== "retry_safe") {
    return { allowed: false, safety, reason: "policy", attempt, maxAttempts };
  }
  return { allowed: true, safety, attempt, maxAttempts };
}
