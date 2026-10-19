/**
 * Where a Qwen Code sign-in lands (issue #299, slice 1).
 *
 * The layout is the one the deployment already owns for provider credentials
 * (`doc/provider-onboarding.md` §4.1): `providers/<providerId>/storage-state.json` plus its
 * `.verified.json` marker. This module does not invent a second location and does not touch the
 * ChatGPT provider's directory: passing `qwen-code` as the provider id is the whole isolation.
 *
 * Two properties are load-bearing:
 *
 * - **Writes are atomic and private** — `atomicWriteFile` is the configuration module's own writer
 *   (mode 0600), so a half-written session can never be read back as a real one.
 * - **Only this provider's origins are captured** — the disposable profile is only ever pointed at
 *   `coder.qwen.ai`, but the capture is filtered anyway, because a redirect through an IdP would
 *   otherwise leave that IdP's cookies in the provider's credential file.
 *
 * Nothing here logs, echoes or returns the captured material: the functions that see it return a
 * path, never a body.
 */
import {
  atomicWriteFile,
  providerCredentialsDir,
  providerStorageStatePath,
  storageStateMarkerPath,
} from "../../config";
import { QWEN_CODE_PROVIDER_ID } from "./provider";

/** One cookie as a storage state carries it; only the fields this module reads are named. */
interface BrowserStorageState {
  readonly cookies?: readonly { readonly domain?: string }[];
  readonly origins?: readonly { readonly origin?: string; readonly localStorage?: readonly unknown[] }[];
}

/** The domains a Qwen Code sign-in may legitimately leave state on. */
const QWEN_CODE_COOKIE_DOMAINS = ["qwen.ai", "aliyun.com"] as const;

/** The origins whose `localStorage` may be captured (the app keeps its session material there). */
const QWEN_CODE_STORAGE_ORIGINS = ["https://coder.qwen.ai", "https://auth.qwen.ai"] as const;

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
export function sanitizeQwenStorageState(storageState: unknown): {
  cookies: { domain?: string }[];
  origins: { origin: string; localStorage: unknown[] }[];
} {
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
 * @returns the path the session was written to (never the session itself).
 */
export function storeQwenSession(storageState: unknown, home?: string): string {
  const target = home === undefined
    ? providerStorageStatePath(QWEN_CODE_PROVIDER_ID)
    : providerStorageStatePath(QWEN_CODE_PROVIDER_ID, home);
  atomicWriteFile(target, `${JSON.stringify(sanitizeQwenStorageState(storageState))}\n`);
  atomicWriteFile(storageStateMarkerPath(target), `${JSON.stringify({
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
  })}\n`);
  return target;
}
