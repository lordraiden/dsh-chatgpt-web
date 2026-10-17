/**
 * ChatGPT Web interactive sign-in controller (issue #276, slice 2b).
 *
 * This is the provider-side half of the optional interactive-authentication capability
 * (`src/web-chat/core/auth.ts`): it starts a disposable Chromium, relays an operator's inputs into
 * it, decides when the ChatGPT surface is authenticated, and owns where the captured session lands.
 * The host (`src/web-chat/host/auth-surface.ts`) only relays pixels and input — it never navigates,
 * never reads a DOM, never speaks CDP and never persists a credential.
 *
 * Ownership boundaries:
 *
 * - **The browser and its temporary profile belong to one session.** `startAuth()` creates a fresh
 *   `mkdtemp` profile under the provider's own credentials directory — never the managed-chrome
 *   runtime profile — and the session releases both on `cancel()`, on a terminal failure, and once
 *   the sign-in is captured (the captured material is held privately, and the manager's cached frame
 *   still serves the last relayed pixels). Nothing is launched until `startAuth()`.
 * - **The controller owns the write.** `storeCapture()` calls the same `storeProviderSession` that
 *   `login`, the system-browser capture and `auth import` use, so there is still exactly one owner for
 *   "persist a ChatGPT session". The host is deliberately ignorant of the destination.
 * - **The controller also owns the account binding.** A captured session is only usable when the
 *   account it belongs to is recorded in the configuration, because the logical account identity of
 *   every turn is `config.accountIdentityFingerprint` (`src/adapters/chatgpt-web/index.ts`). Sign-in
 *   therefore reads the same `detectChatGptAuthenticatedAccountIdentity` probe `login` uses and, once
 *   the session is stored, persists its fingerprint through `persistAccountIdentityFingerprint`. The
 *   fingerprint is provider-side account binding, not captured material, so it stays out of the
 *   neutral `AuthCapture` the host relays.
 * - **The provider id is the catalogue id.** `CHATGPT_WEB_AUTH_PROVIDER_ID` mirrors
 *   `CHATGPT_WEB_DRIVER_ID` and is asserted equal in the contract tests, so the surface can never
 *   list a provider the catalogue does not have.
 * - **Nothing here is a second execution path for turns.** This module signs in and stops.
 *
 * Anti-automation flags follow the two launch sites already in the repository (`ensureManagedBrowser`
 * in `browser-worker.ts` and `loginToChatGpt` in `browser-login.ts`): a normal launch whose headless
 * mode is requested with `--headless=new` in `args` rather than Playwright's `headless: true`, plus
 * `--disable-blink-features=AutomationControlled`, `--no-first-run` and `--no-default-browser-check`.
 * `display` mode is the same launch without `--headless=new`, for a flow that rejects headless.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

import { persistAccountIdentityFingerprint, providerCredentialsDir, type AppConfig } from "../../config";
import {
  CHATGPT_CHAT_URL,
  assertAuthenticatedChatGptPage,
  assertChatGptPage,
  detectChatGptAccountCapabilities,
  detectChatGptAuthenticatedAccountIdentity,
} from "../../chatgpt-session";
import { sanitizeBrowserLoginStorageState, storeProviderSession } from "../../browser-login";
import type { ChatGptWebAccountCapabilities } from "../../chatgpt-web-models";
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
} from "../../web-chat/core";

/**
 * The provider id this controller is served under.
 *
 * Mirrors `CHATGPT_WEB_DRIVER_ID` (the catalogue route id) without importing the host boundary,
 * which would drag the host's conversation store into a provider leaf. The contract test asserts the
 * two are equal.
 */
export const CHATGPT_WEB_AUTH_PROVIDER_ID = "chatgpt-web";

/** The operator-facing label for this provider on the sign-in page. */
export const CHATGPT_WEB_AUTH_PROVIDER_LABEL = "ChatGPT Web";

/**
 * The frame geometry the sign-in browser is launched with.
 *
 * Fixed and reported truthfully by `view()`, so the page can map a click into the provider's own
 * coordinates without guessing a scale.
 */
