/**
 * The DeepSeek Web provider's own facts.
 *
 * This module answers, from **one** place, the questions the driver, the ingress, the catalogue and
 * `doctor` all need:
 *
 * - where this provider's capture lives (`providers/deepseek-web/storage-state.json`, the path the
 *   existing `auth import --provider deepseek-web` writes);
 * - which account binding a conversation belongs to;
 * - which provider-local **`model_type`** values this deployment serves;
 * - the **public** catalogue rows derived from them (`deepseek-web/<model_type>`).
 *
 * ## The model list is configuration, and only configuration
 *
 * Recon §2.5 is unambiguous: DeepSeek's model list is a **session-only remote setting**
 * (`model_configs`, scope `model`), fetched with `GET /api/v0/client/settings?did=…&scope=model`, and
 * the anonymous answer is `SETTINGS_NOT_FOUND`. So:
 *
 * - there is no public endpoint to seed from, and no refresh command (unlike `qwen-chat`);
 * - the bundle's deep-link prefill literal `["default","expert","vision"]` is **not** the catalogue
 *   (`DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES`), and is never used as a seed;
 * - with no `modelTypes` configured, this provider publishes **no rows** and says why
 *   ({@link deepSeekCatalogueNote}). It never falls back to a guess.
 *
 * ## The account identity: recorded, never derived
 *
 * `doc/provider-onboarding.md` §4.3 records the trap: a *derived* fingerprint can never match the
 * account a signed-in browser exposes, so reporting it as an authenticated account is a lie. No stable
 * account identifier was measured for `chat.deepseek.com`, so this provider publishes a fingerprint
 * only when the deployment recorded one. The conversation binding still needs a non-empty identity, so
 * the same stable placeholder every unrecorded deployment uses is applied there and marked as not
 * recorded.
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
import { DEEPSEEK_WEB_ORIGIN, DEEPSEEK_WEB_PROVIDER_ID, DEEPSEEK_WEB_ROUTE_ID } from "./provider";

/**
 * The identity an unrecorded deployment binds its conversations under.
 *
 * Stable by construction (a constant, not a hash of a file), so a restart cannot even change the
 * *placeholder*. It is published as `accountIdentityRecorded: false`; nothing treats it as an account.
 */
export const DEEPSEEK_WEB_UNRECORDED_ACCOUNT_FINGERPRINT = "deepseek-web-unrecorded-account";

/** One DeepSeek `model_type` this deployment serves, with the two recorded toggles. */
export interface DeepSeekModelType {
  /** The value that travels as `model_type` (recon §2.3). */
  readonly id: string;
  /** The catalogue label. */
  readonly label: string;
  /** `thinking_enabled` for a turn of this model. */
  readonly thinking: boolean;
  /** `search_enabled` for a turn of this model. */
  readonly search: boolean;
}

/** Everything the DeepSeek Web provider resolves from the deployment configuration. */
export interface DeepSeekProviderConfig {
  /** Catalogue/driver/provider id. One id, never a second spelling. */
  readonly providerId: string;
  /** Absolute path of the session this deployment reads. */
  readonly storageStatePath: string;
  /** Absolute path of this provider's durable conversation→session state. */
  readonly chatStatePath: string;
  /** The configured Chrome executable (the session page uses it). */
  readonly chromeExecutablePath: string;
  /** Provider-local `model_type` values this deployment serves. May be empty (and says why). */
  readonly modelTypes: readonly DeepSeekModelType[];
  /** The account fingerprint a conversation binds to (recorded, or the documented placeholder). */
  readonly accountFingerprint: string;
  /** Whether `accountFingerprint` is a **recorded** identity rather than the placeholder. */
  readonly accountIdentityRecorded: boolean;
  /** Deployment namespace the core affinity key is derived with; stable across restarts. */
  readonly namespace: string;
}

/** The generic refusal for a malformed provider block. */
function providerConfigError(field: string, detail: string): Error {
  return new Error(`Invalid webChat.providers["${DEEPSEEK_WEB_PROVIDER_ID}"].${field}: ${detail}`);
}

/** A non-empty string field, or `undefined` when it is absent. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw providerConfigError(field, "expected a non-empty string");
  }
  return value.trim();
}

/** A boolean field, or `undefined` when it is absent. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw providerConfigError(field, "expected a boolean");
  return value;
}

/**
 * Read the configured `model_type` list.
 *
 * Accepts `["default", …]` and `[{ "id": "default", "label": …, "thinking": …, "search": … }, …]`.
 *
 * An absent list means "serve no DeepSeek rows", which is a legal state and the honest one: the model
 * list is not public. An **empty array is the same state**, not an error, because there is no seed to
 * fall back to — "configured nothing" and "served nothing" cannot diverge here. A non-array, an empty
 * id or a duplicate is a configuration error.
 */
