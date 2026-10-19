import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";

import {
  QWEN_CODE_AUTH_PROVIDER_LABEL,
  QWEN_CODE_AUTH_VIEWPORT,
  QWEN_CODE_DRIVER_ID,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CODE_ROUTE_ID,
  QWEN_CODE_ROOT_URL,
  createQwenCodeAuthController,
  qwenCodeAuthLaunchArgs,
  qwenTaskListAuthenticated,
  qwenTaskListRefusal,
  sanitizeQwenStorageState,
  storeQwenSession,
  type QwenCodeAuthBrowserHandle,
  type QwenCodeAuthBrowserLaunch,
  type QwenCodeSessionProbeResult,
} from "../src/adapters/qwen-code";
import { CHATGPT_WEB_AUTH_PROVIDER_ID } from "../src/adapters/chatgpt-web/auth-controller";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";
import { CHATGPT_WEB_DRIVER_ID } from "../src/web-chat/host/provider-host";
import { startServer, type RunningServer } from "../src/server";
import { defaultConfig } from "../src/config";
import {
  isWebChatError,
  isProviderAuthView,
  type AuthInput,
  type AuthSessionState,
  type ProviderAuthController,
  type ProviderAuthSession,
} from "../src/web-chat/core";

/**
 * Issue #299, slice 1 — the Qwen Code sign-in controller.
 *
 * Browser-free by construction: launch, probe, storage and profile seams are injected, so no Chromium
 * is started and no Qwen account is needed. The one test that uses the *real* probe does so through a
 * fake page's request facility, which is exactly the seam the default implementation uses.
 */

const ONE_BY_ONE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const STORAGE_STATE = {
  cookies: [
    { name: "session", value: "not-a-real-cookie", domain: ".qwen.ai", path: "/" },
    { name: "tracking", value: "not-a-real-cookie", domain: ".doubleclick.net", path: "/" },
  ],
  origins: [
    { origin: "https://coder.qwen.ai", localStorage: [{ name: "synthetic", value: "synthetic" }] },
    { origin: "https://example.invalid", localStorage: [] },
  ],
};

/** The payload the captured service returns to an anonymous caller (status 200!). */
const ANONYMOUS_TASK_LIST = {
  success: false,
  request_id: "request-fixture",
  data: { code: "Unauthorized", details: "401 Unauthorized" },
};

/** The payload a signed-in caller gets. */
const AUTHENTICATED_TASK_LIST = {
  success: true,
  request_id: "request-fixture",
  data: [{ id: "chat-fixture", title: "fixture", pinned: false, archived: false, status: "finished" }],
};

interface FakePage {
  readonly page: Page;
  readonly calls: {
    clicks: Array<[number, number]>;
    types: string[];
    keys: string[];
    wheels: Array<[number, number]>;
    gotos: string[];
    screenshots: Array<{ caret?: string; type?: string }>;
    probes: string[];
  };
}

function fakePage(options: {
  readonly viewport?: { width: number; height: number };
  readonly closed?: () => boolean;
  readonly probeResponse?: unknown;
} = {}): FakePage {
  const viewport = options.viewport ?? { width: 320, height: 480 };
  const calls: FakePage["calls"] = { clicks: [], types: [], keys: [], wheels: [], gotos: [], screenshots: [], probes: [] };
  const page = {
    viewportSize: () => viewport,
    mouse: {
      click: (x: number, y: number) => { calls.clicks.push([x, y]); },
      wheel: (x: number, y: number) => { calls.wheels.push([x, y]); },
    },
    keyboard: {
      type: (text: string) => {
        if (options.closed?.()) throw new Error("Target page, context or browser has been closed");
        calls.types.push(text);
      },
      press: (key: string) => { calls.keys.push(key); },
    },
    screenshot: async (screenshotOptions?: { caret?: string; type?: string }) => {
      calls.screenshots.push(screenshotOptions ?? {});
      return Buffer.from(ONE_BY_ONE_PNG);
    },
    goto: async (url: string) => { calls.gotos.push(url); },
    isClosed: () => options.closed?.() ?? false,
    request: {
      get: async (url: string) => {
        calls.probes.push(url);
        return {
          status: () => 200,
          json: async () => options.probeResponse ?? AUTHENTICATED_TASK_LIST,
        };
      },
    },
  } as unknown as Page;
  return { page, calls };
}

