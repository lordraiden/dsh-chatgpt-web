/**
 * Issue #193 (correction C3) — the native continuity store fails closed on an unreadable config.
 *
 * The point-of-use resolver used to catch `loadConfig()` and keep continuity in memory, which presents
 * an invalid configuration as if durability were still available. The two outcomes are now explicit:
 *
 * - a **readable** configuration without `webChat.conversationStorePath` keeps continuity in memory —
 *   the intentional, documented fallback;
 * - a configuration that is **unreadable or invalid** raises a typed failure. Nothing is returned, so
 *   no caller can mistake an in-memory store for the deployment's durable continuity.
 *
 * The release path is covered too: shutdown drains the store's queue before it gives the file back, so
 * a second writer is refused while an accepted update has not reached the disk yet, and the release is
 * idempotent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  ChatGptWebNativeContinuityConfigError,
  closeNativeChatGptContinuityStores,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import { defaultConfig, getConfigDir, getConfigPath, saveConfig } from "../src/config";
import type { WebChatConversationDraft, WebChatConversationIdentity } from "../src/web-chat/core";

const IDENTITY: WebChatConversationIdentity = {
  providerId: "chatgpt-web",
  bindingId: "binding-c3",
  key: "conversation-c3",
};

/** A minimal valid draft: what the store owns is revision and timestamps. */
function draft(generation: number): WebChatConversationDraft {
  return { identity: IDENTITY, generation, status: "resumable", checkpoint: "confirmed" };
}

/** The resolver's outcome, kept apart so "it threw" and "it returned a store" are distinct facts. */
function resolveOutcome(): { store?: unknown; error?: unknown } {
  try {
    return { store: resolveNativeChatGptContinuityStore() };
  } catch (error) {
    return { error };
  }
}

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(() => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-193-fail-closed-", { clearFreeHome: true });
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  restoreChatGptWebHome(savedHome, home);
});

function installConfig(conversationStorePath: string | undefined): void {
  saveConfig({
    ...defaultConfig(),
    ...(conversationStorePath !== undefined ? { webChat: { conversationStorePath } } : {}),
  });
}

describe("issue #193 — an unreadable configuration never becomes an in-memory store", () => {
  test("a missing configuration file is a typed failure, not a memory fallback", () => {
    // No configuration was installed in this home.
    expect(existsSync(getConfigPath())).toBe(false);

    const outcome = resolveOutcome();
    expect(outcome.store).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(ChatGptWebNativeContinuityConfigError);
    expect((outcome.error as Error).message).toMatch(/unreadable or invalid/);
  });

  test("an invalid configuration body is a typed failure too", () => {
    writeFileSync(getConfigPath(), "{ this is not a configuration");
    const malformed = resolveOutcome();
    expect(malformed.store).toBeUndefined();
    expect(malformed.error).toBeInstanceOf(ChatGptWebNativeContinuityConfigError);

    // A structurally valid JSON document that is not a configuration fails the same way: the process
    // must not decide continuity against a configuration it could not validate.
    writeFileSync(getConfigPath(), JSON.stringify({ version: 99, records: [] }));
    const unparseable = resolveOutcome();
    expect(unparseable.store).toBeUndefined();
    expect(unparseable.error).toBeInstanceOf(ChatGptWebNativeContinuityConfigError);

    // Nothing was fabricated at the default durable location either.
    expect(existsSync(join(getConfigDir(), "web-chat", "conversations.json"))).toBe(false);
  });
});

describe("issue #193 — a readable configuration without a location keeps memory continuity", () => {
  test("the intentional fallback returns an empty memory store and invents no file", async () => {
    installConfig(undefined);

    const store = resolveNativeChatGptContinuityStore();
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(getConfigDir(), "web-chat", "conversations.json"))).toBe(false);
    // A readable configuration with no configured location is not a failure: it resolves to the
    // memory backend and a later resolve returns the same process-owned store.
    expect(resolveNativeChatGptContinuityStore()).toBe(store);
  });
});

describe("issue #193 — shutdown drains before it releases the store", () => {
  test("an in-flight update keeps the writer slot, and the release is idempotent", async () => {
    const file = join(home, "conversations.json");
    installConfig(file);
    const store = resolveNativeChatGptContinuityStore();

    // An accepted update that has not reached the disk yet: the mutation holds the queue so the
    // release genuinely overlaps it instead of racing a microtask.
    const pending = store.update(IDENTITY, () => {
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // Hold the serialized queue open.
      }
      return draft(1);
    });
    const shutdown = closeNativeChatGptContinuityStores();

    // While draining, the store still owns the file: a second writer is refused rather than racing the
    // update that is still in flight.
    expect(() => resolveNativeChatGptContinuityStore()).toThrow(/already owns it/);

    await pending;
    await shutdown;
    // The update committed before the file was released.
    const document = JSON.parse(readFileSync(file, "utf8")) as { records: unknown[] };
    expect(document.records).toHaveLength(1);

    // Idempotent: releasing a process with no stores is a no-op, concurrently or repeatedly.
    await Promise.all([closeNativeChatGptContinuityStores(), closeNativeChatGptContinuityStores()]);

    // Released: the next runtime opens the same file and sees the committed record.
    const next = resolveNativeChatGptContinuityStore();
    expect(next).not.toBe(store);
    expect(await next.list()).toHaveLength(1);
  });
});