function configuredModelTypes(value: unknown): readonly DeepSeekModelType[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw providerConfigError("modelTypes", "expected an array of model_type values");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id.length === 0) throw providerConfigError(`modelTypes[${index}]`, "expected a non-empty model_type");
      if (seen.has(id)) throw providerConfigError(`modelTypes[${index}]`, `duplicate model_type ${JSON.stringify(id)}`);
      seen.add(id);
      return { id, label: id, thinking: false, search: false };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw providerConfigError(`modelTypes[${index}]`, "expected a model_type string or an object with an id");
    }
    const record = entry as Record<string, unknown>;
    const id = optionalString(record["id"], `modelTypes[${index}].id`);
    if (id === undefined) throw providerConfigError(`modelTypes[${index}].id`, "required");
    if (seen.has(id)) throw providerConfigError(`modelTypes[${index}].id`, `duplicate model_type ${JSON.stringify(id)}`);
    seen.add(id);
    return {
      id,
      label: optionalString(record["label"], `modelTypes[${index}].label`) ?? id,
      thinking: optionalBoolean(record["thinking"], `modelTypes[${index}].thinking`) ?? false,
      search: optionalBoolean(record["search"], `modelTypes[${index}].search`) ?? false,
    };
  });
}

/** The provider-scoped block this deployment configured, if any. */
function providerBlock(config: AppConfig): Record<string, unknown> {
  const scoped = config.webChat?.providers?.[DEEPSEEK_WEB_PROVIDER_ID];
  if (scoped === undefined) return {};
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    throw new Error(`Invalid webChat.providers["${DEEPSEEK_WEB_PROVIDER_ID}"]: expected an object`);
  }
  return scoped as Record<string, unknown>;
}

/**
 * The deployment namespace this provider's conversation keys are derived with.
 *
 * A hash of the facts that identify the deployment, never of a process-local value: the same
 * configuration therefore addresses the same conversations after a restart, which is what makes the
 * durable session state meaningful. It excludes the account *provenance* flag (a fact about reporting,
 * not about identity).
 */
export function deepSeekExecutionNamespace(
  facts: Pick<DeepSeekProviderConfig, "providerId" | "accountFingerprint">,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      providerId: facts.providerId,
      origin: DEEPSEEK_WEB_ORIGIN,
      accountFingerprint: facts.accountFingerprint,
    }))
    .digest("hex");
}

/**
 * Resolve this provider's facts from the deployment configuration.
 *
 * @param config - the deployment configuration.
 * @returns the provider facts the driver, the runtime, the catalogue rows and `doctor` all use.
 * @throws {Error} when a provider-scoped field is malformed (never a silent fallback).
 */
export function resolveDeepSeekProviderConfig(config: AppConfig): DeepSeekProviderConfig {
  const block = providerBlock(config);
  const configuredStorage = optionalString(block["storageStatePath"], "storageStatePath");
  // Deliberately **no** fall back to another provider's credential path: only this provider's own
  // directory, or a path the operator configured for it, may satisfy this provider's session check.
  const storageStatePath = configuredStorage === undefined
    ? providerStorageStatePath(DEEPSEEK_WEB_PROVIDER_ID)
    : resolveProviderStorageStatePath(configuredStorage, DEEPSEEK_WEB_PROVIDER_ID);
  const providerDir = providerCredentialsDir(DEEPSEEK_WEB_PROVIDER_ID, getConfigDir());
  const chromeExecutablePath = optionalString(block["chromeExecutablePath"], "chromeExecutablePath")
    ?? config.chromeExecutablePath;
  const recordedFingerprint = optionalString(block["accountIdentityFingerprint"], "accountIdentityFingerprint");
  const accountFingerprint = recordedFingerprint ?? DEEPSEEK_WEB_UNRECORDED_ACCOUNT_FINGERPRINT;
  const providerId = DEEPSEEK_WEB_PROVIDER_ID;
  return {
    providerId,
    storageStatePath,
    chatStatePath: join(providerDir, "conversations.json"),
    chromeExecutablePath,
    modelTypes: configuredModelTypes(block["modelTypes"]),
    accountFingerprint,
    accountIdentityRecorded: recordedFingerprint !== undefined,
    namespace: deepSeekExecutionNamespace({ providerId, accountFingerprint }),
  };
}

/**
 * Whether a **verified** session exists for this provider right now.
 *
 * The convention is the deployment's own: the storage state file plus the marker written beside it,
 * and the marker must say `version: 1`, `authenticated: true` and carry a `verifiedAt` string. A
 * capture stored by `auth import --provider deepseek-web` today is written **unverified** (no marker),
 * so it is correctly *not* a verified session. Nothing here reads a cookie or a token.
 */
