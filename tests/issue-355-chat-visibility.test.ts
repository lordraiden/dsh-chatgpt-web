/**
 * Issue #355 — configurable Temporary Chat visibility.
 *
 * Every turn used to run in a persistent, history-visible ChatGPT conversation. The provider fact
 * `chatgptWeb.chatVisibility` now selects the surface: absent (or `"persistent"`) keeps today's
 * behaviour byte-for-byte, and `"temporary"` puts the turn on ChatGPT's Temporary Chat
 * (`https://chatgpt.com/?temporary-chat=true`), which is not written to the account history and does
 * not read or write ChatGPT memories.
 *
 * A Temporary Chat is deliberately **not** a durable provider conversation, so this suite pins the
 * three things that must therefore never happen for it — no conversation key claimed, no
 * installed-prefix fingerprint recorded, no conversation handle published — and proves them through
 * the real native turn path (only the browser I/O is simulated), not by re-implementing the decision.
 * The same harness is run once in persistent mode to show the difference is the fact and not the
 * fixture.
 *
 * The fact is validated by the one provider-facts owner, overlaid by the provider-scoped block and
 * readable/writable through the operator control surface, so all three descriptions of it are held to
 * the same rules here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";

import {
  chatGptWebChatBindingIdFor,
  chatGptWebExecutionNamespace,
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  shouldRetainChatGptWebConversation,
} from "../src/adapters/chatgpt-web/index";
import { createChatGptContinuity } from "../src/adapters/chatgpt-web/chatgpt-continuity";
import { createChatGptWebDriver } from "../src/adapters/chatgpt-web/chatgpt-driver";
import { chatGptWebChatIsTemporary, chatGptWebChatVisibility } from "../src/adapters/chatgpt-web/chat-visibility";
import { resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptConversationKey, resolveChatGptResumeBranch } from "../src/adapters/chatgpt-web/conversation-key";
import { compileChatGptWebPrompt, compileRetainedChatGptWebInstall } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_LUNA_CHECKPOINT_MARKER } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptWebChatAccountBinding } from "../src/adapters/chatgpt-web/web-chat-bridge";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import {
  CHATGPT_CHAT_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  assertChatGptPage,
  chatGptSurfaceUrl,
  isChatGptConversationUrl,
  isChatGptSurfaceUrl,
  isChatGptTemporaryChatUrl,
} from "../src/chatgpt-session";
import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  providerConfig,
  saveConfig,
  validateChatGptWebChatVisibility,
  validateChatGptWebProviderFacts,
  type AppConfig,
} from "../src/config";
import { effectiveChatGptWebProviderConfig } from "../src/chatgpt-web-provider-config";
import { startServer, type RunningServer } from "../src/server";
import { createMemoryConversationStore, webChatAccountBindingId } from "../src/web-chat/core";
import { CHATGPT_WEB_DRIVER_ID } from "../src/web-chat/host/provider-host";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

const CONTROL_TOKEN = "issue-355-chat-visibility-control-token-0123456789";
const ACCOUNT_FINGERPRINT = "issue-355-account";

let home: string;
let savedHome: SavedChatGptWebHome;
const running: RunningServer[] = [];

beforeEach(() => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-355-chat-visibility-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
});

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig(),
    port: 0,
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    ...overrides,
  };
}

/**
 * A configuration that can be **persisted and loaded back**.
 *
 * `port: 0` asks the listener for an ephemeral port and is not a value the loader accepts, so a
 * fixture that is written to `config.json` and read through `loadConfig` states a real port.
 */
function persistedConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return config({ port: 17_841, ...overrides });
}

function provider(overrides: Partial<AppConfig> = {}): CodexProviderConfig {
  return providerConfig(config(overrides));
}

/** A page stand-in: `assertChatGptPage` reads nothing but the URL. */
function pageAt(url: string): Page {
  return { url: () => url } as unknown as Page;
}

