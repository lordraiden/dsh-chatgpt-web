import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";

import {
  CHATGPT_WEB_AUTH_PROVIDER_ID,
  CHATGPT_WEB_AUTH_PROVIDER_LABEL,
  CHATGPT_WEB_AUTH_VIEWPORT,
  chatGptWebAuthLaunchArgs,
  createChatGptWebAuthController,
  type ChatGptWebAuthBrowserHandle,
  type ChatGptWebAuthBrowserLaunch,
} from "../src/adapters/chatgpt-web/auth-controller";
import { CHATGPT_WEB_ROUTE_ID, defaultConfig } from "../src/config";
import type { ChatGptWebAccountCapabilities } from "../src/chatgpt-web-models";
import { startServer, type RunningServer } from "../src/server";
import { CHATGPT_WEB_DRIVER_ID } from "../src/web-chat/host/provider-host";
import { createWebChatAuthSessionManager } from "../src/web-chat/host/auth-sessions";
import {
  isWebChatError,
  type AuthSessionState,
  type ProviderAuthController,
  type ProviderAuthSession,
} from "../src/web-chat/core";

/**
 * Issue #276, slice 2b — the ChatGPT Web sign-in controller.
 *
 * Browser-free by construction: every test injects the launch/inspection/store/profile seams, so no
 * Chromium is started, no profile is created and no ChatGPT account is needed. The registration test
 * runs the REAL listener with the REAL controller and a deliberately missing Chrome executable, which
 * is exactly what proves the registration is lazy and the failure is typed at `startAuth()`.
 */

const CONTROL_TOKEN = "issue-276-slice2b-control-token-0123456789";

const ONE_BY_ONE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const CAPTURED_CAPABILITIES: ChatGptWebAccountCapabilities = { solAvailable: true, proAvailable: false };

interface FakePage {
  readonly page: Page;
  readonly calls: {
    clicks: Array<[number, number]>;
    types: string[];
    keys: string[];
    wheels: Array<[number, number]>;
    gotos: string[];
    screenshots: number;
  };
}

function fakePage(options: {
  viewport?: { width: number; height: number };
  closed?: () => boolean;
} = {}): FakePage {
  const viewport = options.viewport ?? { width: 320, height: 480 };
  const calls: FakePage["calls"] = {
    clicks: [],
    types: [],
    keys: [],
    wheels: [],
    gotos: [],
    screenshots: 0,
  };
  const page = {
    viewportSize: () => viewport,
    mouse: {
      click: (x: number, y: number) => { calls.clicks.push([x, y]); },
      wheel: (x: number, y: number) => { calls.wheels.push([x, y]); },
    },
    keyboard: {
      type: (text: string) => { calls.types.push(text); },
      press: (key: string) => { calls.keys.push(key); },
    },
    screenshot: async () => {
      calls.screenshots += 1;
      return Buffer.from(ONE_BY_ONE_PNG);
    },
    goto: async (url: string) => { calls.gotos.push(url); },
    isClosed: () => options.closed?.() ?? false,
  } as unknown as Page;
  return { page, calls };
}

/** A never-resolving inspection: the poll loop parks in `verifying`, so input stays exercisable. */
const neverAuthenticate = (): Promise<ChatGptWebAccountCapabilities> => new Promise(() => {});

