import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { RetainedSurfaceRegistry } from "../src/adapters/chatgpt-web/retained-surface";
import { chatGptWebChatAffinity } from "../src/adapters/chatgpt-web/web-chat-bridge";
import {
  assertCurrentWebChatGeneration,
  assertNoWebChatSecrets,
  beginWebChatConversationAttempt,
  commitWebChatConversationDraft,
  confirmWebChatConversation,
  createMemoryConversationStore,
  isWebChatInitializationCurrent,
  legacyWebChatThreadKey,
  resolveWebChatContinuation,
  validateWebChatConversationRecord,
  webChatAccountBindingId,
  webChatAffinityKey,
  webChatContinuationIdentity,
  webChatConversationHandle,
  type WebChatAccountBinding,
  type WebChatConversation,
  type WebChatConversationDraft,
  type WebChatConversationRecord,
  type WebChatConversationStore,
  type WebChatErrorCategory,
  type WebChatProviderDriver,
} from "../src/web-chat/core";
import {
  WEB_CHAT_CONVERSATION_STORE_VERSION,
  WebChatConversationStoreUnavailableError,
  createFileConversationStore,
  defaultWebChatConversationStorePath,
} from "../src/web-chat/persistence/conversation-store-file";
import type { CodexParsedRequest } from "../src/types";

/**
 * Issue #190 — conversation affinity and durable opaque continuation.
 *
 * Pins the affinity identity, the durable store and its invariants (generations, confirmed
 * checkpoints, opacity, no secrets, restart determinism) and the continuation decisions: no silent
 * fork, no silent downgrade from exact resume to replay, and a provider-driven verdict.
 *
 * The last block is migration evidence: the decisions the existing provider path makes today
 * (install vs continue, per-generation fingerprint, surface tombstone) have to be expressible, and
 * reproducible, in this layer.
 */

const BINDING: WebChatAccountBinding = {
  providerId: "chatgpt-web",
  accountFingerprint: "fp-1",
  browserProfile: "/snap/bin/chromium",
};

function identityOf(threadId = "dsh-thread-1", binding: WebChatAccountBinding = BINDING) {
  return webChatContinuationIdentity({
    binding,
    dshSession: { sessionId: "dsh-session-1" },
    threadId,
    namespace: "dsh-chatgpt-web",
  });
}

/** A driver whose every verdict is scripted, so the core's decisions are what is under test. */
function scriptedDriver(script: {
  assessment?: Awaited<ReturnType<WebChatProviderDriver["assessConversation"]>>;
  createGeneration?: number;
  replayGeneration?: number;
  failCreate?: Error;
  failReplay?: Error;
} = {}) {
  const calls = { assess: 0, create: 0, replay: 0 };
  const conversation = (generation: number, handle = `handle-${generation}`): WebChatConversation => ({
    key: identityOf().key,
    providerId: BINDING.providerId,
    bindingId: webChatAccountBindingId(BINDING),
    generation,
    handle: webChatConversationHandle(handle)!,
    status: "resumable",
  });
  const driver: WebChatProviderDriver = {
    id: "chatgpt-web",
    inspectAccount: async () => ({ authenticated: true, accountFingerprint: BINDING.accountFingerprint }),
    listModels: async () => [{ id: "model-1", label: "Model 1", text: true }],
    resolveModel: async () => ({ id: "model-1", label: "Model 1", text: true }),
    assessConversation: async () => {
      calls.assess += 1;
      return script.assessment ?? { status: "new" };
    },
    resumeConversation: async (input) => {
      const current = input.conversation;
      return current;
    },
    createConversation: async () => {
      calls.create += 1;
      if (script.failCreate) throw script.failCreate;
      return conversation(script.createGeneration ?? 1, "handle-created");
    },
    replayConversation: async () => {
      calls.replay += 1;
      if (script.failReplay) throw script.failReplay;
      return conversation(script.replayGeneration ?? 2, "handle-replayed");
    },
    health: async () => ({ ok: true }),
    shutdown: async () => {},
  };
  return { driver, calls };
}

