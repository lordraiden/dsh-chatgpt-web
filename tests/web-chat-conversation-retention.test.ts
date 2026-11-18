import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../src/web-chat/persistence/conversation-store-file";
import type { WebChatConversationIdentity } from "../src/web-chat/core";

/**
 * Bounded retention for the durable conversation store.
 *
 * The store keeps continuity forever unless a deployment asks for retention. These tests pin the
 * three rules: the age bound, the entry cap, and the one record that is never pruned (an
 * `unconfirmed` attempt, whose reconciliation the next turn still needs).
 */

const DAY = 86_400_000;

function identity(key: string): WebChatConversationIdentity {
  return { providerId: "chatgpt-web", bindingId: "account", key };
}

function draft(identity: WebChatConversationIdentity, checkpoint: "confirmed" | "unconfirmed" = "confirmed") {
  return {
    identity,
    generation: 1,
    status: checkpoint === "confirmed" ? ("resumable" as const) : ("new" as const),
    checkpoint,
  };
}

function storedKeys(file: string): string[] {
  const document = JSON.parse(readFileSync(file, "utf8")) as {
    records: Array<{ identity: { key: string } }>;
  };
  return document.records.map((record) => record.identity.key);
}

function withStore(
  retention: { maxAgeDays?: number; maxEntries?: number } | undefined,
  run: (context: { file: string; store: ReturnType<typeof createFileConversationStore>; advance: (ms: number) => void }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "conversation-retention-"));
  const file = join(dir, "conversations.json");
  let now = 1_000_000_000_000;
  const store = createFileConversationStore({
    file,
    now: () => now,
    ...(retention === undefined ? {} : { retention }),
  });
  return run({ file, store, advance: (ms) => { now += ms; } })
    .finally(async () => {
      await store.close?.();
      rmSync(dir, { recursive: true, force: true });
    });
}

describe("conversation store retention", () => {
  test("drops confirmed records older than maxAgeDays and keeps the recent one", async () => {
    await withStore({ maxAgeDays: 30 }, async ({ file, store, advance }) => {
      await store.update(identity("old"), () => draft(identity("old")));
      advance(31 * DAY);
      await store.update(identity("new"), () => draft(identity("new")));
      expect(storedKeys(file)).toEqual(["new"]);
    });
  });

  test("keeps at most maxEntries confirmed records, dropping the oldest", async () => {
    await withStore({ maxEntries: 2 }, async ({ file, store, advance }) => {
      for (const key of ["one", "two", "three"]) {
        await store.update(identity(key), () => draft(identity(key)));
        advance(1_000);
      }
      expect(storedKeys(file)).toEqual(["two", "three"]);
    });
  });

  test("never prunes an unconfirmed attempt, even when it is the oldest", async () => {
    await withStore({ maxAgeDays: 30 }, async ({ file, store, advance }) => {
      await store.update(identity("pending"), () => draft(identity("pending"), "unconfirmed"));
      advance(31 * DAY);
      await store.update(identity("new"), () => draft(identity("new")));
      expect(storedKeys(file).sort()).toEqual(["new", "pending"]);
    });
  });

  test("a store without retention keeps every record", async () => {
    await withStore(undefined, async ({ file, store, advance }) => {
      await store.update(identity("old"), () => draft(identity("old")));
      advance(365 * DAY);
      await store.update(identity("new"), () => draft(identity("new")));
      expect(storedKeys(file).sort()).toEqual(["new", "old"]);
    });
  });

  test("prunes the existing file at startup, before any write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conversation-retention-startup-"));
    const file = join(dir, "conversations.json");
    let now = 1_000_000_000_000;
    const first = createFileConversationStore({ file, now: () => now });
    await first.update(identity("old"), () => draft(identity("old")));
    await first.close?.();

    now += 31 * DAY;
    const second = createFileConversationStore({ file, now: () => now, retention: { maxAgeDays: 30 } });
    expect(storedKeys(file)).toEqual([]);
    await second.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
});
