import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright-core";
import type { AppConfig } from "./config";
import {
  atomicWriteFile,
  DEFAULT_CREDENTIAL_PROVIDER_ID,
  getConfigDir,
  providerCredentialsDir,
  providerStorageStatePath,
  storageStateMarkerPath,
} from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertChatGptPage,
  CHATGPT_CHAT_URL,
  detectChatGptAccountCapabilities,
  detectChatGptAuthenticatedAccountIdentity,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  accountIdentityFingerprint: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

export type BrowserLoginStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface SystemBrowserLoginCaptureMarker {
  version: 1;
  captureComplete: true;
  source: "isolated-normal-browser-profile";
  capturedAt: string;
}

export interface SystemBrowserLoginCapture {
  storageState: BrowserLoginStorageState;
  marker: SystemBrowserLoginCaptureMarker;
}

interface SystemBrowserLoginOptions {
  continuation: Promise<void>;
  timeoutMs?: number;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

const SYSTEM_LOGIN_TIMEOUT_MS = 10 * 60_000;
const SYSTEM_LOGIN_STOP_TIMEOUT_MS = 5_000;
const LOGIN_STORAGE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;
const CHATGPT_ORIGIN = new URL(CHATGPT_CHAT_URL).origin;

function browserProcessExited(browser: ChildProcess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

function removeTemporaryChromeTabSessions(profileDir: string): void {
  const defaultProfile = join(profileDir, "Default");
  rmSync(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(join(defaultProfile, name), { force: true });
  }
}

async function waitForBrowserExit(browser: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (browserProcessExited(browser)) return true;
  return await new Promise(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    browser.once("exit", onExit);
    if (browserProcessExited(browser)) finish(true);
  });
}

async function stopOwnedLoginBrowser(browser: ChildProcess): Promise<void> {
  if (browserProcessExited(browser) || !Number.isInteger(browser.pid)) return;
  const graceful = waitForBrowserExit(browser, SYSTEM_LOGIN_STOP_TIMEOUT_MS);
  if (!browser.kill() && !browserProcessExited(browser)) {
    throw new Error("The dedicated Chrome login process refused to close");
  }
  if (await graceful) return;
  const forced = waitForBrowserExit(browser, SYSTEM_LOGIN_STOP_TIMEOUT_MS);
  if (!browser.kill("SIGKILL") && !browserProcessExited(browser)) {
    throw new Error("The dedicated Chrome login process refused forced termination");
  }
  if (!await forced) throw new Error("The dedicated Chrome login process did not exit");
}

function allowedLoginStorageHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")) return false;
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (parsed.hostname !== hostname
      || parsed.host !== hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) return false;
  } catch {
    return false;
  }
  return LOGIN_STORAGE_ROOT_DOMAINS.some(root => hostname === root || hostname.endsWith(`.${root}`));
}

export function sanitizeBrowserLoginStorageState(
  storageState: BrowserLoginStorageState,
): BrowserLoginStorageState {
  return {
    cookies: storageState.cookies
      .filter(cookie => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
        && allowedLoginStorageHost(cookie.domain.replace(/^\.+/, "")))
      .map(cookie => ({ ...cookie })),
    origins: storageState.origins
      .filter(origin => origin.origin === CHATGPT_ORIGIN)
      .map(origin => ({
        origin: origin.origin,
        localStorage: origin.localStorage.map(item => ({ ...item })),
      })),
  };
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return storageStateMarkerPath(storageStatePath);
}

/**
 * Read one provider's verification marker, the file {@link storeProviderSession} writes.
 *
 * The marker is the deployment-wide promise "this session was proved at `verifiedAt`". This reader
 * exists for surfaces that report **when** a capture last verified (the session-health endpoint);
 * the `*SessionVerified` helpers keep their own boolean reading, and nothing here interprets a
 * cookie or a token. A marker that cannot be read is simply not a marker.
 *
 * @returns the marker facts, or `null` when there is no readable, authentic marker beside the capture.
 */
