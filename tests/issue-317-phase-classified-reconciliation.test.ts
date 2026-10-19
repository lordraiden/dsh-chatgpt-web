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
  type RetainedSurfaceSubmissionPhase,
  type RetainedSurfaceTurnEnd,
} from "../src/adapters/chatgpt-web/retained-surface";
import {
  reconcileRetainedConversation,
  type ChatGptRetainedAttempt,
} from "../src/adapters/chatgpt-web/retained-coherence";
import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type {
  ChatGptWebSurfaceTransport,
  WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";
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
 * Issue #317, stage 1 — a failed turn is classified by its **phase** before it spends anything.
 *
 * Stage 2 (`#314`, `issue-314-failed-turn-reconciliation.test.ts`) stopped a failed turn from retiring
 * the conversation: it published `unreconciled`, kept the surface and made the next turn its bounded
 * reconciliation attempt. But it did that for **every** failure. A failure that never reached the
 * provider — the composer never sent, the page was never ready — was marked and started spending the
 * caller's reconciliation budget even though nothing was submitted and a retry is perfectly safe.
 *
 * The approved rule, in code terms:
 *
 * - **pre-submission** (the attempt never confirmed a submission): the conversation is **not** marked,
 *   `needsReconciliation` stays false, no reconciliation budget is spent, and the retry is an ordinary
 *   continuation governed by the pre-existing retry layer. The settlement is `not_started`;
 * - **post-submission** (the attempt confirmed its submission): exactly stage 2/3 — the conversation is
 *   marked, the next turn reconciles it in place, nothing is ever resent, and the bounded budget retires
 *   it as `reconciliation-exhausted` when it is spent;
 * - the phase is **structural** and is the stage-3 attempt record's own presence: it is written at send
 *   activation and cleared by the acquire that starts the next attempt, so it answers "did this attempt
 *   reach ChatGPT?" from provider state — never from the failure's message, the prompt, a timer, or any
 *   other heuristic.
 *
 * The first block drives the rule directly, the second drives the real surface owner, and the third
 * drives the **real adapter route** with only the browser I/O replaced — over the production
 * retained-surface owner, the production classifier and the production reconciliation probe. The
 * pre-submission assertions in the second and third blocks are the ones that fail against the current
 * tree: there, a pre-submission failure still marks the conversation and starts consuming the budget.
 */

const KEY_SESSION = "harness-session-317";
const MODEL = "chatgpt-web/luna";
const KEY = "conversation-key-317";

// ---------------------------------------------------------------------------
// The rule: the failure's phase decides the settlement
// ---------------------------------------------------------------------------

describe("issue #317 stage 1 — the settlement of a failure is its phase", () => {
  test("a failure that never confirmed its submission is not a reconciliation mark", () => {
    // Nothing reached the provider: the surface is reusable, the conversation is not marked, and the
    // reconciliation budget is untouched because the settlement that opens the mark never happens.
    expect(retainedSurfaceSettlementForTurn("failed", "unconfirmed")).toBe("not_started");
  });

  test("a failure whose submission was confirmed keeps the stage-2 mark", () => {
    expect(retainedSurfaceSettlementForTurn("failed", "confirmed")).toBe("unreconciled");
  });

  test("completion and an explicit teardown are decided by the turn's end, whatever the phase", () => {
    for (const phase of ["confirmed", "unconfirmed"] as const) {
      // The phase only discriminates a plain failure; it can never turn a completion into a mark or an
      // explicit teardown into a reusable surface (issues #301/#305 keep their meaning).
      expect(retainedSurfaceSettlementForTurn("completed", phase)).toBe("fulfilled");
      expect(retainedSurfaceSettlementForTurn("torn-down", phase)).toBe("rejected");
    }
  });

  test("the decision is a total function of exactly two structural facts, and carries no message", () => {
    const ends: RetainedSurfaceTurnEnd[] = ["completed", "failed", "torn-down"];
    const phases: RetainedSurfaceSubmissionPhase[] = ["confirmed", "unconfirmed"];
    const table = ends.flatMap(end => phases.map(submission => [
      end,
      submission,
      retainedSurfaceSettlementForTurn(end, submission),
    ]));

    // The whole decision is this table: no third input can change it, so it cannot be reading a
    // message, a clock or a heuristic — there is nowhere for one to enter.
    expect(table).toEqual([
      ["completed", "confirmed", "fulfilled"],
      ["completed", "unconfirmed", "fulfilled"],
      ["failed", "confirmed", "unreconciled"],
      ["failed", "unconfirmed", "not_started"],
      ["torn-down", "confirmed", "rejected"],
      ["torn-down", "unconfirmed", "rejected"],
    ]);

    // The phase is a required input, never a defaulted one: `length` is 2, so no default value can
    // silently classify a failure (and the call sites cannot omit it).
    expect(retainedSurfaceSettlementForTurn.length).toBe(2);

    // And the seam has no room for the caller's text: the phase is a closed two-value union, so a prompt
    // cannot be passed where the confirmation fact goes.
    // @ts-expect-error — a caller's message is not a submission phase.
    retainedSurfaceSettlementForTurn("failed", "pregunta dos");
  });
});

// ---------------------------------------------------------------------------
// The surface owner: the mark and the budget follow the phase
// ---------------------------------------------------------------------------

interface PhasePage extends RetainedSurfacePage {
  closeCount: number;
  markClosed(): void;
}

function phasePage(): PhasePage {
  let closed = false;
  const page: PhasePage = {
    closeCount: 0,
    isClosed: () => closed,
    close: async () => {
      closed = true;
      page.closeCount += 1;
    },
    markClosed: () => { closed = true; },
  };
  return page;
}

/**
 * The end of one turn, in the worker's own order and through the worker's own classifier: release, then
 * settle, with the phase read structurally from the registry's own attempt record — exactly as the
 * browser worker reads it (through {@link RetainedSurfaceRegistry.submissionConfirmed}, which is the
 * record's presence). A test that wants a post-submission failure records the attempt (the send was
 * activated); one that wants a pre-submission failure does not.
 */
function endTurn<P extends RetainedSurfacePage, R>(
  registry: RetainedSurfaceRegistry<P, R>,
  key: string,
  end: RetainedSurfaceTurnEnd,
): void {
  registry.release(key);
  registry.settle(key, retainedSurfaceSettlementForTurn(
    end,
    registry.attemptRecord(key) === undefined ? "unconfirmed" : "confirmed",
  ));
}

describe("issue #317 stage 1 — a pre-submission failure spends no reconciliation budget", () => {
  test("a pre-submission failure never marks, however often it repeats, with a budget of one", async () => {
    // The budget is deliberately 1: if a pre-submission failure marked the conversation, the second
    // carry would spend the budget and the third acquire would retire the conversation as
    // `reconciliation-exhausted`. It must not: nothing was submitted, so there is nothing to carry.
    const registry = new RetainedSurfaceRegistry<PhasePage>({ maxReconciliationAttempts: 1 });
    const page = phasePage();
    let created = 0;
    const acquire = () => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return page;
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const turn = await acquire();
      expect(turn.created).toBe(attempt === 0);
      // The retry is an ordinary continuation, never a reconciliation carry.
      expect(turn.reconciling).toBe(false);
      endTurn(registry, KEY, "failed");
      // Nothing was sent, so the conversation is not marked and the budget of one is never touched: a
      // pre-submission failure would have to be carried to spend it, and it never is.
      expect(registry.needsReconciliation(KEY)).toBe(false);
      expect(registry.isLost(KEY)).toBe(false);
      expect(registry.isReusable(KEY)).toBe(true);
      expect(page.isClosed()).toBe(false);
      // The phase fact itself says the attempt never activated a send.
      expect(registry.submissionConfirmed(KEY)).toBe(false);
    }

    expect(created).toBe(1);
    expect(page.closeCount).toBe(0);
  });

  test("a post-submission failure marks, is carried once, and exhaustion retires with its own reason", async () => {
    const registry = new RetainedSurfaceRegistry<PhasePage, ChatGptRetainedAttempt>({
      maxReconciliationAttempts: 1,
    });
    const page = phasePage();
    let created = 0;
    const acquire = () => registry.acquire(KEY, {
      required: false,
      create: async () => {
        created += 1;
        return page;
      },
    });

    const first = await acquire();
    expect(first.reconciling).toBe(false);
    // The send was activated: the attempt record exists, which is what makes the phase "confirmed".
    registry.recordAttempt(KEY, { userTurns: ["conversation-turn-user-1"], responseTurns: [] });
    endTurn(registry, KEY, "failed");
    expect(registry.needsReconciliation(KEY)).toBe(true);
    expect(registry.isLost(KEY)).toBe(false);
    expect(page.isClosed()).toBe(false);

    // The next turn is the bounded reconciliation attempt: the carry — not the failure — is what spends
    // the budget.
    const carried = await acquire();
    expect(carried.reconciling).toBe(true);
    registry.recordAttempt(KEY, { userTurns: ["conversation-turn-user-1"], responseTurns: [] });
    endTurn(registry, KEY, "failed");
    expect(registry.needsReconciliation(KEY)).toBe(true);
    expect(registry.isLost(KEY)).toBe(false);

    // The budget of one is spent: the next carry retires the conversation, with the distinguishable
    // reason, instead of carrying it forever. Retiring is not forking: no replacement was created.
    const exhausted = await acquire().catch((error: unknown) => error);
    expect(exhausted).toBeInstanceOf(RetainedSurfaceLostError);
    expect((exhausted as RetainedSurfaceLostError).reason).toBe("reconciliation-exhausted");
    expect(registry.isLost(KEY)).toBe(true);
    expect(registry.has(KEY)).toBe(false);
    expect(registry.needsReconciliation(KEY)).toBe(false);
    expect(page.isClosed()).toBe(true);
    expect(created).toBe(1);

    // The caller's continuity error is the existing honest one, carrying the reason.
    const mapped = chatGptRetainedSurfaceLostError((exhausted as RetainedSurfaceLostError).reason);
    expect(mapped.code).toBe(CHATGPT_RETAINED_SURFACE_LOST_CODE);
    expect(mapped.status).toBe(409);
    expect(mapped.message).toContain("reconciliation-exhausted");
  });

  test("the phase fact is the attempt record's presence, per attempt, and never a message", async () => {
    const registry = new RetainedSurfaceRegistry<PhasePage, ChatGptRetainedAttempt>();
    const page = phasePage();

    await registry.acquire(KEY, { required: false, create: async () => page });
    // A new attempt clears the previous record, so nothing is submitted until a send is activated.
    expect(registry.attemptRecord(KEY)).toBeUndefined();

    registry.recordAttempt(KEY, { userTurns: ["conversation-turn-user-1"], responseTurns: [] });
    // What was recorded is the conversation's structure — no message reaches it.
    expect(registry.attemptRecord(KEY)).toEqual({
      userTurns: ["conversation-turn-user-1"],
      responseTurns: [],
    });
    // And that record *is* the phase fact the settlement rule reads.
    expect(registry.submissionConfirmed(KEY)).toBe(true);
    // No surface at all: this process submitted nothing through this conversation.
    expect(registry.submissionConfirmed("conversation-key-never-retained")).toBe(false);

    // The next attempt starts fresh: the phase is a fact about *this* attempt, not about the surface.
    registry.release(KEY);
    registry.settle(KEY, "fulfilled");
    await registry.acquire(KEY, { required: false, create: async () => phasePage() });
    expect(registry.attemptRecord(KEY)).toBeUndefined();
    expect(registry.submissionConfirmed(KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real route: the adapter, with only the browser I/O replaced
// ---------------------------------------------------------------------------

/**
 * A retained ChatGPT conversation's structure, without a browser: turn identities and the flags the
 * completion evidence is read from. What the conversation "received" is recorded separately, exactly as
 * the provider side would — so the test can assert what reached the provider and when.
 */
interface PhysicalConversation extends RetainedSurfacePage {
  readonly userTurns: string[];
  readonly responseTurns: string[];
  generationRunning: boolean;
  lastReplyFinalized: boolean;
  readonly submissions: string[];
  closeCount: number;
  submit(prompt: string): void;
  answer(finalized: boolean): void;
  markClosed(): void;
}

function physicalConversation(): PhysicalConversation {
  let closed = false;
  let turnCount = 0;
  const page: PhysicalConversation = {
    userTurns: [],
    responseTurns: [],
    generationRunning: false,
    lastReplyFinalized: false,
    submissions: [],
    closeCount: 0,
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
 * The browser I/O of a managed-chrome ChatGPT turn over the **production** retained-surface owner, the
 * **production** phase classifier and the **production** reconciliation verdict.
 *
 * Only the physical page is replaced. The surface lifetime, the attempt record, the phase decision, the
 * coherence verdict and its retirements are the real implementations.
 */
class ManagedSurfaceFixture {
  readonly registry = new RetainedSurfaceRegistry<PhysicalConversation, ChatGptRetainedAttempt>();
  readonly pages: PhysicalConversation[] = [];
  readonly runs: Array<{
    prompt: string;
    reused: boolean;
    reconciling: boolean;
    submitted: boolean;
    key: string | undefined;
  }> = [];
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
      // The production probe over the production rule: the verdict is structural, read from the page's
      // turn identities against the attempt the send recorded.
      proveRetainedCoherence: (conversationKey: string) => reconcileRetainedConversation({
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
      }),
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
            const page = physicalConversation();
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
    let failed = false;
    let tornDown = false;
    /** The worker's own send-activation boundary: the attempt record is written here, or not at all. */
    let submitted = false;
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
      // Send activation (issue #314 stage 3): the attempt's structural record is taken before anything
      // lands in the conversation, exactly as the browser worker records it.
      if (page && key !== undefined) {
        this.registry.recordAttempt(key, {
          userTurns: [...page.userTurns],
          responseTurns: [...page.responseTurns],
        });
      }
      submitted = true;
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
        this.runs.push({
          prompt: compiled.text,
          reused,
          reconciling: retained.reconciling,
          submitted,
          key,
        });
        // The worker's own order and classifier (issues #171/#314/#317): release, then publish the
        // settlement the turn reached, with the phase read from the registry's own attempt record —
        // the same fact {@link RetainedSurfaceRegistry.submissionConfirmed} exposes.
        this.registry.release(key);
        this.registry.settle(key, retainedSurfaceSettlementForTurn(
          !failed ? "completed" : tornDown ? "torn-down" : "failed",
          this.registry.attemptRecord(key) === undefined ? "unconfirmed" : "confirmed",
        ));
      }
    }
  }
}

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-317-", { clearFreeHome: true });
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
const errorOf = (events: readonly AdapterEvent[]) =>
  events.find((event): event is Extract<AdapterEvent, { type: "error" }> => event.type === "error");

interface TurnFailure {
  readonly code?: string;
  readonly status?: number;
  readonly message?: string;
}

/**
 * The failure one turn reported, whichever way the route reported it: an adapter error the route throws
 * before the turn (a continuity loss) or an error event the turn itself emits. Both are what the caller
 * sees, so the assertions read the same either way.
 */
async function failureOf(
  target: ReturnType<typeof createChatGptWebAdapter>,
  request: CodexParsedRequest,
): Promise<TurnFailure> {
  try {
    const error = errorOf(await runTurn(target, request));
    return { code: error?.code, status: error?.status, message: error?.message };
  } catch (error) {
    const thrown = error as { code?: string; status?: number; message?: string };
    return { code: thrown.code, status: thrown.status, message: thrown.message };
  }
}

describe("issue #317 stage 1 — the real route: only a confirmed failure is reconciled", () => {
  test("a pre-submission failure marks nothing and its retry continues the same conversation", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    // The composer failed before anything was sent: no submission reached ChatGPT.
    fixture.enqueue({ error: new Error("the composer failed before the prompt was sent"), failBeforeActivation: true });
    fixture.enqueue({ answer: "respuesta tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    const first = await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    expect(answerOf(first)).toBe("respuesta uno");
    const key = fixture.surfaceKey!;

    const failed = await failureOf(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    // The gap stage 1 closes: nothing was sent, so the conversation is not marked for reconciliation and
    // no budget is spent. (Against the pre-stage-1 tree this assertion fails: it was `true`.)
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    // A pre-submission failure is reported as an ordinary, retry-safe failure — not as a
    // `chatgpt_submitted_turn_failed`: the route itself distinguishes the phases here, because the
    // provider's own error reporting follows the same send-activation boundary.
    expect(failed.code).toBeUndefined();
    expect(failed.message).toContain("before the prompt was sent");
    expect(fixture.registry.submissionConfirmed(key)).toBe(false);
    expect(fixture.registry.isLost(key)).toBe(false);

    // The retry is an ordinary continuation that succeeds on the same physical conversation.
    const third = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));
    expect(errorOf(third)).toBeUndefined();
    expect(answerOf(third)).toBe("respuesta tres");
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.runs.map(run => run.reconciling)).toEqual([false, false, false]);
    expect(fixture.runs.map(run => run.reused)).toEqual([false, true, true]);
    // The structural phase at the worker's own boundary: only the two successful turns activated a
    // send. The failed turn never did, which is why it was classified as pre-submission.
    expect(fixture.runs.map(run => run.submitted)).toEqual([true, false, true]);

    // The failed turn never submitted anything: the provider received one prompt per *successful* turn.
    expect(fixture.pages[0]!.submissions).toHaveLength(2);
    expect(fixture.pages[0]!.submissions[0]).toContain("pregunta uno");
    expect(fixture.pages[0]!.submissions[1]).toContain("pregunta tres");
    expect(fixture.pages[0]!.submissions[1]).not.toContain("pregunta dos");
  });

  test("a post-submission failure is marked, carried once, and reconciles on the next turn without a resend", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    // The submission was accepted and its reply is physically present, then the turn failed: the
    // measured incident, and the phase stage 1 leaves exactly as stage 2/3 defined it.
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    fixture.enqueue({ answer: "respuesta tres" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    const failed = await failureOf(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    expect(failed.code).toBe("chatgpt_submitted_turn_failed");

    const key = fixture.surfaceKey!;
    expect(fixture.registry.needsReconciliation(key)).toBe(true);
    expect(fixture.registry.isLost(key)).toBe(false);
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.pages[0]!.isClosed()).toBe(false);

    // The next turn is the bounded reconciliation attempt: the carry spends the budget.
    const third = await runTurn(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));

    expect(errorOf(third)).toBeUndefined();
    expect(answerOf(third)).toBe("respuesta tres");
    expect(fixture.runs.map(run => run.reconciling)).toEqual([false, false, true]);
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    expect(fixture.registry.isLost(key)).toBe(false);
    expect(fixture.pages).toHaveLength(1);

    // No path resends a confirmed submission: the failed turn's message reached the provider exactly
    // once (its own submission), and the reconciling turn carried only its own new human message.
    const submissions = fixture.pages[0]!.submissions;
    expect(submissions).toHaveLength(3);
    expect(submissions.filter(text => text.includes("pregunta dos"))).toHaveLength(1);
    expect(submissions[1]).toContain("pregunta dos");
    expect(submissions[2]).not.toContain("pregunta dos");
    expect(submissions[2]).toContain("pregunta tres");
  });

  test("the route records the structural phase fact for a confirmed failure", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    const failed = await failureOf(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    expect(failed.code).toBe("chatgpt_submitted_turn_failed");

    // The decision input is the provider's structural record of the attempt: turn identities and
    // nothing else. The failure's own message mentions no content, and neither does the record, so no
    // prompt can reach the classification.
    const key = fixture.surfaceKey!;
    const record = fixture.registry.attemptRecord(key);
    expect(Object.keys(record!).sort()).toEqual(["responseTurns", "userTurns"]);
    expect(JSON.stringify(record)).not.toContain("pregunta");
    // And that record's presence is the phase fact the settlement rule read: this attempt confirmed a
    // submission.
    expect(fixture.registry.submissionConfirmed(key)).toBe(true);
    // The worker's send-activation boundary and the registry's record agree — every send this fixture
    // activated was recorded — which is what makes the phase structural rather than inferred.
    expect(fixture.runs.map(run => run.submitted)).toEqual([true, true]);
  });

  test("the bounded budget is spent by confirmed carries, and exhaustion retires with its own reason", async () => {
    const fixture = new ManagedSurfaceFixture();
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Turn 1 establishes the conversation.
    fixture.enqueue({ answer: "respuesta uno" });
    history.push({ role: "user", content: "pregunta uno" });
    expect(answerOf(await runTurn(target, apiTurn(history)))).toBe("respuesta uno");
    history.push({ role: "assistant", content: "respuesta uno" });
    const key = fixture.surfaceKey!;

    // Four more turns each fail after a confirmed submission whose reply is physically present, so the
    // production probe reconciles each one: the *carry* spends the budget, never the failure itself.
    for (const question of ["pregunta dos", "pregunta tres", "pregunta cuatro", "pregunta cinco"]) {
      fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
      history.push({ role: "user", content: question });
      const failed = await failureOf(target, apiTurn(history));
      expect(failed.code).toBe("chatgpt_submitted_turn_failed");
      expect(fixture.registry.needsReconciliation(key)).toBe(true);
      expect(fixture.registry.isLost(key)).toBe(false);
      history.push({ role: "assistant", content: `respuesta ${question}` });
    }
    // Three carries: the default bounded budget. Turn 2 was the first mark (no carry), turns 3–5 were
    // the three carries.
    expect(fixture.runs.filter(run => run.reconciling)).toHaveLength(3);

    // The budget is spent: the next turn retires the conversation instead of carrying it a fourth time,
    // and the caller gets the existing continuity refusal with its own distinguishable reason.
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    history.push({ role: "user", content: "pregunta seis" });
    const exhausted = await failureOf(target, apiTurn(history));
    expect(exhausted.code).toBe(CHATGPT_RETAINED_SURFACE_LOST_CODE);
    expect(exhausted.status).toBe(409);
    expect(exhausted.message).toContain("reconciliation-exhausted");
    expect(fixture.registry.isLost(key)).toBe(true);
    expect(fixture.registry.needsReconciliation(key)).toBe(false);
    expect(fixture.pages).toHaveLength(1);

    // Nothing was ever replaced or resent: every submission is a distinct turn's own message.
    const submissions = fixture.pages[0]!.submissions;
    expect(submissions).toHaveLength(5);
    expect(new Set(submissions).size).toBe(submissions.length);
  });

  test("a page that is genuinely dead still yields the continuity error with its reason", async () => {
    const fixture = new ManagedSurfaceFixture();
    fixture.enqueue({ answer: "respuesta uno" });
    fixture.enqueue({ error: new Error("provider failed after submission"), reply: "finalized" });
    const target = createChatGptWebAdapter(controlledProviderConfig(home), { surfaceTransport: fixture.transport });

    await runTurn(target, apiTurn([{ role: "user", content: "pregunta uno" }]));
    const failed = await failureOf(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
    ]));
    expect(failed.code).toBe("chatgpt_submitted_turn_failed");
    const key = fixture.surfaceKey!;
    expect(fixture.registry.needsReconciliation(key)).toBe(true);

    // The page dies after the failed turn: that is proof of death, not a phase, and it retires.
    fixture.pages[0]!.markClosed();
    const refused = await failureOf(target, apiTurn([
      { role: "user", content: "pregunta uno" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "pregunta dos" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "pregunta tres" },
    ]));

    expect(refused.code).toBe(CHATGPT_RETAINED_SURFACE_LOST_CODE);
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("surface-dead");
    expect(fixture.registry.isLost(key)).toBe(true);
    expect(fixture.pages).toHaveLength(1);
  });
});
