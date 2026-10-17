import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import {
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  resolveChatGptWebContextLimits,
} from "./chatgpt-web-models";
import type { CodexProviderConfig } from "./types";
import { accountIdentityFromStorageState } from "./chatgpt-web-authority";
import { VERSION } from "./version";

export type RuntimeMode = "browser-only" | "full";
export type BrowserHostMode = "managed-chrome" | "launcher";
export type BrowserInteractionMode = "automatic" | "manual";
export type SubagentProtocol = "compatibility-v1" | "native";

/**
 * The provider route this deployment implements.
 *
 * It is also the key of the provider-scoped WebChat block (`webChat.providers[...]`) that replaces the
 * flat ChatGPT block as a whole (issue #193), which is why the configuration module validates that
 * block here: the flat and the scoped description of the same facts have one owner.
 */
export const CHATGPT_WEB_ROUTE_ID = "chatgpt-web";

/**
 * ChatGPT caches a connector's public MCP contract by connector identity. The direct turn-token
 * contract therefore has a new identity instead of mutating the retired connector in place.
 */
export const CHATGPT_CONNECTOR_NAME = "Codex Native2";
export const DEV_CHATGPT_CONNECTOR_NAME = `${CHATGPT_CONNECTOR_NAME} DEV`;
export const ZERO_RISK_CHATGPT_CONNECTOR_NAME = "Codex Zero Risk";
export const LEGACY_CHATGPT_CONNECTOR_NAMES = ["Codex Native"] as const;

export function isLegacyChatGptConnectorName(value: string): boolean {
  return (LEGACY_CHATGPT_CONNECTOR_NAMES as readonly string[]).includes(value);
}

export function legacyChatGptConnectorMigrationMessage(legacyName: string): string {
  return `Legacy ChatGPT connector ${JSON.stringify(legacyName)} was found, but this release requires`
    + ` a newly created connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}. Create`
    + ` ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the same tunnel with Authentication set to None;`
    + ` do not rename or refresh ${JSON.stringify(legacyName)}.`;
}

export function resolveSetupConnectorName(existingName?: string, requestedName?: string): string {
  if (requestedName !== undefined) {
    const requested = requestedName.trim();
    if (!requested || requested.length > 80) throw new Error("Connector name is invalid");
    if (requested === ZERO_RISK_CHATGPT_CONNECTOR_NAME) {
      throw new Error(
        `Automatic connector name ${JSON.stringify(requested)} is reserved for Zero Risk; choose a different name`,
      );
    }
    if (isLegacyChatGptConnectorName(requested)) {
      throw new Error(legacyChatGptConnectorMigrationMessage(requested));
    }
    return requested;
  }
  const existing = existingName?.trim();
  if (!existing
    || existing === ZERO_RISK_CHATGPT_CONNECTOR_NAME
    || isLegacyChatGptConnectorName(existing)) return CHATGPT_CONNECTOR_NAME;
  return existing;
}

export function resolveDevSetupConnectorName(existingName?: string, requestedName?: string): string {
  if (requestedName !== undefined) return resolveSetupConnectorName(existingName, requestedName);
  const existing = existingName?.trim();
  if (!existing
    || existing === CHATGPT_CONNECTOR_NAME
    || existing === ZERO_RISK_CHATGPT_CONNECTOR_NAME
    || isLegacyChatGptConnectorName(existing)) {
    return DEV_CHATGPT_CONNECTOR_NAME;
  }
  return resolveSetupConnectorName(existing);
}

export interface InteractionConnectorIdentities {
  appName: string;
  automaticAppName: string;
  manualAppName: typeof ZERO_RISK_CHATGPT_CONNECTOR_NAME;
}

export function resolveInteractionConnectorIdentities(
  existing: Pick<AppConfig, "appName" | "automaticAppName" | "browserInteractionMode"> | undefined,
  interactionMode: BrowserInteractionMode,
  requestedAutomaticName?: string,
): InteractionConnectorIdentities {
  const previousAutomaticName = existing?.automaticAppName
    || (existing?.browserInteractionMode !== "manual" ? existing?.appName : undefined);
  const automaticAppName = resolveSetupConnectorName(previousAutomaticName, requestedAutomaticName);
  return {
    appName: interactionMode === "manual" ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : automaticAppName,
    automaticAppName,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
  };
}

export interface TunnelConfig {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileDir: string;
  profileName: string;
  alias: string;
}

export { type ChatGptWebTuning } from "./types";
import type { ChatGptWebTuning } from "./types";

export const CHATGPT_WEB_TUNING_DEFAULTS: Omit<Required<ChatGptWebTuning>, "turnTimeoutMs"> = {
  composerCharLimit: 120_000,
  responseDomGraceMs: 60_000,
  responseDomGraceMaxMs: 240_000,
  responseDomGracePerCharMs: 2.5,
  sendEnableGraceMs: 5_000,
  // ChatGPT Free/Think routes and connector waits routinely keep generating past five minutes
  // while the visible Stop button proves the turn is still alive, so the stuck-generator budget
  // is generous by default and user-tunable. It measures one continuous visible generation
  // window, never the total turn time.
  generationRunningStallMs: 900_000,
};

/** Tuning with every default applied; turnTimeoutMs stays optional (absent = no absolute deadline). */
export interface ResolvedChatGptWebTuning {
  composerCharLimit: number;
  responseDomGraceMs: number;
  responseDomGraceMaxMs: number;
  responseDomGracePerCharMs: number;
  sendEnableGraceMs: number;
  generationRunningStallMs: number;
  turnTimeoutMs?: number;
}

