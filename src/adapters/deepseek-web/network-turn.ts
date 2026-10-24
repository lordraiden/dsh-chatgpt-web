/**
 * One DeepSeek Web turn over the browser's own network context.
 *
 * ## Why the request is issued from inside the page
 *
 * `chat.deepseek.com` gates a turn twice (recon §2.6):
 *
 * 1. the HTML shell and its API sit behind an **AWS WAF** challenge (`202` + `x-amzn-waf-action:
 *    challenge`), and the app treats `405` + `captcha` as a first-class state;
 * 2. `POST /api/v0/chat/completion` additionally needs a **proof of work** — one challenge per
 *    completion target, solved by the page's own SHA3 WASM worker.
 *
 * The cookie/WAF half is what the provider-neutral page-context relay solves: the request is issued by
 * the provider's own page, same-origin, with the page's cookies and `Sec-Fetch-*`. This module adds no
 * user-agent override, no stealth flag and no synthesized WAF cookie. If the page is challenged, the
 * turn fails with a typed access-verification category instead of being retried behind the operator's
 * back.
 *
 * ## The three things that come from the page at call time
 *
 * The signed-in capture settled all three; none is a constant in this module:
 *
 * - the **proof of work** (`pow.ts`) is produced by the page's own worker, attached to the completion
 *   POST *and nowhere else* — one fresh proof per completion;
 * - the **`Authorization`** value is read from the page's own `localStorage["userToken"]` handle
 *   (`page-identity.ts`), never from configuration and never from a captured header;
 * - the **`x-client-*` / `x-device-*` / `x-hif-leim`** family is built from the page's identity
 *   (`page-identity.ts`), so a guessed client version or a fabricated device id can never be sent.
 *
 * If the page has no token, no `Authorization` header is sent and the provider's own `40002`/`40003`
 * is reported as `AUTH_REQUIRED`. If the page cannot run its solver, the turn fails before anything is
 * sent with `TRANSPORT_UNAVAILABLE` / `DEEPSEEK_POW_UNAVAILABLE`. Neither path fabricates anything and
 * neither retries.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

import { webChatError } from "../../web-chat/core";
import { requestInPageContext } from "../page-context-request";
import {
  DEEPSEEK_WEB_MAX_ANSWER_CHARS,
  DEEPSEEK_WEB_PROVIDER_ID,
  deepSeekApiHeaders,
  deepSeekUrl,
} from "./provider";
import {
  createDeepSeekPageProofAnswerer,
  createDeepSeekProofOfWorkSolver,
  unprovenDeepSeekProofOfWork,
  type DeepSeekProofOfWork,
  type DeepSeekProofOfWorkRequest,
  type DeepSeekProofOfWorkSolver,
} from "./pow";
import {
  deepSeekAuthorizationHeader,
  deepSeekClientHeaders,
  readDeepSeekPageIdentity,
} from "./page-identity";

export { unprovenDeepSeekProofOfWork };
export type { DeepSeekProofOfWork, DeepSeekProofOfWorkRequest, DeepSeekProofOfWorkSolver };

/** How long one JSON call (a session create, a challenge) may take. */
export const DEEPSEEK_WEB_JSON_TIMEOUT_MS = 30_000;

/** The HTTP result of a JSON POST issued from inside the page. */
export interface DeepSeekJsonResult {
  readonly status: number;
  readonly contentType: string;
  /** The parsed JSON body, when the answer was JSON. */
  readonly body: unknown;
  /** The (bounded) body text, so a non-JSON answer can still be classified. */
  readonly bodyText: string;
  /** Whether the transport cut the body at its bound. */
  readonly truncated: boolean;
}

/** The result of a streaming POST. `bodyText` is present only when the answer was not a stream. */
export interface DeepSeekStreamResult {
  readonly status: number;
  readonly contentType: string;
  readonly bodyText?: string;
}

/** What the provider's answer looked like once its response head was known. */
export interface DeepSeekStreamOpened {
  readonly status: number;
  readonly contentType: string;
}

/** Options for one streaming POST. */
export interface DeepSeekStreamPostOptions {
  /** Called with the response head, so the caller can report a truthful submission phase. */
  readonly onOpen?: (opened: DeepSeekStreamOpened) => void;
  /** Cancels the read from this side; the page's own `fetch` is aborted. */
  readonly signal?: AbortSignal;
  /**
   * The proof this turn produced.
   *
   * It is attached **here and only here**: the record says one proof per completion target, and this
   * call is the completion.
   */
  readonly proof?: DeepSeekProofOfWork;
}

/**
 * The request facility one turn needs.
 *
 * Deliberately small and provider-shaped: two POSTs and the proof seam, not a general HTTP client. A
 * test injects a controlled facility; the default implementation is the page's own `fetch`.
 */
export interface DeepSeekTurnRequestFacility {
  postJson(path: string, body: unknown): Promise<DeepSeekJsonResult>;
  /**
   * POST and report each decoded text chunk.
   *
   * `onChunk` returns `true` once the caller no longer needs the stream; the implementation then stops
   * reading it (the page-side reader is cancelled), so a terminal signal actually ends the network
   * turn instead of draining it.
   */
  postEventStream(
    path: string,
    body: unknown,
    onChunk: (chunk: string) => boolean,
    options?: DeepSeekStreamPostOptions,
  ): Promise<DeepSeekStreamResult>;
  /** Produce the proof of work the completion requires. */
  requestProofOfWork(request: DeepSeekProofOfWorkRequest): Promise<DeepSeekProofOfWork>;
}

