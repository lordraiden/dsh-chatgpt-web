/**
 * The Qwen Code provider's own facts (issue #299, slice 2).
 *
 * This module answers the three questions a driver, an ingress and a catalogue row all need, from
 * **one** place:
 *
 * - where this provider's verified session lives (`providers/qwen-code/storage-state.json`, the
 *   layout `doc/provider-onboarding.md` §4.1 already owns);
 * - which account binding this deployment runs under (`doc/provider-onboarding.md` §4.3);
 * - which provider-local model ids it can serve, and the **public** catalogue rows derived from them
 *   (`qwen-code/<modelId>`, `doc/provider-onboarding.md` §4.2).
 *
 * ## The model catalogue: configured, because nothing was measured
 *
 * The recorded completion body carried `models: [<model>]`, so exactly one model id is *measured*:
 * {@link QWEN_CODE_DEFAULT_MODEL} (`qwen3-coder-plus`), the value the live app sent in the captured
 * `task/new` and `completions` bodies. No endpoint that lists the account's selectable models was
 * recorded, and this adapter will not invent one ("do not invent a provider protocol").
 *
 * The catalogue is therefore **configuration**, not discovery: `webChat.providers["qwen-code"].models`
 * lists the provider-local ids this deployment serves, and the measured default applies when the
 * block omits it. A model id maps to a catalogue row by provider-qualification, once, here:
 *
 * ```text
 * provider id  "qwen-code"                    (QWEN_CODE_PROVIDER_ID)
 * model id     "qwen3-coder-plus"             (provider-local, QWEN_CODE_DEFAULT_MODEL)
 * public route "qwen-code/qwen3-coder-plus"   (webChatPublicRoute)
 * ```
 *
 * A deployment that renames its model list must not be surprised by a row it never configured: an
 * empty list is a configuration error, never "serve everything".
 *
 * ## The account identity: recorded, never derived
 *
 * `doc/provider-onboarding.md` §4.3 records the trap: a *derived* fingerprint (from the storage
 * state file, or an `"unknown"` placeholder) can never match the account a signed-in browser
 * exposes, so reporting it as an authenticated account is a lie. ChatGPT was bitten twice by it.
 *
 * No stable provider-side account identifier was measured for Qwen Code: the recorded HAR has no
 * "who am I" endpoint, only chat endpoints. This provider therefore does **not** derive one. Its
 * account identity is whatever the deployment recorded (`accountIdentityFingerprint`), and when
 * nothing was recorded the driver says exactly that — it reports the session as authenticated but
 * publishes **no** fingerprint, instead of minting one from a file. The conversation binding still
 * needs a non-empty identity, so the *same* stable placeholder every unrecorded deployment uses is
 * applied there; it is published with `accountIdentityRecorded: false`, so a diagnostic can tell
 * "recorded account" from "deployment placeholder" without parsing it.
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
import { QWEN_CODE_DEFAULT_MODEL, QWEN_CODE_ORIGIN, QWEN_CODE_PROVIDER_ID } from "./provider";

/**
 * The identity an unrecorded deployment binds its conversations under.
 *
 * Stable by construction (a constant, not a hash of a file), so a restart cannot even change the
 * *placeholder*. It is published as `accountIdentityRecorded: false`; nothing treats it as an
 * account.
 */
export const QWEN_CODE_UNRECORDED_ACCOUNT_FINGERPRINT = "qwen-code-unrecorded-account";

/** One provider-local model this deployment serves. `id` is provider-local, never a public route. */
export interface QwenCodeModelEntry {
  readonly id: string;
  readonly label: string;
}

