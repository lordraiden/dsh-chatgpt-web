/**
 * One Qwen Chat turn over the browser's own network context.
 *
 * ## Why the request is issued from inside the page
 *
 * `chat.qwen.ai`'s **read** surface is open, but every **write** path is anti-bot gated for an
 * anonymous caller: `POST /api/v2/chat/completions` answers with the Alibaba TMD/`x5sec` punish page
 * and `POST /api/v2/chats/new` with an `aliyun_waf` block (recon §1.7). The vendor's bundle also
 * expects its own baxia uid token. That is exactly the situation the Qwen Code adapter solved, and
 * the same answer applies: run the request in the provider's own browsing context so its cookies,
 * origin, `Referer`, `Sec-Fetch-*` and anti-bot state are the page's, and attach the
 * `authorization: Bearer <token>` header the page's own token manager builds.
 *
 * There is **no disguise** here: no user-agent override, no stealth flag, no synthesized anti-bot
 * token. If the page itself is challenged, the turn fails with a typed, actionable
 * `AUTH_REQUIRED`/access-verification category instead of being retried behind the operator's back.
 *
 * ## Payload shapes
 *
 * Every key below comes from the vendor bundle as quoted in recon §1.3–§1.5. Two facts are worth
 * keeping beside the code:
 *
 * - the app builds `{ ..., headers: { "X-Request-Id": ae } }` and then **strips** `headers`, sending
 *   it as a request header. {@link qwenChatCompletionRequest} returns the two halves separately, so
 *   the body never carries a field the browser-facing call does not send;
 * - the exact `messages[]` key set the server accepts is **unknown** without a signed-in capture
 *   (recon §1.9). The shape below is the recorded coder message shape plus every key the chat bundle
 *   is shown writing (`feature_config`, `extra.meta.subChatType`, `models`, `model`). The one
 *   provider-private assumption lives in `provider.ts` (`QWEN_CHAT_SUB_CHAT_TYPE`), so it can be
 *   corrected in a single place when a capture settles it.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

import { isWebChatError, webChatError, type WebChatError } from "../../web-chat/core";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { qwenAuthorizationHeaderFromPage } from "../qwen-code/session-probe";
import {
  QWEN_CHAT_CHAT_MODE,
  QWEN_CHAT_CHAT_TYPE,
  QWEN_CHAT_CHATS_NEW_PATH,
  QWEN_CHAT_COMPLETION_VERSION,
  QWEN_CHAT_COMPLETIONS_PATH,
  QWEN_CHAT_PROVIDER_ID,
  QWEN_CHAT_SUB_CHAT_TYPE,
  QWEN_CHAT_OUTPUT_SCHEMA,
  qwenChatApiHeaders,
  qwenChatFeatureConfig,
  qwenChatUrl,
  type QwenChatMode,
} from "./provider";

/** The HTTP result of a JSON POST issued from inside the page. */
export interface QwenChatJsonPostResult {
  readonly status: number;
  readonly body: unknown;
}

/** The result of a streaming POST. `bodyText` is present only when the answer was not a stream. */
export interface QwenChatStreamPostResult {
  readonly status: number;
  readonly contentType: string;
  readonly bodyText?: string;
}

/** What the provider's answer looked like once its response head was known. */
export interface QwenChatStreamOpened {
  readonly status: number;
  readonly contentType: string;
}

/** Options for one streaming POST. */
export interface QwenChatStreamPostOptions {
  /** Called with the response head, so the caller can report a truthful submission phase. */
  readonly onOpen?: (opened: QwenChatStreamOpened) => void;
  /** Cancels the read from this side; the page's own `fetch` is aborted. */
  readonly signal?: AbortSignal;
  /**
   * The `X-Request-Id` the turn built.
   *
   * The recorded app builds it inside the body and strips it before sending; the facility therefore
   * accepts it here and sends it as a header, so the id the caller generated is the id on the wire.
   */
  readonly requestId?: string;
}