function makeController(options: {
  inspect?: (page: Page) => Promise<ChatGptWebAccountCapabilities>;
  page?: FakePage;
  storageState?: unknown;
  store?: (storageState: unknown, capabilities: ChatGptWebAccountCapabilities) => string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxPolls?: number;
  now?: () => number;
  authBrowserMode?: "headless" | "display";
  launched?: ChatGptWebAuthBrowserLaunch[];
}) {
  const page = options.page ?? fakePage();
  const storageState = options.storageState ?? { cookies: [], origins: [] };
  const storeCalls: Array<{ storageState: unknown; capabilities: ChatGptWebAccountCapabilities }> = [];
  const removes: string[] = [];
  let closes = 0;
  const handle: ChatGptWebAuthBrowserHandle = {
    page: page.page,
    storageState: async () => storageState,
    close: async () => { closes += 1; },
  };
  const controller: ProviderAuthController = createChatGptWebAuthController({
    config: { chromeExecutablePath: "/fake/chrome", authBrowserMode: options.authBrowserMode },
    profileRoot: "/fake/profile-root",
    fileExists: () => true,
    createProfile: () => "/fake/profile",
    removeProfile: dir => { removes.push(dir); },
    openBrowser: async launch => {
      options.launched?.push(launch);
      return handle;
    },
    inspectSurface: options.inspect ?? neverAuthenticate,
    storeSession: options.store ?? ((state, capabilities) => {
      storeCalls.push({ storageState: state, capabilities });
      return "/fake/providers/chatgpt-web/storage-state.json";
    }),
    pollIntervalMs: options.pollIntervalMs ?? 1,
    pollTimeoutMs: options.pollTimeoutMs ?? 60_000,
    ...(options.maxPolls !== undefined ? { maxPolls: options.maxPolls } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return {
    controller,
    page,
    storageState,
    storeCalls,
    removes,
    closes: () => closes,
  };
}

async function waitForState(
  session: ProviderAuthSession,
  state: AuthSessionState,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (session.state() !== state) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${state}; saw ${session.state()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe("issue #276 slice 2b — the provider identity and the launch", () => {
  test("the controller serves the catalogue provider id and label", () => {
    expect(CHATGPT_WEB_AUTH_PROVIDER_ID).toBe(CHATGPT_WEB_ROUTE_ID);
    expect(CHATGPT_WEB_AUTH_PROVIDER_ID).toBe(CHATGPT_WEB_DRIVER_ID);
    expect(CHATGPT_WEB_AUTH_PROVIDER_LABEL).toBe("ChatGPT Web");
  });

  test("headless mode launches the configured executable on this session's own profile", async () => {
    const launched: ChatGptWebAuthBrowserLaunch[] = [];
    const { controller, page, closes, removes } = makeController({ launched });
    const session = await controller.startAuth();

    expect(session.providerId).toBe(CHATGPT_WEB_AUTH_PROVIDER_ID);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      executablePath: "/fake/chrome",
      headless: true,
      profileDir: "/fake/profile",
      url: "https://chatgpt.com/",
      viewport: { ...CHATGPT_WEB_AUTH_VIEWPORT },
    });
    expect(session.state()).toBe("awaiting_input");

    // The frame carries the page's real viewport and a PNG; this is the only pixel producer.
    const frame = await session.view();
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(480);
    expect(frame.png.length).toBeGreaterThan(0);
    expect(page.calls.screenshots).toBe(1);
    // The live page is navigated once at launch (inside the browser seam), never per frame.
    expect(page.calls.gotos).toEqual([]);

    await session.cancel();
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);
  });

  test("the launch flags keep --headless=new in args for headless and drop it for display", () => {
    const viewport = { width: 1280, height: 800 };
    const headless = chatGptWebAuthLaunchArgs({ headless: true, viewport });
    expect(headless).toContain("--headless=new");
    expect(headless).toContain("--disable-blink-features=AutomationControlled");
    expect(headless).toContain("--no-first-run");
    expect(headless).toContain("--no-default-browser-check");
    expect(headless).toContain("--window-size=1280,800");
    expect(headless.some(arg => arg.startsWith("--user-agent="))).toBe(true);
    // Playwright's own flag would be `--headless` alone; the repo's pattern is the `=new` form in args.
    expect(headless).not.toContain("--headless");

    const display = chatGptWebAuthLaunchArgs({ headless: false, viewport });
    expect(display).not.toContain("--headless=new");
    expect(display.some(arg => arg.startsWith("--user-agent="))).toBe(false);
    expect(display).toContain("--disable-blink-features=AutomationControlled");
  });

  test("display mode requests a headed launch; the config field defaults to headless when absent", async () => {
    const displayLaunches: ChatGptWebAuthBrowserLaunch[] = [];
    const display = makeController({ authBrowserMode: "display", launched: displayLaunches });
    const displaySession = await display.controller.startAuth();
    expect(displayLaunches[0]?.headless).toBe(false);
    await displaySession.cancel();

    const headlessLaunches: ChatGptWebAuthBrowserLaunch[] = [];
    const headless = makeController({ launched: headlessLaunches });
    const headlessSession = await headless.controller.startAuth();
    expect(headlessLaunches[0]?.headless).toBe(true);
    await headlessSession.cancel();
  });

  test("a missing Chrome is a typed startAuth failure, not a startup failure, and creates no profile", async () => {
    const creates: string[] = [];
    const controller = createChatGptWebAuthController({
      config: { chromeExecutablePath: "/definitely/not/chrome" },
      fileExists: () => false,
      createProfile: root => { creates.push(root); return "/should/not/exist"; },
      removeProfile: () => {},
    });
    const failure = await controller.startAuth().catch(error => error);
    expect(isWebChatError(failure)).toBe(true);
    expect(failure).toMatchObject({
      category: "TRANSPORT_UNAVAILABLE",
      providerCode: "CHROME_EXECUTABLE_MISSING",
    });
    expect((failure as Error).message).toContain("/definitely/not/chrome");
    expect(creates).toEqual([]);
  });

  test("a launch that throws removes the profile it created and reports a typed transport failure", async () => {
    const removes: string[] = [];
    const controller = createChatGptWebAuthController({
      config: { chromeExecutablePath: "/fake/chrome" },
      fileExists: () => true,
      createProfile: () => "/fake/profile",
      removeProfile: dir => { removes.push(dir); },
      openBrowser: async () => { throw new Error("launch exploded at https://chatgpt.com/?code=secret"); },
    });
    const failure = await controller.startAuth().catch(error => error);
    expect(failure).toMatchObject({ category: "TRANSPORT_UNAVAILABLE", providerCode: "BROWSER_LAUNCH_FAILED" });
    // The URL with its one-time code must never survive into the diagnostic.
    expect((failure as Error).message).not.toContain("?code=secret");
    expect((failure as Error).message).toContain("[url]");
    expect(removes).toEqual(["/fake/profile"]);
  });
});

describe("issue #276 slice 2b — input mapping", () => {
  test("each AuthInput maps to exactly the page call the contract names", async () => {
    const { controller, page } = makeController({});
    const session = await controller.startAuth();

    await session.input({ type: "click", x: 10, y: 20 });
    expect(page.calls.clicks).toEqual([[10, 20]]);

    await session.input({ type: "type", text: "user@example.test" });
    expect(page.calls.types).toEqual(["user@example.test"]);

    await session.input({ type: "key", key: "Enter" });
    expect(page.calls.keys).toEqual(["Enter"]);

    await session.input({ type: "scroll", dy: 120 });
    expect(page.calls.wheels).toEqual([[0, 120]]);

    await session.input({ type: "navigate", url: "https://chatgpt.com/auth/login" });
    expect(page.calls.gotos).toEqual(["https://chatgpt.com/auth/login"]);

    // Input never produces pixels; only `view()` does.
    expect(page.calls.screenshots).toBe(0);
    await session.cancel();
  });

  test("a click outside the viewport is refused, not clamped or clicked at random", async () => {
    const { controller, page } = makeController({});
    const session = await controller.startAuth();

    for (const input of [
      { type: "click" as const, x: 320, y: 10 },
      { type: "click" as const, x: 10, y: 480 },
      { type: "click" as const, x: -1, y: 10 },
      { type: "click" as const, x: 10, y: -1 },
    ]) {
      const failure = await session.input(input).catch(error => error);
      expect(isWebChatError(failure)).toBe(true);
      expect(failure).toMatchObject({ category: "UNSUPPORTED_OPTION", providerCode: "AUTH_CLICK_OUT_OF_VIEWPORT" });
    }
    expect(page.calls.clicks).toEqual([]);

    // The last valid pixel of the viewport is still clickable.
    await session.input({ type: "click", x: 319, y: 479 });
    expect(page.calls.clicks).toEqual([[319, 479]]);
    await session.cancel();
  });

  test("a failed navigation intent is reported without leaking the URL and its query", async () => {
    const { controller, page } = makeController({});
    const session = await controller.startAuth();
    page.page.goto = (async () => {
      throw new Error("page.goto: net::ERR_ABORTED at https://chatgpt.com/auth/callback?code=very-secret");
    }) as unknown as Page["goto"];

    const failure = await session.input({ type: "navigate", url: "https://chatgpt.com/auth/callback?code=very-secret" })
      .catch(error => error);
    expect(failure).toMatchObject({ category: "TRANSPORT_UNAVAILABLE", providerCode: "AUTH_NAVIGATION_FAILED" });
    expect((failure as Error).message).not.toContain("very-secret");
    await session.cancel();
  });
});

describe("issue #276 slice 2b — completion and teardown", () => {
  test("a surface that authenticates after N polls drives verifying → captured", async () => {
    let inspections = 0;
    const { controller, page, closes, removes } = makeController({
      inspect: async () => {
        inspections += 1;
        if (inspections < 3) throw new Error("the composer is not visible yet");
        return CAPTURED_CAPABILITIES;
      },
    });
    const session = await controller.startAuth();
    await waitForState(session, "captured");
    expect(inspections).toBeGreaterThanOrEqual(3);
    expect(page.calls.screenshots).toBe(0);

    // Capturing teardown: the browser and the temporary profile are both released.
    await session.cancel();
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);

    const frame = await session.view().catch(error => error);
    expect(isWebChatError(frame)).toBe(true);
  });

  test("a surface that never authenticates fails at the attempt bound with a non-secret detail", async () => {
    const { controller, closes, removes } = makeController({
      inspect: async () => { throw new Error("not authenticated"); },
      maxPolls: 3,
    });
    const session = await controller.startAuth();
    await waitForState(session, "failed");
    expect(session.detail?.()).toContain("did not authenticate");
    expect(session.detail?.()).not.toContain("http");

    await session.cancel(); // idempotent: it merely awaits the teardown the failure started
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);
  });

  test("a surface that never authenticates fails at the TTL bound too", async () => {
    let clock = 0;
    const { controller } = makeController({
      inspect: async () => { clock += 500; throw new Error("not authenticated"); },
      now: () => clock,
      pollTimeoutMs: 1_000,
    });
    const session = await controller.startAuth();
    await waitForState(session, "failed");
    expect(session.detail?.()).toContain("within 1000ms");
  });

  test("a browser that dies mid-flight fails with the closed detail and still tears down", async () => {
    let inspections = 0;
    const page = fakePage({ closed: () => inspections >= 2 });
    const { controller, closes, removes } = makeController({
      page,
      inspect: async () => { inspections += 1; throw new Error("not authenticated"); },
    });
    const session = await controller.startAuth();
    await waitForState(session, "failed");
    expect(session.detail?.()).toContain("browser closed");

    await session.cancel();
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);
  });

  test("cancel closes the browser and removes the temporary profile, idempotently", async () => {
    const { controller, closes, removes } = makeController({});
    const session = await controller.startAuth();
    expect(session.state()).toBe("awaiting_input");

    await session.cancel();
    expect(session.state()).toBe("expired");
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);

    await session.cancel();
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);
  });
});

