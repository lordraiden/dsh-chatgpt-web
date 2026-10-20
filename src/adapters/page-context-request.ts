/**
 * Issue one HTTP request from **inside a provider's own page** (issue #299).
 *
 * Some consumer-web providers do not authenticate their API with cookies alone: their page's own
 * client attaches something per request (an `Authorization` header built from local storage). A call
 * made from a request context — `context.request` / `page.request` — carries the cookie jar and
 * nothing else, so it is not "how the page does it" and the provider answers Unauthorized even
 * though the captured session is perfectly good.
 *
 * This module is the **provider-neutral mechanism** for the honest alternative: run `fetch` in the
 * page's own browsing context, so the request is same-origin and carries the page's cookies,
 * `Origin`, `Referer` and `Sec-Fetch-*` exactly as the app's own calls do. What is attached on top of
 * that — a header name, where its value comes from — is the provider's business and must never be
 * decided here.
 *
 * Deliberately small: one request, bounded by a timeout and by a caller-owned character bound,
 * returning status plus decoded text. The bound is a transport fact, reported honestly
 * ({@link PageContextAnswer.truncated}) instead of silently deciding that a large answer is a bad
 * one. It is a transport primitive, not a second HTTP client and not an architecture around `Page`
 * (AGENTS.md → *Browser is a transport mechanism, not the architecture*).
 */
import type { Page } from "playwright-core";

/** One request to issue from the page's browsing context. */
export interface PageContextRequest {
  /** Absolute URL. It must be same-origin with the page, which is what makes this "the page". */
  readonly url: string;
  /** HTTP method; defaults to `GET`. */
  readonly method?: "GET" | "POST";
  /** Every header to send. The caller supplies the provider's own shape; nothing is added here. */
  readonly headers: Readonly<Record<string, string>>;
  /** Request body, already serialized (JSON for these providers). */
  readonly body?: string;
  /** How long the request may take before it is aborted inside the page. */
  readonly timeoutMs: number;
  /**
   * Upper bound on the answer text handed back to Node. Defaults to {@link DEFAULT_MAX_ANSWER_CHARS}.
   *
   * The caller owns this bound because only the caller knows how large its endpoint's *successful*
   * answer legitimately is. It is a transport bound, never an authentication decision: a body larger
   * than it is reported as {@link PageContextAnswer.truncated} and the caller decides what a cut
   * answer means for its own protocol.
   */
  readonly maxAnswerChars?: number;
}

/** What the page observed. `payload` is the parsed JSON, or `undefined` when the body was not JSON. */
export interface PageContextAnswer {
  readonly status: number;
  readonly contentType: string;
  /** The (bounded) body text. A non-JSON body — an HTML error page — stays text. */
  readonly text: string;
  /** `JSON.parse(text)` when that succeeds, else `undefined`. */
  readonly payload: unknown;
  /**
   * Whether the body was longer than the caller's bound and had to be cut.
   *
   * The read stops at the bound instead of buffering an unbounded body inside the page, so `text` is
   * a prefix of the answer when this is `true`. A caller must not read "I cannot parse this" as "the
   * provider answered garbage": a cut body is the transport's own limit at work.
   */
  readonly truncated: boolean;
}

/**
 * A larger body than this is cut: these APIs answer small JSON objects.
 *
 * It is a *default*, not a rule about what a provider may legitimately answer: a probe of an
 * account-sized collection endpoint has to raise it for its own call (and still tolerate a cut body).
 */
const DEFAULT_MAX_ANSWER_CHARS = 20_000;

/**
 * Issue `request` from `page` and hand back what it answered.
 *
 * The timeout and the credential mode are both explicit inside the page: `credentials: "same-origin"`
 * is what makes the browser attach the session's cookies, and an `AbortController` keeps a hanging
 * provider from holding a sign-in or an import open indefinitely. The page's own code is not
 * interfered with — this adds no interceptor, no monkey-patch and no header the caller did not ask
 * for.
 */
export async function requestInPageContext(
  page: Page,
  request: PageContextRequest,
): Promise<PageContextAnswer> {
  const method = request.method ?? "GET";
  const maxChars = request.maxAnswerChars ?? DEFAULT_MAX_ANSWER_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new TypeError("A page-context request requires a positive maxAnswerChars bound");
  }
  const observed = await page.evaluate(async ({ url, method, headers, body, timeoutMs, maxChars }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        // Same-origin is the page's own mode: the browser supplies the session's cookies.
        credentials: "same-origin",
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      // Read the body as it arrives and stop at the bound: a chat list can be far larger than any
      // diagnostic needs, and the caller only ever has to decide what the answer says about its
      // session. Stopping also means a provider cannot force the page to buffer an unbounded body.
      const reader = response.body?.getReader?.();
      if (!reader) {
        const whole = await response.text();
        const cut = whole.length > maxChars;
        return { status: response.status, contentType, text: cut ? whole.slice(0, maxChars) : whole, truncated: cut };
      }
      const decoder = new TextDecoder();
      let text = "";
      let truncated = false;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
        if (text.length > maxChars) {
          truncated = true;
          text = text.slice(0, maxChars);
          break;
        }
      }
      if (truncated) {
        // The rest of the answer is not needed: release the connection rather than drain it.
        try { await reader.cancel(); } catch { /* the bound already decided; nothing to recover */ }
      } else {
        text += decoder.decode();
      }
      return { status: response.status, contentType, text, truncated };
    } finally {
      clearTimeout(timer);
    }
  }, {
    url: request.url,
    method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: request.body }),
    timeoutMs: request.timeoutMs,
    maxChars,
  });

  let payload: unknown;
  try {
    payload = JSON.parse(observed.text);
  } catch {
    payload = undefined;
  }
  return {
    status: observed.status,
    contentType: observed.contentType,
    text: observed.text,
    payload,
    truncated: observed.truncated === true,
  };
}
