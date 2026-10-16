/**
 * Issue #193 (P3) — durable native continuity, resolved at the point of use.
 *
 * The native ChatGPT path used a process-lifetime memory store created at import time, so continuity
 * could not survive a restart. The store is now resolved from the effective configuration when a turn
 * needs it, the durable backend is used when the deployment configured a location, and the process
 * releases it on shutdown. These tests hold the real seam the native turn uses
 * (`createChatGptContinuity` over `resolveNativeChatGptContinuityStore`) against a real file: a turn
 * is confirmed, the runtime shuts down, and a second instance over the same file recovers the same
 * conversation — and never invents continuity when the file or the provider cannot support it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeNativeChatGptContinuityStores,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import { createChatGptContinuity } from "../src/adapters/chatgpt-web/chatgpt-continuity";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_DRIVER_ID as CHATGPT_WEB_PROVIDER_ID } from "../src/web-chat/host/provider-host";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebChatAccountBinding } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { defaultConfig, getConfigDir, saveConfig } from "../src/config";
import { webChatAccountBindingId, type WebChatConversationStore } from "../src/web-chat/core";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-durable",
    browserInteractionMode: "automatic",
    browserHost: "managed-chrome",
    solAvailable: false,
    proAvailable: false,
    capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const NAMESPACE = "durable-namespace";
const BINDING = chatGptWebChatAccountBinding({
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-durable",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
});
const AFFINITY = { providerId: CHATGPT_WEB_PROVIDER_ID, bindingId: webChatAccountBindingId(BINDING) };

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
    _dshContext: { dshSessionId: "session-durable", threadId: "dsh-thread-durable", turnId: "turn-1" },
  } as unknown as CodexParsedRequest;
}

const conversationKey = (): string => chatGptConversationKey(parsed(), NAMESPACE, AFFINITY)!;

function nativeContinuity(store: WebChatConversationStore, sessions: ChatGptTurnSessions) {
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

const firstTurn = { parsed: parsed(), legacyRecovery: "NEW" as const, contextExhausted: false, retired: false };

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

beforeEach(() => {
  previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "issue-193-continuity-"));
  delete process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = home;
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
  else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
  if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
  rmSync(home, { recursive: true, force: true });
});

/** Install the deployment configuration the runtime reads at the point of use. */
function installConfig(conversationStorePath: string | undefined): void {
  saveConfig({
    ...defaultConfig(),
    ...(conversationStorePath !== undefined ? { webChat: { conversationStorePath } } : {}),
  });
}