describe("issue #276 slice 2b — capture and store", () => {
  test("capture returns the opaque browser-storage kind and storeCapture writes once with the capabilities", async () => {
    const storageState = { cookies: [{ name: "session", value: "opaque" }], origins: [] };
    let inspections = 0;
    const { controller, storeCalls, closes, removes } = makeController({
      storageState,
      inspect: async () => {
        inspections += 1;
        if (inspections < 2) throw new Error("not yet");
        return CAPTURED_CAPABILITIES;
      },
    });
    const session = await controller.startAuth();
    await waitForState(session, "captured");

    const capture = await session.capture();
    expect(capture.kind).toBe("browser-storage");
    expect(capture).toEqual({ kind: "browser-storage", storageState });

    const result = await controller.storeCapture(capture);
    expect(result).toEqual({ stored: true, location: "/fake/providers/chatgpt-web/storage-state.json" });
    expect(storeCalls).toHaveLength(1);
    // The exact opaque object and the detected capabilities are paired; the host never sees either.
    expect(storeCalls[0]!.storageState).toBe(storageState);
    expect(storeCalls[0]!.capabilities).toEqual(CAPTURED_CAPABILITIES);

    await session.cancel();
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);
  });

  test("capture is refused before the sign-in completes and storeCapture refuses a foreign capture", async () => {
    const { controller, storeCalls } = makeController({});
    const session = await controller.startAuth();

    const early = await session.capture().catch(error => error);
    expect(isWebChatError(early)).toBe(true);
    expect(early).toMatchObject({ category: "CONVERSATION_STATE_MISMATCH" });

    const foreign = await controller.storeCapture({
      kind: "browser-storage",
      storageState: { cookies: [], origins: [] },
    }).catch(error => error);
    expect(foreign).toMatchObject({ category: "CONVERSATION_STATE_MISMATCH" });
    // A capture of another kind is simply not this controller's to write.
    expect(await controller.storeCapture({ kind: "opaque", payload: {} })).toEqual({ stored: false });
    expect(await controller.storeCapture({ kind: "none" })).toEqual({ stored: false });
    expect(storeCalls).toHaveLength(0);

    await session.cancel();
  });
});

