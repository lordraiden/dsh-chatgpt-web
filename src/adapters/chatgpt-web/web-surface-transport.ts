import type { CodexProviderConfig } from "../../types";
import type { ChatGptWebCapabilities } from "./model";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { CapturedChatGptLunaCheckpoint } from "./rolling-checkpoint";
import type { ChatGptTurnProgressReader } from "./turn-progress";
import {
  ChatGptBrowserWorker,
  closeChatGptBrowserWorkers,
  type BrowserTurn,
  type ChatGptBrowserPhysicalSurface,
} from "./browser-worker";

export interface WebSurfacePhysicalSurface {
  resourceId: string;
  browserContextId: string;
  pageId: string;
  profileId: string;
  accountId: string;
}

export interface WebSurfaceTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Select the Codex Native connector without advertising the ordinary turn tool environment. */
  nativeConnector?: boolean;
  retainConversation?: boolean;
  requireRetainedConversation?: boolean;
  conversationKey?: string;
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  /** Abort requested by the owning ProviderCore turn. The transport never turns this into new authority. */
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Semantic send activation; after this point the owner must not replay the prompt on a fresh surface. */
  onSendActivated?: () => void | Promise<void>;
  /** Semantic submission evidence proving that the provider accepted the prompt. */
  onSubmitted?: () => void;
  /** Semantic identity of the physical browser surface; no browser/Playwright object crosses this boundary. */
  onPhysicalSurfaceBound?: (binding: WebSurfacePhysicalSurface) => void | Promise<void>;
  /** Surface is ready after authentication, temporary-chat preparation, and model setup. */
  onSurfaceReady?: () => void | Promise<void>;
  /** Visible reasoning-summary titles only; hidden chain-of-thought never crosses the boundary. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only Markdown answer data. */
  onTextDelta: (delta: string) => void;
  /** Proven current-turn MCP activity; never response content or completion. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Atomically fences browser completion against concurrent MCP claims in the turn broker. */
  completionFence?: {
    begin(): Promise<number | undefined>;
    commit(revision: number): Promise<boolean>;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
}

/**
 * One finalized answer read back from a retained conversation through this transport boundary.
 * Declared here (Playwright-free) so upper provider layers never import browser implementation
 * types; the browser backend maps its own shape onto it.
 */
export interface WebSurfaceRetainedAnswer {
  /** Finalized answer text, trimmed. */
  text: string;
  /** When the answer was read (epoch ms). */
  capturedAt: number;
  /** How long the read waited for the finalized turn. */
  waitedMs: number;
}

export interface WebSurfaceInspection {
  authenticated: true;
  temporary: false;
  url: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

/**
 * Browser-worker adaptation lives only in this provider transport implementation.
 *
 * Upper layers receive WebSurfaceTurn/WebSurfacePhysicalSurface and never import BrowserTurn,
 * Playwright types, selectors, or DOM structures.
 */
export interface WebSurfaceTransportBackend {
  run(turn: WebSurfaceTurn): Promise<string>;
  verifyConnector(traceId?: string): Promise<string>;
  inspectSession(detectCapabilities: boolean): Promise<WebSurfaceInspection>;
  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }>;
  /** Read the finalized answer of an existing retained conversation; never creates one. */
  recoverRetainedAnswer(
    conversationKey: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WebSurfaceRetainedAnswer>;
  close(): Promise<void>;
}

function toBrowserTurn(turn: WebSurfaceTurn): BrowserTurn {
  return {
    traceId: turn.traceId,
    modelId: turn.modelId,
    reasoning: turn.reasoning,
    capabilities: turn.capabilities,
    prepare: turn.prepare,
    prepareResume: turn.prepareResume,
    nativeConnector: turn.nativeConnector,
    retainConversation: turn.retainConversation,
    requireRetainedConversation: turn.requireRetainedConversation,
    conversationKey: turn.conversationKey,
    onPreparedSelected: turn.onPreparedSelected,
    abortSignal: turn.abortSignal,
    onHeartbeat: turn.onHeartbeat,
    onSendActivated: turn.onSendActivated,
    onSubmitted: turn.onSubmitted,
    onPhysicalSurfaceBound: async binding => {
      await turn.onPhysicalSurfaceBound?.({
        resourceId: binding.resourceId,
        browserContextId: binding.browserContextId,
        pageId: binding.pageId,
        profileId: binding.profileId,
        accountId: binding.accountId,
      });
    },
    onSurfaceReady: turn.onSurfaceReady,
    onReasoningSummary: turn.onReasoningSummary,
    onCommentary: turn.onCommentary,
    onTextDelta: turn.onTextDelta,
    externalProgress: turn.externalProgress,
    completionFence: turn.completionFence,
    compaction: turn.compaction,
    captureLunaCheckpoint: turn.captureLunaCheckpoint,
    onLunaCheckpoint: turn.onLunaCheckpoint,
  };
}

class ChatGptBrowserWorkerBackend implements WebSurfaceTransportBackend {
  constructor(private readonly worker: ChatGptBrowserWorker) {}

  run(turn: WebSurfaceTurn): Promise<string> {
    return this.worker.run(toBrowserTurn(turn));
  }

  verifyConnector(traceId?: string): Promise<string> {
    return this.worker.verifyConnector(traceId);
  }

  inspectSession(detectCapabilities: boolean): Promise<WebSurfaceInspection> {
    return this.worker.inspectSession(detectCapabilities);
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.worker.smokeTest(abortSignal);
  }

  async recoverRetainedAnswer(
    conversationKey: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WebSurfaceRetainedAnswer> {
    const answer = await this.worker.recoverRetainedAnswer(conversationKey, options);
    return { text: answer.text, capturedAt: answer.capturedAt, waitedMs: answer.waitedMs };
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}

export interface WebSurfaceTransport {
  run(turn: WebSurfaceTurn): Promise<string>;
  verifyConnector(traceId?: string): Promise<string>;
  inspectSession(detectCapabilities: boolean): Promise<WebSurfaceInspection>;
  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }>;
  recoverRetainedAnswer(
    conversationKey: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WebSurfaceRetainedAnswer>;
  close(): Promise<void>;
}

export class ChatGptWebSurfaceTransport implements WebSurfaceTransport {
  constructor(private readonly backend: WebSurfaceTransportBackend) {}

  run(turn: WebSurfaceTurn): Promise<string> {
    return this.backend.run(turn);
  }

  verifyConnector(traceId?: string): Promise<string> {
    return this.backend.verifyConnector(traceId);
  }

  inspectSession(detectCapabilities: boolean): Promise<WebSurfaceInspection> {
    return this.backend.inspectSession(detectCapabilities);
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.backend.smokeTest(abortSignal);
  }

  recoverRetainedAnswer(
    conversationKey: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WebSurfaceRetainedAnswer> {
    return this.backend.recoverRetainedAnswer(conversationKey, options);
  }

  close(): Promise<void> {
    return this.backend.close();
  }
}

export function chatGptWebSurfaceTransportForProvider(
  provider: CodexProviderConfig,
): ChatGptWebSurfaceTransport {
  return new ChatGptWebSurfaceTransport(
    new ChatGptBrowserWorkerBackend(ChatGptBrowserWorker.forProvider(provider)),
  );
}

export function closeChatGptWebSurfaceTransports(): Promise<void> {
  return closeChatGptBrowserWorkers();
}
