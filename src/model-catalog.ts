import { providerConfig, type AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import {
  availableChatGptWebRoutes,
  createChatGptWebRouteAuthorityFromProvider,
} from "./chatgpt-web-authority";
import { effectiveChatGptWebProviderConfig } from "./chatgpt-web-provider-config";
import {
  CHATGPT_WEB_MODEL_PREFIX,
  resolveChatGptWebContextLimits,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import {
  qwenCodeCatalogueRows,
  qwenCodeCatalogueVisible,
  resolveQwenCodeProviderConfig,
} from "./adapters/qwen-code/provider-config";
import {
  qwenChatCatalogueRows,
  qwenChatCatalogueVisible,
  resolveQwenChatProviderConfig,
} from "./adapters/qwen-chat/provider-config";
import {
  deepSeekCatalogueRows,
  deepSeekCatalogueVisible,
  resolveDeepSeekProviderConfig,
} from "./adapters/deepseek-web/provider-config";

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

/**
 * The catalogue's view of the effective provider facts (issue #193).
 *
 * It reads the same resolved provider configuration every other seam uses, so `/v1/models` cannot
 * advertise a route the Responses ingress or the native loopback would refuse.
 */
function webCapabilities(provider: ReturnType<typeof providerConfig>): {
  solAvailable: boolean;
  proAvailable: boolean;
  experimentalBiggerContext: boolean;
  browserInteractionMode: "automatic" | "manual";
  zeroRiskProEnabled: boolean;
} {
  const authority = createChatGptWebRouteAuthorityFromProvider(provider);
  return {
    solAvailable: authority.capabilities.solAvailable === "supported",
    proAvailable: authority.capabilities.proAvailable === "supported",
    experimentalBiggerContext: provider.chatgptWeb?.experimentalBiggerContext === true,
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
  return buildChatGptWebModelFromProvider(route, effectiveChatGptWebProviderConfig(config));
}

function buildChatGptWebModelFromProvider(
  route: ChatGptWebModelRoute,
  provider: ReturnType<typeof providerConfig>,
): JsonObject {
  const capabilities = webCapabilities(provider);
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
    // The /v1/models catalog describes the Responses-compatible Web ingress. Automatic
    // ChatGPT Web routes retain native image input support; Zero Risk stays text-only because its
    // explicit manual launcher contract does not advertise image transport.
    input_modalities: route.interactionMode === "manual" ? ["text"] : ["text", "image"],
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
  const provider = effectiveChatGptWebProviderConfig(config);
  const routes = availableChatGptWebRoutes(createChatGptWebRouteAuthorityFromProvider(provider));
  const catalog: JsonObject = {
    object: "list",
    models: routes.map(route => buildChatGptWebModelFromProvider(route, provider)),
  };
  if (contextOverride) {
    for (const candidate of catalog.models as JsonObject[]) {
      candidate.max_context_window = contextOverride.contextWindow;
      candidate.context_window = contextOverride.contextWindow;
    }
  }
  return catalog;
}

/**
 * The public WebChat catalogue: every provider this deployment can serve, in one list.
 *
 * The ChatGPT rows keep their own owner ({@link buildChatGptWebModelCatalog}, the route authority
 * documented in `doc/provider-onboarding.md` §4.2); a second provider contributes **its own rows**
 * through its own module. This function only composes them, so `/v1/models`, the chat-completions
 * accepted-model check and any other consumer agree on exactly one list of public routes — and a
 * deployment that never configured the second provider keeps the catalogue it had before.
 */
export function buildPublicModelCatalog(
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const chatgpt = buildChatGptWebModelCatalog(config, contextOverride) as { models?: JsonObject[] };
  const rows: JsonObject[] = [...(chatgpt.models ?? [])];
  if (qwenCodeCatalogueVisible(config)) {
    rows.push(...qwenCodeCatalogueRows(resolveQwenCodeProviderConfig(config)).map(row => ({ ...row })));
  }
  // The second Qwen product (`chat.qwen.ai`) is a separate provider with its own modes. Its rows are
  // advertised on the same terms as Qwen Code's: the operator configured the block, or a verified
  // session exists. The two providers can both be present — they share an account family, never a
  // conversation.
  if (qwenChatCatalogueVisible(config)) {
    rows.push(...qwenChatCatalogueRows(resolveQwenChatProviderConfig(config)).map(row => ({ ...row })));
  }
  // DeepSeek Web is advertised on **one** fact only: the operator configured at least one `model_type`.
  // Its model list is a session-only remote setting (recon §2.5), so a verified session alone names no
  // model this deployment could honestly serve — and the bundle's deep-link prefill literal is not a
  // catalogue. An unconfigured deployment therefore keeps exactly the rows it had.
  if (deepSeekCatalogueVisible(config)) {
    rows.push(...deepSeekCatalogueRows(resolveDeepSeekProviderConfig(config)).map(row => ({ ...row })));
  }
  return { object: "list", models: rows };
}

/** The public route ids this deployment serves, in catalogue order. */
export function publicModelRouteIds(config: AppConfig): readonly string[] {
  const catalog = buildPublicModelCatalog(config);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  return models.flatMap((row) => {
    const routeId = slug(row);
    return routeId === undefined ? [] : [routeId];
  });
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
