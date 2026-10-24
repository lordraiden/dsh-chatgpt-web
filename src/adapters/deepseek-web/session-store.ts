/**
 * Where a DeepSeek Web capture lands, and the structural checks it must pass **before** a browser is
 * launched.
 *
 * The layout is the deployment's existing one (`doc/provider-onboarding.md` §4.1):
 * `providers/deepseek-web/storage-state.json` plus its `.verified.json` marker. Passing `deepseek-web`
 * as the provider id is the whole isolation — one provider's directory can never satisfy another's
 * session check.
 *
 * ## What a DeepSeek capture must contain (measured, `doc/deepseek-web.md` §7)
 *
 * ```text
 * cookies                        the WAF/session cookies of chat.deepseek.com
 * origins[chat.deepseek.com].localStorage
 *   userToken                    {"value": "<opaque bearer>", "__version": "0"}
 *   deepseek-device-id:chat      the browser's device identity
 *   hif_leim_cached              optional; omitted when the page has none
 * ```
 *
 * A capture with cookies only is not a session: every API call carries the page's bearer, and the page
 * reads it from `userToken`. A capture with `userToken` only is not a session either: the WAF/session
 * cookies are the page's own. Both are refused here — synchronously, with a message that names the
 * missing entry — so a browser is never started to discover a capture problem.
 *
 * ## What this module does not decide
 *
 * Whether the session still **works** is the authenticated predicate's question
 * (`session-import.ts` → `session-probe.ts`). This validator only answers "could this file be a
 * DeepSeek Web session at all?", and every refusal names the operator's next step. No cookie, token or
 * storage value is ever read out loud, logged or stored in a message.
 */
import type { BrowserContextOptions } from "playwright-core";

import { storeProviderSession } from "../../browser-login";
import { providerCredentialsDir } from "../../config";
import {
  AUTH_IMPORT_REFUSAL_CODES,
  AuthImportRefusal,
} from "../../auth-import-errors";
import { DEEPSEEK_WEB_PROVIDER_ID } from "./provider";
import {
  DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY,
  DEEPSEEK_WEB_LEIM_STORAGE_KEY,
  DEEPSEEK_WEB_TOKEN_STORAGE_KEY,
  deepSeekAccessTokenFromStorage,
} from "./page-identity";

/** One cookie as a storage state carries it; only the fields this module reads are named. */
interface BrowserStorageState {
  readonly cookies?: readonly { readonly domain?: string; readonly expires?: unknown }[];
  readonly origins?: readonly { readonly origin?: string; readonly localStorage?: readonly unknown[] }[];
}

/** One `localStorage` entry as a storage state carries it. */
interface StorageEntry {
  readonly name?: unknown;
  readonly value?: unknown;
}

/** A validated capture: this provider's cookies and the storage this module could use. */
export interface DeepSeekSessionStorageState {
  readonly cookies: { domain?: string; expires?: unknown }[];
  readonly origins: { origin: string; localStorage: unknown[] }[];
}

/** The only domain a DeepSeek session's cookies belong to (the WAF and the app are both on it). */
export const DEEPSEEK_WEB_COOKIE_DOMAINS = ["deepseek.com"] as const;

/** The origin whose `localStorage` the app keeps its session material on. */
export const DEEPSEEK_WEB_STORAGE_ORIGINS = ["https://chat.deepseek.com"] as const;

/**
 * The `localStorage` entries a capture **must** carry, in the doc's own order.
 *
 * `hif_leim_cached` is deliberately absent: the app's header builder omits `x-hif-leim` when its cache
 * is empty, so a capture without it is complete, not broken.
 */
export const DEEPSEEK_WEB_REQUIRED_STORAGE_KEYS = [
  DEEPSEEK_WEB_TOKEN_STORAGE_KEY,
  DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY,
] as const;

/** The optional entry, named so a refusal can say the capture is complete without it. */
export const DEEPSEEK_WEB_OPTIONAL_STORAGE_KEY = DEEPSEEK_WEB_LEIM_STORAGE_KEY;

/** The three entries the doc lists, in the order it lists them, for one operator-facing sentence. */
export const DEEPSEEK_WEB_CAPTURE_STORAGE_SUMMARY =
  `\`${DEEPSEEK_WEB_TOKEN_STORAGE_KEY}\` (the API bearer), `
  + `\`${DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY}\` (the browser's device identity) and, when the page has `
  + `one, \`${DEEPSEEK_WEB_OPTIONAL_STORAGE_KEY}\``;

/** Where a fresh capture comes from: the same shape the CLI documents. */
const IMPORT_INSTRUCTION =
  "open https://chat.deepseek.com in the browser you signed in with, then export the session again "
  + "(cookies plus that origin's local storage)";

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const normalized = host.replace(/^\.+/, "").toLowerCase();
  return allowed.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

/**
 * Restrict a captured storage state to the origins and cookie domains this provider owns.
 *
 * Structural and defensive: an absent/odd field yields an empty list rather than a throw, because a
 * sanitizer must never be the reason a signed-in session is discarded.
 */
export function sanitizeDeepSeekStorageState(storageState: unknown): DeepSeekSessionStorageState {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as BrowserStorageState;
  const cookies = (state.cookies ?? [])
    .filter(cookie => typeof cookie?.domain === "string" && hostAllowed(cookie.domain, DEEPSEEK_WEB_COOKIE_DOMAINS))
    .map(cookie => ({ ...cookie }));
  const origins = (state.origins ?? [])
    .filter(origin => typeof origin?.origin === "string"
      && (DEEPSEEK_WEB_STORAGE_ORIGINS as readonly string[]).includes(origin.origin))
    .map(origin => ({
      origin: origin.origin as string,
      localStorage: [...(origin.localStorage ?? [])],
    }));
  return { cookies, origins };
}

