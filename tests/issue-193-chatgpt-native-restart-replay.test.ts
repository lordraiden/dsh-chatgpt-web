/**
 * Issue #193 (correction C2) — the durable replay is proven through the **real native turn path**.
 *
 * The two original #193 tests recorded the installation fingerprint by hand
 * (`sessions.recordSentSystemFingerprint(...)`), so they established the restart state *before*
 * deciding, and never exercised the cycle that actually sets it. This test builds the production
 * composition — `createChatGptWebAdapter(provider, { surfaceTransport })` over the real driver,
 * continuity decision, WebChat core, durable store and settlement — so the state under test is
 * produced by the code the deployment runs.
 *
 * What is **real** here: the provider adapter, `startRuntime`, prompt preparation and compilation,
 * the submission hooks, the settlement/confirmation path, the ChatGPT driver, the WebChat continuity
 * decision and core, the durable file store (one writer per file/process), and the retryability-free
 * turn surface.
 *
 * What is **simulated**: only the browser's I/O. `ControlledSurface` replaces the physical web
 * transport — it calls the real `prepare()`/`onSendActivated()`/`onSubmitted()`/`onTextDelta()` hooks
 * the browser worker would call and returns the answer text. No DOM, network or Playwright is
 * involved. `ChatGptTurnSessions.clear()` plus a fresh adapter/core instance stands in for a new
 * process, which is exactly what a restart removes (the process-local installation state), while the
 * durable file survives.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeNativeChatGptContinuityStores,
  createChatGptWebAdapter,
  resolveNativeChatGptContinuityStore,
} from "../src/adapters/chatgpt-web/index";
import type { ChatGptWebSurfaceTransport, WebSurfaceTurn } from "../src/adapters/chatgpt-web/web-surface-transport";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const ACCOUNT_FINGERPRINT = "account-native-restart";

const PROVIDER = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    browserInteractionMode: "automatic",
    browserHost: "managed-chrome",
    storageStatePath: "/tmp/chatgpt-native-restart-state.json",
    chromeExecutablePath: "/usr/bin/chromium",
    brokerSocketPath: "/tmp/chatgpt-native-restart-broker.sock",
    localToolsEnabled: false,
    solAvailable: false,
    proAvailable: false,
    capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
    experimentalBiggerContext: false,
  },
} as unknown as CodexProviderConfig;

const SESSION = "session-native-restart";
const THREAD = "thread-native-restart";

/** Canonical host history, or none at all when the request carries only system instructions. */
function parsed(options: { readonly turn: string; readonly withHistory?: boolean }): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    context: {
      systemPrompt: ["eres un asistente"],
      messages: options.withHistory === false
        ? []
        : [{ role: "user", content: [{ type: "text", text: "arregla el bug" }] }],
    },
    stream: false,
    options: { reasoning: "low" },
    _dshContext: { dshSessionId: SESSION, threadId: THREAD, turnId: options.turn },
  } as unknown as CodexParsedRequest;
}

interface SurfaceRun {
  readonly turn: WebSurfaceTurn;
  readonly prompt: string;
}

/**
 * The controlled browser I/O.
 *
 * `run()` calls exactly the hooks the browser worker calls, in the same order, with test-controlled
 * outcomes (`activate`, `submit`, failure). The prompt text the adapter compiled for this turn is
 * captured so the test can prove the replay rebuilt the conversation from canonical history.
 */