interface Harness {
  readonly controller: ProviderAuthController;
  readonly fake: FakePage;
  readonly launched: QwenCodeAuthBrowserLaunch[];
  readonly removes: string[];
  readonly closes: () => number;
  readonly storageState: { cookies: unknown[]; origins: unknown[] };
}

function makeController(options: {
  readonly probe?: (page: Page) => Promise<QwenCodeSessionProbeResult>;
  readonly fake?: FakePage;
  readonly storageState?: unknown;
  readonly authBrowserMode?: "headless" | "display";
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly maxPolls?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly createProfile?: (root: string) => string;
  readonly openBrowser?: (launch: QwenCodeAuthBrowserLaunch) => Promise<QwenCodeAuthBrowserHandle>;
  readonly fileExists?: (path: string) => boolean;
  readonly storeSession?: (storageState: unknown) => string;
} = {}): Harness {
  const fake = options.fake ?? fakePage();
  const launched: QwenCodeAuthBrowserLaunch[] = [];
  const removes: string[] = [];
  const storageState = (options.storageState ?? STORAGE_STATE) as Harness["storageState"];
  let closes = 0;
  const handle: QwenCodeAuthBrowserHandle = {
    page: fake.page,
    storageState: async () => storageState,
    close: async () => { closes += 1; },
  };
  const controller = createQwenCodeAuthController({
    config: { chromeExecutablePath: "/fake/chrome", authBrowserMode: options.authBrowserMode },
    profileRoot: "/fake/profile-root",
    fileExists: options.fileExists ?? (() => true),
    createProfile: options.createProfile ?? (() => "/fake/profile"),
    removeProfile: dir => { removes.push(dir); },
    openBrowser: options.openBrowser ?? (async launch => {
      launched.push(launch);
      return handle;
    }),
    ...(options.probe === undefined ? {} : { probeSession: options.probe }),
    storeSession: options.storeSession ?? (() => "/fake/providers/qwen-code/storage-state.json"),
    pollIntervalMs: options.pollIntervalMs ?? 1,
    pollTimeoutMs: options.pollTimeoutMs ?? 60_000,
    ...(options.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  return { controller, fake, launched, removes, closes: () => closes, storageState };
}

async function waitForState(
  session: ProviderAuthSession,
  state: AuthSessionState,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (session.state() !== state) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${state}; saw ${session.state()}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** A probe that never authenticates, but yields so the poll loop is not starved. */
const neverAuthenticated = async (): Promise<QwenCodeSessionProbeResult> => {
  throw new Error("the task list answered HTTP 200 with Unauthorized 401 Unauthorized");
};

describe("issue #299 — provider identity and the launch", () => {
  test("one id serves the catalogue route, the driver and the sign-in surface", () => {
    expect(QWEN_CODE_PROVIDER_ID).toBe("qwen-code");
    expect(QWEN_CODE_ROUTE_ID).toBe(QWEN_CODE_PROVIDER_ID);
    expect(QWEN_CODE_DRIVER_ID).toBe(QWEN_CODE_PROVIDER_ID);
    expect(QWEN_CODE_AUTH_PROVIDER_LABEL).toBe("Qwen Code");
  });

  test("headless launches the configured executable on this session's own profile", async () => {
    const harness = makeController();
    const session = await harness.controller.startAuth();

    expect(session.providerId).toBe(QWEN_CODE_PROVIDER_ID);
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0]).toMatchObject({
      executablePath: "/fake/chrome",
      headless: true,
      profileDir: "/fake/profile",
      url: QWEN_CODE_ROOT_URL,
      viewport: { ...QWEN_CODE_AUTH_VIEWPORT },
    });
    expect(session.state()).toBe("awaiting_input");

    const frame = await session.view();
    expect(isProviderAuthView(frame)).toBe(true);
    expect(frame).toMatchObject({ width: 320, height: 480 });
    // The caret stays visible in the relayed pixels, exactly like the ChatGPT sign-in.
    expect(harness.fake.calls.screenshots[0]).toEqual({ type: "png", caret: "initial" });

    await session.cancel();
    expect(harness.launched[0]?.url).toBe("https://coder.qwen.ai/");
  });

  test("the launch flags request old-style headless in args, and never spoof the user agent", () => {
    const headless = qwenCodeAuthLaunchArgs({ headless: true, viewport: { width: 1280, height: 800 } });
    expect(headless).toContain("--headless=new");
    expect(headless).toContain("--disable-blink-features=AutomationControlled");
    expect(headless).toContain("--no-first-run");
    expect(headless).toContain("--no-default-browser-check");
    expect(headless).toContain("--window-size=1280,800");
    // The live probe showed the plain headless user agent is served the app shell and the login form,
    // so this provider carries no user-agent override at all.
    expect(headless.some(argument => argument.startsWith("--user-agent="))).toBe(false);
    // Playwright's own flag is `--headless`; the repository's shape is the `=new` form in args.
    expect(headless).not.toContain("--headless");

    const display = qwenCodeAuthLaunchArgs({ headless: false, viewport: { width: 1280, height: 800 } });
    expect(display).not.toContain("--headless=new");
  });

  test("display mode requests a headed launch; the config field defaults to headless", async () => {
    const display = makeController({ authBrowserMode: "display" });
    const displaySession = await display.controller.startAuth();
    expect(display.launched[0]?.headless).toBe(false);
    await displaySession.cancel();

    const headless = makeController();
    const headlessSession = await headless.controller.startAuth();
    expect(headless.launched[0]?.headless).toBe(true);
    await headlessSession.cancel();
  });

  test("a missing Chrome is a typed startAuth failure and creates no profile", async () => {
    const created: string[] = [];
    const controller = createQwenCodeAuthController({
      config: { chromeExecutablePath: "/definitely/not/chrome" },
      fileExists: () => false,
      createProfile: () => { created.push("profile"); return "/should/not/exist"; },
      removeProfile: () => {},
    });
    const failure = await controller.startAuth().catch(error => error);
    expect(isWebChatError(failure)).toBe(true);
    expect(failure).toMatchObject({ category: "TRANSPORT_UNAVAILABLE", providerCode: "CHROME_EXECUTABLE_MISSING" });
    expect((failure as Error).message).toContain("/definitely/not/chrome");
    expect(created).toEqual([]);
  });

  test("a launch that throws removes the profile it created and reports a typed transport failure", async () => {
    const removes: string[] = [];
    const controller = createQwenCodeAuthController({
      config: { chromeExecutablePath: "/fake/chrome" },
      fileExists: () => true,
      createProfile: () => "/fake/profile",
      removeProfile: dir => { removes.push(dir); },
      openBrowser: async () => { throw new Error("browser blocked at https://coder.qwen.ai/?code=secret"); },
      sleep: async () => {},
    });
    const failure = await controller.startAuth().catch(error => error);
    expect(failure).toMatchObject({ category: "TRANSPORT_UNAVAILABLE", providerCode: "BROWSER_LAUNCH_FAILED" });
    // The URL (and its query) never reaches the diagnostic.
    expect((failure as Error).message).toContain("[url]");
    expect((failure as Error).message).not.toContain("secret");
    expect(removes).toEqual(["/fake/profile"]);
  });
});

describe("issue #299 — the state machine and the structural authenticated check", () => {
  test("the default probe is the API, and the captured anonymous payload does not authenticate", async () => {
    const harness = makeController({ fake: fakePage({ probeResponse: ANONYMOUS_TASK_LIST }), maxPolls: 2 });
    const session = await harness.controller.startAuth();
    await waitForState(session, "failed");

    expect(harness.fake.calls.probes.length).toBeGreaterThanOrEqual(1);
    // Same-origin API, not a page scrape.
    expect(harness.fake.calls.probes[0]).toBe("https://coder.qwen.ai/coder/api/v2/task/list?page=1");
    expect(session.detail?.()).toContain("did not authenticate");
    // The last probe's own answer is part of the failure, not just a bare timeout.
    expect(session.detail?.()).toContain("Unauthorized");

    const capture = await session.capture().catch(error => error);
    expect(isWebChatError(capture)).toBe(true);
    expect(capture).toMatchObject({ category: "CONVERSATION_STATE_MISMATCH" });
  });

  test("the default probe accepts an authenticated task list and captures the session", async () => {
    const harness = makeController({ fake: fakePage({ probeResponse: AUTHENTICATED_TASK_LIST }) });
    const session = await harness.controller.startAuth();
    await waitForState(session, "captured");

    const capture = await session.capture();
    expect(capture.kind).toBe("browser-storage");
    expect((capture as { storageState: unknown }).storageState).toEqual(STORAGE_STATE);
    expect(harness.closes()).toBe(1);
    expect(harness.removes).toEqual(["/fake/profile"]);
  });

  test("a sign-in that never authenticates fails within its bound and tears down", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 3 });
    const session = await harness.controller.startAuth();
    await waitForState(session, "failed");
    expect(harness.fake.calls.screenshots).toEqual([]);
    expect(session.detail?.()).toContain("3 probes");
    expect(harness.closes()).toBe(1);
    expect(harness.removes).toEqual(["/fake/profile"]);
  });

  test("the time bound is honoured even when the attempt bound is not reached", async () => {
    let clock = 0;
    const harness = makeController({
      probe: neverAuthenticated,
      now: () => clock,
      pollTimeoutMs: 1_000,
      sleep: async () => { clock += 400; },
    });
    const session = await harness.controller.startAuth();
    await waitForState(session, "failed");
    expect(session.detail?.()).toContain("1000ms");
  });

  test("an authenticated session that cannot be read is a typed, sanitized failure", async () => {
    // The handle's reader throws a query-bearing URL, which must never reach the diagnostic.
    const broken = createQwenCodeAuthController({
      config: { chromeExecutablePath: "/fake/chrome" },
      fileExists: () => true,
      createProfile: () => "/fake/profile",
      removeProfile: () => {},
      probeSession: async () => ({ authenticated: true, probe: "task-list", status: 200 }),
      openBrowser: async () => ({
        page: fakePage().page,
        storageState: async () => { throw new Error("read failed at https://coder.qwen.ai/?code=abc123"); },
        close: async () => {},
      }),
      pollIntervalMs: 1,
    });
    const session = await broken.startAuth();
    await waitForState(session, "failed");
    expect(session.detail?.()).toContain("[url]");
    expect(session.detail?.()).not.toContain("abc123");
  });
});

