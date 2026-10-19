/**
 * Where a Qwen Code sign-in lands (issue #299, slice 1).
 *
 * The layout is the one the deployment already owns for provider credentials
 * (`doc/provider-onboarding.md` §4.1): `providers/<providerId>/storage-state.json` plus its
 * `.verified.json` marker. This module does not invent a second location and does not touch the
 * ChatGPT provider's directory: passing `qwen-code` as the provider id is the whole isolation.
 *
 * Three properties are load-bearing:
 *
 * - **Writes are atomic and private** — `storeProviderSession` is the deployment's single session
 *   writer (mode 0600), so a half-written session can never be read back as a real one. This module
 *   is the Qwen-facing entry point; it delegates rather than keeping a second writer.
 * - **Only this provider's origins are captured** — the disposable profile is only ever pointed at
 *   `coder.qwen.ai`, but the capture is filtered anyway, because a redirect through an IdP would
 *   otherwise leave that IdP's cookies in the provider's credential file.
 * - **An imported capture is validated before it can reach the writer** — a file that contains no
 *   cookie for this provider, or only expired ones, is refused with an actionable message instead of
 *   being stored as a session that cannot work. Validation never echoes a cookie name or value.
 *
 * Nothing here logs, echoes or returns the captured material: the functions that see it return a
 * path, never a body.
 */
import type { BrowserContextOptions } from "playwright-core";
import { storeProviderSession } from "../../browser-login";
import { providerCredentialsDir } from "../../config";
import {
  AUTH_IMPORT_REFUSAL_CODES,
  AuthImportRefusal,
} from "../../auth-import-errors";
import { QWEN_CODE_PROVIDER_ID } from "./provider";

/** One cookie as a storage state carries it; only the fields this module reads are named. */
interface BrowserStorageState {
  readonly cookies?: readonly { readonly domain?: string; readonly expires?: unknown }[];
  readonly origins?: readonly { readonly origin?: string; readonly localStorage?: readonly unknown[] }[];
}

/** A validated capture: this provider's cookies and the allowed storage origins. */
export interface QwenCodeSessionStorageState {
  readonly cookies: { domain?: string; expires?: unknown }[];
  readonly origins: { origin: string; localStorage: unknown[] }[];
}

/** The domains a Qwen Code sign-in may legitimately leave state on. */
export const QWEN_CODE_COOKIE_DOMAINS = ["qwen.ai", "aliyun.com"] as const;

/** The origins whose `localStorage` may be captured (the app keeps its session material there). */
export const QWEN_CODE_STORAGE_ORIGINS = ["https://coder.qwen.ai", "https://auth.qwen.ai"] as const;

/** Where a fresh capture comes from; the same value the script and the docs use. */
const IMPORT_SCRIPT = "scripts/qwen-storage-state.mjs";

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const normalized = host.replace(/^\.+/, "").toLowerCase();
  return allowed.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

/**
 * Restrict a captured storage state to the origins this provider owns.
 *
 * Structural and defensive: an absent/odd field yields an empty list rather than a throw, because a
 * sanitizer must never be the reason a signed-in session is discarded. The *session* itself is
 * validated by the authenticated probe before this is ever called.
 */
export function sanitizeQwenStorageState(storageState: unknown): QwenCodeSessionStorageState {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as BrowserStorageState;
  const cookies = (state.cookies ?? [])
    .filter(cookie => typeof cookie?.domain === "string" && hostAllowed(cookie.domain, QWEN_CODE_COOKIE_DOMAINS))
    .map(cookie => ({ ...cookie }));
  const origins = (state.origins ?? [])
    .filter(origin => typeof origin?.origin === "string"
      && (QWEN_CODE_STORAGE_ORIGINS as readonly string[]).includes(origin.origin))
    .map(origin => ({
      origin: origin.origin as string,
      localStorage: [...(origin.localStorage ?? [])],
    }));
  return { cookies, origins };
}

function cookieExpired(cookie: { readonly expires?: unknown }, now: number): boolean {
  // Playwright stores `expires` in seconds since the epoch, or -1 for a session cookie. A capture
  // that carries an unexpected shape is treated as a session cookie: refusing it would be the
  // validator discarding a session it cannot judge, which is the one thing it must not do.
  return typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires * 1000 <= now;
}

/**
 * Validate an imported capture for this provider, before the authenticated probe runs.
 *
 * The checks are deliberately separate so each refusal names the actual next step:
 *
 * - no cookies at all — the file is the wrong file (or a truncated export);
 * - cookies, but none for `qwen.ai`/`aliyun.com` — a different browser/site was captured;
 * - this provider's cookies all expired — the export is stale, sign in again.
 *
 * @returns the sanitized capture to probe and, if it authenticates, store.
 */
export function validateQwenCodeSessionStorageState(
  storageState: unknown,
  now = Date.now(),
): QwenCodeSessionStorageState {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as BrowserStorageState;
  const rawCookies = Array.isArray(state.cookies) ? state.cookies : [];
  const sanitized = sanitizeQwenStorageState(storageState);

  if (rawCookies.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      "the capture contains no cookies at all; open https://coder.qwen.ai in the browser you signed in with, "
      + `then export it again with ${IMPORT_SCRIPT}`,
    );
  }
  if (sanitized.cookies.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.foreignDomain,
      "the capture contains no coder.qwen.ai cookies (every cookie in it belongs to another domain); "
      + `open https://coder.qwen.ai in that browser, sign in, then export it again with ${IMPORT_SCRIPT}`,
    );
  }
  const usable = sanitized.cookies.filter(cookie => !cookieExpired(cookie, now));
  if (usable.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.expired,
      "every coder.qwen.ai cookie in the capture has expired; sign in again at https://coder.qwen.ai, "
      + `export a fresh capture with ${IMPORT_SCRIPT}, and re-run the import`,
    );
  }
  return { cookies: usable, origins: sanitized.origins };
}

/** The directory this provider's credentials live in. */
export function qwenCodeCredentialsDir(home?: string): string {
  return home === undefined
    ? providerCredentialsDir(QWEN_CODE_PROVIDER_ID)
    : providerCredentialsDir(QWEN_CODE_PROVIDER_ID, home);
}

/**
 * Persist one captured session as *verified*.
 *
 * The marker is what makes a session real for every other reader of the layout: `version: 1`,
 * `authenticated: true` and a `verifiedAt` timestamp — written only after the authenticated probe
 * already succeeded, so the two files can never disagree about whether the session works.
 *
 * The write itself belongs to {@link storeProviderSession}, the single session owner; this function
 * only supplies the provider id, so the file names and marker layout cannot drift from ChatGPT's.
 *
 * @returns the path the session was written to (never the session itself).
 */
export function storeQwenSession(storageState: unknown, home?: string): string {
  return storeProviderSession(
    // The sanitizer preserves every field of each accepted cookie, so the value is a browser storage
    // state by construction; the narrow return type above only names what this module itself reads.
    sanitizeQwenStorageState(storageState) as unknown as NonNullable<BrowserContextOptions["storageState"]>,
    {},
    {
      providerId: QWEN_CODE_PROVIDER_ID,
      ...(home === undefined ? {} : { home }),
    },
  );
}
