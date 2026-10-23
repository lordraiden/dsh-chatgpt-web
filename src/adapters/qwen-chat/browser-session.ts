/**
 * The Qwen Chat session page: the one transport resource this provider owns.
 *
 * ## Why a page at all
 *
 * `chat.qwen.ai` is a **network** provider, but not a Node-friendly one: its write paths are
 * anti-bot gated for anonymous callers (TMD/`x5sec` punish, `aliyun_waf`) and its page's own client
 * attaches an `authorization` header built from `localStorage` (recon §1.7–§1.8). A request issued
 * from Node would be a request the page never makes. The session is therefore held by a real
 * browsing context seeded with the verified capture, and every request is issued from inside it
 * (`createQwenChatPageRequestFacility`), same-origin, with the page's own token read at call time.
 *
 * ## No retained surface, so no eviction family
 *
 * This page is **not** keyed by conversation and is never the identity of one. It exists to hold the
 * session. Continuity lives in the chat id and cursor (`chat-state.ts`), so the ChatGPT adapter's
 * `retained_surface_lost` family has no counterpart here: nothing of a conversation is retained
 * locally, so nothing can be evicted, and a turn after a restart continues the same chat through the
 * durable chat state.
 *
 * The page is still a physical resource and is owned exclusively: one turn at a time uses it, and a
 * second turn waits its turn instead of racing the same browsing context. That is a resource queue,
 * not a retry authority — the exchange still decides what a failure means.
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

import { providerStorageStatePath } from "../../config";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { webChatError } from "../../web-chat/core";
import { qwenCodeAuthLaunchArgs } from "../qwen-code/auth-controller";
import { awaitQwenPageSession } from "../qwen-code/session-probe";
import {
  QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CHAT_AUTH_VIEWPORT,
  QWEN_CHAT_PROVIDER_ID,
  QWEN_CHAT_ROOT_URL,
} from "./provider";
import {
  createQwenChatPageRequestFacility,
  type QwenChatTurnRequestFacility,
} from "./network-turn";
import { qwenChatSessionVerified, type QwenChatProviderConfig } from "./provider-config";
import { sanitizeQwenChatStorageState, storeQwenChatSession } from "./session-store";

/** The operator's next action when no usable session exists. Never a cookie, never a token. */
export const QWEN_CHAT_SIGN_IN_INSTRUCTION =
  "Sign in to Qwen Chat at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Chat\"), "
  + "or import a capture made at https://chat.qwen.ai with `auth import --provider qwen-chat`";

/** One opened provider page and the only handle that may close it. */
export interface QwenChatSessionPage {
  readonly page: Page;
  /**
   * The session state the live page holds **now**, or a rejection when the context cannot answer.
   *
   * The app renews its access token with the stored `refresh_token` cookie, and the auth host rotates
   * that cookie when it does. The rotation exists only inside this browsing context, so asking the
   * context for its state is what lets the provider write the renewal back instead of restarting from
   * a snapshot the refresh already consumed. Optional so an injected test page stays valid.
   */
  storageState?(): Promise<unknown>;
  close(): Promise<void>;
}

/** Opens the provider's app on a verified capture. Injected by tests; production launches Chromium. */
export type QwenChatSessionPageOpener = (storageState: unknown) => Promise<QwenChatSessionPage>;

/**
 * What a transport needs from the session: readiness, one exclusive turn on the page, and release.
 *
 * It deliberately exposes no page, cookie or token: a transport asks for the *facility*, which issues
 * the requests with the page's own credentials.
 */
export interface QwenChatRequestSession {
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
  run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T>;
  /** Release the browsing context. Idempotent. */
  close(): Promise<void>;
}

/** Options for {@link createQwenChatBrowserSession}. */
export interface QwenChatBrowserSessionOptions {
  /** The resolved provider facts (session path, executable). */
  readonly provider: QwenChatProviderConfig;
  /** Test/in-process seam; production launches Chromium on the capture. */
  readonly openPage?: QwenChatSessionPageOpener;
  /** Bounded wait for the app's own session restore. Defaults to the import path's bound. */
  readonly hydrationTimeoutMs?: number;
  /** Clock seam, for the diagnostics' own timing. */
  readonly now?: () => number;
}

