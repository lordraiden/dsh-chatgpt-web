import { isOnePixelPngDataUrl } from "../../responses/compaction";
import type { CodexAssistantContentPart, CodexContentPart, CodexMessage } from "../../types";

export const CHATGPT_WEB_MAX_INPUT_IMAGES = 10;

export interface ChatGptWebPromptImage {
  ref: string;
  imageUrl: string;
  detail?: string;
}

export interface CanonicalChatGptWebContext {
  readonly version: 3;
  readonly system: readonly string[];
  readonly messages: readonly Record<string, unknown>[];
  readonly images: readonly ChatGptWebPromptImage[];
}

/**
 * Canonical ChatGPT Web projection boundary.
 *
 * DSH-native message/session state is the source of truth. This module converts that state into the
 * structured conversation data consumed by ChatGPT Web without depending on browser state,
 * conversation/thread ids, DOM state, or transport handles.
 */
export function projectCanonicalChatGptWebContext(
  system: readonly string[],
  sourceMessages: readonly CodexMessage[],
): CanonicalChatGptWebContext {
  const messages = withoutSupersededModelSwitchContracts(sourceMessages);
  const images: ChatGptWebPromptImage[] = [];
  const projectedMessages = messages.map(message =>
    messageEnvelope(message, images)
  );

  return Object.freeze({
    version: 3,
    system: Object.freeze([...system]),
    messages: Object.freeze(projectedMessages),
    images: Object.freeze(images),
  });
}

export function serializeCanonicalChatGptWebContext(
  context: CanonicalChatGptWebContext,
): string {
  return withoutRetiredTurnHandles(JSON.stringify({
    version: context.version,
    system: context.system,
    messages: context.messages,
  }));
}

const RETIRED_TRANSPORT_HANDLE_KEYS = new Set([
  "__transport_handle",
  "__turn_handle",
  "__request_handle",
  "__binding_handle",
  "__activity_handle",
  "__surface_handle",
]);

/**
 * Remove only metadata keys that this plugin historically injected as transport handles.
 * This function is intentionally not a general JSON scrubber/normalizer: values and unrelated
 * user/tool-owned fields remain byte-for-byte unchanged by this semantic step.
 */
function sanitizeRetiredTransportFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRetiredTransportFields);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (RETIRED_TRANSPORT_HANDLE_KEYS.has(key)) {
      result[key] = "[retired transport handle]";
      continue;
    }
    result[key] = sanitizeRetiredTransportFields(child);
  }
  return result;
}

export function withoutRetiredTurnHandles(contextJson: string): string {
  try {
    return JSON.stringify(sanitizeRetiredTransportFields(JSON.parse(contextJson)));
  } catch {
    // The canonical serializer emits JSON. Preserve non-JSON caller input rather than mutating
    // arbitrary user-authored text that merely resembles an opaque browser handle.
    return contextJson;
  }
}


/**
 * Apply the provider's measured Free-Web transport image budget after canonical projection.
 *
 * This is deliberately separate from the canonical projection: canonical DSH context retains every
 * supported semantic image, while the transport projection may replace only the oldest excess
 * attachments with an explicit note.
 */
import { isOnePixelPngDataUrl } from "../../responses/compaction";
import type { CodexAssistantContentPart, CodexContentPart, CodexMessage } from "../../types";

export const CHATGPT_WEB_MAX_INPUT_IMAGES = 10;

export interface ChatGptWebPromptImage {
  ref: string;
  imageUrl: string;
  detail?: string;
}

export interface CanonicalChatGptWebContext {
  readonly version: 3;
  readonly system: readonly string[];
  readonly messages: readonly Record<string, unknown>[];
  readonly images: readonly ChatGptWebPromptImage[];
}

/**
 * Canonical ChatGPT Web projection boundary.
 *
 * DSH-native message/session state is the source of truth. This module converts that state into the
 * structured conversation data consumed by ChatGPT Web without depending on browser state,
 * conversation/thread ids, DOM state, or transport handles.
 */
export function projectCanonicalChatGptWebContext(
  system: readonly string[],
  sourceMessages: readonly CodexMessage[],
): CanonicalChatGptWebContext {
  const messages = withoutSupersededModelSwitchContracts(sourceMessages);
  const images: ChatGptWebPromptImage[] = [];
  const projectedMessages = messages.map(message =>
    messageEnvelope(message, images)
  );

  return Object.freeze({
    version: 3,
    system: Object.freeze([...system]),
    messages: Object.freeze(projectedMessages),
    images: Object.freeze(images),
  });
}

export function serializeCanonicalChatGptWebContext(
  context: CanonicalChatGptWebContext,
): string {
  return withoutRetiredTurnHandles(JSON.stringify({
    version: context.version,
    system: context.system,
    messages: context.messages,
  }));
}

const RETIRED_TRANSPORT_HANDLE_KEYS = new Set([
  "__transport_handle",
  "__turn_handle",
  "__request_handle",
  "__binding_handle",
  "__activity_handle",
  "__surface_handle",
]);

/**
 * Remove only metadata keys that this plugin historically injected as transport handles.
 * This function is intentionally not a general JSON scrubber/normalizer: values and unrelated
 * user/tool-owned fields remain byte-for-byte unchanged by this semantic step.
 */
function sanitizeRetiredTransportFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRetiredTransportFields);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (RETIRED_TRANSPORT_HANDLE_KEYS.has(key)) {
      result[key] = "[retired transport handle]";
      continue;
    }
    result[key] = sanitizeRetiredTransportFields(child);
  }
  return result;
}

export function withoutRetiredTurnHandles(contextJson: string): string {
  try {
    return JSON.stringify(sanitizeRetiredTransportFields(JSON.parse(contextJson)));
  } catch {
    // The canonical serializer emits JSON. Preserve non-JSON caller input rather than mutating
    // arbitrary user-authored text that merely resembles an opaque browser handle.
    return contextJson;
  }
}


/**
 * Apply the provider's measured Free-Web transport image budget after canonical projection.
 *
 * This is deliberately separate from the canonical projection: canonical DSH context retains every
 * supported semantic image, while the transport projection may replace only the oldest excess
 * attachments with an explicit note.
 */
