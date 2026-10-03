import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  ChatGptWebSurfaceTransport,
  type WebSurfaceInspection,
  type WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";
import type { WebSurfaceTransportBackend } from "../src/adapters/chatgpt-web/web-surface-transport";

const ROOT = join(import.meta.dir, "..");

function fakeTurn(overrides: Partial<WebSurfaceTurn> = {}): WebSurfaceTurn {
  return {
    traceId: "trace-64",
    modelId: "gpt-5.6-luna",
    capabilities: {
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
    },
    prepare: async () => ({
      text: "hello",
      images: [],
      release: () => {},
    }),
    onTextDelta: () => {},
    ...overrides,
  };
}

function fakeBackend(calls: string[]): WebSurfaceTransportBackend {
  return {
    run(turn) {
      calls.push(`run:${turn.traceId}`);
      turn.onPhysicalSurfaceBound?.({
        resourceId: "surface-1",
        browserContextId: "context-1",
        pageId: "page-1",
        profileId: "profile-1",
        accountId: "account-1",
      });
      turn.onSurfaceReady?.();
      turn.onSendActivated?.();
      turn.onSubmitted?.();
      return Promise.resolve("answer");
    },
    verifyConnector(traceId) {
      calls.push(`verify:${traceId ?? "generated"}`);
      return Promise.resolve("verified");
    },
    inspectSession(detectCapabilities) {
      calls.push(`inspect:${detectCapabilities}`);
      return Promise.resolve({
        authenticated: true,
        temporary: true,
        url: "https://chatgpt.com/",
        solAvailable: false,
        proAvailable: false,
      });
    },
    smokeTest() {
      calls.push("smoke");
      return Promise.resolve({ effort: "low", response: "ok" });
    },
    close() {
      calls.push("close");
      return Promise.resolve();
    },
  };
}

test("WebSurfaceTransport keeps lifecycle evidence semantic", async () => {
  const calls: string[] = [];
  const transport = new ChatGptWebSurfaceTransport(fakeBackend(calls));
  const observed: string[] = [];

  const turn = fakeTurn({
    onPhysicalSurfaceBound: surface => observed.push(`bound:${surface.resourceId}`),
    onSurfaceReady: () => observed.push("ready"),
    onSendActivated: () => observed.push("send-activated"),
    onSubmitted: () => observed.push("submitted"),
  });

  await expect(transport.run(turn)).resolves.toBe("answer");
  expect(observed).toEqual(["bound:surface-1", "ready", "send-activated", "submitted"]);
  expect(calls).toEqual(["run:trace-64"]);
});

test("WebSurfaceTransport preserves owning-turn cancellation semantics", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const backend: WebSurfaceTransportBackend = {
    run(turn) {
      receivedSignal = turn.abortSignal;
      return Promise.reject(new DOMException("cancelled", "AbortError"));
    },
    verifyConnector: () => Promise.resolve("verified"),
    inspectSession: async () => ({
      authenticated: true,
      temporary: true,
      url: "https://chatgpt.com/",
    }),
    smokeTest: async () => ({ effort: "low", response: "ok" }),
    close: () => Promise.resolve(),
  };
  const transport = new ChatGptWebSurfaceTransport(backend);

  const run = transport.run(fakeTurn({ abortSignal: controller.signal }));
  controller.abort();

  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(receivedSignal).toBe(controller.signal);
});

test("WebSurfaceTransport is not a second lifecycle or authorization authority", async () => {
  const calls: string[] = [];
  const transport = new ChatGptWebSurfaceTransport(fakeBackend(calls));

  const inspection = await transport.inspectSession(true);
  expect(inspection).toEqual({
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/",
    solAvailable: false,
    proAvailable: false,
  });
  await transport.verifyConnector("trace-verify");
  await transport.smokeTest();
  await transport.close();

  expect(calls).toEqual([
    "verify:trace-verify",
    "inspect:true",
    "smoke",
    "close",
  ]);
});

test("the transport contract does not export browser implementation types", () => {
  const source = readFileSync(
    join(ROOT, "src", "adapters", "chatgpt-web", "web-surface-transport.ts"),
    "utf8",
  );
  expect(source).toContain("export interface WebSurfaceTurn");
  expect(source).toContain("export interface WebSurfacePhysicalSurface");
  expect(source).not.toContain("export type WebSurfaceTurn = BrowserTurn");
  expect(source).not.toContain("export type WebSurfacePhysicalSurface = ChatGptBrowserPhysicalSurface");
  expect(source).not.toContain("export interface WebSurfaceTransportBackend");
  expect(source).not.toContain("Locator");
  expect(source).not.toContain("Page");
  expect(source).not.toContain("BrowserContext");
  expect(source).not.toContain("Playwright");
});

test("upper provider layers import the transport boundary, never the browser worker", () => {
  for (const path of [
    "src/adapters/chatgpt-web/index.ts",
    "src/adapters/chatgpt-web/browser-helper-main.ts",
    "src/adapters/chatgpt-web/compaction-handoff.ts",
  ]) {
    const source = readFileSync(join(ROOT, path), "utf8");
    expect(source).not.toMatch(/from ["']\.\/browser-worker["']/);
  }
});

test("WebSurfaceTransport exposes all Phase 1 lifecycle evidence without owning completion policy", () => {
  const transport = new ChatGptWebSurfaceTransport(fakeBackend([]));
  const states: string[] = [];
  const turn = fakeTurn({
    onPhysicalSurfaceBound: () => states.push("surface-bound"),
    onSurfaceReady: () => states.push("surface-ready"),
    onSendActivated: () => states.push("send-activated"),
    onSubmitted: () => states.push("submitted"),
    onHeartbeat: () => states.push("heartbeat"),
    onReasoningSummary: () => states.push("reasoning-summary"),
  });

  return transport.run(turn).then(() => {
    expect(states.slice(0, 4)).toEqual([
      "surface-bound",
      "surface-ready",
      "send-activated",
      "submitted",
    ]);
    expect(states).not.toContain("completed");
  });
});