/** Whether a cookie domain is sent to `chat.deepseek.com`. */
function hasDeepSeekCookie(cookies: readonly { readonly domain?: unknown }[]): boolean {
  return cookies.some(cookie => typeof cookie.domain === "string"
    && hostAllowed(cookie.domain, DEEPSEEK_WEB_COOKIE_DOMAINS));
}

function cookieExpired(cookie: { readonly expires?: unknown }, now: number): boolean {
  // Playwright stores `expires` in seconds since the epoch, or -1 for a session cookie. A shape this
  // module does not understand is treated as a session cookie: refusing it would be the validator
  // discarding a session it cannot judge.
  return typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires * 1000 <= now;
}

/** The `localStorage` entries captured for this provider's origin. */
function storageEntries(state: DeepSeekSessionStorageState): Map<string, string> {
  const entries = new Map<string, string>();
  for (const origin of state.origins) {
    if (origin.origin !== "https://chat.deepseek.com") continue;
    for (const raw of origin.localStorage) {
      const entry = (raw && typeof raw === "object" ? raw : {}) as StorageEntry;
      if (typeof entry.name !== "string" || typeof entry.value !== "string") continue;
      entries.set(entry.name, entry.value);
    }
  }
  return entries;
}

/**
 * Validate an imported capture for this provider, before the authenticated probe runs.
 *
 * The checks are separate so each refusal names the actual missing piece, in this order: no cookies at
 * all, no `deepseek.com` cookie, only expired cookies, no `chat.deepseek.com` local storage, and then —
 * the two entries the page's own requests need — `userToken` and `deepseek-device-id:chat`.
 */
export function validateDeepSeekSessionStorageState(
  storageState: unknown,
  now = Date.now(),
): DeepSeekSessionStorageState {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as BrowserStorageState;
  const rawCookies = Array.isArray(state.cookies) ? state.cookies : [];
  const sanitized = sanitizeDeepSeekStorageState(storageState);

  if (rawCookies.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      "the capture contains no cookies at all; a DeepSeek Web session needs the WAF/session cookies of "
      + `chat.deepseek.com as well as its local storage — ${IMPORT_INSTRUCTION}`,
    );
  }
  if (!hasDeepSeekCookie(sanitized.cookies)) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.foreignDomain,
      "the capture contains no deepseek.com cookie (every cookie in it belongs to another domain); "
      + `a DeepSeek Web session is the chat.deepseek.com one — ${IMPORT_INSTRUCTION}`,
    );
  }
  const usable = sanitized.cookies.filter(cookie => !cookieExpired(cookie, now));
  if (usable.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.expired,
      "every deepseek.com cookie in the capture has expired; sign in again at https://chat.deepseek.com, "
      + `export a fresh capture, and re-run the import`,
    );
  }

  if (sanitized.origins.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      "the capture carries no local storage for https://chat.deepseek.com, and this provider's requests "
      + `need it: ${DEEPSEEK_WEB_CAPTURE_STORAGE_SUMMARY}. ${IMPORT_INSTRUCTION}`,
    );
  }

  const entries = storageEntries(sanitized);
  const tokenEntry = entries.get(DEEPSEEK_WEB_TOKEN_STORAGE_KEY);
  if (tokenEntry === undefined) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      `the capture is missing the \`${DEEPSEEK_WEB_TOKEN_STORAGE_KEY}\` local-storage entry, which is the `
      + "bearer every chat.deepseek.com API call carries; a capture needs "
      + `${DEEPSEEK_WEB_CAPTURE_STORAGE_SUMMARY}. ${IMPORT_INSTRUCTION}`,
    );
  }
  if (deepSeekAccessTokenFromStorage(tokenEntry) === undefined) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.shapeInvalid,
      `the capture's \`${DEEPSEEK_WEB_TOKEN_STORAGE_KEY}\` entry is not the JSON the app writes `
      + '(`{"value": "<token>", "__version": "0"}`) or holds no token, so no bearer could be sent. '
      + `${IMPORT_INSTRUCTION}`,
    );
  }

  const deviceId = entries.get(DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY);
  if (deviceId === undefined || deviceId.trim().length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      `the capture is missing the \`${DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY}\` local-storage entry, which is `
      + "the device identity the page's own request headers and the settings call carry; a capture needs "
      + `${DEEPSEEK_WEB_CAPTURE_STORAGE_SUMMARY}. ${IMPORT_INSTRUCTION}`,
    );
  }

  return { cookies: usable, origins: sanitized.origins };
}

/** The directory this provider's credentials live in. */
export function deepSeekCredentialsDir(home?: string): string {
  return home === undefined
    ? providerCredentialsDir(DEEPSEEK_WEB_PROVIDER_ID)
    : providerCredentialsDir(DEEPSEEK_WEB_PROVIDER_ID, home);
}

/**
 * Persist one captured session as *verified*.
 *
 * The marker (`version: 1`, `authenticated: true`, `verifiedAt`) is written only after the authenticated
 * predicate already succeeded, so the two files can never disagree about whether the session works.
 * The writer is the deployment's single session owner.
 *
 * @returns the path the session was written to (never the session itself).
 */
export function storeDeepSeekSession(storageState: unknown, home?: string): string {
  return storeProviderSession(
    sanitizeDeepSeekStorageState(storageState) as unknown as NonNullable<BrowserContextOptions["storageState"]>,
    {},
    {
      providerId: DEEPSEEK_WEB_PROVIDER_ID,
      ...(home === undefined ? {} : { home }),
    },
  );
}