/** A resumable, confirmed record committed through the store's own rules. */
async function seedConversation(
  store: WebChatConversationStore,
  overrides: Partial<WebChatConversationDraft> = {},
): Promise<WebChatConversationRecord> {
  const identity = identityOf();
  return store.update(identity, () => ({
    identity,
    generation: 1,
    handle: webChatConversationHandle("handle-1")!,
    status: "resumable",
    checkpoint: "confirmed",
    ...overrides,
  }));
}

describe("issue #190 — affinity identity", () => {
  test("the affinity key covers provider, binding, session and thread", () => {
    const base = { providerId: "p", bindingId: "b", dshSessionId: "s", threadId: "t" };
    const key = webChatAffinityKey(base);
    expect(key).toBe(webChatAffinityKey({ ...base }));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(webChatAffinityKey({ ...base, providerId: "other" }));
    expect(key).not.toBe(webChatAffinityKey({ ...base, bindingId: "other" }));
    expect(key).not.toBe(webChatAffinityKey({ ...base, dshSessionId: "other" }));
    expect(key).not.toBe(webChatAffinityKey({ ...base, threadId: "other" }));
    // The namespace is deployment detail, not identity: it participates without replacing any of the
    // identities above.
    expect(key).not.toBe(webChatAffinityKey({ ...base, namespace: "ns" }));
    expect(() => webChatAffinityKey({ ...base, bindingId: "" })).toThrow(/bindingId/);
    expect(() => webChatAffinityKey({ ...base, dshSessionId: "" })).toThrow(/dshSessionId/);
  });

  test("the canonical affinity key is not the legacy thread key, and the legacy digest is unchanged", () => {
    const canonical = identityOf().key;
    const legacy = legacyWebChatThreadKey("dsh-chatgpt-web", "dsh-thread-1");
    expect(canonical).not.toBe(legacy);
    // The pre-migration digest is a compatibility surface: it addresses conversations that exist.
    expect(legacyWebChatThreadKey("dsh-chatgpt-web", "dsh-111111111111111111111111"))
      .toBe("8a0c4e8311c88118483ae736970f0f57a3d63c0359bfb3427646fdd1dacd1965");
  });

  test("the account binding identity is stable, account-specific and credential-free", () => {
    const id = webChatAccountBindingId(BINDING);
    expect(id).toBe(webChatAccountBindingId({ ...BINDING }));
    expect(id).not.toBe(webChatAccountBindingId({ ...BINDING, accountFingerprint: "fp-2" }));
    expect(id).not.toBe(webChatAccountBindingId({ ...BINDING, browserProfile: "/other" }));
    expect(id).not.toBe(webChatAccountBindingId({ ...BINDING, browserContext: "/ctx" }));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(() => webChatAccountBindingId({ providerId: "", accountFingerprint: "fp" })).toThrow(/provider/);
    expect(() => webChatAccountBindingId({ providerId: "p", accountFingerprint: "" })).toThrow(/fingerprint/);
  });

  test("an affinity requires a host session identity", () => {
    expect(() => webChatContinuationIdentity({ binding: BINDING, dshSession: {}, threadId: "t" }))
      .toThrow(/host session identity/);
  });

  test("the ChatGPT path projects its turn onto the core affinity", () => {
    const parsed = {
      modelId: "gpt-5.6-luna",
      context: { systemPrompt: [], messages: [] },
      stream: false,
      options: {},
      _dshContext: { dshSessionId: "dsh-session-1", threadId: "dsh-thread-1", turnId: "turn-1" },
    } as unknown as CodexParsedRequest;
    const affinity = chatGptWebChatAffinity(parsed, {
      providerId: "chatgpt-web",
      bindingId: webChatAccountBindingId(BINDING),
      namespace: "dsh-chatgpt-web",
    });
    expect(affinity).toEqual({
      providerId: "chatgpt-web",
      bindingId: webChatAccountBindingId(BINDING),
      dshSessionId: "dsh-session-1",
      threadId: "dsh-thread-1",
      namespace: "dsh-chatgpt-web",
    });
    // The same turn resolves to the same core key, and the legacy key is untouched.
    expect(webChatAffinityKey(affinity)).toBe(identityOf("dsh-thread-1").key);
    expect(chatGptConversationKey(parsed, "dsh-chatgpt-web")).toBe(legacyWebChatThreadKey("dsh-chatgpt-web", "dsh-thread-1"));
    // A turn without a host session cannot be projected onto an affinity.
    const withoutSession = {
      modelId: "gpt-5.6-luna",
      context: { systemPrompt: [], messages: [] },
      stream: false,
      options: {},
      _dshContext: { threadId: "dsh-thread-1", turnId: "turn-1" },
    } as unknown as CodexParsedRequest;
    expect(() => chatGptWebChatAffinity(withoutSession, {
      providerId: "chatgpt-web",
      bindingId: "b",
      namespace: "dsh-chatgpt-web",
    })).toThrow(/host session identity/);
  });
});

