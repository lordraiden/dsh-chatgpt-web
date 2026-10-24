/**
 * Conversation admission — a short-lived conflict stops being fatal, and a refusal stops poisoning the
 * conversation (issue #305 follow-up).
 *
 * Measured on the real deployment: a DSH harness's session-title call and the user's first message
 * share one provider conversation (identity = session id), the title wins the race, and the user's turn
 * is refused in ~0 ms with `retained_surface_busy` /
 * `Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not
 * allowed.` Two fresh sessions failed this way, and the refusal left the conversation unusable: the
 * next attempt failed with "the last attempt on this conversation was never confirmed; the provider
 * must reconcile it before it can be resumed", because the refused turn's continuity decision had
 * already run — a replay had advanced the generation and written an unconfirmed record — before
 * admission refused it.
 *
 * Two owners are exercised here, both through the real turn path (identity resolution, the continuity
 * decision, the provider core, the durable store and settlement) with only the browser I/O replaced:
 *
 * 1. admission (`ChatGptWebProviderCore` over the shared conversation-admission owner): one slot per
 *    native DSH thread, waited for with a bounded, cancellable, event-driven wait. A transient overlap
 *    is absorbed; a genuine one still fails closed with #305's own refusal once the shared 60 s bound
 *    (the harness session-title deadline) expires.
 * 2. the continuity decision (`webChatContinuity.resolveRecovery`): it must run *after* admission, so
 *    a refused turn leaves continuity exactly as it was and the retry can proceed.
 *
 * Deterministic and browser-free: the bound is injected (a constructor seam) or moved with fake timers,
 * the blocker is released by the test, and the durable store is a real file whose bytes are compared
 * across the refusal.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHATGPT_RETAINED_SURFACE_BUSY_CODE,
  ChatGptWebAdapterError,
  chatGptRetainedSurfaceBusyError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import { BrowserAccountLeaseRegistry, ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { defaultConfig, saveConfig } from "../src/config";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { DEFAULT_TRANSPORT_ADMISSION_WAIT_MS } from "../src/web-chat/transport";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  CONTROLLED_ACCOUNT,
  controlledIncoming,
  controlledProviderConfig,
} from "./support/chatgpt-web-surface";

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("conversation-admission-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

/** A bound short enough to make an expiry test fast, and long enough not to race a single timer. */
const EXPIRY_BOUND_MS = 120;
/** A bound comfortably above any work this suite does, for the "the wait succeeds" cases. */
const GENEROUS_BOUND_MS = 5_000;

/** One identity for every turn: the measured shape is one conversation shared by two turns. */
const SESSION_ID = "admission-session";
const THREAD_ID = "admission-thread";

/** A minimal DSH-shaped request the adapter accepts, on one shared conversation identity. */
function turnRequest(turnId: string, text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    context: {
      systemPrompt: ["eres un asistente"],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: { dshSessionId: SESSION_ID, threadId: THREAD_ID, turnId },
  } as unknown as CodexParsedRequest;
}

/**
 * The controlled browser I/O.
 *
 * The FIRST browser run of the fixture confirms its submission and then holds until the test opens the
 * gate, which is exactly the shape the measured race had: a turn that is genuinely in flight while a
 * second request for the same conversation arrives.
 */
class GatedSurface {
  readonly runs: Array<{ readonly prompt: string }> = [];
  private readonly retained = new Set<string>();
  private releaseFirst!: () => void;
  private readonly firstGate = new Promise<void>(resolve => { this.releaseFirst = resolve; });
  private readonly firstSubmittedPromise: Promise<void>;
  private firstSubmittedResolve!: () => void;

  constructor() {
    this.firstSubmittedPromise = new Promise<void>(resolve => { this.firstSubmittedResolve = resolve; });
  }

  /** Resolves once the held turn has reached its confirmed submission. */
  get submitted(): Promise<void> {
    return this.firstSubmittedPromise;
  }

