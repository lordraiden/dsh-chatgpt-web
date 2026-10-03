import type { CodexProviderConfig } from "../../types";
import {
  ChatGptBrowserWorker,
  closeChatGptBrowserWorkers,
  type BrowserTurn,
  type ChatGptBrowserPhysicalSurface,
} from "./browser-worker";

export type WebSurfaceTurn = BrowserTurn;
export type WebSurfacePhysicalSurface = ChatGptBrowserPhysicalSurface;

export interface WebSurfaceInspection {
  authenticated: true;
  temporary: true;
  url: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

export interface WebSurfaceTransportBackend {
  run(turn: WebSurfaceTurn): Promise<string>;
  verifyConnector(traceId?: string): Promise<string>;
  inspectSession(detectCapabilities: boolean): Promise<WebSurfaceInspection>;
  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }>;
  close(): Promise<void>;
}

/**
 * Semantic boundary around the ChatGPT-specific browser implementation.
 *
 * ProviderCore may depend on this contract, but never on ChatGPT DOM selectors, Playwright
 * objects, or browser-worker implementation details. Lifecycle evidence is carried by
 * semantic callbacks on WebSurfaceTurn; the transport owns the provider-specific mechanics.
 */
export interface WebSurfaceTransport {
  run(turn: WebSurfaceTurn): Promise<string>;
  verifyConnector(traceId?: string): Promise<string>;
  inspectSession(detectCapabilities: boolean): Promise<WebSurfaceInspection>;
  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }>;
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

  close(): Promise<void> {
    return this.backend.close();
  }
}

export function chatGptWebSurfaceTransportForProvider(
  provider: CodexProviderConfig,
): ChatGptWebSurfaceTransport {
  return new ChatGptWebSurfaceTransport(ChatGptBrowserWorker.forProvider(provider));
}

export function closeChatGptWebSurfaceTransports(): Promise<void> {
  return closeChatGptBrowserWorkers();
}