export function readVerificationMarker(
  storageStatePath: string,
): { readonly verifiedAt: string } | null {
  const markerPath = storageStateMarkerPath(storageStatePath);
  if (!existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      version?: unknown;
      authenticated?: unknown;
      verifiedAt?: unknown;
    };
    if (marker.version !== 1 || marker.authenticated !== true || typeof marker.verifiedAt !== "string") return null;
    return { verifiedAt: marker.verifiedAt };
  } catch {
    return null;
  }
}

/** The provider a capture is stored for, plus an optional explicit data home (tests). */
export interface ProviderSessionTarget {
  /** Provider whose credential directory owns the session. Defaults to `chatgpt-web`. */
  readonly providerId?: string;
  /** Data home override; the deployment's own `DSH_CHATGPT_WEB_HOME` is the normal source. */
  readonly home?: string;
  /**
   * Whether the caller's authenticated predicate already proved this session.
   *
   * Defaults to `true`, the historical contract. A provider that has no adapter/predicate yet stores
   * its capture with `false`: the storage state is written, but the `.verified.json` marker is
   * **omitted** (and a stale marker removed), so every reader that gates on it keeps treating the
   * session as unverified. That is the honest representation of "captured, not usable".
   */
  readonly verified?: boolean;
}

/**
 * Write a session into the provider's credential layout (issue #249).
 *
 * One owner for "store a session": `login`, the system-browser capture, `auth import` and every
 * provider adapter land here, so the two files can never be split across locations and a second
 * provider cannot grow a second writer. The provider only chooses *which* directory; the file names,
 * the atomic write and the `.verified.json` marker stay this function's business.
 *
 * `capabilities` is ChatGPT-specific account evidence and is optional: a provider that has no such
 * concept (Qwen Code) stores the identical layout with an empty marker payload.
 */
export function storeProviderSession(
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
  capabilities: Partial<ChatGptWebAccountCapabilities> = {},
  slot: ProviderSessionTarget = {},
): string {
  const target = providerStorageStatePath(
    slot.providerId ?? DEFAULT_CREDENTIAL_PROVIDER_ID,
    slot.home ?? getConfigDir(),
  );
  const marker = loginVerificationMarkerPath(target);
  atomicWriteFile(target, `${JSON.stringify(storageState)}\n`);
  if (slot.verified === false) {
    // An unverified capture must not inherit an earlier marker: the marker is the deployment-wide
    // promise "this session works", and a stale one would make the new capture look verified.
    rmSync(marker, { force: true });
  } else {
    writeVerificationMarker(target, capabilities);
  }
  return target;
}

/** Verify a stored state against the provider's login surface before it is accepted (issue #249). */
export async function verifyStoredSession(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  return inspectStoredState(config, storageState);
}

