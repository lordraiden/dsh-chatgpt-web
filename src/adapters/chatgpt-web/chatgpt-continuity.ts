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
  confirmWebChatConversation,
  createMemoryConversationStore,
  webChatError,
  resolveWebChatContinuation,
  webChatContinuationIdentity,
  type WebChatAccountBinding,
  type WebChatConversationIdentity,
  type WebChatConversationStore,
  type WebChatConversationRecord,
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
  /**
   * Confirm the settled turn in the durable record.
   *
   * A turn that never reaches this leaves its conversation unconfirmed, so nothing resumes continuity
   * the provider never established. A confirmation that cannot be applied (the conversation moved on)
   * is logged and the record stays unconfirmed: the turn's own result is already delivered, and
   * failing it here would not make the state any more true.
   */
  confirmTurn(input: { readonly turnId: string; readonly at?: number }): Promise<void>;
}

/**
 * Create the native continuity decision.
 *
 * @param deps - provider, affinity, namespace, binding and the continuity store.
 * @returns the decision, expressed in the provider's recovery vocabulary.
 */
export function createChatGptContinuity(deps: ChatGptContinuityDeps): ChatGptContinuity {
  /** The conversation the last decision resolved, so a settled turn can confirm it. */
  let decision: { identity: WebChatConversationIdentity; generation: number } | undefined;
  const driver = createChatGptWebDriver({
    provider: deps.provider,
    namespace: deps.namespace,
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
  });
  const store = deps.store ?? createMemoryConversationStore();

  /**
   * Whether the provider can prove it can continue the recorded conversation.
   *
   * The verdict is the driver's, and only two explicit intents are derived from it. A verdict this
   * caller cannot take (a driver that throws) is not proof of continuity: the core then decides on the
   * intent the caller would have chosen anyway.
   */
  const providerCanResume = async (
    stored: WebChatConversationRecord,
    scope: {
      readonly binding: WebChatAccountBinding;
      readonly dshSession: { readonly sessionId?: string };
      readonly threadId: string;
    },
    model: string,
  ): Promise<boolean> => {
    if (!stored.handle) return false;
    try {
      const assessment = await driver.assessConversation({
        dshSession: scope.dshSession,
        binding: scope.binding,
        affinity: { providerId: deps.affinity.providerId, bindingId: deps.affinity.bindingId, threadId: scope.threadId },
        model,
        conversation: {
          key: stored.identity.key,
          providerId: stored.identity.providerId,
          bindingId: stored.identity.bindingId,
          generation: stored.generation,
          handle: stored.handle,
          status: stored.status,
        },
      });
      return assessment.status === "resumable";
    } catch {
      return false;
    }
  };

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

      // Every explicit intent names the generation it acts on, so a decision taken from a superseded
      // state is refused instead of creating a conversation that would then be refused a record.
      const currentGeneration = stored?.generation ?? 0;
      let intent: WebChatContinuationIntent;
      if (facts.contextExhausted || facts.retired) {
        // Continuity has to be rebuilt: an explicit replay when canonical history is available, and a
        // first conversation when there is nothing to rebuild from.
        const history = chatGptReplayHistory(facts.parsed);
        intent = history.length > 0
          ? {
            kind: "replay",
            expectedGeneration: currentGeneration,
            reason: "ChatGPT continuity must be rebuilt from canonical history",
            history,
          }
          : {
            kind: "new_conversation",
            expectedGeneration: currentGeneration,
            reason: "ChatGPT continuity was lost and no canonical history remains",
          };
      } else if (stored) {
        // A durable record proves the conversation existed, but not that *this process* can resume it:
        // the provider's installation state is process-local, so the first turn after a restart has to
        // be rebuilt. The verdict is the trigger, and it only chooses between two **explicit** intents:
        // a continuation when the provider can prove the installation, and an explicit replay from
        // canonical history when it cannot. It never turns into a silent replacement conversation.
        if (await providerCanResume(stored, scope, facts.parsed.modelId)) {
          intent = { kind: "continue" };
        } else {
          const history = chatGptReplayHistory(facts.parsed);
          intent = history.length > 0
            ? {
              kind: "replay",
              expectedGeneration: currentGeneration,
              reason: "the provider cannot prove the installation state of this conversation; it is rebuilt explicitly from canonical host history",
              history,
            }
            // Nothing canonical to rebuild from: the explicit refusal is kept. A new conversation here
            // would be the silent fork the contract forbids, so the core refuses instead.
            : { kind: "continue" };
        }
      } else {
        intent = {
          kind: "new_conversation",
          expectedGeneration: currentGeneration,
          reason: "first turn of this chat",
        };
      }

      const plan = await resolveWebChatContinuation(
        { store, driver },
        { ...scope, model: facts.parsed.modelId, intent },
      );
      if (plan.record) decision = { identity: plan.identity, generation: plan.record.generation };
      switch (plan.outcome) {
        case "exact_resume":
          return "EXACT_RESUME";
        case "replay":
          return "REPLAY";
        case "new_conversation":
          return "NEW";
        default:
          // The core refused continuity: the turn fails here, before any provider turn, transport or
          // browser session is created, and the typed failure reaches the caller. Continuing with a
          // recovery flag would be the silent fork the contract forbids.
          throw plan.error ?? webChatError(
            "CONVERSATION_STATE_MISMATCH",
            "The WebChat Core refused continuity for this turn",
          );
      }
    },

    async confirmTurn(input) {
      if (!decision) return;
      try {
        await confirmWebChatConversation(store, decision.identity, {
          generation: decision.generation,
          turnId: input.turnId,
          at: input.at ?? Date.now(),
        });
      } catch (error) {
        console.warn(
          `[chatgpt-web] the settled turn could not be confirmed in the conversation record: ${(error as Error).message}`,
        );
      }
    },
  };
}
