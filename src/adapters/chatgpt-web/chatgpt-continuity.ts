/**
 * The native ChatGPT turn's continuity decision, taken by the WebChat Core (issue #192).
 *
 * The provider decides *with its own facts*, but not *by itself*: it derives the conversation
 * affinity, states its intent (continue, rebuild from canonical history, or a first conversation)
 * and hands the decision to `resolveWebChatContinuation`, which applies the core's rules — a refused
 * verdict fails, an explicit replay rebuilds, and nothing is created by inference.
 *
 * The provider translates the outcome back into its own recovery vocabulary, so the rest of the turn
 * (and its consumers) keep working unchanged.
 */
import { createChatGptWebDriver } from "./chatgpt-driver";
import { chatGptAffinitySessionId, chatGptConversationKey } from "./conversation-key";
import { extractChatGptTurnIdentity } from "./environment";
import type { ProviderRecovery } from "./provider-core";
import type { ChatGptTurnSessions } from "./turn-execution";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import {
  createMemoryConversationStore,
  resolveWebChatContinuation,
  webChatContinuationIdentity,
  type WebChatAccountBinding,
  type WebChatConversationStore,
  type WebChatContinuationIntent,
  type WebChatReplayMessage,
} from "../../web-chat/core";

/** What the native path gives the continuity decision, and what it needs back. */
export interface ChatGptContinuityDeps {
  readonly provider: CodexProviderConfig;
  /** Provider/account binding of this deployment. */
  readonly affinity: { readonly providerId: string; readonly bindingId: string };
  /** Deployment namespace the affinity key is derived with. */
  readonly namespace: string;
  /** The binding as the core sees it. */
  readonly binding: WebChatAccountBinding;
  readonly sessions?: ChatGptTurnSessions;
  /** Durable continuity. A process-lifetime store unless the host wires another one (#193). */
  readonly store?: WebChatConversationStore;
}

/** The provider facts that used to decide recovery by itself. */
export interface ChatGptRecoveryFacts {
  readonly parsed: CodexParsedRequest;
  /** The decision the provider would have made on its own, used when the core cannot be applied. */
  readonly legacyRecovery: ProviderRecovery;
  readonly contextExhausted: boolean;
  readonly retired: boolean;
}

/** Canonical host history, as the core's replay input. */
export function chatGptReplayHistory(parsed: CodexParsedRequest): readonly WebChatReplayMessage[] {
  return parsed.context.messages.flatMap((message): WebChatReplayMessage[] => {
    // Provider-private message kinds that are not text turns (tool results) carry no replayable text.
    if (message.role === "toolResult") return [];
    const role: WebChatReplayMessage["role"] = message.role === "agentMessage"
      ? "assistant"
      : message.role === "developer"
        ? "developer"
        : message.role === "assistant"
          ? "assistant"
          : "user";
    const text = typeof message.content === "string"
      ? message.content
      : message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
    return text.trim().length > 0 ? [{ role, text }] : [];
  });
}

/** The continuity decision of one native turn. */
export interface ChatGptContinuity {
  resolveRecovery(facts: ChatGptRecoveryFacts): Promise<ProviderRecovery>;
}

/**
 * Create the native continuity decision.
 *
 * @param deps - provider, affinity, namespace, binding and the continuity store.
 * @returns the decision, expressed in the provider's recovery vocabulary.
 */
export function createChatGptContinuity(deps: ChatGptContinuityDeps): ChatGptContinuity {
  const driver = createChatGptWebDriver({
    provider: deps.provider,
    namespace: deps.namespace,
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
  });
  const store = deps.store ?? createMemoryConversationStore();

  return {
    async resolveRecovery(facts) {
      const identity = extractChatGptTurnIdentity(facts.parsed);
      const conversationKey = chatGptConversationKey(facts.parsed, deps.namespace, deps.affinity);
      if (!conversationKey || !identity.threadId) {
        // A lane without a logical conversation keeps the provider's own decision: there is no
        // affinity for the core to reason about.
        return facts.legacyRecovery;
      }
      const dshSession = {
        sessionId: chatGptAffinitySessionId({ dshSessionId: identity.dshSessionId, threadId: identity.threadId }),
      };
      const scope = {
        binding: deps.binding,
        dshSession,
        threadId: identity.threadId,
        namespace: deps.namespace,
      };
      const stored = await store.read(webChatContinuationIdentity(scope));

      let intent: WebChatContinuationIntent;
      if (facts.contextExhausted || facts.retired) {
        // Continuity has to be rebuilt: an explicit replay when canonical history is available, and a
        // first conversation when there is nothing to rebuild from.
        const history = chatGptReplayHistory(facts.parsed);
        intent = history.length > 0
          ? { kind: "replay", reason: "ChatGPT continuity must be rebuilt from canonical history", history }
          : { kind: "new_conversation", reason: "ChatGPT continuity was lost and no canonical history remains" };
      } else if (stored) {
        intent = { kind: "continue" };
      } else {
        intent = { kind: "new_conversation", reason: "first turn of this chat" };
      }

      const plan = await resolveWebChatContinuation(
        { store, driver },
        { ...scope, model: facts.parsed.modelId, intent },
      );
      switch (plan.outcome) {
        case "exact_resume":
          return "EXACT_RESUME";
        case "replay":
          return "REPLAY";
        case "new_conversation":
          return "NEW";
        default:
          // The core refused continuity: the turn fails explicitly instead of installing a new
          // conversation by inference.
          return "FAILED";
      }
    },
  };
}
