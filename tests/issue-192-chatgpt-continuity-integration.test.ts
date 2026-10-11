import { describe, expect, test } from "bun:test";

import {
  chatGptWebConversationHandle,
  createChatGptWebDriver,
} from "../src/adapters/chatgpt-web/chatgpt-driver";
import { chatGptAffinitySessionId } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { RetainedSurfaceRegistry } from "../src/adapters/chatgpt-web/retained-surface";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebChatAccountBinding, chatGptWebChatAffinity } from "../src/adapters/chatgpt-web/web-chat-bridge";
import {
  createMemoryConversationStore,
  resolveWebChatContinuation,
  webChatAccountBindingId,
  webChatAffinityKey,
  type WebChatAccountBinding,
  type WebChatConversationStore,
} from "../src/web-chat/core";
import { CHATGPT_WEB_PROVIDER_ID } from "../src/adapters/chatgpt-web/llm-adapter";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

/**
 * Issue #192 — integration of the ChatGPT continuity path over a simulated physical side.
 *
 * It composes the real pieces the migration produced: the provider driver, the core affinity, the
 * continuation decision and the retained-surface owner, driven through two consecutive turns,
 * a cancellation and a replay. The physical side is simulated (a fake page and a fake transport):
 * a unit process cannot open a real ChatGPT surface.
 *
 * What this proves: the provider's own continuity facts (recorded generation, installed
 * initialization fingerprint, retained surface) and the core's durable record describe the same
 * conversation at every step, and the physical resource is never handed on before its settlement.
 * What it does not prove: that the native call site in `index.ts` already drives these decisions
 * (that migration is the remaining item of the issue).
 */

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-integration",
    browserInteractionMode: "managed",
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const BINDING: WebChatAccountBinding = {
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-integration",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
};

const MODEL = "chatgpt-web/light";

interface FakePage { closed: boolean; isClosed(): boolean; close(): Promise<void> }

function fakePage(): FakePage {
  const page: FakePage = {
    closed: false,
    isClosed: () => page.closed,
    close: async () => { page.closed = true; },
  };
  return page;
}

/** The provider turn facts one simulated turn reports, as the native path would. */
function turnRequest(threadId: string, turnId: string) {
  return {
    modelId: MODEL,
    context: { systemPrompt: [], messages: [] },
    stream: false,
    options: {},
    _dshContext: { dshSessionId: "session-integration", threadId, turnId },
  } as unknown as CodexParsedRequest;
}

