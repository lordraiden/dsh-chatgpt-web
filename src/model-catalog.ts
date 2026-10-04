import type { AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import {
  availableChatGptWebRoutes,
  createChatGptWebRouteAuthority,
} from "./chatgpt-web-authority";
import {
  CHATGPT_WEB_MODEL_PREFIX,
  resolveChatGptWebContextLimits,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function webCapabilities(config: AppConfig): {
  solAvailable: boolean;
  proAvailable: boolean;
  experimentalBiggerContext: boolean;
  browserInteractionMode: "automatic" | "manual";
  zeroRiskProEnabled: boolean;
} {
  const authority = createChatGptWebRouteAuthority({
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    capabilityState: config.capabilityState,
    browserInteractionMode: config.browserInteractionMode,
    zeroRiskProEnabled: config.zeroRiskProEnabled,
  });
  return {
    solAvailable: authority.capabilities.solAvailable === "supported",
    proAvailable: authority.capabilities.proAvailable === "supported",
    experimentalBiggerContext: config.experimentalBiggerContext,
    browserInteractionMode: authority.browserInteractionMode,
    zeroRiskProEnabled: authority.zeroRiskProEnabled,
  };
}

function standaloneReasoningLevel(route: ChatGptWebModelRoute): JsonObject {
  return {
    effort: route.adapterEffort,
    description: route.displayName,
  };
}

/**
 * Build a ChatGPT Web model row from the Web route descriptor alone.
 *
 * Native Codex metadata such as priority, multi-agent protocol flags, compaction hashes and
 * service tiers is intentionally not copied. This is a product-owned catalog row.
 */
export function buildChatGptWebModel(
  route: ChatGptWebModelRoute,
  config: AppConfig,
): JsonObject {
  const capabilities = webCapabilities(config);
  const limits = resolveChatGptWebContextLimits(
    route.backendModel,
    route.adapterEffort,
    {
      ...capabilities,
      ...(capabilities.browserInteractionMode === "manual"
        ? { experimentalBiggerContext: false }
        : {}),
    },
  );
  return {
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: ["text"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: route.adapterEffort,
    supported_reasoning_levels: [standaloneReasoningLevel(route)],
    context_window: limits.contextWindow,
    max_context_window: limits.contextWindow,
    effective_context_window_percent: limits.effectiveContextWindowPercent,
    auto_compact_token_limit: limits.autoCompactTokenLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
}

export function buildChatGptWebModelCatalog(
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const routes = availableChatGptWebRoutes(createChatGptWebRouteAuthority({
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    capabilityState: config.capabilityState,
    browserInteractionMode: config.browserInteractionMode,
    zeroRiskProEnabled: config.zeroRiskProEnabled,
  }));
  const catalog: JsonObject = {
    object: "list",
    models: routes.map(route => buildChatGptWebModel(route, config)),
  };
  if (contextOverride) {
    for (const candidate of catalog.models as JsonObject[]) {
      candidate.max_context_window = contextOverride.contextWindow;
      candidate.context_window = contextOverride.contextWindow;
    }
  }
  return catalog;
}

function useCompatibilityV1SubagentSurface(model: JsonObject): void {
  if (model.multi_agent_version !== "disabled") model.multi_agent_version = "v1";
}

export function augmentNativeModelCatalog(
  value: unknown,
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  const nativeModels = structuredClone(
    catalog.models.filter(model => !slug(model)?.startsWith(CHATGPT_WEB_MODEL_PREFIX)),
  );
  if (config.subagentProtocol === "compatibility-v1") {
    for (const candidate of nativeModels) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        useCompatibilityV1SubagentSurface(candidate as JsonObject);
      }
    }
  }
  const webCatalog = buildChatGptWebModelCatalog(config, contextOverride);
  return {
    ...structuredClone(catalog),
    models: [...nativeModels, ...(webCatalog.models as JsonObject[])],
  };
}