export function deepSeekSessionVerified(storageStatePath: string): boolean {
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
 * Whether a capture file exists at all, verified or not.
 *
 * Used only to explain a state honestly (`doctor`, the catalogue note): a stored capture is not an
 * authenticated session, and this function never says it is.
 */
export function deepSeekCapturePresent(storageStatePath: string): boolean {
  return existsSync(storageStatePath);
}

/**
 * The provider/account binding a conversation belongs to.
 *
 * One provider/account pair is one binding (`webChatAccountBindingId`), so two accounts can never share
 * an affinity. No browser profile or context participates: this provider retains no browser surface
 * per conversation.
 */
export function deepSeekAccountBinding(provider: DeepSeekProviderConfig): WebChatAccountBinding {
  return { providerId: provider.providerId, accountFingerprint: provider.accountFingerprint };
}

/**
 * The provider-local descriptors the driver publishes for the models this deployment serves.
 *
 * No `reasoningModes`: the recon records a boolean `thinking_enabled` toggle, not a named mode menu,
 * so publishing mode labels would invent a capability. The toggle is deployment configuration per
 * model (see `doc/deepseek-web.md` §3).
 */
export function deepSeekModelDescriptors(
  provider: DeepSeekProviderConfig,
): readonly WebChatModelDescriptor[] {
  return provider.modelTypes.map(modelType => ({
    id: modelType.id,
    label: modelType.label,
    text: true as const,
  }));
}

/** One provider-qualified catalogue row, in the `/v1/models` shape this service already emits. */
export interface DeepSeekCatalogueRow extends Record<string, unknown> {
  readonly slug: string;
  readonly display_name: string;
}

/**
 * The `/v1/models` rows for this provider.
 *
 * Provider-specific rows in the product's existing catalogue shape, deliberately not a new neutral
 * catalogue owner (`doc/provider-onboarding.md` §4.2). The row makes no claim this provider cannot
 * keep: text-only, no tools, **no reasoning levels** (none were measured) and no context window (none
 * was measured). Everything unknown is `null`, never a plausible-looking number.
 */
export function deepSeekCatalogueRows(provider: DeepSeekProviderConfig): readonly DeepSeekCatalogueRow[] {
  return provider.modelTypes.map(modelType => ({
    slug: `${provider.providerId}/${modelType.id}`,
    display_name: modelType.label,
    description: `DeepSeek Web (${modelType.id}) through the WebChat text bridge`,
    input_modalities: ["text"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    context_window: null,
    max_context_window: null,
    effective_context_window_percent: null,
    auto_compact_token_limit: null,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  }));
}

/**
 * Whether this deployment should advertise this provider's routes in `/v1/models`.
 *
 * Exactly one fact makes a route worth advertising: the operator configured at least one
 * `model_type`. A verified session is **not** enough, because the model list is server-side and
 * session-only (recon §2.5) — a session without a configured model type still names no model this
 * deployment could honestly serve.
 */
export function deepSeekCatalogueVisible(config: AppConfig): boolean {
  return resolveDeepSeekProviderConfig(config).modelTypes.length > 0;
}

/**
 * Why this deployment serves (or does not serve) DeepSeek rows. One sentence, no secret.
 *
 * The composition logs it once when a provider block exists, and `doctor` uses it, so "no rows" is
 * never a silent absence.
 */
export function deepSeekCatalogueNote(config: AppConfig): string {
  const provider = resolveDeepSeekProviderConfig(config);
  if (provider.modelTypes.length > 0) {
    return `${provider.modelTypes.length} DeepSeek model_type value(s) configured: `
      + provider.modelTypes.map(modelType => modelType.id).join(", ");
  }
  const capture = deepSeekCapturePresent(provider.storageStatePath)
    ? "a capture is stored for this provider, but it is not a verified session and it names no model"
    : "no capture is stored for this provider";
  return 'no DeepSeek model_type is configured in webChat.providers["deepseek-web"].modelTypes, so no '
    + `DeepSeek route is published; ${capture}. DeepSeek's model list is a session-only remote setting `
    + "(recon §2.5), so it cannot be discovered without a signed-in capture, and the bundle's deep-link "
    + 'prefill literal ("default", "expert", "vision") is not a catalogue.';
}

/** Every public route this provider serves, as `providerId/modelType`. */
export function deepSeekPublicRoutes(provider: DeepSeekProviderConfig): readonly string[] {
  return deepSeekCatalogueRows(provider).map(row => row.slug);
}

/** The catalogue route id this provider owns. */
export const DEEPSEEK_WEB_CATALOGUE_ROUTE_ID = DEEPSEEK_WEB_ROUTE_ID;
