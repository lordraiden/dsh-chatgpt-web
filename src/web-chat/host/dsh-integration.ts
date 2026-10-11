/**
 * WebChat ↔ DSH host integration (issue #193).
 *
 * This is the **host boundary**: it consumes the provider-neutral core and the ChatGPT driver and
 * exposes them to the DSH runtime. It is deliberately outside `src/web-chat/core/**` (which must stay
 * provider-free) and it never becomes a second routing authority:
 *
 * - DSH selects the provider route; the resolver here only maps an **already-selected** route to its
 *   driver (architecture §17). There is no public registry policy, no model authority and no fallback
 *   provider: an unknown route simply does not resolve.
 * - Model entries are *informational* provider-scoped identities. DSH's catalogue does not decide what
 *   the adapter accepts: the adapter remains authoritative over accepted model ids and unsupported
 *   options (DSH LLM contract), and unsupported content fails explicitly instead of being dropped.
 * - Retryability is translated into DSH's failure semantics so DSH never retries a confirmed or
 *   ambiguous submission as if it were a pre-submit transport failure (architecture §9.4).
 * - Provider `replayState` is opaque, provider-scoped transport metadata: it never replaces the
 *   durable conversation store, and cross-provider reuse fails closed.
 */
import {
  assertTextOnlyWebChatTurn,
  assertWebChatReplayStateOwner,
  createMemoryConversationStore,
  createWebChatDriverResolver,
  isWebChatModelDescriptor,
  webChatRetrySafetyOf,
  type WebChatConversationStore,
  type WebChatDriverResolver,
  type WebChatExchangeSnapshot,
  type WebChatModelDescriptor,
  type WebChatProviderDriver,
  type WebChatProviderHealth,
  type WebChatRetrySafety,
} from "../core";
import {
  createFileConversationStore,
  defaultWebChatConversationStorePath,
} from "../persistence/conversation-store-file";

/** The provider this deployment implements today. */
export const CHATGPT_WEB_DRIVER_ID = "chatgpt-web";

/** Configuration as the host passes it: provider-scoped, with the historical flat block as fallback. */
export interface WebChatHostConfig {
  readonly webChat?: {
    readonly providers?: Readonly<Record<string, unknown>>;
    /** Durable continuity location; omit to keep continuity in memory. */
    readonly conversationStorePath?: string;
  };
  /** Historical flat ChatGPT Web configuration (kept compatible). */
  readonly chatgptWeb?: unknown;
}

/**
 * Resolve one provider's configuration.
 *
 * Precedence: the provider-scoped block (`webChat.providers.<id>`) wins; when it is absent the
 * historical flat block is used for the ChatGPT provider, so existing installations keep working
 * unchanged. Anything else resolves to `undefined` rather than inventing a configuration.
 */
export function resolveWebChatProviderConfig(config: WebChatHostConfig, providerId: string): unknown {
  const scoped = config.webChat?.providers?.[providerId];
  if (scoped !== undefined) return scoped;
  if (providerId === CHATGPT_WEB_DRIVER_ID) return config.chatgptWeb;
  return undefined;
}

/**
 * The durable conversation store this deployment uses.
 *
 * The location is a deployment decision (#193): when a path is configured the durable file backend is
 * used, so continuity survives a restart; otherwise continuity stays in memory. The file backend owns
 * one writer per file and process, so a second store for the same path is refused by design.
 */
export function createWebChatConversationStore(config: WebChatHostConfig): WebChatConversationStore {
  const path = config.webChat?.conversationStorePath;
  if (typeof path === "string" && path.trim().length > 0) {
    return createFileConversationStore({ file: path });
  }
  return createMemoryConversationStore();
}

/** The default durable location, for a deployment that wants to opt in. */
export function defaultWebChatStorePath(): string {
  return defaultWebChatConversationStorePath();
}

/**
 * Resolve an already-selected provider route to its driver.
 *
 * No policy lives here: the caller passes the drivers this deployment composes, DSH has already
 * selected the route, and an unknown route does not resolve.
 */
export function createWebChatHostResolver(
  drivers: readonly WebChatProviderDriver[],
  providerId: string,
): WebChatDriverResolver {
  // Only the provider this deployment actually implements is composed; no fake routes are registered.
  const composed = drivers.filter(driver => driver.id === providerId);
  return createWebChatDriverResolver(composed);
}

