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
 * `import_predicate_failed`. So this module:
 *
 * 1. opens the provider's own page in a context seeded with the capture (cookies **and**
 *    `localStorage`),
 * 2. reads the token **from the capture at call time**, assembles the app's own header shape, and
 * 3. issues the request from inside that page through the provider-neutral
 *    `requestInPageContext`, so origin, referer, cookies and `Sec-Fetch-*` are the page's.
 *
 * No token is ever read from code, configuration or a fixture, and none is logged or returned. When
 * the capture carries no usable token, the refusal says exactly that — and still reports what the
 * provider answered — instead of failing generically.
 */
import { chromium, type BrowserContextOptions } from "playwright-core";
import {
  QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_ROOT_URL,
} from "./provider";
import { qwenCodeAuthLaunchArgs, qwenTaskListAuthenticated } from "./auth-controller";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import {
  createQwenPageTaskListSender,
  probeQwenTaskListFromCapture,
  qwenTaskListProbeRefusal,
  type QwenAccessTokenProblem,
  type QwenAccessTokenSource,
  type QwenTaskListObservation,
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
  /** Whether the provider's own `authorization` header accompanied the request. */
  readonly sentAuthorization?: boolean;
  /** Where the token came from, for diagnostics. */
  readonly tokenSource?: QwenAccessTokenSource;
  /** Why no token was available, when that is the case. */
  readonly tokenProblem?: QwenAccessTokenProblem;
}

/**
 * The probe seam.
 *
 * Production injects nothing and gets the browser-page call below; the import test injects the same
 * assembly with a recording sender, so the header gate is asserted without a browser and without
 * network access.
 */
export type QwenCodeImportedSessionProbe = (storageState: unknown) => Promise<QwenCodeImportedSessionProbeResult>;

/** A verified imported session. Credential-free by construction. */
export interface QwenCodeImportedSessionVerification {
  readonly authenticated: true;
  /** The endpoint that proved it, for diagnostics. */
  readonly probe: "task-list";
  /** The HTTP status the endpoint answered. */
  readonly status: number;
}

/** Options for {@link verifyQwenCodeImportedSession}. */
export interface QwenCodeImportedSessionOptions {
  /** The configured Chrome executable. Only read by the default probe. */
  readonly chromeExecutablePath?: string;
  /** Probe override; tests inject the same assembly with a recording sender, so no browser starts. */
  readonly probe?: QwenCodeImportedSessionProbe;
}

/**
 * The default probe: open the provider's page on the captured state, then probe from inside it.
 *
 * Opening the page is what makes the request the page's own (same-origin `fetch`, the app's cookies
 * and `Referer`). It also applies the capture's `localStorage` to the origin, which is where the
 * provider keeps the token the API actually checks. Nothing about the page's markup is read.
 */
async function probeWithBrowser(
  storageState: unknown,
  chromeExecutablePath: string,
): Promise<QwenCodeImportedSessionProbeResult> {
  const browser = await chromium.launch({
    executablePath: chromeExecutablePath,
    // The repository's established headless shape: `--headless=new` travels in `args` (see
    // `qwenCodeAuthLaunchArgs`), and nothing here spoofs the user agent.
    headless: false,
    args: qwenCodeAuthLaunchArgs({ headless: true, viewport: QWEN_CODE_AUTH_VIEWPORT }),
  });
  try {
    const context = await browser.newContext({
      storageState: storageState as NonNullable<BrowserContextOptions["storageState"]>,
      viewport: { width: QWEN_CODE_AUTH_VIEWPORT.width, height: QWEN_CODE_AUTH_VIEWPORT.height },
    });
    try {
      const page = await context.newPage();
      try {
        await page.goto(QWEN_CODE_ROOT_URL, {
          waitUntil: "domcontentloaded",
          timeout: QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        // The capture is not judged here: failing to open the page is a transport failure, and it is
        // reported as one instead of being dressed up as "the session is not authenticated".
        throw new Error(
          `the provider's page could not be opened to issue the probe: ${nonSecretDiagnosticText(error)}`,
        );
      }
      const observation: QwenTaskListObservation = await probeQwenTaskListFromCapture(
        storageState,
        createQwenPageTaskListSender(page),
      );
      return {
        status: observation.status,
        payload: observation.payload,
        ...(observation.sentAuthorization === undefined
          ? {}
          : { sentAuthorization: observation.sentAuthorization }),
        ...(observation.tokenSource === undefined ? {} : { tokenSource: observation.tokenSource }),
        ...(observation.tokenProblem === undefined ? {} : { tokenProblem: observation.tokenProblem }),
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
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
    if (!options.chromeExecutablePath) {
      throw new Error("no Chrome executable is available for the session check; configure chromeExecutablePath");
    }
    return await probeWithBrowser(state, options.chromeExecutablePath);
  });

  const result = await probe(storageState);
  if (!qwenTaskListAuthenticated(result.payload)) {
    throw new Error(qwenTaskListProbeRefusal(result));
  }
  return { authenticated: true, probe: "task-list", status: result.status };
}