/** Merge a partial tuning over the defaults, keeping only finite positive values. */
export function resolveChatGptWebTuning(tuning?: ChatGptWebTuning): ResolvedChatGptWebTuning {
  const resolved: ResolvedChatGptWebTuning = { ...CHATGPT_WEB_TUNING_DEFAULTS };
  if (!tuning) return resolved;
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  resolved.composerCharLimit = pick(tuning.composerCharLimit, resolved.composerCharLimit);
  resolved.responseDomGraceMs = pick(tuning.responseDomGraceMs, resolved.responseDomGraceMs);
  resolved.responseDomGraceMaxMs = pick(tuning.responseDomGraceMaxMs, resolved.responseDomGraceMaxMs);
  resolved.responseDomGracePerCharMs = pick(tuning.responseDomGracePerCharMs, resolved.responseDomGracePerCharMs);
  resolved.sendEnableGraceMs = pick(tuning.sendEnableGraceMs, resolved.sendEnableGraceMs);
  resolved.generationRunningStallMs = pick(tuning.generationRunningStallMs, resolved.generationRunningStallMs);
  if (typeof tuning.turnTimeoutMs === "number" && Number.isFinite(tuning.turnTimeoutMs) && tuning.turnTimeoutMs > 0) {
    resolved.turnTimeoutMs = tuning.turnTimeoutMs;
  }
  return resolved;
}

/** Validate a raw tuning object (config file or control API) and return a normalized copy. */
export function validateChatGptWebTuning(value: unknown, path = "config"): ChatGptWebTuning {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid tuning in ${path}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) throw new Error(`Invalid tuning in ${path}`);
  const tuning: ChatGptWebTuning = {};
  for (const key of keys) {
    if (key !== "turnTimeoutMs" && !Object.keys(CHATGPT_WEB_TUNING_DEFAULTS).includes(key)) {
      throw new Error(`Unknown tuning key ${key} in ${path}`);
    }
    const num = record[key];
    if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
      throw new Error(`Invalid tuning.${key} in ${path}`);
    }
    (tuning as Record<string, number>)[key] = num;
  }
  if (tuning.responseDomGraceMaxMs !== undefined
    && (tuning.responseDomGraceMs ?? CHATGPT_WEB_TUNING_DEFAULTS.responseDomGraceMs) > tuning.responseDomGraceMaxMs) {
    throw new Error(`Invalid tuning in ${path}: responseDomGraceMs must not exceed responseDomGraceMaxMs`);
  }
  return tuning;
}

/** Boolean provider facts, and the string provider facts that name a location or identity. */
const CHATGPT_WEB_PROVIDER_BOOLEAN_FACTS = [
  "solAvailable", "proAvailable", "zeroRiskProEnabled", "experimentalBiggerContext",
  "headed", "localToolsEnabled", "autoApproveToolCalls",
] as const;
const CHATGPT_WEB_PROVIDER_STRING_FACTS = [
  "appName", "storageStatePath", "chromeExecutablePath", "brokerSocketPath",
  "browserHostDescriptorPath", "accountIdentityFingerprint",
  "threadEnvironmentStatePath", "lunaCheckpointStatePath",
] as const;

function capabilityStateFromBooleans(record: Record<string, unknown>): {
  solAvailable: "supported" | "unsupported" | "unknown";
  proAvailable: "supported" | "unsupported" | "unknown";
} {
  const stateFor = (value: unknown): "supported" | "unsupported" | "unknown" =>
    value === undefined ? "unknown" : value === true ? "supported" : "unsupported";
  return { solAvailable: stateFor(record.solAvailable), proAvailable: stateFor(record.proAvailable) };
}

/**
 * Validate the ChatGPT Web provider facts a configuration block carries (issue #193).
 *
 * The same facts are described twice: by the historical flat ChatGPT block (the AppConfig fields
 * `providerConfig` projects) and by a provider-scoped `webChat.providers["chatgpt-web"]` block, which
 * overlays the projected facts at resolution time. The loader first checks scoped field shapes, then
 * validates the effective merge; the runtime resolver uses the same merge owner. This function is the
 * single copy of their rules, so the two descriptions cannot drift:
 *
 * - the scalar shape of every fact, including the two enumerations and the transport pair
 *   (a launcher browser host requires an absolute descriptor);
 * - the capability invariants: the tri-state shape, an `unknown` state contradicting a boolean claim,
 *   Pro requiring Sol;
 * - the capability ↔ browser-mode invariants (Zero Risk does not support Bigger Context);
 * - the tuning block, through `validateChatGptWebTuning`.
 *
 * Fields the caller omits are not validated: a flat configuration is one source of the facts and a
 * scoped block another, and neither is required to restate every fact. `path` names where the block
 * lives, so a refusal names the exact location whichever block produced it.
 */