/** One provider-scoped model entry for the DSH catalogue. */
export interface WebChatModelCatalogueEntry {
  /** Provider-scoped identity: the same model id under two providers is two different entries. */
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly label: string;
  readonly text: true;
}

/**
 * Build the informational catalogue entries for one provider.
 *
 * The ids are provider-scoped because a model id is not globally unique; the entries exist for
 * discovery only, and the adapter stays authoritative over what it accepts.
 */
export function webChatModelCatalogueEntries(
  providerId: string,
  models: readonly WebChatModelDescriptor[],
): readonly WebChatModelCatalogueEntry[] {
  return models
    .filter(isWebChatModelDescriptor)
    .map(model => ({
      id: `${providerId}/${model.id}`,
      providerId,
      modelId: model.id,
      label: model.label,
      text: true as const,
    }));
}

/** What the host can report about one provider. */
export interface WebChatProviderInfo {
  readonly providerId: string;
  readonly authenticated: boolean;
  readonly accountFingerprint?: string;
  readonly capabilities?: Readonly<Record<string, "supported" | "unsupported" | "unknown">>;
  readonly models: readonly WebChatModelCatalogueEntry[];
  readonly health: WebChatProviderHealth;
}

/**
 * Assemble one provider's information for diagnostics (doctor, logs).
 *
 * The driver answers; the host only presents. A driver failure is reported as an unhealthy provider
 * instead of being hidden.
 */
export async function inspectWebChatProvider(driver: WebChatProviderDriver): Promise<WebChatProviderInfo> {
  try {
    const [account, models, health] = await Promise.all([
      driver.inspectAccount(),
      driver.listModels(),
      driver.health(),
    ]);
    return {
      providerId: driver.id,
      authenticated: account.authenticated,
      ...(account.accountFingerprint !== undefined ? { accountFingerprint: account.accountFingerprint } : {}),
      ...(account.capabilities !== undefined ? { capabilities: account.capabilities } : {}),
      models: webChatModelCatalogueEntries(driver.id, models),
      health,
    };
  } catch (error) {
    return {
      providerId: driver.id,
      authenticated: false,
      models: [],
      health: { ok: false, detail: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** How DSH must treat a failure, derived from the exchange's own retry classification. */
export interface WebChatDshFailureSemantics {
  /** Whether DSH's route-level retry may re-invoke the provider. */
  readonly retryable: boolean;
  readonly safety: WebChatRetrySafety;
  readonly reason: "pre_submit" | "confirmed_or_ambiguous";
  readonly detail: string;
}

/**
 * Translate the exchange's retry safety into DSH's stable failure semantics.
 *
 * `retry_safe` (a failure proven to be before submission) is the only case DSH may retry. Anything
 * else — a confirmed submission, an ambiguous one, partial output — must not be retried by DSH: the
 * provider may already have executed the turn.
 */
export function dshFailureSemanticsFor(snapshot: WebChatExchangeSnapshot): WebChatDshFailureSemantics {
  const safety = webChatRetrySafetyOf({ snapshot });
  if (safety === "retry_safe") {
    return {
      retryable: true,
      safety,
      reason: "pre_submit",
      detail: "the failure is proven to be before submission",
    };
  }
  return {
    retryable: false,
    safety,
    reason: "confirmed_or_ambiguous",
    detail: safety === "ambiguous"
      ? "the provider may have accepted the submission: never retried automatically"
      : "the submission is confirmed or produced output: never retried automatically",
  };
}

/** Assert that host replay state belongs to the requested provider conversation. */
export function assertHostReplayStateOwnership(
  state: unknown,
  expected: { readonly providerId: string; readonly bindingId: string; readonly conversationKey?: string },
): void {
  assertWebChatReplayStateOwner(state, expected);
}

/**
 * Admit a turn into the text-only core, or fail explicitly.
 *
 * The host boundary is where DSH options meet the common layer: files, images, audio/video,
 * attachments, tools, toolChoice and MCP are refused with a stable `UNSUPPORTED_OPTION` instead of
 * being dropped or reinterpreted.
 */
export function admitDshTurn(candidate: unknown): ReturnType<typeof assertTextOnlyWebChatTurn> {
  return assertTextOnlyWebChatTurn(candidate);
}
