import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CHATGPT_RETAINED_SURFACE_LOST_CODE,
  ChatGptSurfaceStaleError,
  chatGptContinuationPromptMissingError,
  chatGptRetainedSurfaceLostError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  DEFAULT_MAX_RETAINED_SURFACE_RECONCILIATION_ATTEMPTS,
  RetainedSurfaceLostError,
  RetainedSurfaceRegistry,
  retainedSurfaceSettlementForTurn,
  type RetainedSurfacePage,
} from "../src/adapters/chatgpt-web/retained-surface";
import {
  chatGptBrowserTurnRetiresRetainedSurface,
  chatGptBrowserTurnTerminal,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { defaultConfig, saveConfig } from "../src/config";
import { translateChatCompletionsRequest } from "../src/responses/chat-completions";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import { controlledIncoming, controlledProviderConfig } from "./support/chatgpt-web-surface";

/**
 * Issue #314, stage 2 — a failure is not a death.
 *
 * The measured incident: a turn failed *after* its submission was accepted (`11-response-visible` then an
 * `unknown` error) and that failure **retired the conversation's physical surface**, so every later turn of
 * the session got `retained_surface_lost 409`. The failed turn was housekeeping (the session title), and
 * the rule must not depend on recognising housekeeping: this build has no reliable marker for it.
 *
 * The approved rule, in code terms:
 *
 * - a failed turn **marks the conversation as needing reconciliation** (`needsReconciliation`) and leaves
 *   the physical surface in place — a failure, by itself, retires nothing;
 * - the **next turn resumes** that surface (the acquisition reports `reconciling`), so the caller's session
 *   survives;
 * - retirement happens only on **proof of death** (the page is closed/gone) or an **explicit teardown**
 *   (cancellation, a closed tab, the service retiring a wedged turn), or when the bounded reconciliation
 *   budget is spent — and then the caller gets the existing honest continuity-loss error, with the reason
 *   expressed when the retiring operation can express it;
 * - **nothing is resent**: reconciliation hands back the surface that already carries the conversation; it
 *   never creates a replacement and never re-submits a confirmed message. Starting over stays an explicit
 *   caller-visible decision taken by the turn's own continuity path.
 *
 * The first block drives the surface owner directly (deterministic, browser-free). The second drives the
 * real adapter route with only the browser I/O replaced, and it is the one that fails against the
 * retire-then-409 behaviour this change removes. The last block states the boundary of this stage
 * explicitly instead of implying it.
 */

const KEY = "conversation-key-314";
const SESSION = "harness-session-314";

// ---------------------------------------------------------------------------
// The surface owner: what a failed turn does to a retained physical conversation
// ---------------------------------------------------------------------------

interface PhysicalConversation extends RetainedSurfacePage {
  readonly name: string;
  closeCount: number;
  /** Every prompt this physical conversation received, in order — the provider side of "nothing resent". */
  readonly submissions: string[];
  submit(prompt: string): void;
  answer(): string;
  markClosed(): void;
}

function physicalConversation(name: string): PhysicalConversation {
  let closed = false;
  const page: PhysicalConversation = {
    name,
    closeCount: 0,
    submissions: [],
    isClosed: () => closed,
    close: async () => {
      closed = true;
      page.closeCount += 1;
    },
    submit: prompt => { page.submissions.push(prompt); },
    // The conversation answers from the turn that was actually submitted to it.
    answer: () => `answer:${page.submissions.at(-1) ?? "nothing"}`,
    markClosed: () => { closed = true; },
  };
  return page;
}

/** The end of a failed managed-chrome turn, in the worker's own order: release, then settle. */
function failedTurn(registry: RetainedSurfaceRegistry<PhysicalConversation>): void {
  registry.release(KEY);
  registry.settle(KEY, retainedSurfaceSettlementForTurn("failed"));
}

describe("issue #314 — a failed turn marks the conversation instead of retiring it", () => {
  test("the b03 sequence: a failed housekeeping turn, then the user's turn resumes the same conversation and answers", async () => {
    const registry = new RetainedSurfaceRegistry<PhysicalConversation>();
    const page = physicalConversation("page-1");
    let created = 0;
    const acquire = () => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return page;
      },
    });

    // ---- The housekeeping turn: its submission is accepted, then it fails.
    const housekeeping = await acquire();
    expect(housekeeping.created).toBe(true);
    expect(housekeeping.reconciling).toBe(false);
    housekeeping.page.submit("generate the session title");
    failedTurn(registry);

    // The failure is an observable mark, not a death: the surface is still there, still reusable.
    expect(registry.needsReconciliation(KEY)).toBe(true);
    expect(registry.isLost(KEY)).toBe(false);
    expect(registry.has(KEY)).toBe(true);
    expect(registry.isReusable(KEY)).toBe(true);
    expect(page.isClosed()).toBe(false);
    expect(page.closeCount).toBe(0);

    // ---- The user's turn: it is the reconciliation attempt, and it resumes THAT conversation.
    const userTurn = await acquire();
    expect(userTurn.created).toBe(false);
    expect(userTurn.reconciling).toBe(true);
    expect(userTurn.page).toBe(page);
    userTurn.page.submit("pregunta dos");
    expect(userTurn.page.answer()).toBe("answer:pregunta dos");

    // Nothing was created for the reconciling turn: no fork, no replacement conversation.
    expect(created).toBe(1);

    // The settled successful turn clears the mark.
    registry.release(KEY);
    registry.settle(KEY, retainedSurfaceSettlementForTurn("completed"));
    expect(registry.needsReconciliation(KEY)).toBe(false);
    expect(registry.isLost(KEY)).toBe(false);
    expect(registry.isReusable(KEY)).toBe(true);
    expect(page.isClosed()).toBe(false);

    // Nothing was resent: each turn submitted exactly its own message, once, to one conversation.
    expect(page.submissions).toEqual(["generate the session title", "pregunta dos"]);
    expect(page.closeCount).toBe(0);
  });

  test("the mark survives more than one failure and still clears on the first successful turn", async () => {
    const registry = new RetainedSurfaceRegistry<PhysicalConversation>({ maxReconciliationAttempts: 3 });
    const page = physicalConversation("page-1");
    let created = 0;
    const acquire = () => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return page;
      },
    });

    const firstTurn = await acquire();
    firstTurn.page.submit("generate the session title");
    failedTurn(registry);
    expect(registry.needsReconciliation(KEY)).toBe(true);

    // The first reconciliation attempt fails too: the conversation is still marked and still not retired.
    const first = await acquire();
    expect(first.reconciling).toBe(true);
    failedTurn(registry);
    expect(registry.needsReconciliation(KEY)).toBe(true);
    expect(registry.isLost(KEY)).toBe(false);
    expect(page.isClosed()).toBe(false);

    // The second attempt answers: the mark clears and the conversation stays exactly where it was.
    const second = await acquire();
    expect(second.reconciling).toBe(true);
    second.page.submit("pregunta tres");
    registry.release(KEY);
    registry.settle(KEY, retainedSurfaceSettlementForTurn("completed"));
    expect(registry.needsReconciliation(KEY)).toBe(false);
    expect(created).toBe(1);
    expect(page.closeCount).toBe(0);
    expect(page.submissions).toEqual(["generate the session title", "pregunta tres"]);
  });

  test("a page that is genuinely dead is proof of death: the next turn fails closed and the surface is retired", async () => {
    const registry = new RetainedSurfaceRegistry<PhysicalConversation>();
    const page = physicalConversation("page-1");
    const fresh = physicalConversation("page-fresh");
    let created = 0;
    const acquire = (candidate: PhysicalConversation = page) => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return candidate;
      },
    });

    const failed = await acquire();
    failed.page.submit("generate the session title");
    failedTurn(registry);
    expect(registry.needsReconciliation(KEY)).toBe(true);

    // The page dies after the failed turn: that is evidence, and evidence retires.
    page.markClosed();
    const lost = await acquire().catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(RetainedSurfaceLostError);
    expect((lost as RetainedSurfaceLostError).reason).toBe("surface-dead");
    expect(registry.isLost(KEY)).toBe(true);
    expect(registry.has(KEY)).toBe(false);
    expect(registry.isReusable(KEY)).toBe(false);
    expect(registry.needsReconciliation(KEY)).toBe(false);

    // The caller's error is the existing honest continuity loss, with the reason expressed.
    const mapped = chatGptRetainedSurfaceLostError((lost as RetainedSurfaceLostError).reason);
    expect(mapped.code).toBe(CHATGPT_RETAINED_SURFACE_LOST_CODE);
    expect(mapped.status).toBe(409);
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).toContain("surface-dead");

    // Retired means retired: the next turn stays a continuity loss and no replacement page is used.
    await expect(acquire(fresh)).rejects.toBeInstanceOf(RetainedSurfaceLostError);
    expect(created).toBe(1);
    expect(fresh.submissions).toEqual([]);
    expect(fresh.closeCount).toBe(0);
  });

  test("the bounded reconciliation budget retires at the attempt that cannot succeed, with the reason expressed", async () => {
    const registry = new RetainedSurfaceRegistry<PhysicalConversation>({ maxReconciliationAttempts: 2 });
    const page = physicalConversation("page-1");
    let created = 0;
    const acquire = () => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return page;
      },
    });

    const firstTurn = await acquire();
    firstTurn.page.submit("generate the session title");
    failedTurn(registry);
    // Two consecutive reconciliation attempts, each failing the same way.
    expect((await acquire()).reconciling).toBe(true);
    failedTurn(registry);
    expect((await acquire()).reconciling).toBe(true);
    failedTurn(registry);
    expect(registry.needsReconciliation(KEY)).toBe(true);

    // The budget is spent: the third acquire retires the conversation instead of carrying it again.
    const exhausted = await acquire().catch((error: unknown) => error);
    expect(exhausted).toBeInstanceOf(RetainedSurfaceLostError);
    expect((exhausted as RetainedSurfaceLostError).reason).toBe("reconciliation-exhausted");
    expect(registry.isLost(KEY)).toBe(true);
    expect(registry.has(KEY)).toBe(false);
    expect(page.isClosed()).toBe(true);
    expect(page.closeCount).toBe(1);
    // Retiring is not forking: no replacement conversation was ever created.
    expect(created).toBe(1);
    await expect(acquire()).rejects.toBeInstanceOf(RetainedSurfaceLostError);
  });

  test("an explicit teardown keeps its meaning: it retires the surface that published no settlement", async () => {
    const registry = new RetainedSurfaceRegistry<PhysicalConversation>();
    const page = physicalConversation("page-1");
    let created = 0;
    const acquire = () => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return page;
      },
    });

    await acquire();
    registry.release(KEY);
    // The worker's classification: a cancellation/closed tab and a replaced document are teardowns,
    // while the provider turn's own failure is not — that is the rule issue #314 changes.
    expect(chatGptBrowserTurnTerminal(new DOMException("cancelled", "AbortError"))).toBe("aborted");
    expect(chatGptBrowserTurnTerminal(new Error("provider failed after submission"))).toBe("failed");
    expect(chatGptBrowserTurnRetiresRetainedSurface(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(chatGptBrowserTurnRetiresRetainedSurface(new ChatGptSurfaceStaleError("rehydrated"))).toBe(true);
    expect(chatGptBrowserTurnRetiresRetainedSurface(new Error("provider failed after submission"))).toBe(false);
    expect(retainedSurfaceSettlementForTurn("torn-down")).toBe("rejected");
    registry.settle(KEY, retainedSurfaceSettlementForTurn("torn-down"));

    expect(registry.isLost(KEY)).toBe(true);
    expect(page.isClosed()).toBe(true);
    expect(registry.needsReconciliation(KEY)).toBe(false);
    await expect(acquire()).rejects.toBeInstanceOf(RetainedSurfaceLostError);
    expect(created).toBe(1);
  });

  test("the reconciliation budget is a positive bound and the default is above one failure", () => {
    expect(DEFAULT_MAX_RETAINED_SURFACE_RECONCILIATION_ATTEMPTS).toBeGreaterThan(1);
    expect(() => new RetainedSurfaceRegistry({ maxReconciliationAttempts: 0 })).toThrow(TypeError);
    expect(() => new RetainedSurfaceRegistry({ maxReconciliationAttempts: 1.5 })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// The real route: the adapter, with only the browser I/O replaced
// ---------------------------------------------------------------------------

/**
 * The browser I/O of a managed-chrome ChatGPT turn, wrapped in the **production** retained-surface owner.
 *
 * Only the physical page is replaced: the surface lifetime is a real `RetainedSurfaceRegistry`, acquired
 * and settled in the worker's own order (acquire for the turn's conversationKey, run the turn, publish the
 * settlement its outcome produces). A tombstoned key therefore becomes the real
 * `retained_surface_lost` adapter error — which is exactly what lets this block fail against the
 * retire-then-409 behaviour it fixes, rather than merely describe it.
 */
class ManagedSurfaceFixture {
  readonly registry = new RetainedSurfaceRegistry<PhysicalConversation>();
  readonly pages: PhysicalConversation[] = [];
  readonly runs: Array<{ prompt: string; reused: boolean; key: string | undefined }> = [];
  private readonly plans: Array<{ answer?: string; error?: Error }> = [];

  enqueue(plan: { answer?: string; error?: Error }): void {
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
      async close() {},
    } as unknown as ChatGptWebSurfaceTransport;
  }

  private async runTurn(turn: WebSurfaceTurn): Promise<string> {
    const plan = this.plans.shift() ?? {};
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
    const reused = retained !== undefined && !retained.created;
    await turn.onPreparedSelected?.(reused);
    const prepare = reused ? turn.prepareResume : turn.prepare;
    if (!prepare) throw chatGptContinuationPromptMissingError();
    const compiled = await prepare();
    this.runs.push({ prompt: compiled.text, reused, key });
    retained?.page.submit(compiled.text);
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
      await turn.onSendActivated?.();
      turn.onSubmitted?.();
      if (plan.error) throw plan.error;
      const answer = plan.answer ?? "controlled answer";
      turn.onTextDelta(answer);
      return answer;
    } catch (error) {
      failed = true;
      tornDown = chatGptBrowserTurnRetiresRetainedSurface(error);
      throw error;
    } finally {
      compiled.release();
      if (retained !== undefined && key !== undefined) {
        this.registry.release(key);
        this.registry.settle(
          key,
          retainedSurfaceSettlementForTurn(!failed ? "completed" : tornDown ? "torn-down" : "failed"),
        );
      }
    }
  }
}

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-314-", { clearFreeHome: true });
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
    model: "chatgpt-web/luna",
    messages: messages.map(message => ({ role: message.role, content: message.content })),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ dsh_session_id: SESSION }) },
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