export function validateChatGptWebProviderFacts(
  value: unknown,
  path = "config",
  options: { crossField?: boolean } = {},
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ChatGPT Web provider configuration in ${path}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of CHATGPT_WEB_PROVIDER_BOOLEAN_FACTS) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`Invalid ${key} in ${path}`);
    }
  }
  for (const key of CHATGPT_WEB_PROVIDER_STRING_FACTS) {
    const candidate = record[key];
    if (candidate !== undefined && (typeof candidate !== "string" || !candidate.trim())) {
      throw new Error(`Invalid ${key} in ${path}`);
    }
  }
  if (record.browserInteractionMode !== undefined
    && record.browserInteractionMode !== "automatic"
    && record.browserInteractionMode !== "manual") {
    throw new Error(`Invalid browserInteractionMode in ${path}`);
  }
  if (record.browserHost !== undefined
    && record.browserHost !== "managed-chrome"
    && record.browserHost !== "launcher") {
    throw new Error(`Invalid browserHost in ${path}`);
  }
  if (options.crossField !== false && record.browserHost === "launcher"
    && (typeof record.browserHostDescriptorPath !== "string" || !record.browserHostDescriptorPath.trim())) {
    throw new Error(`Launcher browser host requires browserHostDescriptorPath in ${path}`);
  }
  if (options.crossField !== false && record.browserHost === "launcher"
    && typeof record.browserHostDescriptorPath === "string"
    && !isAbsolute(expandUserPath(record.browserHostDescriptorPath))) {
    throw new Error(`Launcher browserHostDescriptorPath must be absolute in ${path}`);
  }
  if (record.stallTimeoutSec !== undefined
    && (typeof record.stallTimeoutSec !== "number"
      || !Number.isFinite(record.stallTimeoutSec)
      || record.stallTimeoutSec <= 0)) {
    throw new Error(`Invalid stallTimeoutSec in ${path}`);
  }
  if (record.tuning !== undefined) validateChatGptWebTuning(record.tuning, path);

  // An explicit tri-state, when present, must be a complete and valid pair; otherwise it is derived
  // from the boolean claims (the compatibility fields) exactly as the projection does.
  const explicit = record.capabilityState as
    | { solAvailable?: unknown; proAvailable?: unknown }
    | undefined;
  let explicitState: { solAvailable: "supported" | "unsupported" | "unknown"; proAvailable: "supported" | "unsupported" | "unknown" } | undefined;
  if (explicit !== undefined) {
    const valid = explicit !== null && typeof explicit === "object" && !Array.isArray(explicit)
      && (explicit.solAvailable === "supported" || explicit.solAvailable === "unsupported" || explicit.solAvailable === "unknown")
      && (explicit.proAvailable === "supported" || explicit.proAvailable === "unsupported" || explicit.proAvailable === "unknown");
    if (!valid) throw new Error(`Invalid capabilityState in ${path}`);
    explicitState = {
      solAvailable: explicit.solAvailable as "supported" | "unsupported" | "unknown",
      proAvailable: explicit.proAvailable as "supported" | "unsupported" | "unknown",
    };
  }
  if (options.crossField === false) return;
  if (explicitState?.solAvailable === "unknown" && record.solAvailable !== undefined) {
    throw new Error(`Invalid Sol capability state in ${path}`);
  }
  if (explicitState?.proAvailable === "unknown" && record.proAvailable !== undefined) {
    throw new Error(`Invalid Pro capability state in ${path}`);
  }
  for (const capability of ["solAvailable", "proAvailable"] as const) {
    const reported = explicitState?.[capability];
    const claimed = record[capability];
    if (reported === undefined || reported === "unknown" || claimed === undefined) continue;
    const implied = reported === "supported";
    if (claimed !== implied) {
      throw new Error(`Invalid ${capability} capability state in ${path}: ${reported} conflicts with ${String(claimed)}`);
    }
  }
  const capabilityState = explicitState ?? capabilityStateFromBooleans(record);
  if (capabilityState.proAvailable === "supported" && capabilityState.solAvailable !== "supported") {
    throw new Error(`Invalid ChatGPT account capabilityState in ${path}: Pro requires supported Sol`);
  }
  const browserInteractionMode = record.browserInteractionMode ?? "automatic";
  if (browserInteractionMode === "manual" && record.experimentalBiggerContext === true) {
    throw new Error(`Zero Risk does not support Bigger Context in ${path}`);
  }
  if (record.proAvailable === true && record.solAvailable !== true) {
    throw new Error(`Invalid ChatGPT account capabilities in ${path}: Pro requires Sol`);
  }
}

/** Merge one scoped provider overlay and validate only its effective facts. */
export function mergeChatGptWebProviderFacts(
  base: Record<string, unknown>,
  overlay: unknown,
  path: string,
): Record<string, unknown> {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  validateChatGptWebProviderFacts(overlay, path, { crossField: false });
  const declared = Object.fromEntries(
    Object.entries(overlay as Record<string, unknown>)
      // `accountIdentityRecorded` describes the *effective* fingerprint rather than a fact of its own,
      // so it is never taken from either block: it is recomputed below, from the fingerprint the
      // overlay states. Without this, an authored value could mislabel a genuinely recorded identity.
      .filter(([key, value]) => value !== undefined && key !== "accountIdentityRecorded"),
  );
  const declaredMode = declared.browserInteractionMode;
  if (declaredMode !== undefined && declaredMode !== base.browserInteractionMode) {
    throw new Error(`browserInteractionMode conflicts with deployment mode in ${path}`);
  }
  const merged = { ...base, ...declared };
  // A fingerprint a scoped block states itself is a *recorded* identity by definition, so the
  // derived-fallback marker the flat block carried cannot survive its own replacement. A scoped block
  // that states no fingerprint keeps the flat block's provenance, which `providerConfig` decided.
  if (declared.accountIdentityFingerprint !== undefined) merged.accountIdentityRecorded = true;
  const state = declared.capabilityState as
    | { solAvailable?: "supported" | "unsupported" | "unknown"; proAvailable?: "supported" | "unsupported" | "unknown" }
    | undefined;
  if (state) {
    for (const capability of ["solAvailable", "proAvailable"] as const) {
      const claimed = declared[capability];
      const reported = state[capability];
      if (reported === undefined) continue;
      if (reported === "unknown") {
        if (claimed === undefined) delete merged[capability];
      } else {
        const implied = reported === "supported";
        if (claimed === undefined) merged[capability] = implied;
        else if (claimed !== implied) {
          throw new Error(`Invalid capability combination in ${path}: ${capability} contradicts capabilityState.${capability}`);
        }
      }
    }
  }
  // parseConfig normalizes absent flat legacy booleans to false after validating the persisted
  // unknown state. When any overlay is present, remove only that inherited synthetic assertion;
  // an explicitly scoped boolean with unknown remains invalid in the shared validator.
  const effectiveState = merged.capabilityState as
    | { solAvailable?: string; proAvailable?: string }
    | undefined;
  for (const capability of ["solAvailable", "proAvailable"] as const) {
    if (effectiveState?.[capability] === "unknown" && declared[capability] === undefined) {
      delete merged[capability];
    }
  }
  validateChatGptWebProviderFacts(merged, path);
  return merged;
}

