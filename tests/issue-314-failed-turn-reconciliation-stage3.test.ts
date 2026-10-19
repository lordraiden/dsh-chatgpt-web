import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CHATGPT_RETAINED_SURFACE_LOST_CODE,
  chatGptContinuationPromptMissingError,
  chatGptRetainedSurfaceLostError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  RetainedSurfaceLostError,
  RetainedSurfaceRegistry,
  retainedSurfaceSettlementForTurn,
  type RetainedSurfacePage,
} from "../src/adapters/chatgpt-web/retained-surface";
import {
  chatGptAttemptReplyPresent,
  reconcileRetainedConversation,
  type ChatGptRetainedAttempt,
  type ChatGptRetainedInspection,
} from "../src/adapters/chatgpt-web/retained-coherence";
import {
  chatGptWebConversationHandle,
  createChatGptWebDriver,
} from "../src/adapters/chatgpt-web/chatgpt-driver";
import {
  chatGptWebExecutionNamespace,
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import { ChatGptTurnSessions, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import {
  ChatGptWebSurfaceTransport,
  type WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { translateChatCompletionsRequest } from "../src/responses/chat-completions";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";
import {
  beginWebChatConversationAttempt,
  confirmWebChatConversation,
  createMemoryConversationStore,
  resolveWebChatContinuation,
  webChatAccountBindingId,
  webChatAffinityKey,
  type WebChatAccountBinding,
  type WebChatConversationStore,
} from "../src/web-chat/core";
import { CHATGPT_WEB_DRIVER_ID as CHATGPT_WEB_PROVIDER_ID } from "../src/web-chat/host/provider-host";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import { controlledIncoming, controlledProviderConfig } from "./support/chatgpt-web-surface";

/**
 * Issue #314, stage 3 — adopt a reply that already exists.
 *
 * The measured remaining case: after a turn fails *after* its submission was accepted, in a
 * conversation whose initialization is already installed (an *established* conversation), the next
 * turn is still refused by the WebChat Core — `CONVERSATION_STATE_MISMATCH`, "the last attempt on
 * this conversation was never confirmed; the provider must reconcile it before it can be resumed"
 * (#190). Stage 2 fixed the surface layer; this refusal happens earlier and needs a provider verdict.
 *
 * The approved rule, in code terms:
 *
 * - the provider reconciles an unconfirmed attempt **structurally**, from the retained
 *   conversation's own turn structure and its record of the attempt — never from the caller's text,
 *   never from a timer, never from "the page is alive";
 * - when the reply the failed attempt produced **is** physically present and finalized, the Core
 *   re-confirms the record as it stands and the next turn continues the **same** conversation:
 *   `exact_resume`, nothing resent;
 * - when it cannot be proven, the turn keeps failing closed with the existing honest category and
 *   message, and the conversation is **retired** with the distinguishable loss reason instead of
 *   being carried forever;
 * - a retained page that is gone is a **continuity error** with the `surface-dead` reason;
 * - the failure's **phase** decides the surface mark (stage 1, `#317`): a failure that never reached the
 *   provider is an ordinary retry and marks nothing, while a confirmed submission is marked and
 *   reconciled — the verdict below reads the same structural fact (the attempt record);
 * - the seam receives **state** (the conversation key), so no caller text can even reach it.
 *
 * The first blocks are browser-free and drive the real rule, the real retained-surface owner and the
 * real core seam. The last block drives the **real adapter route** with only the browser I/O
 * replaced, and it is the one that fails against the current tree for the right reason.
 */

const KEY_SESSION = "harness-session-314-stage3";
const MODEL = "chatgpt-web/luna";

// ---------------------------------------------------------------------------
// The rule: turn structure, never text
// ---------------------------------------------------------------------------

const ATTEMPT: ChatGptRetainedAttempt = {
  userTurns: ["conversation-turn-user-1"],
  responseTurns: ["conversation-turn-assistant-1"],
};

describe("issue #314 stage 3 — the verdict is structural", () => {
  test("the failed attempt's reply is proven by structure: the conversation gained a finalized answer", () => {
    expect(chatGptAttemptReplyPresent({
      attempt: ATTEMPT,
      state: {
        userTurns: [...ATTEMPT.userTurns, "conversation-turn-user-2"],
        responseTurns: [...ATTEMPT.responseTurns, "conversation-turn-assistant-2"],
        generationRunning: false,
      },
      replyFinalized: true,
    })).toBe(true);
  });

  test("a conversation that did not move proves nothing about a reply", () => {
    expect(chatGptAttemptReplyPresent({
      attempt: ATTEMPT,
      state: {
        userTurns: [...ATTEMPT.userTurns],
        responseTurns: [...ATTEMPT.responseTurns],
        generationRunning: false,
      },
      replyFinalized: true,
    })).toBe(false);
  });

  test("a reply that is still being generated, or one that is not finalized, is not the attempt's outcome", () => {
    const state = {
      userTurns: [...ATTEMPT.userTurns, "conversation-turn-user-2"],
      responseTurns: [...ATTEMPT.responseTurns, "conversation-turn-assistant-2"],
    };
    expect(chatGptAttemptReplyPresent({
      attempt: ATTEMPT,
      state: { ...state, generationRunning: true },
      replyFinalized: true,
    })).toBe(false);
    expect(chatGptAttemptReplyPresent({
      attempt: ATTEMPT,
      state: { ...state, generationRunning: false },
      replyFinalized: false,
    })).toBe(false);
  });

  test("a replaced conversation is never coherent merely because it holds a reply", () => {
    // The whole turn structure was swapped: the turns the attempt recorded are gone. Holding *a*
    // completed answer is not proof that it is this conversation's answer.
    expect(chatGptAttemptReplyPresent({
      attempt: ATTEMPT,
      state: {
        userTurns: ["conversation-turn-user-9"],
        responseTurns: ["conversation-turn-assistant-9"],
        generationRunning: false,
      },
      replyFinalized: true,
    })).toBe(false);
  });

  test("the rule never reads message content: only turn identity sets and flags reach it", () => {
    // The verdict's whole input is asserted here structurally: any text that reached it would have
    // to arrive through a turn identity or through the finalization flag, and neither carries it.
    const input = {
      attempt: ATTEMPT,
      state: {
        userTurns: [...ATTEMPT.userTurns],
        responseTurns: [...ATTEMPT.responseTurns, "conversation-turn-assistant-2"],
        generationRunning: false,
      },
      replyFinalized: true,
    };
    expect(Object.keys(input).sort()).toEqual(["attempt", "replyFinalized", "state"]);
    expect(Object.keys(input.state).sort()).toEqual(["generationRunning", "responseTurns", "userTurns"]);
    expect(chatGptAttemptReplyPresent(input)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The verdict over the real retained-surface owner
// ---------------------------------------------------------------------------

interface FakePage extends RetainedSurfacePage {
  closeCount: number;
}

function fakePage(): FakePage {
  let closed = false;
  const page: FakePage = {
    closeCount: 0,
    isClosed: () => closed,
    close: async () => {
      closed = true;
      page.closeCount += 1;
    },
  };
  return page;
}

function syntheticInspection(
  state: { userTurns: readonly string[]; responseTurns: readonly string[]; generationRunning?: boolean },
  replyFinalized = true,
): ChatGptRetainedInspection {
  return {
    kind: "read",
    state: { generationRunning: false, ...state },
    replyFinalized,
  };
}

describe("issue #314 stage 3 — the reconciliation verdict and the surface's fate", () => {
  test("a recorded attempt whose reply is present is reconciled, and the surface stays exactly where it is", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const page = fakePage();
    const key = "key-stage3-reconciled";
    await registry.acquire(key, { required: false, create: async () => page });
    registry.recordAttempt(key, { userTurns: [], responseTurns: [] });
    registry.release(key);
    registry.settle(key, "unreconciled");

    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: key,
      inspect: async () => syntheticInspection({
        userTurns: ["conversation-turn-user-1"],
        responseTurns: ["conversation-turn-assistant-1"],
      }),
    });

    expect(verdict).toEqual({
      kind: "reconciled",
      reason: "the retained conversation holds the failed attempt's reply",
    });
    expect(registry.has(key)).toBe(true);
    expect(registry.isLost(key)).toBe(false);
    expect(page.isClosed()).toBe(false);
    expect(page.closeCount).toBe(0);
  });

  test("a conversation that was never submitted to is reconciled without any reply: nothing reached the provider", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const page = fakePage();
    const key = "key-stage3-untouched";
    await registry.acquire(key, { required: false, create: async () => page });
    registry.release(key);
    registry.settle(key, "unreconciled");

    // No attempt was ever recorded for this surface: the failure happened before any send reached
    // ChatGPT, so the conversation is untouched and resuming it resends nothing.
    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: key,
      inspect: async () => {
        throw new Error("the conversation must not even be read");
      },
    });
    expect(verdict.kind).toBe("reconciled");
    expect(registry.isLost(key)).toBe(false);
    expect(page.isClosed()).toBe(false);
  });

  test("an attempt whose reply cannot be attributed retires the conversation with the reconciliation-exhausted reason", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const page = fakePage();
    const key = "key-stage3-unprovable";
    await registry.acquire(key, { required: false, create: async () => page });
    registry.recordAttempt(key, { userTurns: [], responseTurns: [] });
    registry.release(key);
    registry.settle(key, "unreconciled");

    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: key,
      // The prompt landed, but the conversation produced no answer this provider can attribute.
      inspect: async () => syntheticInspection({ userTurns: ["conversation-turn-user-1"], responseTurns: [] }),
    });

    expect(verdict.kind).toBe("unprovable");
    expect(registry.isLost(key)).toBe(true);
    expect(registry.has(key)).toBe(false);
    expect(registry.needsReconciliation(key)).toBe(false);
    expect(page.isClosed()).toBe(true);
    expect(page.closeCount).toBe(1);
  });

  test("a page that is gone is a continuity loss with the surface-dead reason, and no replacement is created", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const page = fakePage();
    const key = "key-stage3-dead";
    await registry.acquire(key, { required: false, create: async () => page });
    registry.recordAttempt(key, { userTurns: [], responseTurns: [] });
    registry.release(key);
    registry.settle(key, "unreconciled");
    page.closeCount = 0;

    // The page dies after the failed turn: that is proof of death, so reconciliation does not guess.
    await page.close();
    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: key,
      inspect: async () => {
        throw new Error("a closed page is never read");
      },
    });
    expect(verdict).toEqual({ kind: "lost", reason: "surface-dead" });
    expect(registry.isLost(key)).toBe(true);
    expect(registry.needsReconciliation(key)).toBe(false);

    // The caller's continuity error is the existing honest one, with the distinguishable reason.
    const mapped = chatGptRetainedSurfaceLostError(
      verdict.kind === "lost" ? verdict.reason : undefined,
    );
    expect(mapped.code).toBe(CHATGPT_RETAINED_SURFACE_LOST_CODE);
    expect(mapped.status).toBe(409);
    expect(mapped.message).toContain("surface-dead");

    // Retired means retired: the next acquire stays a continuity loss, and nothing was created.
    await expect(registry.acquire(key, { required: false, create: async () => fakePage() }))
      .rejects.toBeInstanceOf(RetainedSurfaceLostError);
  });

  test("a page a turn still owns is never read and never retired by reconciliation", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const page = fakePage();
    const key = "key-stage3-busy";
    await registry.acquire(key, { required: false, create: async () => page });
    registry.recordAttempt(key, { userTurns: [], responseTurns: [] });
    // A turn holds it: the surface is not idle.
    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: key,
      inspect: async () => {
        throw new Error("a page another turn owns is never read");
      },
    });
    expect(verdict).toEqual({
      kind: "unprovable",
      reason: "the retained conversation is not idle and could not be inspected",
    });
    expect(registry.isLost(key)).toBe(false);
    expect(page.isClosed()).toBe(false);
  });

  test("a key this process never retained is not declared lost: it keeps failing closed", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: "key-stage3-absent",
      inspect: async () => {
        throw new Error("there is no surface to read");
      },
    });
    // A restart, or a deployment whose conversations live in another process, has no retained surface
    // here — and that absence is not proof that the provider's conversation is gone.
    expect(verdict).toEqual({
      kind: "unprovable",
      reason: "this process has no retained conversation to reconcile",
    });
  });

  test("a retired key is a continuity loss, never left unreconciled", async () => {
    const registry = new RetainedSurfaceRegistry<FakePage, ChatGptRetainedAttempt>();
    const page = fakePage();
    const key = "key-stage3-retired";
    await registry.acquire(key, { required: false, create: async () => page });
    registry.release(key);
    registry.settle(key, "rejected");
    expect(registry.isLost(key)).toBe(true);

    const verdict = await reconcileRetainedConversation({
      registry,
      conversationKey: key,
      inspect: async () => {
        throw new Error("a retired key has no page to read");
      },
    });
    // The tombstone records only that continuity is broken, so no invented reason is attached.
    expect(verdict).toEqual({ kind: "lost" });
  });
});

