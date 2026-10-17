import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeNativeChatGptContinuityStores, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
} from "../src/adapters/chatgpt-web/model";
import { ChatGptWebProviderCore, type ChatGptWebProviderCoreTurnInput } from "../src/adapters/chatgpt-web/provider-core";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  ControlledSurface,
  captureConsole,
  controlledIncoming,
  controlledParsed,
  controlledProviderConfig,
} from "./support/chatgpt-web-surface";

/**
 * The chat-only stability baseline.
 *
 * The former "terminal non-retryable failure path settles ProviderCore only once" and "runTurn
 * exposes a safe high-level chat-only diagnostic" tests read `src/adapters/chatgpt-web/index.ts` and
 * asserted on its text. Both are replaced here by real turns through the adapter's injected
 * surface-transport seam, which is the property those assertions were trying to protect.
 */
let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("dsh-chat-only-stability-", { clearFreeHome: true });
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: join(home, "conversations.json") } });
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  restoreChatGptWebHome(savedHome, home);
});

describe("chat-only stability baseline", () => {
  test("common ChatGPT Web routes remain tool-disabled in stability mode", () => {
    const capabilities = {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
    };

    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, effort, capabilities);
      expect(mode.localTools).toBe(false);
    }

    const luna = resolveChatGptWebModelMode(
      CHATGPT_WEB_LUNA_MODEL_ID,
      "low",
      { ...capabilities, solAvailable: false },
    );
    expect(luna.localTools).toBe(false);
  });

  test("a terminal non-retryable failure settles ProviderCore exactly once and leaves it retired", async () => {
    const provider = controlledProviderConfig(home);
    const providerCore = new ChatGptWebProviderCore();
    const surface = new ControlledSurface();
    // A failure after a confirmed submission: terminal, and never automatically retryable.
    surface.enqueue({
      error: new ChatGptWebAdapterError("provider failed after submission", {
        status: 500,
        errorType: "server_error",
        code: "provider_timeout",
        retryable: false,
      }),
    });
    const adapter = createChatGptWebAdapter(provider, {
      surfaceTransport: surface.transport,
      providerCore,
    });

    const events: Array<{ type: string; code?: string; retryable?: boolean }> = [];
    await adapter.runTurn(controlledParsed(), controlledIncoming(), event => events.push(event));

    // The turn surfaced exactly one terminal, non-retryable failure and never completed.
    const failures = events.filter(event => event.type === "error" || event.type === "incomplete");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("provider_timeout");
    expect(failures[0]?.retryable).toBe(false);
    expect(events.some(event => event.type === "done")).toBe(false);

    // It settled exactly once: a second logical settlement would have thrown, and shutdown
    // completes without an active lease or an unsettled turn holding the core open.
    await expect(providerCore.shutdown()).resolves.toBeUndefined();
    await adapter.shutdown?.();
  });

  test("a chat-only run logs the safe high-level diagnostic and no synthetic Pure Chat commentary", async () => {
    const provider = controlledProviderConfig(home);
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "a plain answer" });
    const adapter = createChatGptWebAdapter(provider, { surfaceTransport: surface.transport });

    const captured = captureConsole();
    try {
      await adapter.runTurn(controlledParsed({ userText: "hola" }), controlledIncoming(), () => {});
    } finally {
      captured.restore();
    }

    // The one high-level diagnostic exists, and it is safe (model id only, no prompt or payload).
    expect(captured.text()).toContain("[chatgpt-web] runTurn model=gpt-5.6-luna chatOnly=true");
    // The retired synthetic banner is never emitted at runtime, not merely absent from the source.
    expect(captured.text()).not.toContain("Pure Chat Mode");
    expect(captured.text()).not.toContain("Pure Chat");
    expect(captured.text()).not.toContain("hola");
    await adapter.shutdown?.();
  });
});

/**
 * Issue #287 slice 3 — shutdown drains what it owns and never hands it back out.
 *
 * Restored from the deleted `scripts/test-issue-9-provider-core.ts` ("ProviderCore shutdown drains
 * physical settlement" and "shutdown cannot hang on an unbound physical settlement"), extended to the
 * adapter seam this file already drives. Both are browser-free: the physical settlement is a promise
 * the test owns, and the adapter runs over the same controlled surface transport as above.
 */