export interface AppConfig {
  version: 3;
  purpose?: "dev-harness";
  releaseVersion: string;
  mode: RuntimeMode;
  subagentProtocol: SubagentProtocol;
  /**
   * Bind address. Loopback is the default and the only value that needs no API key; a non-loopback
   * value is refused at startup unless a key is configured (issue #247), which is why this is not a
   * literal type.
   */
  host: string;
  port: number;
  /**
   * Legacy serialized field kept only so older v3 config files remain readable.
   * New configurations do not write it; providerConfig resolves route-specific capacity.
   */
  contextWindow?: number;
  appName: string;
  automaticAppName: string;
  manualAppName: typeof ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  browserHost: BrowserHostMode;
  browserInteractionMode: BrowserInteractionMode;
  browserHostDescriptorPath?: string;
  /**
   * How the interactive sign-in browser (`/v1/control/auth/*`) is launched (issue #276).
   *
   * `headless` — the default when the field is absent — runs Chromium with `--headless=new`, the same
   * shape the managed ChatGPT browser already uses, and is the supported path on a headless host
   * (it is what the sign-in was verified against a real account with). `display` launches a real
   * window instead, for a provider or anti-bot flow that rejects headless: it needs a display the
   * **operator supplies** (an X server/socket reachable by the service, or their own headed
   * environment). The container starts no display server, and the former noVNC `Dockerfile.login`
   * sign-in image is retired (issue #276 slice 3b). It changes nothing about the managed turn
   * browser.
   */
  authBrowserMode?: "headless" | "display";
  chromeExecutablePath: string;
  storageStatePath: string;
  /** Stable authenticated ChatGPT account fingerprint derived from /api/auth/session user.id. */
  accountIdentityFingerprint?: string;
  brokerSocketPath: string;
  headed: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  capabilityState?: {
    solAvailable: "supported" | "unsupported" | "unknown";
    proAvailable: "supported" | "unsupported" | "unknown";
  };
  experimentalBiggerContext: boolean;
  /** Explicitly install the additional Pro-sized model row while Zero Risk is active. */
  zeroRiskProEnabled: boolean;
  /** Optional adapter-silence budget for the Responses watchdog. */
  stallTimeoutSec?: number;
  /** Optional browser transport tuning; defaults apply per field when absent. */
  tuning?: ChatGptWebTuning;
  autoApproveToolCalls: boolean;
  controlToken: string;
  runtimeCommand: string[];
  acknowledgedUnofficialAt?: string;
  /**
   * WebChat host surface (issue #193): provider-scoped provider configuration and the durable
   * continuity location.
   *
   * The shape is inline on purpose: the configuration module must not import the host boundary (that
   * would be a cycle) and the host boundary accepts this structural shape, so the two can never
   * disagree about what a serialized configuration means. Absent means exactly today's behavior: the
   * historical flat ChatGPT configuration is the effective one.
   */
  webChat?: {
    /** Provider-scoped configuration, keyed by provider route id. */
    providers?: Record<string, unknown>;
    /** Durable continuity location; omit to keep continuity in memory. */
    conversationStorePath?: string;
  };
  tunnel?: TunnelConfig;
  automaticTunnel?: TunnelConfig;
  manualTunnel?: TunnelConfig;
}

export function tunnelConfigForInteractionMode(
  config: Pick<AppConfig, "browserInteractionMode" | "tunnel" | "automaticTunnel" | "manualTunnel">,
  mode: BrowserInteractionMode = config.browserInteractionMode,
): TunnelConfig | undefined {
  const configured = mode === "manual" ? config.manualTunnel : config.automaticTunnel;
  if (configured) return configured;
  if (config.automaticTunnel || config.manualTunnel) return undefined;
  // The single tunnel field predates Zero Risk. Released 4.x configurations therefore always
  // belong to Automatic mode; Zero Risk is populated only by an explicit setup or migration.
  return mode === "automatic" ? config.tunnel : undefined;
}

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const configured = (process.env.DSH_CHATGPT_FREE_HOME || process.env.DSH_CHATGPT_WEB_HOME)?.trim();
  if (configured) return resolve(expandUserPath(configured));
  const dshStorage = join(homedir(), ".dsh", "storages", "chatgpt-web");
  const legacyDshStorage = join(homedir(), ".dsh", "storages", "chatgpt-free");
  const legacyStorage = join(homedir(), ".codex-chatgpt-web");
  if (!existsSync(dshStorage)) {
    if (existsSync(legacyDshStorage)) return resolve(legacyDshStorage);
    if (existsSync(legacyStorage)) return resolve(legacyStorage);
  }
  return resolve(dshStorage);
}

/** An API key shorter than this cannot authenticate anything meaningfully; refuse it (issue #247). */
export const MINIMUM_API_KEY_LENGTH = 16;

/** Environment variable that may carry the public API key. */
export const API_KEY_ENV = "DSH_CHATGPT_WEB_API_KEY";

/** True only for bind values that cannot be reached from another host. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost" || value === "localhost.localdomain";
}

/**
 * The public API key (issue #247), or `undefined` when none is configured.
 *
 * Resolution order: `DSH_CHATGPT_WEB_API_KEY`, then `<data dir>/api-key`. It is deliberately not part
 * of the validated configuration: a key is a secret, not configuration, so it never enters
 * `config.json`, a session projection, a log line or `/healthz`. A key that is too short is refused
 * instead of silently accepted, because it would only give the illusion of protection.
 */
export function resolveApiKey(home = getConfigDir()): string | undefined {
  const key = process.env[API_KEY_ENV]?.trim() || readApiKeyFile(home);
  if (!key) return undefined;
  if (key.length < MINIMUM_API_KEY_LENGTH) {
    throw new Error(
      `${API_KEY_ENV} (or <data dir>/api-key) must be at least ${MINIMUM_API_KEY_LENGTH} characters; `
      + "refusing to start with a key that cannot authenticate anything",
    );
  }
  return key;
}