function parsed(options: { readonly turn?: string; readonly withHistory?: boolean } = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    context: {
      systemPrompt: ["eres un asistente"],
      messages: options.withHistory === false
        ? [{ role: "user", content: [{ type: "text", text: "segundo mensaje" }] }]
        : [
          { role: "user", content: [{ type: "text", text: "primer mensaje" }] },
          { role: "assistant", content: [{ type: "text", text: "primera respuesta" }] },
          { role: "user", content: [{ type: "text", text: "segundo mensaje" }] },
        ],
    },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: {
      dshSessionId: "session-355",
      threadId: "thread-355",
      turnId: options.turn ?? "turn-1",
    },
  } as unknown as CodexParsedRequest;
}

const BINDING = chatGptWebChatAccountBinding({
  providerId: CHATGPT_WEB_DRIVER_ID,
  accountFingerprint: ACCOUNT_FINGERPRINT,
  browserProfile: "managed-chrome",
  browserContext: "default-context",
});
const AFFINITY = { providerId: CHATGPT_WEB_DRIVER_ID, bindingId: webChatAccountBindingId(BINDING) };
const NAMESPACE = "issue-355-namespace";

describe("issue #355 — absent means persistent, byte-for-byte today's behaviour", () => {
  test("the provider fact is absent and every surface decision stays the persistent one", async () => {
    const persistent = provider();
    expect(persistent.chatgptWeb).not.toHaveProperty("chatVisibility");
    expect(chatGptWebChatVisibility(persistent)).toBe("persistent");
    expect(chatGptWebChatIsTemporary(persistent)).toBe(false);

    // The navigation target and the assertion are today's persistent surface.
    expect(chatGptSurfaceUrl("persistent")).toBe(CHATGPT_CHAT_URL);
    expect(chatGptSurfaceUrl()).toBe(CHATGPT_CHAT_URL);
    expect(isChatGptSurfaceUrl(CHATGPT_CHAT_URL)).toBe(true);
    expect(resolveBrowserConfig(persistent).chatVisibility).toBe("persistent");

    // The persistent surface still rejects the temporary URL exactly as it did before the fact existed.
    expect(isChatGptConversationUrl(CHATGPT_TEMPORARY_CHAT_URL)).toBe(false);
    expect(isChatGptSurfaceUrl(CHATGPT_TEMPORARY_CHAT_URL, "persistent")).toBe(false);
    await expect(assertChatGptPage(pageAt(CHATGPT_TEMPORARY_CHAT_URL))).rejects.toThrow(
      /left the persistent conversation surface/,
    );
    await expect(assertChatGptPage(pageAt(CHATGPT_CHAT_URL))).resolves.toBeUndefined();
    await expect(assertChatGptPage(pageAt("https://chatgpt.com/c/abc123"))).resolves.toBeUndefined();
  });

  test("an authored \"persistent\" is the same behaviour, and the fact never re-keys a conversation", () => {
    const authored = provider({ chatVisibility: "persistent" });
    expect(authored.chatgptWeb?.chatVisibility).toBe("persistent");
    expect(chatGptWebChatVisibility(authored)).toBe("persistent");
    expect(resolveBrowserConfig(authored).chatVisibility).toBe("persistent");
    expect(chatGptSurfaceUrl(chatGptWebChatVisibility(authored))).toBe(CHATGPT_CHAT_URL);

    // The namespace keys every conversation and execution key, so a fact that only selects a surface
    // must hash as if it were not there: switching a deployment to temporary and back must resume the
    // conversations it already had instead of abandoning them.
    expect(provider().chatgptWeb).not.toHaveProperty("chatVisibility");
    expect(chatGptWebExecutionNamespace(provider({ chatVisibility: "persistent" })))
      .toBe(chatGptWebExecutionNamespace(provider()));
    expect(chatGptWebExecutionNamespace(provider({ chatVisibility: "temporary" })))
      .toBe(chatGptWebExecutionNamespace(provider()));
  });
});

