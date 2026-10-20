/**
 * Qwen Chat interactive sign-in controller.
 *
 * ## What is shared, and why
 *
 * The live relay, the pointer-gesture handling, the bounded completion poll and the throwaway browser
 * profile are the **same mechanism** the Qwen Code controller already implements — correctly, and with
 * the vendor's own anti-automation shape. Re-implementing them here would create a second sign-in
 * authority, which the onboarding document forbids. This module therefore composes
 * `createQwenCodeAuthController` with this provider's four facts:
 *
 * - the **provider id** (`qwen-chat`), so the neutral auth surface sees one session per provider;
 * - the **app URL** (`https://chat.qwen.ai/`);
 * - the **authenticated probe** (`GET /api/v2/chats`, envelope `success:true`);
 * - the **store** (`providers/qwen-chat/storage-state.json`, filtered to this site's cookie and
 *   storage origins).
 *
 * Nothing about the relay, the input vocabulary or the host surface changes.
 *
 * ## The one thing an operator must understand
 *
 * The Qwen account family is shared with `coder.qwen.ai` (same `auth.qwen.ai` refresh host, same
 * `qwen_access_token_state` storage key), but **cookies and localStorage are per-domain**. A capture
 * made for Qwen Code is not a Qwen Chat session. Signing in through this controller (or importing a
 * capture made at `chat.qwen.ai`) is what makes this provider usable; the account is usually the same
 * one.
 */
import { chromium, type BrowserContext } from "playwright-core";

import { providerCredentialsDir, type AppConfig } from "../../config";
import type { ProviderAuthController } from "../../web-chat/core";
import {
  createQwenCodeAuthController,
  qwenCodeAuthLaunchArgs,
  type QwenCodeAuthBrowserHandle,
  type QwenCodeAuthBrowserLaunch,
  type QwenCodeAuthSessionStored,
  type QwenCodeSessionProbe,
  type QwenCodeSessionProbeResult,
} from "../qwen-code/auth-controller";
import {
  QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CHAT_AUTH_PROVIDER_LABEL,
  QWEN_CHAT_AUTH_VIEWPORT,
  QWEN_CHAT_CHATS_PATH,
  QWEN_CHAT_PROVIDER_ID,
  QWEN_CHAT_ROOT_URL,
} from "./provider";
import { probeQwenChatFromPage, qwenChatProbeRefusal, qwenChatProbeVerdict } from "./session-probe";
import { qwenChatCredentialsDir, sanitizeQwenChatStorageState, storeQwenChatSession } from "./session-store";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";

/** Construction options for {@link createQwenChatAuthController}. */
export interface QwenChatAuthControllerOptions {
  /** The deployment facts: the executable and the launch mode. */
  readonly config: Pick<AppConfig, "chromeExecutablePath" | "authBrowserMode">;
  /** Where the throwaway profile is created. Defaults to this provider's credentials directory. */
  readonly profileRoot?: string;
  /** The one-shot completion hook, called once the session is on disk. */
  readonly afterSessionStored?: QwenCodeAuthSessionStored;
}

/**
 * The default launch: a persistent Chromium context on the throwaway profile, on the Qwen Chat app.
 *
 * `headless: false` plus `--headless=new` is the repository's established headless shape (the same
 * flags the Qwen Code sign-in uses); nothing here overrides the user agent, and a page-level
 * challenge is the operator's to clear — never a disguise's to bypass.
 */
async function openChatBrowser(launch: QwenCodeAuthBrowserLaunch): Promise<QwenCodeAuthBrowserHandle> {
  const context: BrowserContext = await chromium.launchPersistentContext(launch.profileDir, {
    executablePath: launch.executablePath,
    headless: false,
    viewport: { width: launch.viewport.width, height: launch.viewport.height },
    args: qwenCodeAuthLaunchArgs(launch),
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(QWEN_CHAT_ROOT_URL, {
      waitUntil: "domcontentloaded",
      timeout: QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS,
    });
    return {
      page,
      // The profile only ever had a reason to hold Qwen Chat state; the same filter the capture
      // writer applies is applied here too, so no IdP or other-site cookie can leak into the capture.
      storageState: async () => sanitizeQwenChatStorageState(await context.storageState()),
      close: async () => { await context.close(); },
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/**
 * The authenticated probe: the same envelope predicate the import path uses.
 *
 * The poll loop owns the wait, so this is one shot against the live page. A refusal message is
 * non-secret and names the sign-in surface.
 */
async function probeChatSession(page: Parameters<QwenCodeSessionProbe>[0]): Promise<QwenCodeSessionProbeResult> {
  const observation = await probeQwenChatFromPage(page);
  const verdict = qwenChatProbeVerdict(observation);
  if (!verdict.authenticated) {
    throw new Error(qwenChatProbeRefusal(observation));
  }
  return { authenticated: true, probe: QWEN_CHAT_CHATS_PATH, status: observation.status };
}

/**
 * Create the Qwen Chat interactive sign-in controller.
 *
 * Construction is inert: no browser is started and no profile is created here. Only `startAuth()`
 * launches anything, so a listener can register this controller and still start with no browser.
 */
export function createQwenChatAuthController(
  options: QwenChatAuthControllerOptions,
): ProviderAuthController {
  if (!options || !options.config || typeof options.config.chromeExecutablePath !== "string") {
    throw new TypeError("A Qwen Chat sign-in controller requires the deployment configuration");
  }
  try {
    return createQwenCodeAuthController({
      config: options.config,
      providerId: QWEN_CHAT_PROVIDER_ID,
      rootUrl: QWEN_CHAT_ROOT_URL,
      probePath: QWEN_CHAT_CHATS_PATH,
      sessionLabel: QWEN_CHAT_AUTH_PROVIDER_LABEL,
      profileRoot: options.profileRoot ?? qwenChatCredentialsDir(),
      viewport: QWEN_CHAT_AUTH_VIEWPORT,
      openBrowser: openChatBrowser,
      probeSession: probeChatSession,
      storeSession: storeQwenChatSession,
      ...(options.afterSessionStored === undefined ? {} : { afterSessionStored: options.afterSessionStored }),
    });
  } catch (error) {
    // A malformed option is a construction error, and its message is this provider's own. It never
    // contains a credential.
    throw new Error(
      `The Qwen Chat sign-in controller could not be composed: ${nonSecretDiagnosticText(error)}`,
    );
  }
}

/** The directory this provider's credentials live in (re-exported for the listener's composition). */
export { qwenChatCredentialsDir };

/** The default profile root, exported so a listener's diagnostics can name it without guessing. */
export function qwenChatAuthProfileRoot(): string {
  return providerCredentialsDir(QWEN_CHAT_PROVIDER_ID);
}
