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
  type WebChatExchangeState,
  type WebChatModelDescriptor,
  type WebChatProviderDriver,
  type WebChatProviderHealth,
  type WebChatRetrySafety,
  type WebChatSubmissionPhase,
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
      // A driver declares its model's **public** id, which a provider may already scope with its own
      // id (`chatgpt-web/luna`). Prefixing that again would produce `chatgpt-web/chatgpt-web/luna`, so
      // the provider is only added when the id is not already qualified.
      id: model.id.startsWith(`${providerId}/`) ? model.id : `${providerId}/${model.id}`,
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
export function dshFailureSemanticsFor(
  snapshot: WebChatExchangeSnapshot,
  observation: { readonly partialOutputObserved?: boolean } = {},
): WebChatDshFailureSemantics {
  const safety = webChatRetrySafetyOf({
    snapshot,
    ...(observation.partialOutputObserved !== undefined
      ? { partialOutputObserved: observation.partialOutputObserved }
      : {}),
  });
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

/** What one failure's submission evidence is, when the caller does not hold a whole exchange. */
export interface WebChatSubmissionEvidence {
  /** How far submission is proven to have gone for the failed attempt. */
  readonly phase: WebChatSubmissionPhase;
  /** Whether output was already observed, which makes a retry unsafe however the phase reads. */
  readonly partialOutputObserved?: boolean;
  /** When the attempt's exchange is known, its state decides alongside the phase. */
  readonly state?: WebChatExchangeState;
  /** Whether the attempt's conversation was retired. */
  readonly retired?: boolean;
}

/**
 * The DSH failure semantics of one submission evidence, without a whole exchange snapshot.
 *
 * A provider that reports its submit boundary rather than an exchange still gets the same rule: this
 * builds the exchange view the single retry authority reasons over and delegates to
 * {@link dshFailureSemanticsFor}, so `prepared` is the only phase DSH may retry and `send_activated`
 * (ambiguous) or `accepted` (confirmed) never is. No caller reimplements the rule.
 */
export function dshFailureSemanticsForSubmission(
  evidence: WebChatSubmissionEvidence,
): WebChatDshFailureSemantics {
  return dshFailureSemanticsFor({
    exchangeId: "submission-evidence",
    conversationKey: "submission-evidence",
    epoch: 1,
    state: evidence.state ?? (evidence.phase === "send_activated" ? "SUBMISSION_AMBIGUOUS" : "FAILED"),
    phase: evidence.phase,
    logical: "failed",
    physical: "pending",
    retired: evidence.retired ?? false,
    cancelRequested: false,
    submits: 1,
    maxSubmits: 1,
    updatedAt: 0,
  }, evidence.partialOutputObserved !== undefined
    ? { partialOutputObserved: evidence.partialOutputObserved }
    : {});
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

/**
 * The route ids that may be registered publicly.
 *
 * `ctx.llm.registerAdapter` remains the only public registration authority, and a route is only
 * registerable when this deployment actually implements it: an id with no driver is refused, so the
 * registry can never look complete with implementations that do not exist.
 */
export function registerableRouteIds(
  routeIds: readonly string[],
  drivers: readonly WebChatProviderDriver[],
): readonly string[] {
  return routeIds.filter(routeId => drivers.some(driver => driver.id === routeId));
}

/** A public-facing provider check, without any credential. */
export interface WebChatProviderCheck {
  readonly providerId: string;
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}

/**
 * Turn one provider's information into a doctor check.
 *
 * The detail carries only non-secret facts: the account is described by its fingerprint (an
 * identifier, never a credential), and an unhealthy driver is reported as an error rather than being
 * omitted from the report.
 */
export function webChatProviderCheck(info: WebChatProviderInfo): WebChatProviderCheck {
  const parts: string[] = [];
  parts.push(info.authenticated ? `authenticated (${info.accountFingerprint ?? "no fingerprint"})` : "not authenticated");
  if (info.capabilities) {
    const unsupported = Object.entries(info.capabilities)
      .filter(([, state]) => state === "unsupported")
      .map(([capability]) => capability);
    if (unsupported.length > 0) parts.push(`unsupported: ${unsupported.join(", ")}`);
  }
  parts.push(`${info.models.length} model${info.models.length === 1 ? "" : "s"}`);
  if (info.health.detail) parts.push(info.health.detail);

  if (!info.health.ok) return { providerId: info.providerId, status: "error", detail: parts.join("; ") };
  if (!info.authenticated) return { providerId: info.providerId, status: "warning", detail: parts.join("; ") };
  return { providerId: info.providerId, status: "ok", detail: parts.join("; ") };
}

/**
 * The prefix of an account fingerprint that a human-facing report may print.
 *
 * A fingerprint is an account identifier, never a credential, but a diagnostic report should still
 * not carry a complete identifier: only a short prefix is printed, which is enough to tell two
 * accounts apart and useless as a lookup key.
 */
export function redactWebChatFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  return trimmed.length <= 8 ? trimmed : `${trimmed.slice(0, 8)}…`;
}

/**
 * Turn one provider's information into a doctor check, with an identifier-safe detail.
 *
 * This is the doctor-facing variant of {@link webChatProviderCheck}: the same status and the same
 * non-secret facts, with the account fingerprint shortened. The check never carries a credential, and
 * an unhealthy driver is reported as an error rather than omitted from the report.
 */
export function webChatDoctorCheck(info: WebChatProviderInfo): WebChatProviderCheck {
  const check = webChatProviderCheck(info);
  const fingerprint = info.accountFingerprint;
  if (!fingerprint) return check;
  return { ...check, detail: check.detail.split(fingerprint).join(redactWebChatFingerprint(fingerprint)) };
}

/**
 * An idempotent shutdown for the drivers this deployment composed.
 *
 * Each driver is asked to shut down exactly once, and a driver that throws does not stop the others
 * or the sidecar from shutting down: shutdown must always complete.
 */
export function createWebChatShutdown(
  drivers: readonly WebChatProviderDriver[],
  onError: (error: unknown, providerId: string) => void = () => {},
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= (async () => {
      for (const driver of drivers) {
        try {
          await driver.shutdown();
        } catch (error) {
          onError(error, driver.id);
        }
      }
    })();
    return shutdown;
  };
}

/**
 * Release a conversation store, whatever backend it is.
 *
 * Every backend may need to release what it owns (a durable file, for instance), and a release that
 * fails must not turn into an unhandled rejection during shutdown.
 */
export async function closeWebChatConversationStore(store: WebChatConversationStore): Promise<void> {
  try {
    await store.close?.();
  } catch {
    // Releasing is best effort: the process is going away and the store holds no other authority.
  }
}
