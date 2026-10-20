/**
 * The Qwen Code session page: the one transport resource this provider owns (issue #299, slice 2).
 *
 * ## Why a page at all
 *
 * Qwen Code is a **network** provider (`doc/qwen-code.md` §2): every authenticated call carries the
 * app's cookies *and* the `authorization: Bearer <token>` header its own token manager builds from
 * `localStorage`. A cookie-jar request from Node would be a request the page never makes — that is
 * exactly the live `import_predicate_failed` of slice 1. The session is therefore held by a real
 * browsing context seeded with the verified capture, and every request is issued from inside it
 * (`createQwenPageRequestFacility`), same-origin, with the page's own token read at call time.
 *
 * ## Why there is no retained surface, and what that means for continuity
 *
 * This page is **not** keyed by conversation and is never the identity of one. It exists for one
 * reason: to hold the session. Continuity lives in the chat id (`chat-state.ts`), so the ChatGPT
 * adapter's whole `retained_surface_lost` family of failures has no counterpart here: nothing of a
 * conversation is retained locally, so nothing of it can be evicted, and a turn after a restart
 * continues the same chat through the durable chat state.
 *
 * The page is still a physical resource and is owned exclusively: one turn at a time uses it, and a
 * second turn waits its turn instead of racing the same browsing context. That is a resource
 * queue, not a retry authority — the exchange still decides what a failure means.
 *
 * ## Session readiness is pre-submission
 *
 * `ready()` proves the deployment holds a verified session *and* that the live page restored its own
 * token. Both are checks that happen **before** any text could be sent, which is what makes an
 * unauthenticated turn a retry-safe `AUTH_REQUIRED` failure with zero send attempts instead of a
 * mystery. The message names the operator's next action (the sign-in surface), never a cookie.
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
  QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CODE_ROOT_URL,
} from "./provider";
import { qwenCodeAuthLaunchArgs } from "./auth-controller";
import {
  createQwenPageRequestFacility,
  type QwenTurnRequestFacility,
} from "./network-turn";
import { awaitQwenPageSession } from "./session-probe";
import { qwenCodeSessionVerified, type QwenCodeProviderConfig } from "./provider-config";

/** The operator's next action when no usable session exists. Never a cookie, never a token. */
export const QWEN_CODE_SIGN_IN_INSTRUCTION =
  "Sign in to Qwen Code at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Code\"), "
  + "or import a capture with `auth import --provider qwen-code`";

/** One opened provider page and the only handle that may close it. */
export interface QwenCodeSessionPage {
  readonly page: Page;
  close(): Promise<void>;
}

/** Opens the provider's app on a verified capture. Injected by tests; production launches Chromium. */
export type QwenCodeSessionPageOpener = (storageState: unknown) => Promise<QwenCodeSessionPage>;

/**
 * What a transport needs from the session: readiness, one exclusive turn on the page, and release.
 *
 * It deliberately exposes no page, cookie or token: a transport asks for the *facility*, which issues
 * the requests with the page's own credentials.
 */
export interface QwenCodeRequestSession {
  /** Stable identity, for diagnostics. */
  readonly id: string;
  /** Prove an authenticated session is usable. A rejection happens before anything is submitted. */
  ready(): Promise<void>;
  /**
   * Run one turn's requests while holding the page exclusively.
   *
   * `body` receives the request facility and must use it for every call of the turn. The page is
   * released when `body` settles, whatever the outcome.
   */
  run<T>(body: (facility: QwenTurnRequestFacility) => Promise<T>): Promise<T>;
  /** Release the browsing context. Idempotent. */
  close(): Promise<void>;
}

/** Options for {@link createQwenCodeBrowserSession}. */
export interface QwenCodeBrowserSessionOptions {
  /** The resolved provider facts (session path, executable). */
  readonly provider: QwenCodeProviderConfig;
  /** Test/in-process seam; production launches Chromium on the capture. */
  readonly openPage?: QwenCodeSessionPageOpener;
  /** Bounded wait for the app's own session restore. Defaults to the import path's bound. */
  readonly hydrationTimeoutMs?: number;
  /** Clock seam, for the diagnostics' own timing. */
  readonly now?: () => number;
}

