import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  ChatGptWebSurfaceTransport,
  type WebSurfaceTransportBackend,
  type WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";
import {
  chooseChatGptConnectorCandidate,
  resolveBrowserConfig,
  scoreChatGptConnectorCandidate,
} from "../src/adapters/chatgpt-web/browser-worker";
import type { CodexProviderConfig } from "../src/types";

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
    onPhysicalSurfaceBound: surface => { observed.push(`bound:${surface.resourceId}`); },
    onSurfaceReady: () => { observed.push("ready"); },
    onSendActivated: () => { observed.push("send-activated"); },
    onSubmitted: () => { observed.push("submitted"); },
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
    "inspect:true",
    "verify:trace-verify",
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
});

test("upper provider layers import the transport boundary, never the browser worker", () => {
  for (const path of [
    "src/adapters/chatgpt-web/index.ts",
    "src/adapters/chatgpt-web/browser-helper-main.ts",
    "src/adapters/chatgpt-web/compaction-handoff.ts",
    "src/adapters/chatgpt-web/provider-core.ts",
    "src/adapters/chatgpt-web/turn-execution.ts",
    "src/adapters/chatgpt-web/replay.ts",
    "src/adapters/chatgpt-web/retry-policy.ts",
    "src/adapters/chatgpt-web/turn-broker.ts",
  ]) {
    const source = readFileSync(join(ROOT, path), "utf8");
    expect(source).not.toMatch(/from ["']\.\/browser-worker["']/);
  }
});

test("WebSurfaceTransport exposes all Phase 1 lifecycle evidence without owning completion policy", () => {
  const transport = new ChatGptWebSurfaceTransport(fakeBackend([]));
  const states: string[] = [];
  const turn = fakeTurn({
    onPhysicalSurfaceBound: () => { states.push("surface-bound"); },
    onSurfaceReady: () => { states.push("surface-ready"); },
    onSendActivated: () => { states.push("send-activated"); },
    onSubmitted: () => { states.push("submitted"); },
    onHeartbeat: () => { states.push("heartbeat"); },
    onReasoningSummary: () => { states.push("reasoning-summary"); },
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

test("browser surface account binding uses the stable provider identity, not mutable context storage", () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    defaultModel: "gpt-5.6-luna",
    models: ["gpt-5.6-luna"],
    liveModels: false,
    contextWindow: 1_050_000,
    modelInputModalities: { "gpt-5.6-luna": ["text", "image"] },
    modelReasoningEfforts: { "gpt-5.6-luna": ["low"] },
    modelDefaultReasoningEfforts: { "gpt-5.6-luna": "low" },
    noReasoningModels: [],
    chatgptWeb: {
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      storageStatePath: "/tmp/chatgpt-stable-identity.json",
      chromeExecutablePath: "/usr/bin/chromium",
      accountIdentityFingerprint: "stable-account-fingerprint",
    },
  };

  const resolved = resolveBrowserConfig(provider);
  expect(resolved.accountIdentityFingerprint).toBe("stable-account-fingerprint");

  const source = readFileSync(
    join(ROOT, "src", "adapters", "chatgpt-web", "browser-worker.ts"),
    "utf8",
  );
  const bindingStart = source.indexOf("const physicalAccountId = `chatgpt-account:${this.config.accountIdentityFingerprint}`");
  expect(bindingStart).toBeGreaterThanOrEqual(0);
  const bindingWindow = source.slice(bindingStart, source.indexOf("const bindPhysicalSurface", bindingStart));
  expect(bindingWindow).not.toContain("page.context().storageState()");
});


test("ChatGPT connector selection separates app identity from the UI activation mechanism", () => {
  const source = readFileSync(
    join(ROOT, "src", "adapters", "chatgpt-web", "browser-worker.ts"),
    "utf8",
  );
  expect(source).toContain('const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";');
  expect(source).toContain('button[data-testid="composer-plus-button"]');
  expect(source).toContain('button[aria-label*="Add files and more" i]');
  expect(source).toContain("connectorPickerRows");
  expect(source).toContain('[data-mention-list-scroll-area] button[data-list-navigation-item="true"]');
  expect(source).toContain("chooseChatGptConnectorCandidate");
  expect(source).toContain("selectedConnectorControls");
  expect(source).toContain('[app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]');
  expect(source).toContain('composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY');
  expect(source).toContain('composer.press("Backspace"');
  expect(source).toContain("connector-plus-triggered");
  expect(source).not.toContain('const CHATGPT_CONNECTOR_MENTION_QUERY = (appName: string)');
  expect(source).not.toContain(
    "const mentionQuery = CHATGPT_CONNECTOR_MENTION_QUERY(this.config.appName);",
  );
  expect(source).not.toContain("keyword === this.config.appName");
});

test("ChatGPT connector discovery separates configured display names from semantic picker identity", () => {
  const exactDisplay = {
    rawIndex: 0,
    text: "Codex Native2",
    keyword: "codex-native2",
    dataId: "plugin:prod",
    appName: null,
    pluginName: null,
    ariaLabel: null,
    title: null,
    mentionDisplayName: "Codex Native2",
  };
  const semanticExact = {
    rawIndex: 1,
    text: "Codex",
    keyword: "Codex-Native2",
    dataId: "plugin:prod",
    appName: null,
    pluginName: null,
    ariaLabel: null,
    title: null,
    mentionDisplayName: null,
  };
  const genericCodex = {
    rawIndex: 2,
    text: "Codex",
    keyword: "codex",
    dataId: "plugin:only",
    appName: null,
    pluginName: null,
    ariaLabel: null,
    title: null,
    mentionDisplayName: null,
  };
  expect(scoreChatGptConnectorCandidate(exactDisplay, "Codex Native2")).toBe(100);
  expect(scoreChatGptConnectorCandidate(semanticExact, "Codex Native2")).toBe(95);
  expect(chooseChatGptConnectorCandidate([semanticExact], "Codex Native2")).toEqual(semanticExact);
  expect(chooseChatGptConnectorCandidate([genericCodex], "Codex Native2")).toEqual(genericCodex);
  expect(chooseChatGptConnectorCandidate([genericCodex, { ...genericCodex, rawIndex: 3 }], "Codex Native2")).toBeUndefined();
});

test("ChatGPT connector verification does not require data-keyword to equal the configured display name", () => {
  const source = readFileSync(
    join(ROOT, "src", "adapters", "chatgpt-web", "browser-worker.ts"),
    "utf8",
  );
  expect(source).not.toContain("keyword === this.config.appName");
  expect(source).toContain("selectedConnectorControls");
  expect(source).toContain("chooseChatGptConnectorCandidate");
});
