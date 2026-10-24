/**
 * Verify an *imported* DeepSeek Web capture before it is stored.
 *
 * `auth import` adopts a session captured on the operator's own machine. The file is not trusted:
 * `session-store.ts` validates it structurally (the cookies, the origin, `userToken`, the device id) —
 * and that validation is what refuses a capture **before a browser is launched**. Only a capture that
 * passes it reaches this module, which runs the provider's authenticated predicate.
 *
 * The open page is the authority for its own session, exactly as the Qwen importers do it: the capture
 * is loaded into a browser context, the app is opened, the identity (`userToken`, device id, locale,
 * timezone, bundle id, leim) is read **from the live page at call time**, and the measured settings
 * call is issued from inside that page through the provider-neutral `requestInPageContext`.
 *
 * ## Why there is no hydration wait here
 *
 * The Qwen importers wait, observably, for their app to exchange a cookie for a token and write it to
 * storage. No such exchange was measured for DeepSeek: the bearer the page sends **is** the
 * `userToken` entry the capture already carries, read by the app's own storage handle — so the page has
 * its identity at `domcontentloaded`, and a wait would be a sleep dressed up as a predicate. If the
 * page rewrote or cleared that entry while loading, the live read sees the page's truth (and the
 * provider's own answer decides), which is exactly the honesty this module keeps.
 *
 * No token, cookie or device id is ever returned, logged or put in a refusal. When the predicate says
 * unauthenticated it throws a non-secret sentence naming the operator's next action; the import
 * pipeline turns it into its one `import_predicate_failed` refusal, and the session-health surface
 * reports the same sentence.
 */
import type { Page } from "playwright-core";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { DEEPSEEK_WEB_SETTINGS_PATH } from "./provider";
import { openDeepSeekPage } from "./session";
import {
  deepSeekSettingsVerdict,
  probeDeepSeekSessionFromPage,
  type DeepSeekProbeVerdict,
} from "./session-probe";

/** One opened provider page, and the only handle that may close it. */
export interface DeepSeekImportedSessionPage {
  readonly page: Page;
  /**
   * The session state the live page holds **now**, when the opener can read it back.
   *
   * Keeping it stops a verification from consuming the capture it just proved: if the app rotated
   * anything while loading (its `userToken` handle, its leim cache), the state to persist is this one,
   * not the snapshot the proof was handed. Optional so a simulated page stays valid.
   */
  storageState?(): Promise<unknown>;
  /** Idempotent. */
  close(): Promise<void>;
}

/** Opens the provider's app on a captured session. Injected by tests. */
export type DeepSeekImportedSessionPageOpener = (
  storageState: unknown,
) => Promise<DeepSeekImportedSessionPage>;

/** A verified imported session. Credential-free by construction. */
export interface DeepSeekImportedSessionVerification {
  readonly authenticated: true;
  /** The call that proved it, for diagnostics. */
  readonly probe: "settings";
  /** The HTTP status the settings call answered (200 even when its business layer refused). */
  readonly status: number;
  /** The verdict class, so a caller can report that the nested layer decided. */
  readonly kind: "authenticated";
  /**
   * The session state the page held after it proved itself, when the page could be read back.
   *
   * This is the state to persist. It is absent for a probe seam that has no page behind it, and the
   * caller then keeps the capture it already accepted.
   */
  readonly storageState?: unknown;
}

/** Options for {@link verifyDeepSeekImportedSession}. */
export interface DeepSeekImportedSessionOptions {
  /** The configured Chrome executable. Only read by the default page opener. */
  readonly chromeExecutablePath?: string;
  /** Page-opener override: tests supply a simulated page instead of launching Chromium. */
  readonly openPage?: DeepSeekImportedSessionPageOpener;
}

/** The operator's one line for a verified session: which call answered, and which layer decided. */
export function deepSeekVerifiedDetail(status: number): string {
  return `Authenticated: ${DEEPSEEK_WEB_SETTINGS_PATH} answered data.biz_code:0 `
    + `(HTTP ${status}), so the nested business layer of the settings call is what decided it`;
}

/**
 * Prove that an imported capture is a live, authenticated DeepSeek Web session.
 *
 * Rejects with a non-secret diagnostic when the predicate says unauthenticated (or the browser cannot
 * be started). Nothing is written here: the caller stores only after this resolves — and it stores
 * {@link DeepSeekImportedSessionVerification.storageState} when the page could be read back.
 */
export async function verifyDeepSeekImportedSession(
  storageState: unknown,
  options: DeepSeekImportedSessionOptions = {},
): Promise<DeepSeekImportedSessionVerification> {
  const openPage: DeepSeekImportedSessionPageOpener = options.openPage ?? (async capture => {
    if (!options.chromeExecutablePath) {
      throw new Error(
        "no Chrome executable is available for the DeepSeek session check; configure chromeExecutablePath",
      );
    }
    return await openDeepSeekPage(options.chromeExecutablePath, capture);
  });

  const opened = await openPage(storageState).catch(error => {
    // A page that could not be opened judged nothing: it is reported as a transport failure, never as
    // "the session is wrong", and the message carries no URL, cookie or token.
    throw new Error(
      "DeepSeek's page could not be opened to issue the session check: "
      + nonSecretDiagnosticText(error),
    );
  });
  try {
    const observation = await probeDeepSeekSessionFromPage(opened.page);
    const verdict: DeepSeekProbeVerdict = deepSeekSettingsVerdict(observation);
    if (!verdict.authenticated) {
      // The provider's own sentence: it names which class refused (token, settings, challenge, HTTP,
      // unreadable) and the operator's next action. Never a credential.
      throw new Error(verdict.refusal ?? "DeepSeek did not prove this capture's session");
    }
    let proved: unknown;
    if (opened.storageState !== undefined) {
      // Read before `close()`: a closed context cannot answer. A context that will not serialize is
      // not a session failure — the accepted capture stays the state to persist.
      try { proved = await opened.storageState(); } catch { proved = undefined; }
    }
    return {
      authenticated: true,
      probe: "settings",
      status: observation.status,
      kind: "authenticated",
      ...(proved === undefined ? {} : { storageState: proved }),
    };
  } finally {
    await opened.close();
  }
}