/** Read the verified capture. Throws a typed, credential-free failure when it cannot be used. */
function readVerifiedStorageState(provider: QwenChatProviderConfig): unknown {
  if (!qwenChatSessionVerified(provider.storageStatePath)) {
    throw webChatError(
      "AUTH_REQUIRED",
      `Qwen Chat has no verified session on this deployment. ${QWEN_CHAT_SIGN_IN_INSTRUCTION}.`,
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_SESSION_MISSING" },
    );
  }
  try {
    return JSON.parse(readFileSync(provider.storageStatePath, "utf8")) as unknown;
  } catch (error) {
    throw webChatError(
      "AUTH_REQUIRED",
      `The stored Qwen Chat session cannot be read (${nonSecretDiagnosticText(error)}). ${QWEN_CHAT_SIGN_IN_INSTRUCTION}.`,
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_SESSION_UNREADABLE" },
    );
  }
}

/**
 * The default opener: launch Chromium on the capture and open the app shell.
 *
 * The launch shape is the repository's established headless set (`qwenCodeAuthLaunchArgs`), with no
 * user-agent override and no stealth flag: the sibling Qwen app was measured to serve headless
 * normally, and a page-level challenge is the operator's to clear, not a disguise's to bypass.
 * `storageState` seeds cookies *and* `localStorage`, which is where the app's token manager keeps
 * its state.
 */
