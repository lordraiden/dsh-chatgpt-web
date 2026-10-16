/**
 * Issue #193 (P3b) — a restart rebuilds the recorded conversation explicitly.
 *
 * A durable record proves a conversation existed, but the provider's installation state is
 * process-local, so after a restart the provider can never prove that record resumable. Leaving that
 * as a refusal would make the durable continuity we just wired fail the very next turn, so the
 * native turn's decision now chooses between two explicit intents: `continue` when the provider can
 * prove the installation, and an explicit `replay` (same conversation key, next generation, rebuilt
 * from canonical host history) when it cannot. Without canonical history the explicit refusal stands:
 * a new conversation is never created by inference.
 */
import { describe, expect, test } from "bun:test";

import { createChatGptContinuity } from "../src/adapters/chatgpt-web/chatgpt-continuity";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_DRIVER_ID as CHATGPT_WEB_PROVIDER_ID } from "../src/web-chat/host/provider-host";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebChatAccountBinding } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { createMemoryConversationStore, webChatAccountBindingId, type WebChatConversationStore } from "../src/web-chat/core";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-replay",
    browserInteractionMode: "automatic",
    browserHost: "managed-chrome",
    solAvailable: false,
    proAvailable: false,
    capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const NAMESPACE = "replay-namespace";
const BINDING = chatGptWebChatAccountBinding({
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-replay",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
});
const AFFINITY = { providerId: CHATGPT_WEB_PROVIDER_ID, bindingId: webChatAccountBindingId(BINDING) };

/** Canonical host history, or none at all when the request carries only system instructions. */
function parsed(options: { readonly withHistory?: boolean } = {}): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/luna",
    context: {
      systemPrompt: ["eres un asistente"],
      messages: options.withHistory === false
        ? []
        : [{ role: "user", content: [{ type: "text", text: "arregla el bug" }] }],
    },
    stream: false,
    options: {},
    _dshContext: { dshSessionId: "session-replay", threadId: "dsh-thread-replay", turnId: "turn-1" },
  } as unknown as CodexParsedRequest;
}

const conversationKey = (): string => chatGptConversationKey(parsed(), NAMESPACE, AFFINITY)!;

function continuity(store: WebChatConversationStore, sessions: ChatGptTurnSessions) {
  return createChatGptContinuity({
    provider: PROVIDER,
    affinity: AFFINITY,
    namespace: NAMESPACE,
    binding: BINDING,
    sessions,
    store,
  });
}

/** One settled first turn: the decision, the installed state and the confirmation. */
async function settledFirstTurn(store: WebChatConversationStore, sessions: ChatGptTurnSessions): Promise<void> {
  const first = continuity(store, sessions);
  expect(await first.resolveRecovery({ parsed: parsed(), legacyRecovery: "NEW", contextExhausted: false, retired: false }))
    .toBe("NEW");
  sessions.recordSentSystemFingerprint(conversationKey(), 1, "fingerprint-1");
  await first.confirmTurn({ turnId: "turn-1", at: 1 });
}

describe("issue #193 — a restart with canonical history replays explicitly", () => {
  test("the restart's next turn rebuilds the same conversation in the next generation, unconfirmed until it settles", async () => {
    const store = createMemoryConversationStore();
    await settledFirstTurn(store, new ChatGptTurnSessions());
    // The settled first turn is what the durable record holds before the restart.
    expect((await store.list())[0]?.lastConfirmedTurn).toEqual({ turnId: "turn-1", at: 1 });

    // Restart: the durable record is still there, the provider's installation state is not.
    const restartedSessions = new ChatGptTurnSessions();
    const restarted = continuity(store, restartedSessions);
    const recovery = await restarted.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    });
    expect(recovery).toBe("REPLAY");

    // The replay advanced the generation of the same conversation key and registered it unconfirmed:
    // nothing is confirmed before the turn settles, and the new epoch carries no settled turn yet.
    const replayed = (await store.list())[0];
    expect(replayed?.generation).toBe(2);
    expect(replayed?.checkpoint).toBe("unconfirmed");
    expect(replayed?.identity.key).toBe(conversationKey());
    expect(replayed?.lastConfirmedTurn).toBeUndefined();
    expect((await store.list()).length).toBe(1);

    // The settled turn confirms the generation the replay established.
    restartedSessions.recordSentSystemFingerprint(conversationKey(), 2, "fingerprint-2");
    await restarted.confirmTurn({ turnId: "turn-2", at: 2 });
    const settled = (await store.list())[0];
    expect(settled?.generation).toBe(2);
    expect(settled?.checkpoint).toBe("confirmed");
    expect(settled?.lastConfirmedTurn).toEqual({ turnId: "turn-2", at: 2 });
  });

  test("a proven installation is never replayed: it continues", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    await settledFirstTurn(store, sessions);

    // Same process, installation still recorded: the decision stays a continuation.
    const resumed = continuity(store, sessions);
    expect(await resumed.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "EXACT_RESUME",
      contextExhausted: false,
      retired: false,
    })).toBe("EXACT_RESUME");
    expect((await store.list())[0]?.generation).toBe(1);
  });
});

describe("issue #193 — without canonical history the refusal stands", () => {
  test("a restart with nothing to rebuild from fails explicitly and replaces nothing", async () => {
    const store = createMemoryConversationStore();
    // The first turn carries history; the restart's turn has only system instructions.
    await settledFirstTurn(store, new ChatGptTurnSessions());

    const restarted = continuity(store, new ChatGptTurnSessions());
    await expect(restarted.resolveRecovery({
      parsed: parsed({ withHistory: false }),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    })).rejects.toMatchObject({ category: "CONVERSATION_STATE_MISMATCH" });

    // No replacement conversation was created: the record still describes generation 1.
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.generation).toBe(1);
    expect(records[0]?.checkpoint).toBe("confirmed");
  });
});

describe("issue #193 — the first turn is unchanged", () => {
  test("a conversation without a recorded identity is still a first turn", async () => {
    const store = createMemoryConversationStore();
    const first = continuity(store, new ChatGptTurnSessions());
    expect(await first.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    })).toBe("NEW");
    expect((await store.list())[0]?.generation).toBe(1);
    expect((await store.list())[0]?.checkpoint).toBe("unconfirmed");
  });
});