describe("issue #355 — temporary mode selects ChatGPT's Temporary Chat surface", () => {
  test("the resolved fact navigates to the temporary URL and accepts it for that mode only", async () => {
    const temporary = provider({ chatVisibility: "temporary" });
    expect(temporary.chatgptWeb?.chatVisibility).toBe("temporary");
    expect(chatGptWebChatVisibility(temporary)).toBe("temporary");
    expect(chatGptWebChatIsTemporary(temporary)).toBe(true);

    // The exact surface the issue names, and the URL the worker navigates to.
    expect(CHATGPT_TEMPORARY_CHAT_URL).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(chatGptSurfaceUrl("temporary")).toBe(CHATGPT_TEMPORARY_CHAT_URL);
    expect(resolveBrowserConfig(temporary).chatVisibility).toBe("temporary");

    // Accepted for the temporary mode...
    expect(isChatGptTemporaryChatUrl(CHATGPT_TEMPORARY_CHAT_URL)).toBe(true);
    expect(isChatGptSurfaceUrl(CHATGPT_TEMPORARY_CHAT_URL, "temporary")).toBe(true);
    await expect(assertChatGptPage(pageAt(CHATGPT_TEMPORARY_CHAT_URL), "temporary")).resolves.toBeUndefined();
    // ...and still refused by the persistent mode, which is what keeps a temporary deployment from
    // being silently read as a persistent one (and the other way round).
    expect(isChatGptSurfaceUrl(CHATGPT_TEMPORARY_CHAT_URL, "persistent")).toBe(false);
    expect(isChatGptSurfaceUrl(CHATGPT_CHAT_URL, "temporary")).toBe(false);
    await expect(assertChatGptPage(pageAt(CHATGPT_CHAT_URL), "temporary")).rejects.toThrow(
      /left the Temporary Chat surface/,
    );

    // A temporary chat keeps the conversation path shapes but only while its switch is present: a URL
    // that lost `temporary-chat=true` is a persistent conversation, never a silent continuation.
    expect(isChatGptTemporaryChatUrl("https://chatgpt.com/c/abc123?temporary-chat=true")).toBe(true);
    expect(isChatGptTemporaryChatUrl("https://chatgpt.com/c/abc123")).toBe(false);
    expect(isChatGptTemporaryChatUrl("https://example.com/?temporary-chat=true")).toBe(false);
  });
});