describe("issue #276 slice 2b — a failed provider carries its non-secret detail", () => {
  test("the session manager surfaces a provider's failed detail through the snapshot", async () => {
    const provider: ProviderAuthSession = {
      providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
      state: () => "failed",
      detail: () => "The sign-in browser closed before the sign-in completed",
      view: async () => { throw new Error("no frame"); },
      input: async () => {},
      capture: async () => ({ kind: "none" }),
      cancel: async () => {},
    };
    const controller: ProviderAuthController = {
      startAuth: async () => provider,
      storeCapture: async () => ({ stored: false }),
    };
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({ providerId: CHATGPT_WEB_AUTH_PROVIDER_ID, controller });
    expect(handle.state()).toBe("failed");
    expect(handle.snapshot().detail).toBe("The sign-in browser closed before the sign-in completed");
    await manager.close();
  });

  test("a provider whose detail() misbehaves still fails readably", async () => {
    const provider: ProviderAuthSession = {
      providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
      state: () => "failed",
      detail: () => { throw new Error("detail is broken"); },
      view: async () => { throw new Error("no frame"); },
      input: async () => {},
      capture: async () => ({ kind: "none" }),
      cancel: async () => {},
    };
    const manager = createWebChatAuthSessionManager({ sweepIntervalMs: 0 });
    const handle = await manager.open({
      providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
      controller: { startAuth: async () => provider, storeCapture: async () => ({ stored: false }) },
    });
    expect(handle.state()).toBe("failed");
    expect(handle.snapshot().detail).toBeUndefined();
    await manager.close();
  });
});

