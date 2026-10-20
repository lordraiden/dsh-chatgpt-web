/**
 * Verify an *imported* Qwen Code capture before it is stored (issue #299).
 *
 * `auth import` adopts a session captured on the operator's own machine — the alternative to the
 * relayed sign-in page, for the flows whose risk engine refuses relayed (synthesised) input. The
 * file is not trusted: it is validated structurally by `session-store.ts`, then this module runs the
 * **same authenticated predicate the sign-in controller polls** (`GET /coder/api/v2/task/list`, whose
 * anonymous answer is HTTP 200 with `success:false`, so the status code cannot decide it).
 *
 * **How the probe authenticates (measured, issue #299).** The recorded HAR of the signed-in app shows
 * that this provider's API is not cookie-authenticated: every call carries
 * `authorization: Bearer <token>` beside the cookies, and the token is what the app persists in
 * `localStorage` (`session-probe.ts` documents the evidence and the key). A cookie-only call from a
 * request context is therefore not "how the page does it" — that is precisely the live
 * `import_predicate_failed`. The second live attempt carried a token state that said `loggedOut:
 * true`: a stale entry the operator's fresh profile had written, not the session the cookies hold.
 * So **the page, not the capture, is the authority for its own session**. This module:
 *
 * 1. opens the provider's own page in a context seeded with the capture (cookies **and**
 *    `localStorage`),
 * 2. waits — bounded, on the app's own observable state, never on a fixed sleep — for the app to
 *    restore its session from those cookies and install a usable token (the app's bootstrap resets a
 *    stale `loggedOut` state and refreshes its token with a cookie-authenticated call),
 * 3. reads the token **from the live page** at call time, assembles the app's own header shape, and
 * 4. issues the request from inside that page through the provider-neutral
 *    `requestInPageContext`, so origin, referer, cookies and `Sec-Fetch-*` are the page's.
 *
 * No token is ever read from code, configuration or a fixture, and none is logged or returned. When
 * the live page still has no usable token at the deadline, the refusal says exactly that — and still
 * reports what the provider answered — instead of failing generically or blaming the capture.
 */
import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright-core";
import {
  QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_ROOT_URL,
} from "./provider";
import { qwenCodeAuthLaunchArgs } from "./auth-controller";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import {
  probeQwenTaskListFromPageAfterHydration,
  qwenTaskListProbeRefusal,
  qwenTaskListVerdict,
  type QwenAccessTokenProblem,
  type QwenAccessTokenSource,
  type QwenPageHydrationOptions,
  type QwenPageSessionProgress,
  type QwenTaskListObservation,
  type QwenTaskListReadSource,
} from "./session-probe";

/**
 * What one imported-session probe observed. Never carries a credential.
 *
 * `sentAuthorization`/`tokenSource`/`tokenProblem` are optional so an injected probe seam may omit
 * them; the production probe always supplies them, and only then can the refusal name the token.
 */
export interface QwenCodeImportedSessionProbeResult {
  /** The HTTP status the endpoint answered (200 even when the body says unauthenticated). */
  readonly status: number;
  /** The parsed JSON body, or `undefined` when it was not JSON. */
  readonly payload: unknown;
  /** The answer's `content-type`, when the probe could observe it. Diagnostics only. */
  readonly contentType?: string;
  /** The answer's bounded raw body text, when the probe could observe it. Diagnostics only. */
  readonly bodyText?: string;
  /**
   * Whether the transport had to cut the body at its own bound before the body ended.
   *
   * `task/list` answers an account-sized chat list, so a cut is normal and may be a perfectly
   * authenticated answer. The verdict is then read from the leading envelope
   * (`session-probe.ts`, `qwenTaskListVerdict`), never from "this does not parse".
   */
  readonly truncated?: boolean;
  /** Whether the provider's own `authorization` header accompanied the request. */
  readonly sentAuthorization?: boolean;
  /** Where the token came from, for diagnostics. */
  readonly tokenSource?: QwenAccessTokenSource;
  /** Why no token was available, when that is the case. */
  readonly tokenProblem?: QwenAccessTokenProblem;
  /** What the bounded wait for the app's own session restore saw, when it ran. */
  readonly pageSession?: QwenPageSessionProgress;
}

/**
 * The probe seam.
 *
 * Production injects nothing and gets the browser-page call below; the import test injects the same
 * assembly with a recording sender, so the header gate is asserted without a browser and without
 * network access.
 */
export type QwenCodeImportedSessionProbe = (storageState: unknown) => Promise<QwenCodeImportedSessionProbeResult>;

/** One opened provider page, and the only handle that may close it. */
export interface QwenCodeImportedSessionPage {
  /** A page already on the provider's app shell, in the captured context. */
  readonly page: Page;
  /** Releases the page, its context and its browser (or whatever else the opener owns). Idempotent. */
  close(): Promise<void>;
}

/**
 * Open the provider's app on a captured session.
 *
 * A seam so the import tests drive the production composition with a simulated page; the default
 * opener is the Chromium launch below. The opener must hand back a page that is already on the app.
 */