describe("issue #355 — temporary mode claims no key, records no fingerprint and publishes no handle", () => {
  test("the retention decision refuses every reason a persistent turn retains", () => {
    const mode = { localTools: false };
    // The same turn retains in persistent mode (the contrast that makes the temporary answer meaningful).
    expect(shouldRetainChatGptWebConversation(parsed(), mode, false, "persistent")).toBe(true);
    // ...and retains nothing in temporary mode, for a normal turn, an Advisor review and a Luna turn.
    expect(shouldRetainChatGptWebConversation(parsed(), mode, false, "temporary")).toBe(false);
    expect(shouldRetainChatGptWebConversation(advisorParsed(), mode, false, "temporary")).toBe(false);
    expect(shouldRetainChatGptWebConversation(parsed(), { localTools: true }, false, "temporary")).toBe(false);
    // The retired reason still applies on its own; the temporary fact is not `isEphemeralWebChatTurn`.
    expect(shouldRetainChatGptWebConversation(parsed(), mode, true, "persistent")).toBe(false);
  });

  test("without a conversation key no continuation is possible: every turn replays canonical history", () => {
    // With no conversation key there is no branch to continue from, so the turn always installs.
    expect(resolveChatGptResumeBranch(chatGptTurnSessions, undefined, 1)).toBe("install");
    // The non-retained transport is the full self-contained envelope: it carries the complete canonical
    // history on every turn, which is the explicit replay — never a delta, never a silent continuation.
    const compiled = compileChatGptWebPrompt(parsed(), { localToolsEnabled: false, solAvailable: false, proAvailable: false });
    expect(compiled.text).toContain("primer mensaje");
    expect(compiled.text).toContain("primera respuesta");
    expect(compiled.text).toContain("segundo mensaje");
    // The retained install projection is the other explicit rebuild, used when a conversation *is*
    // retained; a temporary turn never reaches it because it never owns a conversation.
    const retained = compileRetainedChatGptWebInstall(parsed(), {});
    expect(retained.text).toContain("User: primer mensaje");
    expect(retained.text).toContain("Assistant: primera respuesta");
  });

  test("the continuity decision is an explicit replay and writes nothing to the durable store", async () => {
    const store = createMemoryConversationStore();
    const continuity = createChatGptContinuity({
      provider: provider({ chatVisibility: "temporary" }),
      affinity: AFFINITY,
      namespace: NAMESPACE,
      binding: BINDING,
      store,
    });

    expect(await continuity.resolveRecovery({
      parsed: parsed(),
      legacyRecovery: "NEW",
      contextExhausted: false,
      retired: false,
    })).toBe("REPLAY");
    await continuity.confirmTurn({ turnId: "turn-1", at: 1 });

    // No record, therefore no opaque handle: nothing can ever resume this "conversation".
    expect(await store.list()).toEqual([]);
  });

  test("the driver refuses to publish a conversation handle at all", async () => {
    const driver = createChatGptWebDriver({ provider: provider({ chatVisibility: "temporary" }) });
    const assessment = await driver.assessConversation({
      dshSession: { sessionId: "session-355" },
      binding: BINDING,
      affinity: { providerId: CHATGPT_WEB_DRIVER_ID, bindingId: AFFINITY.bindingId, threadId: "thread-355" },
      model: "gpt-5.6-luna",
    });
    expect(assessment).toEqual({
      status: "unsupported",
      reason: "ChatGPT Web temporary chat visibility has no resumable provider conversation",
    });

    const selection = {
      dshSession: { sessionId: "session-355" },
      binding: BINDING,
      affinity: { providerId: CHATGPT_WEB_DRIVER_ID, bindingId: AFFINITY.bindingId, threadId: "thread-355" },
      model: "gpt-5.6-luna",
    };
    await expect(driver.createConversation(selection)).rejects.toThrow(/publishes no provider conversation/);
    await expect(driver.resumeConversation({
      ...selection,
      conversation: {
        key: "conversation-key",
        providerId: CHATGPT_WEB_DRIVER_ID,
        bindingId: AFFINITY.bindingId,
        generation: 1,
        handle: "chatgpt-web:conversation-key:1" as never,
        status: "resumable",
      },
    })).rejects.toThrow(/publishes no provider conversation/);
    await expect(driver.replayConversation({
      ...selection,
      history: [{ role: "user", text: "segundo mensaje" }],
    })).rejects.toThrow(/publishes no provider conversation/);

    // The persistent driver is unchanged: it still establishes a conversation and its handle.
    const persistent = createChatGptWebDriver({ provider: provider() });
    const created = await persistent.createConversation(selection);
    expect(String(created.handle)).toBe(`${CHATGPT_WEB_DRIVER_ID}:${created.key}:${created.generation}`);
  });

  test("the real native turn path claims nothing and publishes no handle (only browser I/O is simulated)", async () => {
    const file = join(home, "conversations.json");
    saveConfig(persistedConfig({ chatVisibility: "temporary", webChat: { conversationStorePath: file } }));

    const surface = new ControlledSurface();
    const adapter = createChatGptWebAdapter(provider({ chatVisibility: "temporary" }), {
      surfaceTransport: surface.transport,
    });
    const events = await runTurn(adapter, parsed({ turn: "turn-temporary-1" }));
    await adapter.shutdown?.();

    // The browser turn was told nothing about a provider conversation.
    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]?.turn.conversationKey).toBeUndefined();
    expect(surface.runs[0]?.turn.retainConversation).toBeUndefined();
    expect(surface.runs[0]?.turn.requireRetainedConversation).toBeUndefined();
    // The prompt is the explicit replay of the caller's canonical history: the complete conversation is
    // re-sent on every temporary turn, never a delta that would continue an unrelated chat, and never a
    // Luna rolling checkpoint that would replace that history with provider-local compacted state.
    expect(surface.runs[0]?.prompt).toContain("primer mensaje");
    expect(surface.runs[0]?.prompt).toContain("primera respuesta");
    expect(surface.runs[0]?.prompt).toContain("segundo mensaje");
    expect(surface.runs[0]?.turn.captureLunaCheckpoint).toBeUndefined();
    expect(surface.runs[0]?.prompt).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
    // The answer still reaches the caller: the surface serves the turn, it just keeps nothing.
    expect(events.some(event => event.type === "text_delta" && event.text === "respuesta temporal")).toBe(true);

    // A conversation key *would* be derivable for this deployment, which is what makes its absence the
    // temporary decision rather than a missing identity.
    const temporaryProvider = provider({ chatVisibility: "temporary" });
    const wouldBeKey = chatGptConversationKey(parsed(), chatGptWebExecutionNamespace(temporaryProvider), {
      providerId: CHATGPT_WEB_DRIVER_ID,
      bindingId: chatGptWebChatBindingIdFor(temporaryProvider),
    });
    expect(wouldBeKey).toBeDefined();
    // No installed-prefix fingerprint was recorded for it, and no durable record was published — the
    // continuity file was not even created.
    expect(chatGptTurnSessions.sentSystemFingerprint(wouldBeKey!, 1)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("the same harness in persistent mode does claim a key and publish a handle", async () => {
    // The contrast that proves the temporary assertions above are the fact's doing, not the fixture's.
    const file = join(home, "persistent-conversations.json");
    saveConfig(persistedConfig({ webChat: { conversationStorePath: file } }));

    const surface = new ControlledSurface();
    const adapter = createChatGptWebAdapter(provider(), { surfaceTransport: surface.transport });
    await runTurn(adapter, parsed({ turn: "turn-persistent-1" }));
    await adapter.shutdown?.();

    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]?.turn.conversationKey).toBeDefined();
    expect(surface.runs[0]?.turn.retainConversation).toBe(true);
    // The persistent conversation is a durable record with a handle, which is what a temporary turn
    // must never produce.
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<{ handle?: string; checkpoint: string }>;
    };
    expect(document.records).toHaveLength(1);
    expect(document.records[0]?.handle).toBeDefined();
    // The installed-prefix fingerprint the persistent path records for that conversation generation.
    expect(chatGptTurnSessions.sentSystemFingerprint(surface.runs[0]!.turn.conversationKey!, 1)).toBeDefined();
  });
});

