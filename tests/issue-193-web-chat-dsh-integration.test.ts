import { describe, expect, test } from "bun:test";

import {
  CHATGPT_WEB_DRIVER_ID,
  admitDshTurn,
  closeWebChatConversationStore,
  createWebChatShutdown,
  registerableRouteIds,
  webChatProviderCheck,
  assertHostReplayStateOwnership,
  createWebChatConversationStore,
  createWebChatHostResolver,
  defaultWebChatStorePath,
  dshFailureSemanticsFor,
  inspectWebChatProvider,
  resolveWebChatProviderConfig,
  webChatModelCatalogueEntries,
} from "../src/web-chat/host/dsh-integration";
import {
  createMemoryConversationStore,
  type WebChatExchangeSnapshot,
  type WebChatModelDescriptor,
  type WebChatProviderDriver,
} from "../src/web-chat/core";

/**
 * Issue #193 — the host integration boundary: provider-scoped configuration, catalogue entries,
 * provider information, retry translation, replay state and text-only admission.
 */

function driver(overrides: Partial<WebChatProviderDriver> = {}): WebChatProviderDriver {
  const models: readonly WebChatModelDescriptor[] = [
    { id: "light", label: "Light", text: true },
    { id: "pro", label: "Pro", text: true },
  ];
  return {
    id: CHATGPT_WEB_DRIVER_ID,
    inspectAccount: async () => ({ authenticated: true, accountFingerprint: "fp-193", capabilities: { pro: "unsupported" } }),
    listModels: async () => models,
    resolveModel: async model => models.find(candidate => candidate.id === model),
    assessConversation: async () => ({ status: "new" }),
    createConversation: async input => ({
      key: "key",
      providerId: CHATGPT_WEB_DRIVER_ID,
      bindingId: input.affinity.bindingId,
      generation: 1,
      handle: "handle" as never,
      status: "new",
    }),
    resumeConversation: async input => input.conversation,
    replayConversation: async input => ({ ...(input.conversation ?? {
      key: "key",
      providerId: CHATGPT_WEB_DRIVER_ID,
      bindingId: input.affinity.bindingId,
      generation: 0,
      handle: "handle" as never,
      status: "new" as const,
    }), generation: (input.conversation?.generation ?? 0) + 1 }),
    health: async () => ({ ok: true, detail: "2 routes" }),
    shutdown: async () => {},
    ...overrides,
  };
}

const snapshot = (overrides: Partial<WebChatExchangeSnapshot> = {}): WebChatExchangeSnapshot => ({
  exchangeId: "exchange-1",
  conversationKey: "conversation-1",
  epoch: 1,
  state: "FAILED",
  phase: "prepared",
  logical: "failed",
  physical: "pending",
  retired: false,
  cancelRequested: false,
  submits: 0,
  maxSubmits: 1,
  updatedAt: 1,
  ...overrides,
});

describe("issue #193 — provider-scoped configuration stays compatible", () => {
  test("the provider-scoped block wins, and the flat block is the ChatGPT fallback", () => {
    const flat = { chromeExecutablePath: "/usr/bin/chrome" };
    expect(resolveWebChatProviderConfig({ chatgptWeb: flat }, CHATGPT_WEB_DRIVER_ID)).toBe(flat);
    const scoped = { chromeExecutablePath: "/other" };
    expect(resolveWebChatProviderConfig({
      webChat: { providers: { [CHATGPT_WEB_DRIVER_ID]: scoped } },
      chatgptWeb: flat,
    }, CHATGPT_WEB_DRIVER_ID)).toBe(scoped);
    // Another provider has no configuration here, and none is invented.
    expect(resolveWebChatProviderConfig({ chatgptWeb: flat }, "qwen-web")).toBeUndefined();
    expect(resolveWebChatProviderConfig({}, CHATGPT_WEB_DRIVER_ID)).toBeUndefined();
  });

  test("the durable store is chosen by configuration and defaults to memory", async () => {
    const memory = createWebChatConversationStore({});
    expect(await memory.list()).toEqual([]);
    await memory.close?.();

    // A configured path opens the durable backend; the default location is inside the plugin storage.
    expect(defaultWebChatStorePath()).toContain("conversations.json");
    const temporary = `${defaultWebChatStorePath()}.issue-193-test`;
    const durable = createWebChatConversationStore({ webChat: { conversationStorePath: temporary } });
    await durable.close?.();
  });
});

