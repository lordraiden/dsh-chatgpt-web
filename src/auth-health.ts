/**
 * The session-health surface: does each provider's **stored** session still work, right now?
 *
 * ## The defect it answers
 *
 * A stored Qwen Chat capture worked an hour after it was imported and then stopped: its 15-minute
 * access token had expired, and the browser context that renewed it (rotating the stored
 * `refresh_token` cookie) was gone. The operator only discovered this by **sending a message** and
 * reading `AUTH_REQUIRED` twenty seconds later. A row that says "expired" before the send is the fix.
 *
 * ## One policy, not a second probe
 *
 * This module owns no predicate, no cookie rule and no refusal vocabulary of its own. Each provider
 * is described by the very {@link AuthImportProvider} `auth import` uses, so a health check runs the
 * same `accept` → `authenticate` steps the import pipeline runs ({@link proveProviderCapture}),
 * reports the same `AuthImportRefusal` codes, and stores a renewal through the same single writer.
 * A provider with no authenticated predicate (`verification: "unverified"`, today DeepSeek Web) is
 * reported `unverifiable` — never probed, never dressed up as expired.
 *
 * ## Cheap, bounded, cached
 *
 * A check is one bounded browser round trip per provider that has a capture — the cost of the import
 * probe, paid at most once per {@link DEFAULT_AUTH_HEALTH_CACHE_TTL_MS} and shared by concurrent
 * callers (single-flight per provider). Providers are checked sequentially so the endpoint never
 * starts three browsers at once, and each check is cut at {@link DEFAULT_AUTH_HEALTH_PROBE_TIMEOUT_MS}
 * so a wedged provider cannot pin the request. A timeout is reported as `unknown`: it is not proof
 * that the session is dead, and saying "expired" would send the operator to a needless sign-in.
 *
 * ## A check that renews is written back
 *
 * A provider whose predicate drives its own page (Qwen Chat) can renew the session while proving it.
 * When the page's proved state differs from the state it was opened with, the check persists the
 * proved state through `provider.store` — the pipeline's own writer, marker included. A check that
 * failed writes nothing, and a check that proved the same state writes nothing.
 *
 * ## Never a secret
 *
 * Rows carry a provider id, a label, a state, two timestamps, a machine code and one refusal
 * sentence. No cookie, token, storage entry or filesystem path ever appears in an answer.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  AUTH_IMPORT_PROVIDER_IDS,
  authImportProvider,
  proveProviderCapture,
  validateImportedStorageState,
  type AuthImportProvider,
  type ImportedStorageState,
} from "./auth-import";
import { isAuthImportRefusal } from "./auth-import-errors";
import { readVerificationMarker } from "./browser-login";
import { CHATGPT_WEB_AUTH_PROVIDER_ID } from "./adapters/chatgpt-web/auth-controller";
import { QWEN_CHAT_PROVIDER_ID, resolveQwenChatProviderConfig } from "./adapters/qwen-chat";
import { QWEN_CODE_PROVIDER_ID, resolveQwenCodeProviderConfig } from "./adapters/qwen-code";
import { DEEPSEEK_WEB_PROVIDER_ID, resolveDeepSeekProviderConfig } from "./adapters/deepseek-web";
import type { AppConfig } from "./config";
import { nonSecretDiagnosticText } from "./lib/safe-diagnostics";

/** How one stored session stands right now. */
export type ProviderSessionHealthState =
  | "verified"
  | "expired"
  | "absent"
  | "unverifiable"
  | "unknown";

/** One provider's answer. Credential-free by construction. */
export interface ProviderSessionHealth {
  readonly providerId: string;
  readonly label: string;
  readonly state: ProviderSessionHealthState;
  /** Whether a capture file exists at all (a present capture can still be `expired`). */
  readonly capturePresent: boolean;
  /**
   * The last time this session was proved: this check's time when it verified now, otherwise the
   * persisted marker's `verifiedAt` (the last import/sign-in that proved it), or `null`.
   */
  readonly verifiedAt: string | null;
  /** When the verdict above was produced (a cached verdict keeps its original instant). */
  readonly checkedAt: string;
  /** The import pipeline's machine code when the check refused (`import_expired`, …), else `null`. */
  readonly code: string | null;
  /** One sentence naming the operator's next action. Never a credential. */
  readonly reason: string | null;
}