function advisorParsed(): CodexParsedRequest {
  return { ...parsed(), _advisorReview: { reviewId: "review-1" } } as unknown as CodexParsedRequest;
}

/**
 * The controlled browser I/O for the real native turn path.
 *
 * `run()` calls exactly the hooks the browser worker calls, in the same order; the only simulated part
 * is the browser itself. The prompt the adapter compiled is captured so the test can prove the turn
 * was an explicit replay of canonical history.
 */
class ControlledSurface {
  readonly runs: Array<{ turn: WebSurfaceTurn; prompt: string }> = [];

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const compiled = await turn.prepare();
        this.runs.push({ turn, prompt: compiled.text });
        await turn.onPhysicalSurfaceBound?.({
          resourceId: "surface-resource",
          browserContextId: "surface-context",
          pageId: "surface-page",
          profileId: "surface-profile",
          accountId: `chatgpt-account:${ACCOUNT_FINGERPRINT}`,
        });
        await turn.onSurfaceReady?.();
        await turn.onSendActivated?.();
        turn.onSubmitted?.();
        const answer = "respuesta temporal";
        turn.onTextDelta(answer);
        return answer;
      },
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

async function runTurn(
  adapter: ReturnType<typeof createChatGptWebAdapter>,
  request: CodexParsedRequest,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn(request, { headers: new Headers() }, event => events.push(event));
  return events;
}

