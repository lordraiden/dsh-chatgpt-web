/**
 * WebChat provider host boundary.
 *
 * This is the **host boundary** between the container service and the provider-neutral WebChat
 * core: it composes the ChatGPT Web driver and exposes the facts the container needs. It is
 * deliberately outside `src/web-chat/core/**` (which must stay provider-free) and it never becomes a
 * second routing authority:
 *
 * - The container selects the provider; the caller here composes exactly the drivers this
 *   deployment implements, and an unknown provider simply does not resolve. There is no public
 *   registry policy, no model authority and no fallback provider.
 * - Model entries are *informational* provider-scoped identities. The provider catalogue does not
 *   decide what the adapter accepts: the driver remains authoritative over accepted model ids and
 *   unsupported options, and unsupported content fails explicitly instead of being dropped.
 * - Provider continuation state stays opaque and provider-scoped; it never replaces the durable
 *   conversation store.
 */
import { resolve } from "node:path";

import {
  createMemoryConversationStore,
  isWebChatModelDescriptor,
  type WebChatConversationStore,
  type WebChatModelDescriptor,
  type WebChatProviderDriver,
  type WebChatProviderHealth,
} from "../core";
import { createFileConversationStore } from "../persistence/conversation-store-file";

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
 * The process-owned conversation stores, one per effective durable location.
 *
 * The durable backend owns **one writer per file and process**, so the process keeps exactly one
 * store per location: every provider composition of this process resolves the same store, and a
 * second store for the same file is refused by the backend instead of silently racing a second
 * writer. This is the one registry; the ChatGPT adapter's `resolveNativeChatGptContinuityStore`
 * delegates to it rather than keeping a second map (issue #299, slice 2).
 */
const sharedConversationStores = new Map<string, WebChatConversationStore>();

/**
 * Resolve the deployment's conversation store for one configuration.
 *
 * @param config - the host configuration (the durable location and its provider fallbacks).
 * @returns the process-owned store for that location, or the memory backend when none is configured.
 */
export function resolveSharedConversationStore(config: WebChatHostConfig): WebChatConversationStore {
  const path = config.webChat?.conversationStorePath?.trim();
  const key = path !== undefined && path.length > 0 ? resolve(path) : "";
  const existing = sharedConversationStores.get(key);
  if (existing !== undefined) return existing;
  const store = createWebChatConversationStore(config);
  sharedConversationStores.set(key, store);
  return store;
}

/**
 * Release every process-owned conversation store.
 *
 * Taking the map first makes the release **idempotent**: a repeated shutdown sees an empty map and
 * releases nothing twice. Each backend drains its own write queue before giving the file back, so a
 * committed update is already on disk.
 */
export async function closeSharedConversationStores(): Promise<void> {
  const stores = [...sharedConversationStores.values()];
  sharedConversationStores.clear();
  for (const store of stores) await closeWebChatConversationStore(store);
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

/** One provider-scoped model entry for the informational catalogue. */
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
      // Core model ids are provider-local. The host qualifies them exactly once
      // for the public informational catalogue.
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
