/**
 * Where a Qwen Chat sign-in lands.
 *
 * The layout is the deployment's existing one (`doc/provider-onboarding.md` §4.1):
 * `providers/qwen-chat/storage-state.json` plus its `.verified.json` marker. Passing `qwen-chat` as
 * the provider id is the whole isolation; one provider's directory can never satisfy another's
 * session check (`tests/issue-249-provider-credentials.test.ts`).
 *
 * ## The one thing a Qwen Code capture does not give you
 *
 * Cookies and `localStorage` are **per-domain**. `chat.qwen.ai` and `coder.qwen.ai` share the vendor's
 * auth host (`https://auth.qwen.ai`) and the same `qwen_access_token_state` storage key, but a
 * cookie stored host-only for `coder.qwen.ai` is not sent to `chat.qwen.ai`. A deployment therefore
 * has to sign in at `chat.qwen.ai` itself (or import a capture made there); the same operator account
 * works, the old capture does not. This validator refuses a capture that provably has no
 * `chat.qwen.ai`/parent-domain `qwen.ai` cookie with a message that says exactly that, instead of
 * storing it as a session that cannot work.
 *
 * Writes are atomic and private through {@link storeProviderSession}, the deployment's single session
 * writer; this module only supplies the provider id and the domain filter.
 */
import type { BrowserContextOptions } from "playwright-core";
import { storeProviderSession } from "../../browser-login";
import { providerCredentialsDir } from "../../config";
import {
  AUTH_IMPORT_REFUSAL_CODES,
  AuthImportRefusal,
} from "../../auth-import-errors";
import { QWEN_CHAT_PROVIDER_ID } from "./provider";

/** One cookie as a storage state carries it; only the fields this module reads are named. */
interface BrowserStorageState {
  readonly cookies?: readonly { readonly domain?: string; readonly expires?: unknown }[];
  readonly origins?: readonly { readonly origin?: string; readonly localStorage?: readonly unknown[] }[];
}

/** A validated capture: this provider's cookies and the allowed storage origins. */
export interface QwenChatSessionStorageState {
  readonly cookies: { domain?: string; expires?: unknown }[];
  readonly origins: { origin: string; localStorage: unknown[] }[];
}

/**
 * The domains a Qwen Chat sign-in may legitimately leave state on.
 *
 * The same vendor family the Qwen Code adapter allows (the app loads `aliyun.com` assets and sets
 * its anti-bot cookies there), but the `qwen.ai` cookie must actually cover `chat.qwen.ai` — see
 * {@link hasChatCookie}.
 */
export const QWEN_CHAT_COOKIE_DOMAINS = ["qwen.ai", "aliyun.com"] as const;

/** The origins whose `localStorage` may be captured (the app keeps its session material there). */
export const QWEN_CHAT_STORAGE_ORIGINS = ["https://chat.qwen.ai", "https://auth.qwen.ai"] as const;

/** Where a fresh capture comes from; the same script, pointed at this site. */
const IMPORT_SCRIPT = "scripts/qwen-storage-state.mjs";

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const normalized = host.replace(/^\.+/, "").toLowerCase();
  return allowed.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

/**
 * Whether a cookie domain is sent to `chat.qwen.ai`.
 *
 * A parent-domain cookie (`.qwen.ai`, i.e. `qwen.ai`) is; a host-only `chat.qwen.ai` cookie is; a
 * host-only `coder.qwen.ai` cookie is not. This is the distinction the operator needs to see, and it
 * is structural — no cookie name or value is read.
 */
function hasChatCookie(cookies: readonly { readonly domain?: unknown }[]): boolean {
  return cookies.some(cookie => {
    if (typeof cookie.domain !== "string") return false;
    const host = cookie.domain.replace(/^\.+/, "").toLowerCase();
    return host === "qwen.ai" || host === "chat.qwen.ai";
  });
}

/**
 * Restrict a captured storage state to the origins this provider owns.
 *
 * Structural and defensive: an absent/odd field yields an empty list rather than a throw, because a
 * sanitizer must never be the reason a signed-in session is discarded.
 */
export function sanitizeQwenChatStorageState(storageState: unknown): QwenChatSessionStorageState {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as BrowserStorageState;
  const cookies = (state.cookies ?? [])
    .filter(cookie => typeof cookie?.domain === "string" && hostAllowed(cookie.domain, QWEN_CHAT_COOKIE_DOMAINS))
    .map(cookie => ({ ...cookie }));
  const origins = (state.origins ?? [])
    .filter(origin => typeof origin?.origin === "string"
      && (QWEN_CHAT_STORAGE_ORIGINS as readonly string[]).includes(origin.origin))
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
 * The checks are separate so each refusal names the actual next step: no cookies, no chat-capable
 * Qwen cookie (the per-domain trap), or only expired ones.
 */
export function validateQwenChatSessionStorageState(
  storageState: unknown,
  now = Date.now(),
): QwenChatSessionStorageState {
  const state = (storageState && typeof storageState === "object" ? storageState : {}) as BrowserStorageState;
  const rawCookies = Array.isArray(state.cookies) ? state.cookies : [];
  const sanitized = sanitizeQwenChatStorageState(storageState);

  if (rawCookies.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      "the capture contains no cookies at all; open https://chat.qwen.ai in the browser you signed in "
      + `with, then export it again with ${IMPORT_SCRIPT}`,
    );
  }
  if (sanitized.cookies.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.foreignDomain,
      "the capture contains no qwen.ai cookies (every cookie in it belongs to another domain); "
      + `open https://chat.qwen.ai in that browser, sign in, then export it again with ${IMPORT_SCRIPT}`,
    );
  }
  if (!hasChatCookie(sanitized.cookies)) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.foreignDomain,
      "the capture has no cookie that is sent to chat.qwen.ai: cookies are per-domain, so a capture "
      + "made at coder.qwen.ai is not a Qwen Chat session even though both use the same Qwen account. "
      + `Open https://chat.qwen.ai in that browser, sign in there, then export it again with ${IMPORT_SCRIPT}`,
    );
  }
  const usable = sanitized.cookies.filter(cookie => !cookieExpired(cookie, now));
  if (usable.length === 0) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.expired,
      "every chat.qwen.ai cookie in the capture has expired; sign in again at https://chat.qwen.ai, "
      + `export a fresh capture with ${IMPORT_SCRIPT}, and re-run the import`,
    );
  }
  return { cookies: usable, origins: sanitized.origins };
}

/** The directory this provider's credentials live in. */
export function qwenChatCredentialsDir(home?: string): string {
  return home === undefined
    ? providerCredentialsDir(QWEN_CHAT_PROVIDER_ID)
    : providerCredentialsDir(QWEN_CHAT_PROVIDER_ID, home);
}

/**
 * Persist one captured session as *verified*.
 *
 * The marker (`version: 1`, `authenticated: true`, `verifiedAt`) is written only after the
 * authenticated probe already succeeded, so the two files can never disagree about whether the
 * session works. The writer is the deployment's single session owner.
 *
 * @returns the path the session was written to (never the session itself).
 */
export function storeQwenChatSession(storageState: unknown, home?: string): string {
  return storeProviderSession(
    sanitizeQwenChatStorageState(storageState) as unknown as NonNullable<BrowserContextOptions["storageState"]>,
    {},
    {
      providerId: QWEN_CHAT_PROVIDER_ID,
      ...(home === undefined ? {} : { home }),
    },
  );
}
