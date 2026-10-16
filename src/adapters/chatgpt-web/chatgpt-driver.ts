/**
 * The ChatGPT Web provider driver: the ChatGPT implementation of the WebChat Core's provider
 * contract (issue #192, architecture §8.1, §17).
 *
 * It is a *projection* of the facts this provider already owns — the authenticated account, the Web
 * model catalogue and route authority, the recorded physical generation and the initialization state
 * installed in it — and it adds no second decision anywhere: the driver only reports what the
 * provider established, and the core decides what that means for continuity.
 *
 * ChatGPT-specific mechanisms stay here or in the modules it delegates to: this file never touches a
 * browser page, a selector or an endpoint.
 */
import { accountIdentityFromUnknownSession } from "../../chatgpt-web-authority";
import { CHATGPT_WEB_MODEL_PREFIX, type ChatGptWebModelRoute } from "../../chatgpt-web-models";
import {
  availableChatGptWebRoutes,
  createChatGptWebRouteAuthorityFromProvider,
  requireChatGptWebRoute,
} from "../../chatgpt-web-authority";
import type { CodexProviderConfig } from "../../types";
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
import { chatGptWebAccountFingerprint, chatGptWebExecutionNamespace } from "./index";
import { CHATGPT_WEB_DRIVER_ID } from "../../web-chat/host/provider-host";
import { chatGptTurnSessions, type ChatGptTurnSessions } from "./turn-execution";

/** What the driver reads from the provider, all of it provider-local state. */
export interface ChatGptWebDriverOptions {
  readonly provider: CodexProviderConfig;
  /** Turn-session registry that owns the physical generations and the installed fingerprints. */
  readonly sessions?: ChatGptTurnSessions;
  /**
   * Deployment namespace the conversation key is derived with.
   *
   * The caller that also derives the core's affinity passes the same value, so the driver and the core
   * identity can never disagree about which conversation a turn belongs to. It defaults to the
   * provider's own execution namespace.
   */
  readonly namespace?: string;
}

/** The opaque handle this provider records for one physical conversation. */
export function chatGptWebConversationHandle(conversationKey: string, generation: number): WebChatConversationHandle {
  // Opaque provider state: the core stores, compares and passes it, and never interprets it.
  return `${CHATGPT_WEB_DRIVER_ID}:${conversationKey}:${generation}` as WebChatConversationHandle;
}

/**
 * Create the ChatGPT Web driver.
 *
 * @param options - the provider configuration and (for tests and reuse) the session registry.
 * @returns the driver.
 */
