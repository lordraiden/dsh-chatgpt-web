import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CHATGPT_TURN_QUEUE_FULL_CODE,
  CHATGPT_TURN_QUEUE_TIMEOUT_CODE,
  chatGptTurnQueueBackpressureError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { MAX_CHATGPT_BROWSER_TABS } from "../src/adapters/chatgpt-web/concurrency";
import { closeNativeChatGptContinuityStores, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { BrowserAccountLeaseRegistry, ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import {
  createChatGptTurnQueue,
  DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS,
  resolveChatGptTurnQueueWaitMs,
  type ChatGptTurnQueue,
  type ChatGptTurnQueuePriority,
  type ChatGptTurnQueueRefusal,
  type ChatGptTurnQueueTicket,
} from "../src/adapters/chatgpt-web/turn-queue";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { defaultConfig, saveConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import { CONTROLLED_ACCOUNT, controlledProviderConfig } from "./support/chatgpt-web-surface";

/**
 * Issue #358 — a bounded wait queue in front of the ChatGPT Web account fan-out bound.
 *
 * The bound (`MAX_CHATGPT_BROWSER_TABS`) is an account-safety property and is **not** raised here. What
 * changes is the answer to "the account is full right now": a turn waits for a slot instead of failing
 * immediately, and when the budget is spent the caller gets an honest, typed 429 with `Retry-After` and
 * a stable code instead of a hard failure that a fan-out client answers by retrying into the burst.
 *
 * The suite has two halves:
 *
 * 1. the queue's own contract (capacity, budget, depth, priority, fair share, cancellation, metrics),
 *    driven directly so the bounds are deterministic;
 * 2. the real HTTP route (`/v1/chat/completions`, the OpenAI-compatible surface) with
 *    only the browser I/O replaced, so "the sixth request waits and completes" and "the budget
 *    exhaustion is a 429 with Retry-After" are proven end to end.
 *
 * The lease, per-conversation exclusivity and the retry boundary are untouched: the queue only decides
 * *when* a turn may ask for a lease, and every assertion below holds that line (a refused turn never
 * reached the provider, a queued turn was submitted exactly once).
 */
let home: string;
let savedHome: SavedChatGptWebHome;
const servers: RunningServer[] = [];
const API_KEY = "issue-358-turn-queue-api-key-0123456789";
const CONTROL_TOKEN = "issue-358-turn-queue-control-token-0123456789";

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-358-turn-queue-", { clearFreeHome: true });
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  while (servers.length > 0) {
    const server = servers.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Await `work`, but never let a queued (instead of refused) request hang the suite. */
async function withDeadline<T>(work: Promise<T>, budgetMs = 10_000): Promise<T | "hung"> {
  return Promise.race([
    work,
    new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), budgetMs)),
  ]);
}

// ---------------------------------------------------------------------------------------------------
// Half 1: the queue's own contract.
// ---------------------------------------------------------------------------------------------------

interface QueueHarness {
  readonly queue: ChatGptTurnQueue;
  /** Live "leases" per account, the way the lease registry reports them. */
  readonly leases: Map<string, number>;
  readonly refusals: ChatGptTurnQueueRefusal[];
}

function queueHarness(options: {
  capacity?: number;
  waitBudgetMs?: number;
  maxWaiters?: number;
  maxPerCaller?: number;
} = {}): QueueHarness {
  const leases = new Map<string, number>();
  const refusals: ChatGptTurnQueueRefusal[] = [];
  const queue = createChatGptTurnQueue({
    capacity: options.capacity ?? 2,
    activeLeases: accountKey => leases.get(accountKey) ?? 0,
    ...(options.waitBudgetMs !== undefined ? { waitBudgetMs: options.waitBudgetMs } : {}),
    ...(options.maxWaiters !== undefined ? { maxWaiters: options.maxWaiters } : {}),
    ...(options.maxPerCaller !== undefined ? { maxPerCaller: options.maxPerCaller } : {}),
    refusal: input => {
      refusals.push(input);
      return new Error(`${input.reason} retry-after=${input.retryAfterSeconds} depth=${input.depth}`);
    },
    abortError: () => new DOMException("ChatGPT web turn aborted", "AbortError"),
    closedError: () => new Error("ChatGPT Web ProviderCore is shut down"),
  });
  return { queue, leases, refusals };
}

/** Take a slot and pretend the turn's lease was acquired: the two counts move together. */
async function holdSlot(
  harness: QueueHarness,
  accountKey: string,
  callerKey: string,
  priority: ChatGptTurnQueuePriority = "conversational",
): Promise<ChatGptTurnQueueTicket> {
  const ticket = await harness.queue.acquire({ accountKey, callerKey, priority });
  ticket.commit();
  harness.leases.set(accountKey, (harness.leases.get(accountKey) ?? 0) + 1);
  return ticket;
}

/** Release a slot the way retirement does: the lease goes first, then the queue is told. */
function releaseSlot(harness: QueueHarness, accountKey: string, ticket: ChatGptTurnQueueTicket): void {
  harness.leases.set(accountKey, Math.max(0, (harness.leases.get(accountKey) ?? 1) - 1));
  harness.queue.release(ticket);
}

describe("issue #358 — the bounded wait queue's own contract", () => {
  test("a turn that finds the bound full waits for a slot instead of failing", async () => {
    const harness = queueHarness({ capacity: 2 });
    const first = await holdSlot(harness, "account", "caller-a");
    const second = await holdSlot(harness, "account", "caller-b");

    let settled: ChatGptTurnQueueTicket | undefined;
    const waiting = harness.queue.acquire({ accountKey: "account", callerKey: "caller-c", priority: "conversational" })
      .then(ticket => { settled = ticket; return ticket; });
    await sleep(20);
    expect(settled).toBeUndefined();
    expect(harness.queue.snapshot().depth).toBe(1);

    releaseSlot(harness, "account", first);
    const granted = await waiting;
    granted.commit();
    harness.leases.set("account", 2);
    expect(granted.waitedMs).toBeGreaterThanOrEqual(0);
    expect(harness.queue.snapshot().depth).toBe(0);

    releaseSlot(harness, "account", second);
    releaseSlot(harness, "account", granted);
    expect(harness.queue.snapshot().active).toBe(0);
  });

  test("the wait budget expiry publishes the honest refusal facts", async () => {
    const harness = queueHarness({ capacity: 1, waitBudgetMs: 40 });
    const held = await holdSlot(harness, "account", "caller-a");

    await expect(harness.queue.acquire({ accountKey: "account", callerKey: "caller-b", priority: "conversational" }))
      .rejects.toThrow(/wait_budget_exhausted/);

    expect(harness.refusals).toHaveLength(1);
    expect(harness.refusals[0]!.reason).toBe("wait_budget_exhausted");
    expect(harness.refusals[0]!.retryAfterSeconds).toBe(1);
    expect(harness.refusals[0]!.waitBudgetMs).toBe(40);
    expect(harness.refusals[0]!.capacity).toBe(1);
    // The refused turn took nothing and left no waiter behind.
    expect(harness.queue.snapshot().depth).toBe(0);
    expect(harness.queue.snapshot().grants).toBe(0);
    releaseSlot(harness, "account", held);
  });

  test("the queue depth is bounded: a burst beyond it is refused immediately, not queued", async () => {
    const harness = queueHarness({ capacity: 1, maxWaiters: 1, waitBudgetMs: 5_000 });
    const held = await holdSlot(harness, "account", "caller-a");
    const waiting = harness.queue.acquire({ accountKey: "account", callerKey: "caller-b", priority: "conversational" });
    await sleep(10);

    await expect(harness.queue.acquire({ accountKey: "account", callerKey: "caller-c", priority: "conversational" }))
      .rejects.toThrow(/queue_full/);
    expect(harness.refusals.at(-1)?.reason).toBe("queue_full");
    expect(harness.refusals.at(-1)?.depth).toBe(1);

    releaseSlot(harness, "account", held);
    (await waiting).abandon();
  });

  test("housekeeping is served before conversational turns waiting for the same slot", async () => {
    const harness = queueHarness({ capacity: 1, waitBudgetMs: 5_000 });
    const held = await holdSlot(harness, "account", "caller-holder");

    const grantedOrder: string[] = [];
    const conversational = harness.queue.acquire({ accountKey: "account", callerKey: "caller-chat", priority: "conversational" })
      .then(ticket => { grantedOrder.push("conversational"); return ticket; });
    const housekeeping = harness.queue.acquire({ accountKey: "account", callerKey: "caller-housekeeping", priority: "housekeeping" })
      .then(ticket => { grantedOrder.push("housekeeping"); return ticket; });
    await sleep(10);

    releaseSlot(harness, "account", held);
    const housekeepingTicket = await housekeeping;
    await sleep(10);
    expect(grantedOrder).toEqual(["housekeeping"]);
    expect(harness.queue.snapshot().depth).toBe(1);

    housekeepingTicket.abandon();
    harness.leases.set("account", 0);
    const conversationalTicket = await conversational;
    expect(grantedOrder).toEqual(["housekeeping", "conversational"]);
    conversationalTicket.abandon();
  });

  test("one caller cannot hold every slot while another caller waits — and the cap lifts when it is alone", async () => {
    const harness = queueHarness({ capacity: 2, maxPerCaller: 1, waitBudgetMs: 5_000 });
    const first = await holdSlot(harness, "account", "caller-a");
    const second = await holdSlot(harness, "account", "caller-b");

    // Caller A queues a second turn before caller B queues its first: FIFO alone would grant A's.
    const aSecond = harness.queue.acquire({ accountKey: "account", callerKey: "caller-a", priority: "conversational" });
    const bFirst = harness.queue.acquire({ accountKey: "account", callerKey: "caller-b", priority: "conversational" });
    await sleep(10);

    releaseSlot(harness, "account", second);
    const bTicket = await bFirst;
    expect(bTicket.callerKey).toBe("caller-b");
    await sleep(10);
    // A is over its fair share while B waits, so A's earlier arrival is skipped — not starved forever.
    expect(harness.queue.snapshot().depth).toBe(1);

    releaseSlot(harness, "account", first);
    const aTicket = await aSecond;
    expect(aTicket.callerKey).toBe("caller-a");

    // Alone, the same caller may use the whole account: the cap exists for contention, not to waste
    // capacity when nobody else is waiting.
    const harnessAlone = queueHarness({ capacity: 2, maxPerCaller: 1, waitBudgetMs: 5_000 });
    const aloneHeld = await holdSlot(harnessAlone, "account", "caller-solo");
    const soloWaiting = harnessAlone.queue.acquire({ accountKey: "account", callerKey: "caller-solo", priority: "conversational" });
    await sleep(10);
    releaseSlot(harnessAlone, "account", aloneHeld);
    const soloGranted = await soloWaiting;
    expect(soloGranted.callerKey).toBe("caller-solo");

    aTicket.abandon();
    bTicket.abandon();
    soloGranted.abandon();
  });

  test("an aborted wait never takes a slot", async () => {
    const harness = queueHarness({ capacity: 1, waitBudgetMs: 5_000 });
    const held = await holdSlot(harness, "account", "caller-a");
    const abort = new AbortController();
    const waiting = harness.queue.acquire({
      accountKey: "account",
      callerKey: "caller-b",
      priority: "conversational",
      signal: abort.signal,
    });
    await sleep(10);
    expect(harness.queue.snapshot().depth).toBe(1);
    abort.abort();

    await expect(waiting).rejects.toThrow(/aborted/i);
    expect(harness.queue.snapshot().depth).toBe(0);
    expect(harness.queue.snapshot().granted).toBe(1);
    releaseSlot(harness, "account", held);
  });

  test("queue depth, wait time and refusals are reported per caller", async () => {
    const harness = queueHarness({ capacity: 1, waitBudgetMs: 5_000 });
    const held = await holdSlot(harness, "account", "caller-holder");
    const waiting = harness.queue.acquire({ accountKey: "account", callerKey: "caller-waiter", priority: "conversational" });
    await sleep(15);

    const deep = harness.queue.snapshot();
    expect(deep.capacity).toBe(1);
    expect(deep.depth).toBe(1);
    expect(deep.maxWaiters).toBe(4);
    expect(deep.callers.find(caller => caller.caller === "caller-waiter")?.depth).toBe(1);

    releaseSlot(harness, "account", held);
    const granted = await waiting;
    const afterGrant = harness.queue.snapshot();
    const waiter = afterGrant.callers.find(caller => caller.caller === "caller-waiter");
    expect(waiter?.granted).toBe(1);
    expect(waiter?.depth).toBe(0);
    expect(waiter?.waitMsTotal).toBeGreaterThanOrEqual(0);
    expect(afterGrant.waitMsMax).toBeGreaterThanOrEqual(0);

    // A refusal is counted against the caller that was refused, not against the queue as a whole.
    const refused = queueHarness({ capacity: 1, waitBudgetMs: 30 });
    const refusedHeld = await holdSlot(refused, "account", "caller-holder");
    await expect(refused.queue.acquire({ accountKey: "account", callerKey: "caller-refused", priority: "conversational" }))
      .rejects.toThrow(/wait_budget_exhausted/);
    const refusedSnapshot = refused.queue.snapshot();
    expect(refusedSnapshot.refused).toBe(1);
    expect(refusedSnapshot.callers.find(caller => caller.caller === "caller-refused")?.refused).toBe(1);
    releaseSlot(refused, "account", refusedHeld);

    granted.abandon();
  });

  test("commit, abandon and release are idempotent, so a cancellation racing a grant cannot leak a slot", async () => {
    const harness = queueHarness({ capacity: 1 });
    const ticket = await harness.queue.acquire({ accountKey: "account", callerKey: "caller-a", priority: "conversational" });
    expect(harness.queue.snapshot().grants).toBe(1);
    ticket.commit();
    ticket.commit();
    expect(harness.queue.snapshot().grants).toBe(0);
    expect(harness.queue.snapshot().active).toBe(1);
    ticket.abandon();
    expect(harness.queue.snapshot().active).toBe(1);
    harness.leases.set("account", 1);
    harness.queue.release(ticket);
    harness.queue.release(ticket);
    harness.queue.release(undefined);
    expect(harness.queue.snapshot().active).toBe(0);
  });

  test("closing the queue refuses every waiter instead of leaving it on a timer", async () => {
    const harness = queueHarness({ capacity: 1, waitBudgetMs: 5_000 });
    const held = await holdSlot(harness, "account", "caller-a");
    const waiting = harness.queue.acquire({ accountKey: "account", callerKey: "caller-b", priority: "conversational" });
    await sleep(10);
    harness.queue.close();
    await expect(waiting).rejects.toThrow(/shut down/i);
    expect(harness.queue.snapshot().depth).toBe(0);
    releaseSlot(harness, "account", held);
  });

  test("the wait budget is configurable, with the production default as the fallback", () => {
    expect(resolveChatGptTurnQueueWaitMs({})).toBe(DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS);
    expect(resolveChatGptTurnQueueWaitMs({ DSH_CHATGPT_WEB_TURN_QUEUE_WAIT_MS: "2500" })).toBe(2_500);
    expect(resolveChatGptTurnQueueWaitMs({ DSH_CHATGPT_WEB_TURN_QUEUE_WAIT_MS: "nope" }))
      .toBe(DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS);
    expect(resolveChatGptTurnQueueWaitMs({ DSH_CHATGPT_WEB_TURN_QUEUE_WAIT_MS: "-3" }))
      .toBe(DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS);
  });
});

// ---------------------------------------------------------------------------------------------------
// Half 2: the real HTTP route, with only the browser I/O replaced.
// ---------------------------------------------------------------------------------------------------

/**
 * A controlled surface that holds every turn until the suite releases it, by run index.
 *
 * Holding is what makes the fan-out bound observable: five turns are genuinely in flight (each owns its
 * lease and its browser run), so the sixth request is a real arrival at a full account rather than a
 * simulated one. The surface also records each submission exactly once, which is what proves a turn that
 * waited was not submitted twice.
 */
class GatedSurface {
  readonly runs: Array<{
    readonly turn: WebSurfaceTurn;
    readonly prompt: string;
    readonly index: number;
    sendAttempts: number;
    confirmedSubmissions: number;
  }> = [];
  readonly submittedOrder: number[] = [];
  maxConcurrent = 0;
  private inFlight = 0;
  private previousConversationKey: string | undefined;
  private readonly releases = new Map<number, () => void>();
  private readonly gates = new Map<number, Promise<void>>();
  private readonly submittedResolvers = new Map<number, () => void>();
  private readonly submittedSignals = new Map<number, Promise<void>>();

  /** Resolves when run `index` (1-based) reaches its confirmed submission. */
  submitted(index: number): Promise<void> {
    let signal = this.submittedSignals.get(index);
    if (!signal) {
      signal = new Promise<void>(resolve => { this.submittedResolvers.set(index, resolve); });
      this.submittedSignals.set(index, signal);
    }
    return signal;
  }

  /** Let run `index` finish. */
  release(index: number): void {
    this.releases.get(index)?.();
  }

  releaseAll(): void {
    for (const release of this.releases.values()) release();
  }

  private gate(index: number): Promise<void> {
    let gate = this.gates.get(index);
    if (!gate) {
      gate = new Promise<void>(resolve => { this.releases.set(index, resolve); });
      this.gates.set(index, gate);
    }
    return gate;
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const index = this.runs.length + 1;
        const reused = turn.conversationKey !== undefined
          && turn.conversationKey === this.previousConversationKey;
        await turn.onPreparedSelected?.(reused);
        const prepare = reused ? turn.prepareResume : turn.prepare;
        if (!prepare) throw new Error("the gated surface was asked to resume without a continuation prompt");
        const compiled = await prepare();
        this.inFlight += 1;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
        try {
          const run = {
            turn,
            prompt: compiled.text,
            index,
            sendAttempts: 0,
            confirmedSubmissions: 0,
          };
          this.runs.push(run);
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `surface-${index}`,
            browserContextId: "controlled-context",
            pageId: `controlled-page-${index}`,
            profileId: "controlled-profile",
            accountId: `chatgpt-account:${CONTROLLED_ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();
          await turn.onSendActivated?.();
          run.sendAttempts += 1;
          turn.onSubmitted?.();
          run.confirmedSubmissions += 1;
          this.submittedOrder.push(index);
          this.submittedResolvers.get(index)?.();
          await this.gate(index);
          this.previousConversationKey = turn.conversationKey;
          turn.onTextDelta(`answer-${index}`);
          return `answer-${index}`;
        } finally {
          compiled.release();
          this.inFlight -= 1;
        }
      },
      async verifyConnector() { return "controlled"; },
      async inspectSession() { return { authenticated: true, temporary: false, url: "https://chatgpt.com" }; },
      async smokeTest() { return { effort: "low", response: "controlled" }; },
      async recoverRetainedAnswer() { throw new Error("no retained answer in the controlled fixture"); },
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

function serve(
  surface: GatedSurface,
  queueOptions: { waitBudgetMs?: number; maxWaiters?: number } = {},
): RunningServer {
  const server = startServer(
    {
      ...defaultConfig(),
      port: 0,
      host: "127.0.0.1",
      controlToken: CONTROL_TOKEN,
    } as never,
    {
      providerCore: new ChatGptWebProviderCore(
        "chatgpt-web",
        new BrowserAccountLeaseRegistry(),
        5_000,
        250,
        queueOptions,
      ),
      adapterFactory: (_provider: unknown, providerCore: ChatGptWebProviderCore) => createChatGptWebAdapter(
        controlledProviderConfig(home),
        { providerCore, surfaceTransport: surface.transport },
      ),
    } as never,
  );
  servers.push(server);
  return server;
}

interface TurnResult {
  readonly status: number;
  readonly content?: string;
  readonly retryAfter?: string | null;
  readonly error?: { readonly message?: string; readonly type?: string; readonly code?: string };
}

async function postTurn(
  server: RunningServer,
  content: string,
  options: { user?: string; purpose?: string } = {},
): Promise<TurnResult> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      connection: "close",
      ...(options.purpose !== undefined ? { "x-dsh-turn-purpose": options.purpose } : {}),
    },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      ...(options.user !== undefined ? { user: options.user } : {}),
      messages: [{ role: "user", content }],
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    ...(payload.error ? { error: payload.error as TurnResult["error"] } : {}),
    ...(choices?.[0]?.message?.content !== undefined ? { content: choices[0]!.message!.content } : {}),
  };
}

async function controlStatus(server: RunningServer): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/control/status`, {
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  return await response.json() as Record<string, unknown>;
}

/** Fill the account with held turns: five distinct conversations, so admission never refuses them. */
async function fillAccount(
  surface: GatedSurface,
  server: RunningServer,
  label: string,
  count = MAX_CHATGPT_BROWSER_TABS,
): Promise<Array<Promise<TurnResult>>> {
  const pending: Array<Promise<TurnResult>> = [];
  for (let index = 1; index <= count; index += 1) {
    pending.push(postTurn(server, `${label} question ${index}`, { user: `${label}-conversation-${index}` }));
  }
  await waitFor(
    () => surface.runs.length >= count && surface.submittedOrder.length >= count,
    `${count} turns to reach the browser`,
  );
  return pending;
}

describe("issue #358 — the bounded queue on the real /v1/chat/completions route", () => {
  test("a sixth concurrent request waits for a slot and completes instead of failing", async () => {
    const surface = new GatedSurface();
    const server = serve(surface);
    const held = await fillAccount(surface, server, "wait");
    expect(surface.runs).toHaveLength(MAX_CHATGPT_BROWSER_TABS);
    expect(surface.maxConcurrent).toBe(MAX_CHATGPT_BROWSER_TABS);

    // The sixth turn arrives at a full account. It must wait, not fail.
    const sixth = postTurn(server, "wait question 6", { user: "wait-conversation-6" });
    await waitFor(async () => {
      const status = await controlStatus(server);
      const queue = status.turnQueue as { depth?: number } | undefined;
      return (queue?.depth ?? 0) >= 1;
    }, "the sixth turn to be queued");
    // Waiting means exactly that: no browser run, and no refusal either.
    expect(surface.runs).toHaveLength(MAX_CHATGPT_BROWSER_TABS);

    // One slot frees: the waiting turn is admitted and runs, in its own conversation.
    surface.release(1);
    const first = await withDeadline(held[0]!);
    expect(first).not.toBe("hung");
    if (first === "hung") return;
    expect(first.status).toBe(200);
    expect(first.content).toBe("answer-1");

    await waitFor(() => surface.runs.length === MAX_CHATGPT_BROWSER_TABS + 1, "the sixth turn to start");
    surface.release(MAX_CHATGPT_BROWSER_TABS + 1);
    const sixthResult = await withDeadline(sixth);
    expect(sixthResult).not.toBe("hung");
    if (sixthResult === "hung") return;
    expect(sixthResult.status).toBe(200);
    expect(sixthResult.content).toBe(`answer-${MAX_CHATGPT_BROWSER_TABS + 1}`);

    // No turn was submitted twice because it waited, and no turn was submitted by a refused one.
    expect(surface.runs).toHaveLength(MAX_CHATGPT_BROWSER_TABS + 1);
    for (const run of surface.runs) {
      expect(run.sendAttempts).toBe(1);
      expect(run.confirmedSubmissions).toBe(1);
    }
    const prompts = surface.runs.map(run => run.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);

    surface.releaseAll();
    const rest = await Promise.all(held.slice(1).map(turn => withDeadline(turn)));
    for (const result of rest) {
      expect(result).not.toBe("hung");
      if (result === "hung") return;
      expect(result.status).toBe(200);
    }
  });

  test("an exhausted wait budget is a typed 429 with Retry-After and a stable code, and the turn never reached the provider", async () => {
    const surface = new GatedSurface();
    const server = serve(surface, { waitBudgetMs: 150 });
    const held = await fillAccount(surface, server, "budget");

    const refused = await withDeadline(postTurn(server, "budget question 6", { user: "budget-conversation-6" }));
    expect(refused).not.toBe("hung");
    if (refused === "hung") return;

    expect(refused.status).toBe(429);
    expect(refused.error?.type).toBe("rate_limit_error");
    expect(refused.error?.code).toBe(CHATGPT_TURN_QUEUE_TIMEOUT_CODE);
    // The deferral hint is the queue's own budget window, in whole seconds.
    expect(refused.retryAfter).toBe("1");
    expect(refused.error?.message).toMatch(/not started/i);
    expect(refused.error?.message).toMatch(/retry after 1 second/i);
    // The refused turn never touched the provider: five runs, no sixth.
    expect(surface.runs).toHaveLength(MAX_CHATGPT_BROWSER_TABS);

    // The refusal is counted for the caller that was refused, and the queue is still serving.
    const status = await controlStatus(server);
    const queue = status.turnQueue as {
      refused?: number;
      capacity?: number;
      depth?: number;
      callers?: Array<{ refused?: number }>;
    };
    expect(queue.capacity).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(queue.refused).toBeGreaterThanOrEqual(1);
    expect(queue.depth).toBe(0);
    expect(queue.callers?.some(caller => (caller.refused ?? 0) >= 1)).toBe(true);

    surface.releaseAll();
    const results = await Promise.all(held.map(turn => withDeadline(turn)));
    for (const result of results) {
      expect(result).not.toBe("hung");
      if (result === "hung") return;
      expect(result.status).toBe(200);
    }
  });

  test("a declared housekeeping turn is served while conversational turns are queued", async () => {
    const surface = new GatedSurface();
    const server = serve(surface);
    const held = await fillAccount(surface, server, "priority");

    // Two conversational turns queue first, then one housekeeping turn.
    const conversational = postTurn(server, "priority conversational", { user: "priority-conversation-chat" });
    const housekeeping = postTurn(server, "priority housekeeping", {
      user: "priority-conversation-housekeeping",
      purpose: "session-title",
    });
    await waitFor(async () => {
      const status = await controlStatus(server);
      const queue = status.turnQueue as { depth?: number } | undefined;
      return (queue?.depth ?? 0) >= 2;
    }, "both turns to be queued");
    expect(surface.runs).toHaveLength(MAX_CHATGPT_BROWSER_TABS);

    // One slot frees: housekeeping wins it even though it arrived last.
    surface.release(1);
    await waitFor(() => surface.runs.length === MAX_CHATGPT_BROWSER_TABS + 1, "the housekeeping turn to start");
    const started = surface.runs.at(-1)!;
    expect(started.prompt).toContain("priority housekeeping");
    expect(surface.submittedOrder.at(-1)).toBe(MAX_CHATGPT_BROWSER_TABS + 1);

    // The conversational turn is still waiting — ordered behind, not starved.
    const status = await controlStatus(server);
    expect((status.turnQueue as { depth?: number }).depth).toBe(1);

    surface.release(MAX_CHATGPT_BROWSER_TABS + 1);
    const housekeepingResult = await withDeadline(housekeeping);
    expect(housekeepingResult).not.toBe("hung");
    if (housekeepingResult === "hung") return;
    expect(housekeepingResult.status).toBe(200);

    // A second slot frees: the conversational turn is admitted.
    surface.release(2);
    await waitFor(() => surface.runs.length === MAX_CHATGPT_BROWSER_TABS + 2, "the conversational turn to start");
    surface.release(MAX_CHATGPT_BROWSER_TABS + 2);
    const conversationalResult = await withDeadline(conversational);
    expect(conversationalResult).not.toBe("hung");
    if (conversationalResult === "hung") return;
    expect(conversationalResult.status).toBe(200);

    surface.releaseAll();
    await Promise.all(held.map(turn => withDeadline(turn)));
  });

  test("queue depth and wait time are observable through the control surface, with no prompt text", async () => {
    const surface = new GatedSurface();
    const server = serve(surface);
    const held = await fillAccount(surface, server, "metrics");

    const waiting = postTurn(server, "metrics secret prompt text", { user: "metrics-conversation-6" });
    await waitFor(async () => {
      const status = await controlStatus(server);
      const queue = status.turnQueue as { depth?: number } | undefined;
      return (queue?.depth ?? 0) >= 1;
    }, "the sixth turn to be queued");

    const status = await controlStatus(server);
    const queue = status.turnQueue as {
      capacity?: number;
      depth?: number;
      activeLeases?: number;
      granted?: number;
      waitBudgetMs?: number;
      retryAfterSeconds?: number;
      callers?: Array<{ caller?: string; depth?: number; active?: number }>;
    };
    expect(queue.capacity).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(queue.activeLeases).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(queue.depth).toBe(1);
    expect(queue.granted).toBeGreaterThanOrEqual(MAX_CHATGPT_BROWSER_TABS);
    expect(queue.waitBudgetMs).toBe(DEFAULT_CHATGPT_TURN_QUEUE_WAIT_MS);
    expect(queue.retryAfterSeconds).toBe(60);
    expect(queue.callers?.some(caller => (caller.depth ?? 0) >= 1)).toBe(true);
    // No prompt text and no raw caller identity: the snapshot is counters and fingerprints only.
    const serialized = JSON.stringify(queue);
    expect(serialized).not.toContain("metrics secret prompt text");
    expect(serialized).not.toContain("metrics-conversation-6");
    for (const caller of queue.callers ?? []) {
      expect(caller.caller).toMatch(/^[0-9a-f]{12}$/);
    }

    surface.release(1);
    await waitFor(() => surface.runs.length === MAX_CHATGPT_BROWSER_TABS + 1, "the waiting turn to start");
    surface.release(MAX_CHATGPT_BROWSER_TABS + 1);
    const result = await withDeadline(waiting);
    expect(result).not.toBe("hung");
    if (result === "hung") return;
    expect(result.status).toBe(200);

    surface.releaseAll();
    await Promise.all(held.map(turn => withDeadline(turn)));
  });

  test("the typed backpressure error is a 429-class refusal, never a provider failure", () => {
    // The vocabulary the bridge classifies, without an HTTP round trip.
    const timeout = chatGptTurnQueueBackpressureError({
      reason: "wait_budget_exhausted",
      retryAfterSeconds: 60,
      waitBudgetMs: 60_000,
      depth: 3,
      capacity: MAX_CHATGPT_BROWSER_TABS,
    });
    expect(timeout.status).toBe(429);
    expect(timeout.errorType).toBe("rate_limit_error");
    expect(timeout.code).toBe(CHATGPT_TURN_QUEUE_TIMEOUT_CODE);
    expect(timeout.retryable).toBe(false);
    expect(timeout.code).not.toBe("upstream_server_error");
    expect(timeout.message).toMatch(/not started/i);

    const full = chatGptTurnQueueBackpressureError({
      reason: "queue_full",
      retryAfterSeconds: 60,
      waitBudgetMs: 60_000,
      depth: 20,
      capacity: MAX_CHATGPT_BROWSER_TABS,
    });
    expect(full.status).toBe(429);
    expect(full.code).toBe(CHATGPT_TURN_QUEUE_FULL_CODE);
    expect(full.message).toMatch(/20 turns waiting/i);
  });
});
