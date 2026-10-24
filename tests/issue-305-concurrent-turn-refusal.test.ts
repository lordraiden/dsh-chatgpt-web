import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CHATGPT_RETAINED_SURFACE_BUSY_CODE,
  ChatGptWebAdapterError,
  chatGptRetainedSurfaceBusyError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";
import { closeNativeChatGptContinuityStores, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { BrowserAccountLeaseRegistry, ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { classifyChatGptWebFailure } from "../src/adapters/chatgpt-web/web-chat-bridge";
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
 * Issue #305 — a concurrent-turn refusal on one conversation is a **local admission decision**, and it
 * must be published as one, never as `upstream_server_error`.
 *
 * The reproduction against the real deployment (image of `962d67c`): two overlapping
 * `/v1/chat/completions` requests on the same identity. One answers `200` with content; the other is
 * refused in ~0 ms as
 *
 *   502 {"error":{"message":"ChatGPT Web cannot synchronously start a second provider turn for an
 *        active native DSH thread","type":"server_error","code":"upstream_server_error"}}
 *
 * The refusal itself is correct — architecture §"one active turn per logical conversation" — but the
 * category lies: a local "a turn is already running, wait" was reported as "the provider failed", and
 * those two are resolved in opposite ways. This is the class already retired in #302 and #301.
 *
 * The tests drive the **real route** a `/v1/chat/completions` caller takes — the real HTTP listener,
 * the OpenAI translation, the Responses parser, the catalogue route resolution and the real adapter —
 * with only the browser I/O replaced by a controlled surface, exactly like the #302 suite. The
 * ProviderCore is the listener's own shared instance, so the two requests are two turns of ONE process,
 * which is what the deployment had.
 *
 * The reference body to re-measure on a deployment is the one asserted in the acceptance test below.
 */
let home: string;
let savedHome: SavedChatGptWebHome;
const servers: RunningServer[] = [];
const API_KEY = "issue-305-test-api-key-0123456789";

beforeEach(async () => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-305-refusal-", { clearFreeHome: true });
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

/**
 * A controlled surface whose FIRST turn is held open, so a second overlapping request arrives while a
 * turn for the same conversation is genuinely in flight — the only shape that reaches the admission
 * guard. It mirrors the shared `ControlledSurface` harness, plus the hold.
 */
class GatedSurface {
  readonly runs: Array<{ readonly turn: WebSurfaceTurn; readonly prompt: string }> = [];
  private previousConversationKey: string | undefined;
  private release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  private readonly firstSubmittedSignal: Promise<void>;
  private firstSubmittedResolve!: () => void;
  firstSettled = false;

  constructor() {
    this.firstSubmittedSignal = new Promise<void>(resolve => { this.firstSubmittedResolve = resolve; });
  }

  /** Resolves when the held (first) turn has reached its confirmed submission. */
  get firstSubmitted(): Promise<void> {
    return this.firstSubmittedSignal;
  }

  /** Let the held turn finish. */
  open(): void {
    this.release();
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const index = this.runs.length + 1;
        const reused = turn.conversationKey !== undefined && turn.conversationKey === this.previousConversationKey;
        await turn.onPreparedSelected?.(reused);
        const prepare = reused ? turn.prepareResume : turn.prepare;
        if (!prepare) throw new Error("the gated surface was asked to resume without a continuation prompt");
        const compiled = await prepare();
        try {
          this.runs.push({ turn, prompt: compiled.text });
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `surface-${index}`,
            browserContextId: "controlled-context",
            pageId: `controlled-page-${index}`,
            profileId: "controlled-profile",
            accountId: `chatgpt-account:${CONTROLLED_ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();
          await turn.onSendActivated?.();
          turn.onSubmitted?.();
          if (index === 1) {
            this.firstSubmittedResolve();
            await this.gate;
          }
          this.previousConversationKey = turn.conversationKey;
          turn.onTextDelta(`answer-${index}`);
          return `answer-${index}`;
        } finally {
          compiled.release();
          if (index === 1) this.firstSettled = true;
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

/**
 * The conversation-admission bound this suite injects.
 *
 * Admission now waits for a busy conversation before refusing (the #305 follow-up), so the assertion
 * that the second request is refused *while the first is still held* needs a deterministic bound
 * rather than the production 60 s shared housekeeping deadline. Every assertion below is unchanged:
 * same refusal, same category, same message, same point — only *when* it is decided moved to the end
 * of the bound.
 */
const ADMISSION_BOUND_MS = 250;

function serve(surface: GatedSurface): RunningServer {
  const server = startServer(
    { ...defaultConfig(), port: 0, host: "127.0.0.1" } as never,
    {
      providerCore: new ChatGptWebProviderCore(
        "chatgpt-web",
        new BrowserAccountLeaseRegistry(),
        5_000,
        ADMISSION_BOUND_MS,
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

interface FailureBody {
  readonly status: number;
  readonly error?: { readonly message?: string; readonly type?: string; readonly code?: string };
}

async function postTurn(server: RunningServer, content: string): Promise<FailureBody & { readonly content?: string }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      connection: "close",
    },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      // A stable caller identity: both requests address ONE conversation.
      user: "issue-305-one-identity",
      messages: [{ role: "user", content }],
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return {
    status: response.status,
    ...(payload.error ? { error: payload.error as FailureBody["error"] } : {}),
    ...(choices?.[0]?.message?.content !== undefined ? { content: choices[0]!.message!.content } : {}),
  };
}

/** Await `work`, but never let a queued (instead of refused) request hang the suite. */
async function withDeadline<T>(work: Promise<T>, budgetMs = 5_000): Promise<T | "hung"> {
  return Promise.race([
    work,
    new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), budgetMs)),
  ]);
}

/**
 * One `/v1/responses` turn on a native thread identity — the surface the DSH consumer itself uses. The
 * identity travels in the same `client_metadata` channel the `/v1/chat/completions` translation fills.
 */
async function postResponsesTurn(
  server: RunningServer,
  content: string,
): Promise<{ readonly status: number; readonly responseStatus?: string; readonly error?: FailureBody["error"] }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, connection: "close" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: content }] }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "issue-305-responses-identity" }) },
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  return {
    status: response.status,
    ...(typeof payload.status === "string" ? { responseStatus: payload.status } : {}),
    ...(payload.error ? { error: payload.error as FailureBody["error"] } : {}),
  };
}

const SNAPSHOT_CREATED_AT = 1_700_000_000_000;

function admissionInput(turnId: string, nativeThreadId: string) {
  const nativeTurnId = `native-${turnId}`;
  return {
    executionKey: `execution-${turnId}`,
    traceId: `trace-${turnId}`,
    nativeTurnId,
    nativeThreadId,
    accountIdentity: "account-shared",
    browserProfile: "managed-chrome",
    browserContext: "context-1",
    pageIdentity: `page-${turnId}`,
    capabilitySnapshot: projectChatGptCapabilities({
      sessionId: `session-${turnId}`,
      agentId: `agent-${turnId}`,
      turnId: nativeTurnId,
      tools: [],
      createdAt: SNAPSHOT_CREATED_AT,
    }),
  };
}

function refusalOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the operation to be refused, but it succeeded");
}

describe("issue #305 — a concurrent-turn refusal on one conversation reports its own category", () => {
  test("two overlapping turns on one identity: one answers, the other is refused with its own category, never a provider failure", async () => {
    const surface = new GatedSurface();
    const server = serve(surface);

    // Turn 1: admitted, reaches its browser submission, and is held there — a turn in flight.
    const first = postTurn(server, "primera pregunta");
    let firstResult: Awaited<ReturnType<typeof postTurn>> | "hung" = "hung";
    try {
      await surface.firstSubmitted;

      // Turn 2: the same identity, while turn 1 is still in flight. This is the measured case.
      const second = await withDeadline(postTurn(server, "segunda pregunta"));
      expect(second).not.toBe("hung");
      if (second === "hung") return;

      // Refused, and refused **concurrently**: the answer arrives while the first turn is still held, so
      // the refusal was returned, not queued behind the in-flight turn.
      expect(surface.firstSettled).toBe(false);

      // The acceptance criterion: its own category, never `upstream_server_error`, never a 5xx meaning
      // "the provider failed".
      expect(second.status).toBeLessThan(500);
      expect(second.error?.code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
      expect(second.error?.code).not.toBe("upstream_server_error");
      expect(second.error?.type).not.toBe("server_error");
      expect(second.error?.code).toBe(chatGptRetainedSurfaceBusyError().code);
      expect(classifyChatGptWebFailure(second.error)).toBe("TRANSPORT_UNAVAILABLE");
      // The message says what the caller should do, not an internal state.
      expect(second.error?.message).toMatch(/another turn|concurrent turns/i);

      // Admission was not relaxed and the refused turn never touched the provider: no second browser run.
      expect(surface.runs).toHaveLength(1);

      // Released: the in-flight turn still answers normally.
      surface.open();
      firstResult = await withDeadline(first);
    } finally {
      // Never leave the held turn dangling when an assertion above fails: an unawaited request would
      // otherwise reject after the listener stops and surface as an unrelated suite error.
      surface.open();
      await first.catch(() => undefined);
    }

    expect(firstResult).not.toBe("hung");
    if (firstResult === "hung") return;
    expect(firstResult.status).toBe(200);
    expect(firstResult.content).toBe("answer-1");
    expect(surface.runs).toHaveLength(1);
  });

  test("the same overlap on /v1/responses publishes the same own category in the failed response envelope", async () => {
    const surface = new GatedSurface();
    const server = serve(surface);

    const first = postResponsesTurn(server, "primera pregunta");
    let firstResult: Awaited<ReturnType<typeof postResponsesTurn>> | "hung" = "hung";
    try {
      await surface.firstSubmitted;
      const second = await withDeadline(postResponsesTurn(server, "segunda pregunta"));
      expect(second).not.toBe("hung");
      if (second === "hung") return;

      // The Responses surface never fabricates an HTTP status for a failed turn; what it must publish
      // is the failed envelope carrying the turn's own category instead of `upstream_server_error`.
      expect(second.responseStatus).toBe("failed");
      expect(second.error?.code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
      expect(second.error?.code).not.toBe("upstream_server_error");
      expect(second.error?.type).not.toBe("server_error");
      expect(surface.runs).toHaveLength(1);

      surface.open();
      firstResult = await withDeadline(first);
    } finally {
      surface.open();
      await first.catch(() => undefined);
    }

    expect(firstResult).not.toBe("hung");
    if (firstResult === "hung") return;
    expect(firstResult.status).toBe(200);
    expect(firstResult.responseStatus).toBe("completed");
  });

  test("the refusal is the typed local refusal at the ProviderCore owner, and the same refusal still happens at the same point", () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const first = core.begin(admissionInput("first", "thread-shared"));
    expect(first.snapshot().state).toBe("LEASED");

    const refusal = refusalOf(() => core.begin(admissionInput("second", "thread-shared")));

    // Typed, and the same sibling category the busy-surface refusal publishes: one active turn per
    // logical conversation is one refusal, whoever enforces it.
    expect(refusal).toBeInstanceOf(ChatGptWebAdapterError);
    const typed = refusal as ChatGptWebAdapterError;
    expect(typed.code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
    expect(typed.name).toBe("ChatGptWebAdapterError");
    expect(typed.retryable).toBe(false);
    expect(typed.status).toBeLessThan(500);
    expect(classifyChatGptWebFailure(typed)).toBe("TRANSPORT_UNAVAILABLE");

    // Same point, same strictness: the refused turn acquired no lease and did not become a turn.
    expect(leases.activeCount()).toBe(1);
    expect(core.get("execution-second")).toBeUndefined();

    // The guard is not a permanent lock: the predecessor's physical settlement frees the thread.
    first.failBeforePhysicalSettlement();
    const next = core.begin(admissionInput("third", "thread-shared"));
    expect(next.snapshot().state).toBe("LEASED");
    expect(leases.activeCount()).toBe(1);
  });

  test("the second bare-Error guard on this path is typed too: a cancellation callback can only be attached once", () => {
    const leases = new BrowserAccountLeaseRegistry();
    const core = new ChatGptWebProviderCore("chatgpt-web", leases);
    const turn = core.begin(admissionInput("first", "thread-shared"));

    // The first attachment is the legitimate one.
    turn.attachCancellation(() => {});
    // A second turn that reused this lifecycle has one already: that is the same concurrent-turn
    // refusal, and it must not surface as a bare `Error` the bridge normalizes to a 502.
    const refusal = refusalOf(() => turn.attachCancellation(() => {}));
    expect(refusal).toBeInstanceOf(ChatGptWebAdapterError);
    expect((refusal as ChatGptWebAdapterError).code).toBe(CHATGPT_RETAINED_SURFACE_BUSY_CODE);
    expect(classifyChatGptWebFailure(refusal as ChatGptWebAdapterError)).toBe("TRANSPORT_UNAVAILABLE");
    expect(leases.activeCount()).toBe(1);
  });
});
