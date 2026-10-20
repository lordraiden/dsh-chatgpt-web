/**
 * The Qwen Code provider driver: this provider's implementation of the WebChat Core's provider
 * contract (issue #299, slice 2; architecture §8.1, §8.2, §17).
 *
 * It is a projection of facts this provider owns — the verified session, the configured model list,
 * and the durable chat state — and it adds no second decision: the driver reports what the provider
 * established, and the core decides what that means for continuity.
 *
 * ## Continuity is a chat id, and nothing else
 *
 * ChatGPT's continuity is an installed initialization state in a retained page, so its driver's
 * branch rule is "is the prefix installed in that generation?". Qwen's is a chat id the provider keeps
 * server-side: `resumable` means "this affinity recorded a chat the provider has not rejected", and
 * `replay_required` means "the recorded conversation has no chat (or had one that was lost), so it
 * has to be rebuilt from canonical history". Neither verdict is a new chat: only an explicit caller
 * replay creates one (`doc/provider-onboarding.md` §1.1, AGENTS.md → *No silent fork*).
 *
 * ## No retained surface, so none of that failure family
 *
 * This provider retains no page per conversation (see `browser-session.ts`), so the driver has no
 * `retained_surface_lost` verdict to make and no eviction to reconcile. Nothing of a conversation is
 * process-local except the chat id, and that is durable (`chat-state.ts`), which is why this
 * provider's honest restart declaration is `exact_resume`.
 *
 * ## Reconciliation is not claimed
 *
 * An unconfirmed attempt stays unconfirmed: this provider has no measured way to prove from provider
 * state that a half-observed turn's reply is the one the record means. `reconcileConversation` is
 * therefore **omitted** on purpose, which keeps the core's honest refusal instead of reconciling on a
 * guess (the same rationale as ChatGPT's "no probe, no reconciliation").
 */
import {
  webChatAccountBindingId,
  webChatAffinityKey,
  type WebChatAccountBinding,
  type WebChatAccountInspection,
  type WebChatConversation,
  type WebChatConversationAssessment,
  type WebChatConversationAssessmentInput,
  type WebChatConversationCreateInput,
  type WebChatConversationHandle,
  type WebChatConversationReplayInput,
  type WebChatConversationResumeInput,
  type WebChatModelDescriptor,
  type WebChatProviderDriver,
  type WebChatProviderHealth,
} from "../../web-chat/core";
import type { QwenCodeConversationState } from "./chat-state";
import {
  qwenCodeModelDescriptors,
  qwenCodeSessionVerified,
  type QwenCodeProviderConfig,
} from "./provider-config";
import { QWEN_CODE_PROVIDER_ID } from "./provider";

/** Construction options for {@link createQwenCodeDriver}. */
export interface QwenCodeDriverOptions {
  /** The deployment facts this provider resolved. */
  readonly provider: QwenCodeProviderConfig;
  /** Durable chat state (the provider's own continuity). */
  readonly state: QwenCodeConversationState;
  /** Extra release work, when the composition owns a session page. Must be idempotent. */
  readonly release?: () => Promise<void>;
  /** Clock seam. */
  readonly now?: () => number;
}

/**
 * The opaque handle this provider records for one conversation generation.
 *
 * It is deliberately *not* the chat id: the core treats the handle as opaque, and the chat id is
 * provider state that can change (a replay creates a new chat) while the handle identifies the
 * generation the core asked for. It carries the same shape as the ChatGPT provider's
 * (`provider:key:generation`), which is what "opaque" costs when it must be stable and comparable.
 */
export function qwenCodeConversationHandle(
  conversationKey: string,
  generation: number,
): WebChatConversationHandle {
  return `qwen-code:${conversationKey}:${generation}` as WebChatConversationHandle;
}

/**
 * The core affinity key of one selection.
 *
 * Derived by the core (`webChatAffinityKey`) and never locally, so the driver, the ingress and the
 * durable record can never disagree about which conversation a turn belongs to. A selection with no
 * host session identity has no key: the core requires one (`conversation-key.ts`).
 */