/** Read the verified capture. Throws a typed, credential-free failure when it cannot be used. */
function readVerifiedStorageState(provider: QwenCodeProviderConfig): unknown {
  if (!qwenCodeSessionVerified(provider.storageStatePath)) {
    throw webChatError(
      "AUTH_REQUIRED",
      `Qwen Code has no verified session on this deployment. ${QWEN_CODE_SIGN_IN_INSTRUCTION}.`,
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_SESSION_MISSING" },
    );
  }
  try {
    return JSON.parse(readFileSync(provider.storageStatePath, "utf8")) as unknown;
  } catch (error) {
    throw webChatError(
      "AUTH_REQUIRED",
      `The stored Qwen Code session cannot be read (${nonSecretDiagnosticText(error)}). ${QWEN_CODE_SIGN_IN_INSTRUCTION}.`,
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_SESSION_UNREADABLE" },
    );
  }
}

/**
 * The default opener: launch Chromium on the capture and open the app shell.
 *
 * The launch shape is the repository's established headless set (`qwenCodeAuthLaunchArgs`), with no
 * user-agent override and no stealth flag: this provider's own app is served headless (slice 1
 * measured it), so nothing here disguises the browser. `storageState` seeds cookies *and* the app's
 * `localStorage`, which is where its token manager keeps its state.
 */
async function defaultOpenPage(
  provider: QwenCodeProviderConfig,
  storageState: unknown,
): Promise<QwenCodeSessionPage> {
  const browser: Browser = await chromium.launch({
    executablePath: provider.chromeExecutablePath,
    headless: false,
    args: qwenCodeAuthLaunchArgs({ headless: true, viewport: QWEN_CODE_AUTH_VIEWPORT }),
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      storageState: storageState as NonNullable<BrowserContextOptions["storageState"]>,
      viewport: { width: QWEN_CODE_AUTH_VIEWPORT.width, height: QWEN_CODE_AUTH_VIEWPORT.height },
    });
    const page = await context.newPage();
    await page.goto(QWEN_CODE_ROOT_URL, {
      waitUntil: "domcontentloaded",
      timeout: QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
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
      `The Qwen Code page could not be opened (${nonSecretDiagnosticText(error)}).`,
      {
        providerId: QWEN_CODE_PROVIDER_ID,
        providerCode: "QWEN_PAGE_OPEN_FAILED",
        cause: error,
      },
    );
  }
}

/**
 * A session backed by one lazily-opened browsing context, one turn at a time.
 *
 * @param options - the provider facts and the optional opener seam.
 * @returns the session a transport can ask for readiness and one exclusive turn.
 */
export function createQwenCodeBrowserSession(
  options: QwenCodeBrowserSessionOptions,
): QwenCodeRequestSession {
  const { provider } = options;
  const now = options.now ?? Date.now;
  const openPage: QwenCodeSessionPageOpener = options.openPage
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

  const hydrate = async (page: Page): Promise<void> => {
    const waited = await awaitQwenPageSession(page, {
      ...(options.hydrationTimeoutMs !== undefined ? { timeoutMs: options.hydrationTimeoutMs } : {}),
    });
    if (waited.read.accessToken !== undefined) return;
    const problem = waited.read.problem ?? "absent";
    throw webChatError(
      "AUTH_REQUIRED",
      `The Qwen Code session page is not signed in: after ${waited.waitedMs}ms the app still reports `
      + `${problem === "expired" ? "an expired token" : problem === "logged-out" ? "that it is signed out"
        : problem === "unreadable" ? "a token state it does not understand" : "no token"}. `
      + `${QWEN_CODE_SIGN_IN_INSTRUCTION}.`,
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "QWEN_SESSION_NOT_HYDRATED" },
    );
  };

  const closeSession = async (): Promise<void> => {
    const current = session;
    session = undefined;
    if (!current) return;
    try {
      await current.close();
    } catch (error) {
      console.warn(
        `[qwen-code] session page teardown failed ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
      );
    }
  };

  return {
    id: `qwen-code:session:${provider.accountFingerprint.slice(0, 12)}`,

    async ready(): Promise<void> {
      // Order matters: the credential check is synchronous and free, so a deployment without a
      // session never launches a browser to discover it.
      if (!qwenCodeSessionVerified(provider.storageStatePath)) readVerifiedStorageState(provider);
      try {
        const current = await ensureSession();
        await hydrate(current.page);
      } catch (error) {
        // A page that could not prove readiness is never reused: the next attempt launches a fresh
        // context instead of trusting a half-broken one. The failure is rethrown unchanged.
        await closeSession();
        throw error;
      }
    },

    async run<T>(body: (facility: QwenTurnRequestFacility) => Promise<T>): Promise<T> {
      const turn = queue.then(async () => {
        const current = await ensureSession();
        return await body(createQwenPageRequestFacility(current.page));
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
