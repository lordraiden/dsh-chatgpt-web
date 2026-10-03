import { isOnePixelPngDataUrl } from "../../responses/compaction";
import type { CodexAssistantContentPart, CodexContentPart, CodexMessage } from "../../types";

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
  const userContext = messages
    .filter(message => message.role === "user")
    .map(message => {
      if (typeof message.content === "string") return message.content;
      return message.content.map(part => part.type === "text" ? part.text : "").join(" ");
    })
    .join(" ");

  // Canonical projection is intentionally lossless for supported semantic images. Any per-request
  // attachment cap is a transport concern and belongs after this projection (#11-B).
  const projectedMessages = messages.map(message =>
    messageEnvelope(message, images, userContext)
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

function sanitizeRetiredTransportFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRetiredTransportFields);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (RETIRED_TRANSPORT_HANDLE_KEYS.has(key)) {
      result[key] = "[retired transport handle]";
    } else {
      result[key] = sanitizeRetiredTransportFields(child);
    }
  }
  return result;
}

export function withoutRetiredTurnHandles(contextJson: string): string {
  try {
    return JSON.stringify(sanitizeRetiredTransportFields(JSON.parse(contextJson)));
  } catch {
    // The canonical serializer always emits valid JSON; preserve caller input when this helper is
    // used independently on a non-JSON string rather than mutating arbitrary user text.
    return contextJson;
  }
}

export function countChatGptContextImages(messages: readonly CodexMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image" && !isOnePixelPngDataUrl(part.imageUrl)) total += 1;
    }
  }
  return total;
}

function inputContent(
  content: string | CodexContentPart[],
  images: ChatGptWebPromptImage[],
): unknown {
  if (typeof content === "string") return content;
  const semantic = content.filter(part =>
    part.type !== "image" || !isOnePixelPngDataUrl(part.imageUrl)
  );
  if (!semantic.some(part => part.type === "image")) {
    return semantic.filter(part => part.type === "text").map(part => part.text).join("\n");
  }
  return semantic.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const ref = "codex-input-image-" + (images.length + 1);
    images.push({ ref, imageUrl: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) });
    return {
      type: "image_attachment",
      attachment_ref: ref,
      ...(part.detail ? { detail: part.detail } : {}),
    };
  });
}

function assistantContent(
  content: CodexAssistantContentPart[],
  userContext?: string,
): unknown[] {
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") {
      const text = part.thinking?.trim();
      if (
        !text
        || /^Thought\s+for\s+/i.test(text)
        || /^Thinking\s*(?:Process|\.\.\.)?$/i.test(text)
      ) return undefined;
      return { type: "thinking_summary", text: part.thinking };
    }
    let args = part.arguments;
    if (part.name === "write" && args && typeof args === "object") {
      const rec = { ...(args as Record<string, unknown>) };
      if ((typeof rec.file_path !== "string" || !rec.file_path.trim()) && userContext) {
        const cleaned = userContext
          .replace(/https?:\/\/[^\s]+/g, "")
          .replace(/\b(?:AGENTS|CLAUDE)\.md\b/gi, "");
        const match = cleaned.match(/\b([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]{1,10})\b/);
        if (match?.[1]) {
          rec.file_path = match[1];
          args = rec;
        }
      }
    }
    return {
      type: "tool_call",
      id: part.id,
      name: part.name,
      ...(part.namespace ? { namespace: part.namespace } : {}),
      arguments: args,
    };
  }).filter(Boolean);
}

function plainMessageText(message: CodexMessage): string | undefined {
  if (
    message.role === "assistant"
    || message.role === "agentMessage"
    || message.role === "toolResult"
  ) return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.some(part => part.type !== "text")) return undefined;
  return message.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function startsWithControlBlock(message: CodexMessage, tag: string): boolean {
  return message.role === "developer"
    && plainMessageText(message)?.trimStart().startsWith(tag) === true;
}

export function withoutSupersededModelSwitchContracts(
  messages: readonly CodexMessage[],
): CodexMessage[] {
  const switchIndices = messages.flatMap((message, index) =>
    startsWithControlBlock(message, "<model_switch>") ? [index] : []
  );
  if (switchIndices.length < 2) return [...messages];

  const newestSwitchIndex = switchIndices.at(-1)!;
  const dropped = new Set<number>();
  for (const index of switchIndices.slice(0, -1)) {
    dropped.add(index);
    const skillCatalogIndex = index + 1;
    if (
      skillCatalogIndex < newestSwitchIndex
      && startsWithControlBlock(messages[skillCatalogIndex]!, "<skills_instructions>")
    ) dropped.add(skillCatalogIndex);
  }
  return messages.filter((_message, index) => !dropped.has(index));
}

function messageEnvelope(
  message: CodexMessage,
  images: ChatGptWebPromptImage[],
  userContext?: string,
): Record<string, unknown> {
  if (message.role === "toolResult") {
    return {
      role: "tool_result",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      ...(message.toolNamespace ? { tool_namespace: message.toolNamespace } : {}),
      is_error: message.isError,
      content: inputContent(message.content, images),
    };
  }
  if (message.role === "agentMessage") {
    return {
      role: "agent_message",
      ...(message.author !== undefined ? { author: message.author } : {}),
      ...(message.recipient !== undefined ? { recipient: message.recipient } : {}),
      content: inputContent(message.content, images),
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      ...(message.phase ? { phase: message.phase } : {}),
      content: assistantContent(message.content, userContext),
    };
  }
  return { role: message.role, content: inputContent(message.content, images) };
}
