import { describe, expect, test } from "bun:test";

import {
  CHATGPT_WEB_DRIVER_ID,
  admitDshTurn,
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