export function createChatGptWebDriver(options: ChatGptWebDriverOptions): WebChatProviderDriver {
  const { provider } = options;
  const sessions = options.sessions ?? chatGptTurnSessions;
  const authority = createChatGptWebRouteAuthorityFromProvider(provider);
  const namespace = options.namespace ?? chatGptWebExecutionNamespace(provider);

  const descriptorOf = (model: string): WebChatModelDescriptor | undefined => {
    const route = availableChatGptWebRoutes(authority).find(candidate => candidate.slug === model);
    if (!route) return undefined;
    // Core descriptor ids are provider-local; translate the public DSH route slug
    // at this provider boundary without changing route authority or adapter ids.
    if (!route.slug.startsWith(CHATGPT_WEB_MODEL_PREFIX)) return undefined;
    return {
      id: route.slug.slice(CHATGPT_WEB_MODEL_PREFIX.length),
      label: route.displayName,
      text: true,
      reasoningModes: [route.adapterEffort],
    };
  };

  /**
   * The route this provider serves for a model identity.
   *
   * The continuity decision is handed the request the provider transport carries, whose `modelId` is
   * the **backend** model the provider routes to, while the public, provider-scoped route identity is
   * the slug the service selects. Both name the same served route, and the driver is the owner of that
   * mapping: without resolving both, a real turn would be assessed against a route this deployment does
   * serve and still be refused as unsupported.
   */
  const servedRouteOf = (model: string): ChatGptWebModelRoute | undefined =>
    availableChatGptWebRoutes(authority).find(candidate => candidate.slug === model || candidate.backendModel === model);

  /** The affinity key of one selection, derived by the core and never locally. */
  const conversationKeyOf = (selection: {
    affinity: { providerId: string; bindingId: string; threadId: string };
    dshSession: { sessionId?: string };
  }): string | undefined => {
    const dshSessionId = selection.dshSession.sessionId;
    if (!dshSessionId) return undefined;
    return webChatAffinityKey({
      providerId: selection.affinity.providerId,
      bindingId: selection.affinity.bindingId,
      dshSessionId,
      threadId: selection.affinity.threadId,
      namespace,
    });
  };

  const bindingOf = (binding: WebChatAccountBinding): string => webChatAccountBindingId(binding);

  const conversationOf = (input: {
    key: string;
    binding: WebChatAccountBinding;
    generation: number;
    status: WebChatConversation["status"];
  }): WebChatConversation => ({
    key: input.key,
    providerId: CHATGPT_WEB_DRIVER_ID,
    bindingId: bindingOf(input.binding),
    generation: input.generation,
    handle: chatGptWebConversationHandle(input.key, input.generation),
    status: input.status,
  });

  return {
    id: CHATGPT_WEB_DRIVER_ID,

    async inspectAccount(): Promise<WebChatAccountInspection> {
      const accountFingerprint = chatGptWebAccountFingerprint(provider);
      // An unknown session is a reported identity with no authenticated account behind it: the
      // capabilities are unknown rather than trusted, so the core never starts on a guess.
      const known = accountFingerprint.length > 0
        && accountFingerprint !== accountIdentityFromUnknownSession().fingerprint;
      return {
        authenticated: known,
        accountFingerprint,
        capabilities: {
          sol: known ? authority.capabilities.solAvailable : "unknown",
          pro: known ? authority.capabilities.proAvailable : "unknown",
        },
      };
    },

    async listModels(): Promise<readonly WebChatModelDescriptor[]> {
      return availableChatGptWebRoutes(authority).flatMap(route => {
        const descriptor = descriptorOf(route.slug);
        return descriptor ? [descriptor] : [];
      });
    },

    async resolveModel(model: string, reasoningMode?: string): Promise<WebChatModelDescriptor | undefined> {
      const descriptor = descriptorOf(model);
      if (!descriptor) return undefined;
      if (reasoningMode !== undefined && !descriptor.reasoningModes?.includes(reasoningMode)) return undefined;
      return descriptor;
    },

    /**
     * What this provider can say about an existing conversation.
     *
     * The provider's own branch rule: a fingerprint recorded for a generation means the initialization
     * state is physically installed in that conversation and it can continue; without one, the
     * conversation has to be established from canonical history (the provider's `install` path).
     */
    async assessConversation(input: WebChatConversationAssessmentInput): Promise<WebChatConversationAssessment> {
      if (!servedRouteOf(input.model)) {
        return { status: "unsupported", reason: `the ChatGPT Web route ${input.model} is not served by this deployment` };
      }
      if (input.conversation
        && sessions.sentSystemFingerprint(input.conversation.key, input.conversation.generation) !== undefined) {
        return {
          status: "resumable",
          reason: `the initialization state of generation ${input.conversation.generation} is installed`,
        };
      }
      return {
        status: "replay_required",
        reason: "the physical ChatGPT conversation must be established from canonical host history",
      };
    },

    async createConversation(input: WebChatConversationCreateInput): Promise<WebChatConversation> {
      const key = conversationKeyOf(input);
      if (!key) throw new Error("A ChatGPT conversation requires a host session identity");
      const generation = sessions.conversationGeneration(key);
      sessions.setConversationGeneration(key, generation);
      return conversationOf({ key, binding: input.binding, generation, status: "new" });
    },

    async resumeConversation(input: WebChatConversationResumeInput): Promise<WebChatConversation> {
      const generation = input.conversation.generation;
      sessions.setConversationGeneration(input.conversation.key, generation);
      return conversationOf({
        key: input.conversation.key,
        binding: input.binding,
        generation,
        status: "resumable",
      });
    },

    /**
     * Re-establish a conversation from canonical host history.
     *
     * A replay is a new physical epoch: the generation advances and is recorded, exactly as the
     * provider's replacement path does today.
     */
    async replayConversation(input: WebChatConversationReplayInput): Promise<WebChatConversation> {
      const key = input.conversation?.key ?? conversationKeyOf(input);
      if (!key) throw new Error("A ChatGPT replay requires a host session identity");
      const generation = (input.conversation?.generation ?? 0) + 1;
      sessions.setConversationGeneration(key, generation);
      return conversationOf({ key, binding: input.binding, generation, status: "resumable" });
    },

    async health(): Promise<WebChatProviderHealth> {
      const routes = availableChatGptWebRoutes(authority);
      if (routes.length === 0) {
        return { ok: false, detail: "no ChatGPT Web route is available for this deployment" };
      }
      return { ok: true, detail: `${routes.length} route(s) available` };
    },

    async shutdown(): Promise<void> {
      // The provider owns its processes; nothing to release here.
    },
  };
}
