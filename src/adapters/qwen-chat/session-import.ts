/**
 * Verify an *imported* Qwen Chat capture before it is stored.
 *
 * `auth import` adopts a session captured on the operator's own machine. The file is not trusted:
 * `session-store.ts` validates it structurally (including the per-domain cookie rule), then this
 * module runs the **same authenticated predicate the sign-in controller polls**
 * (`GET /api/v2/chats`, whose anonymous answer is HTTP 200 with `success:false`).
 *
 * The probe page is the authority for its own session, exactly as in the Qwen Code importer: the
 * capture is loaded into a browser context, the app is allowed a bounded amount of time to restore
 * its token from its own cookies, the token is read **from the live page** at call time, and the
 * request is issued from inside that page through the provider-neutral `requestInPageContext`.
 *
 * No token is ever read from code, configuration or a fixture, and none is logged or returned. When
 * the live page still has no usable token at the deadline, the refusal says exactly that.
 */
import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright-core";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { qwenCodeAuthLaunchArgs } from "../qwen-code/auth-controller";
import {
  QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CHAT_AUTH_VIEWPORT,
  QWEN_CHAT_CHATS_PATH,
  QWEN_CHAT_ROOT_URL,
} from "./provider";
import {
  probeQwenChatFromPageAfterHydration,
  qwenChatProbeRefusal,
  qwenChatProbeVerdict,
  type QwenAccessTokenProblem,
  type QwenChatProbeObservation,
  type QwenChatProbeReadSource,
} from "./session-probe";
import type { QwenPageHydrationOptions } from "../qwen-code/session-probe";

/** What one imported-session probe observed. Never carries a credential. */
export interface QwenChatImportedSessionProbeResult {
  /** The HTTP status the endpoint answered (200 even when the body says unauthenticated). */
  readonly status: number;
  /** The parsed JSON body, or the raw text when it was not JSON. */
  readonly payload: unknown;
  readonly contentType?: string;
  readonly bodyText?: string;
  readonly truncated?: boolean;
  readonly sentAuthorization?: boolean;
  readonly tokenProblem?: QwenAccessTokenProblem;
  readonly pageSession?: { readonly hydrated: boolean; readonly waitedMs: number };
}

/** The probe seam. */
export type QwenChatImportedSessionProbe = (storageState: unknown) => Promise<QwenChatImportedSessionProbeResult>;

/** One opened provider page, and the only handle that may close it. */
export interface QwenChatImportedSessionPage {
  readonly page: Page;
  close(): Promise<void>;
}

/** Opens the provider's app on a captured session. Injected by tests. */
export type QwenChatImportedSessionPageOpener = (
  storageState: unknown,
) => Promise<QwenChatImportedSessionPage>;

/** A verified imported session. Credential-free by construction. */
export interface QwenChatImportedSessionVerification {
  readonly authenticated: true;
  /** The endpoint that proved it, for diagnostics. */
  readonly probe: "chats";
  /** The HTTP status the endpoint answered. */
  readonly status: number;
  /** Which reading authenticated the answer (`parsed-body` or `truncated-envelope`). */
  readonly read: QwenChatProbeReadSource;
  /** How many characters of the answer were read, when the envelope decided a cut one. */
  readonly bodyChars?: number;
}

/** Options for {@link verifyQwenChatImportedSession}. */
export interface QwenChatImportedSessionOptions {
  /** The configured Chrome executable. Only read by the default page opener. */
  readonly chromeExecutablePath?: string;
  /** Probe override; tests inject the same assembly with a recording sender. */
  readonly probe?: QwenChatImportedSessionProbe;
  /** Page-opener override: tests supply a simulated page instead of launching Chromium. */
  readonly openPage?: QwenChatImportedSessionPageOpener;
  /** The bounded wait for the app's own session restore. */
  readonly hydration?: QwenPageHydrationOptions;
}

/**
 * The default page opener: launch Chromium on the captured state and open the app shell.
 *
 * Opening the page is what makes the request the page's own (same-origin `fetch`, the app's cookies
 * and `Referer`). It also applies the capture's `localStorage` to the origin, where the token
 * manager keeps its state. Nothing about the page's markup is read.
 */
