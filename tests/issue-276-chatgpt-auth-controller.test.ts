import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
  type ChatGptWebAuthSessionStored,
} from "../src/adapters/chatgpt-web/auth-controller";
import {
  CHATGPT_WEB_ROUTE_ID,
  defaultConfig,
  getConfigPath,
  loadConfig,
  persistAccountIdentityFingerprint,
  providerStorageStatePath,
  resolveProviderStorageStatePath,
  saveConfig,
  type AppConfig,
} from "../src/config";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";
import type { ChatGptWebAccountCapabilities } from "../src/chatgpt-web-models";
import { refreshChatGptWebProviderFacts, startServer, type RunningServer } from "../src/server";
import { storeProviderSession } from "../src/browser-login";
import { CHATGPT_WEB_DRIVER_ID } from "../src/web-chat/host/provider-host";
import { createWebChatAuthSessionManager } from "../src/web-chat/host/auth-sessions";
import { effectiveChatGptWebProviderConfig } from "../src/chatgpt-web-provider-config";
import { resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { browserAccountLeaseInput } from "../src/adapters/chatgpt-web/index";
import { formatDoctorReport } from "../src/doctor";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexProviderConfig } from "../src/types";
import {
  isWebChatError,
  webChatError,
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

/** A realistic 24-hex account fingerprint, i.e. exactly what `accountIdentityFromUserId` produces. */
const IDENTITY_FINGERPRINT = "4f1c9a27b3d05e688a21cc0d";

interface FakePage {
  readonly page: Page;
  readonly calls: {
    clicks: Array<[number, number]>;
    moves: Array<[number, number]>;
    downs: number;
    ups: number;
    types: string[];
    keys: string[];
    wheels: Array<[number, number]>;
    gotos: string[];
    screenshots: number;
    screenshotOptions: Array<{ caret?: string; type?: string }>;
  };
}

function fakePage(options: {
  viewport?: { width: number; height: number };
  closed?: () => boolean;
  /** Fail the Nth `mouse.move` (1-based), which is how a page that dies mid-drag is modelled. */
  failMoveAt?: number;
} = {}): FakePage {
  const viewport = options.viewport ?? { width: 320, height: 480 };
  const calls: FakePage["calls"] = {
    clicks: [],
    moves: [],
    downs: 0,
    ups: 0,
    types: [],
    keys: [],
    wheels: [],
    gotos: [],
    screenshots: 0,
    screenshotOptions: [],
  };
  let moves = 0;
  const page = {
    viewportSize: () => viewport,
    mouse: {
      click: (x: number, y: number) => { calls.clicks.push([x, y]); },
      move: (x: number, y: number) => {
        moves += 1;
        if (options.failMoveAt !== undefined && moves === options.failMoveAt) {
          throw new Error("Target page, context or browser has been closed");
        }
        calls.moves.push([x, y]);
      },
      down: () => { calls.downs += 1; },
      up: () => { calls.ups += 1; },
      wheel: (x: number, y: number) => { calls.wheels.push([x, y]); },
    },
    keyboard: {
      type: (text: string) => { calls.types.push(text); },
      press: (key: string) => { calls.keys.push(key); },
    },
    screenshot: async (screenshotOptions?: { caret?: string; type?: string }) => {
      calls.screenshots += 1;
      calls.screenshotOptions.push(screenshotOptions ?? {});
      return Buffer.from(ONE_BY_ONE_PNG);
    },
    goto: async (url: string) => { calls.gotos.push(url); },
    isClosed: () => options.closed?.() ?? false,
  } as unknown as Page;
  return { page, calls };
}

/**
 * Advance the injected clock by `moveCostMs` every time the fake page moves, so a test can model the
 * real CDP cost of `page.mouse.move` without a browser. The drag replay measures its schedule with the
 * controller's `now` seam, so this is the exact signal it subtracts.
 */
function withMoveCost(fake: FakePage, clock: { value: number }, moveCostMs: number): void {
  const move = fake.page.mouse.move.bind(fake.page.mouse);
  fake.page.mouse.move = (async (x: number, y: number) => {
    move(x, y);
    clock.value += moveCostMs;
  }) as typeof fake.page.mouse.move;
}

/** A never-resolving inspection: the poll loop parks in `verifying`, so input stays exercisable. */
const neverAuthenticate = (): Promise<ChatGptWebAccountCapabilities> => new Promise(() => {});

function makeController(options: {
  inspect?: (page: Page) => Promise<ChatGptWebAccountCapabilities>;
  page?: FakePage;
  storageState?: unknown;
  store?: (storageState: unknown, capabilities: ChatGptWebAccountCapabilities) => string;
  detectIdentity?: (page: Page) => Promise<string>;
  persistIdentity?: (fingerprint: string) => void;
  /** Use the REAL configuration writer instead of the spy, for the persistence tests. */
  realIdentityWriter?: boolean;
  /** The host's one-shot completion signal (issue #287, slice 4b), forwarded to the controller. */
  afterSessionStored?: ChatGptWebAuthSessionStored;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxPolls?: number;
  gestureTimeoutMs?: number;
  now?: () => number;
  /** Pacing seam of the drag relay; the poll loop shares it, so tests filter its interval out. */
  sleep?: (ms: number) => Promise<void>;
  authBrowserMode?: "headless" | "display";
  launched?: ChatGptWebAuthBrowserLaunch[];
}) {
  const page = options.page ?? fakePage();
  const storageState = options.storageState ?? { cookies: [], origins: [] };
  const storeCalls: Array<{ storageState: unknown; capabilities: ChatGptWebAccountCapabilities }> = [];
  const removes: string[] = [];
  /** Every page the completion check probed for the account identity (there must be exactly one). */
  const identityProbes: Page[] = [];
  /** Every fingerprint the controller handed to its writer; empty means it never even tried. */
  const identityWriteAttempts: string[] = [];
  let closes = 0;
  const handle: ChatGptWebAuthBrowserHandle = {
    page: page.page,
    storageState: async () => storageState,
    close: async () => { closes += 1; },
  };
  const detectIdentity = options.detectIdentity ?? (async () => IDENTITY_FINGERPRINT);
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
    detectIdentity: async probe => {
      identityProbes.push(probe);
      return await detectIdentity(probe);
    },
    ...(options.realIdentityWriter === true
      ? {}
      : {
        persistIdentity: (fingerprint: string) => {
          identityWriteAttempts.push(fingerprint);
          options.persistIdentity?.(fingerprint);
        },
      }),
    ...(options.afterSessionStored !== undefined
      ? { afterSessionStored: options.afterSessionStored }
      : {}),
    pollIntervalMs: options.pollIntervalMs ?? 1,
    pollTimeoutMs: options.pollTimeoutMs ?? 60_000,
    ...(options.maxPolls !== undefined ? { maxPolls: options.maxPolls } : {}),
    ...(options.gestureTimeoutMs !== undefined ? { gestureTimeoutMs: options.gestureTimeoutMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });
  return {
    controller,
    page,
    storageState,
    storeCalls,
    removes,
    identityProbes,
    identityWriteAttempts,
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
    // Playwright hides the blinking text caret in screenshots by default. That default is exactly what
    // made a focused field invisible to the operator ("no blinking caret appears"), so the frame must
    // ask for the browser's own caret behaviour on every capture, not just the first one.
    expect(page.calls.screenshotOptions).toEqual([{ type: "png", caret: "initial" }]);
    await session.view();
    expect(page.calls.screenshots).toBe(2);
    expect(page.calls.screenshotOptions.every(option => option.caret === "initial")).toBe(true);
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
  test("a live pointer gesture presses, follows every move and lifts at the exact release", async () => {
    const { controller, page } = makeController({});
    const session = await controller.startAuth();

    await session.input({ type: "pointer-down", x: 10, y: 20 });
    expect(page.calls.moves).toEqual([[10, 20]]);
    expect(page.calls.downs).toBe(1);
    expect(page.calls.ups).toBe(0);
    await session.input({ type: "pointer-move", x: 14, y: 24 });
    await session.input({ type: "pointer-move", x: 20, y: 30 });
    expect(page.calls.moves).toEqual([[10, 20], [14, 24], [20, 30]]);
    await session.input({ type: "pointer-up", x: 33, y: 44 });
    expect(page.calls.moves.at(-1)).toEqual([33, 44]);
    expect(page.calls.ups).toBe(1);
    await session.cancel();
  });

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

  test("a drag is replayed as the operator's own sampled path, in order, with every intermediate move", async () => {
    const clocks = { value: 0 };
    const sleeps: number[] = [];
    const { controller, page } = makeController({
      now: () => clocks.value,
      sleep: async ms => { sleeps.push(ms); clocks.value += ms; },
    });
    const session = await controller.startAuth();
    // A real `page.mouse.move` costs about a frame (~17 ms measured); 10 ms here makes the arithmetic
    // exact and proves the wait is the REMAINDER of the delta, not the whole delta again.
    withMoveCost(page, clocks, 10);

    // A deliberately uneven, non-linear path: the y coordinate rises, dips and rises again.
    const path = [
      { x: 24, y: 260, atMs: 0 },
      { x: 47, y: 257, atMs: 32 },
      { x: 83, y: 264, atMs: 64 },
      { x: 118, y: 251, atMs: 96 },
      { x: 176, y: 245, atMs: 128 },
    ];
    await session.input({ type: "drag", points: path });

    // The anti-collapse assertion: exactly one `mouse.move` per sample, in the drawn order. A
    // "move(start); move(end)" implementation yields two moves, and an interpolated path yields
    // coordinates nobody drew.
    expect(page.calls.moves).toEqual(path.map(point => [point.x, point.y]));
    expect(page.calls.moves.length).toBe(path.length);
    expect(page.calls.downs).toBe(1);
    expect(page.calls.ups).toBe(1);
    // Timing belongs to the input AND to the press's clock: each sample's offset is 32 ms, the press
    // itself costs 10 ms and each move costs 10 ms, so the wait before every sample is 32 - 10 = 22 ms.
    // The old rule slept the full 32 ms on top of the 10 ms move (the double payment that stretched
    // gestures into seconds). The poll loop shares this seam; its 1 ms interval is filtered out.
    expect(sleeps.filter(ms => ms > 1)).toEqual([22, 22, 22, 22]);

    // A held pause is bounded by the relay (250 ms, not seconds), but its release sample is delivered.
    await session.input({ type: "drag", points: [{ x: 5, y: 5, atMs: 0 }, { x: 6, y: 6, atMs: 60_000 }] });
    expect(sleeps.filter(ms => ms > 1).at(-1)).toBe(250);
    expect(page.calls.moves.at(-1)).toEqual([6, 6]);
    await session.cancel();
  });

  test("when a move already costs more than the sample delta, no wait is paid, and no sample is lost", async () => {
    const clocks = { value: 0 };
    const sleeps: number[] = [];
    const { controller, page } = makeController({
      now: () => clocks.value,
      sleep: async ms => { sleeps.push(ms); clocks.value += ms; },
    });
    const session = await controller.startAuth();
    // 20 ms per move against a 12 ms cadence: the recorder is already behind, so every remainder is
    // zero. Sleeping the delta anyway is exactly the "double payment" this test forbids.
    withMoveCost(page, clocks, 20);

    const path = [
      { x: 30, y: 210, atMs: 0 },
      { x: 52, y: 208, atMs: 12 },
      { x: 88, y: 216, atMs: 25 },
      { x: 121, y: 205, atMs: 39 },
      { x: 190, y: 199, atMs: 58 },
    ];
    await session.input({ type: "drag", points: path });

    expect(sleeps.filter(ms => ms > 1)).toEqual([]);
    // The path is still exactly what the operator drew, every sample delivered once, in order.
    expect(page.calls.moves).toEqual(path.map(point => [point.x, point.y]));
    expect(page.calls.downs).toBe(1);
    expect(page.calls.ups).toBe(1);
    await session.cancel();
  });

  test("an exhausted replay budget stops pacing but still delivers every sample and the release", async () => {
    const clocks = { value: 0 };
    const sleeps: number[] = [];
    const { controller, page } = makeController({
      now: () => clocks.value,
      sleep: async ms => { sleeps.push(ms); clocks.value += ms; },
    });
    const session = await controller.startAuth();
    withMoveCost(page, clocks, 10);

    // A long path: pacing alone would take ~6.4 s. The budget caps the waiting at 1 s, then the
    // remaining samples are still moved in order, with no wait, and the last one is the release.
    const points = Array.from({ length: 200 }, (_, index) => ({
      x: 10 + (index % 200),
      y: 20 + (index % 3),
      atMs: index * 32,
    }));
    await session.input({ type: "drag", points });

    const paced = sleeps.filter(ms => ms > 1);
    expect(paced.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);
    expect(paced.every(ms => ms <= 250)).toBe(true);
    // Pacing stopped before the last samples: at least one sample was moved without a wait, which is
    // the budget being enforced rather than the old per-delta sleep being paid to the end.
    expect(paced.length).toBeLessThan(points.length - 1);
    // Nothing was thinned by the budget: every sampled position reached the page, in order.
    expect(page.calls.moves).toEqual(points.map(point => [point.x, point.y]));
    expect(page.calls.downs).toBe(1);
    expect(page.calls.ups).toBe(1);
    await session.cancel();
  });

  test("a drag that leaves the viewport is refused before any press, and the session keeps accepting input", async () => {
    const { controller, page } = makeController({});
    const session = await controller.startAuth();

    for (const points of [
      [{ x: -1, y: 10, atMs: 0 }, { x: 40, y: 40, atMs: 12 }],
      [{ x: 10, y: 10, atMs: 0 }, { x: 40, y: 480, atMs: 12 }],
      [{ x: 10, y: 10, atMs: 0 }, { x: 320, y: 40, atMs: 12 }],
    ]) {
      const failure = await session.input({ type: "drag", points }).catch(error => error);
      expect(isWebChatError(failure)).toBe(true);
      expect(failure).toMatchObject({ category: "UNSUPPORTED_OPTION", providerCode: "AUTH_DRAG_OUT_OF_VIEWPORT" });
    }
    // Refused before the first press: nothing is at random and nothing stays pressed.
    expect(page.calls.moves).toEqual([]);
    expect(page.calls.downs).toBe(0);
    expect(page.calls.ups).toBe(0);

    // A refused gesture does not wedge the session: the next inputs are relayed as usual.
    await session.input({ type: "click", x: 10, y: 10 });
    await session.input({ type: "type", text: "still-live" });
    expect(page.calls.clicks).toEqual([[10, 10]]);
    expect(page.calls.types).toContain("still-live");
    await session.cancel();
  });

  test("a drag that fails while replaying still releases the button, and fails as upstream", async () => {
    const page = fakePage({ failMoveAt: 3 });
    const { controller } = makeController({ page });
    const session = await controller.startAuth();

    const failure = await session.input({
      type: "drag",
      points: [{ x: 10, y: 10, atMs: 0 }, { x: 20, y: 12, atMs: 12 }, { x: 30, y: 15, atMs: 25 }],
    }).catch(error => error);
    expect(failure).toMatchObject({ category: "UPSTREAM_ERROR", providerCode: "AUTH_INPUT_FAILED" });
    // The press happened, the replay failed part-way, and the release still happened in the failure
    // path: the provider's page is never left with a held mouse button.
    expect(page.calls.downs).toBe(1);
    expect(page.calls.ups).toBe(1);
    expect(page.calls.moves).toEqual([[10, 10], [20, 12]]);
    await waitForState(session, "failed");
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

  test("an unexpected page failure on every interaction is the upstream category, and the session fails", async () => {
    // Issue #287 slice 4a / #282. A Playwright failure while relaying click/type/key/scroll used to
    // escape as a raw error, so the sign-in surface answered 500 `auth_unavailable` for what is
    // genuinely an upstream failure. Each interaction is exercised on its own session because the
    // failure is terminal by design: the interactive path is dead and no poll can recover it.
    const blowUp = () => { throw new Error("Target page, context or browser has been closed"); };
    const cases: Array<{
      readonly name: string;
      readonly breakIt: (page: FakePage) => void;
      readonly event: Parameters<ProviderAuthSession["input"]>[0];
    }> = [
      { name: "click", breakIt: page => { page.page.mouse.click = blowUp; }, event: { type: "click", x: 10, y: 20 } },
      { name: "type", breakIt: page => { page.page.keyboard.type = blowUp; }, event: { type: "type", text: "hola" } },
      { name: "key", breakIt: page => { page.page.keyboard.press = blowUp; }, event: { type: "key", key: "Enter" } },
      { name: "scroll", breakIt: page => { page.page.mouse.wheel = blowUp; }, event: { type: "scroll", dy: 120 } },
    ];

    for (const item of cases) {
      const { controller, page, closes, removes } = makeController({});
      const session = await controller.startAuth();
      item.breakIt(page);

      const failure = await session.input(item.event).catch(error => error);
      expect(isWebChatError(failure), item.name).toBe(true);
      expect(failure, item.name).toMatchObject({ category: "UPSTREAM_ERROR", providerCode: "AUTH_INPUT_FAILED" });
      // The session is failed rather than left interactive forever, and its browser/profile are released.
      expect(session.state(), item.name).toBe("failed");
      expect(session.detail?.(), item.name).toContain("could not relay an input");
      await session.cancel();
      expect(closes(), item.name).toBe(1);
      expect(removes, item.name).toEqual(["/fake/profile"]);
    }
  });

  test("a closed page is distinguishable from any other interaction failure, and still non-secret", async () => {
    let closed = false;
    const page = fakePage({ closed: () => closed });
    const { controller, closes, removes } = makeController({ page });
    const session = await controller.startAuth();
    closed = true;
    page.page.keyboard.type = () => {
      throw new Error("Target closed at https://chatgpt.com/auth/callback?code=very-secret");
    };

    const failure = await session.input({ type: "type", text: "user@example.test" }).catch(error => error);
    expect(failure).toMatchObject({ category: "UPSTREAM_ERROR", providerCode: "AUTH_PAGE_CLOSED" });
    expect(session.state()).toBe("failed");
    expect(session.detail?.()).toContain("browser closed");
    // The message is sanitized exactly like every other diagnostic that crosses this boundary.
    expect((failure as Error).message).not.toContain("very-secret");
    expect((failure as Error).message).toContain("[url]");

    await session.cancel();
    expect(closes()).toBe(1);
    expect(removes).toEqual(["/fake/profile"]);
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

describe("issue #276 — a captured session binds the account it signed in", () => {
  /**
   * The production bug these tests pin down: the interactive sign-in stored the session but never the
   * account fingerprint, so the logical identity stayed a fallback (`providerConfig` substitutes the
   * storage-state-derived value for an absent `accountIdentityFingerprint`) and every turn failed
   * closed on the lease's account-binding check. The controller now reads the same probe `login` uses
   * and persists its fingerprint once the session is stored.
   */

  test("the completion check probes identity once on the live page and storeCapture writes that fingerprint", async () => {
    const storageState = { cookies: [{ name: "session", value: "opaque" }], origins: [] };
    let inspections = 0;
    const { controller, page, storeCalls, identityProbes, identityWriteAttempts } = makeController({
      storageState,
      // Three inspections: the detection must happen once, at completion, never per poll.
      inspect: async () => {
        inspections += 1;
        if (inspections < 3) throw new Error("the composer is not visible yet");
        return CAPTURED_CAPABILITIES;
      },
    });
    const session = await controller.startAuth();
    await waitForState(session, "captured");

    // Detection runs against the very page the session drives, exactly once.
    expect(identityProbes).toEqual([page.page]);

    const result = await controller.storeCapture(await session.capture());
    expect(result).toEqual({ stored: true, location: "/fake/providers/chatgpt-web/storage-state.json" });
    expect(storeCalls).toHaveLength(1);
    expect(identityWriteAttempts).toEqual([IDENTITY_FINGERPRINT]);

    await session.cancel();
  });

  test("the real configuration writer persists the fingerprint and leaves every other field untouched", async () => {
    const saved = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("dsh-276-binding-");
    try {
      const initial = {
        ...defaultConfig(),
        port: 4242,
        appName: "issue-276-binding",
        automaticAppName: "issue-276-binding",
      };
      saveConfig(initial);
      const before = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
      expect(before.accountIdentityFingerprint).toBeUndefined();

      let inspections = 0;
      const { controller, identityProbes } = makeController({
        // The REAL default writer: this is the path `storeCapture` takes in production.
        realIdentityWriter: true,
        inspect: async () => {
          inspections += 1;
          if (inspections < 2) throw new Error("not yet");
          return CAPTURED_CAPABILITIES;
        },
      });
      const session = await controller.startAuth();
      await waitForState(session, "captured");
      const result = await controller.storeCapture(await session.capture());
      expect(result).toEqual({ stored: true, location: "/fake/providers/chatgpt-web/storage-state.json" });
      expect(identityProbes).toHaveLength(1);

      const after = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
      expect(after.accountIdentityFingerprint).toBe(IDENTITY_FINGERPRINT);
      const { accountIdentityFingerprint: persisted, ...restAfter } = after;
      const { accountIdentityFingerprint: absent, ...restBefore } = before;
      expect(absent).toBeUndefined();
      expect(persisted).toBe(IDENTITY_FINGERPRINT);
      // Nothing that already existed was clobbered, not the port, not the connector name, and not the
      // configured `storageStatePath` that `loadConfig` resolves for reads only.
      expect(restAfter).toEqual(restBefore);
      expect(after.port).toBe(4242);
      expect(after.appName).toBe("issue-276-binding");
      expect(after.storageStatePath).toBe(initial.storageStatePath);

      // Exactly once at the file too: storing the same value again is a no-op.
      const bytes = readFileSync(getConfigPath(), "utf8");
      expect(persistAccountIdentityFingerprint(IDENTITY_FINGERPRINT)).toBe(false);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);

      await session.cancel();
    } finally {
      restoreChatGptWebHome(saved, home);
    }
  });

  test("a failed session store writes no fingerprint at all", async () => {
    const saved = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("dsh-276-binding-fail-");
    try {
      saveConfig({
        ...defaultConfig(),
        appName: "issue-276-binding-fail",
        automaticAppName: "issue-276-binding-fail",
      });
      const { controller } = makeController({
        realIdentityWriter: true,
        store: () => { throw new Error("EACCES: the storage state could not be written"); },
        inspect: async () => CAPTURED_CAPABILITIES,
      });
      const session = await controller.startAuth();
      await waitForState(session, "captured");

      const failure = await controller.storeCapture(await session.capture()).catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("EACCES");

      // The session never landed, so the account binding must not have either.
      const config = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
      expect(config.accountIdentityFingerprint).toBeUndefined();
      await session.cancel();
    } finally {
      restoreChatGptWebHome(saved, home);
    }
  });

  test("an unreadable account identity keeps the session stored and reports why the next turn fails closed", async () => {
    const { controller, storeCalls, identityWriteAttempts } = makeController({
      storageState: { cookies: [], origins: [] },
      inspect: async () => CAPTURED_CAPABILITIES,
      detectIdentity: async () => {
        throw new Error("auth session probe failed at https://chatgpt.com/api/auth/session?code=very-secret");
      },
    });
    const session = await controller.startAuth();
    await waitForState(session, "captured");

    const result = await controller.storeCapture(await session.capture());
    // Stored, not failed: a session the operator just produced is never thrown away for a missing
    // account binding. But the operator is told, in non-secret terms, that the next turn fails closed.
    expect(result.stored).toBe(true);
    expect(result.location).toBe("/fake/providers/chatgpt-web/storage-state.json");
    expect(result.detail).toContain("account identity could not be read");
    expect(result.detail).toContain("fail closed");
    expect(result.detail).not.toContain("very-secret");
    expect(storeCalls).toHaveLength(1);
    expect(identityWriteAttempts).toEqual([]);

    await session.cancel();
  });

  test("a configuration write failure is reported on the stored capture, never thrown", async () => {
    const { controller, storeCalls, identityWriteAttempts } = makeController({
      storageState: { cookies: [], origins: [] },
      inspect: async () => CAPTURED_CAPABILITIES,
      persistIdentity: () => {
        throw new Error("EACCES: permission denied, open '/operator/.dsh/storages/chatgpt-web/config.json'");
      },
    });
    const session = await controller.startAuth();
    await waitForState(session, "captured");

    const result = await controller.storeCapture(await session.capture());
    expect(result.stored).toBe(true);
    expect(result.detail).toContain("could not be written");
    expect(result.detail).toContain("fail closed");
    expect(storeCalls).toHaveLength(1);
    // The write was attempted exactly once and its failure was reported, not thrown.
    expect(identityWriteAttempts).toEqual([IDENTITY_FINGERPRINT]);

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

  test("with no auth override the listener lists both registered providers and only fails when sign-in is asked to start", async () => {
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
    // Two providers are registered in the production composition: ChatGPT Web (issue #276) and Qwen
    // Code (issue #299). Registration is inert, so listing both still starts nothing.
    expect(await providers.json()).toEqual({
      ok: true,
      providers: [
        { providerId: CHATGPT_WEB_AUTH_PROVIDER_ID, label: CHATGPT_WEB_AUTH_PROVIDER_LABEL },
        { providerId: "qwen-code", label: "Qwen Code" },
      ],
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

describe("issue #276 slice 2c — a client's refusal is a 400, an upstream failure is still a 502", () => {
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

  const CONTROL = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };

  function serve(providers: ReadonlyArray<{
    providerId: string;
    label: string;
    controller: ProviderAuthController;
  }>): RunningServer {
    const server = startServer(
      { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN },
      { auth: { providers: [...providers] } },
    );
    running.push(server);
    return server;
  }

  async function open(server: RunningServer, providerId: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/control/auth/sessions`, {
      method: "POST",
      headers: CONTROL,
      body: JSON.stringify({ providerId }),
    });
    expect(response.status, `open ${providerId}`).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  const postInput = (server: RunningServer, id: string, input: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/v1/control/auth/sessions/${id}/input`, {
      method: "POST",
      headers: CONTROL,
      body: JSON.stringify(input),
    });

  test("a click outside the viewport is the exact 400 with its typed code, and it is never clamped", async () => {
    // The REAL controller and its real viewport arithmetic, with the browser seams injected: no
    // Chromium, no profile and no ChatGPT account.
    const { controller, page } = makeController({});
    const server = serve([{
      providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
      label: CHATGPT_WEB_AUTH_PROVIDER_LABEL,
      controller,
    }]);
    const id = await open(server, CHATGPT_WEB_AUTH_PROVIDER_ID);

    const refused = await postInput(server, id, { type: "click", x: 320, y: 10 });
    // The exact status and the exact typed code: the caller's own bad request, never a 502.
    expect(refused.status).toBe(400);
    const body = await refused.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("UNSUPPORTED_OPTION");
    // The provider's own message says what was wrong; the host adds what to do instead.
    expect(body.message).toContain("outside the 320x480 viewport");
    expect(body.message).toContain("inside the viewport the stream reported");
    // Refused, never clamped into a click at a random coordinate.
    expect(page.calls.clicks).toEqual([]);

    // The good path is untouched: the last valid pixel of the viewport is still relayed verbatim.
    const clicked = await postInput(server, id, { type: "click", x: 319, y: 479 });
    expect(clicked.status).toBe(200);
    expect(page.calls.clicks).toEqual([[319, 479]]);
  });

  test("a genuine upstream failure on the same route is still a 502", async () => {
    const disconnected: ProviderAuthSession = {
      providerId: "broken-web",
      state: () => "awaiting_input",
      view: async () => { throw new Error("no frame"); },
      input: async () => {
        throw webChatError(
          "UPSTREAM_ERROR",
          "The sign-in surface disconnected before the input was relayed",
          { providerId: "broken-web", providerCode: "AUTH_BROWSER_DISCONNECTED" },
        );
      },
      capture: async () => ({ kind: "none" }),
      cancel: async () => {},
    };
    const server = serve([{
      providerId: "broken-web",
      label: "Broken Web",
      controller: {
        async startAuth() { return disconnected; },
        async storeCapture() { return { stored: false }; },
      },
    }]);
    const id = await open(server, "broken-web");

    const failed = await postInput(server, id, { type: "click", x: 10, y: 10 });
    expect(failed.status).toBe(502);
    const body = await failed.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("UPSTREAM_ERROR");
    // A genuine upstream failure is not a client-side refusal, so no client guidance is fabricated.
    expect(body.message).toBe("The sign-in surface disconnected before the input was relayed");
  });

  test("a Playwright failure during input is that same 502, and the session ends failed", async () => {
    // Issue #287 slice 4a / #282, over the REAL listener and the REAL controller with the browser seams
    // injected. Before the fix the raw Playwright error escaped the controller, so this route answered
    // 500 `auth_unavailable` — an internal failure — for a page that had simply gone away.
    const { controller, page } = makeController({});
    const server = serve([{
      providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
      label: CHATGPT_WEB_AUTH_PROVIDER_LABEL,
      controller,
    }]);
    const id = await open(server, CHATGPT_WEB_AUTH_PROVIDER_ID);
    page.page.keyboard.type = () => {
      throw new Error("Target page, context or browser has been closed");
    };

    const failed = await postInput(server, id, { type: "type", text: "user@example.test" });
    expect(failed.status).toBe(502);
    const body = await failed.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.message).toContain("could not relay an input");

    // The session is failed, not interactive forever: the view reports the terminal state.
    const view = await fetch(`http://127.0.0.1:${server.port}/v1/control/auth/sessions/${id}`, { headers: CONTROL });
    expect(view.status).toBe(200);
    expect((await view.json() as { state: string }).state).toBe("failed");

    // A further input on the failed session is refused in the same upstream category, never served.
    const again = await postInput(server, id, { type: "click", x: 10, y: 10 });
    expect(again.status).toBe(502);
    expect((await again.json() as { code: string }).code).toBe("UPSTREAM_ERROR");
    expect(page.calls.clicks).toEqual([]);
  });
});

/**
 * Issue #287, slice 4b — a successful sign-in takes effect without a restart.
 *
 * The owner hit this on a fresh volume: after a successful remote sign-in the session was on disk but
 * the running process kept the facts it resolved at startup, so the next turn failed until
 * `docker restart`. Two halves: the **account identity fingerprint** was written to the config file
 * while the in-memory facts stayed stale, and the **credential path** was resolved once at startup —
 * on a fresh volume at the legacy location, before the new session existed in `providers/<id>/`.
 *
 * Proven here over the REAL listener with the REAL controller and injected browser seams: no
 * Chromium, no ChatGPT account, no network, and — for every live assertion — the same process.
 *
 * The mechanism under test is the **single** refresh primitive in `startServer`, triggered by the
 * controller's one-shot `afterSessionStored`. The suite pins what it is for:
 *
 * - the next request in the same process sees the re-derived facts;
 * - a turn already in flight across the refresh is unaffected: it finishes on the facts it began
 *   with, and is never silently switched mid-turn;
 * - the operator surfaces no longer say "restart" for the half that is fixed, and still do for the
 *   half that is not.
 */
describe("issue #287 slice 4b — a captured sign-in is live on the next turn, with no restart", () => {
  interface LiveSignInFixture {
    readonly home: string;
    readonly server: RunningServer;
    readonly config: AppConfig;
    readonly legacyPath: string;
    /** A snapshot of each provider block the listener's adapter factory received, one per turn. */
    readonly seen: CodexProviderConfig[];
    /** Every completion signal the fixture's controller delivered: the one trigger, exactly once. */
    readonly completions: Array<{ stored: boolean; fingerprint: string; restored: boolean }>;
    openSession(): Promise<string>;
    input(id: string, event: unknown): Promise<Response>;
    view(id: string): Promise<{
      state: string;
      capture?: { stored: boolean; location?: string; detail?: string };
    }>;
    /** Open a session, let its sign-in complete, and hand its capture over through the surface. */
    completeSignIn(): Promise<{ id: string; capture: { stored: boolean; location?: string; detail?: string } }>;
    stop(): Promise<void>;
  }

  /**
   * Serve the real listener over a fresh temporary volume, with the real controller and its browser
   * seams injected. The volume's configured `storageStatePath` is the shipped **legacy** location and
   * it starts with no session at all — exactly the fresh-volume shape the friction was hit on — and
   * the listener starts from the production `loadConfig()` read of it, so its startup facts are the
   * ones production would hold rather than a hand-picked value.
   */
  async function serveLiveSignIn(options: {
    /** When set, the identity writer throws this message: the capture stores but the binding does not. */
    identityWriteFailure?: string;
    /** A turn that stays in flight until the returned release function is called. */
    holdTurnOpen?: boolean;
  } = {}): Promise<LiveSignInFixture & { releaseTurn: () => void }> {
    const home = useTemporaryChatGptWebHome("dsh-287-signin-");
    const legacyPath = join(home, "browser", "storage-state.json");
    saveConfig({
      ...defaultConfig(),
      // A persisted configuration validates a real port; `startServer` is what binds the ephemeral
      // one (the suites' own pattern, asserted on the listener below).
      port: 17841,
      host: "127.0.0.1",
      controlToken: CONTROL_TOKEN,
      authBrowserMode: "headless",
      // The shipped default already points at the legacy location; stated explicitly so the
      // "the startup resolution points at legacy" premise cannot drift with a default change.
      storageStatePath: legacyPath,
      accountIdentityFingerprint: undefined,
    } as AppConfig);
    const config = { ...loadConfig(), port: 0 } as AppConfig;
    expect(config.storageStatePath, "a fresh volume resolves the credential path at startup").toBe(legacyPath);
    expect(config.accountIdentityFingerprint).toBeUndefined();

    let authInspectionReached = false;
    const markAuthReady = (): boolean => {
      if (!authInspectionReached) {
        authInspectionReached = true;
        return false;
      }
      return true;
    };

    const completions: Array<{ stored: boolean; fingerprint: string; restored: boolean }> = [];
    const seen: CodexProviderConfig[] = [];
    let settleTurn: (() => void) | undefined;
    let turnsStarted = 0;
    const runTurn: ProviderAdapter["runTurn"] = async () => {
      // Only the first turn is held open: that is the turn which is "in flight" across the sign-in,
      // and the second turn must be able to complete once the refresh has happened.
      turnsStarted += 1;
      if (options.holdTurnOpen === true && turnsStarted === 1) {
        await new Promise<void>(done => { settleTurn = done; });
      }
    };

    const signIn = makeController({
      storageState: { cookies: [{ name: "session", value: "opaque" }], origins: [] },
      // The first inspection deliberately fails: the sign-in must still be awaiting the operator
      // when `startAuth()` returns, so the HTTP `input` below is the real operator's relay.
      inspect: async () => {
        if (markAuthReady()) return CAPTURED_CAPABILITIES;
        throw new Error("the composer is not visible yet");
      },
      detectIdentity: async () => IDENTITY_FINGERPRINT,
      // The PRODUCTION writer: the session lands in `providers/<id>/`, which is exactly the location
      // a fresh volume's startup resolution did not know about yet.
      store: (state, capabilities) => storeProviderSession(
        state as Parameters<typeof storeProviderSession>[0],
        capabilities,
      ),
      ...(options.identityWriteFailure === undefined
        ? { realIdentityWriter: true }
        : { persistIdentity: () => { throw new Error(options.identityWriteFailure); } }),
      // The production wiring, over the test's controller: the same one-shot completion signal,
      // bound to the same single refresh primitive `startServer` binds its default controller to.
      afterSessionStored: (stored, identity) => {
        completions.push({ stored: stored.stored, fingerprint: identity.fingerprint, restored: identity.restored });
        refreshChatGptWebProviderFacts(config, identity);
      },
    });

    const server = startServer(config, {
      adapterFactory: provider => {
        // The seam: the provider block the real listener resolved for this turn, at turn start.
        seen.push(JSON.parse(JSON.stringify(provider)) as CodexProviderConfig);
        return { name: "issue-287-signin-stub", runTurn };
      },
      auth: {
        providers: [{
          providerId: CHATGPT_WEB_AUTH_PROVIDER_ID,
          label: CHATGPT_WEB_AUTH_PROVIDER_LABEL,
          controller: signIn.controller,
        }],
      },
    });

    expect(server.port, "the listener bound an ephemeral port of its own").toBeGreaterThan(0);
    const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    const control = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };
    const openSession = async (): Promise<string> => {
      const response = await fetch(url("/v1/control/auth/sessions"), {
        method: "POST",
        headers: control,
        body: JSON.stringify({ providerId: CHATGPT_WEB_AUTH_PROVIDER_ID }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const viewOf = async (id: string) => {
      const response = await fetch(url(`/v1/control/auth/sessions/${id}`), { headers: control });
      expect(response.status).toBe(200);
      return await response.json() as Awaited<ReturnType<LiveSignInFixture["view"]>>;
    };
    return {
      home,
      server,
      config,
      legacyPath,
      seen,
      completions,
      releaseTurn: () => { settleTurn?.(); },
      openSession,
      input: (id, event) => fetch(url(`/v1/control/auth/sessions/${id}/input`), {
        method: "POST",
        headers: control,
        body: JSON.stringify(event),
      }),
      view: viewOf,
      async completeSignIn() {
        const id = await openSession();
        // The real controller runs its own poll loop and reaches `captured` on its own. Without a
        // restart, and with nothing else driving it: the listener is the only party that acts.
        const deadline = Date.now() + 2_000;
        for (;;) {
          const snapshot = await viewOf(id);
          if (snapshot.state === "captured" && snapshot.capture !== undefined) {
            expect(snapshot.capture.stored, "the capture is handed over through the surface").toBe(true);
            return { id, capture: snapshot.capture };
          }
          if (Date.now() > deadline) throw new Error(`the sign-in never captured; last state ${snapshot.state}`);
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      },
      async stop() {
        await Promise.race([
          Promise.resolve(server.stop(true)).catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
      },
    };
  }

  const bearerControl = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };

  /** POST one turn at the listener's `/v1/responses` route. */
  const postTurn = async (fixture: LiveSignInFixture, input: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("postTurn timeout")), 3_000);
    try {
      return await fetch(`http://127.0.0.1:${fixture.server.port}/v1/responses`, {
        method: "POST",
        headers: bearerControl,
        body: JSON.stringify({ model: "chatgpt-web/luna", input, stream: false }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const readControlStatus = async (fixture: LiveSignInFixture): Promise<{
    storageStatePath: string;
    storageStatePresent: boolean;
  }> => {
    const response = await fetch(`http://127.0.0.1:${fixture.server.port}/v1/control/status`, {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(200);
    return await response.json() as { storageStatePath: string; storageStatePresent: boolean };
  };

  test("the next request in the same process uses the new identity and credential path", async () => {
    const saved = captureChatGptWebHome();
    const fixture = await serveLiveSignIn();
    try {
      const pid = ((await (await fetch(`http://127.0.0.1:${fixture.server.port}/healthz`)).json()) as { pid: number }).pid;
      const before = await readControlStatus(fixture);
      expect(before.storageStatePath).toBe(fixture.legacyPath);
      expect(before.storageStatePresent).toBe(false);

      const completed = await fixture.completeSignIn();
      // The sign-in wrote the provider-scoped session: the capture's own answer names it, and the
      // callback fired exactly once with the binding it persisted.
      const scopedPath = providerStorageStatePath();
      expect(completed.capture.location).toBe(scopedPath);
      expect(existsSync(scopedPath), "the capture landed in providers/<id>/").toBe(true);
      expect(fixture.completions).toEqual([
        { stored: true, fingerprint: IDENTITY_FINGERPRINT, restored: true },
      ]);

      // 1. The memory the listener serves from: both facts the sign-in changes are live, and the
      //    scoped session the sign-in wrote is the same location the resolver now reports.
      expect(resolveProviderStorageStatePath(fixture.config.storageStatePath)).toBe(scopedPath);
      expect(fixture.config.storageStatePath).toBe(scopedPath);
      expect(fixture.config.accountIdentityFingerprint).toBe(IDENTITY_FINGERPRINT);

      // 2. The resolver every seam reads, and the provider block the next turn derives from it.
      const effective = effectiveChatGptWebProviderConfig(fixture.config);
      expect(effective.chatgptWeb?.accountIdentityFingerprint).toBe(IDENTITY_FINGERPRINT);
      expect(effective.chatgptWeb?.accountIdentityRecorded).toBe(true);
      //    The block the adapter reads carries the re-resolved path, not the startup alias.
      expect(effective.chatgptWeb?.storageStatePath).toBe(scopedPath);
      //    The lease input and the execution namespace are derived from the same block, so the next
      //    turn's account binding is the signed-in account rather than the unrecorded fallback.
      expect(browserAccountLeaseInput(effective, "trace-after")).toMatchObject({
        accountIdentity: IDENTITY_FINGERPRINT,
        accountIdentityRecorded: true,
      });
      //    The credential path was resolved once at startup, but the browser layer re-resolves the
      //    configured value per turn, so what the turn reads is the scoped session — never the alias.
      expect(resolveBrowserConfig(effective).storageStatePath).toBe(scopedPath);

      // 3. The next request itself, through the real listener and its adapter factory.
      expect((await postTurn(fixture, "after the sign-in")).status).toBe(200);
      expect(fixture.seen).toHaveLength(1);
      expect(fixture.seen[0]?.chatgptWeb?.accountIdentityFingerprint).toBe(IDENTITY_FINGERPRINT);
      expect(fixture.seen[0]?.chatgptWeb?.accountIdentityRecorded).toBe(true);
      expect(resolveBrowserConfig(fixture.seen[0]!).storageStatePath).toBe(scopedPath);

      // 4. The same process, and the operator-visible picture agrees with what the turn reads.
      const samePid = ((await (await fetch(`http://127.0.0.1:${fixture.server.port}/healthz`)).json()) as { pid: number }).pid;
      expect(samePid).toBe(pid);
      const after = await readControlStatus(fixture);
      expect(after.storageStatePath).toBe(scopedPath);
      expect(after.storageStatePresent).toBe(true);
    } finally {
      await fixture.stop();
      restoreChatGptWebHome(saved, fixture.home);
    }
  });

  test("a turn already in flight across the refresh finishes on the facts it started with", async () => {
    const saved = captureChatGptWebHome();
    const fixture = await serveLiveSignIn({ holdTurnOpen: true });
    try {
      expect((await readControlStatus(fixture)).storageStatePath).toBe(fixture.legacyPath);

      // A genuinely in-flight turn: the listener has already resolved the provider block for it and
      // handed it to the adapter, which is still running.
      const turn = postTurn(fixture, "in flight across the sign-in");
      let handedToAdapter = false;
      for (let attempt = 0; attempt < 500 && !handedToAdapter; attempt += 1) {
        handedToAdapter = fixture.seen.length > 0;
        if (!handedToAdapter) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(handedToAdapter, "the turn must be in flight before the sign-in completes").toBe(true);
      const inFlight = fixture.seen[0]!;
      expect(inFlight.chatgptWeb?.accountIdentityFingerprint, "it began on the unrecorded fallback")
        .toBe("unknown");
      expect(inFlight.chatgptWeb?.accountIdentityRecorded).toBe(false);

      // The sign-in completes while that turn is still running: this is the refresh.
      await fixture.completeSignIn();
      expect(fixture.config.accountIdentityFingerprint).toBe(IDENTITY_FINGERPRINT);
      expect(fixture.config.storageStatePath).toBe(resolveProviderStorageStatePath(fixture.legacyPath));

      // The in-flight turn was never switched mid-turn: its provider block is byte-for-byte the one
      // it started with, and it only completes once it is allowed to.
      expect(fixture.seen).toHaveLength(1);
      expect(fixture.seen[0]).toEqual(inFlight);
      expect(fixture.seen[0]!.chatgptWeb?.accountIdentityFingerprint).toBe("unknown");

      fixture.releaseTurn();
      const inFlightResponse = await turn;
      expect(inFlightResponse.status).toBe(200);
      // Drain it: the in-flight turn must be fully observed before the next one is issued, exactly
      // like a client that reads the response it was promised.
      await inFlightResponse.text();

      // The *next* turn is the one that sees the refresh — never the turn that was running.
      const second = await postTurn(fixture, "after the sign-in");
      expect(second.status).toBe(200);
      await second.text();
      expect(fixture.seen).toHaveLength(2);
      expect(fixture.seen[1]?.chatgptWeb?.accountIdentityFingerprint).toBe(IDENTITY_FINGERPRINT);
      expect(fixture.seen[1]?.chatgptWeb?.accountIdentityRecorded).toBe(true);
    } finally {
      fixture.releaseTurn();
      await fixture.stop();
      restoreChatGptWebHome(saved, fixture.home);
    }
  });

  test("a capture whose account binding did not land keeps the session but reports why it fails closed", async () => {
    const saved = captureChatGptWebHome();
    const fixture = await serveLiveSignIn({ identityWriteFailure: "EACCES: permission denied" });
    try {
      const { capture } = await fixture.completeSignIn();

      // Stored, not failed: the session the operator just produced is never thrown away. But the
      // operator gets the reason the next turn fails closed, and the live facts were NOT refreshed
      // from a binding that never landed.
      expect(capture.stored).toBe(true);
      expect(capture.detail).toContain("could not be written");
      expect(capture.detail).toContain("fail closed");
      expect(fixture.config.accountIdentityFingerprint).toBeUndefined();

      // The next turn therefore still runs on the unrecorded fallback — the honest outcome, and
      // exactly what the reported detail told the operator to expect.
      expect((await postTurn(fixture, "still unbound")).status).toBe(200);
      expect(fixture.seen[0]?.chatgptWeb?.accountIdentityFingerprint).toBe("unknown");
      expect(fixture.seen[0]?.chatgptWeb?.accountIdentityRecorded).toBe(false);
    } finally {
      await fixture.stop();
      restoreChatGptWebHome(saved, fixture.home);
    }
  });

  test("one refresh: the completion signal fires exactly once per stored capture", async () => {
    const saved = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("dsh-287-signin-once-");
    try {
      // A real data home, because this test uses the REAL identity writer: the completion signal only
      // fires for a binding that actually landed, which is exactly the property being pinned.
      saveConfig({ ...defaultConfig(), appName: "issue-287-signin-once", automaticAppName: "issue-287-signin-once" });
      const completions: Array<{ stored: boolean; fingerprint: string; restored: boolean }> = [];
      const signIn = makeController({
        storageState: { cookies: [], origins: [] },
        inspect: async () => CAPTURED_CAPABILITIES,
        realIdentityWriter: true,
        afterSessionStored: (stored, identity) => {
          completions.push({ stored: stored.stored, fingerprint: identity.fingerprint, restored: identity.restored });
        },
      });
      const session = await signIn.controller.startAuth();
      await waitForState(session, "captured");
      const capture = await session.capture();
      const stored = await signIn.controller.storeCapture(capture);
      expect(readFileSync(getConfigPath(), "utf8")).toContain(IDENTITY_FINGERPRINT);
      // Storing the very same capture again changes nothing, so it is not a second refresh.
      await signIn.controller.storeCapture(capture).catch(() => undefined);
      await session.cancel();
      expect(stored.stored).toBe(true);
      expect(completions).toEqual([{ stored: true, fingerprint: IDENTITY_FINGERPRINT, restored: true }]);
    } finally {
      restoreChatGptWebHome(saved, home);
    }
  });

  test("a host completion hook that throws cannot turn a stored sign-in into a failed one", async () => {
    // The hook is a host seam and runs after the session and its binding are already durable. A host
    // internal must never be reported to the operator as a provider failure, and it must never discard
    // the session the operator just produced.
    const saved = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("dsh-287-signin-hook-");
    try {
      saveConfig({
        ...defaultConfig(),
        appName: "issue-287-signin-hook",
        automaticAppName: "issue-287-signin-hook",
      });
      let hookCalls = 0;
      const signIn = makeController({
        storageState: { cookies: [], origins: [] },
        inspect: async () => CAPTURED_CAPABILITIES,
        realIdentityWriter: true,
        afterSessionStored: () => {
          hookCalls += 1;
          throw new Error("the host refresh exploded");
        },
      });
      const session = await signIn.controller.startAuth();
      await waitForState(session, "captured");
      const result = await signIn.controller.storeCapture(await session.capture());
      // Stored, with no provider-facing detail: the session landed and the binding landed.
      expect(result).toMatchObject({ stored: true });
      expect(result.detail).toBeUndefined();
      expect(hookCalls).toBe(1);
      // And it really is durable — the hook's failure changed nothing about the write.
      expect(readFileSync(getConfigPath(), "utf8")).toContain(IDENTITY_FINGERPRINT);
      await session.cancel();
    } finally {
      restoreChatGptWebHome(saved, home);
    }
  });

  test("the operator is told the sign-in is live, and told where a restart is still required", async () => {
    // The sign-in page's success line is the operator's only receipt, and the page is served
    // anonymously by design, so a listener with no provider registration serves the same bytes.
    const pageServer = startServer(
      { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN },
      { auth: { providers: [] } },
    );
    let page: string;
    try {
      page = await (await fetch(`http://127.0.0.1:${pageServer.port}/v1/control/auth/`)).text();
    } finally {
      await pageServer.stop(true);
    }
    expect(page).toContain("no restart");
    expect(page).not.toContain("Restart the service");
    // The page must say the running service is already using the session — the sentence that
    // replaced the old restart instruction.
    expect(page).toContain("has already picked this session up");

    // `doctor`'s guidance names the interactive sign-in as restart-free, and still requires the
    // restart for `auth import`, which writes from its own short-lived process.
    const report = {
      ok: false,
      mode: "browser-only" as const,
      checks: [{
        id: "login",
        status: "error" as const,
        message: "ChatGPT login state is missing or unverified",
        detail: "provider chatgpt-web",
      }],
    };
    const text = formatDoctorReport(report);
    expect(text).toContain("/v1/control/auth/");
    expect(text).toContain("no restart");
    expect(text).toContain("auth import");
    expect(text).toContain("then: docker compose restart chatgpt-web");
  });
});
