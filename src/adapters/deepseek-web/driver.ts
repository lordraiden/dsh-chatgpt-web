/**
 * The DeepSeek Web provider driver: this provider's implementation of the WebChat Core's provider
 * contract (architecture §8.1, §8.2, §17).
 *
 * It projects facts this provider owns — the verified session and the configured `model_type` list —
 * and adds no second decision: the driver reports what the provider established, and the core decides
 * what that means for continuity.
 *
 * ## Continuity is a session id plus a parent message id
 *
 * ChatGPT's continuity is an installed initialization state in a retained page; Qwen Chat's is a chat
 * id plus a response cursor. DeepSeek's is exactly the pair its completion body uses (recon §2.3):
 * `chat_session_id` and `parent_message_id`. `resumable` means "this affinity recorded a session the
 * provider has not rejected"; `replay_required` means "the recorded conversation has no session (or
 * had one that was lost), so it has to be rebuilt from canonical history". Neither verdict is a new
 * session: only an explicit caller replay creates one (AGENTS.md → *No silent fork*).
 *
 * ## No retained surface, and no reconciliation claim
 *
 * This provider keeps no page per conversation (`session.ts`), so it has no `retained_surface_lost`
 * verdict and no eviction to reconcile. Nothing of a conversation is process-local except the session
 * id and cursor, and those are durable (`chat-state.ts`) — which is why this provider's honest restart
 * declaration is `exact_resume`.
 *
 * An unconfirmed attempt stays unconfirmed: this provider has no measured way to prove from provider
 * state that a half-observed turn's reply is the one the record means. `reconcileConversation` is
 * therefore **omitted** on purpose, which keeps the core's honest refusal instead of reconciling on a
 * guess (the same rationale as the Qwen Code, Qwen Chat and ChatGPT drivers).
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
import type { DeepSeekConversationState } from "./chat-state";
import {
  deepSeekCapturePresent,
  deepSeekModelDescriptors,
  deepSeekSessionVerified,
  type DeepSeekProviderConfig,
} from "./provider-config";
import { DEEPSEEK_WEB_PROVIDER_ID } from "./provider";

/** Construction options for {@link createDeepSeekDriver}. */
export interface DeepSeekDriverOptions {
  /** The deployment facts this provider resolved. */
  readonly provider: DeepSeekProviderConfig;
  /** Durable session state (the provider's own continuity). */
  readonly state: DeepSeekConversationState;
  /** Extra release work, when the composition owns a session page. Must be idempotent. */
  readonly release?: () => Promise<void>;
  /** Clock seam. */
  readonly now?: () => number;
}

/**
 * The opaque handle this provider records for one conversation generation.
 *
 * It is deliberately *not* the session id: the core treats the handle as opaque, and the session id is
 * provider state that can change (a replay creates a new session) while the handle identifies the
 * generation the core asked for.
 */
export function deepSeekConversationHandle(
  conversationKey: string,
  generation: number,
): WebChatConversationHandle {
  return `deepseek-web:${conversationKey}:${generation}` as WebChatConversationHandle;
}

/**
 * The core affinity key of one selection.
 *
 * Derived by the core (`webChatAffinityKey`) and never locally, so the driver, the ingress and the
 * durable record can never disagree about which conversation a turn belongs to. A selection with no
 * host session identity has no key: the core requires one (`conversation-key.ts`).
 */
export function deepSeekAffinityKey(input: {
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
    providerId: DEEPSEEK_WEB_PROVIDER_ID,
    bindingId: webChatAccountBindingId(input.binding),
    generation: input.generation,
    handle: deepSeekConversationHandle(input.key, input.generation),
    status: input.status,
  };
}

/**
 * Create the DeepSeek Web driver.
 *
 * @param options - the deployment facts, the durable session state and the optional release hook.
 * @returns the driver the provider runtime composes.
 */