export function qwenCodeAffinityKey(input: {
  readonly affinity: { readonly providerId: string; readonly bindingId: string; readonly threadId: string };
  readonly dshSession: { readonly sessionId?: string };
  readonly namespace: string;
}): string | undefined {
  const dshSessionId = input.dshSession.sessionId;
  if (dshSessionId === undefined || dshSessionId.length === 0) return undefined;
  return webChatAffinityKey({
    providerId: input.affinity.providerId,
    bindingId: input.affinity.bindingId,
    dshSessionId,
    threadId: input.affinity.threadId,
    namespace: input.namespace,
  });
}

/** The conversation record one generation of an affinity is described by. */
function conversationOf(input: {
  readonly key: string;
  readonly binding: WebChatAccountBinding;
  readonly generation: number;
  readonly status: WebChatConversation["status"];
}): WebChatConversation {
  return {
    key: input.key,
    providerId: QWEN_CODE_PROVIDER_ID,
    bindingId: webChatAccountBindingId(input.binding),
    generation: input.generation,
    handle: qwenCodeConversationHandle(input.key, input.generation),
    status: input.status,
  };
}

/**
 * Create the Qwen Code driver.
 *
 * @param options - the deployment facts, the durable chat state and the optional release hook.
 * @returns the driver the provider runtime composes.
 */
