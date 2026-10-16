import { describe, expect, test } from "bun:test";
import {
  BrowserAccountLeaseRegistry,
  ChatGptWebProviderCore,
  type BrowserAccountLeaseDescriptor,
} from "../src/adapters/chatgpt-web/provider-core";
import {
  MAX_CHATGPT_BROWSER_TABS,
  chatGptBrowserTurnLimitError,
} from "../src/adapters/chatgpt-web/concurrency";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";
import {
  CHATGPT_RETAINED_SURFACE_BUSY_CODE,
  chatGptRetainedSurfaceBusyError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  RetainedSurfaceBusyError,
  RetainedSurfaceRegistry,
  type RetainedSurfacePage,
} from "../src/adapters/chatgpt-web/retained-surface";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import { classifyChatGptWebFailure } from "../src/adapters/chatgpt-web/web-chat-bridge";
import { createWebChatTransportLeaseRegistry } from "../src/web-chat/transport/transport-lease";

/**
 * Account fan-out and per-conversation exclusivity, restored as a deterministic, browser-free
 * suite.
 *
 * This replaces the concurrency contract that lived in the deleted
 * `scripts/test-issue-9-provider-core.ts` (removed in d3c5b82). That file was never in the
 * `scripts.test` chain, so bare `bun test` never saw it either; this suite is a chain entry.
 *
 * The contract today (issue #201, closed):
 *
 * - one authenticated ChatGPT account is a **bounded**, not an exclusive, resource: it serves up to
 *   `MAX_CHATGPT_BROWSER_TABS` simultaneous browser turns;
 * - exclusivity is per logical conversation (transport lease, retained surface) and per physical
 *   browser resource (one resource id, one lease), plus one active turn per native DSH thread;
 * - every fan-out refusal is the one shared bounded sentence.
 *
 * No Playwright, no real account and no browser: only the real owners are exercised.
 */

const SNAPSHOT_CREATED_AT = 1_700_000_000_000;

function leaseInput(turnId: string, overrides: {
  accountIdentity?: string;
  nativeThreadId?: string;
  pageIdentity?: string;
} = {}) {
  const nativeTurnId = `native-${turnId}`;
  return {
    executionKey: `execution-${turnId}`,
    traceId: `trace-${turnId}`,
    nativeTurnId,
    nativeThreadId: overrides.nativeThreadId ?? "thread-1",
    accountIdentity: overrides.accountIdentity ?? `account-${turnId}`,
    browserProfile: "managed-chrome",
    browserContext: "context-1",
    pageIdentity: overrides.pageIdentity ?? `page-${turnId}`,
    capabilitySnapshot: projectChatGptCapabilities({
      sessionId: `session-${turnId}`,
      agentId: `agent-${turnId}`,
      turnId: nativeTurnId,
      tools: [],
      // Pinned so the suite never races the wall clock (the snapshot identity includes it).
      createdAt: SNAPSHOT_CREATED_AT,
    }),
  };
}

function leaseDescriptor(
  turnId: string,
  accountIdentity = "account-shared",
): BrowserAccountLeaseDescriptor {
  return {
    serviceId: "chatgpt-web",
    accountIdentity,
    browserProfile: "managed-chrome",
    browserContext: "context-1",
    pageIdentity: `page-${turnId}`,
    turnId,
  };
}

function physicalResource(turnId: string, accountIdentity = "account-shared") {
  return {
    resourceId: `surface-${turnId}`,
    browserContextId: "context-1",
    pageId: `page-${turnId}`,
    profileId: "profile-shared",
    accountId: `chatgpt-account:${accountIdentity}`,
  };
}

/** Capture a synchronous refusal instead of asserting through a matcher, so the exact text is visible. */
function refusalOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the operation to be refused, but it succeeded");
}

async function asyncRefusalOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the operation to be refused, but it succeeded");
}

/** Minimal Playwright Page stand-in: the two capabilities the registry needs. */
function fakePage(): RetainedSurfacePage {
  let closed = false;
  return {
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
  };
}

/** A runtime whose browser outcome never settles, so its turn session stays active. */
function pendingRuntime(conversationKey: string): ChatGptTurnRuntime {
  return {
    mode: "read-only",
    capabilitySnapshot: projectChatGptCapabilities({
      sessionId: `session-${conversationKey}`,
      agentId: "agent-1",
      turnId: `turn-${conversationKey}`,
      tools: [],
      createdAt: SNAPSHOT_CREATED_AT,
    }),
    browser: new Promise<string>(() => {}),
    physicalSettlement: new Promise<void>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    cancel: () => {},
  };
}

