/**
 * The Qwen Chat provider's own facts.
 *
 * This module answers, from **one** place, the questions the driver, the ingress, the catalogue and
 * `doctor` all need:
 *
 * - where this provider's verified session lives (`providers/qwen-chat/storage-state.json`);
 * - which account binding a conversation belongs to;
 * - which provider-local models this deployment serves, and the abilities that decide each model's
 *   selectable modes;
 * - the **public** catalogue rows derived from those models (`qwen-chat/<modelId>`).
 *
 * ## The model list: configured, cached, else the measured seed
 *
 * See `models.ts` for the full rationale. In short: the anonymous endpoint is probably the visitor
 * subset, so it is a hint; the operator's `models` block wins; a refreshed cache beats the seed; the
 * seed is the three ids the recon measured. An empty configured list is a configuration error, never
 * "serve everything".
 *
 * ## The account identity: recorded, never derived
 *
 * `doc/provider-onboarding.md` §4.3 records the trap: a *derived* fingerprint (from a storage-state
 * file, or an `"unknown"` placeholder) can never match the account a signed-in browser exposes, so
 * reporting it as an authenticated account is a lie. No stable account identifier was measured for
 * `chat.qwen.ai` (there is no recorded "who am I" endpoint), so this provider does not derive one.
 * Its account identity is whatever the deployment recorded (`accountIdentityFingerprint`); when
 * nothing was recorded the driver reports the session as authenticated but publishes **no**
 * fingerprint. The conversation binding still needs a non-empty identity, so the same stable
 * placeholder every unrecorded deployment uses is applied there and marked as not recorded.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getConfigDir,
  providerCredentialsDir,
  providerStorageStatePath,
  resolveProviderStorageStatePath,
  storageStateMarkerPath,
  type AppConfig,
} from "../../config";
import type { WebChatAccountBinding, WebChatModelDescriptor } from "../../web-chat/core";
import {
  QWEN_CHAT_ORIGIN,
  QWEN_CHAT_PROVIDER_ID,
  qwenChatDefaultMode,
  qwenChatThinkingAbility,
  type QwenChatMode,
} from "./provider";
import {
  qwenChatEntryModes,
  qwenChatModelList,
  type QwenChatModelEntry,
} from "./models";

/**
 * The identity an unrecorded deployment binds its conversations under.
 *
 * Stable by construction (a constant, not a hash of a file), so a restart cannot even change the
 * *placeholder*. It is published as `accountIdentityRecorded: false`; nothing treats it as an
 * account.
 */
export const QWEN_CHAT_UNRECORDED_ACCOUNT_FINGERPRINT = "qwen-chat-unrecorded-account";

/** Everything the Qwen Chat provider resolves from the deployment configuration. */
export interface QwenChatProviderConfig {
  /** Catalogue/driver/auth id. One id, never a second spelling. */
  readonly providerId: string;
  /** Absolute path of the verified session this deployment reads. */
  readonly storageStatePath: string;
  /** Absolute path of this provider's durable conversation→chat state. */
  readonly chatStatePath: string;
  /** Absolute path of the cached public model list (written by `models refresh`). */
  readonly modelsCachePath: string;
  /** The configured Chrome executable (the sign-in and the session page both use it). */
  readonly chromeExecutablePath: string;
  /** Provider-local models this deployment serves. Never empty. */
  readonly models: readonly QwenChatModelEntry[];
  /** The account fingerprint a conversation binds to (recorded, or the documented placeholder). */
  readonly accountFingerprint: string;
  /** Whether `accountFingerprint` is a **recorded** identity rather than the placeholder. */
  readonly accountIdentityRecorded: boolean;
  /** Deployment namespace the core affinity key is derived with; stable across restarts. */
  readonly namespace: string;
}

/** The generic refusal for a malformed provider block. */
function providerConfigError(field: string, detail: string): Error {
  return new Error(`Invalid webChat.providers["${QWEN_CHAT_PROVIDER_ID}"].${field}: ${detail}`);
}

