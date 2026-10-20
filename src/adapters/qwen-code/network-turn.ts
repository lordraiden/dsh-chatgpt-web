/**
 * One turn against Qwen Code, over the browser's own network context (issue #299, slice 1).
 *
 * This is the slice's second half: prove that a captured session can actually produce text, using
 * the **browser-network** transport the capture showed — not the DOM.
 *
 * Ownership and safety rules:
 *
 * - **The browser is the session holder, not the interaction surface.** Every request is issued from
 *   inside the page (`fetch` in the page's own browsing context), so cookies — and the
 *   `authorization` header the app builds from its own localStorage token — come from the session.
 *   The recorded HAR shows this provider refuses a cookie-only call: every API call carries
 *   `authorization: Bearer <token>`. The facility therefore reads that token **from the page at call
 *   time** (`session-probe.ts`) and attaches the app's own header shape; there is still no literal
 *   credential, constant or fixture in this module, and the token is never logged.
 * - **The response stream is parsed incrementally.** The page hands each decoded chunk back to this
 *   Node-side parser, so `choices[].delta.content` is consumed as it arrives and the reader is
 *   cancelled as soon as a terminal signal is observed (see `sse.ts` for the three signals).
 * - **The payload shapes are the captured ones.** `task/new` returns the chat id; `completions`
 *   carries the chat id in the query string and the same id in the body. Nothing is invented beyond
 *   client-generated ids, which the web app also generates.
 * - **This is not the driver.** It is the turn-level proof the slice asked for; conversation
 *   affinity, retention and settlement belong to the provider driver (slice 2).
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

import { isWebChatError, webChatError } from "../../web-chat/core";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import {
  QWEN_CODE_CHAT_MODE,
  QWEN_CODE_CHAT_TYPE,
  QWEN_CODE_COMPLETION_VERSION,
  QWEN_CODE_COMPLETIONS_PATH,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CODE_DEFAULT_MODEL,
  QWEN_CODE_OUTPUT_SCHEMA,
  QWEN_CODE_SUB_CHAT_TYPE,
  QWEN_CODE_TASK_NEW_PATH,
  qwenCodeApiHeaders,
  qwenCodeUrl,
} from "./provider";
import { qwenAuthorizationHeaderFromPage } from "./session-probe";
import {
  QwenSseParser,
  createQwenCompletionAccumulator,
  type QwenCompletionResult,
  type QwenSseFrame,
} from "./sse";

/** The HTTP result of a JSON POST issued from inside the page. */
export interface QwenJsonPostResult {
  readonly status: number;
  readonly body: unknown;
}

/** The result of a streaming POST. `bodyText` is present only when the answer was not a stream. */
export interface QwenStreamPostResult {
  readonly status: number;
  readonly contentType: string;
  readonly bodyText?: string;
}

/** What the provider's answer looked like once its response head was known (issue #299, slice 2). */
export interface QwenStreamOpened {
  readonly status: number;
  readonly contentType: string;
}

/**
 * Options for one streaming POST.
 *
 * `onOpen` exists so the caller can report a **truthful submission phase**: the stream's promise only
 * settles when the body ends, but the response head proves whether the provider accepted the turn.
 * `signal` cancels the read from this side; the page's own `fetch` is aborted, so a cancelled turn
 * stops reading instead of draining the stream.
 */
export interface QwenStreamPostOptions {
  readonly onOpen?: (opened: QwenStreamOpened) => void;
  readonly signal?: AbortSignal;
}

/**
 * The request facility one turn needs.
 *
 * Deliberately two methods, not a general HTTP client: a JSON POST that returns a body, and a
 * streaming POST that reports chunks as they arrive. Tests inject a fake; the default implementation
 * is the page's own `fetch`.
 */