export const CHATGPT_WEB_AUTH_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * How long the controller polls the authenticated surface before reporting `failed`.
 *
 * Deliberately a little under the session manager's 10-minute default TTL, so a sign-in that never
 * completes reports the controller's own non-secret failure detail instead of being expired out from
 * under it by the manager's sweep.
 */
export const CHATGPT_WEB_AUTH_POLL_TIMEOUT_MS = 8 * 60_000;

/** How often the authenticated surface is polled while the operator works. Never a busy loop. */
export const CHATGPT_WEB_AUTH_POLL_INTERVAL_MS = 1_500;

/** How long one navigation (the initial one and any operator `navigate`) may take. */
export const CHATGPT_WEB_AUTH_NAVIGATION_TIMEOUT_MS = 60_000;

/** What the default launch sends into the page's own capability probe. */
const CAPABILITY_PROBE_TIMEOUT_MS = 15_000;

/** The Windows desktop user agent the managed headless browser already presents. */
const HEADLESS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** A viewport in the provider's own frame geometry. */
export interface ChatGptWebAuthViewport {
  readonly width: number;
  readonly height: number;
}

/** Everything the browser launcher needs, and nothing it does not. */
export interface ChatGptWebAuthBrowserLaunch {
  /** The configured Chrome executable. */
  readonly executablePath: string;
  /** `true` for the `--headless=new` launch; `false` for the `display` escape hatch. */
  readonly headless: boolean;
  /** The disposable profile directory this session owns. */
  readonly profileDir: string;
  /** The frame geometry the page must report. */
  readonly viewport: ChatGptWebAuthViewport;
  /** The sign-in page to open. */
  readonly url: string;
}

/**
 * One live sign-in browser, as the controller uses it.
 *
 * The handle owns the transport (a persistent context in production); the controller owns the
 * profile directory around it. `storageState()` is the opaque capture read at the moment the sign-in
 * succeeds, already sanitized to the ChatGPT/OpenAI origins by the default implementation.
 */
export interface ChatGptWebAuthBrowserHandle {
  readonly page: Page;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

/** Starts one sign-in browser. Injected by tests so the suite never needs a real browser. */
export type ChatGptWebAuthBrowserLauncher =
  (launch: ChatGptWebAuthBrowserLaunch) => Promise<ChatGptWebAuthBrowserHandle>;

/**
 * Reads the authenticated surface.
 *
 * Resolves with the account capabilities once the page is authenticated; rejects (with no state
 * change) while the operator still has to sign in, or when the browser is gone. The default
 * implementation reuses `assertAuthenticatedChatGptPage` / `detectChatGptAccountCapabilities`.
 */
export type ChatGptWebAuthSurfaceInspector =
  (page: Page) => Promise<ChatGptWebAccountCapabilities>;

/** Persists one captured session. Defaults to `storeProviderSession`, the single session writer. */
export type ChatGptWebAuthSessionStore =
  (storageState: unknown, capabilities: ChatGptWebAccountCapabilities) => string;

/**
 * Reads the authenticated account's non-secret identity fingerprint from the sign-in page.
 *
 * Resolves with the fingerprint once the surface is authenticated; rejects when the page cannot be
 * probed. The default is the very probe `login` uses, so both sign-in paths bind the same account.
 */
export type ChatGptWebAuthIdentityDetector = (page: Page) => Promise<string>;

/**
 * Persists one detected account fingerprint into the deployment configuration.
 *
 * The default is the config module's own read-modify-write; a test injects a spy so "written exactly
 * once" and "not written at all" are provable without touching a real data home.
 */
export type ChatGptWebAuthIdentityWriter = (fingerprint: string) => void;

/** Construction options for {@link createChatGptWebAuthController}. */
export interface ChatGptWebAuthControllerOptions {
  /** The deployment facts this controller needs: the executable and the launch mode. */
  readonly config: Pick<AppConfig, "chromeExecutablePath" | "authBrowserMode">;
  /** Where a disposable profile is created. Defaults to the provider's credentials directory. */
  readonly profileRoot?: string;
  /** The frame geometry. Defaults to {@link CHATGPT_WEB_AUTH_VIEWPORT}. */
  readonly viewport?: ChatGptWebAuthViewport;
  /** Poll cadence while the operator works. Defaults to {@link CHATGPT_WEB_AUTH_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** How long a sign-in may take before it reports `failed`. Default 8 minutes. */
  readonly pollTimeoutMs?: number;
  /** Optional hard cap on polling attempts, independent of the time bound. */
  readonly maxPolls?: number;
  /** Navigation timeout. Defaults to {@link CHATGPT_WEB_AUTH_NAVIGATION_TIMEOUT_MS}. */
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
  readonly openBrowser?: ChatGptWebAuthBrowserLauncher;
  /** Surface inspector. Defaults to the real ChatGPT authentication checks. */
  readonly inspectSurface?: ChatGptWebAuthSurfaceInspector;
  /** Session store. Defaults to `storeProviderSession`. */
  readonly storeSession?: ChatGptWebAuthSessionStore;
  /** Account-identity detector. Defaults to the same probe `login` uses. */
  readonly detectIdentity?: ChatGptWebAuthIdentityDetector;
  /**
   * Account-fingerprint writer. Defaults to `persistAccountIdentityFingerprint`, the configuration
   * module's read-modify-write, so the captured session and the account binding land together.
   */
  readonly persistIdentity?: ChatGptWebAuthIdentityWriter;
}

/**
 * A URL, absolute or bare enough to carry a query string, that must never reach a diagnostic.
 *
 * A sign-in redirect routinely puts a one-time code in the query; a Playwright navigation failure
 * quotes the whole URL back in its own message. Both are removed before any error crosses the
 * provider boundary.
 */
const DIAGNOSTIC_URL_PATTERNS = [
  /https?:\/\/[^\s"'<>]+/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s"'<>]*/gi,
] as const;

/**
 * Turn any failure into a non-secret, bounded one-line diagnostic.
 *
 * Never returns a cookie, a storage state, or a full URL with query parameters: URLs are rewritten to
 * `[url]` before the message is used anywhere.
 */
export function nonSecretAuthDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  let sanitized = raw;
  for (const pattern of DIAGNOSTIC_URL_PATTERNS) sanitized = sanitized.replace(pattern, "[url]");
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  return sanitized.length > 0
    ? sanitized.slice(0, 300)
    : "The sign-in browser reported an unknown failure";
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  // Never a reason for the process to stay alive: the listener socket or the operator's stream is.
  timer.unref?.();
});

