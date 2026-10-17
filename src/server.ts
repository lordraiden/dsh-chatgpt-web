import { chatGptWebTraceId, createChatGptWebAdapter, type ChatGptWebProviderAdapter } from "./adapters/chatgpt-web";
import {
  CHATGPT_WEB_AUTH_PROVIDER_LABEL,
  createChatGptWebAuthController,
  type ChatGptWebAuthStoredIdentity,
} from "./adapters/chatgpt-web/auth-controller";
import { CHATGPT_WEB_DRIVER_ID } from "./web-chat/host/provider-host";
import { createChatGptWebProviderRuntime } from "./adapters/chatgpt-web/provider-runtime";
import {
  AdvisorHostError,
  ADVISOR_INPUT_INVALID_CODE,
  ADVISOR_MODEL_UNAVAILABLE_CODE,
  ADVISOR_TASK_UNAVAILABLE_CODE,
  createAdvisorHost,
  validateAdvisorRecoveryRequest,
  validateAdvisorReviewSource,
  type AdvisorHost,
} from "./advisor";
import type { WebChatProviderRuntime } from "./web-chat/host/text-turn";
import { WEB_CHAT_AUTH_PAGE_HTML, WEB_CHAT_AUTH_PAGE_PATHS } from "./web-chat/host/auth-page";
import {
  createWebChatAuthSurface,
  type WebChatAuthSessionView,
  type WebChatAuthStreamEvent,
  type WebChatAuthSurface,
  type WebChatAuthSurfaceOptions,
} from "./web-chat/host/auth-surface";
import { isAuthInput, isWebChatError, type AuthInput, type WebChatErrorCategory } from "./web-chat/core";
import { ChatGptWebProviderCore } from "./adapters/chatgpt-web/provider-core";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeNativeChatGptContinuityStores } from "./adapters/chatgpt-web/index";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import {
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  cancelStructuredCompactionTrace,
} from "./adapters/chatgpt-web/compaction-handoff";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
  extractChatGptTurnIdentity,
  extractCodexTurnIdentityFromBody,
} from "./adapters/chatgpt-web/environment";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import {
  buildOpenAiModelsData,
  responseFailure,
  toChatCompletion,
  toChatCompletionStream,
  translateChatCompletionsRequest,
} from "./responses/chat-completions";
import type { AppConfig } from "./config";
import {
  CHATGPT_WEB_TUNING_DEFAULTS,
  getConfigDir,
  isLoopbackHost,
  resolveApiKey,
  resolveChatGptWebTuning,
  resolveProviderStorageStatePath,
  saveConfig,
  validateChatGptWebTuning,
} from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody, RequestBodyTooLargeError } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { safeErrorDescriptor } from "./lib/safe-diagnostics";
import { augmentNativeModelCatalog, buildChatGptWebModelCatalog } from "./model-catalog";
import { effectiveChatGptWebProviderConfig } from "./chatgpt-web-provider-config";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
  type CodexModelContextOverride,
} from "./codex-integration";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebInternalBackendModel,
  isChatGptWebModelSlug,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import {
  createChatGptWebRouteAuthorityFromProvider,
  requireChatGptWebRoute,
} from "./chatgpt-web-authority";
import { forwardNativeCodexRequest, type NativeFetch } from "./native-passthrough";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";

type HttpTrackedEndpoint = "models" | "responses" | "chat-completions" | "compact" | "search" | "unspecified";

export interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export interface HttpStreamFailureEvidence {
  httpTurnId: number;
  endpoint: HttpTrackedEndpoint;
  reader: "client" | "windows_lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

type HttpStreamFailureReporter = (evidence: HttpStreamFailureEvidence) => void;

function safeStreamErrorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;
}