/** Everything the Qwen Code provider resolves from the deployment configuration. */
export interface QwenCodeProviderConfig {
  /** Catalogue/driver/auth id. One id, never a second spelling. */
  readonly providerId: string;
  /** Absolute path of the verified session this deployment reads. */
  readonly storageStatePath: string;
  /** Absolute path of this provider's durable conversation→chat state. */
  readonly chatStatePath: string;
  /** The configured Chrome executable (the sign-in and the session page both use it). */
  readonly chromeExecutablePath: string;
  /** Provider-local models this deployment serves. Never empty. */
  readonly models: readonly QwenCodeModelEntry[];
  /** The account fingerprint a conversation binds to (recorded, or the documented placeholder). */
  readonly accountFingerprint: string;
  /** Whether `accountFingerprint` is a **recorded** identity rather than the placeholder. */
  readonly accountIdentityRecorded: boolean;
  /** Deployment namespace the core affinity key is derived with; stable across restarts. */
  readonly namespace: string;
}

/** The generic refusal for a malformed provider block. */
function providerConfigError(field: string, detail: string): Error {
  return new Error(`Invalid webChat.providers["${QWEN_CODE_PROVIDER_ID}"].${field}: ${detail}`);
}

/** A non-empty string field, or `undefined` when it is absent. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw providerConfigError(field, "expected a non-empty string");
  }
  return value.trim();
}

/**
 * Read the configured model list.
 *
 * Accepts `["id", …]` and `[{ "id": …, "label": … }, …]`; both are provider-local ids. An empty or
 * non-array value is refused instead of being replaced by the default, because "serve nothing" and
 * "serve the default" must never be the same silent outcome.
 */
function configuredModels(value: unknown): readonly QwenCodeModelEntry[] | undefined {
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
      return { id, label: id };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw providerConfigError(`models[${index}]`, "expected a model id string or an object with an id");
    }
    const record = entry as Record<string, unknown>;
    const id = optionalString(record["id"], `models[${index}].id`);
    if (id === undefined) throw providerConfigError(`models[${index}].id`, "required");
    if (seen.has(id)) throw providerConfigError(`models[${index}].id`, `duplicate model id ${JSON.stringify(id)}`);
    seen.add(id);
    return { id, label: optionalString(record["label"], `models[${index}].label`) ?? id };
  });
}

/** The provider-scoped block this deployment configured, if any. */
function providerBlock(config: AppConfig): Record<string, unknown> {
  const scoped = config.webChat?.providers?.[QWEN_CODE_PROVIDER_ID];
  if (scoped === undefined) return {};
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    throw new Error(`Invalid webChat.providers["${QWEN_CODE_PROVIDER_ID}"]: expected an object`);
  }
  return scoped as Record<string, unknown>;
}

/**
 * The deployment namespace this provider's conversation keys are derived with.
 *
 * A hash of the facts that identify the deployment, never of a process-local value: the same
 * configuration therefore addresses the same conversations after a restart, which is what makes the
 * durable chat state meaningful. It excludes the account *provenance* flag (a fact about reporting,
 * not about identity) exactly like the ChatGPT namespace does.
 */
export function qwenCodeExecutionNamespace(
  facts: Pick<QwenCodeProviderConfig, "providerId" | "accountFingerprint">,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      providerId: facts.providerId,
      origin: QWEN_CODE_ORIGIN,
      accountFingerprint: facts.accountFingerprint,
    }))
    .digest("hex");
}

/**
 * Resolve this provider's facts from the deployment configuration.
 *
 * @param config - the deployment configuration.
 * @returns the provider facts the driver, the runtime and the catalogue rows all use.
 * @throws {Error} when a provider-scoped field is malformed (never a silent fallback).
 */