export interface QwenTurnRequestFacility {
  postJson(path: string, body: unknown): Promise<QwenJsonPostResult>;
  /**
   * POST and report each decoded text chunk.
   *
   * `onChunk` returns `true` once the caller no longer needs the stream; the implementation must then
   * stop reading it (the browser-side reader is cancelled), so a terminal signal actually stops the
   * network turn instead of draining it.
   */
  postEventStream(
    path: string,
    body: unknown,
    onChunk: (chunk: string) => boolean,
    options?: QwenStreamPostOptions,
  ): Promise<QwenStreamPostResult>;
}

/**
 * The default facility: the page's own `fetch`, inside the page's browsing context.
 *
 * Cookies are the browser's, and the `authorization` header is the one the page's own token manager
 * holds — read from the page at call time, never from configuration or a constant. This module never
 * sees a cookie. The binding names are unique per call because Playwright refuses to expose the same
 * binding name twice on one page, and a page may serve several turns over its life.
 */
export function createQwenPageRequestFacility(page: Page): QwenTurnRequestFacility {
  return {
    async postJson(path: string, body: unknown): Promise<QwenJsonPostResult> {
      const headers = qwenCodeApiHeaders({
        "x-request-id": randomUUID(),
        ...await qwenAuthorizationHeaderFromPage(page),
      });
      const result = await page.evaluate(async ({ url, payload, headers }) => {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          credentials: "same-origin",
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // A non-JSON body (an HTML error page) is kept as text; the caller reports the status.
        }
        return { status: response.status, body: parsed };
      }, { url: qwenCodeUrl(path), payload: body, headers });
      return { status: result.status, body: result.body };
    },

    async postEventStream(
      path: string,
      body: unknown,
      onChunk: (chunk: string) => boolean,
      options: QwenStreamPostOptions = {},
    ): Promise<QwenStreamPostResult> {
      const headers = qwenCodeApiHeaders({
        accept: "text/event-stream",
        "x-request-id": randomUUID(),
        "x-accel-buffering": "no",
        ...await qwenAuthorizationHeaderFromPage(page),
      });
      const suffix = randomUUID().replace(/-/g, "");
      const binding = `__dshQwenCodeChunk_${suffix}`;
      const openBinding = `__dshQwenCodeOpen_${suffix}`;
      const abortKey = `__dshQwenCodeAbort_${suffix}`;
      await page.exposeBinding(binding, async (_source, chunk: unknown) => {
        return typeof chunk === "string" ? onChunk(chunk) : false;
      });
      let openedReported = false;
      const reportOpened = (status: number, contentType: string): void => {
        if (openedReported) return;
        openedReported = true;
        options.onOpen?.({ status, contentType });
      };
      await page.exposeBinding(openBinding, async (_source, payload: unknown) => {
        const record = (payload && typeof payload === "object" ? payload : {}) as {
          status?: unknown;
          contentType?: unknown;
        };
        if (typeof record.status === "number") {
          reportOpened(record.status, typeof record.contentType === "string" ? record.contentType : "");
        }
        return true;
      });
      const onAbort = (): void => {
        // Best effort: the page-side controller is what actually cancels the reader, so a page that
        // went away simply stops being asked.
        void page
          .evaluate((key) => {
            const stop = (window as unknown as Record<string, (() => void) | undefined>)[key];
            if (typeof stop === "function") stop();
          }, abortKey)
          .catch(() => undefined);
      };
      if (options.signal?.aborted === true) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await page.evaluate(async ({ url, payload, headers, binding, openBinding, abortKey }) => {
          const controller = new AbortController();
          (window as unknown as Record<string, unknown>)[abortKey] = () => controller.abort();
          type ChunkSink = (chunk: string) => Promise<boolean>;
          type OpenSink = (payload: { status: number; contentType: string }) => Promise<boolean>;
          const report = (window as unknown as Record<string, ChunkSink | undefined>)[binding];
          const announce = (window as unknown as Record<string, OpenSink | undefined>)[openBinding];
          const finish = (outcome: { status: number; contentType: string; bodyText?: string }): typeof outcome => {
            delete (window as unknown as Record<string, unknown>)[abortKey];
            return outcome;
          };
          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
              credentials: "same-origin",
              signal: controller.signal,
            });
          } catch (error) {
            delete (window as unknown as Record<string, unknown>)[abortKey];
            throw error;
          }
          const contentType = response.headers.get("content-type") ?? "";
          if (typeof announce === "function") await announce({ status: response.status, contentType });
          if (typeof report !== "function") {
            return finish({ status: response.status, contentType, bodyText: "the page lost the stream binding" });
          }
          if (!contentType.includes("text/event-stream") || response.body === null) {
            const text = await response.text();
            return finish({ status: response.status, contentType, bodyText: text.slice(0, 2_000) });
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (await report(decoder.decode(value, { stream: true }))) {
                await reader.cancel().catch(() => {});
                break;
              }
            }
            // Flush a multi-byte character split across the last two chunks.
            await report(decoder.decode());
          } finally {
            reader.releaseLock?.();
          }
          return finish({ status: response.status, contentType });
        }, {
          url: qwenCodeUrl(path),
          payload: body,
          headers,
          binding,
          openBinding,
          abortKey,
        });
        // A non-stream answer never reported its head through the binding: report it now so the
        // caller's submission phase is decided from the provider's own status either way.
        reportOpened(result.status, result.contentType);
        return {
          status: result.status,
          contentType: result.contentType,
          ...(result.bodyText === undefined ? {} : { bodyText: result.bodyText }),
        };
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** One user message, in the shape the web app sends. */
export interface QwenTurnMessage {
  readonly id: null;
  readonly fid: string;
  /** The cursor this message hangs off: `null` when it is the first message of a fresh chat. */
  readonly parentId: string | null;
  readonly childrenIds: readonly string[];
  readonly role: "user";
  readonly content: string;
  readonly user_action: "chat";
  readonly files: readonly never[];
  readonly timestamp: number;
  readonly models: readonly string[];
  readonly model: "";
  readonly chat_type: string;
  readonly feature_config: { readonly thinking_enabled: boolean; readonly output_schema: string };
  readonly extra: { readonly meta: { readonly subChatType: string } };
  readonly sub_chat_type: string;
  readonly parent_id: string | null;
}

