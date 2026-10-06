import { createHash } from "node:crypto";
import {
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_MODEL_ROUTES,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  chatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import type { CodexProviderConfig } from "./types";

export type ChatGptWebCapabilityState = "supported" | "unsupported" | "unknown";

export interface ChatGptWebCapabilityStateSet {
  solAvailable: ChatGptWebCapabilityState;
  proAvailable: ChatGptWebCapabilityState;
}

export interface ChatGptWebAccountIdentity {
  /**
   * This is an authenticated browser-session fingerprint, not a storage/profile identifier
   * and not a raw OpenAI account id. Raw authentication material never leaves memory.
   */
  readonly kind: "authenticated-session";
  readonly fingerprint: string;
}

export interface ChatGptWebRouteAuthority {
  readonly capabilities: ChatGptWebCapabilityStateSet;
  readonly browserInteractionMode: "automatic" | "manual";
  readonly zeroRiskProEnabled: boolean;
  readonly accountIdentity?: ChatGptWebAccountIdentity;
}

function stateFromBoolean(value: boolean | undefined): ChatGptWebCapabilityState {
  if (value === undefined) return "unknown";
  return value ? "supported" : "unsupported";
}

export function resolveChatGptWebCapabilityState(input: {
  solAvailable?: boolean;
  proAvailable?: boolean;
  capabilityState?: Partial<ChatGptWebCapabilityStateSet>;
}): ChatGptWebCapabilityStateSet {
  const solAvailable = input.capabilityState?.solAvailable ?? stateFromBoolean(input.solAvailable);
  const proAvailable = input.capabilityState?.proAvailable ?? stateFromBoolean(input.proAvailable);
  if (proAvailable === "supported" && solAvailable !== "supported") {
    throw new Error("ChatGPT Web Pro capability is inconsistent with Sol capability");
  }
    return { solAvailable, proAvailable };
}

export function accountIdentityFromUserId(userId: string): ChatGptWebAccountIdentity {
  const normalized = userId.trim();
  if (!normalized) throw new Error("ChatGPT authenticated session did not expose a user id");
  const fingerprint = createHash("sha256")
    .update(`chatgpt-web-user:${normalized}`)
    .digest("hex")
    .slice(0, 24);
  return {
    kind: "authenticated-session",
    fingerprint,
  };
}

/** Legacy compatibility only; storage state is not a stable account identity. */
export function accountIdentityFromStorageState(storageState: unknown): ChatGptWebAccountIdentity {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(storageState))
    .digest("hex")
    .slice(0, 24);
  return {
    kind: "authenticated-session",
    fingerprint,
  };
}

export function accountIdentityFromUnknownSession(): ChatGptWebAccountIdentity {
  return {
    kind: "authenticated-session",
    fingerprint: "unknown",
  };
}

export function createChatGptWebRouteAuthority(input: {
  solAvailable?: boolean;
  proAvailable?: boolean;
  capabilityState?: Partial<ChatGptWebCapabilityStateSet>;
  browserInteractionMode?: "automatic" | "manual";
  zeroRiskProEnabled?: boolean;
  accountIdentity?: ChatGptWebAccountIdentity;
}): ChatGptWebRouteAuthority {
  return {
    capabilities: resolveChatGptWebCapabilityState(input),
    browserInteractionMode: input.browserInteractionMode ?? "automatic",
    zeroRiskProEnabled: input.zeroRiskProEnabled === true,
    ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
  };
}

export function createChatGptWebRouteAuthorityFromProvider(
  provider: CodexProviderConfig,
): ChatGptWebRouteAuthority {
  const config = provider.chatgptWeb;
  return createChatGptWebRouteAuthority({
    solAvailable: config?.solAvailable,
    proAvailable: config?.proAvailable,
    capabilityState: config?.capabilityState,
    browserInteractionMode: config?.browserInteractionMode,
    zeroRiskProEnabled: config?.zeroRiskProEnabled,
    ...(config?.accountIdentityFingerprint
      ? {
          accountIdentity: {
            kind: "authenticated-session",
            fingerprint: config.accountIdentityFingerprint,
          },
        }
      : {}),
  });
}

function failUnknown(capability: string): never {
  throw new Error(`ChatGPT Web ${capability} capability is unknown or unverifiable; refusing model selection`);
}

export function availableChatGptWebRoutes(
  authority: ChatGptWebRouteAuthority,
): readonly ChatGptWebModelRoute[] {
  if (authority.browserInteractionMode === "manual") {
    return authority.zeroRiskProEnabled
      ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]
      : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE];
  }

  if (authority.capabilities.solAvailable === "unknown") return [];
  if (authority.capabilities.solAvailable === "unsupported") {
    return CHATGPT_WEB_LUNA_MODEL_ROUTES;
  }

  if (authority.capabilities.proAvailable === "supported") return CHATGPT_WEB_MODEL_ROUTES;
  return CHATGPT_WEB_MODEL_ROUTES.filter(route => !route.requiresPro);
}

export function requireChatGptWebRoute(
  modelId: string,
  authority: ChatGptWebRouteAuthority,
): ChatGptWebModelRoute {
  const route = chatGptWebModelRoute(modelId);
  if (!route) {
    throw new Error(`ChatGPT Web route is not supported: ${modelId}. Codex/Work routes are outside this provider authority`);
  }

  if (route.interactionMode === "manual") {
    if (authority.browserInteractionMode !== "manual") {
      throw new Error(`${route.displayName} requires the explicit Zero Risk browser interaction mode`);
    }
    if (route === CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE && !authority.zeroRiskProEnabled) {
      throw new Error(`${route.displayName} is not enabled in Zero Risk model settings`);
    }
    return route;
  }

  if (authority.browserInteractionMode !== "automatic") {
    throw new Error(`${route.displayName} is unavailable while Zero Risk is enabled`);
  }

  if (authority.capabilities.solAvailable === "unknown") failUnknown("Sol/model-selector");
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (authority.capabilities.solAvailable !== "unsupported") {
      throw new Error(`${route.displayName} is reserved for Luna-only accounts`);
    }
    return route;
  }

  if (authority.capabilities.solAvailable !== "supported") {
    throw new Error(`${route.displayName} is unavailable because the ChatGPT Web model-selector route is not established`);
  }
  if (route.requiresPro) {
    if (authority.capabilities.proAvailable === "unknown") failUnknown("Pro");
    if (authority.capabilities.proAvailable !== "supported") {
      throw new Error(`${route.displayName} is unavailable for this authenticated ChatGPT Web account`);
    }
  }
  return route;
}

export function assertChatGptWebSelectionKnown(
  authority: ChatGptWebRouteAuthority,
): void {
  if (authority.browserInteractionMode === "manual") return;
  if (authority.capabilities.solAvailable === "unknown") failUnknown("Sol/model-selector");
}

export function routeAccountingDomain(route: ChatGptWebModelRoute): "chatgpt-web" {
  return route.accountingDomain;
}