/** A non-empty string field, or `undefined` when it is absent. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw providerConfigError(field, "expected a non-empty string");
  }
  return value.trim();
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw providerConfigError(field, "expected a positive integer");
  }
  return value;
}

/** One configured model, with the fields an operator may narrow. */
interface ConfiguredModel {
  readonly id: string;
  readonly label?: string;
  readonly thinking?: unknown;
  readonly autoThinking?: unknown;
  readonly thinkingFormat?: string;
  readonly contextWindow?: number;
}

/**
 * Read the configured model list.
 *
 * Accepts `["id", …]` and `[{ "id": …, "label": …, "thinking": …, "autoThinking": …,
 * "thinkingFormat": …, "contextWindow": … }, …]`. Both are provider-local ids. An empty or
 * non-array value is refused instead of being replaced by the seed, because "serve nothing" and
 * "serve the seed" must never be the same silent outcome.
 */
function configuredModels(value: unknown): readonly ConfiguredModel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw providerConfigError("models", "expected a non-empty array of model ids");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id.length === 0) throw providerConfigError(`models[${index}]`, "expected a non-empty model id");
      if (seen.has(id)) throw providerConfigError(`models[${index}]`, `duplicate model id ${JSON.stringify(id)}`);
      seen.add(id);
      return { id };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw providerConfigError(`models[${index}]`, "expected a model id string or an object with an id");
    }
    const record = entry as Record<string, unknown>;
    const id = optionalString(record["id"], `models[${index}].id`);
    if (id === undefined) throw providerConfigError(`models[${index}].id`, "required");
    if (seen.has(id)) throw providerConfigError(`models[${index}].id`, `duplicate model id ${JSON.stringify(id)}`);
    seen.add(id);
    const thinking = record["thinking"];
    if (thinking !== undefined && qwenChatThinkingAbility(thinking) === undefined) {
      throw providerConfigError(
        `models[${index}].thinking`,
        "expected a boolean or the numeric abilities enum 0..5",
      );
    }
    const autoThinking = record["autoThinking"];
    if (autoThinking !== undefined && typeof autoThinking !== "boolean") {
      throw providerConfigError(`models[${index}].autoThinking`, "expected a boolean");
    }
    return {
      id,
      ...(optionalString(record["label"], `models[${index}].label`) === undefined
        ? {}
        : { label: optionalString(record["label"], `models[${index}].label`) }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(autoThinking === undefined ? {} : { autoThinking }),
      ...(optionalString(record["thinkingFormat"], `models[${index}].thinkingFormat`) === undefined
        ? {}
        : { thinkingFormat: optionalString(record["thinkingFormat"], `models[${index}].thinkingFormat`) }),
      ...(optionalPositiveInteger(record["contextWindow"], `models[${index}].contextWindow`) === undefined
        ? {}
        : { contextWindow: optionalPositiveInteger(record["contextWindow"], `models[${index}].contextWindow`) }),
    };
  });
}

/** The provider-scoped block this deployment configured, if any. */
function providerBlock(config: AppConfig): Record<string, unknown> {
  const scoped = config.webChat?.providers?.[QWEN_CHAT_PROVIDER_ID];
  if (scoped === undefined) return {};
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    throw new Error(`Invalid webChat.providers["${QWEN_CHAT_PROVIDER_ID}"]: expected an object`);
  }
  return scoped as Record<string, unknown>;
}

/**
 * The deployment namespace this provider's conversation keys are derived with.
 *
 * A hash of the facts that identify the deployment, never of a process-local value: the same
 * configuration therefore addresses the same conversations after a restart, which is what makes the
 * durable chat state meaningful. It excludes the account *provenance* flag (a fact about reporting,
 * not about identity).
 */
export function qwenChatExecutionNamespace(
  facts: Pick<QwenChatProviderConfig, "providerId" | "accountFingerprint">,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      providerId: facts.providerId,
      origin: QWEN_CHAT_ORIGIN,
      accountFingerprint: facts.accountFingerprint,
    }))
    .digest("hex");
}