describe("issue #287 slice 3 — shutdown drains owned resources and does not reuse them", () => {
  function coreTurnInput(executionKey: string): ChatGptWebProviderCoreTurnInput {
    return {
      executionKey,
      traceId: `${executionKey}-trace`,
      nativeTurnId: `${executionKey}-native`,
      nativeThreadId: `${executionKey}-thread`,
      accountIdentity: "account-287-shutdown",
      browserProfile: "profile-287-shutdown",
      browserContext: "context-287-shutdown",
      pageIdentity: `page-${executionKey}`,
      capabilitySnapshot: {
        snapshotId: `snapshot-${executionKey}`,
        sessionId: "session-287-shutdown",
        agentId: "session-287-shutdown",
        turnId: `${executionKey}-native`,
        createdAt: 1_700_000_000_000,
        lifecycle: "active",
        tools: [],
      },
      retryPolicy: "strict",
    };
  }

  function boundCoreTurn(core: ChatGptWebProviderCore, executionKey: string) {
    const turn = core.begin(coreTurnInput(executionKey));
    turn.bindPhysicalResource({
      resourceId: `surface-${executionKey}`,
      browserContextId: "context-287-shutdown",
      pageId: `page-${executionKey}`,
      profileId: "profile-287-shutdown",
      accountId: "chatgpt-account:account-287-shutdown",
    });
    turn.markSurfaceReady();
    return turn;
  }

  test("core shutdown drains a bound settlement and hands its resource back", async () => {
    const core = new ChatGptWebProviderCore();
    const executionKey = "issue-287-shutdown-drain";
    const turn = boundCoreTurn(core, executionKey);

    // The physical operation settles only because cancellation released it: shutdown must drive the
    // turn's own cancellation, then wait for the settlement it produced.
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>(resolve => { releaseSettlement = resolve; });
    core.bindPhysicalSettlement(executionKey, settlement);
    let cancelled = false;
    turn.attachCancellation(() => {
      cancelled = true;
      releaseSettlement();
    });

    await expect(core.shutdown(new Error("test shutdown"))).resolves.toBeUndefined();

    expect(cancelled).toBe(true);
    expect(turn.snapshot().logicalOutcome).toBe("cancelled");
    expect(turn.snapshot().physicalSettled).toBe(true);
    expect(turn.snapshot().physicalSettlementOutcome).toBe("fulfilled");
    expect(turn.snapshot().state).toBe("RETIRED");
    // The drained turn's resource was settled and released, not left owned by a dead core.
    expect(turn.lease.isActive()).toBe(false);
    expect(core.get(executionKey)).toBeUndefined();
  });

  test("core shutdown terminates when no settlement can be bound, and the core is unusable afterwards", async () => {
    // Zero grace: the turn never attaches a physical settlement, so shutdown must not wait forever.
    const core = new ChatGptWebProviderCore("chatgpt-web", undefined, 0);
    const executionKey = "issue-287-shutdown-unbound";
    const turn = boundCoreTurn(core, executionKey);

    await expect(core.shutdown(new Error("test shutdown"))).resolves.toBeUndefined();

    // It wrote the turn off explicitly: settled as never started, retired, resource released.
    expect(turn.snapshot().state).toBe("RETIRED");
    expect(turn.snapshot().physicalSettled).toBe(true);
    expect(turn.snapshot().physicalSettlementAttached).toBe(false);
    expect(turn.snapshot().physicalSettlementOutcome).toBe("not_started");
    expect(turn.lease.isActive()).toBe(false);
    expect(core.get(executionKey)).toBeUndefined();

    // A shut-down core refuses new work instead of drawing another resource.
    expect(() => core.begin(coreTurnInput("issue-287-after-shutdown"))).toThrow(/shut down/i);
    // Terminating twice is still terminating once.
    await expect(core.shutdown()).resolves.toBeUndefined();
  });

  test("core shutdown bounds an attached settlement that never resolves and writes the turn off", async () => {
    // Issue #287 slice 4a. The settlement IS attached, so shutdown used to await it with no bound: a
    // promise that never resolves kept the process alive past `docker stop`'s grace and into SIGKILL.
    // Zero grace keeps the bound deterministic; the drain test above pins the other side — an attached
    // settlement that does resolve is still awaited and still drains as `fulfilled`. The explicit test
    // timeout makes a regression fail the suite instead of hanging it, which is what the old code did.
    const core = new ChatGptWebProviderCore("chatgpt-web", undefined, 0);
    const executionKey = "issue-287-shutdown-stuck";
    const turn = boundCoreTurn(core, executionKey);
    core.bindPhysicalSettlement(executionKey, new Promise<void>(() => { /* never resolves */ }));

    await expect(core.shutdown(new Error("test shutdown"))).resolves.toBeUndefined();

    // The turn was written off with a defined physical outcome: attached, but settled as the failure
    // category, retired, and its resource released. Never `fulfilled`, so nothing is reused.
    const snapshot = turn.snapshot();
    expect(snapshot.state).toBe("RETIRED");
    expect(snapshot.physicalSettlementAttached).toBe(true);
    expect(snapshot.physicalSettled).toBe(true);
    expect(snapshot.physicalSettlementOutcome).toBe("rejected");
    // The timeout is explicit and observable, not inferred from the outcome word alone.
    expect(snapshot.physicalSettlementError).toContain("did not resolve within the 0ms shutdown settlement grace");
    expect(snapshot.physicalSettlementOutcome).not.toBe("fulfilled");
    expect(turn.lease.isActive()).toBe(false);
    expect(core.get(executionKey)).toBeUndefined();
    // The core records the same failure settlement as the provider view.
    expect(turn.coreSnapshot().physical).toBe("rejected");
  }, 5_000);

  test("adapter shutdown terminates, is idempotent, and refuses a turn afterwards", async () => {
    const provider = controlledProviderConfig(home);
    const surface = new ControlledSurface();
    surface.enqueue({ answer: "answer before shutdown" });
    const adapter = createChatGptWebAdapter(provider, { surfaceTransport: surface.transport });
    await adapter.runTurn(controlledParsed(), controlledIncoming(), () => {});
    expect(surface.runs).toHaveLength(1);

    await expect(adapter.shutdown?.()).resolves.toBeUndefined();
    await expect(adapter.shutdown?.()).resolves.toBeUndefined();

    // After shutdown the adapter refuses new work rather than reaching for another resource.
    await expect(adapter.runTurn(controlledParsed(), controlledIncoming(), () => {}))
      .rejects.toThrow(/shutting down/i);
    expect(surface.runs).toHaveLength(1);
  });
});
