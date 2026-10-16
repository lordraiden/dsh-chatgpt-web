/**
 * Issue #193 — durable native continuity, resolved at the point of use.
 *
 * The native ChatGPT path used a process-lifetime memory store created at import time, so continuity
 * could not survive a restart. The store is now resolved from the effective configuration when a turn
 * needs it, the durable backend is used when the deployment configured a location, and the process
 * releases it on shutdown. These tests hold the real seam the native turn uses
 * (`createChatGptContinuity` over `resolveNativeChatGptContinuityStore`) against a real file: a turn
 * is confirmed, the runtime shuts down, and a second instance over the same file recovers the same
 * conversation — and never invents continuity when the file or the provider cannot support it.
 *
 * The rest of the ChatGPT native-continuity family is consolidated here: the core-driven recovery
 * decision (#192), the explicit restart replay over a memory store (#193 P3b) and the durable replay
 * proven through the REAL native turn path (#193 C2). One chain entry, every distinct assertion kept.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import { createChatGptContinuity, chatGptReplayHistory } from "../src/adapters/chatgpt-web/chatgpt-continuity";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_DRIVER_ID as CHATGPT_WEB_PROVIDER_ID } from "../src/web-chat/host/provider-host";
import { ChatGptTurnSessions, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebChatAccountBinding } from "../src/adapters/chatgpt-web/web-chat-bridge";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { defaultConfig, getConfigDir, saveConfig } from "../src/config";
import {
  createMemoryConversationStore,
  webChatAccountBindingId,
  type WebChatConversationStore,
} from "../src/web-chat/core";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

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
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-193-continuity-", { clearFreeHome: true });
  // The process-lifetime owners every merged section shares: the installation state lives in the
  // session registry and the durable store holds one writer slot per file and process.
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
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

    // The runtime shuts down: the sidecar releases the store it owns.
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
    // replays the same conversation explicitly; that path is covered by the replay section below.)
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

/**
 * Merged: the core owns the native recovery decision (issue #192).
 *
 * The provider still knows its own facts (whether a turn is in flight, whether continuity was
 * exhausted or retired), but the decision itself — continue, replay, or a first conversation, and
 * never a new conversation by inference — comes from `resolveWebChatContinuation`.
 */
const nativeDecisionProvider = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-native",
    browserInteractionMode: "managed",
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const NATIVE_DECISION_NAMESPACE = "native-namespace";
const NATIVE_DECISION_BINDING = chatGptWebChatAccountBinding({
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-native",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
});
const NATIVE_DECISION_AFFINITY = {
  providerId: CHATGPT_WEB_PROVIDER_ID,
  bindingId: webChatAccountBindingId(NATIVE_DECISION_BINDING),
};