// ---------------------------------------------------------------------------
// The core seam
// ---------------------------------------------------------------------------

const CORR_PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-stage3",
    browserInteractionMode: "managed",
    browserHost: "managed-chrome",
    solAvailable: false,
    proAvailable: false,
    capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

const CORR_BINDING: WebChatAccountBinding = {
  providerId: CHATGPT_WEB_PROVIDER_ID,
  accountFingerprint: "account-stage3",
  browserProfile: "managed-chrome",
  browserContext: "default-context",
};

/** The affinity and identity the native path derives for one chat. */
function coreScope(threadId = "dsh-thread-stage3") {
  return {
    binding: CORR_BINDING,
    dshSession: { sessionId: "session-stage3" },
    threadId,
    namespace: chatGptWebExecutionNamespace(CORR_PROVIDER),
    model: MODEL,
  };
}

function coreIdentity(threadId = "dsh-thread-stage3") {
  const scope = coreScope(threadId);
  return {
    providerId: CHATGPT_WEB_PROVIDER_ID,
    bindingId: webChatAccountBindingId(CORR_BINDING),
    key: webChatAffinityKey({
      providerId: CHATGPT_WEB_PROVIDER_ID,
      bindingId: webChatAccountBindingId(CORR_BINDING),
      dshSessionId: "session-stage3",
      threadId,
      namespace: scope.namespace,
    }),
  };
}

