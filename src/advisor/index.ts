/**
 * Provider-neutral Advisor host (issue #224).
 *
 * This module owns the Advisor orchestration: the eligible model catalogue, the review task
 * registry, and the start/status/recover operations. It never imports a provider adapter, a driver
 * implementation, a browser object or a DOM selector.
 */
export {
  ADVISOR_DUPLICATE_REVIEW_CODE,
  ADVISOR_INPUT_INVALID_CODE,
  ADVISOR_MODEL_UNAVAILABLE_CODE,
  ADVISOR_RECOVERY_UNAVAILABLE_CODE,
  ADVISOR_REVIEWER_PERSONA,
  ADVISOR_TASK_UNAVAILABLE_CODE,
  ADVISOR_TURN_FAILED_CODE,
  composeAdvisorReviewText,
  projectReferenceName,
  validateAdvisorReviewSource,
  type AdvisorReviewInclusion,
  type AdvisorReviewSource,
} from "./message";

export {
  advisorAffinityKey,
  advisorConversationAffinity,
  advisorConversationThread,
  type AdvisorConversationScope,
} from "./affinity";

export {
  advisorChoiceForRoute,
  buildAdvisorModelCatalogue,
  deterministicAdvisorChoice,
  preferredAdvisorChoice,
  type AdvisorModelCatalogue,
  type AdvisorModelChoice,
  type AdvisorProviderAvailability,
  type AdvisorProviderUnavailableReason,
} from "./catalogue";

export {
  createAdvisorTaskRegistry,
  isAdvisorTaskTerminal,
  type AdvisorTaskCreateInput,
  type AdvisorTaskProvenance,
  type AdvisorTaskRecord,
  type AdvisorTaskRegistry,
  type AdvisorTaskRegistryOptions,
  type AdvisorTaskSourceSummary,
  type AdvisorTaskState,
} from "./tasks";

export {
  ADVISOR_RECOVERY_TIMEOUT_MAX_MS,
  validateAdvisorRecoveryRequest,
  type AdvisorRecoveryRequest,
} from "./recovery";

export {
  AdvisorHostError,
  createAdvisorHost,
  type AdvisorHost,
  type AdvisorHostOptions,
  type AdvisorRecoveryResult,
  type AdvisorStartRequest,
  type AdvisorStartResult,
} from "./host";