describe("issue #193 — model identity, provider information and resolution", () => {
  test("model entries are provider-scoped and informational", () => {
    const entries = webChatModelCatalogueEntries(CHATGPT_WEB_DRIVER_ID, [
      { id: "light", label: "Light", text: true },
      { id: "light", label: "Light", text: true },
    ]);
    expect(entries.map(entry => entry.id)).toEqual(["chatgpt-web/light", "chatgpt-web/light"]);
    // The same model id under two providers is two entries, never one shared global id.
    const other = webChatModelCatalogueEntries("other-web", [{ id: "light", label: "Light", text: true }]);
    expect(other[0]?.id).not.toBe(entries[0]?.id);
    expect(entries[0]?.providerId).toBe(CHATGPT_WEB_DRIVER_ID);
    expect(entries[0]?.modelId).toBe("light");
  });

  test("provider information comes from the driver, and a failing driver is reported", async () => {
    const info = await inspectWebChatProvider(driver());
    expect(info.providerId).toBe(CHATGPT_WEB_DRIVER_ID);
    expect(info.authenticated).toBe(true);
    expect(info.accountFingerprint).toBe("fp-193");
    expect(info.capabilities).toEqual({ pro: "unsupported" });
    expect(info.models).toHaveLength(2);
    expect(info.health).toEqual({ ok: true, detail: "2 routes" });

    const failing = await inspectWebChatProvider(driver({
      inspectAccount: async () => { throw new Error("session unavailable"); },
    }));
    expect(failing.authenticated).toBe(false);
    expect(failing.health.ok).toBe(false);
    expect(failing.health.detail).toContain("session unavailable");
    expect(failing.models).toEqual([]);
  });

  test("resolution maps an already-selected route and invents nothing", () => {
    const resolver = createWebChatHostResolver([driver()], CHATGPT_WEB_DRIVER_ID);
    expect(resolver.resolve(CHATGPT_WEB_DRIVER_ID)?.id).toBe(CHATGPT_WEB_DRIVER_ID);
    // A route this deployment does not implement does not resolve, and no fake route is registered.
    expect(resolver.resolve("qwen-web")).toBeUndefined();
    expect(resolver.providerIds).toEqual([CHATGPT_WEB_DRIVER_ID]);
    expect(createWebChatHostResolver([], CHATGPT_WEB_DRIVER_ID).resolve(CHATGPT_WEB_DRIVER_ID)).toBeUndefined();
  });
});

describe("issue #193 — failure semantics and boundaries", () => {
  test("only a proven pre-submission failure is retryable for DSH", () => {
    const preSubmit = dshFailureSemanticsFor(snapshot());
    expect(preSubmit).toEqual({
      retryable: true,
      safety: "retry_safe",
      reason: "pre_submit",
      detail: "the failure is proven to be before submission",
    });

    const confirmed = dshFailureSemanticsFor(snapshot({ phase: "accepted" }));
    expect(confirmed.retryable).toBe(false);
    expect(confirmed.reason).toBe("confirmed_or_ambiguous");
    expect(confirmed.safety).toBe("not_retry_safe");

    const ambiguous = dshFailureSemanticsFor(snapshot({ state: "SUBMISSION_AMBIGUOUS", phase: "send_activated" }));
    expect(ambiguous.retryable).toBe(false);
    expect(ambiguous.safety).toBe("ambiguous");
    expect(ambiguous.detail).toContain("may have accepted");
  });

  test("host replay state is provider-scoped and fails closed", () => {
    const expected = { providerId: CHATGPT_WEB_DRIVER_ID, bindingId: "binding-1" };
    expect(() => assertHostReplayStateOwnership({
      providerId: CHATGPT_WEB_DRIVER_ID,
      bindingId: "binding-1",
      detail: { cursor: 1 },
    }, expected)).not.toThrow();
    expect(() => assertHostReplayStateOwnership({
      providerId: "qwen-web",
      bindingId: "binding-1",
      detail: {},
    }, expected)).toThrow(/does not belong/);
  });

  test("unsupported DSH options fail explicitly instead of being dropped", () => {
    expect(admitDshTurn({ userText: "hola", model: "chatgpt-web/light" })).toEqual({
      userText: "hola",
      model: "chatgpt-web/light",
    });
    for (const feature of ["files", "images", "tools", "mcp"] as const) {
      expect(() => admitDshTurn({ userText: "hola", model: "m", [feature]: [{ any: true }] })).toThrow(/UNSUPPORTED_OPTION|text-only/);
    }
  });
});

