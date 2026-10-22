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

import { isWebChatError, webChatError, type WebChatError, type WebChatErrorCategory } from "../../web-chat/core";
import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import { qwenAuthorizationHeaderFromPage } from "../qwen-code/session-probe";
// The refusal-evidence rules are the shared ones (`../refusal-evidence`, factored out of the Qwen Code
// probe so both products reduce a provider answer the same way). Nothing here writes a second
// scrubber: a snippet, its redaction, its bound and its body-shape classification all come from there.
import {
  answerBodyShape,
  answerBodyText,
  contentTypePart,
  looksLikeHtmlDocument,
  providerAnswerReason,
  shapeFragment,
} from "../refusal-evidence";
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
// The frame vocabulary is the stream's own (`./sse`); this module only gives an empty answer the same
// treatment a refusal gets — one sentence and one structured log line, both bounded and redacted.
import {
  qwenChatEmptyStreamSummary,
  type QwenChatStreamObservation,
  type QwenChatTermination,
} from "./sse";

/** The HTTP result of a JSON POST issued from inside the page. */
export interface QwenChatJsonPostResult {
  readonly status: number;
  /** The parsed body, or the raw text when it was not JSON. */
  readonly body: unknown;
  /**
   * The answer's `content-type`, when the issuing seam could observe it.
   *
   * Diagnostics only, but load-bearing ones: the read/write surfaces answer **HTTP 200** for their
   * refusals, so a refusal's category follows the body and the content type, never the status alone.
   * An injected facility that cannot observe headers may omit it; the refusal then says so instead of
   * inventing one.
   */
  readonly contentType?: string;
  /**
   * The (bounded) raw body text, when the issuing seam could observe it.
   *
   * This is the field that used to be thrown away: a JSON body was parsed and the bytes that
   * identified it — the anti-bot `ret`/`FAIL_SYS_USER_VALIDATE` envelope, the provider's own
   * `data.code` — were reduced to "a refusal" with no evidence. It is reduced to a redacted snippet
   * before it can reach a refusal (see `../refusal-evidence`), and it is never a credential.
   */
  readonly bodyText?: string;
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
        const contentType = response.headers.get("content-type") ?? "";
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // A non-JSON body (an HTML anti-bot page) is kept as text; the caller reports the status.
        }
        return { status: response.status, contentType, text, body: parsed };
      }, { url: qwenChatUrl(path), payload: body, headers });
      // The parsed body answers the protocol; the status, the content type and the raw text are the
      // evidence a refusal needs. None of them is dropped on the floor here.
      return {
        status: result.status,
        body: result.body,
        contentType: result.contentType,
        bodyText: result.text,
      };
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
 * The kinds of refusal a Qwen Chat answer is reduced to.
 *
 * The read/write surfaces answer HTTP 200 for their refusals, so the category follows the **body** and
 * the anti-bot markers, never the status alone. The kinds exist because they lead to different fixes:
 * a WAF/punish document is the operator's verification, an authentication refusal is a re-sign-in, an
 * unknown chat on a continued conversation is continuity loss, and any other JSON refusal is a
 * body-shape question.
 */
export type QwenChatRefusalKind =
  | "access-verification"
  | "session-unauthorized"
  | "chat-lost"
  | "request-refused"
  | "empty-answer";

/** What was being attempted, for the message. */
export type QwenChatRefusalWhat = "create-a-chat" | "stream-a-completion";

/** Everything the classifier may look at. All of it is the provider's own answer, never a credential. */
export interface QwenChatRefusalInput {
  readonly status: number;
  readonly contentType?: string;
  /** The raw body text, when the issuing seam observed it (the primary evidence). */
  readonly bodyText?: string;
  /** The parsed body, when it was JSON. */
  readonly body?: unknown;
  readonly what: QwenChatRefusalWhat;
  /** Whether a conversation's recorded chat was the target (a refusal then means "lost"). */
  readonly continuedChat: boolean;
}

/** The classification of one refusal, before it becomes a `WebChatError`. */
export interface QwenChatRefusalRead {
  readonly kind: QwenChatRefusalKind;
  readonly category: WebChatErrorCategory;
  readonly providerCode: string;
  /** The operator-facing sentence: it always carries status, content-type and the body evidence. */
  readonly message: string;
  /** The bounded, redacted body fragment the one log line repeats (never a secret). */
  readonly evidence: string;
  /** The provider's own code/details, when the body carried them. */
  readonly reason?: string;
}

/**
 * The anti-bot markers this site's write paths answer with (recon §1.7).
 *
 * Two measured variants: the Alibaba TMD/`x5sec` page (`_____tmd_____`, `x5secdata`, a
 * `punish?`/`action=captchaconnect` URL) and the `aliyun_waf` block page (`aliyun_waf`). A
 * JSON-accepting client gets the TMD envelope instead, whose `ret` names `FAIL_SYS_USER_VALIDATE` /
 * `RGV587_ERROR`. The previous matcher missed that JSON variant's own tokens, which is one of the two
 * ways a punish answer could be reported as a generic refusal; both are matched here.
 */