  /** Let the held turn finish. */
  open(): void {
    this.releaseFirst();
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const index = this.runs.length + 1;
        const reused = turn.conversationKey !== undefined && this.retained.has(turn.conversationKey);
        await turn.onPreparedSelected?.(reused);
        const prepare = reused && turn.prepareResume ? turn.prepareResume : turn.prepare;
        if (!prepare) throw new Error("the admission fixture was asked to resume without a prompt");
        const compiled = await prepare();
        this.runs.push({ prompt: compiled.text });
        try {
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `admission-surface-${index}`,
            browserContextId: "admission-context",
            pageId: `admission-page-${index}`,
            profileId: "admission-profile",
            accountId: `chatgpt-account:${CONTROLLED_ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();
          await turn.onSendActivated?.();
          turn.onSubmitted?.();
          if (index === 1) {
            this.firstSubmittedResolve();
            await this.firstGate;
          }
          if (turn.conversationKey !== undefined) this.retained.add(turn.conversationKey);
          const answer = `answer-${index}`;
          turn.onTextDelta(answer);
          return answer;
        } finally {
          compiled.release();
        }
      },
      async verifyConnector() { return "controlled"; },
      async inspectSession() { return { authenticated: true, temporary: false, url: "https://chatgpt.com" }; },
      async smokeTest() { return { effort: "low", response: "controlled" }; },
      async recoverRetainedAnswer() { throw new Error("no retained answer in the admission fixture"); },
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

function admissionCore(leases: BrowserAccountLeaseRegistry, busyWaitMs: number): ChatGptWebProviderCore {
  return new ChatGptWebProviderCore("chatgpt-web", leases, 5_000, busyWaitMs);
}

function adapterFor(core: ChatGptWebProviderCore, surface: GatedSurface) {
  return createChatGptWebAdapter(controlledProviderConfig(home), {
    providerCore: core,
    surfaceTransport: surface.transport,
  });
}

type Adapter = ReturnType<typeof adapterFor>;

async function runTurn(adapter: Adapter, request: CodexParsedRequest, signal?: AbortSignal): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn(request, controlledIncoming(signal), event => events.push(event));
  return events;
}

/** Run a turn and report its outcome instead of letting an expected refusal reject the test. */
async function outcome<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return work.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** Run a turn that must answer; a rejection fails the test with its own error. */
async function answered(work: Promise<AdapterEvent[]>): Promise<AdapterEvent[]> {
  const settled = await outcome(work);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

const finalText = (events: readonly AdapterEvent[]) =>
  events.filter(event => event.type === "text_delta").map(event => (event as { text: string }).text).join("");

const errorEvents = (events: readonly AdapterEvent[]) =>
  events.filter((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");

/** The typed refusal this provider publishes for a conversation another turn is using (issue #305). */
function assertBusyRefusal(error: unknown): ChatGptWebAdapterError {
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  const typed = error as ChatGptWebAdapterError;
  expect(typed.code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
  expect(typed.code).toBe(chatGptRetainedSurfaceBusyError().code);
  expect(typed.status).toBeLessThan(500);
  expect(typed.message).toBe(chatGptRetainedSurfaceBusyError().message);
  expect(typed.message).toMatch(/Another turn is already using this ChatGPT Web conversation/);
  return typed;
}

describe("a transient conversation conflict is waited out, not refused", () => {
  test("a would-be-refused turn waits, the blocker finishes, and the waiting turn then runs and answers", async () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = admissionCore(leases, GENEROUS_BOUND_MS);
    const surface = new GatedSurface();
    const adapter = adapterFor(core, surface);

    // Turn 1 is admitted, reaches its submission and is held there: a turn genuinely in flight.
    const first = runTurn(adapter, turnRequest("turn-1", "primera"));
    await surface.submitted;

    // Turn 2 is the same conversation. It must WAIT for the slot, not be refused in ~0 ms — and it
    // must not reach the browser while turn 1 holds it.
    const second = runTurn(adapter, turnRequest("turn-2", "segunda"));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(core.conversationWaiterCount()).toBe(1);
    expect(surface.runs).toHaveLength(1);

    // The blocker retires; the waiting turn takes the slot and answers.
    surface.open();
    const [firstEvents, secondEvents] = await Promise.all([answered(first), answered(second)]);
    expect(errorEvents(firstEvents)).toHaveLength(0);
    expect(finalText(firstEvents)).toBe("answer-1");
    expect(errorEvents(secondEvents)).toHaveLength(0);
    expect(finalText(secondEvents)).toBe("answer-2");
    expect(surface.runs).toHaveLength(2);
    // The wait ended with the release, not with the bound.
    expect(core.conversationWaiterCount()).toBe(0);
    expect(leases.activeCount()).toBe(0);
  });

  test("the wait is bounded: after the bound the same honest refusal is published, and nothing else changes", async () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = admissionCore(leases, EXPIRY_BOUND_MS);
    const surface = new GatedSurface();
    const adapter = adapterFor(core, surface);

    const first = runTurn(adapter, turnRequest("turn-1", "primera"));
    await surface.submitted;

    // Two real turns, neither housekeeping: this is genuine contention, and it is still refused.
    const startedAt = Date.now();
    const refused = await outcome(runTurn(adapter, turnRequest("turn-2", "segunda")));
    const elapsed = Date.now() - startedAt;

    expect(refused.ok).toBe(false);
    assertBusyRefusal(refused.ok ? undefined : refused.error);
    // Refused *after* the bound, never instantly.
    expect(elapsed).toBeGreaterThanOrEqual(EXPIRY_BOUND_MS - 10);
    // Nothing else changed: the refused turn never ran, no wait or lease is left behind, and the
    // holder is untouched.
    expect(surface.runs).toHaveLength(1);
    expect(core.conversationWaiterCount()).toBe(0);
    expect(leases.activeCount()).toBe(1);

    surface.open();
    const firstEvents = await answered(first);
    expect(errorEvents(firstEvents)).toHaveLength(0);
    expect(finalText(firstEvents)).toBe("answer-1");
    expect(leases.activeCount()).toBe(0);
  });

  test("the wait is cancelled by the caller's abort, leaving no timer and no lease behind", async () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = admissionCore(leases, GENEROUS_BOUND_MS);
    const surface = new GatedSurface();
    const adapter = adapterFor(core, surface);

    const first = runTurn(adapter, turnRequest("turn-1", "primera"));
    await surface.submitted;

    const controller = new AbortController();
    const waiting = runTurn(adapter, turnRequest("turn-2", "segunda"), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(core.conversationWaiterCount()).toBe(1);

    const abortedAt = Date.now();
    controller.abort();
    const cancelled = await outcome(waiting);
    expect(cancelled.ok).toBe(false);
    expect((cancelled.ok ? undefined : cancelled.error)).toMatchObject({ name: "AbortError" });
    // Cancelled immediately (the bound is 5 s), with the waiter and its timer gone.
    expect(Date.now() - abortedAt).toBeLessThan(GENEROUS_BOUND_MS / 2);
    expect(core.conversationWaiterCount()).toBe(0);
    // The cancelled turn never acquired a lease of its own.
    expect(leases.activeCount()).toBe(1);
    expect(surface.runs).toHaveLength(1);

    surface.open();
    expect(finalText(await answered(first))).toBe("answer-1");
    expect(leases.activeCount()).toBe(0);
  });
});

describe("a refusal that never executed leaves continuity untouched", () => {
  test("the refused turn writes nothing, and a retry after the pure refusal succeeds", async () => {
    const file = join(home, "conversations.json");
    const leases = new BrowserAccountLeaseRegistry();
    const core = admissionCore(leases, EXPIRY_BOUND_MS);
    const surface = new GatedSurface();
    const adapter = adapterFor(core, surface);
    const store = resolveNativeChatGptContinuityStore();

    // Turn 1: a first turn on the conversation. Its continuity decision has already recorded the
    // conversation and left it unconfirmed — exactly the state the measured deployment had when the
    // title call won the race.
    const first = runTurn(adapter, turnRequest("turn-1", "primera"));
    await surface.submitted;
    const beforeRecords = await store.list();
    expect(beforeRecords).toHaveLength(1);
    expect(beforeRecords[0]?.checkpoint).toBe("unconfirmed");
    const beforeBytes = readFileSync(file, "utf8");

    // Turn 2 is refused at admission. It never ran, so it must not have taken a continuity decision:
    // no generation bump, no rewritten checkpoint, nothing that the next attempt could read as "the
    // last attempt was never confirmed".
    const refused = await outcome(runTurn(adapter, turnRequest("turn-2", "segunda")));
    expect(refused.ok).toBe(false);
    assertBusyRefusal(refused.ok ? undefined : refused.error);
    // The refusal is the conversation-busy category and message, never the continuity state an
    // un-run attempt would have produced.
    const typed = refused.ok ? undefined : refused.error as ChatGptWebAdapterError;
    expect(typed?.message).not.toMatch(/never confirmed|reconcile it before it can be resumed/i);
    expect(await store.list()).toEqual(beforeRecords);
    expect(readFileSync(file, "utf8")).toBe(beforeBytes);
    expect(readFileSync(file, "utf8")).toContain('"checkpoint": "unconfirmed"');
    expect(surface.runs).toHaveLength(1);

    // The blocker settles and confirms its own turn.
    surface.open();
    expect(finalText(await answered(first))).toBe("answer-1");
    expect((await store.list())[0]?.checkpoint).toBe("confirmed");

    // The retry the refusal used to poison proceeds, and answers in the same conversation.
    const retryEvents = await answered(runTurn(adapter, turnRequest("turn-3", "tercera")));
    expect(errorEvents(retryEvents)).toHaveLength(0);
    expect(finalText(retryEvents)).toBe("answer-2");
    expect(surface.runs).toHaveLength(2);
  });
});

/**
 * The reported case — the ChatGPT counterpart of #336, operator report on `chatgpt-web/think`: the
 * harness's session-title call is *undeclared* on the wire, so it takes the same conversation as the
 * user's real turn and holds it for as long as the title generation takes. The measured example in this
 * project took **1 m 5 s**, and the old provider bound was 30 s — so the title outlived the bound and
 * the user's turn was refused, exactly as the operator saw:
 *
 *   Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not
 *   allowed.
 *
 * The rule: a housekeeping call must never make a user's turn fail. The admission wait is the shared
 * transport's measured housekeeping deadline, so the title's own 60 s cancellation — never this bound —
 * decides when it stops. This test drives the production default (no bound injected) and moves the clock
 * deterministically, so it fails on the 30 s tree at the 30 s mark and passes once the wait is the shared
 * 60 s one.
 */
describe("the reported case: a slow undeclared session-title call cannot fail the user's turn", () => {
  /** Flush pending microtasks without relying on a clock, since the clock here is fake. */
  async function flushMicrotasks(rounds = 25): Promise<void> {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  }

  test("the ChatGPT admission uses the shared transport's measured housekeeping deadline", () => {
    // The shared transport chose this from the harness's own session-title deadline (`timeoutMs: 60000`).
    // ChatGPT composes the same owner and the same number; there is no second bound to drift.
    expect(DEFAULT_TRANSPORT_ADMISSION_WAIT_MS).toBe(60_000);
  });

  test("a title call holding the conversation past the old 30 s bound is waited out, then the user's turn answers", async () => {
    jest.useFakeTimers();
    const leases = new BrowserAccountLeaseRegistry();
    // No injected bound: this is the shipped default, and the assertion is about that default.
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const surface = new GatedSurface();
    const adapter = adapterFor(core, surface);
    let title: Promise<AdapterEvent[]> | undefined;
    let user: Promise<AdapterEvent[]> | undefined;

    try {
      // The harness's undeclared housekeeping call: indistinguishable from a real turn, so it takes the
      // conversation (same session/thread identity) and is held at its confirmed submission.
      title = runTurn(adapter, turnRequest(
        "title-turn",
        "Generate the session title from this JSON array of human messages: []",
      ));
      title.catch(() => undefined);
      await surface.submitted;
      expect(surface.runs).toHaveLength(1);

      // The operator's real message arrives while the title still owns the conversation.
      user = runTurn(adapter, turnRequest("turn-1", "hola"));
      user.catch(() => undefined);
      await flushMicrotasks();
      expect(core.conversationWaiterCount()).toBe(1);
      // Waiting is a wait, not a second browser turn: exclusivity is unchanged.
      expect(surface.runs).toHaveLength(1);

      // Past the OLD 30 s bound: the user's turn is still waiting. On the old tree it had already been
      // refused here, which is the reported failure.
      jest.advanceTimersByTime(30_001);
      await flushMicrotasks();
      expect(core.conversationWaiterCount()).toBe(1);
      expect(leases.activeCount()).toBe(1);

      // The measured 1 m 5 s title lives past 45 s too; the shared bound (60 s) still has not expired.
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(core.conversationWaiterCount()).toBe(1);

      // Release the title: the user's turn is admitted and answers, never refused, never concurrent.
      jest.useRealTimers();
      surface.open();
      const [titleEvents, userEvents] = await Promise.all([answered(title), answered(user)]);
      expect(errorEvents(titleEvents)).toHaveLength(0);
      expect(errorEvents(userEvents)).toHaveLength(0);
      expect(finalText(userEvents)).toBe("answer-2");
      expect(surface.runs).toHaveLength(2);
      expect(core.conversationWaiterCount()).toBe(0);
      expect(leases.activeCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      surface.open();
      await Promise.allSettled([title, user].filter((work): work is Promise<AdapterEvent[]> => work !== undefined));
    }
  });

  test("a genuine conflict that outlives the shared 60 s bound still refuses with #305's category and sentence", async () => {
    jest.useFakeTimers();
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const surface = new GatedSurface();
    const adapter = adapterFor(core, surface);
    let title: Promise<AdapterEvent[]> | undefined;
    let user: Promise<AdapterEvent[]> | undefined;

    try {
      // Two real turns, neither housekeeping: genuine contention, not a transient overlap.
      title = runTurn(adapter, turnRequest("turn-1", "primera"));
      title.catch(() => undefined);
      await surface.submitted;

      user = runTurn(adapter, turnRequest("turn-2", "segunda"));
      user.catch(() => undefined);
      await flushMicrotasks();
      expect(core.conversationWaiterCount()).toBe(1);

      // Still waiting one millisecond before the shared housekeeping deadline...
      jest.advanceTimersByTime(DEFAULT_TRANSPORT_ADMISSION_WAIT_MS - 1);
      await flushMicrotasks();
      expect(core.conversationWaiterCount()).toBe(1);

      // ...and refused exactly at it, with the same typed local refusal (issue #305): never a 5xx
      // "provider failed", never a different sentence.
      jest.advanceTimersByTime(2);
      await flushMicrotasks();
      const refused = await outcome(user);
      expect(refused.ok).toBe(false);
      assertBusyRefusal(refused.ok ? undefined : refused.error);
      expect(core.conversationWaiterCount()).toBe(0);
      // The refused turn never reached the browser, and the holder is untouched.
      expect(surface.runs).toHaveLength(1);
      expect(leases.activeCount()).toBe(1);

      jest.useRealTimers();
      surface.open();
      const titleEvents = await answered(title);
      expect(errorEvents(titleEvents)).toHaveLength(0);
      expect(finalText(titleEvents)).toBe("answer-1");
      expect(leases.activeCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      surface.open();
      await Promise.allSettled([title, user].filter((work): work is Promise<AdapterEvent[]> => work !== undefined));
    }
  });
});