/**
 * The request facility one turn needs.
 *
 * Deliberately two methods, not a general HTTP client: a JSON POST that returns a body, and a
 * streaming POST that reports chunks as they arrive. Tests inject a fake; the default implementation
 * is the page's own `fetch`.
 */
export interface QwenChatTurnRequestFacility {
  postJson(path: string, body: unknown): Promise<QwenChatJsonPostResult>;
  /**
   * POST and report each decoded text chunk.
   *
   * `onChunk` returns `true` once the caller no longer needs the stream; the implementation then
   * stops reading it (the browser-side reader is cancelled), so a terminal signal actually stops the
   * network turn instead of draining it.
   */
  postEventStream(
    path: string,
    body: unknown,
    onChunk: (chunk: string) => boolean,
    options?: QwenChatStreamPostOptions,
  ): Promise<QwenChatStreamPostResult>;
}

/**
 * The default facility: the page's own `fetch`, inside the page's browsing context.
 *
 * Cookies are the browser's, and the `authorization` header is the one the page's own token manager
 * holds — read from the page at call time, never from configuration or a constant. This module never
 * sees a cookie.
 *
 * A page with **no** token still issues the request (the provider's refusal is then reported
 * honestly). The recon records that the app falls back to an `x-umid` guest identity in that case
 * (recon §1.8); this adapter deliberately does **not** synthesize one, because its value and
 * provenance were not measured and inventing a guest identity would be a credential-shaped guess.
 */
