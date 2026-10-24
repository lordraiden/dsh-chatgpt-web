/**
 * A simulated `chat.deepseek.com` page, for the DeepSeek import predicate's tests.
 *
 * The shapes here are the **recorded** ones (`doc/deepseek-web.md` §6.1 rows 3, 13a and 14): the
 * settings envelope with its two layers, the identity read the page answers (`region`, `locale`,
 * timezone offset, device id, `userToken` handle, leim cache) and the request the predicate assembles.
 * Every value is synthetic — no captured token, device id or cookie value appears in this file.
 *
 * The double exists so the production assembly runs unmodified: the real `readDeepSeekPageIdentity`
 * interprets the raw answer, the real `requestInPageContext` parses the answer text, and the real
 * predicate classifies it. Only `page.evaluate` is replaced.
 */
import type { Page } from "playwright-core";

import {
  DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY,
  DEEPSEEK_WEB_TOKEN_STORAGE_KEY,
} from "../../src/adapters/deepseek-web";

/** A synthetic device identity in the browser's UUID shape. */
export const DEEPSEEK_DEVICE_ID = "11111111-1111-4111-8111-111111111111";

/** The other device identity, so a test can prove which one the request carries. */
export const OTHER_DEEPSEEK_DEVICE_ID = "22222222-2222-4222-8222-222222222222";