describe("issue #201 — ChatGPT account fan-out is bounded, exclusivity is per conversation", () => {
  test("1: two distinct chats on one account both reach LEASED with distinct lease ids", () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);

    // Two different DSH chats, one authenticated account, separate pages and DSH threads.
    const chatA = core.begin(leaseInput("chat-a", {
      accountIdentity: "account-shared",
      pageIdentity: "page-chat-a",
      nativeThreadId: "thread-chat-a",
    }));
    const chatB = core.begin(leaseInput("chat-b", {
      accountIdentity: "account-shared",
      pageIdentity: "page-chat-b",
      nativeThreadId: "thread-chat-b",
    }));

    // An account-level single-owner refusal (the deleted limitation) fails exactly here.
    expect(chatA.snapshot().state).toBe("LEASED");
    expect(chatB.snapshot().state).toBe("LEASED");
    expect(leases.activeCount()).toBe(2);
    expect(chatA.lease.leaseId).not.toBe(chatB.lease.leaseId);

    // Each chat owns its own physical resource, so both can progress independently.
    chatA.bindPhysicalResource(physicalResource("chat-a"));
    chatB.bindPhysicalResource(physicalResource("chat-b"));
    chatA.markSurfaceReady();
    chatB.markSurfaceReady();
    expect(chatA.snapshot().state).toBe("SURFACE_READY");
    expect(chatB.snapshot().state).toBe("SURFACE_READY");
    expect(chatA.snapshot().physicalResource?.resourceId).toBe("surface-chat-a");
    expect(chatB.snapshot().physicalResource?.resourceId).toBe("surface-chat-b");

    // Retiring one chat returns exactly its own slot; the other keeps its lease.
    chatA.failBeforePhysicalSettlement();
    expect(chatA.lease.isActive()).toBe(false);
    expect(chatB.lease.isActive()).toBe(true);
    expect(leases.activeCount()).toBe(1);
    chatB.failBeforePhysicalSettlement();
    expect(leases.activeCount()).toBe(0);
  });

  test("2: a second turn for the same native DSH thread is still refused", () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const first = core.begin(leaseInput("thread-first", {
      accountIdentity: "account-shared",
      nativeThreadId: "thread-shared",
    }));
    expect(first.snapshot().state).toBe("LEASED");

    const refusal = refusalOf(() => core.begin(leaseInput("thread-second", {
      accountIdentity: "account-shared",
      nativeThreadId: "thread-shared",
    })));
    expect(refusal.message).toBe(
      "ChatGPT Web cannot synchronously start a second provider turn for an active native DSH thread",
    );
    // The refused turn never acquired a lease of its own.
    expect(leases.activeCount()).toBe(1);

    // Once the first turn physically settles, the thread is free again.
    first.failBeforePhysicalSettlement();
    const second = core.begin(leaseInput("thread-third", {
      accountIdentity: "account-shared",
      nativeThreadId: "thread-shared",
    }));
    expect(second.snapshot().state).toBe("LEASED");
    expect(leases.activeCount()).toBe(1);
  });

  test("3: two leases never bind the same physical resource id", () => {
    const registry = new BrowserAccountLeaseRegistry();
    const first = registry.acquire(leaseDescriptor("turn-one"));
    const second = registry.acquire(leaseDescriptor("turn-two"));
    expect(registry.activeCount()).toBe(2);

    registry.bindPhysicalResource(first, physicalResource("shared"));
    expect(first.provenance().physicalResourceBound).toBe(true);

    const refusal = refusalOf(() => registry.bindPhysicalResource(second, physicalResource("shared")));
    expect(refusal.message).toBe(
      "Physical browser resource is already leased by turn turn-one: surface-shared",
    );
    // The refused lease stays unbound: it did not steal the resource from its owner.
    expect(second.provenance().physicalResourceBound).toBe(false);
    expect(second.physicalResourceBinding()).toBeUndefined();
    expect(first.provenance().physicalResourceBound).toBe(true);
  });

  test("4: past MAX_CHATGPT_BROWSER_TABS the refusal is the shared bounded message, and release frees exactly one slot", () => {
    const registry = new BrowserAccountLeaseRegistry();
    const live = [];
    for (let index = 1; index <= MAX_CHATGPT_BROWSER_TABS; index += 1) {
      live.push(registry.acquire(leaseDescriptor(`turn-${index}`)));
    }
    expect(registry.activeCount()).toBe(MAX_CHATGPT_BROWSER_TABS);

    const shared = chatGptBrowserTurnLimitError();
    const overflow = refusalOf(() => registry.acquire(leaseDescriptor("turn-overflow")));
    expect(overflow.message).toBe(shared.message);
    expect(overflow.message).toBe(
      `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; `
      + "close or finish a browser tab before starting another",
    );
    // The failed acquire allocated nothing.
    expect(registry.activeCount()).toBe(MAX_CHATGPT_BROWSER_TABS);

    // release() frees exactly one account slot — no more, no less.
    registry.release(live[0]);
    expect(registry.activeCount()).toBe(MAX_CHATGPT_BROWSER_TABS - 1);
    registry.acquire(leaseDescriptor("turn-replacement"));
    expect(registry.activeCount()).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(refusalOf(() => registry.acquire(leaseDescriptor("turn-overflow-2"))).message)
      .toBe(shared.message);

    // The ceiling is per authenticated account: another account has its own allowance.
    const otherAccount = registry.acquire(leaseDescriptor("turn-other-account", "account-other"));
    expect(registry.activeCount()).toBe(MAX_CHATGPT_BROWSER_TABS + 1);
    expect(otherAccount.isActive()).toBe(true);
  });

  test("4b: the turn-session registry enforces the same shared bounded sentence", () => {
    const sessions = new ChatGptTurnSessions(30 * 60_000, 64);
    for (let index = 1; index <= MAX_CHATGPT_BROWSER_TABS; index += 1) {
      sessions.getOrCreate(
        `execution-${index}`,
        () => pendingRuntime(`conversation-${index}`),
        `trace-${index}`,
        `owner-${index}`,
        `native-${index}`,
        `thread-${index}`,
      );
    }
    // Same shared sentence as the lease registry: one bound, one message, every enforcement site.
    expect(refusalOf(() => sessions.getOrCreate(
      "execution-overflow",
      () => pendingRuntime("conversation-overflow"),
      "trace-overflow",
      "owner-overflow",
      "native-overflow",
      "thread-overflow",
    )).message).toBe(chatGptBrowserTurnLimitError().message);
  });

  test("5a: the same conversation key still yields TRANSPORT_UNAVAILABLE", async () => {
    const registry = createWebChatTransportLeaseRegistry();
    const resource = { id: "resource-1", conversationKey: "conversation-1", epoch: 1 };
    const lease = await registry.acquire({
      exchangeId: "exchange-1",
      conversationKey: "conversation-1",
      epoch: 1,
      create: async () => resource,
    });
    expect(lease.snapshot().state).toBe("active");
    expect(registry.isLeased("conversation-1")).toBe(true);

    const refusal = await asyncRefusalOf(() => registry.acquire({
      exchangeId: "exchange-2",
      conversationKey: "conversation-1",
      epoch: 1,
    }));
    expect((refusal as { category?: string }).category).toBe("TRANSPORT_UNAVAILABLE");

    // Only a published settlement makes the key available again.
    lease.settle("fulfilled");
    const next = await registry.acquire({
      exchangeId: "exchange-3",
      conversationKey: "conversation-1",
      epoch: 1,
    });
    expect(next.snapshot().state).toBe("active");
  });

  test("5b: a busy retained surface still yields retained_surface_busy", async () => {
    const registry = new RetainedSurfaceRegistry();
    const page = fakePage();
    const first = await registry.acquire("conversation-busy", {
      required: false,
      create: async () => page,
    });
    expect(first.created).toBe(true);

    expect(await asyncRefusalOf(() => registry.acquire("conversation-busy", {
      required: false,
      create: async () => fakePage(),
    }))).toBeInstanceOf(RetainedSurfaceBusyError);

    // Releasing without a published settlement keeps the key busy (architecture §9.3/§15.3).
    registry.release("conversation-busy");
    expect(await asyncRefusalOf(() => registry.acquire("conversation-busy", {
      required: false,
      create: async () => fakePage(),
    }))).toBeInstanceOf(RetainedSurfaceBusyError);

    // A published settlement is what makes it reusable.
    registry.settle("conversation-busy", "fulfilled");
    const reused = await registry.acquire("conversation-busy", {
      required: false,
      create: async () => fakePage(),
    });
    expect(reused.created).toBe(false);
    expect(reused.page).toBe(page);

    // The ChatGPT adapter publishes the busy surface under this exact code, and the bridge maps it
    // to the shared TRANSPORT_UNAVAILABLE category.
    expect(CHATGPT_RETAINED_SURFACE_BUSY_CODE).toBe("retained_surface_busy");
    expect(chatGptRetainedSurfaceBusyError().code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
    expect(classifyChatGptWebFailure(chatGptRetainedSurfaceBusyError())).toBe("TRANSPORT_UNAVAILABLE");
  });
});
