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
 *    completion target, solved by the bundle's own WASM module.
 *
 * The cookie/WAF half is what the provider-neutral page-context relay already solves: the request is
 * issued by the provider's own page, same-origin, with the page's cookies and `Sec-Fetch-*`. This
 * module adds no user-agent override, no stealth flag and no synthesized WAF cookie. If the page is
 * challenged, the turn fails with a typed access-verification category instead of being retried
 * behind the operator's back.
 *
 * ## The two things this build cannot produce, and where each one lives
 *
 * The proof of work is isolated behind **one seam**, {@link DeepSeekProofOfWorkSolver}, reached only
 * through {@link DeepSeekTurnRequestFacility.requestProofOfWork}. Its default implementation
 * {@link unprovenDeepSeekProofOfWork} throws a typed `TRANSPORT_UNAVAILABLE` failure and nothing else:
 * no retry, no fabricated clearance, no silent skip of the step. Two facts are unproven (recon §2.8):
 *
 * - the **header name** the solved proof travels in (the bundle computes it but the name is not a
 *   plain literal in `main.js`);
 * - the **solution contract** — which hash function, which encoding, what the WASM module's entry
 *   point is.
 *
 * Because the header name is unproven, it travels *with* the value: a solver returns
 * `{header, value}`, so one capture replaces both halves in one place instead of leaving a guessed
 * header constant behind.
 *
 * The second unproven thing is the **provenance of the `Authorization` token** (recon §2.7 records the
 * header and the token manager, not where the token is stored). {@link
 * DeepSeekPageFacilityOptions.authorization} is that seam; its default sends no header at all rather
 * than reading or inventing a credential. The provider's own `40002`/`40003` refusal is then reported
 * honestly as `AUTH_REQUIRED`.
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
  type DeepSeekProofChallenge,
} from "./provider";

/** How long one JSON call (a session create, a challenge) may take. */
export const DEEPSEEK_WEB_JSON_TIMEOUT_MS = 30_000;

/** One solved proof of work: the header it travels in, and its value. */
export interface DeepSeekProofOfWork {
  /**
   * The request header name the provider expects.
   *
   * **Unproven** (recon §2.8). A solver owns it because the header name and the solver contract are
   * settled by the same observation (one signed-in HAR of a completion).
   */
  readonly header: string;
  /** The header value the solver produced from the challenge. */
  readonly value: string;
}

/** What a solver is given. */
export interface DeepSeekProofOfWorkRequest {
  /** The route the proof is for — the recorded `target_path` is the completion path. */
  readonly targetPath: string;
  /** The provider's challenge, with its raw object so a field this build did not name is available. */
  readonly challenge: DeepSeekProofChallenge;
}

/**
 * The one seam the proof-of-work step is isolated behind.
 *
 * A production implementation must use **the page's own solver** (the bundle's `r1Pow` WASM flow,
 * recon §2.6) — never a reimplementation, because the challenge contract is the vendor's. This build
 * does not call it: no global handle for the module was measured, so invoking it would be an
 * invention. See `doc/deepseek-web.md` §6 for the observation that settles it.
 */
export type DeepSeekProofOfWorkSolver = (request: DeepSeekProofOfWorkRequest) => Promise<DeepSeekProofOfWork>;

/**
 * The default solver: a typed refusal, never a fabricated clearance.
 *
 * The failure is `TRANSPORT_UNAVAILABLE` because this is an admission step this build cannot perform
 * — not an authentication refusal (no credential was rejected) and not the provider's error (nothing
 * was sent). The turn is pre-submission and therefore retry-safe; the message names the seam.
 */
export function unprovenDeepSeekProofOfWork(): DeepSeekProofOfWorkSolver {
  return async () => {
    throw webChatError(
      "TRANSPORT_UNAVAILABLE",
      "DeepSeek requires a per-completion proof of work, and this build cannot produce one: the header "
      + "name and the solver contract are unproven (doc/deepseek-web.md §6), so no request was sent. "
      + "The page's own solver is the only acceptable implementation.",
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_POW_UNAVAILABLE" },
    );
  };
}

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
  /** The proof solver. Defaults to {@link unprovenDeepSeekProofOfWork}. */
  readonly requestProofOfWork?: DeepSeekProofOfWorkSolver;
  /**
   * Read the `Authorization` value the page's own client would send.
   *
   * Defaults to "none": no storage key holding this provider's token was measured (recon §2.7 records
   * the header and the token manager, not where the token lives), and reading a credential by guessing
   * at keys is worse than sending no header. The provider then refuses with `40002`/`40003`, which is
   * reported as `AUTH_REQUIRED` with an actionable message.
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
  const requestProofOfWork = options.requestProofOfWork ?? unprovenDeepSeekProofOfWork();
  const authorization = options.authorization;

  const authHeaders = async (): Promise<Record<string, string>> => {
    if (authorization === undefined) return {};
    try {
      return authorizationHeaders(await authorization());
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
      const headers = deepSeekApiHeaders(await authHeaders());
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
        accept: "text/event-stream",
        "x-accel-buffering": "no",
        ...(streamOptions.proof === undefined ? {} : { [streamOptions.proof.header]: streamOptions.proof.value }),
        ...await authHeaders(),
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