describe("issue #299 — input relay and typed refusals", () => {
  test("click, type, key and scroll reach the page in the operator's own vocabulary", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1_000 });
    const session = await harness.controller.startAuth();
    await waitForState(session, "awaiting_input");

    await session.input({ type: "click", x: 12, y: 34 });
    await session.input({ type: "type", text: "operator@example.invalid" });
    await session.input({ type: "key", key: "Enter" });
    await session.input({ type: "scroll", dy: 120 });

    expect(harness.fake.calls.clicks).toEqual([[12, 34]]);
    expect(harness.fake.calls.types).toEqual(["operator@example.invalid"]);
    expect(harness.fake.calls.keys).toEqual(["Enter"]);
    expect(harness.fake.calls.wheels).toEqual([[0, 120]]);
    await session.cancel();
  });

  test("a navigation intent is followed by the page", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1_000 });
    const session = await harness.controller.startAuth();
    await session.input({ type: "navigate", url: "https://coder.qwen.ai/auth?action=signin&from=coder" });
    expect(harness.fake.calls.gotos).toEqual(["https://coder.qwen.ai/auth?action=signin&from=coder"]);
    await session.cancel();
  });

  test("an out-of-viewport click is refused, never clamped", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1_000 });
    const session = await harness.controller.startAuth();
    const failure = await session.input({ type: "click", x: 320, y: 10 }).catch(error => error);
    expect(failure).toMatchObject({ category: "UNSUPPORTED_OPTION", providerCode: "AUTH_CLICK_OUT_OF_VIEWPORT" });
    expect(harness.fake.calls.clicks).toEqual([]);
    await session.cancel();
  });

  test("an unknown input type is a programmer error, not an upstream failure", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1_000 });
    const session = await harness.controller.startAuth();
    const failure = await session.input({ type: "drop" } as unknown as AuthInput).catch(error => error);
    expect(failure).toBeInstanceOf(TypeError);
    await session.cancel();
  });

  test("a dead page while relaying input fails the session as a 502-class upstream error", async () => {
    let closed = false;
    const harness = makeController({
      fake: fakePage({ closed: () => closed }),
      probe: neverAuthenticated,
      maxPolls: 1_000,
    });
    const session = await harness.controller.startAuth();
    closed = true;
    const failure = await session.input({ type: "type", text: "x" }).catch(error => error);
    expect(failure).toMatchObject({ category: "UPSTREAM_ERROR", providerCode: "AUTH_PAGE_CLOSED" });
    await waitForState(session, "failed");
    expect(harness.closes()).toBe(1);
    expect(harness.removes).toEqual(["/fake/profile"]);
  });

  test("a closed session refuses pixels and input with a typed transport failure", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1_000 });
    const session = await harness.controller.startAuth();
    await session.cancel();
    expect(await session.view().catch(error => error)).toMatchObject({ category: "TRANSPORT_UNAVAILABLE" });
    expect(await session.input({ type: "type", text: "x" }).catch(error => error))
      .toMatchObject({ category: "TRANSPORT_UNAVAILABLE" });
  });
});