describe("issue #190 — the durable record and its invariants", () => {
  test("a record keeps its affinity, owns revision/timestamps and advances", async () => {
    let clock = 1_000;
    const store = createMemoryConversationStore({ now: () => (clock += 1) });
    const first = await seedConversation(store);
    expect(first.revision).toBe(1);
    expect(first.createdAt).toBe(1_001);
    expect(first.updatedAt).toBe(first.createdAt);

    const second = await store.update(first.identity, (current) => ({ ...(current as WebChatConversationDraft) }));
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(1_002);
    expect(await store.read(first.identity)).toEqual(second);
    expect(await store.list()).toHaveLength(1);
    expect(await store.forget(first.identity)).toBe(true);
    expect(await store.read(first.identity)).toBeUndefined();
  });

  test("affinities are isolated: different provider, binding, session or thread never share a record", async () => {
    const store = createMemoryConversationStore();
    await seedConversation(store);
    const other = identityOf("dsh-thread-2");
    expect(await store.read(other)).toBeUndefined();
    const otherBinding = webChatContinuationIdentity({
      binding: { ...BINDING, accountFingerprint: "fp-2" },
      dshSession: { sessionId: "dsh-session-1" },
      threadId: "dsh-thread-1",
    });
    expect(await store.read(otherBinding)).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });

  test("concurrent updates of one affinity are serialized, so no update is lost", async () => {
    const store = createMemoryConversationStore();
    const identity = identityOf();
    await store.update(identity, () => ({
      identity,
      generation: 1,
      status: "resumable",
      checkpoint: "confirmed",
      handle: webChatConversationHandle("handle-1")!,
    }));
    await Promise.all(Array.from({ length: 50 }, async (_value, index) => store.update(identity, (current) => ({
      ...(current as WebChatConversationDraft),
      lastConfirmedTurn: { turnId: `turn-${index}`, at: index },
    }))));
    const record = await store.read(identity);
    expect(record?.revision).toBe(51);
  });

  test("a record may not change its own identity, move the generation backwards or lie about its checkpoint", async () => {
    const store = createMemoryConversationStore();
    const identity = identityOf();
    expect(() => commitWebChatConversationDraft(identity, undefined, {
      identity: { ...identity, key: "other" },
      generation: 1,
      status: "new",
      checkpoint: "confirmed",
    }, 0)).toThrow(/may not change its own affinity/);

    const record = await seedConversation(store);
    expect(() => commitWebChatConversationDraft(identity, record, {
      identity,
      generation: 0,
      status: "resumable",
      checkpoint: "confirmed",
    }, 0)).toThrow(/positive safe integer/);
    expect(() => commitWebChatConversationDraft(identity, { ...record, generation: 3 }, {
      identity,
      generation: 2,
      status: "resumable",
      checkpoint: "confirmed",
    }, 0)).toThrow(/cannot move backwards/);
    expect(() => commitWebChatConversationDraft(identity, record, {
      identity,
      generation: 2,
      status: "new",
      checkpoint: "confirmed",
      initialization: { generation: 1, fingerprint: "fp" },
    }, 0)).toThrow(/belongs to the generation/);
    expect(() => commitWebChatConversationDraft(identity, record, {
      identity,
      generation: 1,
      status: "new",
      checkpoint: "confirmed",
      page: {},
    } as unknown as WebChatConversationDraft, 0)).toThrow(/no "page" field/);
  });

  test("an unconfirmed attempt is never resumable, and a stale settlement is refused", async () => {
    const store = createMemoryConversationStore();
    const record = await seedConversation(store);
    const attempted = await beginWebChatConversationAttempt(store, record.identity, { generation: 1 });
    expect(attempted.checkpoint).toBe("unconfirmed");
    // The status still records what the driver established; only the checkpoint marks the state as
    // not yet authoritative.
    expect(attempted.status).toBe("resumable");
    expect(attempted.handle as string | undefined).toBe("handle-1");

    // The conversation is replaced by a replay while the attempt is still in flight.
    await store.update(record.identity, () => ({
      ...attempted,
      generation: 2,
      status: "resumable",
      checkpoint: "confirmed",
    }));
    await expect(confirmWebChatConversation(store, record.identity, { generation: 1, turnId: "turn-1", at: 5 }))
      .rejects.toThrow(/Cannot confirm generation 1/);
    await expect(beginWebChatConversationAttempt(store, record.identity, { generation: 1 }))
      .rejects.toThrow(/Cannot attempt generation 1/);

    const confirmed = await confirmWebChatConversation(store, record.identity, { generation: 2, turnId: "turn-2", at: 6 });
    expect(confirmed.checkpoint).toBe("confirmed");
    expect(confirmed.lastConfirmedTurn).toEqual({ turnId: "turn-2", at: 6 });
    expect(confirmed.status).toBe("resumable");
  });

  test("a stale generation is refused", async () => {
    const store = createMemoryConversationStore();
    const record = await seedConversation(store, { generation: 2 });
    expect(() => assertCurrentWebChatGeneration(record, 1)).toThrow(/is stale/);
    expect(() => assertCurrentWebChatGeneration(record, 2)).not.toThrow();
  });

  test("initialization state is current only for the generation it was installed in", async () => {
    const store = createMemoryConversationStore();
    const record = await seedConversation(store, { initialization: { generation: 1, fingerprint: "fp-system" } });
    expect(isWebChatInitializationCurrent(record, 1, "fp-system")).toBe(true);
    expect(isWebChatInitializationCurrent(record, 2, "fp-system")).toBe(false);
    expect(isWebChatInitializationCurrent(record, 1, "other")).toBe(false);
    expect(isWebChatInitializationCurrent({ ...record, initialization: undefined }, 1, "fp-system")).toBe(false);
  });

  test("authentication material is never stored, and an opaque handle is never inspected", async () => {
    const store = createMemoryConversationStore();
    const identity = identityOf();
    await expect(store.update(identity, () => ({
      identity,
      generation: 1,
      status: "new",
      checkpoint: "confirmed",
      cookie: "session=1",
    } as unknown as WebChatConversationDraft))).rejects.toThrow(/authentication material/);
    expect(() => assertNoWebChatSecrets({ checkpoint: "confirmed", providerDetail: { authorization: "Bearer abc12345678" } }))
      .toThrow(/authentication material/);

    // The handle is opaque provider state: the core stores it verbatim and never judges its contents.
    const opaque = "provider:private:{cookie:1}:42";
    const record = await store.update(identity, () => ({
      identity,
      generation: 1,
      status: "resumable",
      checkpoint: "confirmed",
      handle: webChatConversationHandle(opaque)!,
    }));
    expect(record.handle as string | undefined).toBe(opaque);
    expect((await store.read(identity))?.handle as string | undefined).toBe(opaque);
  });
});