const defaultCreateProfile = (root: string): string => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  const dir = mkdtempSync(join(root, "auth-browser-"));
  try { chmodSync(dir, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  return dir;
};

const defaultRemoveProfile = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

/**
 * The exact Chromium switches the sign-in launch uses.
 *
 * Pure and exported so the flag set is asserted without a browser. It mirrors the managed ChatGPT
 * browser: headless is requested with `--headless=new` in `args` (never Playwright's `headless: true`),
 * `display` mode simply drops that flag and the Windows user agent, and the anti-automation pair is
 * always present.
 */
export function chatGptWebAuthLaunchArgs(
  launch: Pick<ChatGptWebAuthBrowserLaunch, "headless" | "viewport">,
): string[] {
  return [
    ...(launch.headless ? ["--headless=new"] : []),
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${launch.viewport.width},${launch.viewport.height}`,
    ...(launch.headless ? [`--user-agent=${HEADLESS_USER_AGENT}`] : []),
  ];
}

/**
 * The default launch: a persistent Chromium context on the disposable profile.
 *
 * `headless: false` plus `--headless=new` is the repository's established headless shape (see
 * `ensureManagedBrowser`); Playwright's own `headless: true` is deliberately not used, so the flag set
 * stays identical to the managed ChatGPT browser. In `display` mode the flag is simply absent and a
 * real window opens on the image's display.
 */
async function defaultOpenBrowser(launch: ChatGptWebAuthBrowserLaunch): Promise<ChatGptWebAuthBrowserHandle> {
  const context = await chromium.launchPersistentContext(launch.profileDir, {
    executablePath: launch.executablePath,
    headless: false,
    viewport: { width: launch.viewport.width, height: launch.viewport.height },
    args: chatGptWebAuthLaunchArgs(launch),
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(launch.url, {
      waitUntil: "domcontentloaded",
      timeout: CHATGPT_WEB_AUTH_NAVIGATION_TIMEOUT_MS,
    });
    return {
      page,
      // The disposable profile only ever had a reason to hold ChatGPT/OpenAI state, and the same
      // sanitizer the interactive login uses is applied before the capture leaves this module.
      storageState: async () => sanitizeBrowserLoginStorageState(await context.storageState()),
      close: async () => { await context.close(); },
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/** The default surface check: the same authenticated-page assertion and capability probe login uses. */
async function defaultInspectSurface(page: Page): Promise<ChatGptWebAccountCapabilities> {
  await assertAuthenticatedChatGptPage(page);
  await assertChatGptPage(page);
  return detectChatGptAccountCapabilities(page, { selectorTimeoutMs: CAPABILITY_PROBE_TIMEOUT_MS });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`A ChatGPT Web sign-in controller requires a positive ${label}`);
  }
  return value;
}

function assertViewport(viewport: ChatGptWebAuthViewport): ChatGptWebAuthViewport {
  if (!viewport || !Number.isSafeInteger(viewport.width) || viewport.width < 1
    || !Number.isSafeInteger(viewport.height) || viewport.height < 1) {
    throw new TypeError("A ChatGPT Web sign-in controller requires a positive viewport");
  }
  return { width: viewport.width, height: viewport.height };
}

/** One ChatGPT Web sign-in. Owns the browser, the temporary profile and the completion decision. */
class ChatGptWebAuthSession implements ProviderAuthSession {
  readonly providerId = CHATGPT_WEB_AUTH_PROVIDER_ID;

  #state: AuthSessionState = "starting";
  #failureDetail: string | undefined;
  #page: Page | undefined;
  #handle: ChatGptWebAuthBrowserHandle | undefined;
  #profileDir: string | undefined;
  #storageState: unknown;
  #capabilities: ChatGptWebAccountCapabilities | undefined;
  #settled = false;
  #teardownRun: Promise<void> | undefined;
  #polls = 0;
  #deadline = 0;

  constructor(private readonly owner: ChatGptWebAuthControllerOwner) {}

  /** Called by the controller once the browser is up, to begin the interactive lifecycle. */
  begin(handle: ChatGptWebAuthBrowserHandle, profileDir: string): void {
    this.#handle = handle;
    this.#page = handle.page;
    this.#profileDir = profileDir;
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

  async view(): Promise<ProviderAuthView> {
    const page = this.#livePage("relay a frame");
    const size = this.#viewportOf(page);
    // `caret: "initial"` is load-bearing, not cosmetic: Playwright hides the blinking text caret in
    // screenshots by default ("hide"), which removed the operator's only visual confirmation that a
    // click had focused a field — the report that started this fix read as "the click is broken". With
    // the caret left at the browser's own behaviour, the relayed frames show which field is focused.
    // (Supported by the pinned playwright-core; `hide` remains the default this deliberately overrides.)
    const png = await page.screenshot({ type: "png", caret: "initial" });
    // The screenshot is the viewport, so the geometry reported is the geometry the page must map a
    // click into. This is the only place in the controller that produces pixels.
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
   * navigation intent (`TRANSPORT_UNAVAILABLE`) are all decided here and rethrown unchanged by
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
            { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID, providerCode: "AUTH_CLICK_OUT_OF_VIEWPORT" },
          );
        }
        await page.mouse.click(event.x, event.y);
        return;
      }
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
          // The provider validates nothing about the URL: it is an intent. A failed navigation is a
          // transport failure whose own message quotes the URL, so only the sanitized detail travels.
          throw webChatError(
            "TRANSPORT_UNAVAILABLE",
            `The sign-in browser could not follow the navigation intent: ${nonSecretAuthDetail(error)}`,
            {
              providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
              providerCode: "AUTH_NAVIGATION_FAILED",
              cause: error,
            },
          );
        }
        return;
      default:
        throw new TypeError("A WebChat auth input must be one of click, type, key, scroll or navigate");
    }
  }

  /**
   * Translate an unexpected interaction failure into the upstream category the surface maps to 502.
   *
   * A page or browser that dies while an input is relayed used to escape as a raw Playwright error,
   * which the sign-in surface could only answer as a 500 `auth_unavailable`; the operator saw an
   * internal failure instead of an upstream one. The controller knows better than the host here: the
   * interactive path it owns has failed, no poll can recover it, so it fails the session (releasing
   * the browser and the temporary profile through the one teardown) and reports the shared upstream
   * category. A closed page is distinguishable from any other interaction failure by provider code,
   * and the detail is sanitized exactly like every other diagnostic that crosses this boundary.
   */
  #inputFailure(page: Page, error: unknown): Error {
    // The categories this controller already publishes pass through untouched: a refused intent is
    // still the caller's 400, a malformed event is still a 400, and a failed navigation is still the
    // transport category it has always been.
    if (isWebChatError(error) || error instanceof TypeError) return error;
    const detail = nonSecretAuthDetail(error);
    const closed = page.isClosed();
    if (closed) {
      this.#fail("The sign-in browser closed while an input was being relayed");
      return webChatError(
        "UPSTREAM_ERROR",
        `The sign-in browser closed while an input was being relayed: ${detail}`,
        { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID, providerCode: "AUTH_PAGE_CLOSED", cause: error },
      );
    }
    this.#fail(`The sign-in browser could not relay an input: ${detail}`);
    return webChatError(
      "UPSTREAM_ERROR",
      `The sign-in browser could not relay an input: ${detail}`,
      { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID, providerCode: "AUTH_INPUT_FAILED", cause: error },
    );
  }

  async capture(): Promise<AuthCapture> {
    if (this.#state !== "captured" || this.#capabilities === undefined) {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `The ${CHATGPT_WEB_AUTH_PROVIDER_ID} sign-in has not captured`,
        { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID },
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
      this.#page = undefined;
      this.#handle = undefined;
      this.#profileDir = undefined;
      this.#teardownRun = (async () => {
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
        `The ${CHATGPT_WEB_AUTH_PROVIDER_ID} sign-in browser is closed and cannot ${action}`,
        { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID },
      );
    }
    return this.#page;
  }

  #viewportOf(page: Page): ChatGptWebAuthViewport {
    const size = page.viewportSize();
    if (size && size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
    return this.owner.viewport;
  }

  /**
   * Bounded completion detection: sleep, then check the authenticated surface once.
   *
   * The sleep is what keeps this off the CPU; the time/attempt bound is what makes a sign-in that
   * never authenticates report `failed` instead of polling forever. When the browser dies (the page
   * closes, or the check fails on a closed page) the session fails immediately and tears down.
   */
  async #poll(): Promise<void> {
    while (!this.#settled) {
      await this.owner.sleep(this.owner.pollIntervalMs);
      if (this.#settled) return;
      if (this.#polls >= this.owner.maxPolls) {
        this.#fail(
          `The ChatGPT sign-in surface did not authenticate within ${this.owner.maxPolls} polls`,
        );
        return;
      }
      if (this.owner.now() >= this.#deadline) {
        this.#fail(
          `The ChatGPT sign-in surface did not authenticate within ${this.owner.pollTimeoutMs}ms`,
        );
        return;
      }
      this.#polls += 1;
      const page = this.#page;
      if (!page || page.isClosed()) {
        this.#fail("The sign-in browser closed before the sign-in completed");
        return;
      }
      this.#state = "verifying";
      let capabilities: ChatGptWebAccountCapabilities;
      try {
        capabilities = await this.owner.inspectSurface(page);
      } catch {
        if (this.#settled) return;
        if (page.isClosed()) {
          this.#fail("The sign-in browser closed before the sign-in completed");
          return;
        }
        // Not authenticated yet is the expected answer while the operator works; the loop simply
        // goes back to `awaiting_input` and waits again.
        this.#state = "awaiting_input";
        continue;
      }
      if (this.#settled) return;
      let storageState: unknown;
      try {
        storageState = await this.owner.storageState(this.#handle!);
      } catch (error) {
        this.#fail(`The sign-in completed but the session could not be read: ${nonSecretAuthDetail(error)}`);
        return;
      }
      if (this.#settled) return;
      // Best-effort, never fatal: an unreadable account identity must not discard a signed-in session,
      // but it is also not silent. Without the fingerprint the logical identity stays the constant
      // "unknown session" fallback and every turn fails closed on the account-binding check, so the
      // reason travels to `storeCapture` and is reported to the operator there.
      let accountIdentityFingerprint: string | undefined;
      let accountIdentityDetail: string | undefined;
      try {
        accountIdentityFingerprint = await this.owner.detectAccountIdentity(page);
      } catch (error) {
        accountIdentityDetail = nonSecretAuthDetail(error);
      }
      if (this.#settled) return;
      this.#capabilities = capabilities;
      this.#storageState = storageState;
      // The controller remembers the capabilities keyed by the exact opaque state it will hand to the
      // host, so `storeCapture` can pair them without the host ever seeing a capability.
      this.owner.recordCapture(
        storageState,
        capabilities,
        accountIdentityFingerprint,
        accountIdentityDetail,
      );
      this.#state = "captured";
      await this.#teardown();
      return;
    }
  }
}

/** The controller-internal view of the shared configuration the session needs. */
interface ChatGptWebAuthControllerOwner {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly viewport: ChatGptWebAuthViewport;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly maxPolls: number;
  readonly navigationTimeoutMs: number;
  readonly removeProfile: (dir: string) => void;
  readonly inspectSurface: ChatGptWebAuthSurfaceInspector;
  storageState(handle: ChatGptWebAuthBrowserHandle): Promise<unknown>;
  /** The authenticated account's fingerprint, or a rejection the session records as a detail. */
  detectAccountIdentity(page: Page): Promise<string>;
  recordCapture(
    storageState: unknown,
    capabilities: ChatGptWebAccountCapabilities,
    accountIdentityFingerprint: string | undefined,
    accountIdentityDetail: string | undefined,
  ): void;
}

/**
 * Create the ChatGPT Web interactive sign-in controller.
 *
 * Construction is inert: no browser is started and no profile is created here. Only `startAuth()`
 * launches anything, so a listener can register this controller and still start with no browser
 * available.
 *
 * @param options - the deployment facts plus the test seams. Only `config` is required.
 * @returns the provider's auth capability.
 */
export function createChatGptWebAuthController(
  options: ChatGptWebAuthControllerOptions,
): ProviderAuthController {
  if (!options || !options.config || typeof options.config.chromeExecutablePath !== "string") {
    throw new TypeError("A ChatGPT Web sign-in controller requires the deployment configuration");
  }
  const config = options.config;
  const profileRoot = options.profileRoot ?? providerCredentialsDir();
  const viewport = assertViewport(options.viewport ?? CHATGPT_WEB_AUTH_VIEWPORT);
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? CHATGPT_WEB_AUTH_POLL_INTERVAL_MS,
    "poll interval",
  );
  const pollTimeoutMs = positiveInteger(
    options.pollTimeoutMs ?? CHATGPT_WEB_AUTH_POLL_TIMEOUT_MS,
    "poll timeout",
  );
  const maxPolls = options.maxPolls === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInteger(options.maxPolls, "poll attempt bound");
  const navigationTimeoutMs = positiveInteger(
    options.navigationTimeoutMs ?? CHATGPT_WEB_AUTH_NAVIGATION_TIMEOUT_MS,
    "navigation timeout",
  );
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const fileExists = options.fileExists ?? existsSync;
  const createProfile = options.createProfile ?? defaultCreateProfile;
  const removeProfile = options.removeProfile ?? defaultRemoveProfile;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const inspectSurface = options.inspectSurface ?? defaultInspectSurface;
  const storeSession = options.storeSession ?? ((state, capabilities) =>
    storeProviderSession(
      state as Parameters<typeof storeProviderSession>[0],
      capabilities,
    ));
  const detectIdentity = options.detectIdentity ?? (async (page: Page) =>
    (await detectChatGptAuthenticatedAccountIdentity(page)).fingerprint);
  const writeIdentity = options.persistIdentity ?? persistAccountIdentityFingerprint;
  const headless = (config.authBrowserMode ?? "headless") === "headless";

  /**
   * The capabilities, and the account fingerprint, of each capture this controller produced, keyed by
   * the opaque state object the host will hand back to `storeCapture`. A WeakMap, so nothing outlives
   * the capture it describes.
   */
  const captures = new WeakMap<object, {
    readonly capabilities: ChatGptWebAccountCapabilities;
    readonly accountIdentityFingerprint: string | undefined;
    readonly accountIdentityDetail: string | undefined;
  }>();

  /**
   * Persist the fingerprint a capture detected and report — never throw — why it was skipped.
   *
   * The session is already stored when this runs, so a sign-in is never discarded for a missing
   * account binding; but without the fingerprint the logical identity stays a non-account fallback
   * (`providerConfig` substitutes the storage-state-derived value when the field is absent), and the
   * next turn fails closed on the account-binding check. That is exactly what the operator has to be
   * told, in non-secret terms, through the reported detail.
   */
  const persistIdentity = (capture: {
    readonly accountIdentityFingerprint: string | undefined;
    readonly accountIdentityDetail: string | undefined;
  }): string | undefined => {
    if (capture.accountIdentityFingerprint === undefined) {
      return "The signed-in ChatGPT account identity could not be read, so no account fingerprint "
        + `was written${capture.accountIdentityDetail ? ` (${capture.accountIdentityDetail})` : ""}; `
        + "every turn will fail closed until a sign-in records it.";
    }
    try {
      writeIdentity(capture.accountIdentityFingerprint);
      return undefined;
    } catch (error) {
      return `The ChatGPT account fingerprint could not be written to the deployment configuration: `
        + `${nonSecretAuthDetail(error)}. Every turn will fail closed until a sign-in records it.`;
    }
  };

  const owner: ChatGptWebAuthControllerOwner = {
    now,
    sleep,
    viewport,
    pollIntervalMs,
    pollTimeoutMs,
    maxPolls,
    navigationTimeoutMs,
    removeProfile,
    inspectSurface,
    async storageState(handle) {
      return await handle.storageState();
    },
    async detectAccountIdentity(page) {
      return await detectIdentity(page);
    },
    recordCapture(storageState, capabilities, accountIdentityFingerprint, accountIdentityDetail) {
      if (storageState !== null && (typeof storageState === "object" || typeof storageState === "function")) {
        captures.set(storageState as object, {
          capabilities,
          accountIdentityFingerprint,
          accountIdentityDetail,
        });
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
            providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
            providerCode: "CHROME_EXECUTABLE_MISSING",
          },
        );
      }
      const profileDir = createProfile(profileRoot);
      let handle: ChatGptWebAuthBrowserHandle;
      try {
        handle = await openBrowser({
          executablePath: config.chromeExecutablePath,
          headless,
          profileDir,
          viewport,
          url: CHATGPT_CHAT_URL,
        });
      } catch (error) {
        // The profile is owned from the moment it exists, even when the browser never came up.
        try { removeProfile(profileDir); } catch { /* the launch failure is the error being reported */ }
        throw webChatError(
          "TRANSPORT_UNAVAILABLE",
          `The interactive sign-in browser could not start: ${nonSecretAuthDetail(error)}`,
          {
            providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
            providerCode: "BROWSER_LAUNCH_FAILED",
            cause: error,
          },
        );
      }
      const session = new ChatGptWebAuthSession(owner);
      session.begin(handle, profileDir);
      return session;
    },

    async storeCapture(capture: AuthCapture): Promise<ProviderAuthStoreResult> {
      if (capture.kind !== "browser-storage") {
        // `opaque`/`none` are other providers' shapes; this controller produced nothing to write.
        return { stored: false };
      }
      const record = typeof capture.storageState === "object" && capture.storageState !== null
        ? captures.get(capture.storageState)
        : undefined;
      if (!record) {
        throw webChatError(
          "CONVERSATION_STATE_MISMATCH",
          `The ${CHATGPT_WEB_AUTH_PROVIDER_ID} sign-in controller was asked to store a capture it did not produce`,
          { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID },
        );
      }
      // The session first, the account binding second: a failed session write must leave the
      // configuration untouched, so a half-signed-in deployment is never recorded as bound.
      const location = storeSession(capture.storageState, record.capabilities);
      // The fingerprint is provider-side account binding, not captured material, so it is persisted
      // here — the controller already owns the write — rather than widened into the neutral
      // `AuthCapture` the host relays. `AuthCapture` stays exactly as it is.
      const detail = persistIdentity(record);
      return { stored: true, location, ...(detail !== undefined ? { detail } : {}) };
    },
  };
}