export function createQwenCodeDriver(options: QwenCodeDriverOptions): WebChatProviderDriver {
  const { provider, state } = options;
  let closed = false;

  /**
   * The descriptor of an identity that names this provider's model.
   *
   * Both spellings are accepted, because both are real: the **public route** the host selects
   * (`qwen-code/<model>`, what `resolveModel` is asked with) and the **provider-local id** the
   * descriptor carries. They name the same served model, and this is the one place the mapping is
   * applied — the public route is never a descriptor id (`doc/provider-onboarding.md` §1.1).
   */
  const descriptorOf = (model: string): WebChatModelDescriptor | undefined => {
    const prefix = `${provider.providerId}/`;
    const local = model.startsWith(prefix) ? model.slice(prefix.length) : model;
    return qwenCodeModelDescriptors(provider).find(candidate => candidate.id === local);
  };

  /** The verdict for an affinity this provider has (or has not) seen. */
  const assess = (input: {
    readonly key: string | undefined;
    readonly binding: WebChatAccountBinding;
    readonly conversation?: WebChatConversation;
  }): WebChatConversationAssessment => {
    if (input.key === undefined) {
      // No host session identity means no durable affinity: the core never recorded one either.
      return { status: "new", reason: "this turn carries no conversation affinity" };
    }
    const entry = state.read(input.key);
    if (input.conversation === undefined) {
      if (entry?.chat?.status === "active") {
        // The provider knows the chat but the core has no record (a store loss): hand the
        // conversation back so the core can adopt it instead of replaying something that exists.
        return {
          status: "resumable",
          reason: "the provider still holds this conversation's chat",
          conversation: conversationOf({
            key: input.key,
            binding: input.binding,
            generation: entry.generation,
            status: "resumable",
          }),
        };
      }
      if (entry?.chat?.status === "lost") {
        return { status: "lost", reason: "the provider no longer accepts this conversation's chat" };
      }
      return { status: "new", reason: "this provider has no chat for the affinity yet" };
    }
    if (entry?.chat?.status === "lost") {
      return {
        status: "lost",
        reason: "the provider no longer accepts this conversation's chat, so it cannot be continued",
      };
    }
    if (entry?.chat !== undefined && entry.chat.status === "active") return { status: "resumable" };
    // The core recorded a conversation but this provider has no chat for it: a replay is the only
    // honest way forward, and it is an explicit decision — never a silent replacement.
    return {
      status: "replay_required",
      reason: "the provider has no chat recorded for this conversation; it must be rebuilt from canonical history",
    };
  };

  return {
    id: provider.providerId,

    async inspectAccount(): Promise<WebChatAccountInspection> {
      // The session marker is the deployment's own proof that this provider authenticated (the import
      // and the sign-in controller write it only after `task/list` answered `success:true`). No live
      // account identifier was measured for this provider, so no fingerprint is published unless the
      // deployment recorded one — a derived one would be the trap `doc/provider-onboarding.md` §4.3
      // documents.
      const authenticated = qwenCodeSessionVerified(provider.storageStatePath);
      return {
        authenticated,
        ...(provider.accountIdentityRecorded ? { accountFingerprint: provider.accountFingerprint } : {}),
        capabilities: {
          text: "supported",
          // This bridge is a text chat: the provider offers no tool execution and no return channel.
          tools: "unsupported",
          images: "unsupported",
        },
      };
    },

    async listModels(): Promise<readonly WebChatModelDescriptor[]> {
      return qwenCodeModelDescriptors(provider);
    },

    async resolveModel(model: string, reasoningMode?: string): Promise<WebChatModelDescriptor | undefined> {
      const descriptor = descriptorOf(model);
      if (!descriptor) return undefined;
      // No reasoning level was measured for this provider (the recorded body pins
      // `thinking_enabled: false` and carries no reasoning selection), so *any* selected mode is
      // refused instead of being silently dropped.
      if (reasoningMode !== undefined) return undefined;
      return descriptor;
    },

    async assessConversation(input: WebChatConversationAssessmentInput): Promise<WebChatConversationAssessment> {
      if (!descriptorOf(input.model)) {
        return { status: "unsupported", reason: `the Qwen Code model ${input.model} is not served by this deployment` };
      }
      return assess({
        key: qwenCodeAffinityKey({
          affinity: input.affinity,
          dshSession: input.dshSession,
          namespace: provider.namespace,
        }),
        binding: input.binding,
        ...(input.conversation ? { conversation: input.conversation } : {}),
      });
    },

    async createConversation(input: WebChatConversationCreateInput): Promise<WebChatConversation> {
      const key = qwenCodeAffinityKey({
        affinity: input.affinity,
        dshSession: input.dshSession,
        namespace: provider.namespace,
      });
      if (key === undefined) throw new Error("A Qwen Code conversation requires a host session identity");
      // The caller is asking for a conversation in the epoch this provider already reports. The epoch
      // only advances through `replayConversation` (an explicit rebuild), which is what keeps a
      // recorded chat from being abandoned by a create call.
      const generation = state.generation(key);
      state.beginGeneration(key, generation);
      return conversationOf({ key, binding: input.binding, generation, status: "new" });
    },

    async resumeConversation(input: WebChatConversationResumeInput): Promise<WebChatConversation> {
      state.beginGeneration(input.conversation.key, input.conversation.generation);
      return conversationOf({
        key: input.conversation.key,
        binding: input.binding,
        generation: input.conversation.generation,
        status: "resumable",
      });
    },

    /**
     * Re-establish a conversation from canonical host history.
     *
     * A replay is a new epoch: the generation advances and the previous chat is abandoned, so the next
     * turn creates a fresh chat instead of continuing the one the caller explicitly replaced.
     */
    async replayConversation(input: WebChatConversationReplayInput): Promise<WebChatConversation> {
      const key = input.conversation?.key ?? qwenCodeAffinityKey({
        affinity: input.affinity,
        dshSession: input.dshSession,
        namespace: provider.namespace,
      });
      if (key === undefined) throw new Error("A Qwen Code replay requires a host session identity");
      const current = Math.max(state.generation(key), input.conversation?.generation ?? 0);
      const generation = current + 1;
      state.beginGeneration(key, generation);
      return conversationOf({ key, binding: input.binding, generation, status: "resumable" });
    },

    async health(): Promise<WebChatProviderHealth> {
      const models = qwenCodeModelDescriptors(provider);
      if (models.length === 0) {
        return { ok: false, detail: "no Qwen Code model is configured for this deployment" };
      }
      if (!qwenCodeSessionVerified(provider.storageStatePath)) {
        return { ok: false, detail: "no verified Qwen Code session is stored" };
      }
      return { ok: true, detail: `${models.length} model(s) available` };
    },

    async shutdown(): Promise<void> {
      // Idempotent by construction: the suite calls this twice.
      if (closed) return;
      closed = true;
      await options.release?.();
    },
  };
}