export function createDeepSeekDriver(options: DeepSeekDriverOptions): WebChatProviderDriver {
  const { provider, state } = options;
  let closed = false;

  /**
   * The descriptor of an identity that names this provider's model.
   *
   * Both spellings are accepted, because both are real: the **public route** the host selects
   * (`deepseek-web/<model_type>`, what `resolveModel` is asked with) and the **provider-local id** the
   * descriptor carries.
   */
  const descriptorOf = (model: string): WebChatModelDescriptor | undefined => {
    const prefix = `${provider.providerId}/`;
    const local = model.startsWith(prefix) ? model.slice(prefix.length) : model;
    return deepSeekModelDescriptors(provider).find(candidate => candidate.id === local);
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
      if (entry?.session?.status === "active") {
        // The provider knows the session but the core has no record (a store loss): hand the
        // conversation back so the core can adopt it instead of replaying something that exists.
        return {
          status: "resumable",
          reason: "the provider still holds this conversation's chat session",
          conversation: conversationOf({
            key: input.key,
            binding: input.binding,
            generation: entry.generation,
            status: "resumable",
          }),
        };
      }
      if (entry?.session?.status === "lost") {
        return { status: "lost", reason: "the provider no longer accepts this conversation's chat session" };
      }
      return { status: "new", reason: "this provider has no chat session for the affinity yet" };
    }
    if (entry?.session?.status === "lost") {
      return {
        status: "lost",
        reason: "the provider no longer accepts this conversation's chat session, so it cannot be continued",
      };
    }
    if (entry?.session !== undefined && entry.session.status === "active") return { status: "resumable" };
    // The core recorded a conversation but this provider has no session for it: a replay is the only
    // honest way forward, and it is an explicit decision — never a silent replacement.
    return {
      status: "replay_required",
      reason: "the provider has no chat session recorded for this conversation; it must be rebuilt from canonical history",
    };
  };

  return {
    id: provider.providerId,

    async inspectAccount(): Promise<WebChatAccountInspection> {
      // The marker is the deployment's own proof that an authenticated predicate accepted this
      // provider's session. No live account identifier was measured, so no fingerprint is published
      // unless the deployment recorded one — a derived one would be the trap
      // `doc/provider-onboarding.md` §4.3 documents.
      const authenticated = deepSeekSessionVerified(provider.storageStatePath);
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
      return deepSeekModelDescriptors(provider);
    },

    async resolveModel(model: string, reasoningMode?: string): Promise<WebChatModelDescriptor | undefined> {
      const descriptor = descriptorOf(model);
      if (!descriptor) return undefined;
      // No named reasoning levels were measured for this provider (recon §2.5 records a boolean
      // toggle, not a menu), so any selection is refused instead of being silently substituted.
      if (reasoningMode !== undefined) return undefined;
      return descriptor;
    },

    async assessConversation(input: WebChatConversationAssessmentInput): Promise<WebChatConversationAssessment> {
      if (!descriptorOf(input.model)) {
        return { status: "unsupported", reason: `the DeepSeek model ${input.model} is not served by this deployment` };
      }
      return assess({
        key: deepSeekAffinityKey({
          affinity: input.affinity,
          dshSession: input.dshSession,
          namespace: provider.namespace,
        }),
        binding: input.binding,
        ...(input.conversation ? { conversation: input.conversation } : {}),
      });
    },

    async createConversation(input: WebChatConversationCreateInput): Promise<WebChatConversation> {
      const key = deepSeekAffinityKey({
        affinity: input.affinity,
        dshSession: input.dshSession,
        namespace: provider.namespace,
      });
      if (key === undefined) throw new Error("A DeepSeek conversation requires a host session identity");
      // The caller is asking for a conversation in the epoch this provider already reports. The epoch
      // only advances through `replayConversation` (an explicit rebuild), which is what keeps a
      // recorded session from being abandoned by a create call.
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
     * A replay is a new epoch: the generation advances and the previous session is abandoned, so the
     * next turn creates a fresh session instead of continuing the one the caller explicitly replaced.
     */
    async replayConversation(input: WebChatConversationReplayInput): Promise<WebChatConversation> {
      const key = input.conversation?.key ?? deepSeekAffinityKey({
        affinity: input.affinity,
        dshSession: input.dshSession,
        namespace: provider.namespace,
      });
      if (key === undefined) throw new Error("A DeepSeek replay requires a host session identity");
      const current = Math.max(state.generation(key), input.conversation?.generation ?? 0);
      const generation = current + 1;
      state.beginGeneration(key, generation);
      return conversationOf({ key, binding: input.binding, generation, status: "resumable" });
    },

    async health(): Promise<WebChatProviderHealth> {
      const models = deepSeekModelDescriptors(provider);
      if (models.length === 0) {
        return {
          ok: false,
          detail: 'no DeepSeek model_type is configured (webChat.providers["deepseek-web"].modelTypes); '
            + "the model list is a session-only remote setting, so it is never discovered automatically",
        };
      }
      if (!deepSeekSessionVerified(provider.storageStatePath)) {
        return {
          ok: false,
          detail: deepSeekCapturePresent(provider.storageStatePath)
            ? "a DeepSeek capture is stored but it is not a verified session: the import's settings "
              + "predicate has not accepted it — re-run `auth import --provider deepseek-web` "
              + "(doc/deepseek-web.md §7)"
            : "no DeepSeek session is stored for this deployment: import a capture with "
              + "`auth import --provider deepseek-web` (doc/deepseek-web.md §7)",
        };
      }
      return { ok: true, detail: `${models.length} model_type(s) available` };
    },

    async shutdown(): Promise<void> {
      // Idempotent by construction: the suite calls this twice.
      if (closed) return;
      closed = true;
      await options.release?.();
    },
  };
}