describe("issue #299 — teardown on every exit path", () => {
  test("cancel expires the session and releases the browser and profile exactly once", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1_000 });
    const session = await harness.controller.startAuth();
    await session.cancel();
    expect(session.state()).toBe("expired");
    await session.cancel();
    expect(harness.closes()).toBe(1);
    expect(harness.removes).toEqual(["/fake/profile"]);
  });

  test("a captured session releases the browser and profile before the capture is stored", async () => {
    const order: string[] = [];
    const controller = createQwenCodeAuthController({
      config: { chromeExecutablePath: "/fake/chrome" },
      fileExists: () => true,
      createProfile: () => "/fake/profile",
      removeProfile: () => { order.push("remove-profile"); },
      probeSession: async () => ({ authenticated: true, probe: "task-list", status: 200 }),
      openBrowser: async () => ({
        page: fakePage().page,
        storageState: async () => STORAGE_STATE,
        close: async () => { order.push("close"); },
      }),
      storeSession: () => { order.push("store"); return "/fake/path"; },
      pollIntervalMs: 1,
    });
    const session = await controller.startAuth();
    await waitForState(session, "captured");
    // Success is a teardown path like any other: nothing keeps a profile alive after the capture.
    expect(order).toEqual(["close", "remove-profile"]);
    expect(await controller.storeCapture(await session.capture())).toMatchObject({ stored: true });
    expect(order).toEqual(["close", "remove-profile", "store"]);
  });

  test("a launch failure removes the profile it created", async () => {
    const removes: string[] = [];
    const controller = createQwenCodeAuthController({
      config: { chromeExecutablePath: "/fake/chrome" },
      fileExists: () => true,
      createProfile: () => "/fake/profile",
      removeProfile: dir => { removes.push(dir); },
      openBrowser: async () => { throw new Error("launch failed"); },
      pollIntervalMs: 1,
    });
    await controller.startAuth().catch(() => undefined);
    expect(removes).toEqual(["/fake/profile"]);
  });

  test("storeCapture refuses a capture this controller did not produce", async () => {
    const harness = makeController({ probe: neverAuthenticated, maxPolls: 1 });
    const failure = await harness.controller.storeCapture({
      kind: "browser-storage",
      storageState: { cookies: [], origins: [] },
    }).catch(error => error);
    expect(failure).toMatchObject({ category: "CONVERSATION_STATE_MISMATCH" });
  });

  test("storeCapture reports 'not stored' for another provider's capture shape", async () => {
    const harness = makeController();
    expect(await harness.controller.storeCapture({ kind: "none" })).toEqual({ stored: false });
  });
});