describe("issue #190 — durable file backend", () => {
  function withTempDir(run: (file: string) => void | Promise<void>): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "web-chat-store-"));
    return Promise.resolve(run(join(directory, "conversations.json")))
      .finally(() => rmSync(directory, { recursive: true, force: true }));
  }

  test("a restarted runtime reads the same conversation back", async () => {
    await withTempDir(async (file) => {
      const identity = identityOf();
      const first = createFileConversationStore({ file, now: () => 111 });
      const written = await seedConversation(first, { initialization: { generation: 1, fingerprint: "fp-system" } });
      expect(written.revision).toBe(1);

      // A second store instance is a restarted runtime: no shared memory, same durable state.
      const second = createFileConversationStore({ file, now: () => 222 });
      const readBack = await second.read(identity);
      expect(readBack).toEqual(written);
      expect(readBack?.handle as string | undefined).toBe("handle-1");
      expect(readBack?.generation).toBe(1);
      expect(readBack?.checkpoint).toBe("confirmed");
      expect(await second.list()).toHaveLength(1);

      // The durable document is a versioned record list, and carries no transcript.
      const document = JSON.parse(readFileSync(file, "utf8")) as { version: number; records: unknown[] };
      expect(document.version).toBe(WEB_CHAT_CONVERSATION_STORE_VERSION);
      expect(document.records).toHaveLength(1);
      expect(JSON.stringify(document)).not.toContain("messages");
    });
  });

  test("an unrecorded affinity is absent, not invented", async () => {
    await withTempDir(async (file) => {
      const store = createFileConversationStore({ file });
      expect(await store.read(identityOf("never-seen"))).toBeUndefined();
      expect(await store.list()).toEqual([]);
    });
  });

  test("a corrupt, unknown-version or invalid store fails explicitly instead of reading as empty", async () => {
    await withTempDir(async (file) => {
      const store = createFileConversationStore({ file });
      writeFileSync(file, "{not json");
      await expect(store.read(identityOf())).rejects.toThrow(WebChatConversationStoreUnavailableError);
      await expect(store.list()).rejects.toThrow(/not valid JSON/);

      writeFileSync(file, JSON.stringify({ version: 99, records: [] }));
      await expect(store.list()).rejects.toThrow(/schema version 99 is not supported/);

      writeFileSync(file, JSON.stringify({
        version: WEB_CHAT_CONVERSATION_STORE_VERSION,
        records: [{ identity: { providerId: "p", bindingId: "b", key: "k" }, generation: 1, status: "new", checkpoint: "confirmed", revision: 1, createdAt: 1, updatedAt: 1, storageState: "/tmp/x" }],
      }));
      await expect(store.list()).rejects.toThrow(/authentication material/);
    });
  });

  test("the file backend applies the same invariants and serializes its writers", async () => {
    await withTempDir(async (file) => {
      const store = createFileConversationStore({ file });
      const identity = identityOf();
      await seedConversation(store);
      await Promise.all(Array.from({ length: 20 }, async (_value, index) => store.update(identity, (current) => ({
        ...(current as WebChatConversationDraft),
        lastConfirmedTurn: { turnId: `turn-${index}`, at: index },
      }))));
      expect((await store.read(identity))?.revision).toBe(21);
      await expect(store.update(identity, () => ({
        identity,
        generation: 1,
        status: "new",
        checkpoint: "confirmed",
        token: "abc",
      } as unknown as WebChatConversationDraft))).rejects.toThrow(/authentication material/);
      expect(await store.forget(identity)).toBe(true);
      expect(await store.forget(identity)).toBe(false);
    });
  });

  test("the default durable location is inside the plugin storage directory", () => {
    expect(defaultWebChatConversationStorePath()).toContain("conversations.json");
    expect(defaultWebChatConversationStorePath()).toContain("web-chat");
  });

  test("a validated read refuses a record it cannot vouch for", async () => {
    expect(() => validateWebChatConversationRecord({ identity: { providerId: "p", bindingId: "b", key: "k" }, generation: 1, status: "new", checkpoint: "confirmed", revision: 0, createdAt: 1, updatedAt: 1 }))
      .toThrow(/no usable revision/);
    expect(() => validateWebChatConversationRecord({ generation: 1 })).toThrow(/no affinity identity/);
    const valid = await seedConversation(createMemoryConversationStore());
    expect(validateWebChatConversationRecord(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });
});

