import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_COMPOSER_CHAR_LIMIT,
  CHATGPT_WEB_LUNA_CONTEXT_WINDOW,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  type ChatGptWebAdapterEffort,
} from "../../chatgpt-web-models";
import type { CodexMessage } from "../../types";

export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 128_000;
/**
 * Conservative Free-Web transport guardrail measured for this bridge. OpenAI's public ChatGPT image
 * documentation does not define a universal image-count maximum; it says the count depends on
 * image size and accompanying text. This value is therefore NOT an OpenAI product limit.
 */
export const CHATGPT_WEB_DEFAULT_IMAGE_LIMIT = 10;

/** Conservative JSON-encoded ceiling for a single compaction-control request. */
export const CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET = 110_000;

export function chatGptPromptJsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/**
 * Output headroom is the gap between the theoretical model context and the explicit pre-compaction
 * threshold. It is derived from provider limits rather than becoming another model window.
 */
export interface ChatGptWebContextBudget {
  modelId: string;
  effort: ChatGptWebAdapterEffort;
  theoreticalContextWindow: number;
  preCompactionInputBudget: number;
  outputHeadroomTokens: number;
  platformReserveTokens: number;
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
  imageLimit: number;
}

export type ChatGptWebCapacityOutcome =
  | "fits"
  | "multipart_required"
  | "compaction_required"
  | "context_exhausted"
  | "budget_exceeded"
  | "unsupported_content"
  | "canonical_state_missing";

export interface ChatGptWebCapacityMeasurement {
  estimatedInputTokens: number;
  estimatedMessageTokens: number;
  promptChars?: number;
  imageCount?: number;
  serializedInputBytes?: number;
  partCount?: 1 | 2 | 3;
}

export interface ChatGptWebCapacityDecision {
  outcome: ChatGptWebCapacityOutcome;
  nextAction: "none" | "compact" | "multipart" | "replay" | "fail";
  budget: ChatGptWebContextBudget;
  effectiveInputTokenBudget: number;
  effectiveMessageTokenBudget?: number;
  diagnostics: {
    estimatedInputTokens: number;
    estimatedMessageTokens: number;
    promptChars?: number;
    imageCount?: number;
    serializedInputBytes?: number;
    partCount: 1 | 2 | 3;
    theoreticalContextWindow: number;
    preCompactionInputBudget: number;
    outputHeadroomTokens: number;
    platformReserveTokens: number;
  };
}

export interface ChatGptWebCapacityDecisionOptions {
  compactionAvailable: boolean;
  multipartAvailable: boolean;
  productContextExhausted?: boolean;
  unsupportedContent?: boolean;
  canonicalStatePresent?: boolean;
  partCount?: 1 | 2 | 3;
}

export function resolveChatGptWebContextBudget(
  modelId: string,
  effort: ChatGptWebAdapterEffort,
  // Capability flags are retained for call-site compatibility; paid-account capability state is
  // intentionally ignored because this provider's supported matrix is ChatGPT Free Web only.
  _capabilities: Pick<{ solAvailable: boolean; proAvailable: boolean; experimentalBiggerContext?: boolean }, "solAvailable" | "proAvailable" | "experimentalBiggerContext">,
): ChatGptWebContextBudget {
  // #11-B is intentionally scoped to authenticated ChatGPT Free Web accounts. Paid-account
  // context windows and API model cards are not authoritative here. Current Free Web access is
  // represented by the Luna route; product/transport limits are measured on the browser surface.
  if (modelId !== CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    throw new Error(
      "ChatGPT Web context budgeting is defined only for the supported Free-account Luna route",
    );
  }

  const preCompactionInputBudget = CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET;
  const outputHeadroomTokens = Math.max(
    0,
    CHATGPT_WEB_LUNA_CONTEXT_WINDOW - preCompactionInputBudget,
  );

  return {
    modelId,
    effort,
    theoreticalContextWindow: CHATGPT_WEB_LUNA_CONTEXT_WINDOW,
    preCompactionInputBudget,
    outputHeadroomTokens,
    platformReserveTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    browserMessageTokenLimit: CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
    browserComposerCharLimit: CHATGPT_WEB_LUNA_COMPOSER_CHAR_LIMIT,
    imageLimit: CHATGPT_WEB_DEFAULT_IMAGE_LIMIT,
  };
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(name + " must be a finite non-negative number");
}

