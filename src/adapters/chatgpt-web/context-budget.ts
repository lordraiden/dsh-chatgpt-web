import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  type ChatGptWebAdapterEffort,
  type ChatGptWebBackendModel,
} from "../../chatgpt-web-models";
import type { CodexMessage } from "../../types";

export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 128_000;
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
  capabilities: Pick<{ solAvailable: boolean; proAvailable: boolean; experimentalBiggerContext?: boolean }, "solAvailable" | "proAvailable" | "experimentalBiggerContext">,
): ChatGptWebContextBudget {
  const backendModel = modelId as ChatGptWebBackendModel;
  const limits = resolveChatGptWebContextLimits(backendModel, effort, capabilities);
  const transport = resolveChatGptWebTransportLimits(backendModel, effort, capabilities);
  const browserMessageTokenLimit = modelId === CHATGPT_WEB_LUNA_BACKEND_MODEL
    ? CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
    : transport.browserMessageTokenLimit;
  const outputHeadroomTokens = Math.max(0, limits.contextWindow - limits.autoCompactTokenLimit);

  return {
    modelId,
    effort,
    theoreticalContextWindow: limits.contextWindow,
    preCompactionInputBudget: limits.autoCompactTokenLimit,
    outputHeadroomTokens,
    platformReserveTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    ...(browserMessageTokenLimit !== undefined ? { browserMessageTokenLimit } : {}),
    ...(transport.browserComposerCharLimit !== undefined
      ? { browserComposerCharLimit: transport.browserComposerCharLimit }
      : {}),
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
  const effectiveInputTokenBudget = budget.preCompactionInputBudget * partCount;
  const effectiveMessageTokenBudget = budget.browserMessageTokenLimit;
  const diagnostics = {
    estimatedInputTokens: measurement.estimatedInputTokens,
    estimatedMessageTokens: measurement.estimatedMessageTokens,
    ...(measurement.promptChars !== undefined ? { promptChars: measurement.promptChars } : {}),
    ...(measurement.imageCount !== undefined ? { imageCount: measurement.imageCount } : {}),
    ...(measurement.serializedInputBytes !== undefined ? { serializedInputBytes: measurement.serializedInputBytes } : {}),
    partCount,
    theoreticalContextWindow: budget.theoreticalContextWindow * partCount,
    preCompactionInputBudget: budget.preCompactionInputBudget * partCount,
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
    return {
      ...base,
      outcome: options.compactionAvailable ? "compaction_required" : "budget_exceeded",
      nextAction: options.compactionAvailable ? "compact" : "fail",
    };
  }
  if (budget.browserComposerCharLimit !== undefined
    && measurement.promptChars !== undefined
    && measurement.promptChars > budget.browserComposerCharLimit) {
    return {
      ...base,
      outcome: options.compactionAvailable ? "compaction_required" : "budget_exceeded",
      nextAction: options.compactionAvailable ? "compact" : "fail",
    };
  }
  if (effectiveMessageTokenBudget !== undefined && measurement.estimatedMessageTokens > effectiveMessageTokenBudget) {
    return {
      ...base,
      outcome: options.compactionAvailable ? "compaction_required" : "budget_exceeded",
      nextAction: options.compactionAvailable ? "compact" : "fail",
    };
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

  const protectedIndices = new Set<number>();
  const settledToolCallIds = new Set(
    current.filter(message => message.role === "toolResult").map(message => message.toolCallId),
  );
  for (let index = 0; index < current.length; index += 1) {
    const message = current[index]!;
    if (message.role === "developer" || message.role === "toolResult") {
      protectedIndices.add(index);
      continue;
    }
    if (message.role === "assistant") {
      const hasProtectedToolCall = message.content.some(
        part => part.type === "toolCall" && settledToolCallIds.has(part.id),
      );
      if (hasProtectedToolCall) protectedIndices.add(index);
    }
  }
  const latestUserIndex = [...current]
    .map((message, index) => message.role === "user" ? index : -1)
    .filter(index => index >= 0)
    .at(-1);
  if (latestUserIndex !== undefined) protectedIndices.add(latestUserIndex);

  const removableIndices = current
    .map((_message, index) => index)
    .filter(index => !protectedIndices.has(index));
  for (const index of removableIndices) {
    const next = current.filter((_message, candidateIndex) => candidateIndex !== index);
    if (fits(next)) return { messages: next, removed: messages.length - next.length };
    current = next;
  }
  throw new Error(
    "ChatGPT Web compaction transport budget cannot fit while preserving required instructions and settled tool results",
  );
}

export const CONTEXT_EXHAUSTED_CODE = "context_exhausted";
export const CONTEXT_BUDGET_EXCEEDED_CODE = "context_budget_exceeded";
export const CONTEXT_COMPACTION_REQUIRED_CODE = "context_compaction_required";
export const CONTEXT_UNSUPPORTED_CONTENT_CODE = "context_unsupported_content";
export const CONTEXT_CANONICAL_STATE_MISSING_CODE = "context_canonical_state_missing";

void CHATGPT_WEB_LUNA_MODEL_ID;