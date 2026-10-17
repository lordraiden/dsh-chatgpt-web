/**
 * Shared behavioural harness: drive the production ChatGPT-Web adapter through a controlled
 * `WebSurfaceTransport`.
 *
 * The adapter factory accepts an injected `surfaceTransport`, so a suite can run a real turn
 * (prompt compilation, provider-core lifecycle, diagnostics, settlement) without a browser. This is
 * the seam the source-text assertions were meant to protect, expressed as observable behaviour.
 *
 * It is a plain module, not a test file: it defines no test and is never added to the `test` script.
 */
import { join } from "node:path";

import { chatGptContinuationPromptMissingError } from "../../src/adapters/chatgpt-web/adapter-error";
import type {
  ChatGptWebSurfaceTransport,
  WebSurfaceTurn,
} from "../../src/adapters/chatgpt-web/web-surface-transport";
import type { CodexParsedRequest, CodexProviderConfig } from "../../src/types";

export const CONTROLLED_ACCOUNT = "controlled-surface-account";

/** A provider config that never reaches a browser: the surface transport is injected. */
export function controlledProviderConfig(home: string): CodexProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:17841",
    chatgptWeb: {
      accountIdentityFingerprint: CONTROLLED_ACCOUNT,
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      storageStatePath: join(home, "browser-state.json"),
      chromeExecutablePath: "/usr/bin/chromium",
      brokerSocketPath: join(home, "turn-broker.sock"),
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
      capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
      experimentalBiggerContext: false,
    },
  } as unknown as CodexProviderConfig;
}

/** One recorded surface turn: what the adapter actually asked the transport to do. */
export interface ControlledSurfaceRun {
  readonly turn: WebSurfaceTurn;
  readonly prompt: string;
  sendAttempts: number;
  confirmedSubmissions: number;
}

/** What the next surface turn should do. Defaults to a clean successful answer. */
export interface ControlledSurfacePlan {
  answer?: string;
  /** Thrown after a confirmed submission (the provider failed mid-turn). */
  error?: Error;
  /** Thrown before send activation (the surface/authentication failed). */
  failBeforeSend?: Error;
}

export class ControlledSurface {
  readonly runs: ControlledSurfaceRun[] = [];
  private readonly plans: ControlledSurfacePlan[] = [];
  /**
   * Conversation keys this fixture has already served, so a later turn on one of them is a resume even
   * when another conversation ran in between — the shape the production surface keeps per retained
   * conversation, and the shape an ephemeral turn (which retains nothing) leaves untouched.
   */
  private readonly retainedConversationKeys = new Set<string>();

  enqueue(plan: ControlledSurfacePlan): void {
    this.plans.push(plan);
  }

  get lastRun(): ControlledSurfaceRun | undefined {
    return this.runs.at(-1);
  }

  get transport(): ChatGptWebSurfaceTransport {
    return {
      run: async (turn: WebSurfaceTurn): Promise<string> => {
        const plan = this.plans.shift() ?? {};
        const reused = turn.conversationKey !== undefined
          && this.retainedConversationKeys.has(turn.conversationKey);
        await turn.onPreparedSelected?.(reused);
        const prepare = reused ? turn.prepareResume : turn.prepare;
        if (!prepare) throw chatGptContinuationPromptMissingError();
        const compiled = await prepare();
        try {
          const run: ControlledSurfaceRun = {
            turn,
            prompt: compiled.text,
            sendAttempts: 0,
            confirmedSubmissions: 0,
          };
          this.runs.push(run);
          await turn.onPhysicalSurfaceBound?.({
            resourceId: `surface:${turn.conversationKey ?? turn.traceId}`,
            browserContextId: "controlled-context",
            pageId: "controlled-page",
            profileId: "controlled-profile",
            accountId: `chatgpt-account:${CONTROLLED_ACCOUNT}`,
          });
          await turn.onSurfaceReady?.();
          if (plan.failBeforeSend) throw plan.failBeforeSend;
          await turn.onSendActivated?.();
          run.sendAttempts += 1;
          turn.onSubmitted?.();
          run.confirmedSubmissions += 1;
          if (plan.error) throw plan.error;
          const answer = plan.answer ?? "controlled answer";
          turn.onTextDelta(answer);
          if (turn.conversationKey !== undefined) {
            this.retainedConversationKeys.add(turn.conversationKey);
          }
          return answer;
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

let parsedCounter = 0;

/** A minimal DSH-shaped request the adapter accepts. */
export function controlledParsed(input: {
  userText?: string;
  systemPrompt?: string[];
  modelId?: string;
  reasoning?: string;
  turnId?: string;
} = {}): CodexParsedRequest {
  parsedCounter += 1;
  const turnId = input.turnId ?? `controlled-turn-${parsedCounter}`;
  return {
    modelId: input.modelId ?? "gpt-5.6-luna",
    context: {
      systemPrompt: input.systemPrompt ?? ["You are a controlled test assistant."],
      messages: [{ role: "user", content: [{ type: "text", text: input.userText ?? "hello" }] }],
    },
    stream: false,
    options: { reasoning: input.reasoning ?? "low" },
    _dshContext: {
      dshSessionId: "controlled-session",
      threadId: "controlled-thread",
      turnId,
    },
  } as unknown as CodexParsedRequest;
}

/** The incoming metadata the adapter expects; only headers and an optional signal are read. */
export function controlledIncoming(abortSignal?: AbortSignal): { headers: Headers; abortSignal?: AbortSignal } {
  return { headers: new Headers(), ...(abortSignal ? { abortSignal } : {}) };
}

export interface ConsoleCapture {
  readonly lines: string[];
  text(): string;
  restore(): void;
}

/** Capture every `console.*` line emitted while a scenario runs. Always `restore()` in `finally`. */
export function captureConsole(): ConsoleCapture {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(argument => typeof argument === "string" ? argument : safelyStringify(argument)).join(" "));
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  console.debug = record;
  return {
    lines,
    text: () => lines.join("\n"),
    restore: () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
    },
  };
}

function safelyStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