export type QwenCodeImportedSessionPageOpener = (
  storageState: unknown,
) => Promise<QwenCodeImportedSessionPage>;

/** A verified imported session. Credential-free by construction. */
export interface QwenCodeImportedSessionVerification {
  readonly authenticated: true;
  /** The endpoint that proved it, for diagnostics. */
  readonly probe: "task-list";
  /** The HTTP status the endpoint answered. */
  readonly status: number;
  /**
   * Which reading authenticated the answer.
   *
   * `parsed-body` is the ordinary predicate over a complete body; `truncated-envelope` means the page
   * transport had to cut the answer at its bound and the leading `{success, data}` envelope decided.
   * The caller reports it, so a stored session never hides which reading won.
   */
  readonly read: QwenTaskListReadSource;
  /** How many characters of the answer were read, when the envelope decided a cut one. */
  readonly bodyChars?: number;
}

/** Options for {@link verifyQwenCodeImportedSession}. */
export interface QwenCodeImportedSessionOptions {
  /** The configured Chrome executable. Only read by the default page opener. */
  readonly chromeExecutablePath?: string;
  /** Probe override; tests inject the same assembly with a recording sender, so no browser starts. */
  readonly probe?: QwenCodeImportedSessionProbe;
  /** Page-opener override: tests supply a simulated page instead of launching Chromium. */
  readonly openPage?: QwenCodeImportedSessionPageOpener;
  /** The bounded wait for the app's own session restore. Defaults apply when omitted. */
  readonly hydration?: QwenPageHydrationOptions;
}

/**
 * The default page opener: launch Chromium on the captured state and open the app shell.
 *
 * Opening the page is what makes the request the page's own (same-origin `fetch`, the app's cookies
 * and `Referer`). It also applies the capture's `localStorage` to the origin, which is where the
 * provider's token manager keeps its state — including a stale `loggedOut` entry, which the app's own
 * bootstrap then repairs. Nothing about the page's markup is read.
 */
async function openBrowserPage(
  storageState: unknown,
  chromeExecutablePath: string,
): Promise<QwenCodeImportedSessionPage> {
  const browser = await chromium.launch({
    executablePath: chromeExecutablePath,
    // The repository's established headless shape: `--headless=new` travels in `args` (see
    // `qwenCodeAuthLaunchArgs`), and nothing here spoofs the user agent.
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
      `the provider's page could not be opened to issue the probe: ${nonSecretDiagnosticText(error)}`,
    );
  }
}

/** Wait for the app's own session restore, probe from the live page, and flatten the observation. */
async function probeOpenedPage(
  page: Page,
  hydration: QwenPageHydrationOptions | undefined,
): Promise<QwenCodeImportedSessionProbeResult> {
  const observation: QwenTaskListObservation = await probeQwenTaskListFromPageAfterHydration(
    page,
    hydration ?? {},
  );
  return {
    status: observation.status,
    payload: observation.payload,
    ...(observation.contentType === undefined ? {} : { contentType: observation.contentType }),
    ...(observation.bodyText === undefined ? {} : { bodyText: observation.bodyText }),
    ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
    ...(observation.sentAuthorization === undefined
      ? {}
      : { sentAuthorization: observation.sentAuthorization }),
    ...(observation.tokenSource === undefined ? {} : { tokenSource: observation.tokenSource }),
    ...(observation.tokenProblem === undefined ? {} : { tokenProblem: observation.tokenProblem }),
    ...(observation.pageSession === undefined ? {} : { pageSession: observation.pageSession }),
  };
}

/**
 * Prove that an imported capture is a live, authenticated session.
 *
 * Rejects with a non-secret diagnostic when the predicate says unauthenticated (or the browser
 * cannot be started). Nothing is written here: the caller stores only after this resolves.
 */
export async function verifyQwenCodeImportedSession(
  storageState: unknown,
  options: QwenCodeImportedSessionOptions = {},
): Promise<QwenCodeImportedSessionVerification> {
  const probe: QwenCodeImportedSessionProbe = options.probe ?? (async state => {
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
      return await probeOpenedPage(opened.page, options.hydration);
    } finally {
      await opened.close();
    }
  });

  const result = await probe(storageState);
  // The one verdict, shared with the sign-in controller's poll step: a complete body is decided by
  // the predicate, and a body the page transport had to cut is decided by its leading envelope. A
  // bound on how much of an account-sized answer is read must never be reported as "the provider
  // answered garbage" — that was the live `import_predicate_failed` of issue #299.
  const verdict = qwenTaskListVerdict(result);
  if (!verdict.authenticated) {
    throw new Error(qwenTaskListProbeRefusal(result));
  }
  return {
    authenticated: true,
    probe: "task-list",
    status: result.status,
    read: verdict.source ?? "parsed-body",
    ...(verdict.source === "truncated-envelope" && typeof result.bodyText === "string"
      ? { bodyChars: result.bodyText.length }
      : {}),
  };
}