/** One answered request: status, content type and the body text exactly as the page would read it. */
export interface DeepSeekAnswerFixture {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

/** The measured signed-in settings answer: success at both envelope layers. */
export const DEEPSEEK_SETTINGS_AUTHENTICATED: DeepSeekAnswerFixture = {
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({
    code: 0,
    msg: "",
    data: {
      biz_code: 0,
      biz_msg: "",
      biz_data: {
        // The measured shape of the model settings value: an `{id, value}` wrapper (row 3).
        settings: {
          model_configs: {
            id: "model",
            value: [{ value: "default", enabled: true, switchable: true, is_default: true }],
          },
        },
      },
    },
  }),
};

/** The measured anonymous answer: HTTP 200, `code:0`, a business refusal nested beside it. */
export const DEEPSEEK_SETTINGS_ANONYMOUS: DeepSeekAnswerFixture = {
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({ code: 0, msg: "", data: { biz_code: 1, biz_msg: "SETTINGS_NOT_FOUND" } }),
};

/** The token refusal nested in the business layer (the capture's `biz_code` family). */
export const DEEPSEEK_SETTINGS_NESTED_TOKEN_REFUSED: DeepSeekAnswerFixture = {
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({ code: 0, msg: "", data: { biz_code: 40003, biz_msg: "INVALID_TOKEN" } }),
};

/** The token refusal at the top layer, which the anonymous capture also showed. */
export const DEEPSEEK_SETTINGS_TOP_TOKEN_REFUSED: DeepSeekAnswerFixture = {
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({ code: 40003, msg: "INVALID_TOKEN", data: null }),
};

/** A plain HTML document with no challenge marker: unreadable, not a challenge. */
export const DEEPSEEK_HTML: DeepSeekAnswerFixture = {
  status: 200,
  contentType: "text/html; charset=utf-8",
  text: "<!DOCTYPE html><html><head><title>Not Found</title></head><body>nope</body></html>",
};

/** The recorded access-verification shape: the WAF marker travels in the answer. */
export const DEEPSEEK_WAF_HTML: DeepSeekAnswerFixture = {
  status: 202,
  contentType: "text/html; charset=utf-8",
  text: "<!DOCTYPE html><html><head><title>Access Verification</title></head>"
    + '<body><script>x-amzn-waf-action: challenge</script></body></html>',
};

/** An HTTP-level refusal with no envelope at all. */
export function deepSeekStatusAnswer(status: number): DeepSeekAnswerFixture {
  return { status, contentType: "text/html; charset=utf-8", text: "" };
}

/** One request the probe issued from the page. Headers are kept for assertion, never sent. */
export interface DeepSeekSentRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** What the simulated page recorded. */
export interface SimulatedDeepSeekPage {
  readonly page: Page;
  /** Every request the predicate issued, in order. */
  readonly sent: DeepSeekSentRequest[];
  /** The token value the page handed back on each identity read. */
  readonly reads: (string | undefined)[];
  /** Rotate the page's token, so a test can prove the request follows the live page. */
  setToken(token: string | undefined): void;
}

/** Options for {@link simulatedDeepSeekPage}. */
export interface SimulatedDeepSeekPageOptions {
  /** The token the page's `userToken` handle holds (absent = a page with no token). */
  readonly token?: string;
  /** The device identity the page reports. */
  readonly deviceId?: string;
  /** What the settings call answers; defaults to the measured signed-in answer. */
  readonly answer?: DeepSeekAnswerFixture;
  /** The page's cached HIF leim token; omitted means the header is omitted, as the app does. */
  readonly leim?: string;
}

/** A page double: the identity read, the page-context request, and nothing else. */
export function simulatedDeepSeekPage(options: SimulatedDeepSeekPageOptions = {}): SimulatedDeepSeekPage {
  const sent: DeepSeekSentRequest[] = [];
  const reads: (string | undefined)[] = [];
  let token = options.token;

  const page = {
    evaluate: async (_fn: unknown, arg?: Record<string, unknown>) => {
      if (typeof arg?.["deviceKey"] === "string") {
        reads.push(token);
        return {
          region: "ES",
          locale: "en_US",
          timezoneOffsetSeconds: 7200,
          deviceId: options.deviceId ?? DEEPSEEK_DEVICE_ID,
          ...(options.leim === undefined ? {} : { leimStorage: JSON.stringify(options.leim) }),
          ...(token === undefined
            ? {}
            : { tokenStorage: JSON.stringify({ value: token, __version: "0" }) }),
        };
      }
      if (typeof arg?.["url"] === "string") {
        sent.push({
          url: String(arg["url"]),
          headers: { ...(arg["headers"] as Record<string, string>) },
        });
        const answer = options.answer ?? DEEPSEEK_SETTINGS_AUTHENTICATED;
        return {
          status: answer.status,
          contentType: answer.contentType,
          text: answer.text,
          truncated: false,
        };
      }
      throw new Error("the simulated DeepSeek page does not implement this evaluation");
    },
  } as unknown as Page;

  return {
    page,
    sent,
    reads,
    setToken(next) { token = next; },
  };
}

/** A page opener that hands the import check an already-built page. */
export function deepSeekPageOpener(
  page: Page,
): (storageState?: unknown) => Promise<{ page: Page; close: () => Promise<void> }> {
  return async () => ({ page, close: async () => {} });
}

/** A capture in the shape the doc lists: cookies plus this origin's local storage. */
export function deepSeekCapture(options: {
  readonly token?: string;
  readonly deviceId?: string;
  readonly cookie?: string;
  readonly cookieExpires?: number;
  readonly extraLocalStorage?: readonly { readonly name: string; readonly value: string }[];
} = {}): Record<string, unknown> {
  return {
    cookies: [{
      name: "waf_session",
      value: options.cookie ?? "synthetic-deepseek-cookie",
      domain: ".deepseek.com",
      path: "/",
      expires: options.cookieExpires ?? 1_893_456_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }],
    origins: [{
      origin: "https://chat.deepseek.com",
      localStorage: [
        {
          name: DEEPSEEK_WEB_TOKEN_STORAGE_KEY,
          value: JSON.stringify({ value: options.token ?? "synthetic-page-token", __version: "0" }),
        },
        { name: DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY, value: options.deviceId ?? DEEPSEEK_DEVICE_ID },
        ...(options.extraLocalStorage ?? []),
      ],
    }],
  };
}