/**
 * Seed the store and the provider with an *established* conversation — its initialization
 * fingerprint is installed — whose last attempt a failed turn left unconfirmed, exactly as the
 * measured case leaves it.
 */
async function seedUnconfirmedConversation(
  store: WebChatConversationStore,
  sessions: ChatGptTurnSessions,
  threadId = "dsh-thread-stage3",
) {
  const identity = coreIdentity(threadId);
  const handle = chatGptWebConversationHandle(identity.key, 1);
  const seeded = await store.update(identity, () => ({
    identity,
    generation: 1,
    handle,
    status: "resumable",
    checkpoint: "confirmed",
    initialization: { generation: 1, fingerprint: "fp-installed" },
    lastConfirmedTurn: { turnId: "turn-1", at: 11 },
  }));
  sessions.recordSentSystemFingerprint(identity.key, 1, "installed-fingerprint");
  await beginWebChatConversationAttempt(store, identity, { generation: 1 });
  return { identity, handle, seeded };
}

describe("issue #314 stage 3 — the core re-confirms only what the provider reconciled", () => {
  test("a reconciled verdict re-confirms the record exactly as it stands, and nothing is replaced", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    const { identity, handle, seeded } = await seedUnconfirmedConversation(store, sessions);
    const driver = createChatGptWebDriver({
      provider: CORR_PROVIDER,
      sessions,
      proveRetainedCoherence: async () => ({ kind: "reconciled", reason: "the reply is present" }),
    });

    const plan = await resolveWebChatContinuation({ store, driver }, {
      ...coreScope(),
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });

    expect(plan.outcome).toBe("exact_resume");
    const record = await store.read(identity);
    expect(record?.checkpoint).toBe("confirmed");
    expect(record?.handle).toBe(handle);
    expect(record?.generation).toBe(1);
    // The reconciliation is not an adoption: everything the record already held survives.
    expect(record?.initialization).toEqual({ generation: 1, fingerprint: "fp-installed" });
    expect(record?.lastConfirmedTurn).toEqual({ turnId: "turn-1", at: 11 });
    expect(record?.status).toBe("resumable");
    expect(record?.revision).toBeGreaterThan(seeded.revision);
  });

  test("an unprovable verdict keeps the existing honest refusal, with the record untouched", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    const { identity } = await seedUnconfirmedConversation(store, sessions);
    const before = (await store.read(identity))!;
    const driver = createChatGptWebDriver({
      provider: CORR_PROVIDER,
      sessions,
      proveRetainedCoherence: async () => ({ kind: "unprovable", reason: "no finalized reply" }),
    });

    const plan = await resolveWebChatContinuation({ store, driver }, {
      ...coreScope(),
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });

    expect(plan.outcome).toBe("failed");
    expect(plan.error?.category).toBe("CONVERSATION_STATE_MISMATCH");
    expect(plan.reason).toContain("never confirmed");
    expect((await store.read(identity))?.checkpoint).toBe("unconfirmed");
    expect((await store.read(identity))?.revision).toBe(before.revision);
  });

  test("a lost verdict is the core's provider-neutral continuity loss, carrying the provider's code", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    await seedUnconfirmedConversation(store, sessions);
    const driver = createChatGptWebDriver({
      provider: CORR_PROVIDER,
      sessions,
      proveRetainedCoherence: async () => ({ kind: "lost", reason: "surface-dead" }),
    });

    const plan = await resolveWebChatContinuation({ store, driver }, {
      ...coreScope(),
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });

    expect(plan.outcome).toBe("failed");
    expect(plan.error?.category).toBe("CONVERSATION_LOST");
    expect(plan.error?.providerCode).toBe("surface-dead");
    expect(plan.reason).toContain("surface-dead");
  });

  test("a driver with no reconciliation method behaves exactly as before: the honest refusal", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    await seedUnconfirmedConversation(store, sessions);
    const driver = createChatGptWebDriver({ provider: CORR_PROVIDER, sessions });

    const plan = await resolveWebChatContinuation({ store, driver }, {
      ...coreScope(),
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });
    expect(plan.outcome).toBe("failed");
    expect(plan.error?.category).toBe("CONVERSATION_STATE_MISMATCH");
    expect(plan.reason).toContain("never confirmed");
  });

  test("the seam receives provider state only — the conversation key, no message content", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    const { identity } = await seedUnconfirmedConversation(store, sessions);
    const probeInputs: unknown[] = [];
    const driver = createChatGptWebDriver({
      provider: CORR_PROVIDER,
      sessions,
      proveRetainedCoherence: async (input) => {
        probeInputs.push(input);
        return { kind: "reconciled", reason: "proven" };
      },
    });

    const plan = await resolveWebChatContinuation({ store, driver }, {
      ...coreScope(),
      // A caller's text is present in the request; there is no path for it to reach the probe.
      systemInstructions: ["the caller's own words"],
      intent: { kind: "continue" },
      expectedGeneration: 1,
    });
    expect(plan.outcome).toBe("exact_resume");
    expect(probeInputs).toEqual([{ conversationKey: identity.key }]);
  });

  test("a transport that cannot inspect a retained conversation fails closed instead of guessing", async () => {
    const transport = new ChatGptWebSurfaceTransport({
      async run() { throw new Error("unused by this test"); },
      async verifyConnector() { return "unused"; },
      async inspectSession() {
        return { authenticated: true as const, temporary: false as const, url: "https://chatgpt.com" };
      },
      async smokeTest() { return { effort: "low", response: "unused" }; },
      async recoverRetainedAnswer() { throw new Error("unused by this test"); },
      async close() {},
    });
    expect(await transport.proveRetainedCoherence("key-stage3-uninspectable")).toEqual({
      kind: "unprovable",
      reason: "this transport cannot inspect a retained conversation",
    });
  });

  test("an explicit replay never needs reconciliation, and is never blocked by a lost verdict", async () => {
    const store = createMemoryConversationStore();
    const sessions = new ChatGptTurnSessions();
    await seedUnconfirmedConversation(store, sessions);
    let probed = 0;
    const driver = createChatGptWebDriver({
      provider: CORR_PROVIDER,
      sessions,
      proveRetainedCoherence: async () => {
        probed += 1;
        return { kind: "lost", reason: "surface-dead" };
      },
    });

    const plan = await resolveWebChatContinuation({ store, driver }, {
      ...coreScope(),
      intent: {
        kind: "replay",
        expectedGeneration: 1,
        reason: "the caller decided to rebuild",
        history: [{ role: "user", text: "arregla el bug" }],
      },
      expectedGeneration: 1,
    });
    expect(plan.outcome).toBe("replay");
    expect(plan.conversation?.generation).toBe(2);
    expect(probed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The real route: the adapter, with only the browser I/O replaced
// ---------------------------------------------------------------------------

/**
 * A retained ChatGPT conversation's structure, without a browser.
 *
 * The page holds *turn identities* (the same structural keys the DOM exposes) and the flags the
 * completion evidence is read from. It never holds message text of its own: what it "received" is
 * recorded separately, exactly as the provider side would.
 */
interface PhysicalConversation extends RetainedSurfacePage {
  readonly name: string;
  closeCount: number;
  readonly userTurns: string[];
  readonly responseTurns: string[];
  generationRunning: boolean;
  lastReplyFinalized: boolean;
  /** Every prompt this physical conversation received, in order — the provider side of "nothing resent". */
  readonly submissions: string[];
  submit(prompt: string): void;
  answer(finalized: boolean): void;
  markClosed(): void;
}

function physicalConversation(name: string): PhysicalConversation {
  let closed = false;
  let turnCount = 0;
  const page: PhysicalConversation = {
    name,
    closeCount: 0,
    userTurns: [],
    responseTurns: [],
    generationRunning: false,
    lastReplyFinalized: false,
    submissions: [],
    isClosed: () => closed,
    close: async () => {
      closed = true;
      page.closeCount += 1;
    },
    submit: prompt => {
      page.submissions.push(prompt);
      page.userTurns.push(`conversation-turn-user-${++turnCount}`);
    },
    answer: finalized => {
      page.responseTurns.push(`conversation-turn-assistant-${++turnCount}`);
      page.generationRunning = !finalized;
      page.lastReplyFinalized = finalized;
    },
    markClosed: () => { closed = true; },
  };
  return page;
}

/** What one planned turn does, as the browser I/O. */
type TurnPlan =
  | { answer: string }
  | { error: Error; failBeforeActivation: true }
  | {
    error: Error;
    /** Whether the prompt was accepted and rendered (the default) or never landed. */
    accepted?: boolean;
    /** The answer state the failed attempt left behind, if any. */
    reply?: "finalized" | "streaming" | "none";
  };

/**
 * The browser I/O of a managed-chrome ChatGPT turn, over the **production** retained-surface owner
 * and the **production** reconciliation rule.
 *
 * Only the physical page is replaced. The surface lifetime, the attempt record, the coherence verdict
 * and its retirements are the real implementations, so this block proves the whole seam rather than a
 * description of it.
 */
class ManagedSurfaceFixture {
  readonly registry = new RetainedSurfaceRegistry<PhysicalConversation, ChatGptRetainedAttempt>();
  readonly pages: PhysicalConversation[] = [];
  readonly runs: Array<{ prompt: string; reused: boolean; key: string | undefined }> = [];
  /** Exactly what the provider's reconciliation seam was handed, per call. */
  readonly probeArguments: unknown[][] = [];
  private readonly plans: TurnPlan[] = [];

  enqueue(plan: TurnPlan): void {
    this.plans.push(plan);
  }

  get surfaceKey(): string | undefined {
    return this.runs.at(-1)?.key;
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: (turn: WebSurfaceTurn) => this.runTurn(turn),
      async verifyConnector() { return "controlled"; },
      async inspectSession() { return { authenticated: true, temporary: false, url: "https://chatgpt.com" }; },
      async smokeTest() { return { effort: "low", response: "controlled" }; },
      async recoverRetainedAnswer() { throw new Error("no retained answer in this fixture"); },
      proveRetainedCoherence: (conversationKey: string) => {
        // The provider seam receives state: exactly the conversation key.
        this.probeArguments.push([conversationKey]);
        return reconcileRetainedConversation({
          registry: this.registry,
          conversationKey,
          inspect: async page => ({
            kind: "read" as const,
            state: {
              userTurns: [...page.userTurns],
              responseTurns: [...page.responseTurns],
              generationRunning: page.generationRunning,
            },
            replyFinalized: !page.generationRunning
              && page.responseTurns.length > 0
              && page.lastReplyFinalized,
          }),
        });
      },
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }

  private async runTurn(turn: WebSurfaceTurn): Promise<string> {
    const plan = this.plans.shift();
    if (!plan) throw new Error("this fixture has no planned turn left");
    const key = turn.conversationKey;
    let retained;
    if (key !== undefined) {
      try {
        retained = await this.registry.acquire(key, {
          required: false,
          create: async () => {
            const page = physicalConversation(`page-${this.pages.length + 1}`);
            this.pages.push(page);
            return page;
          },
        });
      } catch (error) {
        if (error instanceof RetainedSurfaceLostError) throw chatGptRetainedSurfaceLostError(error.reason);
        throw error;
      }
    }
    const page = retained?.page;
    const reused = retained !== undefined && !retained.created;
    await turn.onPreparedSelected?.(reused);
    const prepare = reused ? turn.prepareResume : turn.prepare;
    if (!prepare) throw chatGptContinuationPromptMissingError();
    const compiled = await prepare();
    this.runs.push({ prompt: compiled.text, reused, key });
    let failed = false;
    let tornDown = false;
    try {
      await turn.onPhysicalSurfaceBound?.({
        resourceId: `surface:${key ?? turn.traceId}`,
        browserContextId: "controlled-context",
        pageId: `controlled-page:${key ?? turn.traceId}`,
        profileId: "controlled-profile",
        accountId: "chatgpt-account:controlled-surface-account",
      });
      await turn.onSurfaceReady?.();
      if ("failBeforeActivation" in plan) {
        failed = true;
        throw plan.error;
      }
      // Send activation: the attempt's structural record is taken before anything lands in the
      // conversation, exactly as the browser worker records it (issue #314 stage 3).
      if (page && key !== undefined) {
        this.registry.recordAttempt(key, {
          userTurns: [...page.userTurns],
          responseTurns: [...page.responseTurns],
        });
      }
      await turn.onSendActivated?.();
      turn.onSubmitted?.();
      if ("error" in plan) {
        failed = true;
        if (page && plan.accepted !== false) page.submit(compiled.text);
        if (page && plan.reply === "finalized") page.answer(true);
        if (page && plan.reply === "streaming") page.answer(false);
        throw plan.error;
      }
      page?.submit(compiled.text);
      page?.answer(true);
      turn.onTextDelta(plan.answer);
      return plan.answer;
    } catch (error) {
      failed = true;
      tornDown = error instanceof DOMException && error.name === "AbortError";
      throw error;
    } finally {
      compiled.release();
      if (retained !== undefined && key !== undefined) {
        // The worker's own order (issue #171/#314) and its own classifier (issue #317 stage 1):
        // release, then publish the settlement this turn reached. The phase is the registry's own
        // structural fact — the attempt record exists exactly when this turn's send was activated — so
        // a pre-activation failure settles as `not_started` (nothing was sent, nothing to reconcile) and
        // a post-activation failure as `unreconciled` (the surface stays and is marked). A page that died
        // during the turn is retired by the registry itself.
        this.registry.release(key);
        this.registry.settle(
          key,
          retainedSurfaceSettlementForTurn(
            !failed ? "completed" : tornDown ? "torn-down" : "failed",
            this.registry.submissionConfirmed(key) ? "confirmed" : "unconfirmed",
          ),
        );
      }
    }
  }
}

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-314-stage3-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

/** One `/v1/chat/completions` request through the real production path, with the browser I/O replaced. */
function apiTurn(messages: readonly { role: "user" | "assistant"; content: string }[]): CodexParsedRequest {
  const translated = translateChatCompletionsRequest({
    model: MODEL,
    messages: messages.map(message => ({ role: message.role, content: message.content })),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ dsh_session_id: KEY_SESSION }) },
  });
  const parsed = parseRequest(translated.body);
  routeChatGptWebRequest(parsed, defaultConfig());
  return parsed;
}

