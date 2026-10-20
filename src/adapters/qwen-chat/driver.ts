/**
 * The Qwen Chat provider driver: this provider's implementation of the WebChat Core's provider
 * contract (architecture §8.1, §8.2, §17).
 *
 * It projects facts this provider owns — the verified session, the configured/cached model list with
 * its per-model mode abilities, and the durable chat state — and adds no second decision: the driver
 * reports what the provider established, and the core decides what that means for continuity.
 *
 * ## Continuity is a chat id plus a response cursor
 *
 * ChatGPT's continuity is an installed initialization state in a retained page. Qwen Chat's is a chat
 * id the provider keeps server-side **and** the cursor the last response ended on. `resumable` means
 * "this affinity recorded a chat the provider has not rejected"; `replay_required` means "the
 * recorded conversation has no chat (or had one that was lost), so it has to be rebuilt from
 * canonical history". Neither verdict is a new chat: only an explicit caller replay creates one
 * (`doc/provider-onboarding.md` §1.1, AGENTS.md → *No silent fork*).
 *
 * ## No retained surface
 *
 * This provider keeps no page per conversation (`browser-session.ts`), so it has no
 * `retained_surface_lost` verdict and no eviction to reconcile. Nothing of a conversation is
 * process-local except the chat id and cursor, and those are durable (`chat-state.ts`) — which is
 * why this provider's honest restart declaration is `exact_resume`.
 *
 * ## Reconciliation is not claimed
 *
 * An unconfirmed attempt stays unconfirmed: this provider has no measured way to prove from provider
 * state that a half-observed turn's reply is the one the record means. `reconcileConversation` is
 * therefore **omitted** on purpose, which keeps the core's honest refusal instead of reconciling on a
 * guess (the same rationale as the Qwen Code and ChatGPT drivers).
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
import type { QwenChatConversationState } from "./chat-state";
import {
  qwenChatModelDescriptors,
  qwenChatSessionVerified,
  type QwenChatProviderConfig,
} from "./provider-config";
import { QWEN_CHAT_PROVIDER_ID } from "./provider";

/** Construction options for {@link createQwenChatDriver}. */
export interface QwenChatDriverOptions {
  /** The deployment facts this provider resolved. */
  readonly provider: QwenChatProviderConfig;
  /** Durable chat state (the provider's own continuity). */
  readonly state: QwenChatConversationState;
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
 * generation the core asked for. It carries the same shape as the other providers'
 * (`provider:key:generation`), which is what "opaque" costs when it must be stable and comparable.
 */
export function qwenChatConversationHandle(
  conversationKey: string,
  generation: number,
): WebChatConversationHandle {
  return `qwen-chat:${conversationKey}:${generation}` as WebChatConversationHandle;
}

/**
 * The core affinity key of one selection.
 *
 * Derived by the core (`webChatAffinityKey`) and never locally, so the driver, the ingress and the
 * durable record can never disagree about which conversation a turn belongs to. A selection with no
 * host session identity has no key: the core requires one (`conversation-key.ts`).
 */
export function qwenChatAffinityKey(input: {
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
    providerId: QWEN_CHAT_PROVIDER_ID,
    bindingId: webChatAccountBindingId(input.binding),
    generation: input.generation,
    handle: qwenChatConversationHandle(input.key, input.generation),
    status: input.status,
  };
}

/**
 * Create the Qwen Chat driver.
 *
 * @param options - the deployment facts, the durable chat state and the optional release hook.
 * @returns the driver the provider runtime composes.
 */
export function createQwenChatDriver(options: QwenChatDriverOptions): WebChatProviderDriver {
  const { provider, state } = options;
  let closed = false;

  /**
   * The descriptor of an identity that names this provider's model.
   *
   * Both spellings are accepted, because both are real: the **public route** the host selects
   * (`qwen-chat/<model>`, what `resolveModel` is asked with) and the **provider-local id** the
   * descriptor carries. They name the same served model, and this is the one place the mapping is
   * applied — the public route is never a descriptor id.
   */
  const descriptorOf = (model: string): WebChatModelDescriptor | undefined => {
    const prefix = `${provider.providerId}/`;
    const local = model.startsWith(prefix) ? model.slice(prefix.length) : model;
    return qwenChatModelDescriptors(provider).find(candidate => candidate.id === local);
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
      // and the sign-in controller write it only after the authenticated probe answered success:true).
      // No live account identifier was measured for this provider, so no fingerprint is published
      // unless the deployment recorded one — a derived one would be the trap
      // `doc/provider-onboarding.md` §4.3 documents.
      const authenticated = qwenChatSessionVerified(provider.storageStatePath);
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
      return qwenChatModelDescriptors(provider);
    },

    async resolveModel(model: string, reasoningMode?: string): Promise<WebChatModelDescriptor | undefined> {
      const descriptor = descriptorOf(model);
      if (!descriptor) return undefined;
      // A mode this model's measured abilities do not offer is refused, never silently substituted by
      // the default: the caller asked for a specific reasoning selection and must learn it is absent.
      if (reasoningMode !== undefined) {
        if (!descriptor.reasoningModes?.includes(reasoningMode)) return undefined;
      }
      return descriptor;
    },

    async assessConversation(input: WebChatConversationAssessmentInput): Promise<WebChatConversationAssessment> {
      if (!descriptorOf(input.model)) {
        return { status: "unsupported", reason: `the Qwen Chat model ${input.model} is not served by this deployment` };
      }
      return assess({
        key: qwenChatAffinityKey({
          affinity: input.affinity,
          dshSession: input.dshSession,
          namespace: provider.namespace,
        }),
        binding: input.binding,
        ...(input.conversation ? { conversation: input.conversation } : {}),
      });
    },

    async createConversation(input: WebChatConversationCreateInput): Promise<WebChatConversation> {
      const key = qwenChatAffinityKey({
        affinity: input.affinity,
        dshSession: input.dshSession,
        namespace: provider.namespace,
      });
      if (key === undefined) throw new Error("A Qwen Chat conversation requires a host session identity");
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
      const key = input.conversation?.key ?? qwenChatAffinityKey({
        affinity: input.affinity,
        dshSession: input.dshSession,
        namespace: provider.namespace,
      });
      if (key === undefined) throw new Error("A Qwen Chat replay requires a host session identity");
      const current = Math.max(state.generation(key), input.conversation?.generation ?? 0);
      const generation = current + 1;
      state.beginGeneration(key, generation);
      return conversationOf({ key, binding: input.binding, generation, status: "resumable" });
    },

    async health(): Promise<WebChatProviderHealth> {
      const models = qwenChatModelDescriptors(provider);
      if (models.length === 0) {
        return { ok: false, detail: "no Qwen Chat model is configured for this deployment" };
      }
      if (!qwenChatSessionVerified(provider.storageStatePath)) {
        return { ok: false, detail: "no verified Qwen Chat session is stored" };
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