describe("issue #190 — continuation decisions", () => {
  const request = (overrides: Partial<Parameters<typeof resolveWebChatContinuation>[1]> = {}) => ({
    binding: BINDING,
    dshSession: { sessionId: "dsh-session-1" },
    threadId: "dsh-thread-1",
    namespace: "dsh-chatgpt-web",
    model: "model-1",
    intent: { kind: "continue" } as const,
    ...overrides,
  });

  test("a fresh affinity creates its first conversation, explicitly", async () => {
    const store = createMemoryConversationStore();
    const { driver, calls } = scriptedDriver({ assessment: { status: "new" }, createGeneration: 1 });
    const plan = await resolveWebChatContinuation({ store, driver }, request());
    expect(plan.outcome).toBe("new_conversation");
    expect(plan.conversation?.generation).toBe(1);
    expect(plan.record?.checkpoint).toBe("confirmed");
    expect(calls).toEqual({ assess: 1, create: 1, replay: 0 });
  });

  test("a confirmed resumable conversation continues with the same generation and handle", async () => {
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store);
    const { driver, calls } = scriptedDriver({ assessment: { status: "resumable" } });
    const plan = await resolveWebChatContinuation({ store, driver }, request());
    expect(plan.outcome).toBe("exact_resume");
    expect(plan.conversation?.generation).toBe(seeded.generation);
    expect(plan.conversation?.handle as string | undefined).toBe("handle-1");
    expect(calls).toEqual({ assess: 1, create: 0, replay: 0 });
    expect((await store.read(seeded.identity))?.generation).toBe(1);
  });

  test("a lost conversation fails explicitly and is never replaced silently", async () => {
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store, { status: "lost" });
    const { driver, calls } = scriptedDriver({ assessment: { status: "lost", reason: "the surface died" } });
    const plan = await resolveWebChatContinuation({ store, driver }, request());
    expect(plan.outcome).toBe("failed");
    expect(plan.error?.category).toBe("CONVERSATION_LOST");
    expect(plan.reason).toContain("surface died");
    // Nothing was created, and the record is untouched: a lost conversation stays explicit.
    expect(calls.create).toBe(0);
    const after = await store.read(seeded.identity);
    expect(after?.generation).toBe(1);
  });

  test("replay-required, unsupported and unknown state are explicit failures", async () => {
    const cases: Array<[{ status: "replay_required" | "unsupported" | "unreachable" }, WebChatErrorCategory]> = [
      [{ status: "replay_required" }, "CONVERSATION_STATE_MISMATCH"],
      [{ status: "unsupported" }, "UNSUPPORTED_OPTION"],
      [{ status: "unreachable" }, "TRANSPORT_UNAVAILABLE"],
    ];
    for (const [assessment, category] of cases) {
      const store = createMemoryConversationStore();
      await seedConversation(store);
      const { driver, calls } = scriptedDriver({ assessment });
      const plan = await resolveWebChatContinuation({ store, driver }, request());
      expect(plan.outcome).toBe("failed");
      expect(plan.error?.category).toBe(category);
      expect(calls.create).toBe(0);
      expect(calls.replay).toBe(0);
    }
  });

  test("exact resume never degrades into replay or a new conversation", async () => {
    const store = createMemoryConversationStore();
    await seedConversation(store);
    const { driver } = scriptedDriver({ assessment: { status: "replay_required" } });
    // The intent is a continuation: even though the provider wants a replay, the core refuses and
    // requires the caller to decide explicitly.
    const plan = await resolveWebChatContinuation({ store, driver }, request());
    expect(plan.outcome).toBe("failed");
    expect(plan.outcome).not.toBe("replay");
    expect(plan.outcome).not.toBe("new_conversation");
  });

  test("an unconfirmed attempt is not resumable until the driver reconciles it", async () => {
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store);
    await beginWebChatConversationAttempt(store, seeded.identity, { generation: 1 });

    // The provider says it can continue but hands back nothing that proves it.
    const failed = await resolveWebChatContinuation({ store, driver: scriptedDriver({ assessment: { status: "resumable" } }).driver }, request());
    expect(failed.outcome).toBe("failed");
    expect(failed.error?.category).toBe("CONVERSATION_STATE_MISMATCH");

    // The driver reconciles it explicitly by handing the conversation back.
    const reconciled = scriptedDriver({
      assessment: { status: "resumable", reason: "found the remote conversation", conversation: {
        key: seeded.identity.key,
        providerId: seeded.identity.providerId,
        bindingId: seeded.identity.bindingId,
        generation: 1,
        handle: webChatConversationHandle("handle-1")!,
        status: "resumable",
      } },
    });
    const plan = await resolveWebChatContinuation({ store, driver: reconciled.driver }, request());
    expect(plan.outcome).toBe("exact_resume");
    expect(plan.reason).toContain("reconciled");
    expect((await store.read(seeded.identity))?.checkpoint).toBe("confirmed");
  });

  test("an unrecorded affinity is never turned into a conversation on a resumable claim", async () => {
    const store = createMemoryConversationStore();
    const { driver, calls } = scriptedDriver({ assessment: { status: "resumable" } });
    const plan = await resolveWebChatContinuation({ store, driver }, request());
    expect(plan.outcome).toBe("failed");
    expect(plan.error?.category).toBe("CONVERSATION_STATE_MISMATCH");
    expect(calls.create).toBe(0);
  });

  test("a stale expected generation is refused before the driver is consulted", async () => {
    const store = createMemoryConversationStore();
    await seedConversation(store, { generation: 2 });
    const { driver, calls } = scriptedDriver({ assessment: { status: "resumable" } });
    const plan = await resolveWebChatContinuation({ store, driver }, request({ expectedGeneration: 1 }));
    expect(plan.outcome).toBe("failed");
    expect(plan.error?.category).toBe("CONVERSATION_STATE_MISMATCH");
    expect(calls.assess).toBe(0);
  });

  test("an explicit new conversation advances the generation, and only after the driver confirms it", async () => {
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store);
    const { driver } = scriptedDriver({ assessment: { status: "lost" }, createGeneration: 2 });
    const plan = await resolveWebChatContinuation({ store, driver }, request({
      intent: { kind: "new_conversation", reason: "the user asked for a fresh conversation" },
    }));
    expect(plan.outcome).toBe("new_conversation");
    expect(plan.conversation?.generation).toBe(2);
    expect(plan.conversation?.handle as string | undefined).toBe("handle-created");
    expect((await store.read(seeded.identity))?.generation).toBe(2);

    // A driver that does not advance the generation is refused, and the record is untouched.
    const failing = scriptedDriver({ assessment: { status: "lost" }, createGeneration: 2 });
    const refused = await resolveWebChatContinuation({ store, driver: failing.driver }, request({
      intent: { kind: "new_conversation", reason: "again" },
    }));
    expect(refused.outcome).toBe("failed");
    expect(refused.reason).toContain("must advance the generation");
    expect((await store.read(seeded.identity))?.generation).toBe(2);
  });

  test("replay is explicit, rebuilds from canonical history, and refuses an empty history", async () => {
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store, { status: "lost" });
    const history = [
      { role: "user" as const, text: "arregla el bug" },
      { role: "assistant" as const, text: "hecho" },
    ];
    const { driver, calls } = scriptedDriver({ assessment: { status: "lost" }, replayGeneration: 2 });
    const plan = await resolveWebChatContinuation({ store, driver }, request({
      intent: { kind: "replay", reason: "continuity was lost", history },
    }));
    expect(plan.outcome).toBe("replay");
    expect(plan.conversation?.generation).toBe(2);
    expect(plan.conversation?.handle as string | undefined).toBe("handle-replayed");
    expect(calls.replay).toBe(1);

    const beforeEmpty = await store.read(seeded.identity);
    const empty = scriptedDriver({ assessment: { status: "lost" } });
    const refused = await resolveWebChatContinuation({ store, driver: empty.driver }, request({
      intent: { kind: "replay", reason: "nothing to rebuild from", history: [] },
    }));
    expect(refused.outcome).toBe("failed");
    expect(refused.error?.category).toBe("CONVERSATION_STATE_MISMATCH");
    expect(empty.calls.replay).toBe(0);
    expect(await store.read(seeded.identity)).toEqual(beforeEmpty);
  });

  test("a driver failure leaves the stored continuity exactly as it was", async () => {
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store, { status: "lost" });
    const { driver } = scriptedDriver({ assessment: { status: "lost" }, failReplay: new Error("provider refused") });
    await expect(resolveWebChatContinuation({ store, driver }, request({
      intent: { kind: "replay", reason: "retry", history: [{ role: "user", text: "hi" }] },
    }))).rejects.toThrow(/provider refused/);
    const after = await store.read(seeded.identity);
    expect(after?.generation).toBe(1);
    expect(after?.handle as string | undefined).toBe("handle-1");
  });
});

