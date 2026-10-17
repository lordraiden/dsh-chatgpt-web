import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BrowserAccountLeaseRegistry,
  CHATGPT_WEB_ACCOUNT_IDENTITY_MISSING_MESSAGE,
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
  ChatGptWebAdapterError,
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
    // The refusal is the one conversation-busy category this provider publishes (issue #305): a local
    // admission decision, never a bare `Error` the API would normalize into `502 upstream_server_error`.
    expect(refusal).toBeInstanceOf(ChatGptWebAdapterError);
    expect((refusal as ChatGptWebAdapterError).code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
    expect(classifyChatGptWebFailure(refusal as ChatGptWebAdapterError)).toBe("TRANSPORT_UNAVAILABLE");
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

  test("3b: a genuine account mismatch is still refused, and names both sides fingerprinted", () => {
    // A fingerprint a sign-in recorded genuinely disagrees with the account the page exposes. The
    // check must keep refusing, and the diagnostic must name *which* physical account disagreed
    // without ever printing a raw account identifier.
    const registry = new BrowserAccountLeaseRegistry();
    const lease = registry.acquire(leaseDescriptor("turn-one", "logical-account-276"));

    const refusal = refusalOf(() => registry.bindPhysicalResource(
      lease,
      physicalResource("turn-one", "physical-account-276"),
    ));
    expect(refusal.message).toContain("Browser lease physical account does not match its logical account identity");
    // Both sides are named, and both are this file's own 12-hex fingerprints.
    expect(refusal.message).toMatch(/expected [0-9a-f]{12}, actual [0-9a-f]{12}/);
    expect(refusal.message).not.toContain("logical-account-276");
    expect(refusal.message).not.toContain("physical-account-276");
    // And it is a real refusal: the lease stays unbound and owns no physical resource.
    expect(lease.provenance().physicalResourceBound).toBe(false);
    expect(lease.physicalResourceBinding()).toBeUndefined();
  });

  test("3b(ii): a refusal only says 'no identity recorded' when the identity really was a derived fallback", () => {
    // The same genuine mismatch, but the logical identity is marked as `providerConfig`'s derived
    // storage-state fallback: that is NOT a recorded account identity, so the operator must be told
    // the real cause — and the refusal must still refuse. It never reports the mismatch sentence,
    // which would be true but useless. Both cases are the same check, distinguished once, in
    // `BrowserAccountLease.bindPhysicalResource`.
    const registry = new BrowserAccountLeaseRegistry();
    const lease = registry.acquire({
      ...leaseDescriptor("turn-one", "storage-state-derived-fallback"),
      accountIdentityRecorded: false,
    });

    const refusal = refusalOf(() => registry.bindPhysicalResource(
      lease,
      physicalResource("turn-one", "physical-account-276"),
    ));
    expect(refusal.message).toBe(CHATGPT_WEB_ACCOUNT_IDENTITY_MISSING_MESSAGE);
    // It names the missing identity and the action, not just the disagreement.
    expect(refusal.message).toContain("no recorded account identity");
    expect(refusal.message).toContain("sign in again");
    expect(refusal.message).toContain("/v1/control/auth/");
    expect(refusal.message).not.toContain("does not match its logical account identity");
    // Never bind on a guess.
    expect(lease.provenance().physicalResourceBound).toBe(false);
    expect(lease.physicalResourceBinding()).toBeUndefined();
  });

  test("3b(iii): the provenance travels with the turn into the lease, and a matching account still binds", () => {
    // The end-to-end hop a production turn takes: `browserAccountLeaseInput` carries the fact
    // `providerConfig` decided into `begin()`, and `begin()` into the descriptor the check reads.
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const turn = core.begin({
      ...leaseInput("derived-account"),
      accountIdentity: "storage-state-derived-fallback",
      accountIdentityRecorded: false,
    });

    const refusal = refusalOf(() => turn.bindPhysicalResource(physicalResource(
      "derived-account",
      "physical-account-276",
    )));
    expect(refusal.message).toBe(CHATGPT_WEB_ACCOUNT_IDENTITY_MISSING_MESSAGE);

    // The check is not weakened in the other direction: the account the logical identity does name
    // still binds, and the derived provenance never becomes a reason to refuse a matching account.
    const matching = core.begin({
      ...leaseInput("matching-account"),
      accountIdentity: "storage-state-derived-fallback",
      accountIdentityRecorded: false,
      nativeThreadId: "thread-matching",
    });
    matching.bindPhysicalResource(physicalResource("matching-account", "storage-state-derived-fallback"));
    // A bound surface can become ready; an unbound one cannot, so this is the proof it really bound.
    matching.markSurfaceReady();
    expect(matching.snapshot().state).toBe("SURFACE_READY");
    expect(leases.activeCount()).toBe(2);
  });

  test("3c: the matching physical account still binds, so the check is not weakened", () => {
    const registry = new BrowserAccountLeaseRegistry();
    const lease = registry.acquire(leaseDescriptor("turn-one", "logical-account-276"));
    registry.bindPhysicalResource(lease, physicalResource("turn-one", "logical-account-276"));
    expect(lease.provenance().physicalResourceBound).toBe(true);
    expect(lease.physicalResourceBinding()?.accountId).toBe("chatgpt-account:logical-account-276");
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

/**
 * The lease provenance is the one identity channel that must never carry a raw identity.
 *
 * Restored from the deleted `scripts/test-issue-9-provider-core.ts` ("provenance fingerprints trusted
 * account/profile context/page identity"), asserted against the lease as it is now and extended to
 * every identity the provenance reports and to the whole published key set. The suite's own `3b`
 * cases already pin the same fingerprint vocabulary in the *refusal* text; this pins it in the
 * published provenance and in the lease id.
 *
 * The lease provenance is browser-free by construction: it is a plain value derived from the
 * descriptor, so no page, account or path has to exist.
 */
describe("issue #201 — the lease provenance publishes fingerprints, never an identity", () => {
  /** This file's own copy of the fingerprint the lease uses: sha256, hex, first 12. */
  function fingerprint(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
  }

  const PROVENANCE_KEYS = [
    "account",
    "browserContext",
    "browserProfile",
    "leaseId",
    "page",
    "physicalResourceBound",
    "serviceId",
    "turnId",
  ];

  const RAW = {
    accountIdentity: "raw-account-201",
    browserProfile: "raw-profile-201",
    browserContext: "raw-context-201",
    pageIdentity: "raw-page-201",
    resourceId: "raw-surface-201",
  };

  test("every identity the lease reports is a 12-hex fingerprint, and no raw value is published", () => {
    const registry = new BrowserAccountLeaseRegistry();
    const lease = registry.acquire({
      serviceId: "chatgpt-web",
      accountIdentity: RAW.accountIdentity,
      browserProfile: RAW.browserProfile,
      browserContext: RAW.browserContext,
      pageIdentity: RAW.pageIdentity,
      turnId: "turn-provenance-201",
    });

    const provenance = lease.provenance();

    // The exact published key set, so an added or renamed identity field fails loudly here instead
    // of the absence of one being read by cast and silently missing a rename.
    expect(Object.keys(provenance).sort()).toEqual(PROVENANCE_KEYS);

    // Each reported identity is the fingerprint of the descriptor value it stands for.
    expect(provenance.account).toBe(fingerprint(RAW.accountIdentity));
    expect(provenance.browserProfile).toBe(fingerprint(RAW.browserProfile));
    expect(provenance.browserContext).toBe(fingerprint(RAW.browserContext));
    expect(provenance.page).toBe(fingerprint(RAW.pageIdentity));
    for (const field of ["account", "browserProfile", "browserContext", "page"] as const) {
      expect(provenance[field]).toMatch(/^[0-9a-f]{12}$/);
    }

    // `serviceId` is the provider label and `turnId` is the lease owner the registry dedupes on;
    // neither is an account/profile/context/page identity, and nothing here is a path.
    expect(provenance.serviceId).toBe("chatgpt-web");
    expect(provenance.turnId).toBe("turn-provenance-201");

    // The lease id is those same fingerprints in a fixed order plus the raw lease owner: it is a
    // second publication of the same sanitized identities, never a second raw channel.
    expect(provenance.leaseId).toBe([
      "chatgpt-web",
      fingerprint(RAW.accountIdentity),
      fingerprint(RAW.browserProfile),
      fingerprint(RAW.browserContext),
      fingerprint(RAW.pageIdentity),
      "turn-provenance-201",
    ].join(":"));
    expect(provenance.leaseId).toMatch(/^chatgpt-web(?::[0-9a-f]{12}){4}:turn-provenance-201$/);

    const published = JSON.stringify(provenance);
    for (const raw of Object.values(RAW)) expect(published).not.toContain(raw);
  });

  test("binding a physical resource reports that it exists, never which resource, page or path it is", () => {
    const registry = new BrowserAccountLeaseRegistry();
    const lease = registry.acquire({
      serviceId: "chatgpt-web",
      accountIdentity: RAW.accountIdentity,
      browserProfile: RAW.browserProfile,
      browserContext: RAW.browserContext,
      pageIdentity: RAW.pageIdentity,
      turnId: "turn-bound-201",
    });
    expect(lease.provenance().physicalResourceBound).toBe(false);

    registry.bindPhysicalResource(lease, {
      resourceId: RAW.resourceId,
      browserContextId: RAW.browserContext,
      pageId: RAW.pageIdentity,
      profileId: RAW.browserProfile,
      accountId: `chatgpt-account:${RAW.accountIdentity}`,
    });

    const bound = lease.provenance();
    // The resource identity is deliberately not reported: provenance carries the boolean, and the
    // raw binding stays in `physicalResourceBinding()`, where the driver that owns it reads it.
    expect(bound.physicalResourceBound).toBe(true);
    expect(Object.keys(bound).sort()).toEqual(PROVENANCE_KEYS);
    expect(lease.physicalResourceBinding()?.resourceId).toBe(RAW.resourceId);

    const published = JSON.stringify(bound);
    for (const raw of Object.values(RAW)) expect(published).not.toContain(raw);
  });

  test("a turn publishes that same sanitized provenance while `begin()` still holds the raw identity", () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const turn = core.begin({
      ...leaseInput("provenance-201"),
      accountIdentity: RAW.accountIdentity,
      pageIdentity: RAW.pageIdentity,
    });

    expect(Object.keys(turn.snapshot().lease).sort()).toEqual(PROVENANCE_KEYS);
    expect(JSON.stringify(turn.snapshot().lease)).not.toContain(RAW.accountIdentity);
    expect(JSON.stringify(turn.snapshot().lease)).not.toContain(RAW.pageIdentity);

    // The raw binding the driver needs is a separate field of the turn snapshot, and it only appears
    // once the physical resource really exists.
    expect(turn.snapshot().physicalResource).toBeUndefined();
    turn.bindPhysicalResource(physicalResource("provenance-201", RAW.accountIdentity));
    expect(turn.snapshot().physicalResource?.resourceId).toBe("surface-provenance-201");
    // Binding changes neither the published lease shape nor what it says.
    expect(Object.keys(turn.snapshot().lease).sort()).toEqual(PROVENANCE_KEYS);
    expect(JSON.stringify(turn.snapshot().lease)).not.toContain(RAW.accountIdentity);
  });
});
