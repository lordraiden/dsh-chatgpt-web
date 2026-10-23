import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "playwright-core";

import { defaultConfig } from "../src/config";
import { importProviderSession, qwenChatAuthImportProvider } from "../src/auth-import";
import {
  createQwenChatBrowserSession,
  resolveQwenChatProviderConfig,
  type QwenChatSessionPage,
} from "../src/adapters/qwen-chat";
import { QWEN_CHAT_PROVIDER_ID } from "../src/adapters/qwen-chat/provider";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * Issue #333 follow-up — a Qwen Chat capture must survive the renewal it causes.
 *
 * Measured on the operator's own stored capture: the refresh credential is the persistent
 * `refresh_token` cookie (30 days), the access token beside it lives 15 minutes, and the app renews
 * the latter with the former. The auth host **rotates** that cookie when it does, and the rotation
 * exists only inside the browsing context — so a verification or a turn that consumed the stored
 * cookie left the file holding a credential the server had already replaced. After the next restart
 * the page could not renew and the turn failed with "no token after 20000ms".
 *
 * These tests pin the two places that must keep the renewal:
 *
 * 1. an import stores the state **the page produced**, not the snapshot its own probe consumed;
 * 2. a live session writes its renewed state back through the single writer, only when it changed,
 *    and never over a capture it did not prove.
 */

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const FUTURE = Math.floor(Date.UTC(2027, 0, 1) / 1_000);
const FUTURE_MS = Date.UTC(2027, 0, 1);
const MARKER = "2026-10-22T13:51:35.003Z";

const SECRET_OLD_REFRESH = "SECRET-OLD-REFRESH-TOKEN";
const SECRET_ROTATED_REFRESH = "SECRET-ROTATED-REFRESH-TOKEN";
const SECRET_SECOND_REFRESH = "SECRET-SECOND-REFRESH-TOKEN";
const SECRET_OLD_LOCAL = "SECRET-OLD-LOCAL-TOKEN-STATE";
const SECRET_LIVE_LOCAL = "SECRET-LIVE-LOCAL-TOKEN-STATE";

const savedHome = captureChatGptWebHome();
const homes: string[] = [];
let home: string;

beforeEach(() => {
  home = useTemporaryChatGptWebHome("dsh-qwen-chat-renewal-");
  homes.push(home);
});

