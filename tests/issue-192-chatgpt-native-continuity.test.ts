import { describe, expect, test } from "bun:test";

import { createChatGptContinuity, chatGptReplayHistory } from "../src/adapters/chatgpt-web/chatgpt-continuity";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_PROVIDER_ID } from "../src/adapters/chatgpt-web/llm-adapter";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebChatAccountBinding } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { createMemoryConversationStore, webChatAccountBindingId } from "../src/web-chat/core";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

/**
 * Issue #192 — the native turn's recovery decision is the WebChat Core's.
 *
 * The provider still knows its own facts (whether a turn is in flight, whether continuity was
 * exhausted or retired), but the decision itself — continue, replay, or a first conversation, and
 * never a new conversation by inference — now comes from `resolveWebChatContinuation`.
 */

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-native",
    browserInteractionMode: "managed",
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const NAMESPACE = "native-namespace";
const BINDING = chatGptWebChatAccountBinding({
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-native",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
});
const AFFINITY = { providerId: CHATGPT_WEB_PROVIDER_ID, bindingId: webChatAccountBindingId(BINDING) };

function parsed(options: { modelId?: string; withIdentity?: boolean; withHistory?: boolean } = {}): CodexParsedRequest {
  return {
    modelId: options.modelId ?? "chatgpt-web/light",
    context: {
      systemPrompt: [],
      messages: options.withHistory === false
        ? []
        : [{ role: "user", content: [{ type: "text", text: "arregla el bug" }] }],
    },
    stream: false,
    options: {},
    ...(options.withIdentity === false
      ? {}
      : { _dshContext: { dshSessionId: "session-native", threadId: "dsh-thread-native", turnId: "turn-1" } }),
  } as unknown as CodexParsedRequest;
}

function continuity(store = createMemoryConversationStore(), sessions = new ChatGptTurnSessions()) {
  return {
    store,
    sessions,
    instance: createChatGptContinuity({
      provider: PROVIDER,
      affinity: AFFINITY,
      namespace: NAMESPACE,
      binding: BINDING,
      sessions,
      store,
    }),
  };
}

describe("issue #192 — the native recovery decision comes from the core", () => {
  test("a first turn installs, and the turn after it continues", async () => {
    const { instance, sessions } = continuity();

    const first = await instance.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    });
    expect(first).toBe("NEW");

    // The install turn settles: the initialization state of generation 1 is physically installed,
    // which is what the provider records today when that turn completes.
    const key = chatGptConversationKey(parsed(), NAMESPACE, AFFINITY)!;
    sessions.recordSentSystemFingerprint(key, 1, "fingerprint-1");

    const second = await instance.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "EXACT_RESUME",
      contextExhausted: false,
      retired: false,
    });
    expect(second).toBe("EXACT_RESUME");
  });

  test("exhausted or retired continuity rebuilds from canonical history, explicitly", async () => {
    const { instance } = continuity();
    const exhausted = await instance.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "REPLAY",
      contextExhausted: true,
      retired: false,
    });
    expect(exhausted).toBe("REPLAY");

    const retired = await instance.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "REPLAY",
      contextExhausted: false,
      retired: true,
    });
    expect(retired).toBe("REPLAY");
  });

  test("a rebuild with nothing to rebuild from starts a first conversation", async () => {
    const { instance } = continuity();
    const plan = await instance.resolveRecovery({
      parsed: parsed({ withHistory: false }),
      legacyRecovery: "REPLAY",
      contextExhausted: true,
      retired: false,
    });
    expect(plan).toBe("NEW");
  });

  test("a verdict that refuses continuity fails explicitly, never silently", async () => {
    const { instance, sessions } = continuity();
    // The chat has a recorded conversation and an installed initialization state...
    const key = chatGptConversationKey(parsed(), NAMESPACE, AFFINITY)!;
    await instance.resolveRecovery({ parsed: parsed(), legacyRecovery: "NEW", contextExhausted: false, retired: false });
    sessions.recordSentSystemFingerprint(key, 1, "fingerprint-1");

    // ...but this turn asks for a route the deployment does not serve: the core refuses.
    const refused = await instance.resolveRecovery({
      parsed: parsed({ modelId: "chatgpt-web/pro" }),
      legacyRecovery: "EXACT_RESUME",
      contextExhausted: false,
      retired: false,
    });
    expect(refused).toBe("FAILED");
  });

  test("a lane with no logical conversation keeps the provider's own decision", async () => {
    const { instance } = continuity();
    const legacy = await instance.resolveRecovery({
      parsed: parsed({ withIdentity: false }),
      legacyRecovery: "REPLAY",
      contextExhausted: false,
      retired: false,
    });
    expect(legacy).toBe("REPLAY");
  });

  test("canonical history is projected as text only", () => {
    const history = chatGptReplayHistory({
      modelId: "chatgpt-web/light",
      context: {
        systemPrompt: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "hola" }] },
          { role: "toolResult", content: [{ type: "text", text: "salida de herramienta" }] },
          { role: "assistant", content: [{ type: "thinking", text: "pensando" }] },
        ],
      },
      stream: false,
      options: {},
    } as unknown as CodexParsedRequest);
    expect(history).toEqual([{ role: "user", text: "hola" }]);
  });
});