describe("issue #193 — the native continuity store is durable and configuration-driven", () => {
  test("a confirmed turn survives the shutdown and a second instance over the same file", async () => {
    const file = join(home, "conversations.json");
    installConfig(file);

    // First runtime: the turn's continuity decision, then the confirmation the settled turn writes.
    const sessions = new ChatGptTurnSessions();
    const store = resolveNativeChatGptContinuityStore();
    const continuity = nativeContinuity(store, sessions);
    expect(await continuity.instance.resolveRecovery(firstTurn)).toBe("NEW");
    // The install turn completes and records the initialization state it physically installed, which
    // is what makes the next turn in this process a continuation.
    sessions.recordSentSystemFingerprint(conversationKey(), 1, "fingerprint-1");
    await continuity.instance.confirmTurn({ turnId: "turn-1", at: 1 });

    // The file is continuity state, not a transcript: one record with the confirmed turn.
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      records: Array<{ generation: number; lastConfirmedTurn?: { turnId: string; at: number } }>;
    };
    expect(document.version).toBe(1);
    expect(document.records).toHaveLength(1);
    expect(document.records[0]?.generation).toBe(1);
    expect(document.records[0]?.lastConfirmedTurn).toEqual({ turnId: "turn-1", at: 1 });

    // The runtime shuts down: the plugin stops the sidecar, which releases the store it owns.
    await closeNativeChatGptContinuityStores();

    // Second runtime over the same file: a new store instance is allowed because the first released
    // the file, and it recovers the same conversation.
    const secondSessions = new ChatGptTurnSessions();
    const secondStore = resolveNativeChatGptContinuityStore();
    expect(secondStore).not.toBe(store);
    const recovered = (await secondStore.list())[0];
    expect(recovered?.generation).toBe(1);
    expect(recovered?.lastConfirmedTurn?.turnId).toBe("turn-1");

    // The durable record is continuity, not proof: once the provider records the installed state for
    // that generation, the same conversation continues.
    secondSessions.recordSentSystemFingerprint(conversationKey(), recovered!.generation, "fingerprint-1");
    const resumed = nativeContinuity(secondStore, secondSessions);
    expect(await resumed.instance.resolveRecovery({ ...firstTurn, legacyRecovery: "EXACT_RESUME" })).toBe("EXACT_RESUME");
  });

  test("a restart with nothing to rebuild from never invents continuity: the refusal is explicit", async () => {
    const file = join(home, "conversations.json");
    installConfig(file);

    const store = resolveNativeChatGptContinuityStore();
    const continuity = nativeContinuity(store, new ChatGptTurnSessions());
    await continuity.instance.resolveRecovery(firstTurn);
    await continuity.instance.confirmTurn({ turnId: "turn-1", at: 1 });
    await closeNativeChatGptContinuityStores();

    // A fresh process whose provider cannot prove the installation state must not silently replace the
    // durable conversation with a new one. Without canonical history there is nothing to replay from,
    // so the refusal is explicit and carries the provider's reason. (With history the next turn
    // replays the same conversation explicitly; that path is covered by
    // tests/issue-193-chatgpt-continuity-restart-replay.test.ts.)
    const restarted = resolveNativeChatGptContinuityStore();
    const next = nativeContinuity(restarted, new ChatGptTurnSessions());
    await expect(next.instance.resolveRecovery({ ...firstTurn, parsed: parsed({ withHistory: false }) })).rejects.toThrow(
      /conversation must be established from canonical host history/,
    );
    // Nothing was rewritten: the durable record still describes the same conversation.
    const records = await restarted.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.generation).toBe(1);
    expect(records[0]?.lastConfirmedTurn?.turnId).toBe("turn-1");
  });

  test("a corrupt file or an unknown version fails explicitly instead of inventing continuity", async () => {
    const file = join(home, "conversations.json");
    installConfig(file);
    const store = resolveNativeChatGptContinuityStore();

    writeFileSync(file, "{ this is not a conversation store");
    await expect(nativeContinuity(store, new ChatGptTurnSessions()).instance.resolveRecovery(firstTurn))
      .rejects.toThrow(/not valid JSON/);

    writeFileSync(file, JSON.stringify({ version: 99, records: [] }));
    await expect(nativeContinuity(store, new ChatGptTurnSessions()).instance.resolveRecovery(firstTurn))
      .rejects.toThrow(/schema version 99 is not supported/);
  });

  test("one writer per file and process, and memory only when no location is configured", async () => {
    const file = join(home, "conversations.json");
    installConfig(file);
    const first = resolveNativeChatGptContinuityStore();
    // Every adapter instance of the process resolves the same store, so a second writer never opens.
    expect(resolveNativeChatGptContinuityStore()).toBe(first);
    await closeNativeChatGptContinuityStores();
    // Released: the same file can be opened again, by the next runtime.
    expect(resolveNativeChatGptContinuityStore()).not.toBe(first);
    await closeNativeChatGptContinuityStores();

    // A readable configuration without a configured location keeps continuity in memory and invents
    // no file at the default location either.
    installConfig(undefined);
    const memory = resolveNativeChatGptContinuityStore();
    expect(await memory.list()).toEqual([]);
    expect(existsSync(join(getConfigDir(), "web-chat", "conversations.json"))).toBe(false);
  });
});