function readApiKeyFile(home: string): string | undefined {
  try {
    return readFileSync(join(home, "api-key"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The marker file that records a *verified* session beside its storage state.
 *
 * One owner for the convention (issue #249): `browser-login.ts` delegates here, and the credential
 * resolver below needs it without importing the provider-local login module.
 */
export function storageStateMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

/**
 * The only provider with a credential layout today. Mirrors `CHATGPT_WEB_DRIVER_ID`; kept as a plain
 * string here to avoid a config -> provider import cycle.
 */
const CREDENTIAL_PROVIDER_ID = "chatgpt-web";

/** The directory holding one provider's credentials inside the data home (issue #249). */
export function providerCredentialsDir(providerId: string = CREDENTIAL_PROVIDER_ID, home = getConfigDir()): string {
  return join(home, "providers", providerId);
}

/** Where a NEW session for this provider is written, by `login`, `setup` and `auth import`. */
export function providerStorageStatePath(providerId: string = CREDENTIAL_PROVIDER_ID, home = getConfigDir()): string {
  return join(providerCredentialsDir(providerId, home), "storage-state.json");
}

/**
 * The path the runtime READS for a provider (issue #249).
 *
 * The provider-scoped session wins when it exists — that is where new sessions are written — and the
 * configured (by default legacy) path stays the alias, so an existing installation keeps working with
 * no migration and no rewritten `config.json`.
 */
export function resolveProviderStorageStatePath(
  configuredPath?: string,
  providerId: string = CREDENTIAL_PROVIDER_ID,
  home = getConfigDir(),
): string {
  const scoped = providerStorageStatePath(providerId, home);
  if (existsSync(scoped) || existsSync(storageStateMarkerPath(scoped))) return scoped;
  const configured = (configuredPath ?? "").trim();
  return resolve(expandUserPath(configured || join(home, "browser", "storage-state.json")));
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function isWindowsPipeEndpoint(value: string): boolean {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}

export function defaultBrokerEndpoint(home = getConfigDir(), platform = process.platform): string {
  if (platform !== "win32") return join(home, "runtime", "turn-broker.sock");
  const identity = createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 20);
  return `\\\\.\\pipe\\dsh-chatgpt-web-${identity}`;
}

export function resolveBrokerEndpoint(value: string): string {
  const expanded = expandUserPath(value);
  return isWindowsPipeEndpoint(expanded) ? expanded : resolve(expanded);
}

const atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;

function renameAtomicFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      Atomics.wait(atomicWaitCell, 0, 0, delay);
    }
  }
}

export function atomicWriteFile(path: string, data: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameAtomicFile(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the installer. */ }
}

export function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

export function preserveUtf8Bom(text: string, original: string): string {
  return original.startsWith("\uFEFF") ? `\uFEFF${stripUtf8Bom(text)}` : stripUtf8Bom(text);
}

export function defaultConfig(mode: RuntimeMode = "browser-only"): AppConfig {
  const home = getConfigDir();
  return {
    version: 3,
    releaseVersion: VERSION,
    mode,
    subagentProtocol: "compatibility-v1",
    host: "127.0.0.1",
    port: 17841,
    appName: CHATGPT_CONNECTOR_NAME,
    automaticAppName: CHATGPT_CONNECTOR_NAME,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    browserHost: "managed-chrome",
    browserInteractionMode: "automatic",
    authBrowserMode: "headless",
    chromeExecutablePath: defaultChromeExecutable(),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
    headed: false,
    solAvailable: false,
    proAvailable: false,
    capabilityState: {
      solAvailable: "unsupported",
      proAvailable: "unsupported",
    },
    experimentalBiggerContext: false,
    zeroRiskProEnabled: false,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
    runtimeCommand: currentRuntimeCommand(),
  };
}

export function currentRuntimeCommand(): string[] {
  const executableName = basename(process.execPath).toLowerCase();
  const bunExecutable = executableName === "bun" || executableName === "bun.exe"
    ? installedBunExecutable()
    : undefined;
  return runtimeCommandForProcess({
    launcher: process.env.DSH_CHATGPT_FREE_LAUNCHER,
    executable: process.execPath,
    entry: typeof Bun !== "undefined" ? Bun.main : process.argv[1],
    bunExecutable,
  });
}

export function installedBunExecutable({
  platform = process.platform,
  pathValue = process.env.PATH || process.env.Path || "",
  candidates = [],
}: {
  platform?: NodeJS.Platform;
  pathValue?: string;
  candidates?: Array<string | null | undefined>;
} = {}): string {
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathCandidates = pathValue
    .split(pathDelimiter)
    .map(part => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map(part => join(part, executableName));
  const discovered = [
    process.env.DSH_CHATGPT_FREE_BUN,
    process.env.DSH_CHATGPT_WEB_BUN,
    ...candidates,
    ...pathCandidates,
    typeof Bun !== "undefined" ? Bun.which("bun") : undefined,
    process.execPath,
  ];
  for (const candidate of discovered) {
    if (!candidate?.trim()) continue;
    const executable = resolve(candidate.trim());
    try {
      assertDurableRuntimeCommand([executable]);
      return executable;
    } catch {
      // Candidate discovery is exhaustive; the final error remains explicit.
    }
  }
  throw new Error("A durable installed Bun executable was not found outside temporary directories");
}

export function runtimeCommandForProcess({
  launcher,
  executable,
  entry,
  bunExecutable,
}: {
  launcher?: string;
  executable: string;
  entry?: string;
  bunExecutable?: string | null;
}): string[] {
  launcher = launcher?.trim();
  if (launcher) {
    const command = [resolve(launcher)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  executable = resolve(executable);
  const executableName = basename(executable).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    if (!entry || entry.endsWith("/[eval]") || entry === "[eval]") {
      throw new Error("Cannot install a service from an evaluated Bun script");
    }
    const command = [resolve(bunExecutable?.trim() || executable), resolve(entry)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  const command = [executable];
  assertDurableRuntimeCommand(command);
  return command;
}

function inside(path: string, root: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

export function assertDurableRuntimeCommand(command: string[]): void {
  if (command.length === 0) throw new Error("Runtime command is empty");
  const executable = command[0]!;
  if (!isAbsolute(executable)) throw new Error(`Runtime executable must be absolute: ${executable}`);
  const ephemeralRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  for (const part of command) {
    if (!isAbsolute(part)) continue;
    if (ephemeralRoots.some(root => inside(part, root))) {
      throw new Error(`Runtime command must not reference an ephemeral path: ${part}`);
    }
  }
  if (!existsSync(executable)) throw new Error(`Runtime executable does not exist: ${executable}`);
}

export function defaultChromeExecutable(
  platform = process.platform,
  programFiles = process.env.PROGRAMFILES,
): string {
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (platform === "win32") {
    return win32.join(programFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  }
  return "/usr/bin/google-chrome";
}

function comparableReleaseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return undefined;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

/**
 * Synchronize the persisted config with the installed release.
 *
 * Config files intentionally survive package upgrades, so releaseVersion is runtime metadata,
 * not user-owned configuration. Older persisted versions are promoted automatically. A config
 * from a newer release is refused rather than silently downgraded.
 */
export function migrateReleaseVersion(config: AppConfig, installedVersion = VERSION): AppConfig {
  if (config.releaseVersion === installedVersion) return config;

  const stored = comparableReleaseVersion(config.releaseVersion);
  const installed = comparableReleaseVersion(installedVersion);
  if (stored && installed) {
    const newerConfig = stored[0] > installed[0]
      || (stored[0] === installed[0] && stored[1] > installed[1])
      || (stored[0] === installed[0] && stored[1] === installed[1] && stored[2] > installed[2]);
    if (newerConfig) {
      throw new Error(
        `Configuration releaseVersion ${config.releaseVersion} is newer than installed release ${installedVersion}; refusing automatic downgrade`,
      );
    }
  }

  return {
    ...config,
    releaseVersion: installedVersion,
  };
}

function loadAndMigrateConfig(path: string, raw: unknown): AppConfig {
  const parsed = parseConfig(raw, path);
  const migrated = migrateReleaseVersion(parsed);
  if (migrated !== parsed) saveConfig(migrated);
  return migrated;
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run dsh-chatgpt-web setup first.`);
  const config = loadAndMigrateConfig(path, JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))));
  // Resolve the per-provider credential layout for READS only (issue #249). Setup keeps the configured
  // value, so a save never rewrites the persisted path.
  return { ...config, storageStatePath: resolveProviderStorageStatePath(config.storageStatePath) };
}

export function loadConfigForSetup(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run dsh-chatgpt-web setup first.`);
  const raw = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))) as Record<string, unknown>;
  if (raw.version === 1 && raw.mode === "pro-only") {
    raw.version = 2;
    raw.mode = "browser-only";
  }
  if (raw.version === 2) {
    raw.version = 3;
    raw.browserHost = "managed-chrome";
  }
  const interactionMode = raw.browserInteractionMode ?? "automatic";
  const automaticName = raw.automaticAppName
    ?? (interactionMode === "automatic" ? raw.appName : CHATGPT_CONNECTOR_NAME);
  if (automaticName === ZERO_RISK_CHATGPT_CONNECTOR_NAME) {
    raw.automaticAppName = CHATGPT_CONNECTOR_NAME;
    if (interactionMode === "automatic") raw.appName = CHATGPT_CONNECTOR_NAME;
  }
  return loadAndMigrateConfig(path, raw);
}

function parseConfig(value: unknown, path: string): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid configuration object in ${path}`);
  const parsed = value as Partial<AppConfig>;
  if (parsed.version !== 3) throw new Error(`Unsupported configuration version in ${path}; rerun setup to migrate it`);
  if (parsed.purpose !== undefined && parsed.purpose !== "dev-harness") {
    throw new Error(`Invalid configuration purpose in ${path}`);
  }
  if (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion.trim()) throw new Error(`Missing releaseVersion in ${path}`);
  if (parsed.mode !== "browser-only" && parsed.mode !== "full") throw new Error(`Invalid runtime mode in ${path}`);
  const subagentProtocol = parsed.subagentProtocol ?? "compatibility-v1";
  if (subagentProtocol !== "compatibility-v1" && subagentProtocol !== "native") {
    throw new Error(`Invalid subagentProtocol in ${path}`);
  }
  // The bind is validated for *shape* here only. Whether a non-loopback bind is allowed depends on
  // the API key, and that fail-closed decision is taken when the server starts (issue #247), so a
  // configuration file alone can never expose the bridge.
  if (typeof parsed.host !== "string" || !/^[A-Za-z0-9.:_-]{1,253}$/.test(parsed.host)) {
    throw new Error(`Invalid host in ${path}`);
  }
  if (parsed.browserHost !== "managed-chrome" && parsed.browserHost !== "launcher") {
    throw new Error(`Invalid browserHost in ${path}`);
  }
  const browserInteractionMode = parsed.browserInteractionMode ?? "automatic";
  if (browserInteractionMode !== "automatic" && browserInteractionMode !== "manual") {
    throw new Error(`Invalid browserInteractionMode in ${path}`);
  }
  // The interactive sign-in browser mode (issue #276) is additive and optional: absent means the
  // documented `headless` default, and a present value must be one of the two enumerated modes.
  if (parsed.authBrowserMode !== undefined
    && parsed.authBrowserMode !== "headless"
    && parsed.authBrowserMode !== "display") {
    throw new Error(`Invalid authBrowserMode in ${path}`);
  }
  if (browserInteractionMode === "manual" && parsed.mode !== "full") {
    throw new Error(`Zero Risk requires full mode in ${path}`);
  }
  if (browserInteractionMode === "manual" && parsed.browserHost !== "launcher") {
    throw new Error(`Zero Risk requires the launcher browser host in ${path}`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65_535) throw new Error(`Invalid port in ${path}`);
  if (parsed.contextWindow !== undefined
    && (!Number.isSafeInteger(parsed.contextWindow) || parsed.contextWindow <= 0)) {
    throw new Error(`Invalid legacy contextWindow in ${path}`);
  }
  if (typeof parsed.headed !== "boolean") throw new Error(`Invalid headed in ${path}`);
  if (typeof parsed.autoApproveToolCalls !== "boolean") {
    throw new Error(`Invalid autoApproveToolCalls in ${path}`);
  }
  const requiredStrings: Array<keyof AppConfig> = [
    "appName", "chromeExecutablePath", "storageStatePath", "brokerSocketPath", "controlToken",
  ];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error(`Missing ${key} in ${path}`);
  }
  if (parsed.appName!.length > 80) throw new Error(`appName is too long in ${path}`);
  const automaticAppName = parsed.automaticAppName
    ?? (browserInteractionMode === "automatic" ? parsed.appName : CHATGPT_CONNECTOR_NAME);
  const manualAppName = parsed.manualAppName ?? ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  if (typeof automaticAppName !== "string" || !automaticAppName.trim() || automaticAppName.length > 80) {
    throw new Error(`Invalid automaticAppName in ${path}`);
  }
  if (manualAppName !== ZERO_RISK_CHATGPT_CONNECTOR_NAME) {
    throw new Error(`manualAppName must be ${JSON.stringify(ZERO_RISK_CHATGPT_CONNECTOR_NAME)} in ${path}`);
  }
  if (automaticAppName === manualAppName) {
    throw new Error(`Automatic and Zero Risk connector names must differ in ${path}; rerun setup`);
  }
  const expectedAppName = browserInteractionMode === "manual" ? manualAppName : automaticAppName;
  if (parsed.appName !== expectedAppName) {
    throw new Error(`Active appName does not match browserInteractionMode in ${path}; rerun setup`);
  }
  if (parsed.browserHost === "launcher"
    && (typeof parsed.browserHostDescriptorPath !== "string" || !parsed.browserHostDescriptorPath.trim())) {
    throw new Error(`Launcher browser host requires browserHostDescriptorPath in ${path}`);
  }
  if (parsed.browserHost === "launcher"
    && !isAbsolute(expandUserPath(parsed.browserHostDescriptorPath!))) {
    throw new Error(`Launcher browserHostDescriptorPath must be absolute in ${path}`);
  }
  const brokerEndpoint = expandUserPath(parsed.brokerSocketPath!);
  if (process.platform === "win32") {
    if (!isWindowsPipeEndpoint(brokerEndpoint)) {
      throw new Error(`Windows brokerSocketPath must be a named pipe in ${path}`);
    }
  } else if (!isAbsolute(brokerEndpoint) || isWindowsPipeEndpoint(brokerEndpoint)) {
    throw new Error(`brokerSocketPath must be an absolute Unix socket path in ${path}`);
  }
  if (!/^[A-Za-z0-9_-]{40,}$/.test(parsed.controlToken!)) throw new Error(`Invalid controlToken in ${path}`);
  const validateTunnel = (tunnel: TunnelConfig | undefined, label: string): void => {
    if (!tunnel || typeof tunnel !== "object") throw new Error(`${label} is missing in ${path}`);
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"] as const) {
      if (typeof tunnel[key] !== "string" || !tunnel[key].trim()) {
        throw new Error(`Missing ${label}.${key} in ${path}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)) {
      throw new Error(`Invalid ${label}.tunnelId in ${path}`);
    }
    for (const key of ["profileName", "alias"] as const) {
      if (!/^[A-Za-z0-9._-]+$/.test(tunnel[key])) {
        throw new Error(`Invalid ${label}.${key} in ${path}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"] as const) {
      if (!isAbsolute(expandUserPath(tunnel[key]))) {
        throw new Error(`${label}.${key} must be absolute in ${path}`);
      }
    }
  };
  if (parsed.mode === "full") {
    validateTunnel(parsed.tunnel, "tunnel");
    if (parsed.automaticTunnel !== undefined) validateTunnel(parsed.automaticTunnel, "automaticTunnel");
    if (parsed.manualTunnel !== undefined) validateTunnel(parsed.manualTunnel, "manualTunnel");
    if (parsed.automaticTunnel && parsed.manualTunnel
      && parsed.automaticTunnel.tunnelId === parsed.manualTunnel.tunnelId) {
      throw new Error(`Automatic and Zero Risk must use different Tunnel IDs in ${path}`);
    }
    const activeTunnel = browserInteractionMode === "manual" ? parsed.manualTunnel : parsed.automaticTunnel;
    if ((parsed.automaticTunnel || parsed.manualTunnel) && !activeTunnel) {
      throw new Error(`Active browser interaction mode has no tunnel configuration in ${path}`);
    }
    if (activeTunnel && JSON.stringify(activeTunnel) !== JSON.stringify(parsed.tunnel)) {
      throw new Error(`Active tunnel does not match browserInteractionMode in ${path}; rerun MCP setup`);
    }
  }
  if (!Array.isArray(parsed.runtimeCommand) || parsed.runtimeCommand.length === 0
    || parsed.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error(`Invalid runtimeCommand in ${path}`);
  }
  assertDurableRuntimeCommand(parsed.runtimeCommand as string[]);
  // The capability and browser-mode facts of the flat ChatGPT block are validated by the single owner
  // of those rules (issue #193), which the provider-scoped block uses too, so the two cannot drift.
  validateChatGptWebProviderFacts({
    browserInteractionMode,
    solAvailable: parsed.solAvailable,
    proAvailable: parsed.proAvailable,
    capabilityState: parsed.capabilityState,
    zeroRiskProEnabled: parsed.zeroRiskProEnabled,
    experimentalBiggerContext: parsed.experimentalBiggerContext,
  }, path);
  if (parsed.stallTimeoutSec !== undefined
    && (!Number.isFinite(parsed.stallTimeoutSec) || parsed.stallTimeoutSec <= 0)) {
    throw new Error(`Invalid stallTimeoutSec in ${path}`);
  }
  if (parsed.tuning !== undefined) {
    parsed.tuning = validateChatGptWebTuning(parsed.tuning, path);
  }
  if (parsed.webChat !== undefined) {
    const webChat = parsed.webChat as unknown;
    if (!webChat || typeof webChat !== "object" || Array.isArray(webChat)) {
      throw new Error(`Invalid webChat in ${path}`);
    }
    const record = webChat as Record<string, unknown>;
    if (record.providers !== undefined) {
      if (!record.providers || typeof record.providers !== "object" || Array.isArray(record.providers)) {
        throw new Error(`Invalid webChat.providers in ${path}`);
      }
      for (const [providerId, provider] of Object.entries(record.providers)) {
        if (!providerId.trim() || !provider || typeof provider !== "object" || Array.isArray(provider)) {
          throw new Error(`Invalid webChat.providers.${providerId || "(empty)"} in ${path}`);
        }
        // The provider-scoped block overlays provider facts. An explicit browser mode is accepted
        // only when it agrees with the normalized deployment mode.
        if (providerId === CHATGPT_WEB_ROUTE_ID) {
          const scopedPath = `${path} (webChat.providers["${CHATGPT_WEB_ROUTE_ID}"])`;
          const scoped = provider as Record<string, unknown>;
          validateChatGptWebProviderFacts(provider, scopedPath, { crossField: false });
          if (scoped.browserInteractionMode !== undefined
            && scoped.browserInteractionMode !== browserInteractionMode) {
            throw new Error(`browserInteractionMode conflicts with deployment mode in ${scopedPath}`);
          }
        }
      }
    }
    if (record.conversationStorePath !== undefined
      && (typeof record.conversationStorePath !== "string" || !record.conversationStorePath.trim())) {
      throw new Error(`Invalid webChat.conversationStorePath in ${path}`);
    }
  }
  const solAvailable = parsed.solAvailable === true;
  const proAvailable = parsed.proAvailable === true;
  const capabilityState = parsed.capabilityState ?? {
    solAvailable: parsed.solAvailable === undefined ? "unknown" : solAvailable ? "supported" : "unsupported",
    proAvailable: parsed.proAvailable === undefined ? "unknown" : proAvailable ? "supported" : "unsupported",
  };
  const experimentalBiggerContext = parsed.experimentalBiggerContext === true;
  const zeroRiskProEnabled = parsed.zeroRiskProEnabled === true;
  const result = {
    ...parsed,
    appName: expectedAppName,
    automaticAppName,
    manualAppName,
    browserInteractionMode,
    subagentProtocol,
    solAvailable,
    proAvailable,
    capabilityState,
    experimentalBiggerContext,
    zeroRiskProEnabled,
  } as AppConfig;
  const scopedProvider = result.webChat?.providers?.[CHATGPT_WEB_ROUTE_ID];
  if (scopedProvider && typeof scopedProvider === "object" && !Array.isArray(scopedProvider)) {
    mergeChatGptWebProviderFacts(
      providerConfig(result).chatgptWeb as unknown as Record<string, unknown>,
      scopedProvider,
      `${path} (webChat.providers["${CHATGPT_WEB_ROUTE_ID}"])`,
    );
  }
  return result;
}

export function saveConfig(config: AppConfig): void {
  const path = getConfigPath();
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWriteFile(path, preserveUtf8Bom(`${JSON.stringify(config, null, 2)}\n`, original));
}

/**
 * Persist the authenticated ChatGPT account fingerprint (issue #276).
 *
 * `setup` and `login` mutate the config they already hold and save it themselves; the interactive
 * sign-in controller holds only deployment facts, so it read-modify-writes through this module's own
 * helpers instead of writing the JSON itself. Reads go through `loadConfigForSetup`, which preserves
 * the *configured* `storageStatePath` — `loadConfig` resolves that path for READS only, so saving its
 * result would rewrite a persisted field. `saveConfig` keeps the BOM and writes atomically, and no
 * other field is touched.
 *
 * @param fingerprint - the non-secret account fingerprint derived from the signed-in page.
 * @returns whether the stored value changed.
 */
export function persistAccountIdentityFingerprint(fingerprint: string): boolean {
  const normalized = fingerprint.trim();
  if (!normalized) {
    // Never write a placeholder: an empty fingerprint would silently become a *different* binding.
    throw new Error("A ChatGPT account identity fingerprint must be a non-empty string");
  }
  const config = loadConfigForSetup();
  if (config.accountIdentityFingerprint === normalized) return false;
  config.accountIdentityFingerprint = normalized;
  saveConfig(config);
  return true;
}

function accountIdentityFingerprint(config: AppConfig): string {
  try {
    if (!existsSync(config.storageStatePath)) return "unknown";
    return accountIdentityFromStorageState(
      JSON.parse(readFileSync(config.storageStatePath, "utf8")),
    ).fingerprint;
  } catch {
    return "unknown";
  }
}

export function providerConfig(config: AppConfig): CodexProviderConfig {
  const manual = config.browserInteractionMode === "manual";
  const model = manual
    ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
    : config.solAvailable ? "gpt-5.6-sol" : "gpt-5.6-luna";
  const models = manual
    ? [
      CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
      ...(config.zeroRiskProEnabled ? [CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL] : []),
    ]
    : [model];
  const efforts = manual
    ? ["low"]
    : config.solAvailable
    ? ["low", "medium", "high", "xhigh", ...(config.proAvailable ? ["max"] : [])]
    : ["low", "medium"];
  const defaultEffort = manual ? "low" : config.solAvailable ? "high" : "low";
  const resolvedContextWindow = resolveChatGptWebContextLimits(
    model as Parameters<typeof resolveChatGptWebContextLimits>[0],
    defaultEffort as Parameters<typeof resolveChatGptWebContextLimits>[1],
    {
      solAvailable: manual ? false : config.solAvailable,
      proAvailable: manual ? false : config.proAvailable,
      experimentalBiggerContext: manual ? false : config.experimentalBiggerContext,
      browserInteractionMode: config.browserInteractionMode,
      zeroRiskProEnabled: config.zeroRiskProEnabled,
    },
  ).contextWindow;
  return {
    adapter: CHATGPT_WEB_ROUTE_ID,
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: model,
    contextWindow: resolvedContextWindow,
    modelInputModalities: Object.fromEntries(models.map(model => [model, manual ? ["text"] : ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(models.map(modelId => [modelId, efforts])),
    modelDefaultReasoningEfforts: Object.fromEntries(
      models.map(modelId => [modelId, manual ? "low" : config.solAvailable ? "high" : "low"]),
    ),
    noReasoningModels: [],
    chatgptWeb: {
      appName: manual ? config.manualAppName : config.automaticAppName,
      browserInteractionMode: config.browserInteractionMode,
      browserHost: config.browserHost,
      browserHostDescriptorPath: config.browserHostDescriptorPath,
      storageStatePath: config.storageStatePath,
      accountIdentityFingerprint: config.accountIdentityFingerprint
        ?? accountIdentityFingerprint(config),
      // The provenance of the fingerprint is decided here, at the ONE place the fallback is
      // substituted: a recorded identity is one a sign-in persisted (or config authored), and the
      // fallback over the storage-state file is not an account identity. The lease's binding check
      // reads this to name the real cause instead of a mismatch between two unrelated hashes.
      accountIdentityRecorded: config.accountIdentityFingerprint !== undefined,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      lunaCheckpointStatePath: join(getConfigDir(), "runtime", "luna-checkpoints.json"),
      headed: config.headed,
      localToolsEnabled: config.mode === "full",
      solAvailable: manual ? false : config.solAvailable,
      proAvailable: manual ? false : config.proAvailable,
      capabilityState: manual ? {
        solAvailable: "unsupported",
        proAvailable: "unsupported",
      } : config.capabilityState,
      zeroRiskProEnabled: manual ? config.zeroRiskProEnabled : false,
      experimentalBiggerContext: manual ? false : config.experimentalBiggerContext,
      ...(config.stallTimeoutSec !== undefined ? { stallTimeoutSec: config.stallTimeoutSec } : {}),
      ...(config.tuning !== undefined ? { tuning: config.tuning } : {}),
      autoApproveToolCalls: manual ? false : config.autoApproveToolCalls,
    },
  };
}