export function resolveQwenCodeProviderConfig(config: AppConfig): QwenCodeProviderConfig {
  const block = providerBlock(config);
  const configuredStorage = optionalString(block["storageStatePath"], "storageStatePath");
  // Deliberately **no** fall back to the deployment's ChatGPT credential path (the shared resolver's
  // legacy alias): only this provider's own directory, or a path the operator configured for it, may
  // satisfy this provider's session check. One provider's session can never authenticate another
  // (`tests/issue-249-provider-credentials.test.ts`).
  const storageStatePath = configuredStorage === undefined
    ? providerStorageStatePath(QWEN_CODE_PROVIDER_ID)
    : resolveProviderStorageStatePath(configuredStorage, QWEN_CODE_PROVIDER_ID);
  const chromeExecutablePath = optionalString(block["chromeExecutablePath"], "chromeExecutablePath")
    ?? config.chromeExecutablePath;
  const recordedFingerprint = optionalString(block["accountIdentityFingerprint"], "accountIdentityFingerprint");
  const models = configuredModels(block["models"]) ?? [{ id: QWEN_CODE_DEFAULT_MODEL, label: QWEN_CODE_DEFAULT_MODEL }];
  const accountFingerprint = recordedFingerprint ?? QWEN_CODE_UNRECORDED_ACCOUNT_FINGERPRINT;
  const providerId = QWEN_CODE_PROVIDER_ID;
  return {
    providerId,
    storageStatePath,
    chatStatePath: join(providerCredentialsDir(QWEN_CODE_PROVIDER_ID, getConfigDir()), "conversations.json"),
    chromeExecutablePath,
    models,
    accountFingerprint,
    accountIdentityRecorded: recordedFingerprint !== undefined,
    namespace: qwenCodeExecutionNamespace({ providerId, accountFingerprint }),
  };
}

/**
 * Whether a **verified** session exists for this provider right now.
 *
 * The convention is the deployment's own (`doc/provider-onboarding.md` §4.1): the storage state
 * file plus the marker written beside it, and the marker must say `version: 1`, `authenticated: true`
 * and carry a `verifiedAt` string. Nothing here reads a cookie or a token; a file that cannot be
 * inspected is simply not a verified session.
 */
export function qwenCodeSessionVerified(storageStatePath: string): boolean {
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
 * surface per conversation, so there is nothing a profile could distinguish.
 */
export function qwenCodeAccountBinding(provider: QwenCodeProviderConfig): WebChatAccountBinding {
  return { providerId: provider.providerId, accountFingerprint: provider.accountFingerprint };
}

/** The provider-local descriptors the driver publishes for the models this deployment serves. */
export function qwenCodeModelDescriptors(
  provider: QwenCodeProviderConfig,
): readonly WebChatModelDescriptor[] {
  return provider.models.map(model => ({ id: model.id, label: model.label, text: true as const }));
}

/** One provider-qualified catalogue row, in the `/v1/models` shape this service already emits. */
export interface QwenCodeCatalogueRow extends Record<string, unknown> {
  readonly slug: string;
  readonly display_name: string;
}

/**
 * The `/v1/models` rows for this provider.
 *
 * They are provider-specific rows in the product's existing catalogue shape (`slug`,
 * `display_name`, `description`, visibility flags), deliberately not a new neutral catalogue owner:
 * `doc/provider-onboarding.md` §4.2 states that extraction is not already done and does not prescribe
 * its shape. The row makes no claim this provider cannot keep: **text-only**, no tools, no image
 * input, and no reasoning levels (the recorded request carries none).
 */
export function qwenCodeCatalogueRows(provider: QwenCodeProviderConfig): readonly QwenCodeCatalogueRow[] {
  return provider.models.map(model => ({
    slug: `${provider.providerId}/${model.id}`,
    display_name: model.label,
    description: `Qwen Code (${model.id}) through the WebChat text bridge`,
    input_modalities: ["text"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    // The recorded request asks for `feature_config.thinking_enabled: false`; this provider advertises
    // no selectable reasoning level because none was measured.
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
 * Two facts make a route worth advertising, and neither invents one: the operator **configured** the
 * provider (a `webChat.providers["qwen-code"]` block exists), or a **verified session** exists for it.
 * A ChatGPT-only deployment therefore keeps the catalogue it has today, and a deployment that signed
 * in sees its Qwen rows appear without editing a second file.
 */
export function qwenCodeCatalogueVisible(config: AppConfig): boolean {
  return config.webChat?.providers?.[QWEN_CODE_PROVIDER_ID] !== undefined
    || qwenCodeSessionVerified(resolveQwenCodeProviderConfig(config).storageStatePath);
}

/** Every public route this provider serves, as `providerId/modelId`. */
export function qwenCodePublicRoutes(provider: QwenCodeProviderConfig): readonly string[] {
  return qwenCodeCatalogueRows(provider).map(row => row.slug);
}