describe("issue #192 — two turns, a cancellation and a replay over one physical conversation", () => {
  test("the durable record and the physical side agree at every step", async () => {
    const sessions = new ChatGptTurnSessions();
    const surfaces = new RetainedSurfaceRegistry<FakePage>();
    const store: WebChatConversationStore = createMemoryConversationStore();
    const driver = createChatGptWebDriver({ provider: PROVIDER, sessions });

    // The affinity the native path derives for this chat (provider + binding + session + thread).
    const parsed = turnRequest("dsh-thread-integration", "turn-1");
    const affinityInput = chatGptWebChatAffinity(parsed, {
      providerId: CHATGPT_WEB_PROVIDER_ID,
      bindingId: webChatAccountBindingId(BINDING),
      namespace: chatGptWebExecutionNamespace(PROVIDER),
    });
    const key = webChatAffinityKey(affinityInput);
    expect(affinityInput.dshSessionId).toBe(chatGptAffinitySessionId({
      dshSessionId: "session-integration",
      threadId: "dsh-thread-integration",
    }));

    const selection = {
      binding: BINDING,
      dshSession: { sessionId: "session-integration" },
      threadId: "dsh-thread-integration",
      // The native path derives the affinity with the provider's execution namespace, which is the
      // namespace the driver uses for its own conversation key.
      namespace: chatGptWebExecutionNamespace(PROVIDER),
      model: MODEL,
    };

    // ---- Turn 1: no conversation yet, so the provider installs one (an explicit decision).
    const first = await resolveWebChatContinuation({ store, driver }, {
      ...selection,
      intent: { kind: "new_conversation", reason: "first turn of this chat" },
    });
    expect(first.outcome).toBe("new_conversation");
    expect(first.conversation?.generation).toBe(1);
    expect(first.record?.checkpoint).toBe("confirmed");

    // The physical side: the surface is acquired, used, released and settled.
    const page = fakePage();
    const acquired = await surfaces.acquire(key, { create: async () => page, required: false });
    expect(acquired.created).toBe(true);
    expect(surfaces.isReusable(key)).toBe(false);
    surfaces.release(key);
    // Released without a settlement: still not reusable, exactly as the core requires.
    expect(surfaces.isReusable(key)).toBe(false);

    // The initialization state is physically installed in generation 1, which is what the provider
    // records when its install turn settles.
    sessions.recordSentSystemFingerprint(key, 1, "fingerprint-1");
    surfaces.settle(key, "fulfilled");
    expect(surfaces.isReusable(key)).toBe(true);

    // ---- Turn 2: the same identity continues the same physical conversation.
    const second = await resolveWebChatContinuation({ store, driver }, {
      ...selection,
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });
    expect(second.outcome).toBe("exact_resume");
    expect(second.conversation?.generation).toBe(1);
    expect(second.conversation?.handle).toBe(chatGptWebConversationHandle(key, 1));

    // The same physical page is reused, and the durable record still describes it.
    const reused = await surfaces.acquire(key, { create: async () => fakePage(), required: false });
    expect(reused.created).toBe(false);
    expect(reused.page).toBe(page);

    // ---- Cancellation: the surface is not reusable until its settlement is published.
    surfaces.release(key);
    expect(surfaces.isReusable(key)).toBe(false);
    await expect(surfaces.acquire(key, { create: async () => fakePage(), required: false })).rejects.toThrow(/already using the retained/);
    surfaces.settle(key, "fulfilled");
    expect(surfaces.isReusable(key)).toBe(true);

    // ---- Recovery/replay: the surface dies, continuity is tombstoned, and a replay rebuilds it.
    page.closed = true;
    await expect(surfaces.acquire(key, { create: async () => fakePage(), required: false })).rejects.toThrow(/lost/i);
    expect(surfaces.isLost(key)).toBe(true);

    // The provider cannot continue a conversation whose surface is gone and whose next generation has
    // no installation yet: it asks for an explicit replay rather than continuing by inference.
    const verdict = await driver.assessConversation({
      dshSession: { sessionId: "session-integration" },
      binding: BINDING,
      affinity: { providerId: CHATGPT_WEB_PROVIDER_ID, bindingId: webChatAccountBindingId(BINDING), threadId: "dsh-thread-integration" },
      model: MODEL,
      conversation: second.conversation!,
    });
    expect(verdict.status).toBe("resumable"); // generation 1 is still installed as far as the provider knows

    const replayed = await resolveWebChatContinuation({ store, driver }, {
      ...selection,
      intent: { kind: "replay", reason: "the retained surface was lost", history: [{ role: "user", text: "arregla el bug" }] },
      expectedGeneration: 1,
    });
    expect(replayed.outcome).toBe("replay");
    expect(replayed.conversation?.generation).toBe(2);

    // The physical side follows: the tombstone is cleared explicitly, a new page is installed, and
    // the initialization state of the new generation is recorded.
    surfaces.reset(key);
    const reinstalled = fakePage();
    const reacquired = await surfaces.acquire(key, { create: async () => reinstalled, required: false });
    expect(reacquired.created).toBe(true);
    sessions.recordSentSystemFingerprint(key, 2, "fingerprint-2");
    surfaces.release(key);
    surfaces.settle(key, "fulfilled");

    // ---- The durable record and the physical side agree.
    const record = await store.read(replayed.identity);
    expect(record?.generation).toBe(2);
    expect(record?.handle).toBe(chatGptWebConversationHandle(key, 2));
    expect(record?.checkpoint).toBe("confirmed");
    expect(record?.status).toBe("resumable");
    // Physical: the provider's recorded generation is the same one, its initialization state belongs
    // to that generation, and the surface is retained, settled and reusable.
    const durableGeneration = record!.generation;
    expect(sessions.conversationGeneration(key)).toBe(durableGeneration);
    expect(sessions.sentSystemFingerprint(key, durableGeneration)).toBe("fingerprint-2");
    expect(sessions.sentSystemFingerprint(key, durableGeneration - 1)).toBeUndefined();
    expect(surfaces.has(key)).toBe(true);
    expect(surfaces.isReusable(key)).toBe(true);
    expect(surfaces.isLost(key)).toBe(false);

    // ---- And the conversation is continuable again on the new generation.
    const continued = await resolveWebChatContinuation({ store, driver }, {
      ...selection,
      intent: { kind: "continue" },
      expectedGeneration: 2,
    });
    expect(continued.outcome).toBe("exact_resume");
    expect(continued.conversation?.generation).toBe(2);

    // A stale expectation is refused: the caller cannot continue a generation that is gone.
    const stale = await resolveWebChatContinuation({ store, driver }, {
      ...selection,
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });
    expect(stale.outcome).toBe("failed");
    expect(stale.error?.category).toBe("CONVERSATION_STATE_MISMATCH");
  });

  test("the account binding separates two accounts of the same provider", async () => {
    const sessions = new ChatGptTurnSessions();
    const store = createMemoryConversationStore();
    const driver = createChatGptWebDriver({ provider: PROVIDER, sessions });
    const base = {
      dshSession: { sessionId: "session-integration" },
      threadId: "dsh-thread-integration",
      namespace: chatGptWebExecutionNamespace(PROVIDER),
      model: MODEL,
      intent: { kind: "new_conversation", reason: "first turn" } as const,
    };
    const firstAccount = await resolveWebChatContinuation({ store, driver }, { ...base, binding: BINDING });
    const secondBinding = chatGptWebChatAccountBinding({
      providerId: CHATGPT_WEB_PROVIDER_ID,
      accountFingerprint: "account-other",
      browserProfile: "managed-chrome",
      browserContext: "default-context",
    });
    const secondAccount = await resolveWebChatContinuation({ store, driver }, { ...base, binding: secondBinding });
    expect(firstAccount.identity.key).not.toBe(secondAccount.identity.key);
    expect(firstAccount.record?.identity.bindingId).not.toBe(secondAccount.record?.identity.bindingId);
    expect(await store.list()).toHaveLength(2);
  });
});
