import { describe, expect, test } from "bun:test";

import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptWebChatBindingIdFor } from "../src/adapters/chatgpt-web/index";
import { legacyWebChatThreadKey, webChatAffinityKey } from "../src/web-chat/core";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

/**
 * Issue #192 — the native ChatGPT path uses the canonical WebChat affinity.
 *
 * The affinity now includes the provider and the authenticated account binding (architecture §7), so
 * one DSH chat holds one ChatGPT conversation per provider *and* per account. The legacy thread
 * digest stays for the callers that do not supply an affinity, and its digest must not change: it
 * addresses conversations that already exist.
 */

const NAMESPACE = "dsh-chatgpt-web";
const AFFINITY = { providerId: "chatgpt-web", bindingId: "binding-a" };

function provider(accountFingerprint: string): CodexProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:17841",
    chatgptWeb: { accountIdentityFingerprint: accountFingerprint },
  } as unknown as CodexProviderConfig;
}

function turn(options: {
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  modelId?: string;
  reasoning?: string;
} = {}): CodexParsedRequest {
  const threadId = options.threadId ?? "dsh-thread-1";
  return {
    modelId: options.modelId ?? "gpt-5.6-sol",
    context: { systemPrompt: [], messages: [] },
    stream: false,
    options: {},
    _dshContext: {
      ...(options.sessionId === undefined ? { dshSessionId: "session-1" } : { dshSessionId: options.sessionId }),
      threadId,
      turnId: options.turnId ?? "turn-1",
    },
  } as unknown as CodexParsedRequest;
}

describe("issue #192 — canonical affinity for the native path", () => {
  test("the key is the core's canonical affinity, not the legacy digest", () => {
    const parsed = turn();
    const canonical = chatGptConversationKey(parsed, NAMESPACE, AFFINITY);
    expect(canonical).toBe(webChatAffinityKey({
      providerId: AFFINITY.providerId,
      bindingId: AFFINITY.bindingId,
      dshSessionId: "session-1",
      threadId: "dsh-thread-1",
      namespace: NAMESPACE,
    }));
    expect(canonical).not.toBe(legacyWebChatThreadKey(NAMESPACE, "dsh-thread-1"));
  });

  test("the affinity survives the turn details that must not split a chat", () => {
    // The contract of issue #170, now on the canonical derivation: the chat identity decides, the
    // turn details do not.
    const base = chatGptConversationKey(turn(), NAMESPACE, AFFINITY);
    expect(base).toBe(chatGptConversationKey(turn({ turnId: "turn-2" }), NAMESPACE, AFFINITY));
    expect(base).toBe(chatGptConversationKey(turn({ modelId: "gpt-5.6-luna" }), NAMESPACE, AFFINITY));
    expect(base).toBe(chatGptConversationKey(turn({ reasoning: "high" }), NAMESPACE, AFFINITY));
    expect(base).not.toBe(chatGptConversationKey(turn({ threadId: "dsh-thread-2" }), NAMESPACE, AFFINITY));
    expect(base).not.toBe(chatGptConversationKey(turn({ sessionId: "session-2" }), NAMESPACE, AFFINITY));
  });

  test("one DSH chat holds one conversation per provider and per account", () => {
    const parsed = turn();
    const base = chatGptConversationKey(parsed, NAMESPACE, AFFINITY);
    expect(base).not.toBe(chatGptConversationKey(parsed, NAMESPACE, { ...AFFINITY, bindingId: "binding-b" }));
    expect(base).not.toBe(chatGptConversationKey(parsed, NAMESPACE, { ...AFFINITY, providerId: "other-web" }));
    expect(base).not.toBe(chatGptConversationKey(parsed, "other-namespace", AFFINITY));
  });

  test("a turn without a host session identity still yields one stable key", () => {
    // The provider projects its stable thread identity as the session, so a chat never splits across
    // two conversations depending on which turn carries the native context.
    const withoutSession = turn({ sessionId: "" });
    const key = chatGptConversationKey(withoutSession, NAMESPACE, AFFINITY);
    expect(key).toBe(chatGptConversationKey(withoutSession, NAMESPACE, AFFINITY));
    expect(key).toBe(webChatAffinityKey({
      providerId: AFFINITY.providerId,
      bindingId: AFFINITY.bindingId,
      dshSessionId: "dsh-thread-1",
      threadId: "dsh-thread-1",
      namespace: NAMESPACE,
    }));
  });

  test("the legacy digest is unchanged for callers without an affinity", () => {
    expect(chatGptConversationKey(turn(), NAMESPACE))
      .toBe(legacyWebChatThreadKey(NAMESPACE, "dsh-thread-1"));
    expect(chatGptConversationKey(turn(), NAMESPACE))
      .not.toBe(chatGptConversationKey(turn(), NAMESPACE, AFFINITY));
    // A turn with no provider thread identity has no key at all, with or without an affinity.
    expect(chatGptConversationKey({ ...turn(), _dshContext: undefined } as unknown as CodexParsedRequest, NAMESPACE, AFFINITY))
      .toBeUndefined();
  });

  test("the binding identity comes from the account and browser facts the lease uses", () => {
    const parsed = turn();
    const binding = chatGptWebChatBindingIdFor(provider("account-a"));
    expect(binding).toBe(chatGptWebChatBindingIdFor(provider("account-a")));
    expect(binding).not.toBe(chatGptWebChatBindingIdFor(provider("account-b")));
    // The same account in another browser profile is another binding.
    const otherBrowser = chatGptWebChatBindingIdFor({
      ...provider("account-a"),
      chatgptWeb: { accountIdentityFingerprint: "account-a", chromeExecutablePath: "/other/chrome" },
    } as unknown as CodexProviderConfig);
    expect(otherBrowser).not.toBe(binding);
  });
});