/** One provider this surface reports: where its capture lives and the descriptor that proves it. */
export interface AuthHealthProvider {
  /** The resolved capture path (per-provider layout, or the deployment's configured path). */
  readonly storageStatePath: string;
  /** The same descriptor `auth import` uses for this provider id. */
  readonly importProvider: AuthImportProvider;
}

/** The endpoint's answer. */
export interface AuthHealthSnapshot {
  readonly checkedAt: string;
  readonly cache: { readonly ttlMs: number };
  readonly providers: readonly ProviderSessionHealth[];
}

/** Options for {@link createAuthHealthSurface}. */
export interface AuthHealthSurfaceOptions {
  readonly providers: readonly AuthHealthProvider[];
  /** Clock seam; tests inject one. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** How long one verdict is reused. Default {@link DEFAULT_AUTH_HEALTH_CACHE_TTL_MS}. */
  readonly cacheTtlMs?: number;
  /** The hard bound of one provider's check. Default {@link DEFAULT_AUTH_HEALTH_PROBE_TIMEOUT_MS}. */
  readonly probeTimeoutMs?: number;
}

/** The surface. In-process, provider-selected, and deliberately not a scheduler. */
export interface AuthHealthSurface {
  /** Check every configured provider (from cache when it is warm) and report the rows. */
  snapshot(): Promise<AuthHealthSnapshot>;
  /**
   * Record a verification another owner just performed, so the next page load does not have to
   * launch a browser to learn what the import already proved. Used by `POST /v1/control/auth/import`.
   */
  noteVerified(providerId: string, verifiedAt: string | null): void;
}

/** One minute: long enough that opening the page twice is one check, short enough to stay useful. */
export const DEFAULT_AUTH_HEALTH_CACHE_TTL_MS = 60_000;
/** One check's hard bound; the provider predicates have their own, shorter, internal bounds. */
export const DEFAULT_AUTH_HEALTH_PROBE_TIMEOUT_MS = 90_000;

/** The operator's next action, in the one vocabulary the rest of the sign-in surface uses. */
function signInInstruction(label: string): string {
  return `Sign in at /v1/control/auth/ (choose "${label}"), then check again.`;
}

/** A capture as it sits on disk. */
type StoredCapture =
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown }
  | { readonly present: true; readonly unreadable: true };

/**
 * Read the stored capture without ever quoting it.
 *
 * A `JSON.parse` failure quotes a fragment of its input — exactly where a cookie value lives — so the
 * parser's own message is deliberately not included; the row says the file is not readable JSON.
 */
function readStoredCapture(storageStatePath: string): StoredCapture {
  if (!existsSync(storageStatePath)) return { present: false };
  try {
    return { present: true, value: JSON.parse(readFileSync(storageStatePath, "utf8")) as unknown };
  } catch {
    return { present: true, unreadable: true };
  }
}

/** A stable rendering of a state, so "unchanged" means the same material and not the same order. */
function canonicalState(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry === null || typeof entry !== "object") return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map(key => [key, canonicalize(record[key])]),
    );
  };
  return JSON.stringify(canonicalize(value));
}

/** One bounded promise: the work is not cancelled, but the caller stops waiting for it. */
async function bounded<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The providers this deployment reports, resolved by the same owners the rest of the service uses.
 *
 * ChatGPT Web keeps the deployment's configured `storageStatePath` (already resolved for reads by
 * `loadConfig`); each other provider is asked for its own facts, so a configured per-provider path is
 * honoured rather than guessed.
 */