class ControlledSurface {
  readonly runs: SurfaceRun[] = [];
  /** Test-controlled behaviour of the next browser run. */
  next: { activate?: boolean; submit?: boolean; answer?: string; fail?: Error } = {
    activate: true,
    submit: true,
    answer: "respuesta del turno",
  };
  /** Runs the test's assertion while the turn is still in flight, before settlement. */
  beforeSettle: ((run: SurfaceRun) => void | Promise<void>) | undefined;

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const compiled = await turn.prepare();
        const run: SurfaceRun = { turn, prompt: compiled.text };
        this.runs.push(run);
        await this.beforeSettle?.(run);
        // The surface lifecycle the browser worker performs, in its order: bind the physical surface,
        // declare it ready, then the send activation and the submission that follow it.
        await turn.onPhysicalSurfaceBound?.({
          resourceId: "surface-resource",
          browserContextId: "surface-context",
          pageId: "surface-page",
          profileId: "surface-profile",
          accountId: `chatgpt-account:${ACCOUNT_FINGERPRINT}`,
        });
        await turn.onSurfaceReady?.();
        if (this.next.activate === true) await turn.onSendActivated?.();
        if (this.next.submit === true) turn.onSubmitted?.();
        if (this.next.fail) throw this.next.fail;
        const answer = this.next.answer ?? "";
        if (answer.length > 0) turn.onTextDelta(answer);
        return answer;
      },
    } as unknown as ChatGptWebSurfaceTransport;
  }
}

/** A production-composed provider adapter whose only replaced part is the browser transport. */
function nativeAdapter(surface: ControlledSurface) {
  return createChatGptWebAdapter(PROVIDER, { surfaceTransport: surface.transport });
}

async function runTurn(adapter: ReturnType<typeof nativeAdapter>, request: CodexParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn(request, { headers: new Headers() }, event => events.push(event));
  return events;
}

async function durableRecords() {
  return resolveNativeChatGptContinuityStore().list();
}

interface DurableDocument {
  version: number;
  records: Array<{
    generation: number;
    checkpoint: string;
    handle?: string;
    lastConfirmedTurn?: { turnId: string; at: number };
  }>;
}

function durableFile(file: string): DurableDocument {
  return JSON.parse(readFileSync(file, "utf8")) as DurableDocument;
}

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

beforeEach(async () => {
  previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "issue-193-native-restart-"));
  delete process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = home;
  chatGptTurnSessions.clear();
  await closeNativeChatGptContinuityStores();
});

afterEach(async () => {
  await closeNativeChatGptContinuityStores();
  chatGptTurnSessions.clear();
  if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
  else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
  if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
  rmSync(home, { recursive: true, force: true });
});

function installDurableConfig(): string {
  const file = join(home, "conversations.json");
  saveConfig({ ...defaultConfig(), webChat: { conversationStorePath: file } });
  return file;
}

/**
 * One settled first turn through the real path: it installs the conversation, the browser turn
 * settles, the adapter confirms the record, and the runtime shuts down.
 */
async function settleFirstTurn(file: string): Promise<void> {
  // Each test starts from a clean process: the generation counter and the installation state live in
  // the session registry, and a test that inherits the previous one would not be a first turn.
  chatGptTurnSessions.clear();
  const surface = new ControlledSurface();
  surface.next = { activate: true, submit: true, answer: "respuesta del turno uno" };
  const adapter = nativeAdapter(surface);
  await runTurn(adapter, parsed({ turn: "turn-1" }));
  await adapter.shutdown?.();
  // The restart boundary: the process ends, so everything the process kept about the installation —
  // the sent-system fingerprints and the retirements — is gone, while the durable file survives.
  // Without this the next turn is an exact resume of state the restarted process never established.
  chatGptTurnSessions.clear();
  // The record the restart finds: generation 1, confirmed by the settled turn.
  expect(durableFile(file).records[0]?.generation).toBe(1);
  expect(durableFile(file).records[0]?.checkpoint).toBe("confirmed");
}

