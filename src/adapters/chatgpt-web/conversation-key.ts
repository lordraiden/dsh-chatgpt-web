import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

/**
 * Logical ChatGPT Web conversation affinity.
 *
 * Derived only from the stable DSH chat identity (thread) and the execution
 * namespace. Model, reasoning effort, and compaction are properties of the
 * turn, not of the chat: they must never split one DSH chat into a second
 * ChatGPT conversation.
 */
export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
  })).digest("hex");
}

/** Full history remains canonical; a retained epoch receives only the suffix after its last assistant reply. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.slice(lastAssistant + 1),
    },
  };
}

/**
 * Stable identity of the DSH system block for one retained conversation.
 *
 * A retained continuation omits the system block entirely while this identity
 * matches the one last delivered to the physical ChatGPT conversation; a change
 * propagates only the new complete block, never a full context rebuild.
 */
export function chatGptSystemFingerprint(systemPrompt?: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(systemPrompt ?? [])).digest("hex");
}