export function decideChatGptWebContextCapacity(
  budget: ChatGptWebContextBudget,
  measurement: ChatGptWebCapacityMeasurement,
  options: ChatGptWebCapacityDecisionOptions,
): ChatGptWebCapacityDecision {
  assertFiniteNonNegative("estimatedInputTokens", measurement.estimatedInputTokens);
  assertFiniteNonNegative("estimatedMessageTokens", measurement.estimatedMessageTokens);
  if (measurement.promptChars !== undefined) assertFiniteNonNegative("promptChars", measurement.promptChars);
  if (measurement.imageCount !== undefined) assertFiniteNonNegative("imageCount", measurement.imageCount);
  if (measurement.serializedInputBytes !== undefined) {
    assertFiniteNonNegative("serializedInputBytes", measurement.serializedInputBytes);
  }

  const partCount = options.partCount ?? 1;
  // The effective context budget cannot exceed either the provider pre-compaction threshold or the
  // browser's atomic single-message token boundary.
  const effectiveInputTokenBudget = Math.min(
    budget.preCompactionInputBudget,
    budget.browserMessageTokenLimit ?? Number.POSITIVE_INFINITY,
  ) * partCount;
  const effectiveMessageTokenBudget = budget.browserMessageTokenLimit;
  const diagnostics = {
    estimatedInputTokens: measurement.estimatedInputTokens,
    estimatedMessageTokens: measurement.estimatedMessageTokens,
    ...(measurement.promptChars !== undefined ? { promptChars: measurement.promptChars } : {}),
    ...(measurement.imageCount !== undefined ? { imageCount: measurement.imageCount } : {}),
    ...(measurement.serializedInputBytes !== undefined ? { serializedInputBytes: measurement.serializedInputBytes } : {}),
    partCount,
    theoreticalContextWindow: budget.theoreticalContextWindow * partCount,
    preCompactionInputBudget: Math.min(
      budget.preCompactionInputBudget,
      budget.browserMessageTokenLimit ?? Number.POSITIVE_INFINITY,
    ) * partCount,
    outputHeadroomTokens: budget.outputHeadroomTokens * partCount,
    platformReserveTokens: budget.platformReserveTokens,
  };
  const base = {
    budget,
    effectiveInputTokenBudget,
    ...(effectiveMessageTokenBudget !== undefined ? { effectiveMessageTokenBudget } : {}),
    diagnostics,
  };

  if (options.productContextExhausted) return { ...base, outcome: "context_exhausted", nextAction: "replay" };
  if (options.canonicalStatePresent === false) return { ...base, outcome: "canonical_state_missing", nextAction: "fail" };
  if (options.unsupportedContent) return { ...base, outcome: "unsupported_content", nextAction: "fail" };

  if (measurement.imageCount !== undefined && measurement.imageCount > budget.imageLimit) {
    return { ...base, outcome: "budget_exceeded", nextAction: "fail" };
  }
  // An atomic composer/message boundary cannot be repaired by removing older history.
  if (budget.browserComposerCharLimit !== undefined
    && measurement.promptChars !== undefined
    && measurement.promptChars > budget.browserComposerCharLimit) {
    return { ...base, outcome: "budget_exceeded", nextAction: "fail" };
  }
  if (effectiveMessageTokenBudget !== undefined && measurement.estimatedMessageTokens > effectiveMessageTokenBudget) {
    return { ...base, outcome: "budget_exceeded", nextAction: "fail" };
  }
  if (measurement.estimatedInputTokens <= effectiveInputTokenBudget) {
    return { ...base, outcome: "fits", nextAction: "none" };
  }
  // Deterministic reduction order: supported compaction/handoff first, multipart second.
  if (options.compactionAvailable) {
    return { ...base, outcome: "compaction_required", nextAction: "compact" };
  }
  if (partCount === 1 && options.multipartAvailable) {
    return { ...base, outcome: "multipart_required", nextAction: "multipart" };
  }
  return { ...base, outcome: "budget_exceeded", nextAction: "fail" };
}

/**
 * Deterministically select a smaller compaction input without touching canonical authority.
 *
 * System instructions are outside this function. Developer messages, settled tool results, the
 * assistant messages that originated those tool calls, and the latest user message are protected.
 * Older ordinary conversation messages are removed oldest-first.
 */
export function selectCompactionMessagesDeterministically(
  messages: readonly CodexMessage[],
  fits: (candidate: readonly CodexMessage[]) => boolean,
): { messages: CodexMessage[]; removed: number } {
  let current = [...messages];
  if (fits(current)) return { messages: current, removed: 0 };

  const settledToolCallIds = new Set(
    current.filter(message => message.role === "toolResult").map(message => message.toolCallId),
  );

  const isProtected = (message: CodexMessage, index: number, state: readonly CodexMessage[]): boolean => {
    if (message.role === "developer" || message.role === "toolResult") return true;
    if (message.role === "assistant") {
      if (message.content.some(
        part => part.type === "toolCall" && settledToolCallIds.has(part.id),
      )) return true;
      // Preserve the latest assistant state, including a reasoning summary, as part of deterministic
      // continuation. Older ordinary assistant history remains eligible for reduction.
      return state.slice(index + 1).every(candidate => candidate.role !== "assistant");
    }
    if (message.role === "agentMessage") {
      // Preserve the latest inter-agent message so compaction cannot erase the active handoff.
      return state.slice(index + 1).every(candidate => candidate.role !== "agentMessage");
    }
    if (message.role === "user") {
      return index === state.length - 1
        || state.slice(index + 1).every(candidate => candidate.role !== "user");
    }
    return false;
  };

  while (true) {
    const removableIndex = current.findIndex(
      (message, index, state) => !isProtected(message, index, state),
    );
    if (removableIndex < 0) {
      throw new Error(
        "ChatGPT Web compaction transport budget cannot fit while preserving required instructions and settled tool results",
      );
    }

    const next = current.filter((_message, candidateIndex) => candidateIndex !== removableIndex);
    if (fits(next)) {
      return { messages: next, removed: messages.length - next.length };
    }
    current = next;
  }
}


export const CONTEXT_EXHAUSTED_CODE = "context_exhausted";
export const CONTEXT_BUDGET_EXCEEDED_CODE = "context_budget_exceeded";
export const CONTEXT_COMPACTION_REQUIRED_CODE = "context_compaction_required";
export const CONTEXT_UNSUPPORTED_CONTENT_CODE = "context_unsupported_content";
export const CONTEXT_CANONICAL_STATE_MISSING_CODE = "context_canonical_state_missing";

