import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { closeNativeChatGptContinuityStores, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { BrowserAccountLeaseRegistry, ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { MAX_CHATGPT_BROWSER_TABS } from "../src/adapters/chatgpt-web/concurrency";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import {
  createChatGptTurnAccounting,
  MAX_ACCOUNTED_OPERATIONS,
  MAX_ACCOUNTED_REQUESTS,
  type ChatGptTurnAccountingRequestSnapshot,
  type ChatGptTurnAccountingSnapshot,
} from "../src/adapters/chatgpt-web/turn-accounting";
import type {
  ChatGptWebSurfaceTransport,
  WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";
import { defaultConfig, saveConfig } from "../src/config";
import { fingerprintDiagnosticValue } from "../src/lib/safe-diagnostics";
import { startServer, type RunningServer } from "../src/server";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import { CONTROLLED_ACCOUNT, controlledProviderConfig } from "./support/chatgpt-web-surface";

/**
 * Issue #359 — measure the browser turns one request/operation actually costs.
 *
 * The acceptance is a measurement, not a guess: the control surface must publish, per request and per
 * operation, how many browser turns ran, how long the request waited for an account slot, and how much
 * context it replayed. The suite has two halves:
 *
 * 1. the accounting owner's own contract, driven directly so the bounds and the "absent is not zero"
 *    rule are deterministic;
 * 2. the real `/v1/chat/completions` route (the OpenAI-compatible surface Hindsight speaks) with only
 *    the browser I/O replaced, so the counts are the production ones.
 *
 * The reuse boundary is asserted explicitly: a reflect loop that declares one operation identity
 * continues its own conversation (a delta, not a replay), and a different operation — even with
 * byte-identical messages — gets its own conversation and never sees the first operation's prompt.
 */
let home: string;
let savedHome: SavedChatGptWebHome;
const servers: RunningServer[] = [];
const API_KEY = "issue-359-turn-accounting-api-key-0123456789";
const CONTROL_TOKEN = "issue-359-turn-accounting-control-token-0123456789";

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-359-turn-accounting-", { clearFreeHome: true });
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
// Half 1: the accounting owner's own contract.
// ---------------------------------------------------------------------------------------------------

describe("issue #359 — the browser-turn accounting owner", () => {
  test("per-request and per-operation turns, wait time and replay size are reported", () => {
    const accounting = createChatGptTurnAccounting();
    const request = accounting.begin({ operation: "operation-alpha" });
    request.recordWait(12);
    const turn = request.beginBrowserTurn();
    turn.recordPrompt("install", 3, 120);
    turn.settle("completed");
    request.finish("completed");

    const snapshot = accounting.snapshot();
    expect(snapshot.requests).toBe(1);
    expect(snapshot.browserTurns).toBe(1);
    expect(snapshot.replayTurns).toBe(1);
    expect(snapshot.continuationTurns).toBe(0);
    expect(snapshot.replayMessages).toBe(3);
    expect(snapshot.replayChars).toBe(120);
    expect(snapshot.waitMsTotal).toBe(12);
    expect(snapshot.waitMsMax).toBe(12);
    expect(snapshot.turnMsTotal).toBeGreaterThanOrEqual(0);

    expect(snapshot.recent).toHaveLength(1);
    const record = snapshot.recent[0]!;
    expect(record.operation).toBe(fingerprintDiagnosticValue("operation-alpha"));
    expect(record.browserTurns).toBe(1);
    expect(record.replayTurns).toBe(1);
    expect(record.continuationTurns).toBe(0);
    expect(record.replayMessages).toBe(3);
    expect(record.replayChars).toBe(120);
    expect(record.waitMs).toBe(12);
    expect(record.turnMs).toBeGreaterThanOrEqual(0);
    expect(record.outcome).toBe("completed");

    expect(snapshot.operations).toHaveLength(1);
    const operation = snapshot.operations[0]!;
    expect(operation.operation).toBe(fingerprintDiagnosticValue("operation-alpha"));
    expect(operation.requests).toBe(1);
    expect(operation.browserTurns).toBe(1);
    expect(operation.replayTurns).toBe(1);
    expect(operation.continuationTurns).toBe(0);
    expect(operation.replayMessages).toBe(3);
    expect(operation.waitMsTotal).toBe(12);
    expect(operation.waitMsMax).toBe(12);
    expect(operation.turnMsTotal).toBeGreaterThanOrEqual(0);
  });

  test("a continuation reports only its delta, so the replay saving is visible", () => {
    const accounting = createChatGptTurnAccounting();
    const install = accounting.begin({ operation: "operation-reflect" });
    const installTurn = install.beginBrowserTurn();
    installTurn.recordPrompt("install", 1, 1_000);
    installTurn.settle("completed");
    install.finish("completed");

    const continuation = accounting.begin({ operation: "operation-reflect" });
    const continuationTurn = continuation.beginBrowserTurn();
    continuationTurn.recordPrompt("continuation", 1, 20);
    continuationTurn.settle("completed");
    continuation.finish("completed");

    const snapshot = accounting.snapshot();
    expect(snapshot.operations).toHaveLength(1);
    const operation = snapshot.operations[0]!;
    expect(operation.requests).toBe(2);
    expect(operation.browserTurns).toBe(2);
    expect(operation.replayTurns).toBe(1);
    expect(operation.continuationTurns).toBe(1);
    expect(operation.replayChars).toBe(1_020);
    expect(snapshot.recent[0]!.replayChars).toBe(1_000);
    expect(snapshot.recent[1]!.replayChars).toBe(20);
  });

  test("the browser-turn metric is absent — not zero — when a turn never reached the provider", () => {
    const accounting = createChatGptTurnAccounting();
    const request = accounting.begin({ operation: "operation-refused" });
    request.recordWait(150);
    request.finish("failed");

    const snapshot = accounting.snapshot();
    const record = snapshot.recent[0]!;
    expect(record.outcome).toBe("refused");
    expect(record.waitMs).toBe(150);
    // Absent, never zero: the turn never reached the provider, so there is nothing to measure.
    expect("browserTurns" in record).toBe(false);
    expect("turnMs" in record).toBe(false);
    expect("replayMessages" in record).toBe(false);
    expect("replayTurns" in record).toBe(false);
    expect(snapshot.browserTurns).toBe(0);
    expect(snapshot.operations[0]!.browserTurns).toBe(0);
  });

  test("a cancellation that never reached the provider stays a cancellation", () => {
    const accounting = createChatGptTurnAccounting();
    const request = accounting.begin({ operation: "operation-cancelled" });
    request.finish("cancelled");
    const record = accounting.snapshot().recent[0]!;
    expect(record.outcome).toBe("cancelled");
    expect("browserTurns" in record).toBe(false);
  });

  test("the snapshot carries no prompt text and no raw operation identity", () => {
    const accounting = createChatGptTurnAccounting();
    const request = accounting.begin({ operation: "secret-session-identity-359" });
    const turn = request.beginBrowserTurn();
    turn.recordPrompt("install", 2, 42);
    turn.settle("completed");
    request.finish("completed");

    const serialized = JSON.stringify(accounting.snapshot());
    expect(serialized).not.toContain("secret-session-identity-359");
    expect(accounting.snapshot().recent[0]!.operation).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the recent-request ring and the operation table are bounded", () => {
    const accounting = createChatGptTurnAccounting();
    for (let index = 0; index < MAX_ACCOUNTED_REQUESTS + 5; index += 1) {
      const request = accounting.begin({ operation: `operation-${index}` });
      request.finish("failed");
    }
    const snapshot = accounting.snapshot();
    expect(snapshot.requests).toBe(MAX_ACCOUNTED_REQUESTS + 5);
    expect(snapshot.recent).toHaveLength(MAX_ACCOUNTED_REQUESTS);
    expect(snapshot.operations.length).toBeLessThanOrEqual(MAX_ACCOUNTED_OPERATIONS);
  });

  test("an unfinished request is visible as pending and its turn settles exactly once", () => {
    const accounting = createChatGptTurnAccounting();
    const request = accounting.begin({ operation: "operation-pending" });
    const turn = request.beginBrowserTurn();
    turn.recordPrompt("install", 1, 10);
    turn.settle("completed");
    turn.settle("failed");
    const snapshot = accounting.snapshot();
    expect(snapshot.recent[0]!.outcome).toBe("completed");
    expect(snapshot.recent[0]!.browserTurns).toBe(1);
    expect(snapshot.recent[0]!.replayTurns).toBe(1);
    expect(snapshot.browserTurns).toBe(1);
    request.finish("completed");
    expect(accounting.snapshot().recent[0]!.outcome).toBe("completed");
  });
});

// ---------------------------------------------------------------------------------------------------
// Half 2: the real /v1/chat/completions route, with only the browser I/O replaced.
// ---------------------------------------------------------------------------------------------------

interface AccountingRun {
  readonly turn: WebSurfaceTurn;
  readonly prompt: string;
  readonly conversationKey?: string;
  /** Whether the surface continued an existing conversation instead of installing a new one. */
  readonly reused: boolean;
  readonly kind: "install" | "continuation";
  sendAttempts: number;
  confirmedSubmissions: number;
}

/**
 * A controlled surface that records what each browser turn did and can hold turns at a gate.
 *
 * Reuse follows the production shape: a turn whose conversation key this fixture has already served
 * continues it through `prepareResume`; a new key installs through `prepare`. That is what makes the
 * operation boundary observable — a leak would appear as a continuation on another operation's key.
 */
class AccountingSurface {
  readonly runs: AccountingRun[] = [];
  readonly submittedOrder: number[] = [];
  /** When true, every run waits at its own gate until the suite releases it. */
  hold = false;
  private readonly seenConversationKeys = new Set<string>();
  private readonly releases = new Map<number, () => void>();
  private readonly gates = new Map<number, Promise<void>>();
  private readonly submittedResolvers = new Map<number, () => void>();
  private readonly submittedSignals = new Map<number, Promise<void>>();

  submitted(index: number): Promise<void> {
    let signal = this.submittedSignals.get(index);
    if (!signal) {
      signal = new Promise<void>(resolve => { this.submittedResolvers.set(index, resolve); });
      this.submittedSignals.set(index, signal);
    }
    return signal;
  }

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
          && this.seenConversationKeys.has(turn.conversationKey);
        await turn.onPreparedSelected?.(reused);
        const prepare = reused ? turn.prepareResume : turn.prepare;
        if (!prepare) throw new Error("the controlled surface was asked to resume without a continuation prompt");
        const compiled = await prepare();
        try {
          const run: AccountingRun = {
            turn,
            prompt: compiled.text,
            ...(turn.conversationKey !== undefined ? { conversationKey: turn.conversationKey } : {}),
            reused,
            kind: reused ? "continuation" : "install",
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
          if (this.hold) await this.gate(index);
          if (turn.conversationKey !== undefined) this.seenConversationKeys.add(turn.conversationKey);
          turn.onTextDelta(`answer-${index}`);
          return `answer-${index}`;
        } finally {
          compiled.release();
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
  surface: AccountingSurface,
  options: { waitBudgetMs?: number; chatVisibility?: "temporary" } = {},
): RunningServer {
  const base = controlledProviderConfig(home);
  const provider = options.chatVisibility === undefined
    ? base
    : {
      ...base,
      chatgptWeb: { ...base.chatgptWeb, chatVisibility: options.chatVisibility },
    };
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
        options.waitBudgetMs === undefined ? {} : { waitBudgetMs: options.waitBudgetMs },
      ),
      adapterFactory: (_provider: unknown, providerCore: ChatGptWebProviderCore) => createChatGptWebAdapter(
        provider,
        { providerCore, surfaceTransport: surface.transport }),
    } as never,
  );
  servers.push(server);
  return server;
}

interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface TurnResult {
  readonly status: number;
  readonly content?: string;
  readonly error?: { readonly message?: string; readonly code?: string };
}

async function postTurn(
  server: RunningServer,
  messages: readonly WireMessage[],
  options: { user?: string } = {},
): Promise<TurnResult> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      connection: "close",
    },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      ...(options.user !== undefined ? { user: options.user } : {}),
      messages,
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return {
    status: response.status,
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

function accountingOf(status: Record<string, unknown>): ChatGptTurnAccountingSnapshot {
  return status.turnAccounting as ChatGptTurnAccountingSnapshot;
}

function lastRecord(accounting: ChatGptTurnAccountingSnapshot): ChatGptTurnAccountingRequestSnapshot {
  const record = accounting.recent.at(-1);
  if (!record) throw new Error("the accounting snapshot has no recent request");
  return record;
}

describe("issue #359 — browser-turn accounting on the real /v1/chat/completions route", () => {
  test("one request reports its browser turn, wait time and replay size", async () => {
    const surface = new AccountingSurface();
    const server = serve(surface);

    const result = await postTurn(server, [{ role: "user", content: "measure this turn" }], {
      user: "operation-measure",
    });
    expect(result.status).toBe(200);
    expect(surface.runs).toHaveLength(1);

    const accounting = accountingOf(await controlStatus(server));
    const record = lastRecord(accounting);
    expect(record.operation).toBe(fingerprintDiagnosticValue("operation-measure"));
    expect(record.browserTurns).toBe(1);
    expect(record.replayTurns).toBe(1);
    expect(record.continuationTurns).toBe(0);
    expect(record.replayMessages).toBe(1);
    expect(record.replayChars).toBeGreaterThan(0);
    // A turn that found a free account slot still waits for the queue's own grant tick, so the
    // measurement is reported (never absent for a turn that reached the provider) but is not
    // pinned to a constant: a real deployment's wait is whatever the queue actually spent.
    expect(typeof record.waitMs).toBe("number");
    expect(record.waitMs).toBeGreaterThanOrEqual(0);
    expect(record.waitMs).toBeLessThan(5_000);
    expect(record.turnMs).toBeGreaterThanOrEqual(0);
    expect(record.outcome).toBe("completed");

    const operation = accounting.operations.find(candidate => candidate.operation === record.operation);
    expect(operation).toBeDefined();
    expect(operation!.requests).toBe(1);
    expect(operation!.browserTurns).toBe(1);
    expect(operation!.replayTurns).toBe(1);
    expect(operation!.continuationTurns).toBe(0);
    // The operation total aggregates the same measured wait, so it is non-negative rather than a
    // constant: the queue's grant tick is real time and must not make this assertion flaky.
    expect(operation!.waitMsTotal).toBeGreaterThanOrEqual(0);

    // No prompt text and no raw identity: counters and fingerprints only.
    const serialized = JSON.stringify(accounting);
    expect(serialized).not.toContain("measure this turn");
    expect(serialized).not.toContain("operation-measure");
  });

  test("a request refused before the provider reports no browser turn (absent, not zero)", async () => {
    const surface = new AccountingSurface();
    surface.hold = true;
    const server = serve(surface, { waitBudgetMs: 120 });

    const held: Array<Promise<TurnResult>> = [];
    for (let index = 1; index <= MAX_CHATGPT_BROWSER_TABS; index += 1) {
      held.push(postTurn(server, [{ role: "user", content: `hold ${index}` }], {
        user: `operation-hold-${index}`,
      }));
    }
    await waitFor(
      () => surface.runs.length >= MAX_CHATGPT_BROWSER_TABS && surface.submittedOrder.length >= MAX_CHATGPT_BROWSER_TABS,
      "the account to be full",
    );

    const refused = await withDeadline(postTurn(server, [{ role: "user", content: "refused turn" }], {
      user: "operation-refused",
    }));
    expect(refused).not.toBe("hung");
    if (refused === "hung") return;
    expect(refused.status).toBe(429);
    expect(refused.error?.code).toBe("turn_queue_timeout");
    // The refused turn never reached the browser.
    expect(surface.runs).toHaveLength(MAX_CHATGPT_BROWSER_TABS);

    const accounting = accountingOf(await controlStatus(server));
    const record = lastRecord(accounting);
    expect(record.operation).toBe(fingerprintDiagnosticValue("operation-refused"));
    expect(record.outcome).toBe("refused");
    expect(record.waitMs).toBeGreaterThan(0);
    expect("browserTurns" in record).toBe(false);
    expect("turnMs" in record).toBe(false);
    expect("replayMessages" in record).toBe(false);
    const operation = accounting.operations.find(candidate => candidate.operation === record.operation);
    expect(operation).toBeDefined();
    expect(operation!.requests).toBe(1);
    expect(operation!.browserTurns).toBe(0);
    expect(operation!.waitMsTotal).toBeGreaterThan(0);

    surface.releaseAll();
    const results = await Promise.all(held.map(turn => withDeadline(turn)));
    for (const result of results) {
      expect(result).not.toBe("hung");
      if (result === "hung") return;
      expect(result.status).toBe(200);
    }
  });

  test("a queued request reports the wait it spent for an account slot", async () => {
    const surface = new AccountingSurface();
    surface.hold = true;
    const server = serve(surface, { waitBudgetMs: 5_000 });

    const held: Array<Promise<TurnResult>> = [];
    for (let index = 1; index <= MAX_CHATGPT_BROWSER_TABS; index += 1) {
      held.push(postTurn(server, [{ role: "user", content: `hold ${index}` }], {
        user: `operation-hold-${index}`,
      }));
    }
    await waitFor(
      () => surface.runs.length >= MAX_CHATGPT_BROWSER_TABS && surface.submittedOrder.length >= MAX_CHATGPT_BROWSER_TABS,
      "the account to be full",
    );

    const waiting = postTurn(server, [{ role: "user", content: "queued turn" }], {
      user: "operation-waited",
    });
    await waitFor(async () => {
      const status = await controlStatus(server);
      const queue = status.turnQueue as { depth?: number } | undefined;
      return (queue?.depth ?? 0) >= 1;
    }, "the sixth turn to be queued");
    await sleep(30);
    surface.release(1);
    await waitFor(() => surface.runs.length === MAX_CHATGPT_BROWSER_TABS + 1, "the queued turn to start");
    surface.release(MAX_CHATGPT_BROWSER_TABS + 1);

    const result = await withDeadline(waiting);
    expect(result).not.toBe("hung");
    if (result === "hung") return;
    expect(result.status).toBe(200);

    const accounting = accountingOf(await controlStatus(server));
    const record = lastRecord(accounting);
    expect(record.operation).toBe(fingerprintDiagnosticValue("operation-waited"));
    expect(record.browserTurns).toBe(1);
    expect(record.waitMs).toBeGreaterThanOrEqual(20);
    const operation = accounting.operations.find(candidate => candidate.operation === record.operation);
    expect(operation).toBeDefined();
    expect(operation!.waitMsTotal).toBeGreaterThanOrEqual(20);
    expect(operation!.waitMsMax).toBeGreaterThanOrEqual(20);

    surface.releaseAll();
    await Promise.all(held.map(turn => withDeadline(turn)));
  });

  test("a stateless caller replays its whole history; a session-addressed caller replays only its delta", async () => {
    const surface = new AccountingSurface();
    const server = serve(surface);
    const history: WireMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ];

    const stateless = await postTurn(server, history);
    expect(stateless.status).toBe(200);
    const session = await postTurn(server, history, { user: "operation-session" });
    expect(session.status).toBe(200);
    expect(surface.runs).toHaveLength(2);

    const accounting = accountingOf(await controlStatus(server));
    expect(accounting.recent).toHaveLength(2);
    const statelessRecord = accounting.recent[0]!;
    const sessionRecord = accounting.recent[1]!;
    // The stateless caller has no continuity: the projection transmits its whole history every call.
    expect(statelessRecord.replayMessages).toBe(3);
    expect(statelessRecord.replayTurns).toBe(1);
    // A session-addressed caller continues its provider conversation: only the newest user message.
    expect(sessionRecord.replayMessages).toBe(1);
    expect(sessionRecord.replayTurns).toBe(1);
    expect(sessionRecord.operation).toBe(fingerprintDiagnosticValue("operation-session"));
    // The session-addressed turn carries only the newest user message: the earlier turns are the
    // provider conversation's, not part of the transmitted prompt.
    expect(surface.runs[1]!.prompt).toContain("second question");
    expect(surface.runs[1]!.prompt).not.toContain("first question");
  });

  test("a temporary deployment's stateless caller replays the whole history into the browser", async () => {
    const surface = new AccountingSurface();
    const server = serve(surface, { chatVisibility: "temporary" });
    const history: WireMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ];

    const stateless = await postTurn(server, history);
    expect(stateless.status).toBe(200);
    expect(surface.runs).toHaveLength(1);
    // A Temporary Chat claims no provider conversation, so the whole canonical history is replayed.
    expect(surface.runs[0]!.prompt).toContain("first question");
    expect(surface.runs[0]!.prompt).toContain("second question");

    const accounting = accountingOf(await controlStatus(server));
    const record = lastRecord(accounting);
    expect(record.replayMessages).toBe(3);
    expect(record.replayTurns).toBe(1);
    expect(record.continuationTurns).toBe(0);
    expect(record.replayChars).toBeGreaterThan(0);
  });

  test("a 3-call workload: 3 replays without an operation identity, 1 replay + 2 continuations with one", async () => {
    const surface = new AccountingSurface();
    const server = serve(surface);
    const growingHistory: WireMessage[] = [
      { role: "user", content: "reflect step one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "reflect step two" },
      { role: "assistant", content: "answer two" },
      { role: "user", content: "reflect step three" },
    ];

    // Without an operation identity: every call is a different content-derived conversation, so every
    // call replays its whole history into a fresh provider conversation.
    for (let length = 1; length <= 5; length += 2) {
      const result = await postTurn(server, growingHistory.slice(0, length));
      expect(result.status).toBe(200);
    }
    // With one operation identity: the first call installs, the next two continue it with a delta.
    for (let length = 1; length <= 5; length += 2) {
      const result = await postTurn(server, growingHistory.slice(0, length), {
        user: "operation-reflect-loop",
      });
      expect(result.status).toBe(200);
    }
    expect(surface.runs).toHaveLength(6);

    const accounting = accountingOf(await controlStatus(server));
    const statelessRecords = accounting.recent.slice(0, 3);
    const operationRecords = accounting.recent.slice(3);
    const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

    // Before: one full replay per call, each carrying the whole growing history.
    expect(sum(statelessRecords.map(record => record.browserTurns ?? 0))).toBe(3);
    expect(sum(statelessRecords.map(record => record.replayTurns ?? 0))).toBe(3);
    expect(sum(statelessRecords.map(record => record.continuationTurns ?? 0))).toBe(0);
    expect(sum(statelessRecords.map(record => record.replayMessages ?? 0))).toBe(9);
    // Three distinct operations: nothing groups the stateless calls.
    expect(new Set(statelessRecords.map(record => record.operation)).size).toBe(3);

    // After: one full replay and two continuations on one operation conversation.
    expect(sum(operationRecords.map(record => record.browserTurns ?? 0))).toBe(3);
    expect(sum(operationRecords.map(record => record.replayTurns ?? 0))).toBe(1);
    expect(sum(operationRecords.map(record => record.continuationTurns ?? 0))).toBe(2);
    expect(sum(operationRecords.map(record => record.replayMessages ?? 0))).toBe(3);
    expect(new Set(operationRecords.map(record => record.operation)).size).toBe(1);
    const operation = accounting.operations.find(
      candidate => candidate.operation === operationRecords[0]!.operation,
    );
    expect(operation).toBeDefined();
    expect(operation!.requests).toBe(3);
    expect(operation!.browserTurns).toBe(3);
    expect(operation!.replayTurns).toBe(1);
    expect(operation!.continuationTurns).toBe(2);
    expect(operation!.replayMessages).toBe(3);
    // The three stateless calls are three separate operations, each with one request.
    for (const record of statelessRecords) {
      const statelessOperation = accounting.operations.find(
        candidate => candidate.operation === record.operation,
      );
      expect(statelessOperation?.requests).toBe(1);
      expect(statelessOperation?.replayTurns).toBe(1);
      expect(statelessOperation?.continuationTurns).toBe(0);
    }
  });

  test("reuse stays inside one operation; another operation never sees its context", async () => {
    const surface = new AccountingSurface();
    const server = serve(surface);
    const reflectHistory: WireMessage[] = [
      { role: "user", content: "reflect step one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "reflect step two" },
    ];

    const reflectOne = await postTurn(server, [{ role: "user", content: "reflect step one" }], {
      user: "operation-reflect",
    });
    const reflectTwo = await postTurn(server, reflectHistory, { user: "operation-reflect" });
    // Byte-identical messages, a different operation: it must NOT continue the reflect conversation.
    const retain = await postTurn(server, reflectHistory, { user: "operation-retain" });
    expect(reflectOne.status).toBe(200);
    expect(reflectTwo.status).toBe(200);
    expect(retain.status).toBe(200);
    expect(surface.runs).toHaveLength(3);

    // Within the operation: one conversation, continued with a delta.
    expect(surface.runs[1]!.reused).toBe(true);
    expect(surface.runs[1]!.kind).toBe("continuation");
    expect(surface.runs[1]!.conversationKey).toBe(surface.runs[0]!.conversationKey);
    expect(surface.runs[1]!.prompt).toBe("reflect step two");

    // Across operations: a different conversation, installed from its own history.
    expect(surface.runs[2]!.reused).toBe(false);
    expect(surface.runs[2]!.kind).toBe("install");
    expect(surface.runs[2]!.conversationKey).not.toBe(surface.runs[0]!.conversationKey);
    expect(surface.runs[2]!.prompt).not.toContain("reflect step one");
    expect(surface.runs[2]!.prompt).toContain("reflect step two");

    const accounting = accountingOf(await controlStatus(server));
    const reflectRecord = accounting.recent[1]!;
    const retainRecord = accounting.recent[2]!;
    expect(reflectRecord.operation).toBe(fingerprintDiagnosticValue("operation-reflect"));
    expect(retainRecord.operation).toBe(fingerprintDiagnosticValue("operation-retain"));
    expect(reflectRecord.operation).not.toBe(retainRecord.operation);
    expect(reflectRecord.continuationTurns).toBe(1);
    expect(reflectRecord.replayTurns).toBe(0);
    expect(retainRecord.replayTurns).toBe(1);
    expect(retainRecord.continuationTurns).toBe(0);

    const reflectOperation = accounting.operations.find(candidate => candidate.operation === reflectRecord.operation);
    expect(reflectOperation).toBeDefined();
    expect(reflectOperation!.requests).toBe(2);
    expect(reflectOperation!.browserTurns).toBe(2);
    expect(reflectOperation!.replayTurns).toBe(1);
    expect(reflectOperation!.continuationTurns).toBe(1);
    const retainOperation = accounting.operations.find(candidate => candidate.operation === retainRecord.operation);
    expect(retainOperation).toBeDefined();
    expect(retainOperation!.requests).toBe(1);
    expect(retainOperation!.browserTurns).toBe(1);
    expect(retainOperation!.replayTurns).toBe(1);
    expect(retainOperation!.continuationTurns).toBe(0);
  });
});