describe("issue #299 — the captured session is provider-scoped and credential-clean", () => {
  test("the anonymous task-list payload is classified as unauthenticated", () => {
    expect(qwenTaskListAuthenticated(ANONYMOUS_TASK_LIST)).toBe(false);
    expect(qwenTaskListRefusal(ANONYMOUS_TASK_LIST)).toBe("Unauthorized 401 Unauthorized");
    expect(qwenTaskListAuthenticated(AUTHENTICATED_TASK_LIST)).toBe(true);
    expect(qwenTaskListAuthenticated({ success: true, data: {} })).toBe(false);
    expect(qwenTaskListAuthenticated(undefined)).toBe(false);
  });

  test("the sanitizer keeps this provider's origins and drops everything else", () => {
    const sanitized = sanitizeQwenStorageState(STORAGE_STATE);
    expect(sanitized.cookies.map(cookie => cookie.domain)).toEqual([".qwen.ai"]);
    expect(sanitized.origins.map(origin => origin.origin)).toEqual(["https://coder.qwen.ai"]);
    // Structural, never throwing: a sanitizer must not be why a signed-in session is discarded.
    expect(sanitizeQwenStorageState(undefined)).toEqual({ cookies: [], origins: [] });
  });

  test("the writer lands in this provider's own credential directory with a verified marker", () => {
    const home = mkdtempSync(join(tmpdir(), "issue-299-qwen-store-"));
    try {
      const location = storeQwenSession(STORAGE_STATE, home);
      expect(location).toBe(join(home, "providers", "qwen-code", "storage-state.json"));
      expect(existsSync(location)).toBe(true);
      const stored = JSON.parse(readFileSync(location, "utf8")) as { cookies: { domain: string }[] };
      expect(stored.cookies.map(cookie => cookie.domain)).toEqual([".qwen.ai"]);

      const marker = JSON.parse(readFileSync(`${location}.verified.json`, "utf8")) as {
        version: number;
        authenticated: boolean;
        verifiedAt: string;
      };
      expect(marker.version).toBe(1);
      expect(marker.authenticated).toBe(true);
      expect(typeof marker.verifiedAt).toBe("string");

      // One provider's directory can never satisfy another provider's check.
      expect(location).not.toContain(CHATGPT_WEB_AUTH_PROVIDER_ID);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("issue #299 — the production listener registers qwen-code lazily", () => {
  const running: RunningServer[] = [];
  let savedHome: ReturnType<typeof captureChatGptWebHome> | undefined;
  let home: string | undefined;

  afterEach(async () => {
    while (running.length > 0) {
      const server = running.pop()!;
      await Promise.race([
        Promise.resolve(server.stop(true)).catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
    if (savedHome !== undefined) restoreChatGptWebHome(savedHome, home);
    savedHome = undefined;
    home = undefined;
  });

  test("the sign-in surface lists both providers, and opening Qwen fails typed before any browser", async () => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-299-qwen-registration-");
    const controlToken = "issue-299-qwen-control-token-0123456789";
    const server = startServer({
      ...defaultConfig(),
      port: 0,
      host: "127.0.0.1",
      controlToken,
      chromeExecutablePath: join(tmpdir(), `dsh-missing-chrome-qwen-${process.pid}-${Date.now()}`),
    });
    running.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const control = { authorization: `Bearer ${controlToken}`, "content-type": "application/json" };

    const providers = await fetch(`${base}/v1/control/auth/providers`, { headers: control });
    const listing = await providers.json() as { providers: { providerId: string; label: string }[] };
    expect(listing.providers).toContainEqual({ providerId: QWEN_CODE_PROVIDER_ID, label: QWEN_CODE_AUTH_PROVIDER_LABEL });

    const open = await fetch(`${base}/v1/control/auth/sessions`, {
      method: "POST",
      headers: control,
      body: JSON.stringify({ providerId: QWEN_CODE_PROVIDER_ID }),
    });
    expect(open.status).toBe(409);
    const body = await open.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("TRANSPORT_UNAVAILABLE");
    expect(body.message).toContain("Chrome was not found");
  });

  test("the ChatGPT registration is untouched by the second provider", async () => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-299-chatgpt-registration-");
    const controlToken = "issue-299-chatgpt-control-token-0123456789";
    const server = startServer({
      ...defaultConfig(),
      port: 0,
      host: "127.0.0.1",
      controlToken,
      chromeExecutablePath: join(tmpdir(), `dsh-missing-chrome-both-${process.pid}-${Date.now()}`),
    });
    running.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const control = { authorization: `Bearer ${controlToken}`, "content-type": "application/json" };

    const open = await fetch(`${base}/v1/control/auth/sessions`, {
      method: "POST",
      headers: control,
      body: JSON.stringify({ providerId: CHATGPT_WEB_DRIVER_ID }),
    });
    expect(open.status).toBe(409);
    expect(((await open.json()) as { code: string }).code).toBe("TRANSPORT_UNAVAILABLE");
  });
});
