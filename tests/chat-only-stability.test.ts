import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeNativeChatGptContinuityStores, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
} from "../src/adapters/chatgpt-web/model";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  ControlledSurface,
  captureConsole,
  controlledIncoming,
  controlledParsed,
  controlledProviderConfig,
} from "./support/chatgpt-web-surface";

/**
 * The chat-only stability baseline.
 *
 * The former "terminal non-retryable failure path settles ProviderCore only once" and "runTurn
 * exposes a safe high-level chat-only diagnostic" tests read `src/adapters/chatgpt-web/index.ts` and
 * asserted on its text. Both are replaced here by real turns through the adapter's injected
 * surface-transport seam, which is the property those assertions were trying to protect.
 */
let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("dsh-chat-only-stability-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

describe("chat-only stability baseline", () => {
  test("common ChatGPT Web routes remain tool-disabled in stability mode", () => {
    const capabilities = {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
    };

    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, effort, capabilities);
      expect(mode.localTools).toBe(false);
    }

    const luna = resolveChatGptWebModelMode(
      CHATGPT_WEB_LUNA_MODEL_ID,
      "low",
      { ...capabilities, solAvailable: false },
    );
    expect(luna.localTools).toBe(false);
  });

  test("a terminal non-retryable failure settles ProviderCore exactly once and leaves it retired", async () => {
    const provider = controlledProviderConfig(home);
    const providerCore = new ChatGptWebProviderCore();
    const surface = new ControlledSurface();
    // A failure after a confirmed submission: terminal, and never automatically retryable.
    surface.enqueue({
      error: new ChatGptWebAdapterError("provider failed after submission", {
        status: 500,
        errorType: "server_error",
        code: "provider_timeout",
        retryable: false,
      }),
    });
    const adapter = createChatGptWebAdapter(provider, {
      surfaceTransport: surface.transport,
      providerCore,
    });

    const events: Array<{ type: string; code?: string; retryable?: boolean }> = [];
    await adapter.runTurn(controlledParsed(), controlledIncoming(), event => events.push(event));

    // The turn surfaced exactly one terminal, non-retryable failure and never completed.
    const failures = events.filter(event => event.type === "error" || event.type === "incomplete");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("provider_timeout");
    expect(failures[0]?.retryable).toBe(false);
    expect(events.some(event => event.type === "done")).toBe(false);

    // It settled exactly once: a second logical settlement would have thrown, and shutdown
    // completes without an active lease or an unsettled turn holding the core open.
    await expect(providerCore.shutdown()).resolves.toBeUndefined();
    await adapter.shutdown?.();
  });

  test("a chat-only run logs the safe high-level diagnostic and no synthetic Pure Chat commentary", async () => {
    const provider = controlledProviderConfig(home);
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "a plain answer" });
    const adapter = createChatGptWebAdapter(provider, { surfaceTransport: surface.transport });

    const captured = captureConsole();
    try {
      await adapter.runTurn(controlledParsed({ userText: "hola" }), controlledIncoming(), () => {});
    } finally {
      captured.restore();
    }

    // The one high-level diagnostic exists, and it is safe (model id only, no prompt or payload).
    expect(captured.text()).toContain("[chatgpt-web] runTurn model=gpt-5.6-luna chatOnly=true");
    // The retired synthetic banner is never emitted at runtime, not merely absent from the source.
    expect(captured.text()).not.toContain("Pure Chat Mode");
    expect(captured.text()).not.toContain("Pure Chat");
    expect(captured.text()).not.toContain("hola");
    await adapter.shutdown?.();
  });
});
