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
 * Deliberately small: one request, bounded by a timeout, returning status plus decoded text. It is a
 * transport primitive, not a second HTTP client and not an architecture around `Page`
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
  /** Upper bound on the answer text handed back to Node. Defaults to {@link DEFAULT_MAX_ANSWER_CHARS}. */
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
}

/** A larger body than this is truncated: these APIs answer small JSON objects. */
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
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        text: text.length > maxChars ? text.slice(0, maxChars) : text,
      };
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
  };
}