/** Options for {@link createDeepSeekPageRequestFacility}. */
export interface DeepSeekPageFacilityOptions {
  /** The proof solver. Defaults to the page's own worker ({@link createDeepSeekPageProofAnswerer}). */
  readonly requestProofOfWork?: DeepSeekProofOfWorkSolver;
  /**
   * Override the `Authorization` value the page's own client would send.
   *
   * Defaults to reading the page's own token from its `localStorage["userToken"]` handle at call time.
   * An override that answers `undefined` sends no header; the provider's `40002`/`40003` is then
   * reported as `AUTH_REQUIRED`.
   */
  readonly authorization?: () => Promise<string | undefined>;
}

/** The `Authorization: Bearer …` shape the recorded app sends (recon §2.7), when a value is available. */
function authorizationHeaders(value: string | undefined): Record<string, string> {
  return value === undefined || value.trim().length === 0
    ? {}
    : { authorization: value.startsWith("Bearer ") ? value : `Bearer ${value}` };
}

/**
 * The default facility: the page's own `fetch`, inside the page's browsing context.
 *
 * Cookies are the browser's. The `Authorization` header and the proof-of-work header are supplied by
 * the two documented seams; this module never invents either, and it never sees a cookie.
 */
export function createDeepSeekPageRequestFacility(
  page: Page,
  options: DeepSeekPageFacilityOptions = {},
): DeepSeekTurnRequestFacility {
  const requestProofOfWork = options.requestProofOfWork
    ?? createDeepSeekProofOfWorkSolver(createDeepSeekPageProofAnswerer(page));
  const authorization = options.authorization;

  /**
   * The page's identity for one request: its client/device headers plus its own bearer, read now.
   *
   * Read per request (not once per page) because the page's token is the page's to rotate. The
   * `authorization` override replaces only the bearer; the client/device headers still come from the
   * page, because they are the browser's own identity.
   */
  const pageHeaders = async (): Promise<Record<string, string>> => {
    let identity;
    try {
      identity = await readDeepSeekPageIdentity(page);
    } catch (error) {
      throw webChatError(
        "TRANSPORT_UNAVAILABLE",
        "The DeepSeek page identity could not be read, so this turn was not sent. The page must be "
        + "the signed-in chat.deepseek.com app.",
        { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_PAGE_IDENTITY_UNREADABLE", cause: error },
      );
    }
    const client = deepSeekClientHeaders(identity);
    if (authorization === undefined) {
      return { ...client, ...deepSeekAuthorizationHeader(identity) };
    }
    try {
      return { ...client, ...authorizationHeaders(await authorization()) };
    } catch (error) {
      throw webChatError(
        "AUTH_REQUIRED",
        "The DeepSeek page token could not be read, so this turn was not sent. Capture a fresh "
        + "signed-in session and import it with `auth import --provider deepseek-web`.",
        { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_TOKEN_UNREADABLE", cause: error },
      );
    }
  };

  return {
    async postJson(path: string, body: unknown): Promise<DeepSeekJsonResult> {
      const headers = deepSeekApiHeaders(await pageHeaders());
      const answer = await requestInPageContext(page, {
        url: deepSeekUrl(path),
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs: DEEPSEEK_WEB_JSON_TIMEOUT_MS,
        maxAnswerChars: DEEPSEEK_WEB_MAX_ANSWER_CHARS,
      });
      return {
        status: answer.status,
        contentType: answer.contentType,
        body: answer.payload,
        bodyText: answer.text,
        truncated: answer.truncated,
      };
    },

    async postEventStream(
      path: string,
      body: unknown,
      onChunk: (chunk: string) => boolean,
      streamOptions: DeepSeekStreamPostOptions = {},
    ): Promise<DeepSeekStreamResult> {
      const headers = deepSeekApiHeaders({
        ...await pageHeaders(),
        ...(streamOptions.proof === undefined ? {} : { [streamOptions.proof.header]: streamOptions.proof.value }),
      });
      const suffix = randomUUID().replace(/-/g, "");
      const chunkBinding = `__dshDeepSeekChunk_${suffix}`;
      const openBinding = `__dshDeepSeekOpen_${suffix}`;
      const abortKey = `__dshDeepSeekAbort_${suffix}`;
      await page.exposeBinding(chunkBinding, async (_source, chunk: unknown) => {
        return typeof chunk === "string" ? onChunk(chunk) : false;
      });
      let openedReported = false;
      const reportOpened = (status: number, contentType: string): void => {
        if (openedReported) return;
        openedReported = true;
        streamOptions.onOpen?.({ status, contentType });
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
      if (streamOptions.signal?.aborted === true) onAbort();
      else streamOptions.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await page.evaluate(async ({ url, payload, headers, chunkBinding, openBinding, abortKey }) => {
          const controller = new AbortController();
          (window as unknown as Record<string, unknown>)[abortKey] = () => controller.abort();
          type ChunkSink = (chunk: string) => Promise<boolean>;
          type OpenSink = (payload: { status: number; contentType: string }) => Promise<boolean>;
          const report = (window as unknown as Record<string, ChunkSink | undefined>)[chunkBinding];
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
          url: deepSeekUrl(path),
          payload: body,
          headers,
          chunkBinding,
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
        streamOptions.signal?.removeEventListener("abort", onAbort);
      }
    },

    requestProofOfWork(request: DeepSeekProofOfWorkRequest): Promise<DeepSeekProofOfWork> {
      return requestProofOfWork(request);
    },
  };
}