describe("issue #193 — a restart replays durably through the real native path", () => {
  test("the restart's next turn is an explicit replay, unconfirmed until it settles successfully", async () => {
    const file = installDurableConfig();
    await settleFirstTurn(file);

    // Restart: the durable record survives, the process-local installation state does not.
    const surface = new ControlledSurface();
    surface.next = { activate: true, submit: true, answer: "respuesta del turno dos" };
    let inFlight: Awaited<ReturnType<typeof durableRecords>> | undefined;
    surface.beforeSettle = async () => { inFlight = await durableRecords(); };
    const adapter = nativeAdapter(surface);

    await runTurn(adapter, parsed({ turn: "turn-2" }));

    // The decision was an explicit replay of the recorded conversation: the generation advanced by one
    // (a continuation would have kept generation 1 and a new conversation would not have advanced it),
    // and the replay rebuilt the prompt from canonical host history.
    expect(surface.runs).toHaveLength(1);
    expect(surface.runs[0]?.prompt).toContain("arregla el bug");
    expect(inFlight).toHaveLength(1);
    expect(inFlight?.[0]?.generation).toBe(2);
    expect(inFlight?.[0]?.identity.key).toBe((await durableRecords())[0]?.identity.key);
    // Unconfirmed while the turn is in flight, and with no settled turn recorded yet.
    expect(inFlight?.[0]?.checkpoint).toBe("unconfirmed");
    expect(inFlight?.[0]?.lastConfirmedTurn).toBeUndefined();

    // Only the settled turn confirms it.
    const settled = await durableRecords();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.generation).toBe(2);
    expect(settled[0]?.checkpoint).toBe("confirmed");
    expect(settled[0]?.lastConfirmedTurn?.turnId).toBe("turn-2");
  });

  test("a failed or ambiguous turn cannot be resumed as confirmed", async () => {
    const file = installDurableConfig();
    await settleFirstTurn(file);

    // Restart, and the browser turn fails after Send activation: the prompt may have reached ChatGPT,
    // so nothing about this attempt is proof of continuation.
    const failedSurface = new ControlledSurface();
    failedSurface.next = { activate: true, submit: false, fail: new Error("browser session lost") };
    const failing = nativeAdapter(failedSurface);
    // The native adapter reports a failed browser turn as an error event (it settled the turn as
    // failed), not by throwing: what matters here is that nothing about this attempt became proof of
    // continuation.
    const failedEvents = await runTurn(failing, parsed({ turn: "turn-2" }));
    expect(failedEvents.some(event => event.type === "error")).toBe(true);
    await failing.shutdown?.();

    // The replayed generation is registered but never confirmed.
    expect(durableFile(file).records[0]?.generation).toBe(2);
    expect(durableFile(file).records[0]?.checkpoint).toBe("unconfirmed");
    expect(durableFile(file).records[0]?.lastConfirmedTurn).toBeUndefined();

    // A later turn does not treat it as resumable: it replays again (generation 3) rather than
    // continuing a conversation whose last attempt was never confirmed.
    const surface = new ControlledSurface();
    surface.next = { activate: true, submit: true, answer: "respuesta del turno tres" };
    let inFlight: Awaited<ReturnType<typeof durableRecords>> | undefined;
    surface.beforeSettle = async () => { inFlight = await durableRecords(); };
    const adapter = nativeAdapter(surface);
    await runTurn(adapter, parsed({ turn: "turn-3" }));

    expect(inFlight?.[0]?.generation).toBe(3);
    expect(inFlight?.[0]?.checkpoint).toBe("unconfirmed");
    expect(durableFile(file).records[0]?.checkpoint).toBe("confirmed");
    expect(durableFile(file).records[0]?.lastConfirmedTurn?.turnId).toBe("turn-3");
  });

  test("without canonical history the restart fails explicitly and leaves the durable file intact", async () => {
    const file = installDurableConfig();
    await settleFirstTurn(file);
    const before = readFileSync(file, "utf8");

    const surface = new ControlledSurface();
    const adapter = nativeAdapter(surface);
    // The ChatGPT native transport requires the current turn's user message, so a request with no
    // messages at all cannot even be keyed: the turn fails explicitly with the provider's own error,
    // before any browser run and without creating or replacing a conversation. The narrower
    // "recorded conversation but nothing to rebuild from" guard is exercised where it is reachable —
    // at the continuity decision — by the durable suite.
    await expect(runTurn(adapter, parsed({ turn: "turn-2", withHistory: false }))).rejects.toThrow();

    // No browser turn was attempted, no new conversation was created, and the durable record is
    // byte-for-byte the one the previous process left behind.
    expect(surface.runs).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(durableFile(file).records).toHaveLength(1);
    expect(durableFile(file).records[0]?.generation).toBe(1);
    expect(durableFile(file).records[0]?.checkpoint).toBe("confirmed");
    expect(durableFile(file).records[0]?.lastConfirmedTurn?.turnId).toBe("turn-1");
  });
});