export function createQwenChatPageRequestFacility(page: Page): QwenChatTurnRequestFacility {
  return {
    async postJson(path: string, body: unknown): Promise<QwenChatJsonPostResult> {
      const headers = qwenChatApiHeaders({
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
          // A non-JSON body (an HTML anti-bot page) is kept as text; the caller reports the status.
        }
        return { status: response.status, body: parsed };
      }, { url: qwenChatUrl(path), payload: body, headers });
      return { status: result.status, body: result.body };
    },

    async postEventStream(
      path: string,
      body: unknown,
      onChunk: (chunk: string) => boolean,
      options: QwenChatStreamPostOptions = {},
    ): Promise<QwenChatStreamPostResult> {
      const headers = qwenChatApiHeaders({
        accept: "text/event-stream",
        "x-request-id": options.requestId ?? randomUUID(),
        "x-accel-buffering": "no",
        ...await qwenAuthorizationHeaderFromPage(page),
      });
      const suffix = randomUUID().replace(/-/g, "");
      const binding = `__dshQwenChatChunk_${suffix}`;
      const openBinding = `__dshQwenChatOpen_${suffix}`;
      const abortKey = `__dshQwenChatAbort_${suffix}`;
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
          url: qwenChatUrl(path),
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
          ...(result.bodyText === undefined ? {} : { bodyText: result.bodyText }),
          contentType: result.contentType,
        };
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * A chat-creation refusal, classified by the provider's own answer.
 *
 * The read/write surfaces answer HTTP 200 for their refusals, so the category follows the body and
 * the anti-bot markers, never the status alone. The anti-bot branch exists because the recon measured
 * exactly those pages (recon §1.7); it is reported as an operator action, never retried.
 */
export function qwenChatRefusal(input: {
  readonly status: number;
  readonly contentType?: string;
  readonly bodyText?: string;
  readonly body?: unknown;
  /** What was being attempted, for the message. */
  readonly what: "create-a-chat" | "stream-a-completion";
  /** Whether a conversation's recorded chat was the target (a refusal then means "lost"). */
  readonly continuedChat: boolean;
}): WebChatError {
  const text = input.bodyText ?? "";
  const botWall = /_____tmd_____|x5secdata|aliyun_waf|punish\?|action=captchaconnect/i.test(text);
  if (botWall) {
    return webChatError(
      "AUTH_REQUIRED",
      `Qwen Chat answered the ${input.what} request with an access-verification challenge. `
      + "Open the operator sign-in surface /v1/control/auth/ (choose \"Qwen Chat\"), complete the "
      + "verification in that page, and retry — this provider never retries past a challenge itself.",
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_ACCESS_VERIFICATION" },
    );
  }
  const unauthorized = input.status === 401
    || input.status === 403
    || /"?Unauthorized"?/i.test(text)
    || (input.body !== undefined && bodySaysUnauthorized(input.body));
  const missing = input.status === 404 || /chat[^a-z]{0,4}not[^a-z]{0,4}found|ChatNotFound/i.test(text);
  if (missing && input.continuedChat) {
    return webChatError(
      "CONVERSATION_LOST",
      `Qwen Chat no longer has the chat this conversation was continuing (HTTP ${input.status}), so it `
      + "was not reused; a new chat requires an explicit replay",
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_CHAT_LOST" },
    );
  }
  if (unauthorized) {
    return webChatError(
      "AUTH_REQUIRED",
      `Qwen Chat refused to ${input.what}: the stored session is no longer accepted (HTTP ${input.status}). `
      + "Sign in again at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Chat\").",
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_SESSION_UNAUTHORIZED" },
    );
  }
  return webChatError(
    "UPSTREAM_ERROR",
    `Qwen Chat refused to ${input.what} (HTTP ${input.status}, ${input.contentType || "no content type"})`,
    { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_COMPLETION_REFUSED" },
  );
}

/** Whether a parsed envelope says `success:false` + `Unauthorized`. */
function bodySaysUnauthorized(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
  const code = data["code"];
  return record["success"] === false && (code === "Unauthorized" || code === 401 || code === "401");
}

/** One user message, in the recorded chat shape (recon §1.3). */
export interface QwenChatTurnMessage {
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
  readonly feature_config: Record<string, unknown>;
  readonly extra: { readonly meta: { readonly subChatType: string } };
  readonly sub_chat_type: string;
  readonly parent_id: string | null;
}

/** The two halves of the completion call: the JSON body, and the request id the app sends as a header. */
export interface QwenChatCompletionRequest {
  readonly body: Record<string, unknown>;
  /** Sent as `X-Request-Id`; the recorded app strips it from the body before sending. */
  readonly requestId: string;
}

/**
 * Build the one-message completion body.
 *
 * Pure and exported so the payload is assertable without a browser. The assistant's future id is
 * client-generated (as the web app does) and listed in the user message's `childrenIds`.
 */
export function qwenChatCompletionRequest(input: {
  readonly chatId: string;
  readonly prompt: string;
  readonly model: string;
  /** The mode to send, or `undefined` for a model that hides the selection entirely. */
  readonly mode?: QwenChatMode;
  /** `info.meta.thinking_format` of the selected model, when it published one. */
  readonly thinkingFormat?: string;
  readonly timestampSeconds: number;
  /** The user message id (the app generates it, so the adapter does too). */
  readonly messageId: string;
  /** The assistant message id, listed as the user message's only child, as the app does. */
  readonly assistantId: string;
  /** The previous turn's parent/response cursor, when this chat already has one. */
  readonly parentId?: string;
  /** Per-call request id; generated when omitted. */
  readonly requestId?: string;
}): QwenChatCompletionRequest {
  const { chatId, prompt, model, mode, timestampSeconds, messageId, assistantId } = input;
  // The recorded first-turn shape is `parentId: ""` at the top level and `null` on the message; a
  // continuation names the same cursor in both places.
  const parentId = input.parentId !== undefined && input.parentId.length > 0 ? input.parentId : "";
  // A model whose abilities hide the mode selection (the recorded `thinking: 2` case) gets the
  // schema field only: the app resolves no mode for it and sends no thinking selection, and this
  // adapter does not invent one. Otherwise the label and both derived booleans travel as one object
  // (`qwenChatFeatureConfig`), so the mode payload stays assertable in one place.
  const featureConfig = mode === undefined
    ? { output_schema: QWEN_CHAT_OUTPUT_SCHEMA }
    : qwenChatFeatureConfig({
      mode,
      ...(input.thinkingFormat === undefined ? {} : { thinkingFormat: input.thinkingFormat }),
    });
  return {
    requestId: input.requestId ?? randomUUID(),
    body: {
      stream: true,
      version: QWEN_CHAT_COMPLETION_VERSION,
      incremental_output: true,
      chatId,
      parentId,
      chat_id: chatId,
      chat_mode: QWEN_CHAT_CHAT_MODE,
      model,
      parent_id: parentId.length > 0 ? parentId : null,
      messages: [{
        id: null,
        fid: messageId,
        parentId: parentId.length > 0 ? parentId : null,
        childrenIds: [assistantId],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: [],
        timestamp: timestampSeconds,
        models: [model],
        model: "",
        chat_type: QWEN_CHAT_CHAT_TYPE,
        feature_config: featureConfig,
        extra: { meta: { subChatType: QWEN_CHAT_SUB_CHAT_TYPE } },
        sub_chat_type: QWEN_CHAT_SUB_CHAT_TYPE,
        parent_id: null,
      }],
      timestamp: timestampSeconds,
    },
  };
}

/**
 * Build the `chats/new` body, in the recorded shape (recon §1.3, `createChat`).
 *
 * The recorded call is `createChat(ctx, { chatId: "", models, project_id, timestamp, chat_type,
 * chat_mode })`; `project_id` is a project binding this text bridge does not have, so it is omitted
 * rather than sent as `undefined`/empty.
 */
export function qwenChatChatNewRequest(input: {
  readonly model: string;
  readonly timestampMs: number;
}): Record<string, unknown> {
  return {
    chatId: "",
    models: [input.model],
    timestamp: input.timestampMs,
    chat_type: QWEN_CHAT_CHAT_TYPE,
    chat_mode: QWEN_CHAT_CHAT_MODE,
  };
}

/** The id `chats/new` returned, or a typed failure explaining why the turn could not start. */
export function readQwenChatCreatedChatId(body: unknown, status: number): string {
  // A non-JSON answer (the anti-bot HTML page) is kept as text so the refusal can recognize it.
  const bodyText = typeof body === "string" ? body : undefined;
  if (status < 200 || status >= 300) {
    throw qwenChatRefusal({
      status,
      ...(bodyText === undefined ? { body } : { bodyText }),
      what: "create-a-chat",
      continuedChat: false,
    });
  }
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (record["success"] !== true) {
    throw qwenChatRefusal({
      status,
      ...(bodyText === undefined ? { body } : { bodyText }),
      what: "create-a-chat",
      continuedChat: false,
    });
  }
  const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
  const id = data["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw webChatError(
      "UPSTREAM_ERROR",
      "Qwen Chat created a chat without returning its id",
      { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_CHAT_CREATE_INVALID" },
    );
  }
  return id;
}

/** Wrap a non-WebChat failure in this provider's transport category, without leaking a page error. */
export function qwenChatTransportFailure(error: unknown, what: string): WebChatError {
  if (isWebChatError(error)) return error;
  return webChatError(
    "TRANSPORT_UNAVAILABLE",
    `Qwen Chat could not ${what}: ${nonSecretDiagnosticText(error)}`,
    { providerId: QWEN_CHAT_PROVIDER_ID, providerCode: "QWEN_CHAT_TURN_TRANSPORT", cause: error },
  );
}

/** The path of the completion call for one chat. */
export function qwenChatCompletionPath(chatId: string): string {
  return `${QWEN_CHAT_COMPLETIONS_PATH}?chat_id=${encodeURIComponent(chatId)}`;
}

/** Re-exported so a test can name the create path without reaching into `provider.ts`. */
export { QWEN_CHAT_CHATS_NEW_PATH };