async function defaultOpenPage(
  provider: QwenChatProviderConfig,
  storageState: unknown,
): Promise<QwenChatSessionPage> {
  const browser: Browser = await chromium.launch({
    executablePath: provider.chromeExecutablePath,
    headless: false,
    args: qwenCodeAuthLaunchArgs({ headless: true, viewport: QWEN_CHAT_AUTH_VIEWPORT }),
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      storageState: storageState as NonNullable<BrowserContextOptions["storageState"]>,
      viewport: { width: QWEN_CHAT_AUTH_VIEWPORT.width, height: QWEN_CHAT_AUTH_VIEWPORT.height },
    });
    const page = await context.newPage();
    await page.goto(QWEN_CHAT_ROOT_URL, {
      waitUntil: "domcontentloaded",
      timeout: QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS,
    });
    const opened = context;
    return {
      page,
      async storageState() {
        return await opened.storageState();
      },
      async close() {
        try { await opened.close(); } finally { await browser.close(); }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw webChatError(
      "TRANSPORT_UNAVAILABLE",
      `The Qwen Chat page could not be opened (${nonSecretDiagnosticText(error)}).`,
      {
        providerId: QWEN_CHAT_PROVIDER_ID,
        providerCode: "QWEN_CHAT_PAGE_OPEN_FAILED",
        cause: error,
      },
    );
  }
}

/**
 * A captured entry, reduced to the stable ordering the comparison needs. Values are compared, never
 * printed: two states are "the same session material" when their provider-scoped cookies and their
 * `localStorage` entries match in a canonical order.
 */
function canonicalSessionState(value: unknown): string {
  const sanitized = sanitizeQwenChatStorageState(value);
  const cookies = (sanitized.cookies as readonly Record<string, unknown>[])
    .map(cookie => ({ ...cookie }))
    .sort((left, right) => {
      const order = `${String(left["domain"])}\u0000${String(left["name"])}\u0000${String(left["path"])}`;
      return order.localeCompare(`${String(right["domain"])}\u0000${String(right["name"])}\u0000${String(right["path"])}`);
    });
  const origins = sanitized.origins
    .map(origin => ({
      origin: origin.origin,
      localStorage: (origin.localStorage as readonly Record<string, unknown>[])
        .map(entry => ({ ...entry }))
        .sort((left, right) => String(left["name"]).localeCompare(String(right["name"]))),
    }))
    .sort((left, right) => left.origin.localeCompare(right.origin));
  return JSON.stringify({ cookies, origins });
}

/**
 * Write the live session back when the page renewed it (issue #333 follow-up, measured).
 *
 * The Qwen Chat capture's only refresh credential is the persistent `refresh_token` cookie. The app
 * renews its 15-minute access token with it, and the auth host rotates the cookie during that call.
 * The rotated value lives only in the browsing context; the file on disk keeps the consumed one, so
 * a restart (or any later context) cannot renew and the operator sees "no token after 20000ms" on a
 * session that worked an hour earlier.
 *
 * Persisting the live state fixes exactly that, with the deployment's **single** session writer
 * (`storeQwenChatSession` → `storeProviderSession`, same sanitizer, same marker) and only when the
 * state actually changed. It never writes on a failed hydration (the caller only reaches this after
 * `ready()` proved a token), never writes a state with no provider cookie, and never claims success
 * silently when the write itself fails.
 *
 * A deployment that configured its own `storageStatePath` for this provider is left alone: the one
 * writer owns `providers/<id>/storage-state.json`, and writing to a different file from here would
 * be a second layout authority.
 */
async function persistRenewedSession(
  provider: QwenChatProviderConfig,
  opened: QwenChatSessionPage,
): Promise<void> {
  if (opened.storageState === undefined) return;
  if (provider.storageStatePath !== providerStorageStatePath(QWEN_CHAT_PROVIDER_ID)) return;
  let live: unknown;
  try {
    live = await opened.storageState();
  } catch (error) {
    console.warn(
      `[qwen-chat] session_state_unreadable ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
    );
    return;
  }
  if (sanitizeQwenChatStorageState(live).cookies.length === 0) return;
  let stored: unknown;
  let storedUnknown = false;
  try {
    stored = JSON.parse(readFileSync(provider.storageStatePath, "utf8")) as unknown;
  } catch {
    storedUnknown = true;
  }
  if (!storedUnknown && stored !== undefined && canonicalSessionState(stored) === canonicalSessionState(live)) return;
  try {
    storeQwenChatSession(live);
    console.info(
      `[qwen-chat] session_state_persisted ${JSON.stringify({
        providerId: QWEN_CHAT_PROVIDER_ID,
        reason: storedUnknown ? "stored-state-unreadable" : stored === undefined ? "no-stored-state" : "renewed",
      })}`,
    );
  } catch (error) {
    // A write that fails must not fail the turn that just proved the session: the in-memory context
    // still works, and the operator's next action (renew) is unaffected. One honest line, no retry.
    console.warn(
      `[qwen-chat] session_state_persist_failed ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
    );
  }
}

/**
 * A session backed by one lazily-opened browsing context, one turn at a time.
 *
 * @param options - the provider facts and the optional opener seam.
 * @returns the session a transport can ask for readiness and one exclusive turn.
 */
export function createQwenChatBrowserSession(
  options: QwenChatBrowserSessionOptions,
): QwenChatRequestSession {
  const { provider } = options;
  const now = options.now ?? Date.now;
  const openPage: QwenChatSessionPageOpener = options.openPage
    ?? ((storageState: unknown) => defaultOpenPage(provider, storageState));

  let session:
    | { readonly page: Page; readonly close: () => Promise<void>; readonly openedAt: number; readonly storageState?: () => Promise<unknown> }
    | undefined;
  let closing: Promise<void> | undefined;
  /** Serializes turns: one browsing context, one turn using it. */
  let queue: Promise<unknown> = Promise.resolve();

  const ensureSession = async (): Promise<QwenChatSessionPage & { readonly openedAt: number }> => {
    if (session) return session;
    const storageState = readVerifiedStorageState(provider);
    const opened = await openPage(storageState);
    // The opener's own methods are kept bound to its object: an injected page may implement
    // `storageState()` as a method that reads its own state, and detaching it would break that.
    const readState = opened.storageState;
    session = {
      page: opened.page,
      close: () => opened.close(),
      openedAt: now(),
      ...(readState === undefined ? {} : { storageState: () => readState.call(opened) }),
    };
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
      `The Qwen Chat session page is not signed in: after ${waited.waitedMs}ms the app still reports `
      + `${problem === "expired" ? "an expired token" : problem === "logged-out" ? "that it is signed out"
        : problem === "unreadable" ? "a token state it does not understand" : "no token"}. `
      + `${QWEN_CHAT_SIGN_IN_INSTRUCTION}.`,
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_SESSION_NOT_HYDRATED" },
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
        `[qwen-chat] session page teardown failed ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
      );
    }
  };

  return {
    id: `qwen-chat:session:${provider.accountFingerprint.slice(0, 12)}`,

    async ready(): Promise<void> {
      // Order matters: the credential check is synchronous and free, so a deployment without a
      // session never launches a browser to discover it.
      if (!qwenChatSessionVerified(provider.storageStatePath)) readVerifiedStorageState(provider);
      try {
        const current = await ensureSession();
        await hydrate(current.page);
        // Hydration is the moment the app renews an expired access token, which rotates the stored
        // `refresh_token` cookie. Persist that renewal before the turn runs, so a crash afterwards
        // still leaves a session that can renew again.
        await persistRenewedSession(provider, current);
      } catch (error) {
        // A page that could not prove readiness is never reused: the next attempt launches a fresh
        // context instead of trusting a half-broken one. The failure is rethrown unchanged.
        await closeSession();
        throw error;
      }
    },

    async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
      const turn = queue.then(async () => {
        const current = await ensureSession();
        try {
          return await body(createQwenChatPageRequestFacility(current.page));
        } finally {
          // The turn's own requests can trigger a mid-turn renewal (`recoverAccessToken`); the state
          // that made the turn work is the state worth keeping. Best effort, and only when changed.
          await persistRenewedSession(provider, current);
        }
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
