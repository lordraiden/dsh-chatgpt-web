/**
 * Qwen Code interactive sign-in controller (issue #299, slice 1).
 *
 * The provider-side half of the optional interactive-authentication capability
 * (`src/web-chat/core/auth.ts`): it launches a disposable headless Chromium on a temporary profile,
 * navigates to `coder.qwen.ai`, relays the operator's inputs into it, and decides — **structurally,
 * through the provider's own API** — whether the browser now holds an authenticated session. It then
 * captures `storageState()` and owns where that capture lands.
 *
 * The host (`src/web-chat/host/auth-surface.ts`) is unchanged: it relays pixels and input and hands
 * the opaque capture back to this controller's `storeCapture`. No new surface, no second authority.
 *
 * Ownership boundaries (identical to the neutral contract's intent, not copied DOM logic):
 *
 * - **One temporary profile per sign-in.** Created under this provider's own credentials directory,
 *   never the managed runtime profile, and removed on *every* exit path: capture, cancel, timeout,
 *   input failure, and a launch that never came up.
 * - **The completion decision is an authenticated API call, not a page scrape.** `GET
 *   /coder/api/v2/task/list`, issued **from inside the provider's page** with the `authorization`
 *   header the page itself builds from its own localStorage token (see `session-probe.ts` and
 *   `doc/qwen-code.md` §4). Cookies alone are not how this provider authenticates: an anonymous
 *   caller gets HTTP 200 with `{ success: false, data: { code: "Unauthorized" } }`, so the check
 *   inspects `success`, not the status code. Text scraping was rejected — the SPA's signed-in and
 *   signed-out shells differ by more than a string this module should own.
 * - **No stealth.** The launch uses the repository's established headless shape (`--headless=new` in
 *   `args`, never `headless: true`) and the anti-automation pair both existing launch sites use. It
 *   deliberately does **not** override the user agent: a live probe of this provider showed the plain
 *   headless `HeadlessChrome` user agent reaching the full app shell and the login form (see
 *   `doc/qwen-code.md`), so a spoof would be an unearned workaround, and if this provider ever rejects
 *   headless the answer is `authBrowserMode: "display"` with an operator-supplied display, not a
 *   disguise.
 * - **Nothing here executes a turn.** This module signs in and stops; the turn-level proof lives in
 *   `network-turn.ts`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

import { providerCredentialsDir, type AppConfig } from "../../config";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import {
  AUTH_POINTER_GESTURE_TIMEOUT_MS,
  createAuthPointerGesture,
  type AuthPointerGesture,
} from "../auth-pointer-gesture";
import {
  isWebChatError,
  webChatError,
  type AuthCapture,
  type AuthInput,
  type AuthSessionState,
  type ProviderAuthController,
  type ProviderAuthSession,
  type ProviderAuthStoreResult,
  type ProviderAuthView,
  type ProviderAuthViewOptions,
} from "../../web-chat/core";
import {
  QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
  QWEN_CODE_AUTH_POLL_INTERVAL_MS,
  QWEN_CODE_AUTH_POLL_TIMEOUT_MS,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CODE_ROOT_URL,
  QWEN_CODE_TASK_LIST_PATH,
} from "./provider";
import {
  probeQwenTaskListFromPage,
  qwenTaskListAuthenticated,
  qwenTaskListProbeRefusal,
  qwenTaskListRefusal,
} from "./session-probe";
import { sanitizeQwenStorageState, storeQwenSession } from "./session-store";

// The task-list predicates and their refusal vocabulary live with the probe that reads the answer
// (`session-probe.ts`); re-exported here so this module's long-standing public surface is unchanged.
export { qwenTaskListAuthenticated, qwenTaskListRefusal };

/** The frame geometry the sign-in browser is launched with (re-exported for the surface). */
export type QwenCodeAuthViewport = { readonly width: number; readonly height: number };

