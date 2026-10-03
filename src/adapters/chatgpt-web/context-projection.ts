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
  maxInputImages = 10,
): CanonicalChatGptWebContext {
  if (!Number.isSafeInteger(maxInputImages) || maxInputImages < 0) {
    throw new Error("ChatGPT canonical context image budget is invalid");
  }

  const messages = withoutSupersededModelSwitchContracts(sourceMessages);
  const images: ChatGptWebPromptImage[] = [];
  const budget: ImageBudget = {
    seen: 0,
    dropped: Math.max(0, countChatGptContextImages(messages) - maxInputImages),
  };
  const userContext = messages
    .filter(message => message.role === "user")
    .map(message => {
      if (typeof message.content === "string") return message.content;
      return message.content.map(part => part.type === "text" ? part.text : "").join(" ");
    })
    .join(" ");

  const projectedMessages = messages.map(message =>
    messageEnvelope(message, images, budget, userContext)
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

const RETIRED_TURN_HANDLE = /\b(turn|request|binding)_[A-Za-z0-9_-]{24,}/g;

export function withoutRetiredTurnHandles(contextJson: string): string {
  return contextJson.replace(
    RETIRED_TURN_HANDLE,
    (_handle, kind: string) => "[retired " + kind + " handle]",
  );
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

interface ImageBudget {
  seen: number;
  dropped: number;
}

function inputContent(
  content: string | CodexContentPart[],
  images: ChatGptWebPromptImage[],
  budget: ImageBudget,
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
    budget.seen += 1;
    if (budget.seen <= budget.dropped) {
      return { type: "text", text: "[older image not attached: ChatGPT accepts at most 10 per message]" };
    }
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
  budget: ImageBudget,
  userContext?: string,
): Record<string, unknown> {
  if (message.role === "toolResult") {
    return {
      role: "tool_result",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      ...(message.toolNamespace ? { tool_namespace: message.toolNamespace } : {}),
      is_error: message.isError,
      content: inputContent(message.content, images, budget),
    };
  }
  if (message.role === "agentMessage") {
    return {
      role: "agent_message",
      ...(message.author !== undefined ? { author: message.author } : {}),
      ...(message.recipient !== undefined ? { recipient: message.recipient } : {}),
      content: inputContent(message.content, images, budget),
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      ...(message.phase ? { phase: message.phase } : {}),
      content: assistantContent(message.content, userContext),
    };
  }
  return { role: message.role, content: inputContent(message.content, images, budget) };
}