describe("issue #355 — the one provider-facts owner validates the fact and its location", () => {
  test("an invalid value is refused with the location it was read from", () => {
    expect(() => validateChatGptWebProviderFacts({ chatVisibility: "hidden" }, "config.json"))
      .toThrow(/Invalid chatVisibility in config\.json/);
    expect(() => validateChatGptWebChatVisibility("hidden", "control API"))
      .toThrow(/Invalid chatVisibility in control API/);
    expect(() => validateChatGptWebChatVisibility(null, "config.json"))
      .toThrow(/Invalid chatVisibility in config\.json/);
    expect(validateChatGptWebChatVisibility("temporary")).toBe("temporary");
    expect(validateChatGptWebChatVisibility("persistent")).toBe("persistent");
    // The flat block and the scoped overlay accept the two modes.
    expect(() => validateChatGptWebProviderFacts({ chatVisibility: "temporary" })).not.toThrow();
  });

  test("the loader refuses an invalid flat value and an invalid scoped value with its own path", () => {
    saveConfig(persistedConfig());
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;

    saveConfigFile({ ...raw, chatVisibility: "hidden" });
    expect(() => loadConfig()).toThrow(/Invalid chatVisibility/);

    saveConfigFile({ ...raw, webChat: { providers: { "chatgpt-web": { chatVisibility: "hidden" } } } });
    expect(() => loadConfig()).toThrow(/Invalid chatVisibility in .*webChat\.providers\["chatgpt-web"\]/);

    saveConfigFile({ ...raw, chatVisibility: "temporary" });
    expect(loadConfig().chatVisibility).toBe("temporary");
  });

  test("temporary visibility on the launcher host is refused instead of silently running persistent", () => {
    // The launcher attaches to the product's own Electron surface, where the fact cannot be honoured.
    // Saving it would put every turn back into the account history the operator opted out of.
    expect(() => validateChatGptWebProviderFacts(
      { chatVisibility: "temporary", browserHost: "launcher", browserHostDescriptorPath: "/tmp/host.json" },
      "config.json",
    )).toThrow(/Temporary chat visibility requires the managed-chrome browser host in config\.json/);
    // The scoped overlay is checked against the effective merged facts, so the same combination is
    // refused there too, naming the scoped location.
    const launcher = config({
      browserHost: "launcher",
      browserInteractionMode: "manual",
      mode: "full",
      browserHostDescriptorPath: "/tmp/browser-host.json",
    });
    launcher.webChat = { providers: { "chatgpt-web": { chatVisibility: "temporary" } } };
    expect(() => effectiveChatGptWebProviderConfig(launcher))
      .toThrow(/Temporary chat visibility requires the managed-chrome browser host in webChat\.providers\["chatgpt-web"\]/);
  });
});

/** Write a raw configuration document, exactly as an operator would edit it. */
function saveConfigFile(document: Record<string, unknown>): void {
  saveConfig(document as unknown as AppConfig);
}

describe("issue #355 — the provider-scoped overlay wins over the flat field", () => {
  test("a scoped visibility overrides the flat one in both directions", () => {
    const flatTemporary = config({ chatVisibility: "temporary" });
    expect(effectiveChatGptWebProviderConfig(flatTemporary).chatgptWeb?.chatVisibility).toBe("temporary");

    flatTemporary.webChat = { providers: { "chatgpt-web": { chatVisibility: "persistent" } } };
    expect(effectiveChatGptWebProviderConfig(flatTemporary).chatgptWeb?.chatVisibility).toBe("persistent");
    expect(chatGptWebChatVisibility(effectiveChatGptWebProviderConfig(flatTemporary))).toBe("persistent");

    const flatPersistent = config();
    flatPersistent.webChat = { providers: { "chatgpt-web": { chatVisibility: "temporary" } } };
    expect(effectiveChatGptWebProviderConfig(flatPersistent).chatgptWeb?.chatVisibility).toBe("temporary");
    expect(chatGptWebChatIsTemporary(effectiveChatGptWebProviderConfig(flatPersistent))).toBe(true);

    // An overlay that states no visibility keeps the flat fact.
    flatTemporary.webChat = { providers: { "chatgpt-web": { tuning: { composerCharLimit: 1_000 } } } };
    expect(effectiveChatGptWebProviderConfig(flatTemporary).chatgptWeb?.chatVisibility).toBe("temporary");
  });
});