/**
 * The pacing bounds of one drag replay.
 *
 * The operator's sampled path carries each point's offset from the press, so the replay is scheduled
 * against the press's own clock: before moving to a sample, wait only what is LEFT of its offset after
 * the time already spent (including every previous CDP move) is subtracted. Sleeping the raw delta
 * again is the double payment that stretched a ~1 s gesture into several seconds, because one
 * `page.mouse.move` already costs about a frame (measured at ~17 ms on the reference host).
 *
 * Two bounds keep a synchronous relay request finite. No single wait may exceed
 * {@link AUTH_DRAG_MAX_GAP_MS}, so a held-still pause cannot stall the sign-in; and pacing stops once
 * {@link AUTH_DRAG_REPLAY_BUDGET_MS} of wall time has been spent, after which the remaining samples
 * are still delivered in order with no wait. Every sampled position is always delivered, and the
 * release sample is always the last `mouse.move` before `mouse.up()` — the budget never skips a move,
 * it only stops waiting.
 */
const AUTH_DRAG_MAX_GAP_MS = 250;
const AUTH_DRAG_REPLAY_BUDGET_MS = 1_000;

/** Everything the browser launcher needs, and nothing it does not. */
export interface QwenCodeAuthBrowserLaunch {
  /** The configured Chrome executable. */
  readonly executablePath: string;
  /** `true` for the `--headless=new` launch; `false` for `display` (operator-supplied display). */
  readonly headless: boolean;
  /** The disposable profile directory this session owns. */
  readonly profileDir: string;
  /** The frame geometry the page must report. */
  readonly viewport: QwenCodeAuthViewport;
  /** The page to open (the public app shell). */
  readonly url: string;
}

/**
 * One live sign-in browser, as the controller uses it.
 *
 * The handle owns the browser transport; the controller owns the profile directory around it.
 * `storageState()` is the opaque capture read at the moment the authenticated check succeeds.
 */
export interface QwenCodeAuthBrowserHandle {
  readonly page: Page;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

/** Starts one sign-in browser. Injected by tests so the suite never needs a real browser. */
export type QwenCodeAuthBrowserLauncher =
  (launch: QwenCodeAuthBrowserLaunch) => Promise<QwenCodeAuthBrowserHandle>;

/** What an authenticated probe found. Credential-free by construction. */
export interface QwenCodeSessionProbeResult {
  /** Always `true` when the probe resolves; an unauthenticated session rejects instead. */
  readonly authenticated: true;
  /** The endpoint that proved it, for diagnostics. */
  readonly probe: "task-list";
  /** The HTTP status the endpoint answered. */
  readonly status: number;
}

/**
 * Reads the authenticated session.
 *
 * Resolves once an authenticated API call succeeds; rejects (with no state change) while the operator
 * still has to sign in, or when the browser is gone. Rejections are turned into a sanitized detail by
 * the session, so a probe may throw freely.
 */
export type QwenCodeSessionProbe = (page: Page) => Promise<QwenCodeSessionProbeResult>;

/** Persists one captured session; returns where it landed. */
export type QwenCodeSessionStore = (storageState: unknown) => string;

/** One-shot completion seam: a session is on disk. */
export type QwenCodeAuthSessionStored = (location: string) => void;

/** Construction options for {@link createQwenCodeAuthController}. */
export interface QwenCodeAuthControllerOptions {
  /** The deployment facts this controller needs: the executable and the launch mode. */
  readonly config: Pick<AppConfig, "chromeExecutablePath" | "authBrowserMode">;
  /** Where a disposable profile is created. Defaults to this provider's credentials directory. */
  readonly profileRoot?: string;
  /** The frame geometry. Defaults to {@link QWEN_CODE_AUTH_VIEWPORT}. */
  readonly viewport?: QwenCodeAuthViewport;
  /** Poll cadence while the operator works. Defaults to {@link QWEN_CODE_AUTH_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** How long a live pointer gesture may go silent before its button is released. Default 10 s. */
  readonly gestureTimeoutMs?: number;
  /** How long a sign-in may take before it reports `failed`. Default 8 minutes. */
  readonly pollTimeoutMs?: number;
  /** Optional hard cap on polling attempts, independent of the time bound. */
  readonly maxPolls?: number;
  /** Navigation timeout. Defaults to {@link QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS}. */
  readonly navigationTimeoutMs?: number;
  /** Clock seam; tests inject one so the time bound needs no real time. */
  readonly now?: () => number;
  /** Sleep seam; tests inject one that resolves immediately. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Existence seam for the configured executable; tests inject one. */
  readonly fileExists?: (path: string) => boolean;
  /** Profile-directory creation seam; tests inject one so no filesystem is touched. */
  readonly createProfile?: (root: string) => string;
  /** Profile-directory removal seam; tests spy on it. */
  readonly removeProfile?: (dir: string) => void;
  /** Browser launcher. Defaults to a headless Chromium persistent context. */
  readonly openBrowser?: QwenCodeAuthBrowserLauncher;
  /** Authenticated-session probe. Defaults to the real task-list API call. */
  readonly probeSession?: QwenCodeSessionProbe;
  /** Session store. Defaults to {@link storeQwenSession}. */
  readonly storeSession?: QwenCodeSessionStore;
  /** The one-shot completion hook, called once the session is on disk. */
  readonly afterSessionStored?: QwenCodeAuthSessionStored;
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  // Never a reason for the process to stay alive: the listener socket or the operator's stream is.
  timer.unref?.();
});