describe("issue #190 — migration evidence from the current provider path", () => {
  test("install vs continue maps onto replay vs exact resume", async () => {
    // The existing path installs its initialization state per generation: no recorded fingerprint
    // for the generation means the conversation has to be rebuilt, a recorded one means it continues.
    const store = createMemoryConversationStore();
    const seeded = await seedConversation(store, { initialization: { generation: 1, fingerprint: "fp-system" } });
    const recorded = await store.read(seeded.identity);
    expect(isWebChatInitializationCurrent(recorded as WebChatConversationRecord, 1, "fp-system")).toBe(true);
    expect(isWebChatInitializationCurrent(recorded as WebChatConversationRecord, 2, "fp-system")).toBe(false);

    const { driver } = scriptedDriver({ assessment: { status: "resumable" } });
    const resume = await resolveWebChatContinuation({ store, driver }, {
      binding: BINDING,
      dshSession: { sessionId: "dsh-session-1" },
      threadId: "dsh-thread-1",
      namespace: "dsh-chatgpt-web",
      model: "model-1",
      intent: { kind: "continue" },
    });
    expect(resume.outcome).toBe("exact_resume");
    expect(resume.conversation?.generation).toBe(1);

    const replaced = scriptedDriver({ assessment: { status: "replay_required" }, replayGeneration: 2 });
    const replay = await resolveWebChatContinuation({ store, driver: replaced.driver }, {
      binding: BINDING,
      dshSession: { sessionId: "dsh-session-1" },
      threadId: "dsh-thread-1",
      namespace: "dsh-chatgpt-web",
      model: "model-1",
      intent: { kind: "replay", reason: "the installed initialization state no longer applies", history: [{ role: "user", text: "hi" }] },
    });
    expect(replay.outcome).toBe("replay");
    expect(replay.conversation?.generation).toBe(2);
  });

  test("a tombstoned physical surface is a continuity loss, exactly like a lost record", async () => {
    interface FakePage { closed: boolean; isClosed(): boolean; close(): Promise<void> }
    const registry = new RetainedSurfaceRegistry<FakePage>();
    const page: FakePage = { closed: false, isClosed: () => page.closed, close: async () => { page.closed = true; } };
    const acquired = await registry.acquire("conversation-key", {
      create: async () => page,
      required: false,
    });
    expect(acquired.created).toBe(true);
    registry.release("conversation-key");
    page.closed = true;

    // The physical surface dies: continuity is tombstoned, and a second acquire refuses instead of
    // silently creating a replacement.
    await expect(registry.acquire("conversation-key", { create: async () => page, required: false }))
      .rejects.toThrow(/lost/i);
    expect(registry.isLost("conversation-key")).toBe(true);

    // The core's decision for a lost record is the same refusal, and only an explicit recovery
    // clears it.
    const store = createMemoryConversationStore();
    await seedConversation(store, { status: "lost" });
    const { driver, calls } = scriptedDriver({ assessment: { status: "lost" } });
    const plan = await resolveWebChatContinuation({ store, driver }, {
      binding: BINDING,
      dshSession: { sessionId: "dsh-session-1" },
      threadId: "dsh-thread-1",
      namespace: "dsh-chatgpt-web",
      model: "model-1",
      intent: { kind: "continue" },
    });
    expect(plan.outcome).toBe("failed");
    expect(calls.create).toBe(0);

    registry.reset("conversation-key");
    expect(registry.isLost("conversation-key")).toBe(false);
  });
});
