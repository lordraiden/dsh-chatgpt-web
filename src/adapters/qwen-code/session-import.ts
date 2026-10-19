/**
 * Verify an *imported* Qwen Code capture before it is stored (issue #299).
 *
 * `auth import` adopts a session captured on the operator's own machine — the alternative to the
 * relayed sign-in page, for the flows whose risk engine refuses relayed (synthesised) input. The
 * file is not trusted: it is validated structurally by `session-store.ts`, then this module runs the
 * **same authenticated predicate the sign-in controller polls** (`GET /coder/api/v2/task/list`, whose
 * anonymous answer is HTTP 200 with `success:false`, so the status code cannot decide it).
 *
 * The browser is only the session holder, exactly as in `network-turn.ts`: the probe is issued from
 * the context that carries the captured cookies, so this module never reads, reconstructs or prints a
 * cookie value. The request facility's failure is reported by status and provider code only.
 */
import { chromium, type BrowserContextOptions } from "playwright-core";
import {
  QWEN_CODE_AUTH_PROBE_TIMEOUT_MS,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_TASK_LIST_PATH,
  qwenCodeApiHeaders,
  qwenCodeUrl,
} from "./provider";
import { qwenCodeAuthLaunchArgs, qwenTaskListAuthenticated, qwenTaskListRefusal } from "./auth-controller";

/** What one imported-session probe observed. Never carries a credential. */
export interface QwenCodeImportedSessionProbeResult {
  /** The HTTP status the endpoint answered (200 even when the body says unauthenticated). */
  readonly status: number;
  /** The parsed JSON body, or `undefined` when it was not JSON. */
  readonly payload: unknown;
}

/**
 * The probe seam.
 *
 * Production injects nothing and gets the browser-context call below; the import test injects a fake
 * payload, so the predicate gate is asserted without a browser and without network access.
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
  /** Probe override; tests inject a fake answer so no browser starts. */
  readonly probe?: QwenCodeImportedSessionProbe;
}

/** The default probe: the one authenticated endpoint, through the captured context's own cookies. */
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
      const response = await context.request.get(qwenCodeUrl(QWEN_CODE_TASK_LIST_PATH, { page: "1" }), {
        headers: qwenCodeApiHeaders(),
        timeout: QWEN_CODE_AUTH_PROBE_TIMEOUT_MS,
      });
      const status = response.status();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      return { status, payload };
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
    throw new Error(
      `the task list answered HTTP ${result.status} with ${qwenTaskListRefusal(result.payload)}; `
      + "sign in to Qwen Code again in the browser you captured from, export the session again, and re-run the import",
    );
  }
  return { authenticated: true, probe: "task-list", status: result.status };
}