function streamFailureEvidence(
  error: unknown,
  httpTurnId: number,
  endpoint: HttpTrackedEndpoint,
  reader: HttpStreamFailureEvidence["reader"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureEvidence {
  const candidate = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  return {
    httpTurnId,
    endpoint,
    reader,
    platform,
    chunks,
    bytes,
    errorName: safeStreamErrorField(candidate.name, "Error"),
    errorCode: safeStreamErrorField(candidate.code, "unknown"),
  };
}

const reportHttpStreamFailure: HttpStreamFailureReporter = evidence => {
  console.warn(`[dsh-chatgpt-web] http_stream_failed ${JSON.stringify(evidence)}`);
};

function emitHttpStreamFailure(
  reporter: HttpStreamFailureReporter,
  evidence: HttpStreamFailureEvidence,
): void {
  try {
    reporter(evidence);
  } catch {
    // Diagnostics are a side channel: they must never replace the source stream error or retain
    // HTTP turn ownership after the client has already observed that failure.
  }
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  private identityKey(identity: NativeCodexTurnIdentity): string {
    return `${identity.threadId}\u0000${identity.turnId}`;
  }

  private rememberInterrupted(identity: NativeCodexTurnIdentity, reason: unknown): void {
    const key = this.identityKey(identity);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) {
      const oldest = this.interrupted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interrupted.delete(oldest);
    }
  }

  constructor(private readonly reportStreamFailure: HttpStreamFailureReporter = reportHttpStreamFailure) {}

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async cancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  beginCancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): { cancelled: number; settlement: Promise<void> } {
    this.rememberInterrupted(identity, reason);
    const turns = [...this.active.values()].filter(turn => (
      turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId
    ));
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    return {
      cancelled: turns.length,
      settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined),
    };
  }

  async track(
    run: (
      signal: AbortSignal,
      bindIdentity: (identity: NativeCodexTurnIdentity) => void,
    ) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
    endpoint: HttpTrackedEndpoint = "unspecified",
  ): Promise<Response> {
    const id = this.nextId++;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tracked: {
      abort: AbortController;
      done: Promise<void>;
      finish: () => void;
      identity?: NativeCodexTurnIdentity;
    } = { abort, done, finish };
    this.active.set(id, tracked);
    let released = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    clientAbortListener = () => abort.abort(clientSignal?.reason);
    if (clientSignal?.aborted) abort.abort(clientSignal.reason);
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const response = await run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) {
          throw new Error("Native Codex turn identity must contain a threadId and turnId");
        }
        if (tracked.identity
          && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        tracked.identity = identity;
        const interruptedReason = this.interrupted.get(this.identityKey(identity));
        if (interruptedReason !== undefined && !abort.signal.aborted) abort.abort(interruptedReason);
      });
      if (!response.body) {
        release();
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        release();
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        const reportStreamFailure = this.reportStreamFailure;
        let chunks = 0;
        let bytes = 0;
        streamAbortListener = () => {
          void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
        };
        abort.signal.addEventListener("abort", streamAbortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              chunks += 1;
              bytes += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            } catch (error) {
              if (!abort.signal.aborted) {
                emitHttpStreamFailure(reportStreamFailure, streamFailureEvidence(
                  error,
                  id,
                  endpoint,
                  "client",
                  platform,
                  chunks,
                  bytes,
                ));
              }
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      let chunks = 0;
      let bytes = 0;
      streamAbortListener = () => {
        void Promise.allSettled([
          reader.cancel(abort.signal.reason),
          clientBody.cancel(abort.signal.reason),
        ]).finally(release);
      };
      abort.signal.addEventListener("abort", streamAbortListener, { once: true });
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks += 1;
            bytes += chunk.value.byteLength;
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            emitHttpStreamFailure(this.reportStreamFailure, streamFailureEvidence(
              error,
              id,
              endpoint,
              "windows_lifecycle",
              platform,
              chunks,
              bytes,
            ));
          }
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ChatGptWebProviderAdapter;

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  /** Bind the physical HTTP stream to the exact native Codex turn that owns it. */
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

/**
 * The route authority for one configuration, derived from the **same** effective provider facts every
 * other seam uses (issue #193). This is a view over provider facts, not a second routing authority:
 * DSH still selects the provider, and the sidecar still executes the selected turn.
 */
function chatGptWebRouteAuthority(config: AppConfig) {
  return createChatGptWebRouteAuthorityFromProvider(effectiveChatGptWebProviderConfig(config));
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebRoute(parsed.modelId, chatGptWebRouteAuthority(config));
  parsed.modelId = route.backendModel;
  parsed.options.reasoning = route.adapterEffort;
  return route;
}

/**
 * An oversized body is a 413, not a generic 400 (issue #247). `readJsonRequestBody` throws the typed
 * error; every handler that reads a body maps it through here.
 */
function requestBodyFailure(error: unknown): Response | undefined {
  if (error instanceof RequestBodyTooLargeError) {
    return formatErrorResponse(413, "request_too_large", error.message);
  }
  return undefined;
}

/**
 * Optional per-process cap on concurrently tracked HTTP turns (issue #247). `0` (the default) keeps
 * today's behaviour for the DSH/Codex consumer, which legitimately runs several turns at once;
 * an exposed deployment can set `DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS` and get a typed 429 instead of
 * unbounded queueing.
 */
export function resolveMaxInflightTurns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS;
  const configured = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 0;
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
): Promise<Response> {
  const override = contextOverride?.();
  const webCatalog = buildChatGptWebModelCatalog(config, override);
  let upstream: Response | undefined;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);
  } catch {
    upstream = undefined;
  }

  let catalog: Record<string, unknown> = webCatalog;
  let headers = new Headers({
    "content-type": "application/json",
  });
  let status = 200;
  let statusText = "OK";

  if (upstream?.ok) {
    try {
      catalog = augmentNativeModelCatalog(await upstream.json(), config, override);
      headers = new Headers(upstream.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      status = upstream.status;
      statusText = upstream.statusText;
    } catch {
      // Native Codex catalog corruption must not make the independent Web catalog unavailable.
      catalog = webCatalog;
    }
  }

  // Issue #248: the OpenAI `data` array is ADDITIVE. `models` and the top-level shape stay exactly as
  // they are, so the Codex/DSH consumer needs no change.
  catalog = { ...catalog, data: buildOpenAiModelsData(webCatalog) };
  const body = JSON.stringify(catalog);
  headers.set("content-type", "application/json");
  headers.set("etag", `W/"${createHash("sha256").update(body).digest("base64url")}"`);
  return new Response(body, { status, statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    const tooLarge = requestBodyFailure(error);
    if (tooLarge) return tooLarge;
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    if (isChatGptWebInternalBackendModel(requestedModel)) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT Web backend model IDs are internal implementation identifiers and cannot be selected as public routes",
      );
    }
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    route = routeChatGptWebRequest(parsed, config);
    const identity = extractChatGptTurnIdentity(parsed);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (parsed._opaqueMultiAgentV2Payload) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT Web cannot read this encrypted cross-backend subagent payload. "
        + "Start a new Compatibility V1 task, or delegate from a Web model whose collaboration call uses the plaintext-delivery marker.",
    );
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  if (compaction && route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const provider = effectiveChatGptWebProviderConfig(config);
  let traceId: string | undefined;
  try {
    traceId = chatGptWebTraceId(provider, parsed);
  } catch (error) {
    // A cancelled browser session can only exist after the adapter accepted canonical native
    // turn identity and user-revision metadata. Requests without that identity have no matching
    // trace tombstone; preserve the adapter's existing strict validation/error path below.
    const message = error instanceof Error ? error.message : String(error);
    if (message === CHATGPT_TURN_REVISION_CONFLICT_MESSAGE) {
      // Codex can reopen an interrupted task with only refreshed developer/skill context under a
      // new turn_id. Its last human prompt still belongs to the stopped turn and must not be
      // replayed as new work. HTTP 400 makes that malformed recovery request terminal instead of
      // allowing Codex to retry it as an upstream 502.
      return formatErrorResponse(400, "invalid_request_error", message);
    }
    if (!message.includes("requires native Codex turn_id metadata")
      && !message.includes("requires a current-turn user message")) throw error;
  }
  const cancelledError = traceId ? chatGptTurnSessions.cancelledError(traceId) : undefined;
  if (cancelledError) {
    // Codex retries unknown streamed response.failed codes. A replay after the user explicitly
    // closed the only browser document is instead a terminal client state: repeating that exact
    // request is invalid and must not recreate the DOM. Codex maps HTTP 400 to its non-retryable
    // InvalidRequest category while the body preserves the real client_cancelled classification.
    return new Response(JSON.stringify({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: cancelledError.message,
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const adapter = adapterFactory(provider);
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => {
        options.onAdapterEvent?.(event);
        queue.push(event);
      });
    } catch (error) {
      // A turn that rejects without a terminal event still owes its consumer one, and a typed adapter
      // refusal owes it its **own category**: dropping the classification here made the bridge re-derive
      // one from the message text, which is how a local admission decision was published as an upstream
      // failure (issue #305). The fields are the same ones every other adapter error event carries.
      const event: AdapterEvent = error instanceof ChatGptWebAdapterError
        ? {
            type: "error",
            message: error.message,
            status: error.status,
            errorType: error.errorType,
            code: error.code,
            retryable: error.retryable,
          }
        : { type: "error", message: error instanceof Error ? error.message : String(error) };
      options.onAdapterEvent?.(event);
      queue.push(event);
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(provider.chatgptWeb?.stallTimeoutSec !== undefined
          ? { stallTimeoutSec: provider.chatgptWeb.stallTimeoutSec }
          : {}),
        ...(compaction ? { compaction: true } : {
          ...(options.rememberState === false ? {} : {
            onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, { force: true }),
          }),
        }),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
  });
  if (!compaction && options.rememberState !== false) {
    rememberResponseState(parsed._rawBody, json, { force: true });
  }
  return Response.json(json);
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: Pick<ResponseRequestOptions, "onTurnIdentity"> = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    const tooLarge = requestBodyFailure(error);
    if (tooLarge) return tooLarge;
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    if (isChatGptWebInternalBackendModel(raw.model)) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT Web backend model IDs are internal implementation identifiers and cannot be selected as public routes",
      );
    }
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebRoute(raw.model, chatGptWebRouteAuthority(config));
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, options);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

/** CORS headers for the local DSH Web GUI control surface (127.0.0.1:3080). */
function controlCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "http://127.0.0.1:3080",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