async function runTurn(
  target: ReturnType<typeof createChatGptWebAdapter>,
  request: CodexParsedRequest,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await target.runTurn(request, controlledIncoming(), event => events.push(event));
  return events;
}

const answerOf = (events: readonly AdapterEvent[]) =>
  events.filter(event => event.type === "text_delta").map(event => (event as { text: string }).text).join("");
const codeOf = (events: readonly AdapterEvent[]) => {
  const error = events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");
  return error?.code;
};
const errorOf = (events: readonly AdapterEvent[]) =>
  events.find(event => event.type === "error") as (Extract<AdapterEvent, { type: "error" }> | undefined);

describe("issue #314 stage 3 — the real route: an established conversation survives its failed turn", () => {
  test("the remaining case: the failed turn's reply is in the page, so the next turn resumes and answers", async () => {
    const fixture = new ManagedSurfaceFixture();
    // Turn 1 establishes the conversation (its install turn settles, so the initialization
    // fingerprint is installed). Turn 2 fails AFTER its submission was accepted, with its reply
    // physically present in the page. Turn 3 is the user's next turn.
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    fixture.enqueue({ answer: "respuesta tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    const first = await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    expect(codeOf(first)).toBeUndefined();
    expect(answerOf(first)).toBe("respuesta uno");

    const failed = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    expect(codeOf(failed)).toBe("chatgpt_submitted_turn_failed");

    const key = fixture.surfaceKey!;
    expect(fixture.registry.needsReconciliation(key)).toBe(true);
    expect(fixture.registry.isLost(key)).toBe(false);

    // The provider proved the retained conversation holds the failed attempt's reply, so the core
    // accepts an exact resume and the user's next turn answers on the same conversation.
    const third = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));

    expect(codeOf(third)).toBeUndefined();
    expect(answerOf(third)).toBe("respuesta tres");
    expect(fixture.runs).toHaveLength(3);
    expect(fixture.runs[2]!.key).toBe(key);
    expect(fixture.runs[2]!.reused).toBe(true);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.registry.isLost(key)).toBe(false);
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    // The record the core re-confirmed is the recorded conversation, not a replacement.
    const record = (await resolveNativeChatGptContinuityStore(loadConfig()).list())
      .find(candidate => candidate.identity.key === key);
    expect(record?.generation).toBe(1);
    expect(record?.checkpoint).toBe("confirmed");

    // Nothing is resent: the failed turn's message reached the provider exactly once, and the next
    // turn carried only its own new human message.
    const submissions = fixture.pages[0]!.submissions;
    expect(submissions).toHaveLength(3);
    // The failed turn's message reached the provider exactly once (its own submission), and the
    // next turn carried only its own new human message — nothing was resent.
    expect(submissions.filter(text => text.includes("pregunta dos"))).toHaveLength(1);
    expect(submissions[1]).toContain("pregunta dos");
    expect(submissions[2]).not.toContain("pregunta dos");
    expect(submissions[2]).toContain("pregunta tres");
  });

  test("and the conversation keeps working: a fourth turn continues the same page", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    fixture.enqueue({ answer: "respuesta tres" });
    fixture.enqueue({ answer: "respuesta cuatro" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    const third = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));
    const fourth = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
      { role: "assistant", content: "tres" },
      { role: "user", content: "pregunta cuatro" },
    ]));

    expect(answerOf(third)).toBe("respuesta tres");
    expect(answerOf(fourth)).toBe("respuesta cuatro");
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.runs.map(run => run.reused)).toEqual([false, true, true, true]);
    expect(fixture.registry.isLost(fixture.surfaceKey!)).toBe(false);
  });

  test("coherence that cannot be proven fails closed with the honest category and retires the conversation", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    // The prompt landed, but this failed attempt produced no answer this provider can attribute.
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "none" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    const failed = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    expect(codeOf(failed)).toBe("chatgpt_submitted_turn_failed");
    const key = fixture.surfaceKey!;
    expect(fixture.registry.needsReconciliation(key)).toBe(true);

    const refused = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ])).catch((error: unknown) => error);

    // The existing honest category and message, unchanged: the provider could not reconcile it.
    expect(refused).toBeInstanceOf(Error);
    expect((refused as { category?: string }).category).toBe("CONVERSATION_STATE_MISMATCH");
    expect((refused as Error).message).toContain("never confirmed");
    // The conversation is retired rather than left unreconciled forever, and nothing was replaced.
    expect(fixture.registry.isLost(key)).toBe(true);
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    expect(fixture.registry.has(key)).toBe(false);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.pages[0]!.isClosed()).toBe(true);
    expect(fixture.runs).toHaveLength(2);
  });

  test("a page that is gone is a continuity error with the surface-dead reason", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    const key = fixture.surfaceKey!;

    // The page dies after the failed turn: that is evidence, and evidence retires.
    fixture.pages[0]!.markClosed();
    const refused = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ])).catch((error: unknown) => error);

    expect(refused).toBeDefined();
    expect((refused as { code?: string }).code).toBe(CHATGPT_RETAINED_SURFACE_LOST_CODE);
    expect((refused as { status?: number }).status).toBe(409);
    expect((refused as Error).message).toContain("surface-dead");
    expect(fixture.registry.isLost(key)).toBe(true);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.runs).toHaveLength(2);
  });

  test("a failure that never reached the provider is reconciled without a reply, so the session survives", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("the composer failed before the prompt was sent"), failBeforeActivation: true });
    fixture.enqueue({ answer: "respuesta tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    // This one never activated a send, so nothing was submitted: no reply exists and none is needed.
    const failed = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ])).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    const key = fixture.surfaceKey!;
    // Changed by issue #317 stage 1: this failure never reached the provider, so it marks nothing and
    // spends no reconciliation budget. Before stage 1 this assertion was `true` — it encoded the
    // old "every failed turn marks" behaviour, which is exactly the gap stage 1 closes. The stage-3
    // verdict below is unaffected: the durable attempt is still unconfirmed, so the provider probe
    // still reconciles it (no attempt record ⇒ nothing was sent), and the session still survives.
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    expect(fixture.registry.submissionConfirmed(key)).toBe(false);

    const third = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));
    expect(codeOf(third)).toBeUndefined();
    expect(answerOf(third)).toBe("respuesta tres");
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.runs[2]!.reused).toBe(true);
    expect(fixture.registry.isLost(key)).toBe(false);
  });

  test("the provider seam is handed state only, never the turn's text", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    fixture.enqueue({ answer: "respuesta tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta secreta dos" },
    ]));
    await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta secreta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));

    const key = fixture.surfaceKey!;
    expect(fixture.probeArguments.length).toBeGreaterThan(0);
    for (const args of fixture.probeArguments) {
      expect(args).toEqual([key]);
      for (const argument of args) {
        expect(JSON.stringify(argument)).not.toContain("pregunta");
      }
    }
  });
});