/** The `completions` request body, in the captured shape (plus client-generated ids). */
export interface QwenCompletionRequest {
  readonly stream: true;
  readonly version: string;
  readonly incremental_output: true;
  readonly chatId: string;
  readonly parentId: string;
  readonly chat_id: string;
  readonly chat_mode: string;
  readonly model: string;
  readonly parent_id: string | null;
  readonly messages: readonly QwenTurnMessage[];
  readonly timestamp: number;
}

/**
 * Build the one-message completion body.
 *
 * Pure and exported so the payload is assertable without a browser. The assistant's future id is
 * client-generated (as the web app does) and listed in the user message's `childrenIds`; the
 * top-level `parentId` is empty because this is the first turn of a fresh chat.
 */
export function qwenCodeCompletionRequest(input: {
  readonly chatId: string;
  readonly prompt: string;
  readonly model: string;
  readonly timestampSeconds: number;
  /** The user message id (the app generates it, so the adapter does too). */
  readonly messageId: string;
  /** The assistant message id, listed as the user message's only child, as the app does. */
  readonly assistantId: string;
  /**
   * The parent cursor of the previous turn, when this chat already has one.
   *
   * The recorded app links each new message to the previous one (`parentId`/`parent_id`), and the
   * stream's `response.created` repeats the cursor the next turn continues from. A fresh chat has
   * none, which is the captured `parentId: ""` / `parent_id: null` pair.
   */
  readonly parentId?: string;
}): QwenCompletionRequest {
  const { chatId, prompt, model, timestampSeconds, messageId, assistantId } = input;
  // The captured first-turn shape is `parentId: ""` at the top level and `null` on the message; a
  // continuation names the same cursor in both places.
  const parentId = input.parentId !== undefined && input.parentId.length > 0 ? input.parentId : "";
  return {
    stream: true,
    version: QWEN_CODE_COMPLETION_VERSION,
    incremental_output: true,
    chatId,
    parentId,
    chat_id: chatId,
    chat_mode: QWEN_CODE_CHAT_MODE,
    model,
    parent_id: parentId.length > 0 ? parentId : null,
    messages: [{
      id: null,
      fid: messageId,
      parentId: parentId.length > 0 ? parentId : null,
      // A fresh chat has no prior sibling; the client pre-allocates the assistant's id here. The
      // captured app uses a *different* id for the child than for the user message, so this does too.
      childrenIds: [assistantId],
      role: "user",
      content: prompt,
      user_action: "chat",
      files: [],
      timestamp: timestampSeconds,
      models: [model],
      model: "",
      chat_type: QWEN_CODE_CHAT_TYPE,
      feature_config: { thinking_enabled: false, output_schema: QWEN_CODE_OUTPUT_SCHEMA },
      extra: { meta: { subChatType: QWEN_CODE_SUB_CHAT_TYPE } },
      sub_chat_type: QWEN_CODE_SUB_CHAT_TYPE,
      parent_id: null,
    }],
    timestamp: timestampSeconds,
  };
}