async function openBrowserPage(
  storageState: unknown,
  chromeExecutablePath: string,
): Promise<QwenChatImportedSessionPage> {
  const browser = await chromium.launch({
    executablePath: chromeExecutablePath,
    // The repository's established headless shape: `--headless=new` travels in `args`, and nothing
    // here spoofs the user agent.
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
    const openedContext = context;
    return {
      page,
      async close() {
        try { await openedContext.close(); } finally { await browser.close(); }
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    // The capture is not judged here: failing to open the page is a transport failure, and it is
    // reported as one instead of being dressed up as "the session is not authenticated".
    throw new Error(
      `Qwen Chat's page could not be opened to issue the session check: ${nonSecretDiagnosticText(error)}`,
    );
  }
}

function flatten(observation: QwenChatProbeObservation): QwenChatImportedSessionProbeResult {
  return {
    status: observation.status,
    payload: observation.payload,
    ...(observation.contentType === undefined ? {} : { contentType: observation.contentType }),
    ...(observation.bodyText === undefined ? {} : { bodyText: observation.bodyText }),
    ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
    ...(observation.sentAuthorization === undefined ? {} : { sentAuthorization: observation.sentAuthorization }),
    ...(observation.tokenProblem === undefined ? {} : { tokenProblem: observation.tokenProblem }),
    ...(observation.pageSession === undefined ? {} : { pageSession: observation.pageSession }),
  };
}

/**
 * Prove that an imported capture is a live, authenticated Qwen Chat session.
 *
 * Rejects with a non-secret diagnostic when the predicate says unauthenticated (or the browser
 * cannot be started). Nothing is written here: the caller stores only after this resolves.
 */
export async function verifyQwenChatImportedSession(
  storageState: unknown,
  options: QwenChatImportedSessionOptions = {},
): Promise<QwenChatImportedSessionVerification> {
  const probe: QwenChatImportedSessionProbe = options.probe ?? (async state => {
    const openPage = options.openPage ?? (async (capture: unknown) => {
      if (!options.chromeExecutablePath) {
        throw new Error(
          "no Chrome executable is available for the session check; configure chromeExecutablePath",
        );
      }
      return await openBrowserPage(capture, options.chromeExecutablePath);
    });
    const opened = await openPage(state);
    try {
      return flatten(await probeQwenChatFromPageAfterHydration(opened.page, options.hydration ?? {}));
    } finally {
      await opened.close();
    }
  });

  const result = await probe(storageState);
  // The one verdict, shared with the sign-in controller's poll step: a complete body is decided by
  // the predicate, and a body the page transport had to cut is decided by its leading envelope.
  const verdict = qwenChatProbeVerdict({
    status: result.status,
    payload: result.payload,
    ...(result.bodyText === undefined ? {} : { bodyText: result.bodyText }),
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    ...(result.sentAuthorization === undefined ? {} : { sentAuthorization: result.sentAuthorization }),
    ...(result.tokenProblem === undefined ? {} : { tokenProblem: result.tokenProblem }),
  });
  if (!verdict.authenticated) {
    throw new Error(qwenChatProbeRefusal({
      status: result.status,
      payload: result.payload,
      ...(result.bodyText === undefined ? {} : { bodyText: result.bodyText }),
      ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
      ...(result.sentAuthorization === undefined ? {} : { sentAuthorization: result.sentAuthorization }),
      ...(result.tokenProblem === undefined ? {} : { tokenProblem: result.tokenProblem }),
    }));
  }
  return {
    authenticated: true,
    probe: "chats",
    status: result.status,
    read: verdict.source ?? "parsed-body",
    ...(verdict.source === "truncated-envelope" && typeof result.bodyText === "string"
      ? { bodyChars: result.bodyText.length }
      : {}),
  };
}

/** The endpoint the import probe proves, exported so a refusal can name it. */
export const QWEN_CHAT_IMPORT_PROBE_PATH = QWEN_CHAT_CHATS_PATH;