interface RecentBrowserTurnSummary {
  traceId: string;
  capturedAt: string | null;
  checkpoint: string | null;
  error: string | null;
  userTurns: number;
  assistantTurns: number;
}

/** Summarize the newest browser-turn diagnostic directories (last checkpoint of each). */
function readRecentBrowserTurns(limit: number): RecentBrowserTurnSummary[] {
  const root = join(getConfigDir(), "diagnostics", "browser-turns");
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        try {
          return { name: entry.name, mtimeMs: statSync(join(root, entry.name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
  return entries.map(entry => {
    const empty: RecentBrowserTurnSummary = {
      traceId: entry.name.split("-")[0] ?? entry.name,
      capturedAt: null,
      checkpoint: null,
      error: null,
      userTurns: 0,
      assistantTurns: 0,
    };
    try {
      const files = readdirSync(join(root, entry.name)).filter(name => name.endsWith(".json")).sort();
      if (files.length === 0) return empty;
      const data = JSON.parse(readFileSync(join(root, entry.name, files[files.length - 1]), "utf8")) as {
        capturedAt?: string;
        checkpoint?: string;
        error?: string;
        state?: { turns?: { user?: number; assistant?: unknown[] } };
      };
      return {
        traceId: empty.traceId,
        capturedAt: data.capturedAt ?? null,
        checkpoint: data.checkpoint ?? null,
        error: data.error ?? null,
        userTurns: data.state?.turns?.user ?? 0,
        assistantTurns: Array.isArray(data.state?.turns?.assistant) ? data.state.turns.assistant.length : 0,
      };
    } catch {
      return empty;
    }
  });
}

function nodeReqToWebRequest(req: IncomingMessage, host: string, port: number): Request {
  const url = `http://${req.headers.host || `${host}:${port}`}${req.url}`;
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : null;

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error duplex required by node fetch for stream body
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status;
  res.statusMessage = webRes.statusText;
  webRes.headers.forEach((val, key) => {
    res.setHeader(key, val);
  });

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  res.on("close", () => {
    void reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.writableEnded) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export interface RunningServer {
  port: number;
  stop: (closeActiveConnections?: boolean) => Promise<void> | void;
}

/**
 * Advisor control API (issue #224).
 *
 * The Advisor is a provider-neutral feature above the WebChat host boundary: the sidecar's
 * `AdvisorHost` resolves every request against the composed provider contributions, and these
 * handlers only translate HTTP to that host. Nothing here selects a model, knows a provider, or
 * ties a review's lifetime to the request.
 *
 * - `GET  /v1/control/advisor/models`          — the currently eligible model catalogue
 * - `POST /v1/control/advisor/reviews`         — accept a review as a tracked background task
 * - `GET  /v1/control/advisor/reviews`         — tracked tasks (activity view)
 * - `GET  /v1/control/advisor/reviews/<id>`    — one task by its exact review id
 * - `POST /v1/control/advisor/recover`         — read-only recovery of a retained answer (#214)
 */
async function advisorModelsRequest(host: AdvisorHost): Promise<Response> {
  try {
    const catalogue = await host.catalogue();
    return Response.json({ ok: true, ...catalogue }, { headers: controlCorsHeaders() });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        code: ADVISOR_MODEL_UNAVAILABLE_CODE,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502, headers: controlCorsHeaders() },
    );
  }
}

/** Map one Advisor host refusal to the control API's HTTP answer. */
function advisorFailureResponse(error: unknown): Response {
  if (error instanceof AdvisorHostError) {
    return Response.json(
      { ok: false, code: error.code, message: error.message },
      { status: 409, headers: controlCorsHeaders() },
    );
  }
  return Response.json(
    { ok: false, code: ADVISOR_INPUT_INVALID_CODE, message: error instanceof Error ? error.message : String(error) },
    { status: 500, headers: controlCorsHeaders() },
  );
}

/**
 * Accept one review. The task is created and started before this handler returns, and it keeps
 * running independently of this request, the modal and any browser navigation within DSH.
 */
async function advisorStartRequest(req: Request, host: AdvisorHost): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    const tooLarge = requestBodyFailure(error);
    if (tooLarge) return tooLarge;
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : "Advisor review body must be valid JSON");
  }
  let source: ReturnType<typeof validateAdvisorReviewSource>;
  try {
    source = validateAdvisorReviewSource(raw);
  } catch (error) {
    return Response.json(
      { ok: false, code: ADVISOR_INPUT_INVALID_CODE, message: error instanceof Error ? error.message : String(error) },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  const body = raw as Record<string, unknown>;
  const route = typeof body.route === "string" ? body.route.trim() : "";
  if (route.length === 0) {
    return Response.json(
      { ok: false, code: ADVISOR_INPUT_INVALID_CODE, message: 'Advisor review field "route" must be a non-empty string' },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  const reasoningMode = typeof body.reasoningMode === "string" && body.reasoningMode.trim().length > 0
    ? body.reasoningMode.trim()
    : undefined;
  try {
    const result = await host.start({
      source,
      route,
      ...(reasoningMode !== undefined ? { reasoningMode } : {}),
    });
    return Response.json(
      { ok: true, duplicate: result.duplicate, task: result.task },
      { status: result.duplicate ? 200 : 202, headers: controlCorsHeaders() },
    );
  } catch (error) {
    return advisorFailureResponse(error);
  }
}

/** One tracked task by its exact review id. */
function advisorStatusRequest(host: AdvisorHost, reviewId: string): Response {
  const task = host.status(reviewId);
  if (!task) {
    return Response.json(
      {
        ok: false,
        code: ADVISOR_TASK_UNAVAILABLE_CODE,
        message: "This review is no longer available on this sidecar; start a new review.",
      },
      { status: 404, headers: controlCorsHeaders() },
    );
  }
  return Response.json({ ok: true, task }, { headers: controlCorsHeaders() });
}

/** The tracked task list behind the persistent activity view. */
function advisorListRequest(host: AdvisorHost, url: URL): Response {
  const sessionId = url.searchParams.get("sessionId");
  const requested = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 50) : 20;
  const reviews = host.list({
    ...(sessionId ? { sessionId } : {}),
    limit,
  });
  return Response.json({ ok: true, reviews }, { headers: controlCorsHeaders() });
}

/**
 * Read the finalized answer of one DSH session's retained Advisor conversation (issue #214).
 *
 * Read-only by construction: it never submits, navigates or creates a conversation, so a review the
 * browser turn gave up on stays recoverable. Everything the read cannot deliver becomes
 * a typed `ok: false` result carrying `advisor_recovery_unavailable`. The tracked execution signal
 * aborts a bounded read instead of leaving it polling the retained page.
 */
async function advisorRecoverRequest(
  req: Request,
  host: AdvisorHost,
  signal: AbortSignal,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    const tooLarge = requestBodyFailure(error);
    if (tooLarge) return tooLarge;
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : "Advisor recovery body must be valid JSON");
  }
  let input: ReturnType<typeof validateAdvisorRecoveryRequest>;
  try {
    input = validateAdvisorRecoveryRequest(raw);
  } catch (error) {
    return Response.json(
      { ok: false, code: ADVISOR_INPUT_INVALID_CODE, message: error instanceof Error ? error.message : String(error) },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  const result = await host.recover({ ...input, signal });
  return Response.json(result, { status: result.ok ? 200 : 502, headers: controlCorsHeaders() });
}

/**
 * The interactive sign-in control surface (issue #276, slice 2a).
 *
 * `/v1/control/auth/*` is the operator's authority, exactly like the rest of `/v1/control/*`: the
 * control token opens it, the API key does not, and the control token still cannot open `/v1/*`.
 * Nothing here is a second execution path for turns — this surface relays a provider's *sign-in* and
 * never runs one.
 *
 * - `GET    /v1/control/auth/providers`            — the providers exposing an auth controller
 * - `POST   /v1/control/auth/sessions`             — open one (409 when that provider is busy)
 * - `GET    /v1/control/auth/sessions/<id>`        — the session view: no cookie, no storage state,
 *                                                    no frame bytes and no page URL
 * - `GET    /v1/control/auth/sessions/<id>/stream` — SSE, `data: {"seq","state","frame"…}` at 2-3 fps
 * - `POST   /v1/control/auth/sessions/<id>/input`  — one `AuthInput`; the fresh state is the response
 *                                                    and the fresh frame arrives on the stream
 * - `DELETE /v1/control/auth/sessions/<id>`        — cancel, idempotently, and acknowledge a capture
 *
 * The page at `GET /v1/control/auth/` is the one path under `/v1/control/` deliberately NOT behind the
 * control token: a browser cannot attach a header to a navigation, and putting the token in the URL is
 * exactly what the page refuses to do. It is a static document carrying no data, and every endpoint
 * that carries data is guarded like the rest of the control surface.
 */
function authProviderListResponse(surface: WebChatAuthSurface): Response {
  return Response.json({ ok: true, providers: surface.providers() }, { headers: controlCorsHeaders() });
}

/**
 * The refusal categories that are the *caller's* own mistake on the sign-in surface.
 *
 * One owner for the classification: the honest status and the actionable message both derive from
 * here. `UNSUPPORTED_OPTION` is an intent this provider does not serve, such as a click outside the
 * frame it reported. It is keyed on the category, never on a provider code: the host knows the
 * semantic vocabulary, not the provider's, and the same category covers any provider's refused
 * intent.
 */
const AUTH_CLIENT_REFUSAL_CATEGORIES: ReadonlySet<WebChatErrorCategory> = new Set([
  "UNSUPPORTED_OPTION",
]);

/** What a client should do about a refusal of its own making; appended to the provider's message. */
const AUTH_CLIENT_REFUSAL_GUIDANCE =
  "Relay one of the supported sign-in intents (click, type, key, scroll, navigate) with a click "
  + "inside the viewport the stream reported.";

/**
 * The honest HTTP status of one sign-in refusal category.
 *
 * A client-side refusal is a bad request (400), never a 502. Everything unlisted is a genuine
 * upstream failure: the provider could not serve the sign-in it was asked for.
 */
function authFailureStatus(category: WebChatErrorCategory): number {
  if (AUTH_CLIENT_REFUSAL_CATEGORIES.has(category)) return 400;
  switch (category) {
    case "MODEL_UNAVAILABLE":
      // The host refusing an unknown provider id (the message names the valid ones).
      return 404;
    case "SHUTDOWN":
      return 503;
    case "TRANSPORT_UNAVAILABLE":
    case "CONVERSATION_STATE_MISMATCH":
    case "AUTH_EXPIRED":
      // The sign-in lifecycle refusing the request: busy, already captured, or no longer alive.
      return 409;
    default:
      return 502;
  }
}

/** Map a malformed body or a surface refusal to the control API's HTTP answer. */
function authFailureResponse(error: unknown): Response {
  if (error instanceof TypeError) {
    return Response.json(
      { ok: false, code: "invalid_auth_input", message: error.message },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  if (isWebChatError(error)) {
    const status = authFailureStatus(error.category);
    // A client-side refusal still carries the typed category code and the provider's own message,
    // plus the one thing the provider's message does not say: what to do instead.
    const message = AUTH_CLIENT_REFUSAL_CATEGORIES.has(error.category)
      ? `${error.message} ${AUTH_CLIENT_REFUSAL_GUIDANCE}`
      : error.message;
    return Response.json(
      { ok: false, code: error.category, message },
      { status, headers: controlCorsHeaders() },
    );
  }
  return Response.json(
    { ok: false, code: "auth_unavailable", message: error instanceof Error ? error.message : String(error) },
    { status: 500, headers: controlCorsHeaders() },
  );
}

function authSessionNotFoundResponse(): Response {
  return Response.json(
    { ok: false, code: "session_not_found", message: "No sign-in session with that id is open on this service." },
    { status: 404, headers: controlCorsHeaders() },
  );
}

/** The session view as JSON. Captured material is deliberately absent, not redacted. */
function authSessionBody(view: WebChatAuthSessionView): Record<string, unknown> {
  return { ok: true, ...view };
}

/** `POST /v1/control/auth/sessions` — open one sign-in session for an already-selected provider. */
async function authOpenRequest(req: Request, surface: WebChatAuthSurface): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    const tooLarge = requestBodyFailure(error);
    if (tooLarge) return tooLarge;
    return Response.json(
      { ok: false, code: "invalid_request_error", message: "The sign-in session body must be valid JSON" },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  const providerId = raw && typeof raw === "object" && typeof (raw as { providerId?: unknown }).providerId === "string"
    ? (raw as { providerId: string }).providerId.trim()
    : "";
  if (providerId.length === 0) {
    return Response.json(
      { ok: false, code: "invalid_request_error", message: 'A sign-in session body requires a non-empty "providerId"' },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  try {
    const view = await surface.open(providerId);
    return Response.json(authSessionBody(view), { status: 201, headers: controlCorsHeaders() });
  } catch (error) {
    return authFailureResponse(error);
  }
}

/** `POST /v1/control/auth/sessions/<id>/input` — relay one validated input. */
async function authInputRequest(req: Request, surface: WebChatAuthSurface, id: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    const tooLarge = requestBodyFailure(error);
    if (tooLarge) return tooLarge;
    return Response.json(
      { ok: false, code: "invalid_auth_input", message: "A sign-in input must be valid JSON" },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  // The slice-1 guard is the only input vocabulary: an unknown intent or half an instruction is
  // refused here, so nothing incomplete ever reaches a provider.
  if (!isAuthInput(raw)) {
    return Response.json(
      {
        ok: false,
        code: "invalid_auth_input",
        message: "A sign-in input must be one of click, type, key, scroll or navigate",
      },
      { status: 400, headers: controlCorsHeaders() },
    );
  }
  try {
    const view = await surface.input(id, raw as AuthInput);
    return view
      ? Response.json(authSessionBody(view), { headers: controlCorsHeaders() })
      : authSessionNotFoundResponse();
  } catch (error) {
    return authFailureResponse(error);
  }
}

/** One SSE event payload. Frame bytes are relayed as base64 and never decoded here. */
function authStreamPayload(event: WebChatAuthStreamEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    state: event.state,
    terminal: event.terminal,
    ...(event.png !== undefined ? { frame: Buffer.from(event.png).toString("base64") } : {}),
    ...(event.viewport !== undefined ? { viewport: event.viewport } : {}),
    ...(event.capture !== undefined ? { capture: event.capture } : {}),
    ...(event.closeReason !== undefined ? { closeReason: event.closeReason } : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
  };
}

/**
 * `GET /v1/control/auth/sessions/<id>/stream` — the frame/state relay.
 *
 * The body is the surface's own generator: it yields immediately, again right after any input (the
 * session's wake signal, not a poll) and on the frame cadence, and stops after one terminal event.
 * The final event is both a `data:` frame and an `event: end`, so a client may key off either.
 */
function authStreamResponse(surface: WebChatAuthSurface, id: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const frames = surface.stream(id, signal);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of frames) {
          const payload = JSON.stringify(authStreamPayload(event));
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          if (event.terminal) {
            controller.enqueue(encoder.encode(`event: end\ndata: ${payload}\n\n`));
            break;
          }
        }
      } catch {
        // A refusal or a dead socket ends the relay; the session itself is unaffected.
      }
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    },
    async cancel() {
      await frames.return?.(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...controlCorsHeaders(),
    },
  });
}

/** The static sign-in page. No data, no secret and no absolute URL of any kind. */
function authPageResponse(): Response {
  return new Response(WEB_CHAT_AUTH_PAGE_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Same-origin only, data: frames only, and no form may ever be submitted natively: a browser
      // with scripting disabled must not turn the token field into a URL query.
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
      ...controlCorsHeaders(),
    },
  });
}

/**
 * The one live-configuration refresh primitive (issue #287, slice 4b).
 *
 * A successful remote sign-in writes to the data volume, but the running process resolved its
 * provider facts once, when it loaded the configuration, and every seam reads those facts from
 * `config` per call (`effectiveChatGptWebProviderConfig` is deliberately never cached). So the fix is
 * to re-derive exactly the two facts the sign-in changes and swap them into the live configuration:
 *
 * - `accountIdentityFingerprint`, the deployment's logical account identity. Without it
 *   `providerConfig` substitutes the storage-state-derived fallback, `accountIdentityRecorded` is
 *   false, and every turn fails closed on the lease's account-binding check.
 * - `storageStatePath`, **resolved for reads** through the same `resolveProviderStorageStatePath`
 *   owner `loadConfig` uses. On a fresh volume the startup resolution pointed at the legacy location
 *   because `providers/<id>/storage-state.json` did not exist yet; once the sign-in writes it, the
 *   provider-scoped session wins and the reported and read locations must be the same one.
 *
 * This function is the **only** place the live provider facts are mutated. `startServer` wires it to
 * the sign-in controller's single `afterSessionStored` completion signal and nothing else calls it,
 * so a successful sign-in has one trigger and one owner.
 *
 * **In-flight turns are unaffected by construction.** A turn's provider facts are captured into a
 * plain `CodexProviderConfig` before the turn starts (the ingress resolves them; the adapter factory
 * and `ChatGptBrowserWorker.forProvider` derive their own copies from that value), and no part of a
 * running turn reads `config` again. This function therefore swaps a *future* turn's facts; a turn
 * already in flight keeps the reference it started with, whether it then succeeds or fails on the
 * facts it began with. Never "fix up" a running turn from here.
 *
 * The writes are deliberately ordered path-first/fingerprint-last on a best-effort path: a
 * fingerprint swap matters far more than a reporting path, so losing the cheap one must never cost
 * the important one. Re-deriving a value that did not change is a no-op, because both are compared
 * before they are written.
 *
 * @param config - the live configuration this listener serves from, mutated in place.
 * @param identity - the account binding the sign-in persisted, read from its own write's answer.
 * @returns whether the credential path the deployment resolves actually changed.
 */
export function refreshChatGptWebProviderFacts(
  config: AppConfig,
  identity: ChatGptWebAuthStoredIdentity,
): boolean {
  const previousPath = config.storageStatePath;
  if (!identity.restored && config.accountIdentityFingerprint === identity.fingerprint) return false;
  // A path that cannot be resolved must not take the account identity down with it: the turn itself
  // re-resolves the credential path from the configured value per turn (see `resolveBrowserConfig`),
  // so only the reported path would stay stale, while a missing fingerprint fails every turn closed.
  try {
    config.storageStatePath = resolveProviderStorageStatePath(config.storageStatePath);
  } catch (error) {
    console.warn(
      `[dsh-chatgpt-web] sign_in_credential_path_refresh_failed ${safeErrorDescriptor(error)}`,
    );
  }
  config.accountIdentityFingerprint = identity.fingerprint;
  console.info(
    `[dsh-chatgpt-web] sign_in_provider_facts_refreshed ${JSON.stringify({
      accountIdentityRecorded: true,
      credentialPathChanged: config.storageStatePath !== previousPath,
    })}`,
  );
  return config.storageStatePath !== previousPath;
}

export function startServer(
  config: AppConfig,
  dependencies: {
    fetchUpstream?: NativeFetch;
    /**
     * Test/in-process override. The production server owns the ProviderCore and supplies the
     * exact same instance to every adapter created for this listener.
     */
    adapterFactory?: (provider: CodexProviderConfig, providerCore: ChatGptWebProviderCore) => ProviderAdapter;
    /**
     * The interactive sign-in providers this listener serves (issue #276).
     *
     * The host composes them, exactly like the provider catalogue: this listener never invents a
     * provider, and a provider that exposes no auth controller is simply not offered. Left out, the
     * listener registers the ChatGPT Web controller — construction is inert and only `startAuth()`
     * launches a browser, so a host with no Chrome still starts. An explicit value (including an empty
     * `providers` list) replaces the default entirely.
     */
    auth?: WebChatAuthSurfaceOptions;
  } = {},
): RunningServer {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  // Fail closed on an unsafe bind (issue #247): a non-loopback listener exposes a logged-in provider
  // session, so it requires an API key before the socket is opened — never after.
  const apiKey = resolveApiKey();
  if (!isLoopbackHost(config.host) && apiKey === undefined) {
    throw new Error(
      `Refusing to serve on ${config.host}: a non-loopback bind exposes the provider session, so an `
      + "API key is required. Set DSH_CHATGPT_WEB_API_KEY (or write it to <data dir>/api-key), or bind "
      + "127.0.0.1.",
    );
  }
  const startedAt = Date.now();
  // The sidecar is the single ChatGPT Web execution authority. Responses requests and
  // native DSH turns routed through the sidecar must share this lifecycle owner.
  const sharedProviderCore = new ChatGptWebProviderCore();
  const adapterFactory: ChatGptWebAdapterFactory = dependencies.adapterFactory
    ? provider => dependencies.adapterFactory!(provider, sharedProviderCore)
    : provider => createChatGptWebAdapter(provider, { providerCore: sharedProviderCore });
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  if (config.mode === "full") {
    void turnBroker!.listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable ${safeErrorDescriptor(error)}`,
      );
    });
  }
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  const httpTurns = new HttpTurnCounter();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  /**
   * The public API key guard (issue #247), the same constant-time shape as the control token above.
   * With no key configured the surface is open, which the startup check above only allows on
   * loopback.
   */
  const apiAuthorized = (req: Request): boolean => {
    if (apiKey === undefined) return true;
    const expected = Buffer.from(`Bearer ${apiKey}`);
    const bearer = Buffer.from(req.headers.get("authorization") ?? "");
    if (bearer.length === expected.length && timingSafeEqual(bearer, expected)) return true;
    const wanted = Buffer.from(apiKey);
    const header = Buffer.from(req.headers.get("x-api-key") ?? "");
    return header.length === wanted.length && timingSafeEqual(header, wanted);
  };
  const maxInflightTurns = resolveMaxInflightTurns();
  /**
   * The provider composition the Advisor resolves routes against.
   *
   * It is rebuilt per Advisor operation so a configuration change (tuning, browser host) is picked up
   * exactly like the rest of the control API, while the host itself — and therefore the tracked
   * reviews — stays one owner for the life of this listener. The ChatGPT Web adapter keeps sharing
   * the listener's ProviderCore, so the Advisor can never become a second execution authority.
   */
  const advisorRuntimes = (): readonly WebChatProviderRuntime[] => {
    const provider = effectiveChatGptWebProviderConfig(config);
    const adapter = adapterFactory(provider);
    return [createChatGptWebProviderRuntime({ provider, adapter })];
  };
  const advisorHost: AdvisorHost = createAdvisorHost({ runtimes: advisorRuntimes });

  /**
   * The interactive sign-in surface (issue #276). One owner for the life of this listener: it holds
   * the one-active-session-per-provider slots, so two listeners — or two requests — can never race
   * two sign-ins over one account's stored state.
   *
   * Registration is the production default and is deliberately lazy: composing the controller starts
   * nothing, and a missing Chrome surfaces as a typed `startAuth()` failure on the request that needs
   * it rather than at startup.
   *
   * The controller's one-shot `afterSessionStored` is wired to {@link refreshChatGptWebProviderFacts}
   * (issue #287, slice 4b), the single place the live provider facts are mutated, so a successful
   * sign-in takes effect on the very next turn here — no restart, no second process, and no other call
   * site that touches those facts.
   */
  const authSurface: WebChatAuthSurface = createWebChatAuthSurface(dependencies.auth ?? {
    providers: [{
      providerId: CHATGPT_WEB_DRIVER_ID,
      label: CHATGPT_WEB_AUTH_PROVIDER_LABEL,
      controller: createChatGptWebAuthController({
        config: {
          chromeExecutablePath: config.chromeExecutablePath,
          authBrowserMode: config.authBrowserMode,
        },
        afterSessionStored: (_stored, identity) => {
          refreshChatGptWebProviderFacts(config, identity);
        },
      }),
    }],
  });

  /**
   * The port the listening socket is actually bound to.
   *
   * `config.port` is the *requested* port and may be `0` (an ephemeral port, which the test suites and
   * `--port 0` use), so reporting it directly would tell an operator or supervisor `0` instead of the
   * port the service can be reached on. The listener is created after this closure, and the Node branch
   * only learns its port once `listen()` completes, so it is resolved lazily per request.
   */
  let listenerPort: (() => number | undefined) | undefined;
  const boundPort = (): number => {
    const port = listenerPort?.();
    return port !== undefined && port > 0 ? port : config.port;
  };

  const handleFetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        service: "dsh-chatgpt-web",
        version: VERSION,
        mode: config.mode,
        pid: process.pid,
        port: boundPort(),
        uptime: (Date.now() - startedAt) / 1_000,
        accepting_turns: !draining,
        successful_model_catalog_requests: successfulModelCatalogRequests,
        last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
        ...activity(),
      });
    }
    // The sign-in page (issue #276): a static document, deliberately readable without the control
    // token — a browser cannot put a header on a navigation, and the page's whole token handling
    // exists to keep the token out of the URL. It carries no data; every endpoint below is guarded.
    if (req.method === "GET" && WEB_CHAT_AUTH_PAGE_PATHS.includes(url.pathname)) {
      return authPageResponse();
    }
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/control/")) {
      return new Response(null, { status: 204, headers: controlCorsHeaders() });
    }
    if (url.pathname.startsWith("/v1/control/") && !controlAuthorized(req)) {
      return new Response("Unauthorized", { status: 401, headers: controlCorsHeaders() });
    }
    // The public API surface (issue #247). `/v1/control/*` above keeps the operator's control token:
    // the two are separate authorities and are never interchangeable.
    if (url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v1/control/")) {
      if (!apiAuthorized(req)) {
        // The bridge owns the code vocabulary and derives it from the status: 401 becomes
        // `invalid_api_key` / `authentication_error`.
        const unauthorized = formatErrorResponse(
          401,
          "authentication_error",
          "Missing or invalid API key. Send `Authorization: Bearer <key>` or `x-api-key: <key>`.",
        );
        unauthorized.headers.set("www-authenticate", "Bearer");
        return unauthorized;
      }
      if (maxInflightTurns > 0 && req.method === "POST" && httpTurns.count() >= maxInflightTurns) {
        return formatErrorResponse(
          429,
          "rate_limit_error",
          `The service is at its configured limit of ${maxInflightTurns} concurrent turns.`,
        );
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/control/status") {
      return Response.json({
        status: "ok",
        service: "dsh-chatgpt-web",
        version: VERSION,
        mode: config.mode,
        pid: process.pid,
        // The port the listener is actually bound to, exactly like `/healthz`: `config.port` may be 0
        // (an ephemeral port), and echoing it would tell an operator or supervisor the wrong port.
        port: boundPort(),
        uptime: (Date.now() - startedAt) / 1_000,
        accepting_turns: !draining,
        ...activity(),
        storageDir: getConfigDir(),
        storageStatePath: config.storageStatePath,
        storageStatePresent: existsSync(config.storageStatePath),
        chromeExecutablePath: config.chromeExecutablePath,
        headed: config.headed,
        solAvailable: config.solAvailable,
        proAvailable: config.proAvailable,
        tuning: resolveChatGptWebTuning(config.tuning),
      }, { headers: controlCorsHeaders() });
    }
    if (req.method === "GET" && url.pathname === "/v1/control/config") {
      return Response.json({
        tuning: config.tuning ?? {},
        effective: resolveChatGptWebTuning(config.tuning),
        defaults: { ...CHATGPT_WEB_TUNING_DEFAULTS },
      }, { headers: controlCorsHeaders() });
    }
    if (req.method === "PUT" && url.pathname === "/v1/control/config") {
      try {
        const body = await req.json() as { tuning?: unknown };
        const tuning = validateChatGptWebTuning(body.tuning, "control API");
        saveConfig({ ...config, tuning });
        // Mutate the in-memory config so the next turn's effective provider configuration sees the
        // new tuning without a sidecar restart (workers are keyed by the serialized provider config).
        // The resolver reads the configuration per call, and a provider-scoped block still wins over
        // this flat field, exactly as it wins over the loaded one (issue #193).
        config.tuning = tuning;
        return Response.json({ status: "ok", tuning }, { headers: controlCorsHeaders() });
      } catch (error) {
        return Response.json(
          { status: "error", error: error instanceof Error ? error.message : String(error) },
          { status: 400, headers: controlCorsHeaders() },
        );
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/control/recent-turns") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10) || 10, 1), 25);
      return Response.json({ turns: readRecentBrowserTurns(limit) }, { headers: controlCorsHeaders() });
    }
    if (url.pathname === "/v1/control/auth/providers" && req.method === "GET") {
      return authProviderListResponse(authSurface);
    }
    if (url.pathname === "/v1/control/auth/sessions" && req.method === "POST") {
      return authOpenRequest(req, authSurface);
    }
    if (url.pathname.startsWith("/v1/control/auth/sessions/")) {
      const rest = url.pathname.slice("/v1/control/auth/sessions/".length);
      const stream = rest.endsWith("/stream");
      const input = rest.endsWith("/input");
      const id = decodeURIComponent(stream ? rest.slice(0, -"/stream".length)
        : input ? rest.slice(0, -"/input".length)
          : rest);
      if (id.length === 0 || id.includes("/")) {
        return Response.json(
          { ok: false, code: "invalid_request_error", message: "A sign-in session id is required" },
          { status: 400, headers: controlCorsHeaders() },
        );
      }
      if (stream && req.method === "GET") {
        // Resolved before the stream so an unknown session is a 404 and not an empty 200 event stream.
        if (!await authSurface.view(id)) return authSessionNotFoundResponse();
        return authStreamResponse(authSurface, id, req.signal);
      }
      if (input && req.method === "POST") {
        return authInputRequest(req, authSurface, id);
      }
      if (!stream && !input && req.method === "GET") {
        const view = await authSurface.view(id);
        return view
          ? Response.json(authSessionBody(view), { headers: controlCorsHeaders() })
          : authSessionNotFoundResponse();
      }
      if (!stream && !input && req.method === "DELETE") {
        const view = await authSurface.cancel(id);
        return view
          ? Response.json(authSessionBody(view), { headers: controlCorsHeaders() })
          : authSessionNotFoundResponse();
      }
      return new Response("Method not allowed", { status: 405, headers: controlCorsHeaders() });
    }
    if (req.method === "GET" && url.pathname === "/v1/control/advisor/models") {
      return httpTurns.track(
        () => advisorModelsRequest(advisorHost),
        req.signal,
        process.platform,
        "unspecified",
      );
    }
    if (req.method === "POST" && url.pathname === "/v1/control/advisor/reviews") {
      if (draining) return formatErrorResponse(503, "server_error", "dsh-chatgpt-web is draining for a requested service operation");
      return httpTurns.track(
        // The accepted task is deliberately NOT bound to this request's signal: the review continues
        // after the dialog closes. Only the acceptance itself is tracked.
        () => advisorStartRequest(new Request(req), advisorHost),
        req.signal,
        process.platform,
        "unspecified",
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/control/advisor/reviews") {
      return advisorListRequest(advisorHost, url);
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/control/advisor/reviews/")) {
      const reviewId = decodeURIComponent(url.pathname.slice("/v1/control/advisor/reviews/".length)).trim();
      if (!reviewId || reviewId.includes("/")) {
        return Response.json(
          { ok: false, code: ADVISOR_TASK_UNAVAILABLE_CODE, message: "A review id is required" },
          { status: 400, headers: controlCorsHeaders() },
        );
      }
      return advisorStatusRequest(advisorHost, reviewId);
    }
    if (req.method === "POST" && url.pathname === "/v1/control/advisor/recover") {
      if (draining) return formatErrorResponse(503, "server_error", "dsh-chatgpt-web is draining for a requested service operation");
      return httpTurns.track(
        signal => advisorRecoverRequest(new Request(req, { signal }), advisorHost, signal),
        req.signal,
        process.platform,
        "unspecified",
      );
    }
    if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      draining = url.pathname === "/admin/drain";
      turnBroker?.setExternalOwnersAccepted(!draining);
      return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
    }
    if (req.method === "POST" && url.pathname === "/admin/cancel-turn") {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      let traceId: string;
      try {
        const body = await req.json() as { traceId?: unknown };
        traceId = typeof body?.traceId === "string" ? body.traceId : "";
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
      } catch (error) {
        return Response.json(
          { status: "error", error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
      const reason = chatGptBrowserTabClosedError();
      // Revoke the owner first. This prevents a compaction callback that observes its retained
      // source being cancelled below from starting a fresh fallback during operator shutdown.
      const compactionCancellation = cancelStructuredCompactionTrace(traceId, reason);
      const browserCancellation = chatGptTurnSessions.cancelTrace(traceId, reason);
      const [cancelledBrowserTurns, cancelledCompactionRuns] = await Promise.all([
        browserCancellation,
        compactionCancellation,
      ]);
      const cancelledBrokerTurns = turnBroker?.revokeTrace(traceId, reason) ?? 0;
      return Response.json({
        status: "ok",
        trace_id: traceId,
        cancelled_browser_turns: cancelledBrowserTurns,
        cancelled_broker_turns: cancelledBrokerTurns,
        cancelled_compaction_runs: cancelledCompactionRuns,
        ...activity(),
      });
    }
    if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      let identity: NativeCodexTurnIdentity;
      try {
        const body = await req.json() as { threadId?: unknown; turnId?: unknown };
        const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
        const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
          throw new Error("native Codex threadId or turnId is invalid");
        }
        identity = { threadId, turnId };
      } catch (error) {
        return Response.json(
          { status: "error", error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
      const reason = new DOMException("Codex turn interrupted", "AbortError");
      const browserCancellation = chatGptTurnSessions.cancelNativeTurn(
        identity.threadId,
        identity.turnId,
        reason,
      );
      const compactionCancellation = cancelStructuredCompactionNativeTurn(
        identity.threadId,
        identity.turnId,
        reason,
      );
      const httpCancellation = httpTurns.beginCancelTurn(identity, reason);
      const settlement = Promise.allSettled([
        browserCancellation.settlement,
        compactionCancellation.settlement,
        httpCancellation.settlement,
      ]);
      void settlement.then(results => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.error(
              `[chatgpt-web] interrupted turn cleanup failed ${safeErrorDescriptor(result.reason)}`,
            );
          }
        }
      });
      return Response.json({
        status: "ok",
        cancelled_http_turns: httpCancellation.cancelled,
        cancelled_browser_turns: browserCancellation.cancelled,
        cancelled_compaction_runs: compactionCancellation.cancelled,
      });
    }
    if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const reason = new Error("Active turn cancelled by launcher");
      // Abort shared compaction owners before clearing their retained source sessions. The
      // owner signal is the only cancellation boundary for a fresh fallback not in the session
      // registry.
      const compactionCancellation = cancelAllStructuredCompactions(reason);
      const cancelledBrowserTurns = chatGptTurnSessions.clear() + (turnBroker?.revokeExternalOwners() ?? 0);
      const [cancelledHttpTurns, cancelledCompactionRuns] = await Promise.all([
        httpTurns.cancelAll(reason),
        compactionCancellation,
      ]);
      return Response.json({
        status: "ok",
        cancelled_http_turns: cancelledHttpTurns,
        cancelled_browser_turns: cancelledBrowserTurns,
        cancelled_compaction_runs: cancelledCompactionRuns,
        ...activity(),
      });
    }
    if (req.method === "POST" && url.pathname === "/admin/shutdown") {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const current = activity();
      if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
        return Response.json(
          {
            status: "refused",
            accepting_turns: !draining,
            ...current,
          },
          { status: 409 },
        );
      }
      setTimeout(shutdown, 0);
      return Response.json({ status: "ok", accepting_turns: false, ...current });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (draining) {
        return formatErrorResponse(
          503,
          "server_error",
          "dsh-chatgpt-web is draining for a requested service operation",
        );
      }
      return httpTurns.track(async signal => {
        let catalogConfig: AppConfig;
        try {
          catalogConfig = {
            ...config,
            subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol),
          };
        } catch (error) {
          return formatErrorResponse(
            500,
            "server_error",
            `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const response = await modelsRequest(
          new Request(req, { signal }),
          catalogConfig,
          dependencies.fetchUpstream,
          readCodexModelContextOverride,
        );
        if (response.ok) {
          successfulModelCatalogRequests += 1;
          lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
        }
        return response;
      }, req.signal, process.platform, "models");
    }
    if (req.method === "GET" && url.pathname === "/v1/responses") {
      return new Response("Responses WebSocket transport is not enabled on this local route", {
        status: 426,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (draining) return formatErrorResponse(503, "server_error", "dsh-chatgpt-web is draining for a requested service operation");
      return httpTurns.track(
        (signal, bindIdentity) => responseRequest(
          new Request(req, { signal }),
          config,
          adapterFactory,
          { onTurnIdentity: bindIdentity },
        ),
        req.signal,
        process.platform,
        "responses",
      );
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (draining) return formatErrorResponse(503, "server_error", "dsh-chatgpt-web is draining for a requested service operation");
      let translation;
      try {
        translation = translateChatCompletionsRequest(await readJsonRequestBody(req));
      } catch (error) {
        const tooLarge = requestBodyFailure(error);
        if (tooLarge) return tooLarge;
        return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : "Invalid request body");
      }
      // An unknown model names the accepted ids instead of falling through to the native passthrough.
      const accepted = buildOpenAiModelsData(buildChatGptWebModelCatalog(config)).map((entry) => entry.id);
      if (!accepted.includes(translation.model)) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `Unknown model ${JSON.stringify(translation.model)}. Available models: ${accepted.join(", ")}.`,
        );
      }
      // Exactly the same execution as /v1/responses: this route adds no engine, no ProviderCore and no
      // retry authority, it only renames the wire shape (issues #248, architecture §18/§26).
      const internalRequest = new Request(req.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(translation.body),
      });
      // Capability declarations are discarded by design (this bridge is a text chat with no execution
      // or return channel), but never silently: they never enter the internal request above and are
      // declared here, once, on every response shape this route returns.
      const dropped = translation.droppedCapabilities;
      if (dropped.length > 0) {
        console.warn(
          `[dsh-chatgpt-web] web_chat_dropped_capabilities ${JSON.stringify({ endpoint: "chat-completions", dropped })}`,
        );
      }
      const declareDropped = (response: Response): Response => {
        if (dropped.length > 0) response.headers.set("x-dsh-chatgpt-web-ignored-features", dropped.join(","));
        return response;
      };
      return httpTurns.track(async (signal, bindIdentity) => {
        const upstream = await responseRequest(internalRequest, config, adapterFactory, { onTurnIdentity: bindIdentity });
        if (translation.stream) {
          return declareDropped(new Response(
            toChatCompletionStream(upstream.body ?? new ReadableStream(), translation.model),
            {
              status: upstream.status,
              headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
            },
          ));
        }
        let payload: Record<string, unknown> = {};
        try {
          payload = await upstream.json() as Record<string, unknown>;
        } catch {
          payload = {};
        }
        // A provider failure must not look like an empty successful completion to an OpenAI client.
        // The failed Responses payload already carries the provider's own classification; this surface
        // relays it instead of re-labelling every failure as an upstream one, which is how a local
        // admission refusal came to mean "the provider failed" (issue #305). Same rule `compactRequest`
        // applies below. A payload with no published type keeps the historical 502/upstream_error.
        const failure = responseFailure(payload);
        if (failure) {
          const error = {
            message: failure.message,
            type: failure.type ?? "upstream_error",
            code: failure.code ?? null,
          };
          return declareDropped(Response.json(
            { error },
            { status: httpStatusFromTerminalError(error) },
          ));
        }
        return declareDropped(
          Response.json(toChatCompletion(payload, translation.model), { status: upstream.ok ? 200 : upstream.status }),
        );
      }, req.signal, process.platform, "chat-completions");
    }
    if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
      if (draining) return formatErrorResponse(503, "server_error", "dsh-chatgpt-web is draining for a requested service operation");
      return httpTurns.track(
        (signal, bindIdentity) => compactRequest(
          new Request(req, { signal }),
          config,
          adapterFactory,
          { onTurnIdentity: bindIdentity },
        ),
        req.signal,
        process.platform,
        "compact",
      );
    }
    if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
      if (draining) return formatErrorResponse(503, "server_error", "dsh-chatgpt-web is draining for a requested service operation");
      return httpTurns.track(
        signal => nativeSearchRequest(new Request(req, { signal }), dependencies.fetchUpstream),
        req.signal,
        process.platform,
        "search",
      );
    }
    return new Response("Not found", { status: 404 });
  };

  let server: RunningServer;
  if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
    const bunServer = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 0,
      fetch: handleFetch,
    });
    server = {
      port: bunServer.port ?? config.port,
      stop: async (force) => {
        await bunServer.stop(force);
      },
    };
    listenerPort = () => bunServer.port;
  } else {
    const nodeServer = createServer(async (req, res) => {
      try {
        const webReq = nodeReqToWebRequest(req, config.host, config.port);
        const webRes = await handleFetch(webReq);
        await sendWebResponse(webRes, res);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
    });
    nodeServer.listen(config.port, config.host);
    listenerPort = () => {
      const address = nodeServer.address();
      return address !== null && typeof address === "object" ? address.port : undefined;
    };
    server = {
      // Same lazy resolution as /healthz: with an ephemeral port the OS assigns the real one only
      // once the socket is listening.
      get port() { return boundPort(); },
      stop: () => new Promise<void>((resolve) => nodeServer.close(() => resolve())),
    };
  }

  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    chatGptTurnSessions.clear();
    // An accepted review has no owner once this process stops: it is reported as interrupted, never
    // as still running (issue #224).
    advisorHost.dispose();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
        sharedProviderCore.shutdown(),
        // The sign-in surface owns the provider slots and the sweep timer (issue #276). A captured
        // session is deliberately left alone: its material may still be unacknowledged.
        authSurface.close(),
        // The durable continuity store owns an open file and one writer slot per process; the
        // sidecar releases it on its own shutdown path (#193).
        closeNativeChatGptContinuityStores(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[dsh-chatgpt-web] shutdown cleanup failed ${safeErrorDescriptor(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[dsh-chatgpt-web] server shutdown failed ${safeErrorDescriptor(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