/** Merge one configured entry with the hint (seed/cache) entry of the same id. */
function resolveModelEntry(configured: ConfiguredModel, hints: readonly QwenChatModelEntry[]): QwenChatModelEntry {
  const hint = hints.find(candidate => candidate.id === configured.id);
  const thinking = configured.thinking === undefined ? hint?.thinking : qwenChatThinkingAbility(configured.thinking);
  const autoThinking = configured.autoThinking === undefined
    ? hint?.autoThinking
    : configured.autoThinking === true;
  const thinkingFormat = configured.thinkingFormat ?? hint?.thinkingFormat;
  const contextWindow = configured.contextWindow ?? hint?.contextWindow;
  return {
    id: configured.id,
    label: configured.label ?? hint?.label ?? configured.id,
    ...(thinking === undefined ? {} : { thinking }),
    ...(autoThinking === undefined ? {} : { autoThinking }),
    ...(thinkingFormat === undefined ? {} : { thinkingFormat }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

/**
 * Resolve this provider's facts from the deployment configuration.
 *
 * @param config - the deployment configuration.
 * @returns the provider facts the driver, the runtime, the catalogue rows and `doctor` all use.
 * @throws {Error} when a provider-scoped field is malformed (never a silent fallback).
 */
export function resolveQwenChatProviderConfig(config: AppConfig): QwenChatProviderConfig {
  const block = providerBlock(config);
  const configuredStorage = optionalString(block["storageStatePath"], "storageStatePath");
  // Deliberately **no** fall back to the deployment's ChatGPT/Qwen Code credential path: only this
  // provider's own directory, or a path the operator configured for it, may satisfy this provider's
  // session check. One provider's session can never authenticate another.
  const storageStatePath = configuredStorage === undefined
    ? providerStorageStatePath(QWEN_CHAT_PROVIDER_ID)
    : resolveProviderStorageStatePath(configuredStorage, QWEN_CHAT_PROVIDER_ID);
  const providerDir = providerCredentialsDir(QWEN_CHAT_PROVIDER_ID, getConfigDir());
  const chromeExecutablePath = optionalString(block["chromeExecutablePath"], "chromeExecutablePath")
    ?? config.chromeExecutablePath;
  const recordedFingerprint = optionalString(block["accountIdentityFingerprint"], "accountIdentityFingerprint");
  const accountFingerprint = recordedFingerprint ?? QWEN_CHAT_UNRECORDED_ACCOUNT_FINGERPRINT;
  const modelsCachePath = optionalString(block["modelsCachePath"], "modelsCachePath")
    ?? join(providerDir, "models.json");
  const configured = configuredModels(block["models"]);
  const hints = qwenChatModelList({ cacheFile: modelsCachePath });
  const models = configured === undefined
    ? hints
    : configured.map(entry => resolveModelEntry(entry, hints));
  const providerId = QWEN_CHAT_PROVIDER_ID;
  return {
    providerId,
    storageStatePath,
    chatStatePath: join(providerDir, "conversations.json"),
    modelsCachePath,
    chromeExecutablePath,
    models,
    accountFingerprint,
    accountIdentityRecorded: recordedFingerprint !== undefined,
    namespace: qwenChatExecutionNamespace({ providerId, accountFingerprint }),
  };
}

/**
 * Whether a **verified** session exists for this provider right now.
 *
 * The convention is the deployment's own: the storage state file plus the marker written beside it,
 * and the marker must say `version: 1`, `authenticated: true` and carry a `verifiedAt` string. Nothing
 * here reads a cookie or a token; a file that cannot be inspected is simply not a verified session.
 */
export function qwenChatSessionVerified(storageStatePath: string): boolean {
  if (!existsSync(storageStatePath)) return false;
  const markerPath = storageStateMarkerPath(storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      version?: unknown;
      authenticated?: unknown;
      verifiedAt?: unknown;
    };
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

/**
 * The provider/account binding a conversation belongs to.
 *
 * One provider/account pair is one binding (`webChatAccountBindingId`), so two accounts can never
 * share an affinity. No browser profile or context participates: this provider retains no browser
 * surface per conversation.
 */
export function qwenChatAccountBinding(provider: QwenChatProviderConfig): WebChatAccountBinding {
  return { providerId: provider.providerId, accountFingerprint: provider.accountFingerprint };
}

/** The provider-local descriptors the driver publishes for the models this deployment serves. */
export function qwenChatModelDescriptors(
  provider: QwenChatProviderConfig,
): readonly WebChatModelDescriptor[] {
  return provider.models.map(model => {
    const modes = qwenChatEntryModes(model);
    return {
      id: model.id,
      label: model.label,
      text: true as const,
      // No modes means the model offers no selectable mode at all (`abilities.thinking: 2`, the
      // recorded "Hidden" value). The field is omitted rather than published as an empty selection.
      ...(modes.length === 0 ? {} : { reasoningModes: modes }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    };
  });
}

/** One provider-qualified catalogue row, in the `/v1/models` shape this service already emits. */
export interface QwenChatCatalogueRow extends Record<string, unknown> {
  readonly slug: string;
  readonly display_name: string;
}

/** Human descriptions of the three modes, for the catalogue's reasoning levels. */
const MODE_DESCRIPTION: Record<QwenChatMode, string> = {
  Auto: "Qwen chooses whether to think for this turn",
  Thinking: "Always think before answering",
  Fast: "Answer without a thinking pass",
};

/**
 * The `/v1/models` rows for this provider.
 *
 * Provider-specific rows in the product's existing catalogue shape, deliberately not a new neutral
 * catalogue owner (`doc/provider-onboarding.md` §4.2). The row makes no claim this provider cannot
 * keep: **text-only**, no tools, and exactly the reasoning levels the model's measured abilities
 * support. A model with no selectable mode publishes `default_reasoning_level: null` and an empty
 * level list.
 */
export function qwenChatCatalogueRows(provider: QwenChatProviderConfig): readonly QwenChatCatalogueRow[] {
  return provider.models.map(model => {
    const modes = qwenChatEntryModes(model);
    const defaultMode = modes.length === 0 ? undefined : qwenChatDefaultMode(model) ?? modes[0];
    return {
      slug: `${provider.providerId}/${model.id}`,
      display_name: model.label,
      description: `Qwen Chat (${model.id}) through the WebChat text bridge`,
      input_modalities: ["text"],
      visibility: "list",
      supported_in_api: true,
      tool_mode: null,
      upgrade: null,
      default_reasoning_level: defaultMode ?? null,
      supported_reasoning_levels: modes.map(effort => ({ effort, description: MODE_DESCRIPTION[effort] })),
      context_window: model.contextWindow ?? null,
      max_context_window: model.contextWindow ?? null,
      effective_context_window_percent: null,
      auto_compact_token_limit: null,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
    };
  });
}

/**
 * Whether this deployment should advertise this provider's routes in `/v1/models`.
 *
 * Two facts make a route worth advertising, and neither invents one: the operator **configured** the
 * provider (a `webChat.providers["qwen-chat"]` block exists), or a **verified session** exists for it.
 * A ChatGPT-only deployment keeps the catalogue it has today, and a deployment that signed in sees
 * its Qwen Chat rows appear without editing a second file.
 */
export function qwenChatCatalogueVisible(config: AppConfig): boolean {
  return config.webChat?.providers?.[QWEN_CHAT_PROVIDER_ID] !== undefined
    || qwenChatSessionVerified(resolveQwenChatProviderConfig(config).storageStatePath);
}

/** Every public route this provider serves, as `providerId/modelId`. */
export function qwenChatPublicRoutes(provider: QwenChatProviderConfig): readonly string[] {
  return qwenChatCatalogueRows(provider).map(row => row.slug);
}