describe("issue #355 — the control API reads and writes the fact", () => {
  function serve(value: AppConfig): RunningServer {
    const server = startServer(value);
    running.push(server);
    return server;
  }

  const controlUrl = (server: RunningServer, path: string): string => `http://127.0.0.1:${server.port}${path}`;
  const headers = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };

  test("the configured and the effective visibility are both readable", async () => {
    const server = serve(config());
    const response = await fetch(controlUrl(server, "/v1/control/config"), { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.chatVisibility).toBe("persistent");
    expect(body.effectiveChatVisibility).toBe("persistent");
    // The tuning surface it already exposed is unchanged.
    expect(body.defaults).toBeDefined();
    expect(body.effective).toBeDefined();
  });

  test("a PUT persists the fact and mutates the in-memory configuration the next turn reads", async () => {
    const live = config();
    const server = serve(live);

    const response = await fetch(controlUrl(server, "/v1/control/config"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ chatVisibility: "temporary" }),
    });
    expect(response.status).toBe(200);
    const put = await response.json() as Record<string, unknown>;
    expect(put.status).toBe("ok");
    expect(put.chatVisibility).toBe("temporary");

    // Persisted: the document the next process loads states the fact.
    const saved = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(saved.chatVisibility).toBe("temporary");
    // In memory: the very next turn resolves the temporary surface without a restart.
    expect(live.chatVisibility).toBe("temporary");
    expect(providerConfig(live).chatgptWeb?.chatVisibility).toBe("temporary");
    expect(resolveBrowserConfig(providerConfig(live)).chatVisibility).toBe("temporary");

    const readBack = await fetch(controlUrl(server, "/v1/control/config"), { headers });
    const body = await readBack.json() as Record<string, unknown>;
    expect(body.chatVisibility).toBe("temporary");
    expect(body.effectiveChatVisibility).toBe("temporary");
  });

  test("tuning and visibility can be written together, and tuning alone still works", async () => {
    const live = config();
    const server = serve(live);

    const both = await fetch(controlUrl(server, "/v1/control/config"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ tuning: { composerCharLimit: 1_000 }, chatVisibility: "temporary" }),
    });
    expect(both.status).toBe(200);
    expect(await both.json()).toEqual({
      status: "ok",
      tuning: { composerCharLimit: 1_000 },
      chatVisibility: "temporary",
    });
    expect(live.tuning).toEqual({ composerCharLimit: 1_000 });
    expect(live.chatVisibility).toBe("temporary");

    // A tuning-only PUT keeps the visibility it did not mention.
    const tuningOnly = await fetch(controlUrl(server, "/v1/control/config"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ tuning: { composerCharLimit: 2_000 } }),
    });
    expect(tuningOnly.status).toBe(200);
    expect(live.tuning).toEqual({ composerCharLimit: 2_000 });
    expect(live.chatVisibility).toBe("temporary");
  });

  test("an invalid value is refused with its location and nothing is written", async () => {
    // A valid document from before the refused write, so "nothing was written" is observable.
    saveConfig(persistedConfig());
    const live = config();
    const server = serve(live);

    const response = await fetch(controlUrl(server, "/v1/control/config"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ chatVisibility: "hidden" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toMatch(/Invalid chatVisibility in control API/);
    expect(live.chatVisibility).toBeUndefined();
    expect(loadConfig().chatVisibility).toBeUndefined();

    // An empty body keeps today's refusal instead of becoming a silent no-op.
    const empty = await fetch(controlUrl(server, "/v1/control/config"), {
      method: "PUT",
      headers,
      body: "{}",
    });
    expect(empty.status).toBe(400);
    expect((await empty.json() as { error: string }).error).toMatch(/Invalid tuning in control API/);
  });

  test("a provider-scoped block still wins over the in-memory flat mutation", async () => {
    const live = config();
    live.webChat = { providers: { "chatgpt-web": { chatVisibility: "persistent" } } };
    const server = serve(live);

    const response = await fetch(controlUrl(server, "/v1/control/config"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ chatVisibility: "temporary" }),
    });
    expect(response.status).toBe(200);
    // The flat field is what the control API writes; the scoped block is the effective fact.
    expect(live.chatVisibility).toBe("temporary");
    expect(chatGptWebChatVisibility(effectiveChatGptWebProviderConfig(live))).toBe("persistent");
    const readBack = await fetch(controlUrl(server, "/v1/control/config"), { headers });
    const body = await readBack.json() as Record<string, unknown>;
    expect(body.chatVisibility).toBe("temporary");
    expect(body.effectiveChatVisibility).toBe("persistent");
  });
});