afterEach(() => {
  while (homes.length > 0) {
    try { rmSync(homes.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  restoreChatGptWebHome(savedHome);
});

const defaultCapturePath = () => join(home, "providers", QWEN_CHAT_PROVIDER_ID, "storage-state.json");

function capture(options: {
  readonly refresh?: string;
  readonly tokenState?: string;
  readonly expires?: number;
} = {}) {
  return {
    cookies: [
      {
        name: "refresh_token",
        value: options.refresh ?? SECRET_OLD_REFRESH,
        domain: ".qwen.ai",
        path: "/",
        expires: options.expires ?? FUTURE,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
      {
        name: "c",
        value: "SYNTHETIC-COOKIE",
        domain: "chat.qwen.ai",
        path: "/",
        expires: options.expires ?? FUTURE,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [{
      origin: "https://chat.qwen.ai",
      localStorage: [{ name: "qwen_access_token_state", value: options.tokenState ?? SECRET_OLD_LOCAL }],
    }],
  };
}

function writeVerifiedCapture(path: string, value: unknown, verifiedAt = MARKER): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  writeFileSync(`${path}.verified.json`, `${JSON.stringify({
    version: 1,
    authenticated: true,
    verifiedAt,
  })}\n`, { mode: 0o600 });
}

const liveTokenState = () => JSON.stringify({
  version: 1,
  stateId: "state-live",
  token: "live-access-token",
  expiresAt: FUTURE_MS,
  updatedAt: NOW,
  sourceId: "page",
});

/** The page the import probe and the turn session both drive; only the two reads they make. */
function simulatedPage(options: {
  readonly tokenState: string;
  readonly authenticated?: boolean;
  readonly onRequest?: () => void;
}): Page {
  return {
    evaluate: async (_fn: unknown, arg?: Record<string, unknown>) => {
      if (typeof arg?.["accessKey"] === "string") {
        return { state: options.tokenState, legacy: undefined };
      }
      if (typeof arg?.["url"] === "string") {
        options.onRequest?.();
        return {
          status: 200,
          contentType: "application/json",
          text: JSON.stringify(options.authenticated === false
            ? { success: false, data: { code: "Unauthorized" } }
            : { success: true, data: [] }),
        };
      }
      throw new Error("the simulated page does not implement this evaluation");
    },
  } as unknown as Page;
}

const FAST_HYDRATION = { timeoutMs: 300, pollIntervalMs: 5 } as const;

describe("issue #333 — an import stores the state the page renewed, not the one it consumed", () => {
  test("the page's own state is what lands on disk", async () => {
    const source = join(home, "capture.json");
    writeFileSync(source, JSON.stringify(capture()), { mode: 0o600 });
    const renewedState = capture({ refresh: SECRET_ROTATED_REFRESH, tokenState: SECRET_LIVE_LOCAL });

    const result = await importProviderSession({
      provider: qwenChatAuthImportProvider({
        hydration: FAST_HYDRATION,
        openPage: async (): Promise<QwenChatSessionPage> => ({
          page: simulatedPage({ tokenState: liveTokenState() }),
          storageState: async () => renewedState,
          close: async () => {},
        }),
      }),
      from: source,
      now: () => NOW,
    });

    expect(result.verified).toBe(true);
    const stored = readFileSync(defaultCapturePath(), "utf8");
    expect(stored).toContain(SECRET_ROTATED_REFRESH);
    expect(stored).not.toContain(SECRET_OLD_REFRESH);
    expect(stored).toContain(SECRET_LIVE_LOCAL);
    expect(stored).not.toContain(SECRET_OLD_LOCAL);
    // Nothing in the import's answer quotes the material it stored.
    expect(JSON.stringify(result)).not.toContain(SECRET_ROTATED_REFRESH);
    expect(JSON.stringify(result)).not.toContain(SECRET_LIVE_LOCAL);
  });

  test("a page with no readable state keeps the accepted capture", async () => {
    const source = join(home, "capture.json");
    writeFileSync(source, JSON.stringify(capture()), { mode: 0o600 });

    await importProviderSession({
      provider: qwenChatAuthImportProvider({
        hydration: FAST_HYDRATION,
        openPage: async () => ({
          page: simulatedPage({ tokenState: liveTokenState() }),
          close: async () => {},
        }),
      }),
      from: source,
      now: () => NOW,
    });

    expect(readFileSync(defaultCapturePath(), "utf8")).toContain(SECRET_OLD_REFRESH);
  });

  test("a context that will not serialize never turns a proved session into a failure", async () => {
    const source = join(home, "capture.json");
    writeFileSync(source, JSON.stringify(capture()), { mode: 0o600 });

    const result = await importProviderSession({
      provider: qwenChatAuthImportProvider({
        hydration: FAST_HYDRATION,
        openPage: async () => ({
          page: simulatedPage({ tokenState: liveTokenState() }),
          storageState: async () => {
            throw new Error("Target page, context or browser has been closed");
          },
          close: async () => {},
        }),
      }),
      from: source,
      now: () => NOW,
    });

    expect(result.verified).toBe(true);
    expect(readFileSync(defaultCapturePath(), "utf8")).toContain(SECRET_OLD_REFRESH);
  });
});

describe("issue #333 — a live session writes its renewal back through the single writer", () => {
  const sessionFor = (options: {
    readonly page: Page;
    readonly states: () => Promise<unknown>;
  }) => createQwenChatBrowserSession({
    provider: resolveQwenChatProviderConfig(defaultConfig()),
    hydrationTimeoutMs: FAST_HYDRATION.timeoutMs,
    openPage: async () => ({
      page: options.page,
      storageState: options.states,
      close: async () => {},
    }),
  });

  test("ready() persists the renewal the app performed while restoring its token", async () => {
    writeVerifiedCapture(defaultCapturePath(), capture());
    const renewed = capture({ refresh: SECRET_ROTATED_REFRESH, tokenState: SECRET_LIVE_LOCAL });
    const session = sessionFor({
      page: simulatedPage({ tokenState: liveTokenState() }),
      states: async () => renewed,
    });

    await session.ready();

    const stored = readFileSync(defaultCapturePath(), "utf8");
    expect(stored).toContain(SECRET_ROTATED_REFRESH);
    expect(stored).not.toContain(SECRET_OLD_REFRESH);
    // The writer's marker moved: the capture on disk is the one the live page just proved.
    const marker = JSON.parse(readFileSync(`${defaultCapturePath()}.verified.json`, "utf8")) as { verifiedAt: string };
    expect(marker.verifiedAt).not.toBe(MARKER);
    expect(Number.isFinite(Date.parse(marker.verifiedAt))).toBe(true);
  });

  test("a turn's own renewal is persisted when the turn settles", async () => {
    writeVerifiedCapture(defaultCapturePath(), capture());
    const afterReady = capture({ refresh: SECRET_ROTATED_REFRESH, tokenState: SECRET_LIVE_LOCAL });
    const afterTurn = capture({ refresh: SECRET_SECOND_REFRESH, tokenState: SECRET_LIVE_LOCAL });
    let reads = 0;
    const session = sessionFor({
      page: simulatedPage({ tokenState: liveTokenState() }),
      states: async () => {
        reads += 1;
        return reads === 1 ? afterReady : afterTurn;
      },
    });

    await session.ready();
    expect(readFileSync(defaultCapturePath(), "utf8")).toContain(SECRET_ROTATED_REFRESH);

    await session.run(async () => undefined);
    const stored = readFileSync(defaultCapturePath(), "utf8");
    expect(stored).toContain(SECRET_SECOND_REFRESH);
    expect(stored).not.toContain(SECRET_ROTATED_REFRESH);
  });

  test("an unchanged state writes nothing", async () => {
    const state = capture();
    writeVerifiedCapture(defaultCapturePath(), state);
    const before = readFileSync(defaultCapturePath(), "utf8");
    const markerBefore = readFileSync(`${defaultCapturePath()}.verified.json`, "utf8");
    const session = sessionFor({
      page: simulatedPage({ tokenState: liveTokenState() }),
      states: async () => state,
    });

    await session.ready();
    await session.run(async () => undefined);

    expect(readFileSync(defaultCapturePath(), "utf8")).toBe(before);
    expect(readFileSync(`${defaultCapturePath()}.verified.json`, "utf8")).toBe(markerBefore);
  });

  test("a configured custom capture path is left to the writer that owns it", async () => {
    const customPath = join(home, "custom-credential", "storage-state.json");
    writeVerifiedCapture(customPath, capture());
    const before = readFileSync(customPath, "utf8");
    const config = defaultConfig();
    const session = createQwenChatBrowserSession({
      provider: {
        ...resolveQwenChatProviderConfig(config),
        storageStatePath: customPath,
      },
      hydrationTimeoutMs: FAST_HYDRATION.timeoutMs,
      openPage: async () => ({
        page: simulatedPage({ tokenState: liveTokenState() }),
        storageState: async () => capture({ refresh: SECRET_ROTATED_REFRESH, tokenState: SECRET_LIVE_LOCAL }),
        close: async () => {},
      }),
    });

    await session.ready();

    expect(readFileSync(customPath, "utf8")).toBe(before);
  });

  test("a page that never proved a token is never written", async () => {
    writeVerifiedCapture(defaultCapturePath(), capture());
    const before = readFileSync(defaultCapturePath(), "utf8");
    const session = sessionFor({
      // The page reports an expired state: readiness must fail, and the file must not be replaced
      // with whatever a half-loaded page happened to hold.
      page: simulatedPage({
        tokenState: JSON.stringify({
          version: 1, stateId: "state-old", token: "old", expiresAt: 1, updatedAt: 1, sourceId: "page",
        }),
      }),
      states: async () => capture({ refresh: SECRET_ROTATED_REFRESH, tokenState: SECRET_LIVE_LOCAL }),
    });

    await expect(session.ready()).rejects.toThrow(/not signed in/);
    expect(readFileSync(defaultCapturePath(), "utf8")).toBe(before);
  });
});