const QWEN_CHAT_BOT_WALL_MARKERS =
  /_____tmd_____|x5secdata|aliyun_waf|FAIL_SYS_USER_VALIDATE|RGV587_ERROR|action=captchaconnect|punish\?/i;

/**
 * Whether a parsed envelope means "this HTTP 200 is a dead token".
 *
 * The vendor's own client decides exactly this way (its global `fetch` wrapper treats a JSON body with
 * `success:false` and a `data.code` of `Unauthorized`/`Invalid Token` as a 401 and refreshes), so the
 * adapter uses the provider's vocabulary rather than a private one. A bare 401/403 status is accepted
 * too.
 */
function bodySaysUnauthorized(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (record["success"] !== false) return false;
  const data = (record["data"] && typeof record["data"] === "object" ? record["data"] : {}) as Record<string, unknown>;
  const code = data["code"];
  if (code === 401 || code === "401") return true;
  return typeof code === "string" && ["unauthorized", "invalid token"].includes(code.toLowerCase());
}

/** The evidence clause every refusal carries: status, content-type, and what the body actually was. */
interface QwenChatRefusalEvidence {
  /** The parenthesised clause, e.g. `(HTTP 200, content-type: application/json; body snippet: …)`. */
  readonly clause: string;
  /** The bounded, redacted fragment the log line names (empty when the body was empty). */
  readonly fragment: string;
  /** The provider's own code/details, when the body carried legible ones. */
  readonly reason?: string;
}

/**
 * The parsed body when the caller did not have one, derived from the text it did observe.
 *
 * The streaming facility hands over the bytes rather than a parsed object (it has to decide the
 * content type first), so the classifier parses the same text it is about to reduce to a snippet. A
 * text that is not a JSON object stays `undefined`: nothing is invented from a body that is not JSON.
 */