const defaultCreateProfile = (root: string): string => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  const dir = mkdtempSync(join(root, "qwen-auth-browser-"));
  try { chmodSync(dir, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  return dir;
};

const defaultRemoveProfile = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

/**
 * The exact Chromium switches the sign-in launch uses.
 *
 * Pure and exported so the flag set is asserted without a browser. `--headless=new` is requested in
 * `args` (the repository's established shape), `display` mode simply drops it, and **no user agent is
 * overridden** — a live probe showed the plain headless user agent is served the full app shell and
 * the login form, so there is nothing to disguise.
 */
export function qwenCodeAuthLaunchArgs(
  launch: Pick<QwenCodeAuthBrowserLaunch, "headless" | "viewport">,
): string[] {
  return [
    ...(launch.headless ? ["--headless=new"] : []),
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${launch.viewport.width},${launch.viewport.height}`,
  ];
}

/**
 * The default launch: a persistent Chromium context on the disposable profile.
 *
 * `headless: false` plus `--headless=new` is the repository's established headless shape (see
 * `ensureManagedBrowser` and the ChatGPT sign-in controller); Playwright's own `headless: true` is
 * deliberately not used so the flag set stays identical to the other launch sites.
 */
async function defaultOpenBrowser(launch: QwenCodeAuthBrowserLaunch): Promise<QwenCodeAuthBrowserHandle> {
  const context = await chromium.launchPersistentContext(launch.profileDir, {
    executablePath: launch.executablePath,
    headless: false,
    viewport: { width: launch.viewport.width, height: launch.viewport.height },
    args: qwenCodeAuthLaunchArgs(launch),
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(launch.url, {
      waitUntil: "domcontentloaded",
      timeout: QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
    });
    return {
      page,
      // The profile only ever had a reason to hold Qwen Code state; the same filter the capture
      // writer applies is applied here too, so no IdP cookie can leak into the capture.
      storageState: async () => sanitizeQwenStorageState(await context.storageState()),
      close: async () => { await context.close(); },
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/**
 * The default probe: the one authenticated endpoint, issued **from inside the provider's page** with
 * the token the page itself keeps (issue #299).
 *
 * The recorded HAR settles how this provider authenticates: the app's API calls carry
 * `authorization: Bearer <token>` beside the cookies, and that token is what its own token manager
 * persists in `localStorage` (see `session-probe.ts`). A cookie-only call from a request context is
 * not the page's behaviour — it is exactly the `import_predicate_failed` shape — so the probe reads
 * the page's token at call time, assembles the app's header shape, and runs the request in the page's
 * browsing context. The token is never logged, never returned, and never taken from a constant.
 */
async function defaultProbeSession(page: Page): Promise<QwenCodeSessionProbeResult> {
  const observation = await probeQwenTaskListFromPage(page);
  if (!qwenTaskListAuthenticated(observation.payload)) {
    throw new Error(qwenTaskListProbeRefusal(observation));
  }
  return { authenticated: true, probe: "task-list", status: observation.status };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`A Qwen Code sign-in controller requires a positive ${label}`);
  }
  return value;
}

function assertViewport(viewport: QwenCodeAuthViewport): QwenCodeAuthViewport {
  if (!viewport || !Number.isSafeInteger(viewport.width) || viewport.width < 1
    || !Number.isSafeInteger(viewport.height) || viewport.height < 1) {
    throw new TypeError("A Qwen Code sign-in controller requires a positive viewport");
  }
  return { width: viewport.width, height: viewport.height };
}

/** The controller-internal view of the shared configuration the session needs. */
interface QwenCodeAuthControllerOwner {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly viewport: QwenCodeAuthViewport;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly maxPolls: number;
  readonly navigationTimeoutMs: number;
  readonly gestureTimeoutMs: number;
  readonly removeProfile: (dir: string) => void;
  readonly probeSession: QwenCodeSessionProbe;
  storageState(handle: QwenCodeAuthBrowserHandle): Promise<unknown>;
  /** Remember the capture so `storeCapture` can prove this controller produced it. */
  recordCapture(storageState: unknown): void;
}

/** One Qwen Code sign-in. Owns the browser, the temporary profile and the completion decision. */
class QwenCodeAuthSession implements ProviderAuthSession {
  readonly providerId = QWEN_CODE_PROVIDER_ID;

  #state: AuthSessionState = "starting";
  #failureDetail: string | undefined;
  #page: Page | undefined;
  #pointer: AuthPointerGesture | undefined;
  #handle: QwenCodeAuthBrowserHandle | undefined;
  #profileDir: string | undefined;
  #storageState: unknown;
  #settled = false;
  #teardownRun: Promise<void> | undefined;
  #polls = 0;
  #deadline = 0;
  /** The last failed probe's sanitized reason; surfaced only when the session hits its bound. */
  #lastProbeDetail: string | undefined;

  constructor(private readonly owner: QwenCodeAuthControllerOwner) {}

  /** Called by the controller once the browser is up, to begin the interactive lifecycle. */
  begin(handle: QwenCodeAuthBrowserHandle, profileDir: string): void {
    this.#handle = handle;
    this.#page = handle.page;
    this.#profileDir = profileDir;
    this.#pointer = createAuthPointerGesture({
      move: (x, y) => handle.page.mouse.move(x, y),
      down: () => handle.page.mouse.down(),
      up: () => handle.page.mouse.up(),
    }, { providerId: QWEN_CODE_PROVIDER_ID, timeoutMs: this.owner.gestureTimeoutMs });
    this.#deadline = this.owner.now() + this.owner.pollTimeoutMs;
    this.#state = "awaiting_input";
    void this.#poll();
  }

  state(): AuthSessionState {
    return this.#state;
  }

  detail(): string | undefined {
    return this.#failureDetail;
  }

  async view(options?: ProviderAuthViewOptions): Promise<ProviderAuthView> {
    const page = this.#livePage("relay a frame");
    const size = this.#viewportOf(page);
    if (options?.quality === "fast") {
      // A live drag is watched, not read: a JPEG at low quality costs a fraction of the PNG to encode,
      // which is what makes 10-15 frames per second affordable. The idle frame stays lossless — the
      // sign-in page is also where the operator reads a one-time code or an error message.
      const jpeg = await page.screenshot({ type: "jpeg", quality: 55, caret: "initial" });
      return { png: jpeg, width: size.width, height: size.height, mimeType: "image/jpeg" };
    }
    // `caret: "initial"` keeps the focused-field caret visible in the relayed pixels, exactly like the
    // ChatGPT sign-in: without it the operator cannot tell that a click focused the email field.
    const png = await page.screenshot({ type: "png", caret: "initial" });
    return { png, width: size.width, height: size.height };
  }

  async input(event: AuthInput): Promise<void> {
    const page = this.#livePage("accept input");
    try {
      await this.#relayInput(page, event);
    } catch (error) {
      throw this.#inputFailure(page, error);
    }
  }

  /**
   * Relay one validated input into the page.
   *
   * The refused intent (`UNSUPPORTED_OPTION`), the malformed event (`TypeError`) and the failed
   * navigation intent (`TRANSPORT_UNAVAILABLE`) are decided here and rethrown unchanged by
   * {@link #inputFailure}; only an interaction that throws something else is an unexpected page or
   * browser failure.
   */
  async #relayInput(page: Page, event: AuthInput): Promise<void> {
    switch (event.type) {
      case "click": {
        const size = this.#viewportOf(page);
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)
          || event.x < 0 || event.y < 0 || event.x >= size.width || event.y >= size.height) {
          // Never click at random: an out-of-frame coordinate is refused, not clamped.
          throw webChatError(
            "UNSUPPORTED_OPTION",
            `The sign-in click (${event.x}, ${event.y}) is outside the ${size.width}x${size.height} viewport`,
            { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "AUTH_CLICK_OUT_OF_VIEWPORT" },
          );
        }
        await page.mouse.click(event.x, event.y);
        return;
      }
      case "drag": {
        const size = this.#viewportOf(page);
        const points = event.points;
        if (!Array.isArray(points) || points.length < 2) {
          // A drag is a pressed pointer moved along a path: one point (or none) is not one, and
          // pressing somewhere to guess at the rest would be motion the operator never made.
          throw new TypeError("A drag input must carry an ordered path of at least two points");
        }
        let previousAtMs = 0;
        for (const point of points) {
          if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)
            || point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) {
            // Never clamp a sample: a clamped path is a different gesture than the one drawn, so an
            // out-of-frame point refuses the whole drag exactly like an out-of-frame click.
            throw webChatError(
              "UNSUPPORTED_OPTION",
              `The sign-in drag point (${point?.x}, ${point?.y}) is outside the `
              + `${size.width}x${size.height} viewport`,
              { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "AUTH_DRAG_OUT_OF_VIEWPORT" },
            );
          }
          if (!Number.isFinite(point.atMs) || point.atMs < previousAtMs) {
            throw new TypeError("A drag path must carry ordered, finite sample times");
          }
          previousAtMs = point.atMs;
        }
        // Press at the operator's own start, replay every sampled point in the order it was drawn,
        // and release at the end. The samples themselves are the motion: no interpolation, no
        // synthetic path, and `page.mouse.move` is called once per sample with no `steps`.
        const start = points[0]!;
        const startedAt = this.owner.now();
        let pressed = false;
        try {
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          pressed = true;
          for (let index = 1; index < points.length; index += 1) {
            const point = points[index]!;
            // Schedule against the press, not against the previous sample: `elapsed` already includes
            // every previous move's CDP cost, so `atMs - elapsed` is the remainder only. When moves are
            // already slower than the operator's cadence this is zero and no time is paid twice; when
            // they are faster, the wait restores the operator's rhythm.
            const elapsed = this.owner.now() - startedAt;
            const remainingBudget = Math.max(0, AUTH_DRAG_REPLAY_BUDGET_MS - elapsed);
            const due = Math.max(0, point.atMs - elapsed);
            const pause = Math.min(due, AUTH_DRAG_MAX_GAP_MS, remainingBudget);
            if (pause > 0) await this.owner.sleep(pause);
            // Every sample is delivered, in order; the last one is the release. The budget never
            // skips a move — it only stops waiting — so an exhausted gesture still lands.
            await page.mouse.move(point.x, point.y);
          }
        } finally {
          // The button is down from `down()` until here, so it is released on every path — a failed
          // replay must not leave the provider's page with a held button that poisons later inputs.
          if (pressed) {
            try { await page.mouse.up(); } catch { /* the failure being reported is the real one */ }
          }
        }
        return;
      }
      case "pointer-down":
      case "pointer-move":
      case "pointer-up": {
        const size = this.#viewportOf(page);
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)
          || event.x < 0 || event.y < 0 || event.x >= size.width || event.y >= size.height) {
          // Never clamp a sample: a clamped path is a different gesture than the one drawn.
          throw webChatError(
            "UNSUPPORTED_OPTION",
            `The sign-in pointer (${event.x}, ${event.y}) is outside the `
            + `${size.width}x${size.height} viewport`,
            { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "AUTH_POINTER_OUT_OF_VIEWPORT" },
          );
        }
        // The gesture owns the pressed button across requests: `down` presses, each `move` is one
        // real sample applied on arrival, and `up` moves to the exact release and lifts. A move or
        // release with no open gesture is the helper's typed refusal. Any failure lifts the button
        // before it is reported, so a dead page can never leave the provider's mouse held down.
        const pointer = this.#livePointer();
        try {
          if (event.type === "pointer-down") await pointer.down(event.x, event.y);
          else if (event.type === "pointer-move") await pointer.move(event.x, event.y);
          else await pointer.up(event.x, event.y);
        } catch (error) {
          await pointer.release();
          throw error;
        }
        return;
      }
      case "pointer-cancel":
        // A cancelled gesture (pointercancel, a lost capture) lifts where the pointer is; it never
        // pretends a release happened at a position the operator did not choose.
        await this.#livePointer().cancel();
        return;
      case "type":
        await page.keyboard.type(event.text);
        return;
      case "key":
        await page.keyboard.press(event.key);
        return;
      case "scroll":
        await page.mouse.wheel(0, event.dy);
        return;
      case "navigate":
        try {
          await page.goto(event.url, {
            waitUntil: "domcontentloaded",
            timeout: this.owner.navigationTimeoutMs,
          });
        } catch (error) {
          throw webChatError(
            "TRANSPORT_UNAVAILABLE",
            `The sign-in browser could not follow the navigation intent: ${nonSecretDiagnosticText(error)}`,
            {
              providerId: QWEN_CODE_PROVIDER_ID,
              providerCode: "AUTH_NAVIGATION_FAILED",
              cause: error,
            },
          );
        }
        return;
      default:
        throw new TypeError("A WebChat auth input must be one of click, drag, pointer-down, pointer-move, pointer-up, pointer-cancel, type, key, scroll or navigate");
    }
  }

  /**
   * Translate an unexpected interaction failure into the upstream category the surface maps to 502.
   *
   * A page or browser that dies while an input is relayed must not escape as a raw Playwright error:
   * the interactive path has failed, no poll can recover it, so the session fails and releases the
   * browser and the temporary profile through the one teardown.
   */
  #inputFailure(page: Page, error: unknown): Error {
    if (isWebChatError(error) || error instanceof TypeError) return error;
    const detail = nonSecretDiagnosticText(error);
    if (page.isClosed()) {
      this.#fail("The sign-in browser closed while an input was being relayed");
      return webChatError(
        "UPSTREAM_ERROR",
        `The sign-in browser closed while an input was being relayed: ${detail}`,
        { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "AUTH_PAGE_CLOSED", cause: error },
      );
    }
    this.#fail(`The sign-in browser could not relay an input: ${detail}`);
    return webChatError(
      "UPSTREAM_ERROR",
      `The sign-in browser could not relay an input: ${detail}`,
      { providerId: QWEN_CODE_PROVIDER_ID, providerCode: "AUTH_INPUT_FAILED", cause: error },
    );
  }

  async capture(): Promise<AuthCapture> {
    if (this.#state !== "captured") {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `The ${QWEN_CODE_PROVIDER_ID} sign-in has not captured`,
        { providerId: QWEN_CODE_PROVIDER_ID },
      );
    }
    return { kind: "browser-storage", storageState: this.#storageState };
  }

  async cancel(): Promise<void> {
    if (!this.#settled && this.#state !== "captured" && this.#state !== "failed") {
      this.#state = "expired";
    }
    await this.#teardown();
  }

  /** The only place the browser and its temporary profile are released. Idempotent. */
  #teardown(): Promise<void> {
    if (!this.#teardownRun) {
      this.#settled = true;
      const handle = this.#handle;
      const profileDir = this.#profileDir;
      const pointer = this.#pointer;
      this.#page = undefined;
      this.#handle = undefined;
      this.#profileDir = undefined;
      this.#pointer = undefined;
      this.#teardownRun = (async () => {
        // A gesture that was still open is released before the browser is closed: capture, timeout,
        // cancellation and failure all pass through here, so no exit path can leave the button down.
        // A closed gesture has nothing to lift, and waiting on it would only delay the teardown.
        if (pointer) {
          if (pointer.pressed()) {
            try { await pointer.dispose(); } catch { /* the teardown below still runs */ }
          } else {
            void pointer.dispose();
          }
        }
        if (handle) {
          try { await handle.close(); } catch { /* the profile removal below still runs */ }
        }
        if (profileDir !== undefined) {
          try { this.owner.removeProfile(profileDir); } catch { /* best effort */ }
        }
      })();
    }
    return this.#teardownRun;
  }

  #fail(detail: string): void {
    if (this.#settled) return;
    this.#failureDetail = detail;
    this.#state = "failed";
    void this.#teardown();
  }

  /** The live page, or a typed refusal when the session can no longer serve the request. */
  #livePage(action: string): Page {
    if (this.#settled || !this.#page) {
      throw webChatError(
        "TRANSPORT_UNAVAILABLE",
        `The ${QWEN_CODE_PROVIDER_ID} sign-in browser is closed and cannot ${action}`,
        { providerId: QWEN_CODE_PROVIDER_ID },
      );
    }
    return this.#page;
  }

  #viewportOf(page: Page): QwenCodeAuthViewport {
    const size = page.viewportSize();
    if (size && size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
    return this.owner.viewport;
  }

  /** The one gesture helper, or a typed refusal if this session somehow has no live page. */
  #livePointer(): AuthPointerGesture {
    if (!this.#pointer) {
      throw webChatError(
        "TRANSPORT_UNAVAILABLE",
        `The ${QWEN_CODE_PROVIDER_ID} sign-in browser is closed and cannot relay a pointer gesture`,
        { providerId: QWEN_CODE_PROVIDER_ID },
      );
    }
    return this.#pointer;
  }

  /**
   * Bounded completion detection: sleep, then run the authenticated API probe once.
   *
   * The sleep is what keeps this off the CPU; the time/attempt bound is what makes a sign-in that
   * never authenticates report `failed` instead of polling forever. When the browser dies the session
   * fails immediately and tears down, so no poll can outlive its browser.
   */
  async #poll(): Promise<void> {
    while (!this.#settled) {
      await this.owner.sleep(this.owner.pollIntervalMs);
      if (this.#settled) return;
      if (this.#polls >= this.owner.maxPolls) {
        this.#fail(this.#timeoutDetail(
          `The Qwen Code session did not authenticate within ${this.owner.maxPolls} probes `
          + `(${QWEN_CODE_TASK_LIST_PATH})`,
        ));
        return;
      }
      if (this.owner.now() >= this.#deadline) {
        this.#fail(this.#timeoutDetail(
          `The Qwen Code session did not authenticate within ${this.owner.pollTimeoutMs}ms `
          + `(${QWEN_CODE_TASK_LIST_PATH})`,
        ));
        return;
      }
      this.#polls += 1;
      const page = this.#page;
      if (!page || page.isClosed()) {
        this.#fail("The sign-in browser closed before the sign-in completed");
        return;
      }
      this.#state = "verifying";
      try {
        await this.owner.probeSession(page);
      } catch (error) {
        if (this.#settled) return;
        if (page.isClosed()) {
          this.#fail("The sign-in browser closed before the sign-in completed");
          return;
        }
        // Not authenticated yet is the expected answer while the operator works; the loop simply
        // goes back to `awaiting_input` and waits again.
        this.#state = "awaiting_input";
        // The last probe's reason is kept: a session that never authenticates reports *why* (e.g. a
        // still-anonymous task list) instead of a bare timeout.
        this.#lastProbeDetail = nonSecretDiagnosticText(error);
        continue;
      }
      if (this.#settled) return;
      let storageState: unknown;
      try {
        storageState = await this.owner.storageState(this.#handle!);
      } catch (error) {
        this.#fail(`The sign-in completed but the session could not be read: ${nonSecretDiagnosticText(error)}`);
        return;
      }
      if (this.#settled) return;
      this.#storageState = storageState;
      this.owner.recordCapture(storageState);
      this.#state = "captured";
      await this.#teardown();
      return;
    }
  }

  /** The reason a bounded session reports: its own bound plus the last probe's answer. */
  #timeoutDetail(detail: string): string {
    return this.#lastProbeDetail === undefined ? detail : `${detail}; last probe: ${this.#lastProbeDetail}`;
  }
}

/**
 * Create the Qwen Code interactive sign-in controller.
 *
 * Construction is inert: no browser is started and no profile is created here. Only `startAuth()`
 * launches anything, so a listener can register this controller and still start with no browser.
 */
export function createQwenCodeAuthController(
  options: QwenCodeAuthControllerOptions,
): ProviderAuthController {
  if (!options || !options.config || typeof options.config.chromeExecutablePath !== "string") {
    throw new TypeError("A Qwen Code sign-in controller requires the deployment configuration");
  }
  const config = options.config;
  const profileRoot = options.profileRoot ?? providerCredentialsDir(QWEN_CODE_PROVIDER_ID);
  const viewport = assertViewport(options.viewport ?? QWEN_CODE_AUTH_VIEWPORT);
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? QWEN_CODE_AUTH_POLL_INTERVAL_MS,
    "poll interval",
  );
  const pollTimeoutMs = positiveInteger(
    options.pollTimeoutMs ?? QWEN_CODE_AUTH_POLL_TIMEOUT_MS,
    "poll timeout",
  );
  const maxPolls = options.maxPolls === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInteger(options.maxPolls, "probe attempt bound");
  const navigationTimeoutMs = positiveInteger(
    options.navigationTimeoutMs ?? QWEN_CODE_AUTH_NAVIGATION_TIMEOUT_MS,
    "navigation timeout",
  );
  const gestureTimeoutMs = positiveInteger(
    options.gestureTimeoutMs ?? AUTH_POINTER_GESTURE_TIMEOUT_MS,
    "pointer gesture timeout",
  );
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const fileExists = options.fileExists ?? existsSync;
  const createProfile = options.createProfile ?? defaultCreateProfile;
  const removeProfile = options.removeProfile ?? defaultRemoveProfile;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const probeSession = options.probeSession ?? defaultProbeSession;
  const storeSession = options.storeSession ?? storeQwenSession;
  const afterSessionStored = options.afterSessionStored;
  const headless = (config.authBrowserMode ?? "headless") === "headless";

  /**
   * The captures this controller produced, keyed by the opaque state object the host will hand back
   * to `storeCapture`. A WeakSet, so nothing outlives the capture it describes.
   */
  const captures = new WeakSet<object>();

  const owner: QwenCodeAuthControllerOwner = {
    now,
    sleep,
    viewport,
    pollIntervalMs,
    pollTimeoutMs,
    maxPolls,
    navigationTimeoutMs,
    gestureTimeoutMs,
    removeProfile,
    probeSession,
    async storageState(handle) {
      return await handle.storageState();
    },
    recordCapture(storageState) {
      if (storageState !== null && (typeof storageState === "object" || typeof storageState === "function")) {
        captures.add(storageState as object);
      }
    },
  };

  return {
    async startAuth(): Promise<ProviderAuthSession> {
      if (!config.chromeExecutablePath.trim() || !fileExists(config.chromeExecutablePath)) {
        // Fail closed from `startAuth`, not from startup: a listener may register this controller on a
        // host that has no Chrome yet, and the operator gets the actionable error on the one request
        // that needs a browser.
        throw webChatError(
          "TRANSPORT_UNAVAILABLE",
          `The interactive sign-in browser could not start: Chrome was not found at `
          + `${config.chromeExecutablePath.trim() || "(unset)"}`,
          {
            providerId: QWEN_CODE_PROVIDER_ID,
            providerCode: "CHROME_EXECUTABLE_MISSING",
          },
        );
      }
      const profileDir = createProfile(profileRoot);
      let handle: QwenCodeAuthBrowserHandle;
      try {
        handle = await openBrowser({
          executablePath: config.chromeExecutablePath,
          headless,
          profileDir,
          viewport,
          url: QWEN_CODE_ROOT_URL,
        });
      } catch (error) {
        // The profile is owned from the moment it exists, even when the browser never came up.
        try { removeProfile(profileDir); } catch { /* the launch failure is the error being reported */ }
        throw webChatError(
          "TRANSPORT_UNAVAILABLE",
          `The interactive sign-in browser could not start: ${nonSecretDiagnosticText(error)}`,
          {
            providerId: QWEN_CODE_PROVIDER_ID,
            providerCode: "BROWSER_LAUNCH_FAILED",
            cause: error,
          },
        );
      }
      const session = new QwenCodeAuthSession(owner);
      session.begin(handle, profileDir);
      return session;
    },

    async storeCapture(capture: AuthCapture): Promise<ProviderAuthStoreResult> {
      if (capture.kind !== "browser-storage") {
        // `opaque`/`none` are other providers' shapes; this controller produced nothing to write.
        return { stored: false };
      }
      const state = capture.storageState;
      if (state === null || typeof state !== "object" || !captures.has(state as object)) {
        throw webChatError(
          "CONVERSATION_STATE_MISMATCH",
          `The ${QWEN_CODE_PROVIDER_ID} sign-in controller was asked to store a capture it did not produce`,
          { providerId: QWEN_CODE_PROVIDER_ID },
        );
      }
      const location = storeSession(state);
      try {
        afterSessionStored?.(location);
      } catch (error) {
        // A host hook must never turn a stored sign-in into a failed one: the session is already
        // durable. It is still named, because a stale in-process fact is a real problem.
        console.warn(
          `[qwen-code] sign-in completion hook failed for ${QWEN_CODE_PROVIDER_ID} `
          + `(${nonSecretDiagnosticText(error)}); the stored session is unaffected`,
        );
      }
      return { stored: true, location };
    },
  };
}
