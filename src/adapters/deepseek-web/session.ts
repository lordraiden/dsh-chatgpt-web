/**
 * The DeepSeek Web session page: the one transport resource this provider owns.
 *
 * ## Why a page at all
 *
 * `chat.deepseek.com` is a network provider, but not a Node-friendly one: the shell is behind an AWS
 * WAF challenge and the completion needs a proof of work (recon §2.6). A request issued from Node
 * would have to reproduce both. The session is therefore held by a real browsing context seeded with
 * the verified capture, and every request is issued from inside it
 * (`createDeepSeekPageRequestFacility`), same-origin.
 *
 * ## What readiness can honestly mean here
 *
 * The Qwen adapters can wait for their app to restore a token from `localStorage`. **No equivalent
 * observable was measured for DeepSeek** (recon §2.7 names the token manager and the storage keys the
 * app caches its *settings* in, not a token key), so this adapter does not pretend to have one:
 *
 * 1. the deployment's `.verified.json` marker must exist (the deployment's own proof that an
 *    authenticated predicate accepted this session);
 * 2. the provider's page must open.
 *
 * Everything after that is the provider's answer: a missing/invalid token comes back as
 * `40002`/`40003` and is reported as `AUTH_REQUIRED`, a WAF page as `DEEPSEEK_ACCESS_VERIFICATION`.
 * Guessing a hydration predicate would be a second, invented readiness rule.
 *
 * ## No retained surface, so no eviction family
 *
 * This page is **not** keyed by conversation and is never the identity of one. Continuity lives in
 * the chat session id and the parent message id (`chat-state.ts`), so the ChatGPT adapter's
 * `retained_surface_lost` family has no counterpart here. The page is still a physical resource and is
 * owned exclusively: one turn at a time uses it, and a second turn queues instead of racing it.
 */
import { readFileSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright-core";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { webChatError } from "../../web-chat/core";
import {
  DEEPSEEK_WEB_NAVIGATION_TIMEOUT_MS,
  DEEPSEEK_WEB_PROVIDER_ID,
  DEEPSEEK_WEB_ROOT_URL,
  DEEPSEEK_WEB_VIEWPORT,
} from "./provider";
import {
  createDeepSeekPageRequestFacility,
  type DeepSeekProofOfWorkSolver,
  type DeepSeekTurnRequestFacility,
} from "./network-turn";
import { deepSeekSessionVerified, type DeepSeekProviderConfig } from "./provider-config";

/** The operator's next action when no usable session exists. Never a cookie, never a token. */
export const DEEPSEEK_WEB_SIGN_IN_INSTRUCTION =
  "Sign in to DeepSeek at https://chat.deepseek.com in the browser that holds the account, then store "
  + "the capture with `auth import --provider deepseek-web`. This build verifies no DeepSeek capture "
  + "itself (doc/deepseek-web.md §6), so a capture is stored unverified and no turn uses it yet.";

/** The established headless launch shape, kept beside the only place that uses it. */
function deepSeekWebLaunchArgs(): string[] {
  return [
    "--headless=new",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${DEEPSEEK_WEB_VIEWPORT.width},${DEEPSEEK_WEB_VIEWPORT.height}`,
  ];
}

/** One opened provider page and the only handle that may close it. */
export interface DeepSeekSessionPage {
  readonly page: Page;
  close(): Promise<void>;
}

/** Opens the provider's app on a verified capture. Injected by tests; production launches Chromium. */
export type DeepSeekSessionPageOpener = (storageState: unknown) => Promise<DeepSeekSessionPage>;

/**
 * What a transport needs from the session: readiness, one exclusive turn on the page, and release.
 *
 * It deliberately exposes no page, cookie or token: a transport asks for the *facility*, which issues
 * the requests with the page's own context and the two documented seams.
 */
export interface DeepSeekRequestSession {
  /** Stable identity, for diagnostics. */
  readonly id: string;
  /** Prove a session is usable. A rejection happens before anything is submitted. */
  ready(): Promise<void>;
  /**
   * Run one turn's requests while holding the page exclusively.
   *
   * `body` receives the request facility and must use it for every call of the turn. The page is
   * released when `body` settles, whatever the outcome.
   */
  run<T>(body: (facility: DeepSeekTurnRequestFacility) => Promise<T>): Promise<T>;
  /** Release the browsing context. Idempotent. */
  close(): Promise<void>;
}

/** Options for {@link createDeepSeekBrowserSession}. */
export interface DeepSeekBrowserSessionOptions {
  /** The resolved provider facts (session path, executable). */
  readonly provider: DeepSeekProviderConfig;
  /** Test/in-process seam; production launches Chromium on the capture. */
  readonly openPage?: DeepSeekSessionPageOpener;
  /** The proof solver. Defaults to the typed refusal (`unprovenDeepSeekProofOfWork`). */
  readonly proofOfWork?: DeepSeekProofOfWorkSolver;
  /** The `Authorization` reader. Defaults to "none" (no measured token provenance). */
  readonly authorization?: () => Promise<string | undefined>;
  /** Clock seam, for the diagnostics' own timing. */
  readonly now?: () => number;
}

/** Read the verified capture. Throws a typed, credential-free failure when it cannot be used. */
function readVerifiedStorageState(provider: DeepSeekProviderConfig): unknown {
  if (!deepSeekSessionVerified(provider.storageStatePath)) {
    throw webChatError(
      "AUTH_REQUIRED",
      `DeepSeek has no verified session on this deployment. ${DEEPSEEK_WEB_SIGN_IN_INSTRUCTION}.`,
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_SESSION_MISSING" },
    );
  }
  try {
    return JSON.parse(readFileSync(provider.storageStatePath, "utf8")) as unknown;
  } catch (error) {
    throw webChatError(
      "AUTH_REQUIRED",
      `The stored DeepSeek session cannot be read (${nonSecretDiagnosticText(error)}). `
      + `${DEEPSEEK_WEB_SIGN_IN_INSTRUCTION}.`,
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_SESSION_UNREADABLE" },
    );
  }
}

/**
 * The default opener: launch Chromium on the capture and open the app shell.
 *
 * No user-agent override and no stealth flag: the recorded block here is WAF/PoW, not UA sensitivity
 * (recon §2.6 measured identical answers with and without a UA), and a page-level challenge is the
 * operator's to clear, not a disguise's to bypass.
 */
async function defaultOpenPage(
  provider: DeepSeekProviderConfig,
  storageState: unknown,
): Promise<DeepSeekSessionPage> {
  const browser: Browser = await chromium.launch({
    executablePath: provider.chromeExecutablePath,
    headless: false,
    args: deepSeekWebLaunchArgs(),
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      storageState: storageState as NonNullable<BrowserContextOptions["storageState"]>,
      viewport: { width: DEEPSEEK_WEB_VIEWPORT.width, height: DEEPSEEK_WEB_VIEWPORT.height },
    });
    const page = await context.newPage();
    await page.goto(DEEPSEEK_WEB_ROOT_URL, {
      waitUntil: "domcontentloaded",
      timeout: DEEPSEEK_WEB_NAVIGATION_TIMEOUT_MS,
    });
    const opened = context;
    return {
      page,
      async close() {
        try { await opened.close(); } finally { await browser.close(); }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw webChatError(
      "TRANSPORT_UNAVAILABLE",
      `The DeepSeek page could not be opened (${nonSecretDiagnosticText(error)}).`,
      {
        providerId: DEEPSEEK_WEB_PROVIDER_ID,
        providerCode: "DEEPSEEK_PAGE_OPEN_FAILED",
        cause: error,
      },
    );
  }
}

/**
 * A session backed by one lazily-opened browsing context, one turn at a time.
 *
 * @param options - the provider facts and the optional opener/seam overrides.
 * @returns the session a transport can ask for readiness and one exclusive turn.
 */
export function createDeepSeekBrowserSession(
  options: DeepSeekBrowserSessionOptions,
): DeepSeekRequestSession {
  const { provider } = options;
  const now = options.now ?? Date.now;
  const openPage: DeepSeekSessionPageOpener = options.openPage
    ?? ((storageState: unknown) => defaultOpenPage(provider, storageState));

  let session: { readonly page: Page; readonly close: () => Promise<void>; readonly openedAt: number } | undefined;
  let closing: Promise<void> | undefined;
  /** Serializes turns: one browsing context, one turn using it. */
  let queue: Promise<unknown> = Promise.resolve();

  const ensureSession = async (): Promise<{ page: Page }> => {
    if (session) return session;
    const storageState = readVerifiedStorageState(provider);
    const opened = await openPage(storageState);
    session = { page: opened.page, close: opened.close, openedAt: now() };
    return session;
  };

  const closeSession = async (): Promise<void> => {
    const current = session;
    session = undefined;
    if (!current) return;
    try {
      await current.close();
    } catch (error) {
      console.warn(
        `[deepseek-web] session page teardown failed ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
      );
    }
  };

  return {
    id: `deepseek-web:session:${provider.accountFingerprint.slice(0, 12)}`,

    async ready(): Promise<void> {
      // Order matters: the credential check is synchronous and free, so a deployment without a
      // session never launches a browser to discover it.
      if (!deepSeekSessionVerified(provider.storageStatePath)) readVerifiedStorageState(provider);
      try {
        await ensureSession();
      } catch (error) {
        // A page that could not prove readiness is never reused: the next attempt launches a fresh
        // context instead of trusting a half-broken one. The failure is rethrown unchanged.
        await closeSession();
        throw error;
      }
    },

    async run<T>(body: (facility: DeepSeekTurnRequestFacility) => Promise<T>): Promise<T> {
      const turn = queue.then(async () => {
        const current = await ensureSession();
        return await body(createDeepSeekPageRequestFacility(current.page, {
          ...(options.proofOfWork === undefined ? {} : { requestProofOfWork: options.proofOfWork }),
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        }));
      });
      // The queue never rejects for the next caller: a failed turn must not poison the page.
      queue = turn.then(() => undefined, () => undefined);
      return await turn;
    },

    async close(): Promise<void> {
      closing ??= closeSession();
      await closing;
      closing = undefined;
    },
  };
}