function parsedAnswerBody(input: QwenChatRefusalInput): unknown {
  if (input.body !== undefined) return input.body;
  if (typeof input.bodyText !== "string") return undefined;
  const trimmed = input.bodyText.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function qwenChatRefusalEvidence(input: QwenChatRefusalInput): QwenChatRefusalEvidence {
  const body = parsedAnswerBody(input);
  const shape = answerBodyShape(body, input.bodyText);
  const rendered = shapeFragment(shape, Number.POSITIVE_INFINITY).replace(/^; /, "");
  const reason = providerAnswerReason(body);
  const clause = `(HTTP ${input.status}${contentTypePart(input.contentType)}`
    + (reason === undefined ? "" : `; the provider's own code/details: ${reason}`)
    + (rendered.length === 0 ? "" : `; ${rendered}`)
    + ")";
  return {
    clause,
    fragment: shape.details[0] ?? "",
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Classify one refusal by the provider's own answer. Pure: no logging, no error construction.
 *
 * Order matters, because the answers overlap: an anti-bot document is reported as the verification it
 * is before an `Unauthorized`-looking envelope can claim the session is dead; a chat this adapter
 * proved gone is continuity loss, not a generic refusal.
 */
export function readQwenChatRefusal(input: QwenChatRefusalInput): QwenChatRefusalRead {
  const text = answerBodyText(input.body, input.bodyText);
  const evidence = qwenChatRefusalEvidence(input);
  const { clause, reason } = evidence;

  const botWall = QWEN_CHAT_BOT_WALL_MARKERS.test(text)
    // The recon measured both write paths answering an *HTML* access-verification page. Any HTML
    // document on a JSON endpoint is that class of answer; a non-2xx document stays an upstream
    // failure below, so a CDN error page is not dressed up as a challenge.
    || (input.status === 200 && looksLikeHtmlDocument(text));
  if (botWall) {
    return {
      kind: "access-verification",
      category: "AUTH_REQUIRED",
      providerCode: "QWEN_CHAT_ACCESS_VERIFICATION",
      message: `Qwen Chat answered the ${input.what} request with an access-verification challenge `
        + `${clause}. Open the operator sign-in surface /v1/control/auth/ (choose "Qwen Chat"), `
        + "complete the verification in that page, and retry — this provider never retries past a "
        + "challenge itself.",
      evidence: evidence.fragment,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  const missing = input.status === 404 || /chat[^a-z]{0,4}not[^a-z]{0,4}found|ChatNotFound/i.test(text);
  if (missing && input.continuedChat) {
    return {
      kind: "chat-lost",
      category: "CONVERSATION_LOST",
      providerCode: "QWEN_CHAT_CHAT_LOST",
      message: `Qwen Chat no longer has the chat this conversation was continuing ${clause}, so it `
        + "was not reused; a new chat requires an explicit replay",
      evidence: evidence.fragment,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  const unauthorized = input.status === 401
    || input.status === 403
    || /"?Unauthorized"?/i.test(text)
    || bodySaysUnauthorized(parsedAnswerBody(input));
  if (unauthorized) {
    return {
      kind: "session-unauthorized",
      category: "AUTH_REQUIRED",
      providerCode: "QWEN_CHAT_SESSION_UNAUTHORIZED",
      message: `Qwen Chat refused to ${input.what}: the stored session is no longer accepted ${clause}. `
        + "Sign in again at the operator sign-in surface /v1/control/auth/ (choose \"Qwen Chat\").",
      evidence: evidence.fragment,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  if (text.trim().length === 0) {
    return {
      kind: "empty-answer",
      category: "UPSTREAM_ERROR",
      providerCode: "QWEN_CHAT_EMPTY_ANSWER",
      message: `Qwen Chat refused to ${input.what}: the provider answered HTTP ${input.status}`
        + `${contentTypePart(input.contentType)}, with an empty body instead of a stream`,
      evidence: "",
    };
  }

  return {
    kind: "request-refused",
    category: "UPSTREAM_ERROR",
    providerCode: "QWEN_CHAT_COMPLETION_REFUSED",
    message: `Qwen Chat refused to ${input.what}: the provider answered its own refusal instead of a `
      + `stream ${clause}`,
    evidence: evidence.fragment,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * The typed refusal for one refused request, with the provider's own answer preserved.
 *
 * The answer reaches **both** the error the operator sees and one structured log line: a thrown-away
 * body is a refusal nobody can act on, and an operator should not need a second round trip to learn
 * what the provider said. The status, the content type and the body are the same fields in both, and
 * the body is the shared redaction's bounded snippet — never a cookie, a token or a request header.
 */
export function qwenChatRefusal(input: QwenChatRefusalInput): WebChatError {
  const read = readQwenChatRefusal(input);
  console.warn(
    `[qwen-chat] qwen_chat_refusal ${JSON.stringify({
      provider: QWEN_CHAT_PROVIDER_ID,
      what: input.what,
      kind: read.kind,
      status: input.status,
      contentType: input.contentType ?? "",
      body: read.evidence,
    })}`,
  );
  return webChatError(read.category, read.message, {
    providerId: QWEN_CHAT_PROVIDER_ID,
    providerCode: read.providerCode,
    providerDetail: {
      kind: read.kind,
      status: input.status,
      contentType: input.contentType ?? "",
      ...(read.reason === undefined ? {} : { reason: read.reason }),
      body: read.evidence,
    },
  });
}

/**
 * The typed failure of a stream that **completed with no extracted answer text**.
 *
 * Until this existed the transport treated such a turn as a success and published an empty answer,
 * so the operator's harness reported a completed response with no content and nothing else — the
 * frame vocabulary the provider actually used was thrown away. The category stays `UPSTREAM_ERROR`;
 * the provider code is this case's own, and the evidence is the same kind of bounded, redacted
 * summary a refusal carries: frame count, the distinct frame shapes with their counts (key paths
 * only), the signal that ended the stream, how many delta frames carried a content field at all, and
 * at most one short redacted payload fragment.
 *
 * It is deliberately **not** a `QwenChatRefusalKind`: a refusal is the provider answering instead of
 * streaming, while this is the provider streaming and this driver reading nothing out of it. They
 * lead to different fixes, so they stay distinguishable.
 */
export function qwenChatEmptyStream(input: {
  readonly observation: QwenChatStreamObservation;
  readonly termination: QwenChatTermination;
  readonly terminalStatus?: string;
}): WebChatError {
  const read = qwenChatEmptyStreamSummary(input);
  console.warn(
    `[qwen-chat] qwen_chat_empty_stream ${JSON.stringify({
      provider: QWEN_CHAT_PROVIDER_ID,
      ...read.detail,
    })}`,
  );
  return webChatError("UPSTREAM_ERROR", read.message, {
    providerId: QWEN_CHAT_PROVIDER_ID,
    providerCode: "QWEN_CHAT_EMPTY_STREAM",
    providerDetail: read.detail,
  });
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

/**
 * The id `chats/new` returned, or a typed failure explaining why the turn could not start.
 *
 * The whole answer is handed to the refusal — status, content type, the parsed body **and** the raw
 * text — because a `chats/new` refusal is either a JSON envelope that names its own reason or an
 * anti-bot document, and neither is readable from the status alone. Dropping the raw text here is what
 * used to make a JSON punish envelope answer as an unexplained refusal.
 */
export function readQwenChatCreatedChatId(result: QwenChatJsonPostResult): string {
  const evidence = {
    status: result.status,
    ...(result.contentType === undefined ? {} : { contentType: result.contentType }),
    ...(result.bodyText === undefined ? {} : { bodyText: result.bodyText }),
    body: result.body,
  };
  if (result.status < 200 || result.status >= 300) {
    throw qwenChatRefusal({ ...evidence, what: "create-a-chat", continuedChat: false });
  }
  const record = (result.body && typeof result.body === "object" ? result.body : {}) as Record<string, unknown>;
  if (record["success"] !== true) {
    throw qwenChatRefusal({ ...evidence, what: "create-a-chat", continuedChat: false });
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