function nativeDecisionParsed(options: { modelId?: string; withIdentity?: boolean; withHistory?: boolean } = {}): CodexParsedRequest {
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

function nativeDecisionContinuity(store = createMemoryConversationStore(), sessions = new ChatGptTurnSessions()) {
  return {
    store,
    sessions,
    instance: createChatGptContinuity({
      provider: nativeDecisionProvider,
      affinity: NATIVE_DECISION_AFFINITY,
      namespace: NATIVE_DECISION_NAMESPACE,
      binding: NATIVE_DECISION_BINDING,
      sessions,
      store,
    }),
  };
}

describe("issue #192 — the native recovery decision comes from the core", () => {
  test("a first turn installs, and the turn after it continues", async () => {
    const { instance, sessions } = nativeDecisionContinuity();

    const first = await instance.resolveRecovery({
      parsed: nativeDecisionParsed(),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    });
    expect(first).toBe("NEW");

    // The install turn settles: the initialization state of generation 1 is physically installed,
    // which is what the provider records today when that turn completes, and the settled turn
    // confirms the record.
    const key = chatGptConversationKey(nativeDecisionParsed(), NATIVE_DECISION_NAMESPACE, NATIVE_DECISION_AFFINITY)!;
    sessions.recordSentSystemFingerprint(key, 1, "fingerprint-1");
    await instance.confirmTurn({ turnId: "turn-1", at: 1 });

    const second = await instance.resolveRecovery({
      parsed: nativeDecisionParsed(),
      legacyRecovery: "EXACT_RESUME",
      contextExhausted: false,
      retired: false,
    });
    expect(second).toBe("EXACT_RESUME");
  });

  test("exhausted or retired continuity rebuilds from canonical history, explicitly", async () => {
    const { instance } = nativeDecisionContinuity();
    const exhausted = await instance.resolveRecovery({
      parsed: nativeDecisionParsed(),
      legacyRecovery: "REPLAY",
      contextExhausted: true,
      retired: false,
    });
    expect(exhausted).toBe("REPLAY");

    const retired = await instance.resolveRecovery({
      parsed: nativeDecisionParsed(),
      legacyRecovery: "REPLAY",
      contextExhausted: false,
      retired: true,
    });
    expect(retired).toBe("REPLAY");
  });

  test("a rebuild with nothing to rebuild from starts a first conversation", async () => {
    const { instance } = nativeDecisionContinuity();
    const plan = await instance.resolveRecovery({
      parsed: nativeDecisionParsed({ withHistory: false }),
      legacyRecovery: "REPLAY",
      contextExhausted: true,
      retired: false,
    });
    expect(plan).toBe("NEW");
  });

  test("a verdict that refuses continuity stops the turn instead of continuing", async () => {
    const { instance, sessions } = nativeDecisionContinuity();
    // The chat has a recorded conversation and an installed initialization state...
    const key = chatGptConversationKey(nativeDecisionParsed(), NATIVE_DECISION_NAMESPACE, NATIVE_DECISION_AFFINITY)!;
    await instance.resolveRecovery({ parsed: nativeDecisionParsed(), legacyRecovery: "NEW", contextExhausted: false, retired: false });
    sessions.recordSentSystemFingerprint(key, 1, "fingerprint-1");

    // ...but this turn asks for a route the deployment does not serve: the core refuses, and the
    // refusal reaches the caller as a typed failure *before* any provider turn is created.
    await expect(instance.resolveRecovery({
      parsed: nativeDecisionParsed({ modelId: "chatgpt-web/pro" }),
      legacyRecovery: "EXACT_RESUME",
      contextExhausted: false,
      retired: false,
    })).rejects.toMatchObject({ category: "UNSUPPORTED_OPTION" });
  });

  test("a lane with no logical conversation keeps the provider's own decision", async () => {
    const { instance } = nativeDecisionContinuity();
    const legacy = await instance.resolveRecovery({
      parsed: nativeDecisionParsed({ withIdentity: false }),
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

/**
 * Merged: a restart rebuilds the recorded conversation explicitly (issue #193 P3b).
 *
 * A durable record proves a conversation existed, but the provider's installation state is
 * process-local, so after a restart the provider can never prove that record resumable. The native
 * turn's decision chooses between two explicit intents: `continue` when the provider can prove the
 * installation, and an explicit `replay` (same conversation key, next generation, rebuilt from
 * canonical host history) when it cannot. Without canonical history the explicit refusal stands: a
 * new conversation is never created by inference.
 */
const replayProvider = {
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

const REPLAY_NAMESPACE = "replay-namespace";
const REPLAY_BINDING = chatGptWebChatAccountBinding({
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-replay",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
});
const REPLAY_AFFINITY = { providerId: CHATGPT_WEB_PROVIDER_ID, bindingId: webChatAccountBindingId(REPLAY_BINDING) };

/** Canonical host history, or none at all when the request carries only system instructions. */
function replayParsed(options: { readonly withHistory?: boolean } = {}): CodexParsedRequest {
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

const replayConversationKey = (): string => chatGptConversationKey(replayParsed(), REPLAY_NAMESPACE, REPLAY_AFFINITY)!;

function replayContinuity(store: WebChatConversationStore, sessions: ChatGptTurnSessions) {
  return createChatGptContinuity({
    provider: replayProvider,
    affinity: REPLAY_AFFINITY,
    namespace: REPLAY_NAMESPACE,
    binding: REPLAY_BINDING,
    sessions,
    store,
  });
}

/** One settled first turn: the decision, the installed state and the confirmation. */
async function settleReplayFirstTurn(store: WebChatConversationStore, sessions: ChatGptTurnSessions): Promise<void> {
  const first = replayContinuity(store, sessions);
  expect(await first.resolveRecovery({ parsed: replayParsed(), legacyRecovery: "NEW", contextExhausted: false, retired: false }))
    .toBe("NEW");
  sessions.recordSentSystemFingerprint(replayConversationKey(), 1, "fingerprint-1");
  await first.confirmTurn({ turnId: "turn-1", at: 1 });
}

describe("issue #193 — a restart with canonical history replays explicitly", () => {
  test("the restart's next turn rebuilds the same conversation in the next generation, unconfirmed until it settles", async () => {
    const store = createMemoryConversationStore();
    await settleReplayFirstTurn(store, new ChatGptTurnSessions());
    // The settled first turn is what the durable record holds before the restart.
    expect((await store.list())[0]?.lastConfirmedTurn).toEqual({ turnId: "turn-1", at: 1 });

    // Restart: the durable record is still there, the provider's installation state is not.
    const restartedSessions = new ChatGptTurnSessions();
    const restarted = replayContinuity(store, restartedSessions);
    const recovery = await restarted.resolveRecovery({
      parsed: replayParsed(),
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
    expect(replayed?.identity.key).toBe(replayConversationKey());
    expect(replayed?.lastConfirmedTurn).toBeUndefined();
    expect((await store.list()).length).toBe(1);

    // The settled turn confirms the generation the replay established.
    restartedSessions.recordSentSystemFingerprint(replayConversationKey(), 2, "fingerprint-2");
    await restarted.confirmTurn({ turnId: "turn-2", at: 2 });
    const settled = (await store.list())[0];
    expect(settled?.generation).toBe(2);
    expect(settled?.checkpoint).toBe("confirmed");
    expect(settled?.lastConfirmedTurn).toEqual({ turnId: "turn-2", at: 2 });
  });

  test("a proven installation is never replayed: it continues", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    await settleReplayFirstTurn(store, sessions);

    // Same process, installation still recorded: the decision stays a continuation.
    const resumed = replayContinuity(store, sessions);
    expect(await resumed.resolveRecovery({
      parsed: replayParsed(),
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
    await settleReplayFirstTurn(store, new ChatGptTurnSessions());

    const restarted = replayContinuity(store, new ChatGptTurnSessions());
    await expect(restarted.resolveRecovery({
      parsed: replayParsed({ withHistory: false }),
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
    const first = replayContinuity(store, new ChatGptTurnSessions());
    expect(await first.resolveRecovery({
      parsed: replayParsed(),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    })).toBe("NEW");
    expect((await store.list())[0]?.generation).toBe(1);
    expect((await store.list())[0]?.checkpoint).toBe("unconfirmed");
  });
});

/**
 * Merged: the durable replay is proven through the real native turn path (issue #193 C2).
 *
 * The original #193 tests recorded the installation fingerprint by hand
 * (`sessions.recordSentSystemFingerprint(...)`), so they established the restart state *before*
 * deciding. This section builds the production composition —
 * `createChatGptWebAdapter(provider, { surfaceTransport })` over the real driver, continuity
 * decision, WebChat core, durable store and settlement — so the state under test is produced by the
 * code the deployment runs.
 *
 * What is real: the provider adapter, `startRuntime`, prompt preparation and compilation, the
 * submission hooks, the settlement/confirmation path, the ChatGPT driver, the WebChat continuity
 * decision and core, the durable file store (one writer per file/process), and the
 * retryability-free turn surface. What is simulated: only the browser I/O.
 */
const RESTART_ACCOUNT_FINGERPRINT = "account-native-restart";

const restartProvider = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: RESTART_ACCOUNT_FINGERPRINT,
    browserInteractionMode: "automatic",
    browserHost: "managed-chrome",
    storageStatePath: "/tmp/chatgpt-native-restart-state.json",
    chromeExecutablePath: "/usr/bin/chromium",
    brokerSocketPath: "/tmp/chatgpt-native-restart-broker.sock",
    localToolsEnabled: false,
    solAvailable: false,
    proAvailable: false,
    capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
    experimentalBiggerContext: false,
  },
} as unknown as CodexProviderConfig;

const RESTART_SESSION = "session-native-restart";
const RESTART_THREAD = "thread-native-restart";

/** Canonical host history, or none at all when the request carries only system instructions. */
function restartParsed(options: { readonly turn: string; readonly withHistory?: boolean }): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    context: {
      systemPrompt: ["eres un asistente"],
      messages: options.withHistory === false
        ? []
        : [{ role: "user", content: [{ type: "text", text: "arregla el bug" }] }],
    },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: { dshSessionId: RESTART_SESSION, threadId: RESTART_THREAD, turnId: options.turn },
  } as unknown as CodexParsedRequest;
}

interface RestartSurfaceRun {
  readonly turn: WebSurfaceTurn;
  readonly prompt: string;
}

/**
 * The controlled browser I/O.
 *
 * `run()` calls exactly the hooks the browser worker calls, in the same order, with test-controlled
 * outcomes (`activate`, `submit`, failure). The prompt text the adapter compiled for this turn is
 * captured so the test can prove the replay rebuilt the conversation from canonical history.
 */
class RestartControlledSurface {
  readonly runs: RestartSurfaceRun[] = [];
  /** Test-controlled behaviour of the next browser run. */
  next: { activate?: boolean; submit?: boolean; answer?: string; fail?: Error } = {
    activate: true,
    submit: true,
    answer: "respuesta del turno",
  };
  /** Runs the test's assertion while the turn is still in flight, before settlement. */
  beforeSettle: ((run: RestartSurfaceRun) => void | Promise<void>) | undefined;

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const compiled = await turn.prepare();
        const run: RestartSurfaceRun = { turn, prompt: compiled.text };
        this.runs.push(run);
        await this.beforeSettle?.(run);
        // The surface lifecycle the browser worker performs, in its order: bind the physical surface,
        // declare it ready, then the send activation and the submission that follow it.
        await turn.onPhysicalSurfaceBound?.({
          resourceId: "surface-resource",
          browserContextId: "surface-context",
          pageId: "surface-page",
          profileId: "surface-profile",
          accountId: `chatgpt-account:${RESTART_ACCOUNT_FINGERPRINT}`,
        });
        await turn.onSurfaceReady?.();
        if (this.next.activate === true) await turn.onSendActivated?.();
        if (this.next.submit === true) turn.onSubmitted?.();
        if (this.next.fail) throw this.next.fail;
        const answer = this.next.answer ?? "";
        if (answer.length > 0) turn.onTextDelta(answer);
        return answer;
      },
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

/** A production-composed provider adapter whose only replaced part is the browser transport. */
function restartNativeAdapter(surface: RestartControlledSurface) {
  return createChatGptWebAdapter(restartProvider, { surfaceTransport: surface.transport });
}

async function restartRunTurn(adapter: ReturnType<typeof restartNativeAdapter>, request: CodexParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn(request, { headers: new Headers() }, event => events.push(event));
  return events;
}

async function restartDurableRecords() {
  return resolveNativeChatGptContinuityStore().list();
}

interface RestartDurableDocument {
  version: number;
  records: Array<{
    generation: number;
    checkpoint: string;
    handle?: string;
    lastConfirmedTurn?: { turnId: string; at: number };
  }>;
}

function restartDurableFile(file: string): RestartDurableDocument {
  return JSON.parse(readFileSync(file, "utf8")) as RestartDurableDocument;
}

function installRestartDurableConfig(): string {
  const file = join(home, "conversations.json");
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: file } });
  return file;
}

/**
 * One settled first turn through the real path: it installs the conversation, the browser turn
 * settles, the adapter confirms the record, and the runtime shuts down.
 */
async function settleRestartFirstTurn(file: string): Promise<void> {
  // Each test starts from a clean process: the generation counter and the installation state live in
  // the session registry, and a test that inherits the previous one would not be a first turn.
  chatGptTurnSessions.clear();
  const surface = new RestartControlledSurface();
  surface.next = { activate: true, submit: true, answer: "respuesta del turno uno" };
  const adapter = restartNativeAdapter(surface);
  await restartRunTurn(adapter, restartParsed({ turn: "turn-1" }));
  await adapter.shutdown?.();
  // The restart boundary: the process ends, so everything the process kept about the installation —
  // the sent-system fingerprints and the retirements — is gone, while the durable file survives.
  // Without this the next turn is an exact resume of state the restarted process never established.
  chatGptTurnSessions.clear();
  // The record the restart finds: generation 1, confirmed by the settled turn.
  expect(restartDurableFile(file).records[0]?.generation).toBe(1);
  expect(restartDurableFile(file).records[0]?.checkpoint).toBe("confirmed");
}

describe("issue #193 — a restart replays durably through the real native path", () => {
  test("the restart's next turn is an explicit replay, unconfirmed until it settles successfully", async () => {
    const file = installRestartDurableConfig();
    await settleRestartFirstTurn(file);

    // Restart: the durable record survives, the process-local installation state does not.
    const surface = new RestartControlledSurface();
    surface.next = { activate: true, submit: true, answer: "respuesta del turno dos" };
    let inFlight: Awaited<ReturnType<typeof restartDurableRecords>> | undefined;
    surface.beforeSettle = async () => { inFlight = await restartDurableRecords(); };
    const adapter = restartNativeAdapter(surface);

    await restartRunTurn(adapter, restartParsed({ turn: "turn-2" }));

    // The decision was an explicit replay of the recorded conversation: the generation advanced by one
    // (a continuation would have kept generation 1 and a new conversation would not have advanced it),
    // and the replay rebuilt the prompt from canonical host history.
    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]?.prompt).toContain("arregla el bug");
    expect(inFlight).toHaveLength(1);
    expect(inFlight?.[0]?.generation).toBe(2);
    expect(inFlight?.[0]?.identity.key).toBe((await restartDurableRecords())[0]?.identity.key);
    // Unconfirmed while the turn is in flight, and with no settled turn recorded yet.
    expect(inFlight?.[0]?.checkpoint).toBe("unconfirmed");
    expect(inFlight?.[0]?.lastConfirmedTurn).toBeUndefined();

    // Only the settled turn confirms it.
    const settled = await restartDurableRecords();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.generation).toBe(2);
    expect(settled[0]?.checkpoint).toBe("confirmed");
    expect(settled[0]?.lastConfirmedTurn?.turnId).toBe("turn-2");
  });

  test("a failed or ambiguous turn cannot be resumed as confirmed", async () => {
    const file = installRestartDurableConfig();
    await settleRestartFirstTurn(file);

    // Restart, and the browser turn fails after Send activation: the prompt may have reached ChatGPT,
    // so nothing about this attempt is proof of continuation.
    const failedSurface = new RestartControlledSurface();
    failedSurface.next = { activate: true, submit: false, fail: new Error("browser session lost") };
    const failing = restartNativeAdapter(failedSurface);
    // The native adapter reports a failed browser turn as an error event (it settled the turn as
    // failed), not by throwing: what matters here is that nothing about this attempt became proof of
    // continuation.
    const failedEvents = await restartRunTurn(failing, restartParsed({ turn: "turn-2" }));
    expect(failedEvents.some(event => event.type === "error")).toBe(true);
    await failing.shutdown?.();

    // The replayed generation is registered but never confirmed.
    expect(restartDurableFile(file).records[0]?.generation).toBe(2);
    expect(restartDurableFile(file).records[0]?.checkpoint).toBe("unconfirmed");
    expect(restartDurableFile(file).records[0]?.lastConfirmedTurn).toBeUndefined();

    // A later turn does not treat it as resumable: it replays again (generation 3) rather than
    // continuing a conversation whose last attempt was never confirmed.
    const surface = new RestartControlledSurface();
    surface.next = { activate: true, submit: true, answer: "respuesta del turno tres" };
    let inFlight: Awaited<ReturnType<typeof restartDurableRecords>> | undefined;
    surface.beforeSettle = async () => { inFlight = await restartDurableRecords(); };
    const adapter = restartNativeAdapter(surface);
    await restartRunTurn(adapter, restartParsed({ turn: "turn-3" }));

    expect(inFlight?.[0]?.generation).toBe(3);
    expect(inFlight?.[0]?.checkpoint).toBe("unconfirmed");
    expect(restartDurableFile(file).records[0]?.checkpoint).toBe("confirmed");
    expect(restartDurableFile(file).records[0]?.lastConfirmedTurn?.turnId).toBe("turn-3");
  });

  test("without canonical history the restart fails explicitly and leaves the durable file intact", async () => {
    const file = installRestartDurableConfig();
    await settleRestartFirstTurn(file);
    const before = readFileSync(file, "utf8");

    const surface = new RestartControlledSurface();
    const adapter = restartNativeAdapter(surface);
    // The ChatGPT native transport requires the current turn's user message, so a request with no
    // messages at all cannot even be keyed: the turn fails explicitly with the provider's own error,
    // before any browser run and without creating or replacing a conversation. The narrower
    // "recorded conversation but nothing to rebuild from" guard is exercised where it is reachable —
    // at the continuity decision — by the durable suite above.
    await expect(restartRunTurn(adapter, restartParsed({ turn: "turn-2", withHistory: false }))).rejects.toThrow();

    // No browser turn was attempted, no new conversation was created, and the durable record is
    // byte-for-byte the one the previous process left behind.
    expect(surface.runs).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(restartDurableFile(file).records).toHaveLength(1);
    expect(restartDurableFile(file).records[0]?.generation).toBe(1);
    expect(restartDurableFile(file).records[0]?.checkpoint).toBe("confirmed");
    expect(restartDurableFile(file).records[0]?.lastConfirmedTurn?.turnId).toBe("turn-1");
  });
});