describe("issue #314 — the real route: a failed turn does not kill the caller's session", () => {
  test("the failed turn's surface survives, the user's next turn continues it, and nothing is resent", async () => {
    const fixture = new ManagedSurfaceFixture();
    // The housekeeping/first turn submits, then fails. The user's turn answers.
    fixture.enqueue({ error: new Error("provider failed after submission") });
    fixture.enqueue({ answer: "respuesta dos" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    const failed = await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    expect(codeOf(failed)).toBe("chatgpt_submitted_turn_failed");

    const key = fixture.surfaceKey!;
    expect(key).toBeDefined();
    // The failure marked the conversation and left the one physical page in place.
    expect(fixture.registry.needsReconciliation(key)).toBe(true);
    expect(fixture.registry.isLost(key)).toBe(false);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.pages[0]!.isClosed()).toBe(false);

    const second = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));

    // The session survives: the user's turn answers, on the same physical conversation.
    expect(codeOf(second)).toBeUndefined();
    expect(answerOf(second)).toBe("respuesta dos");
    expect(fixture.runs).toHaveLength(2);
    expect(fixture.runs[1]!.key).toBe(key);
    expect(fixture.runs[1]!.reused).toBe(true);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    expect(fixture.registry.isLost(key)).toBe(false);

    // Nothing is resent: the provider received the failed turn's message exactly once, and the next turn
    // carried only its own new human message.
    expect(fixture.pages[0]!.submissions).toHaveLength(2);
    expect(fixture.pages[0]!.submissions[1]).not.toContain("pregunta uno");
    expect(fixture.pages[0]!.submissions[1]).toContain("pregunta dos");
  });

  test("and the session keeps working after that: a third turn continues the same conversation", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ error: new Error("provider failed after submission") });
    fixture.enqueue({ answer: "respuesta dos" });
    fixture.enqueue({ answer: "respuesta tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    const second = await runTurn(target, apiTurn([
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

    expect(answerOf(second)).toBe("respuesta dos");
    expect(answerOf(third)).toBe("respuesta tres");
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.runs.map(run => run.reused)).toEqual([false, true, true]);
    expect(fixture.registry.isLost(fixture.surfaceKey!)).toBe(false);
  });

  /**
   * The boundary of stage 2, stated rather than implied.
   *
   * In an *established* conversation the provider's verdict is `resumable` (its initialization fingerprint
   * is installed), so the turn asks the WebChat Core to `continue` — and the core refuses, because the last
   * attempt on that conversation was never confirmed and "the provider must reconcile it before it can be
   * resumed" (#190). That refusal is a **core continuity** decision, taken before the retained surface is
   * ever touched: stage 2 removes the surface-level 409, but it does not make an unconfirmed conversation
   * resumable again. Doing that honestly needs stage 3's structural inspection (does the conversation
   * actually hold the reply?) — the surface merely being alive is not proof that its content is coherent,
   * and adopting it on that basis would be the inference the plan forbids.
   */
  test("stated boundary: a failed turn in an ESTABLISHED conversation is still refused by the core, not by the surface", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "uno" });
    fixture.enqueue({ error: new Error("provider failed after submission") });
    fixture.enqueue({ answer: "tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    const failed = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    expect(codeOf(failed)).toBe("chatgpt_submitted_turn_failed");

    // The surface part of the rule did work: the conversation is marked, not retired.
    const key = fixture.surfaceKey!;
    expect(fixture.registry.needsReconciliation(key)).toBe(true);
    expect(fixture.registry.isLost(key)).toBe(false);

    // The next turn is refused before the surface: the core demands a reconciliation this stage cannot
    // provide, so the boundary is a core continuation decision, not a lost retained surface.
    const refused = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ])).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(Error);
    expect((refused as { category?: string }).category).toBe("CONVERSATION_STATE_MISMATCH");
    expect((refused as Error).message).toContain("never confirmed");
    // Nothing reached the provider and no surface was retired or replaced.
    expect(fixture.runs).toHaveLength(2);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.registry.isLost(key)).toBe(false);
  });
});