export function defaultAuthHealthProviders(config: AppConfig): readonly AuthHealthProvider[] {
  const providers: AuthHealthProvider[] = [];
  for (const providerId of AUTH_IMPORT_PROVIDER_IDS) {
    const importProvider = authImportProvider(providerId, config);
    const storageStatePath = providerId === CHATGPT_WEB_AUTH_PROVIDER_ID
      ? config.storageStatePath
      : providerId === QWEN_CODE_PROVIDER_ID
        ? resolveQwenCodeProviderConfig(config).storageStatePath
        : providerId === QWEN_CHAT_PROVIDER_ID
          ? resolveQwenChatProviderConfig(config).storageStatePath
          : providerId === DEEPSEEK_WEB_PROVIDER_ID
            ? resolveDeepSeekProviderConfig(config).storageStatePath
            : undefined;
    if (storageStatePath === undefined) continue;
    providers.push({ storageStatePath, importProvider });
  }
  return providers;
}

/**
 * Create the session-health surface.
 *
 * @param options - the provider list and the timing seams.
 * @returns the surface.
 */
export function createAuthHealthSurface(options: AuthHealthSurfaceOptions): AuthHealthSurface {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_AUTH_HEALTH_CACHE_TTL_MS;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError("A session-health surface requires a non-negative cache TTL");
  }
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_AUTH_HEALTH_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1) {
    throw new TypeError("A session-health surface requires a positive probe timeout");
  }
  const providers = [...options.providers];
  const byId = new Map<string, AuthHealthProvider>();
  for (const provider of providers) {
    const id = provider.importProvider.id;
    if (byId.has(id)) throw new TypeError(`Provider ${id} is registered twice for session health`);
    byId.set(id, provider);
  }
  /** A warm verdict, keyed by provider id. */
  const cache = new Map<string, { readonly at: number; readonly value: ProviderSessionHealth }>();
  /** A check that is already running, so concurrent page loads share one browser. */
  const inflight = new Map<string, Promise<ProviderSessionHealth>>();

  const row = (
    provider: AuthHealthProvider,
    state: ProviderSessionHealthState,
    facts: {
      readonly capturePresent: boolean;
      readonly verifiedAt: string | null;
      readonly code: string | null;
      readonly reason: string | null;
    },
  ): ProviderSessionHealth => ({
    providerId: provider.importProvider.id,
    label: provider.importProvider.label,
    state,
    capturePresent: facts.capturePresent,
    verifiedAt: facts.verifiedAt,
    checkedAt: new Date(now()).toISOString(),
    code: facts.code,
    reason: facts.reason,
  });

  /**
   * Persist a renewal the proof produced, through the pipeline's own writer.
   *
   * The state the check opened with is the state that was persisted by the last import; a proved
   * state that differs is a renewal the provider's own page performed, and keeping it is what makes
   * the next check (and the next turn) able to renew at all. A failed write is reported and never
   * turns a verified session into a failed check.
   */
  const keepRenewal = (
    provider: AuthHealthProvider,
    before: ImportedStorageState,
    after: unknown,
  ): void => {
    if (canonicalState(before) === canonicalState(after)) return;
    try {
      provider.importProvider.store({
        storageState: after as ImportedStorageState,
        detail: "the session page renewed the capture during the health check",
        verified: true,
      });
      console.info(
        `[chatgpt-web] session_health_renewed ${JSON.stringify({ provider: provider.importProvider.id })}`,
      );
    } catch (error) {
      console.warn(
        `[chatgpt-web] session_health_renewal_not_stored ${JSON.stringify({
          provider: provider.importProvider.id,
          detail: nonSecretDiagnosticText(error),
        })}`,
      );
    }
  };

  const check = async (provider: AuthHealthProvider): Promise<ProviderSessionHealth> => {
    const label = provider.importProvider.label;
    const marker = readVerificationMarker(provider.storageStatePath);
    const lastVerifiedAt = marker?.verifiedAt ?? null;
    const capture = readStoredCapture(provider.storageStatePath);

    if (!capture.present) {
      return row(provider, "absent", {
        capturePresent: false,
        verifiedAt: lastVerifiedAt,
        code: null,
        reason: `No ${label} session is stored on this deployment. ${signInInstruction(label)}`,
      });
    }

    // A provider with no authenticated predicate is never probed: a capture is not proof.
    if (provider.importProvider.verification === "unverified") {
      return row(provider, "unverifiable", {
        capturePresent: true,
        verifiedAt: lastVerifiedAt,
        code: null,
        reason: provider.importProvider.unverifiedMessage
          ?? `${label} stores captures, but it has no authenticated predicate, so no check can verify one.`,
      });
    }

    if ("unreadable" in capture) {
      return row(provider, "expired", {
        capturePresent: true,
        verifiedAt: lastVerifiedAt,
        code: null,
        reason: `The stored ${label} capture is not readable JSON, so it cannot be checked or used. `
          + signInInstruction(label),
      });
    }

    let parsed: ImportedStorageState;
    try {
      parsed = validateImportedStorageState(capture.value, "the stored capture");
    } catch (error) {
      return row(provider, "expired", {
        capturePresent: true,
        verifiedAt: lastVerifiedAt,
        code: isAuthImportRefusal(error) ? error.code : null,
        reason: isAuthImportRefusal(error) ? error.message : `The stored ${label} capture is not usable. ${signInInstruction(label)}`,
      });
    }

    try {
      const authentication = await bounded(
        proveProviderCapture(provider.importProvider, parsed, now),
        probeTimeoutMs,
        `the ${label} session check did not finish within ${Math.round(probeTimeoutMs / 1_000)}s`,
      );
      keepRenewal(provider, parsed, authentication.storageState);
      return row(provider, "verified", {
        capturePresent: true,
        verifiedAt: new Date(now()).toISOString(),
        code: null,
        reason: null,
      });
    } catch (error) {
      if (!isAuthImportRefusal(error)) {
        // A bound or a transport fault: the session was not judged, so it is not called expired.
        return row(provider, "unknown", {
          capturePresent: true,
          verifiedAt: lastVerifiedAt,
          code: null,
          reason: `The ${label} session could not be checked: ${nonSecretDiagnosticText(error)}. `
            + "The stored session was not judged. Check again, or sign in again at /v1/control/auth/ "
            + `(choose "${label}").`,
        });
      }
      // The provider's own sentence when it has one: the import wrapper says "so nothing was
      // written", which is true for an import and false for a check that was never writing.
      const inner = error.cause === undefined ? undefined : nonSecretDiagnosticText(error.cause);
      return row(provider, "expired", {
        capturePresent: true,
        verifiedAt: lastVerifiedAt,
        code: error.code,
        reason: inner === undefined || inner.length === 0 ? error.message : inner,
      });
    }
  };

  const checked = async (provider: AuthHealthProvider): Promise<ProviderSessionHealth> => {
    const id = provider.importProvider.id;
    const warm = cache.get(id);
    if (warm !== undefined && now() - warm.at < cacheTtlMs) return warm.value;
    const running = inflight.get(id);
    if (running !== undefined) return await running;
    const run = check(provider).then(value => {
      cache.set(id, { at: now(), value });
      return value;
    });
    inflight.set(id, run);
    try {
      return await run;
    } finally {
      if (inflight.get(id) === run) inflight.delete(id);
    }
  };

  return {
    async snapshot(): Promise<AuthHealthSnapshot> {
      const rows: ProviderSessionHealth[] = [];
      // Sequential on purpose: one browser at a time, so opening the page cannot spawn three.
      for (const provider of providers) rows.push(await checked(provider));
      return {
        checkedAt: new Date(now()).toISOString(),
        cache: { ttlMs: cacheTtlMs },
        providers: rows,
      };
    },

    noteVerified(providerId, verifiedAt) {
      const provider = byId.get(providerId);
      if (provider === undefined) return;
      const at = now();
      cache.set(providerId, {
        at,
        value: {
          providerId,
          label: provider.importProvider.label,
          state: "verified",
          capturePresent: true,
          verifiedAt: verifiedAt ?? new Date(at).toISOString(),
          checkedAt: new Date(at).toISOString(),
          code: null,
          reason: null,
        },
      });
    },
  };
}