function writeVerificationMarker(
  storageStatePath: string,
  capabilities: Partial<ChatGptWebAccountCapabilities>,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--enable-automation", "--password-store=basic", "--use-mock-keychain"],
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertChatGptPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected);
  return {
    solAvailable: inspected.solAvailable,
    proAvailable: inspected.proAvailable,
  };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export async function captureSystemBrowserLogin(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: SystemBrowserLoginOptions,
): Promise<SystemBrowserLoginCapture> {
  if (process.platform !== "darwin") {
    throw new Error("Passkey sign-in is currently supported only on macOS");
  }
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  }
  const timeoutMs = options.timeoutMs ?? SYSTEM_LOGIN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Passkey sign-in timeout must be a positive finite number");
  }
  const deadline = Date.now() + timeoutMs;
  const remainingTime = () => {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error("Timed out waiting for passkey sign-in");
    return remaining;
  };

  const profileParent = providerCredentialsDir();
  mkdirSync(profileParent, { recursive: true, mode: 0o700 });
  try { chmodSync(profileParent, 0o700); } catch {}
  const profileDir = mkdtempSync(join(profileParent, "login-profile-"));
  try { chmodSync(profileDir, 0o700); } catch {}
  process.stdout.write(
    "Sign in with your passkey in the dedicated Chrome window. When the ChatGPT conversation surface is ready, return to Codex Web GPT and choose Continue.\n",
  );

  let capture: SystemBrowserLoginCapture | undefined;
  let context: BrowserContext | undefined;
  let primaryError: unknown;
  try {
    const loginBrowser = spawn(config.chromeExecutablePath, [
      `--user-data-dir=${profileDir}`,
      "--new-window",
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
      CHATGPT_CHAT_URL,
    ], { env: process.env, stdio: "ignore" });
    let continuationRequested = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for passkey sign-in")), remainingTime());
        void options.continuation.then(() => {
          continuationRequested = true;
          if (!loginBrowser.kill() && !browserProcessExited(loginBrowser)) {
            reject(new Error("The dedicated Chrome login process refused the Continue request"));
          }
        }, reject);
        loginBrowser.once("error", reject);
        loginBrowser.once("exit", (code, signal) => {
          if (continuationRequested) resolve();
          else if (signal) reject(new Error(`Dedicated Chrome login exited from signal ${signal}`));
          else if (code === 0) reject(new Error("Dedicated Chrome closed before Continue was selected"));
          else reject(new Error(`Dedicated Chrome login exited with status ${code ?? 1}`));
        });
      });
    } catch (error) {
      try {
        await stopOwnedLoginBrowser(loginBrowser);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; Chrome cleanup also failed: ${cleanup}`);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    // Authentication happens before Playwright ever owns this profile. Chrome does not load
    // session-only cookies after a normal restart unless session restore is requested. Remove only
    // the disposable profile's tab-session files first, so restoring cookies cannot reopen the
    // authenticated or identity-provider pages during the offline capture.
    removeTemporaryChromeTabSessions(profileDir);
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: config.chromeExecutablePath,
      headless: true,
      chromiumSandbox: true,
      offline: true,
      serviceWorkers: "block",
      ignoreDefaultArgs: [
        "--no-sandbox",
        "--enable-automation",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
      args: [
        "--disable-background-mode",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
      ],
      timeout: Math.min(30_000, remainingTime()),
    });
    await context.setOffline(true);
    await context.route("**/*", route => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><meta charset=\"utf-8\"><title>Private login-state capture</title>",
    }));
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(60_000, remainingTime()),
    });
    if (new URL(page.url()).origin !== CHATGPT_ORIGIN) {
      throw new Error("Offline passkey-state capture reached an unexpected origin");
    }
    const storageState = sanitizeBrowserLoginStorageState(await context.storageState());
    if (storageState.cookies.length === 0) {
      throw new Error("The dedicated Chrome profile contains no ChatGPT/OpenAI cookies");
    }
    capture = {
      storageState,
      marker: {
        version: 1,
        captureComplete: true,
        source: "isolated-normal-browser-profile",
        capturedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (context && !context.isClosed()) await context.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError) {
    if (cleanupError) {
      throw new Error(
        `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; temporary-profile cleanup also failed:`
        + ` ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  if (!capture) throw new Error("Passkey sign-in completed without capture evidence");
  return capture;
}

export async function captureSystemBrowserLoginToFile(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: SystemBrowserLoginOptions,
): Promise<void> {
  const capture = await captureSystemBrowserLogin(config, options);
  const target = providerStorageStatePath();
  const markerPath = loginVerificationMarkerPath(target);
  rmSync(markerPath, { force: true });
  atomicWriteFile(target, `${JSON.stringify(capture.storageState)}\n`);
  atomicWriteFile(markerPath, `${JSON.stringify(capture.marker)}\n`);
}

/**
 * One owner of the disposable login profile's lifecycle.
 *
 * The profile is created here and removed here, on **every** exit path: the browser that never
 * launched, the sign-in that failed before it wrote any state, the sign-in that succeeded. It used to
 * be removed in a `finally` guarded by `browserLoginStateExists(config)`, which is the wrong
 * question — a failed sign-in has precisely no state yet — so each failure left a `login-profile-*`
 * directory behind in the provider's credentials directory forever.
 *
 * Exported so that contract is testable without a real browser: the run body is whatever the caller
 * starts inside the profile, and only the profile's removal is this function's business.
 *
 * @param parentDir - the credentials directory the profiled directory is created under.
 * @param run - the sign-in work, given the profile directory to launch the browser against.
 * @returns whatever `run` returned.
 */
export async function withTemporaryLoginProfile<T>(
  parentDir: string,
  run: (profileDir: string) => Promise<T>,
): Promise<T> {
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const profileDir = mkdtempSync(join(parentDir, "login-profile-"));
  try {
    return await run(profileDir);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }

  // Under Bun on Windows, Bun's child process pipe implementation has a known limitation with Playwright stdio pipes.
  // Delegate to a dedicated Node process which executes Playwright natively and flawlessly.
  if (process.platform === "win32" && typeof (process.versions as Record<string, string>).bun === "string") {
    const helperScript = join(import.meta.dirname, "login-helper.cjs");
    if (existsSync(helperScript)) {
      process.stdout.write(
        "A Chrome window is open. Sign in to ChatGPT in the window. Once logged in, this setup will automatically capture your session.\n",
      );
      return await new Promise<BrowserLoginResult>((resolve, reject) => {
        const child = spawn("node", [helperScript, JSON.stringify({ config, options })], {
          stdio: ["ignore", "pipe", "inherit"],
          windowsHide: false,
        });
        let output = "";
        child.stdout?.on("data", chunk => {
          output += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          if (code === 0) {
            const match = output.match(/__RESULT__:(.+)/);
            if (match && match[1]) {
              try {
                resolve(JSON.parse(match[1]) as BrowserLoginResult);
                return;
              } catch (err) {
                reject(err);
                return;
              }
            }
            reject(new Error("Login completed but result payload was missing"));
          } else {
            reject(new Error(`Login helper exited with code ${code ?? signal}`));
          }
        });
      });
    }
  }

  return await withTemporaryLoginProfile(providerCredentialsDir(), async profileDir => {
    process.stdout.write(
      "A Chrome window is open. Sign in to ChatGPT in the window. Once logged in, this setup will automatically capture your session.\n",
    );

    // The launch is inside the profile owner, so a browser that never came up cannot leave the
    // profile behind either.
    let context: BrowserContext | undefined;
    try {
      const launched = await chromium.launchPersistentContext(profileDir, {
        executablePath: config.chromeExecutablePath,
        headless: false,
        ignoreDefaultArgs: [
          "--enable-automation",
          "--password-store=basic",
          "--use-mock-keychain",
        ],
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      context = launched;
      const page = launched.pages()[0] ?? await launched.newPage();
      try {
        await page.goto(CHATGPT_CHAT_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      } catch {
        // In case navigation is redirected immediately (e.g. to login portal)
      }

      const deadline = Date.now() + (options.timeoutMs ?? 300_000);
      let activePage: Page | undefined;
      while (Date.now() < deadline) {
        for (const p of launched.pages()) {
          try {
            const composer = p.locator(
              '[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], [role="textbox"][aria-label="Ask ChatGPT"], .ProseMirror[contenteditable="true"]',
            ).first();
            if (await composer.isVisible().catch(() => false)) {
              activePage = p;
              break;
            }
          } catch {}
        }
        if (activePage) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!activePage) {
        throw new Error("The authenticated ChatGPT page did not produce a visible composer within 5 minutes");
      }

      await assertAuthenticatedChatGptPage(activePage);
      const rawState = await launched.storageState();
      const state = sanitizeBrowserLoginStorageState(rawState);

      let capabilities: ChatGptWebAccountCapabilities = {
        solAvailable: false,
        proAvailable: false,
      };
      capabilities = await detectChatGptAccountCapabilities(activePage, { selectorTimeoutMs: 15_000 });
      const accountIdentity = await detectChatGptAuthenticatedAccountIdentity(activePage);

      const target = storeProviderSession(state, capabilities);
      return {
        storageStatePath: target,
        accountSurfaceUrl: activePage.url(),
        accountIdentityFingerprint: accountIdentity.fingerprint,
        solAvailable: capabilities.solAvailable,
        proAvailable: capabilities.proAvailable,
      };
    } finally {
      await context?.close().catch(() => {});
    }
  });
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
