import { describe, expect, test } from "bun:test";

import {
  chatGptWebConversationHandle,
  createChatGptWebDriver,
} from "../src/adapters/chatgpt-web/chatgpt-driver";
import { chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { isWebChatModelDescriptor, webChatAccountBindingId, webChatAffinityKey } from "../src/web-chat/core";
import type { CodexProviderConfig } from "../src/types";

/**
 * Issue #192 — ChatGPT Web implements the WebChat Core provider driver.
 *
 * The driver is a projection of facts the provider already owns: the authenticated account, the Web
 * model catalogue and route authority, and the physical generation with the initialization state
 * installed in it. Nothing here decides continuity that the core should decide.
 */

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-192",
    browserInteractionMode: "managed",
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const BINDING = {
  providerId: "chatgpt-web",
  accountFingerprint: "account-192",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
};

function selection(threadId = "dsh-thread-1") {
  return {
    dshSession: { sessionId: "session-1" },
    binding: BINDING,
    affinity: { providerId: "chatgpt-web", bindingId: webChatAccountBindingId(BINDING), threadId },
    model: "chatgpt-web/light",
  };
}

describe("issue #192 — the ChatGPT driver", () => {
  test("it identifies itself and reports the authenticated account", async () => {
    const driver = createChatGptWebDriver({ provider: PROVIDER });
    expect(driver.id).toBe("chatgpt-web");
    const account = await driver.inspectAccount();
    expect(account.authenticated).toBe(true);
    expect(account.accountFingerprint).toBe("account-192");
    expect(account.capabilities?.sol).toBe("supported");
    expect(account.capabilities?.pro).toBe("unsupported");
  });

  test("it lists and resolves only the routes this deployment serves", async () => {
    const driver = createChatGptWebDriver({ provider: PROVIDER });
    const models = await driver.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(isWebChatModelDescriptor(model)).toBe(true);
    expect(models.some(model => model.id === "light")).toBe(true);
    expect(models.some(model => model.id.startsWith("chatgpt-web/"))).toBe(false);
    // The provider driver accepts the unchanged public DSH route and projects it to a local descriptor.
    expect((await driver.resolveModel("chatgpt-web/light"))?.id).toBe("light");
    // A Pro route is not served when the account does not have it.
    expect(await driver.resolveModel("chatgpt-web/pro")).toBeUndefined();
    expect(await driver.resolveModel("api/gpt-5")).toBeUndefined();
  });

  test("the public Luna route remains unchanged while its descriptor is provider-local", async () => {
    const lunaProvider = {
      ...PROVIDER,
      chatgptWeb: {
        ...PROVIDER.chatgptWeb,
        solAvailable: false,
        capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
      },
    } as unknown as CodexProviderConfig;
    const driver = createChatGptWebDriver({ provider: lunaProvider });

    expect((await driver.resolveModel("chatgpt-web/luna"))?.id).toBe("luna");
  });

  test("health reflects whether any route is available", async () => {
    const driver = createChatGptWebDriver({ provider: PROVIDER });
    expect((await driver.health()).ok).toBe(true);
    const unknown = createChatGptWebDriver({
      provider: { ...PROVIDER, chatgptWeb: { ...PROVIDER.chatgptWeb, capabilityState: { solAvailable: "unknown", proAvailable: "unknown" } } } as unknown as CodexProviderConfig,
    });
    expect((await unknown.health()).ok).toBe(false);
  });

  test("assessment follows the provider's own branch rule, not a new one", async () => {
    const sessions = new ChatGptTurnSessions();
    const driver = createChatGptWebDriver({ provider: PROVIDER, sessions });
    const key = webChatAffinityKey({
      providerId: "chatgpt-web",
      bindingId: webChatAccountBindingId(BINDING),
      dshSessionId: "session-1",
      threadId: "dsh-thread-1",
      namespace: "dsh-chatgpt-web",
    });

    // No conversation yet: the physical conversation has to be established from canonical history.
    const fresh = await driver.assessConversation({
      dshSession: { sessionId: "session-1" },
      binding: BINDING,
      affinity: { providerId: "chatgpt-web", bindingId: webChatAccountBindingId(BINDING), threadId: "dsh-thread-1" },
      model: "chatgpt-web/light",
    });
    expect(fresh.status).toBe("replay_required");

    // With the initialization state of that generation installed, the conversation continues.
    sessions.recordSentSystemFingerprint(key, 1, "fingerprint-1");
    const resumable = await driver.assessConversation({
      dshSession: { sessionId: "session-1" },
      binding: BINDING,
      affinity: { providerId: "chatgpt-web", bindingId: webChatAccountBindingId(BINDING), threadId: "dsh-thread-1" },
      model: "chatgpt-web/light",
      conversation: {
        key,
        providerId: "chatgpt-web",
        bindingId: webChatAccountBindingId(BINDING),
        generation: 1,
        handle: chatGptWebConversationHandle(key, 1),
        status: "resumable",
      },
    });
    expect(resumable.status).toBe("resumable");

    // A later generation has no installed state: it is a new physical epoch.
    const later = await driver.assessConversation({
      dshSession: { sessionId: "session-1" },
      binding: BINDING,
      affinity: { providerId: "chatgpt-web", bindingId: webChatAccountBindingId(BINDING), threadId: "dsh-thread-1" },
      model: "chatgpt-web/light",
      conversation: {
        key,
        providerId: "chatgpt-web",
        bindingId: webChatAccountBindingId(BINDING),
        generation: 2,
        handle: chatGptWebConversationHandle(key, 2),
        status: "resumable",
      },
    });
    expect(later.status).toBe("replay_required");

    // A model this deployment does not serve can never be represented in this conversation.
    const unsupported = await driver.assessConversation({
      dshSession: { sessionId: "session-1" },
      binding: BINDING,
      affinity: { providerId: "chatgpt-web", bindingId: webChatAccountBindingId(BINDING), threadId: "dsh-thread-1" },
      model: "chatgpt-web/pro",
    });
    expect(unsupported.status).toBe("unsupported");
  });

  test("conversation operations keep the handle opaque and the generation explicit", async () => {
    const sessions = new ChatGptTurnSessions();
    const driver = createChatGptWebDriver({ provider: PROVIDER, sessions });
    const created = await driver.createConversation(selection());
    expect(created.providerId).toBe("chatgpt-web");
    expect(created.bindingId).toBe(webChatAccountBindingId(BINDING));
    expect(created.status).toBe("new");
    expect(created.handle).toBe(chatGptWebConversationHandle(created.key, created.generation));
    expect(created.handle).toContain("chatgpt-web:");

    const resumed = await driver.resumeConversation({ ...selection(), conversation: created });
    expect(resumed.generation).toBe(created.generation);
    expect(resumed.status).toBe("resumable");

    // A replay is a new physical epoch: the generation advances and is recorded.
    const replayed = await driver.replayConversation({
      ...selection(),
      conversation: created,
      history: [{ role: "user", text: "arregla el bug" }],
    });
    expect(replayed.generation).toBe(created.generation + 1);
    expect(sessions.conversationGeneration(created.key)).toBe(replayed.generation);
    // The core never interprets the handle; it only stores and passes it.
    expect(replayed.handle).not.toBe(created.handle);
  });

  test("a conversation needs a host session identity, and the key is the core's affinity", async () => {
    const driver = createChatGptWebDriver({ provider: PROVIDER });
    await expect(driver.createConversation({
      ...selection(),
      dshSession: {},
    })).rejects.toThrow(/host session identity/);

    const created = await driver.createConversation(selection());
    expect(created.key).toBe(webChatAffinityKey({
      providerId: "chatgpt-web",
      bindingId: webChatAccountBindingId(BINDING),
      dshSessionId: "session-1",
      threadId: "dsh-thread-1",
      namespace: chatGptWebExecutionNamespace(PROVIDER),
    }));
  });
});