/** What one network turn produced. */
export interface QwenNetworkTurnResult extends QwenCompletionResult {
  readonly model: string;
  /** Wall-clock milliseconds from the first request to the terminating signal. */
  readonly elapsedMs: number;
}

/** Construction options for {@link runQwenNetworkTurn}. */
export interface QwenNetworkTurnOptions {
  /** The request facility; production passes {@link createQwenPageRequestFacility}. */
  readonly request: QwenTurnRequestFacility;
  /** The user text to send. */
  readonly prompt: string;
  /** Provider-local model id. Defaults to {@link QWEN_CODE_DEFAULT_MODEL}. */
  readonly model?: string;
  /** Include the agent's `function`-role progress in the answer text. Default false. */
  readonly includeFunctionOutput?: boolean;
  /** Clock seam (milliseconds). */
  readonly now?: () => number;
  /** Id seam; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

/**
 * Build the `task/new` body, in the captured shape.
 *
 * Pure and exported so the payload is assertable without a browser, and so the one-turn proof
 * (`runQwenNetworkTurn`) and the provider transport send exactly the same create request.
 */
export function qwenTaskNewRequest(input: {
  readonly model: string;
  readonly timestampMs: number;
}): Record<string, unknown> {
  return {
    chatId: "",
    models: [input.model],
    chat_type: QWEN_CODE_CHAT_TYPE,
    title: "New Chat",
    chat_mode: QWEN_CODE_CHAT_MODE,
    timestamp: input.timestampMs,
    sub_chat_type: QWEN_CODE_SUB_CHAT_TYPE,
  };
}

/** The id `task/new` returned, or a typed failure explaining why the turn could not start. */
export function readQwenCreatedChatId(body: unknown, status: number): string {
  const failure = (
    category: "AUTH_REQUIRED" | "UPSTREAM_ERROR",
    providerCode: string,
    message: string,
  ): Error => webChatError(category, message, { providerId: QWEN_CODE_PROVIDER_ID, providerCode });
  // The captured service answers an anonymous caller with HTTP 200 and `success:false`, so the
  // category follows the *reason*, never the status alone.
  if (status < 200 || status >= 300) {
    const unauthorized = status === 401 || status === 403;
    throw failure(
      unauthorized ? "AUTH_REQUIRED" : "UPSTREAM_ERROR",
      unauthorized ? "QWEN_SESSION_UNAUTHORIZED" : "QWEN_TASK_CREATE_FAILED",
      `Qwen Code refused to create a chat (HTTP ${status})`,
    );
  }
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (record["success"] !== true) {
    const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
    const code = typeof data["code"] === "string" ? data["code"] : undefined;
    const unauthorized = code === "Unauthorized" || code === "401";
    throw failure(
      unauthorized ? "AUTH_REQUIRED" : "UPSTREAM_ERROR",
      unauthorized ? "QWEN_SESSION_UNAUTHORIZED" : "QWEN_TASK_CREATE_FAILED",
      `Qwen Code refused to create a chat${code === undefined ? "" : ` (${code})`}`,
    );
  }
  const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
  const id = data["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw failure("UPSTREAM_ERROR", "QWEN_TASK_CREATE_INVALID", "Qwen Code created a chat without returning its id");
  }
  return id;
}

/**
 * Run one text turn: create the chat, stream the completion, return the text and the signal.
 *
 * The only thing this needs from the caller is an authenticated session — the facility is bound to
 * it. A refusal (HTTP error, `success:false`, a non-stream answer) is a typed `WebChatError`; it is
 * never a silent empty answer.
 */
export async function runQwenNetworkTurn(options: QwenNetworkTurnOptions): Promise<QwenNetworkTurnResult> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) throw new TypeError("A Qwen Code turn requires non-empty text");
  const model = (options.model ?? QWEN_CODE_DEFAULT_MODEL).trim();
  if (model.length === 0) throw new TypeError("A Qwen Code turn requires a non-empty model id");
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const startedAt = now();
  const createdAt = Math.floor(startedAt / 1_000);

  const transportFailure = (providerCode: string, error: unknown): Error => webChatError(
    "TRANSPORT_UNAVAILABLE",
    `Qwen Code could not be reached: ${nonSecretDiagnosticText(error)}`,
    { providerId: QWEN_CODE_PROVIDER_ID, providerCode, cause: error },
  );
  let created: QwenJsonPostResult;
  try {
    created = await options.request.postJson(
      QWEN_CODE_TASK_NEW_PATH,
      qwenTaskNewRequest({ model, timestampMs: startedAt }),
    );
  } catch (error) {
    if (isWebChatError(error)) throw error;
    throw transportFailure("QWEN_TASK_CREATE_TRANSPORT", error);
  }
  const chatId = readQwenCreatedChatId(created.body, created.status);

  const parser = new QwenSseParser();
  const accumulator = createQwenCompletionAccumulator({
    includeFunctionOutput: options.includeFunctionOutput === true,
  });
  const consume = (frames: readonly QwenSseFrame[]): void => {
    for (const frame of frames) {
      if (accumulator.push(frame)) return;
    }
  };

  const completion = qwenCodeCompletionRequest({
    chatId,
    prompt,
    model,
    timestampSeconds: createdAt,
    messageId: newId(),
    assistantId: newId(),
  });
  let stream: QwenStreamPostResult;
  try {
    stream = await options.request.postEventStream(
      `${QWEN_CODE_COMPLETIONS_PATH}?chat_id=${encodeURIComponent(chatId)}`,
      completion,
      chunk => {
        consume(parser.push(chunk));
        return accumulator.done;
      },
    );
  } catch (error) {
    if (isWebChatError(error)) throw error;
    throw transportFailure("QWEN_COMPLETION_TRANSPORT", error);
  }
  consume(parser.end());

  if (stream.bodyText !== undefined) {
    // A non-SSE answer: an auth/portal error page, or a JSON refusal. Never treated as empty text.
    throw webChatError(
      stream.status === 401 || stream.status === 403 ? "AUTH_REQUIRED" : "UPSTREAM_ERROR",
      `Qwen Code did not stream a completion (HTTP ${stream.status}, ${stream.contentType || "no content type"})`,
      {
        providerId: QWEN_CODE_PROVIDER_ID,
        providerCode: stream.status === 401 || stream.status === 403
          ? "QWEN_SESSION_UNAUTHORIZED"
          : "QWEN_COMPLETION_REFUSED",
      },
    );
  }

  const result = accumulator.finish();
  return {
    model,
    ...result,
    // `task/new` is the only authority on the chat id; the stream's `response.created` repeats it.
    chatId: result.chatId ?? chatId,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}