describe("issue #276 slice 2b — the real listener registers the controller lazily", () => {
  const running: RunningServer[] = [];
  afterEach(async () => {
    while (running.length > 0) {
      const server = running.pop()!;
      await Promise.race([
        Promise.resolve(server.stop(true)).catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
  });

  test("with no auth override the listener lists chatgpt-web and only fails when sign-in is asked to start", async () => {
    // A missing executable is the whole point: if registration launched anything, the listener could
    // not start at all. It starts, serves the catalogue, and fails typed only on the opening request.
    const server = startServer({
      ...defaultConfig(),
      port: 0,
      host: "127.0.0.1",
      controlToken: CONTROL_TOKEN,
      chromeExecutablePath: join(tmpdir(), `dsh-missing-chrome-${process.pid}-${Date.now()}`),
    });
    running.push(server);
    expect(server.port).toBeGreaterThan(0);

    const base = `http://127.0.0.1:${server.port}`;
    const control = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };

    const providers = await fetch(`${base}/v1/control/auth/providers`, { headers: control });
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual({
      ok: true,
      providers: [{ providerId: CHATGPT_WEB_AUTH_PROVIDER_ID, label: CHATGPT_WEB_AUTH_PROVIDER_LABEL }],
    });

    // The API key cannot open this surface, and the control token still opens it (authority unchanged).
    expect((await fetch(`${base}/v1/control/auth/providers`, {
      headers: { authorization: "Bearer some-api-key-value-0123456789" },
    })).status).toBe(401);

    const open = await fetch(`${base}/v1/control/auth/sessions`, {
      method: "POST",
      headers: control,
      body: JSON.stringify({ providerId: CHATGPT_WEB_AUTH_PROVIDER_ID }),
    });
    expect(open.status).toBe(409);
    const body = await open.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("TRANSPORT_UNAVAILABLE");
    expect(body.message).toContain("Chrome was not found");
  });

  test("an explicit auth override replaces the default entirely", async () => {
    const server = startServer(
      { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN },
      { auth: { providers: [] } },
    );
    running.push(server);
    const providers = await fetch(`http://127.0.0.1:${server.port}/v1/control/auth/providers`, {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    expect(await providers.json()).toEqual({ ok: true, providers: [] });
  });
});