describe("issue #193 — the wiring the host boundary enables", () => {
  test("a route without a driver is never registerable", () => {
    const implemented = driver();
    expect(registerableRouteIds([CHATGPT_WEB_DRIVER_ID, "qwen-web"], [implemented])).toEqual([CHATGPT_WEB_DRIVER_ID]);
    expect(registerableRouteIds(["qwen-web", "deepseek-web"], [implemented])).toEqual([]);
    // The registration authority stays DSH's: this only decides which ids may be passed to it.
    expect(registerableRouteIds([], [implemented])).toEqual([]);
  });

  test("the provider check reports auth, capabilities and an unhealthy driver, without secrets", async () => {
    const healthy = webChatProviderCheck(await inspectWebChatProvider(driver()));
    expect(healthy).toEqual({
      providerId: CHATGPT_WEB_DRIVER_ID,
      status: "ok",
      detail: "authenticated (fp-193); unsupported: pro; 2 models; 2 routes",
    });
    expect(healthy.detail).not.toContain("token");

    const unauthenticated = webChatProviderCheck(await inspectWebChatProvider(driver({
      inspectAccount: async () => ({ authenticated: false }),
    })));
    expect(unauthenticated.status).toBe("warning");
    expect(unauthenticated.detail).toContain("not authenticated");

    const unhealthy = webChatProviderCheck(await inspectWebChatProvider(driver({
      health: async () => ({ ok: false, detail: "sidecar closed" }),
    })));
    expect(unhealthy.status).toBe("error");
    expect(unhealthy.detail).toContain("sidecar closed");
  });

  test("shutdown asks every driver once and survives one that fails", async () => {
    let first = 0;
    let second = 0;
    const failures: string[] = [];
    const shutdown = createWebChatShutdown([
      driver({ shutdown: async () => { first += 1; } }),
      driver({ id: "other-web", shutdown: async () => { second += 1; throw new Error("already gone"); } }),
    ], (error, providerId) => failures.push(`${providerId}: ${(error as Error).message}`));

    await shutdown();
    await shutdown();
    expect([first, second]).toEqual([1, 1]);
    expect(failures).toEqual(["other-web: already gone"]);
  });

  test("a durable store survives a restart, and releasing it is idempotent", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(tmpdir(), "issue-193-store-"));
    const file = join(directory, "conversations.json");

    const first = createWebChatConversationStore({ webChat: { conversationStorePath: file } });
    const identity = { providerId: CHATGPT_WEB_DRIVER_ID, bindingId: "binding-1", key: "key-1" };
    await first.update(identity, () => ({
      identity,
      generation: 1,
      handle: "handle-1" as never,
      status: "resumable" as const,
      checkpoint: "confirmed" as const,
      lastConfirmedTurn: { turnId: "turn-1", at: 1 },
    }));
    // One writer per file and process: the same path cannot be opened twice.
    expect(() => createWebChatConversationStore({ webChat: { conversationStorePath: file } })).toThrow(/already owns it/);
    await closeWebChatConversationStore(first);

    // A restarted runtime opens the same file and reads the same conversation back.
    const second = createWebChatConversationStore({ webChat: { conversationStorePath: file } });
    const record = await second.read(identity);
    expect(record?.generation).toBe(1);
    expect(record?.lastConfirmedTurn?.turnId).toBe("turn-1");
    await closeWebChatConversationStore(second);
    // Releasing an already released store is harmless.
    await closeWebChatConversationStore(second);
  });
});
