/**
 * The authenticated-session predicate for `chat.deepseek.com`.
 *
 * ## The one call that decides it
 *
 * `GET /api/v0/client/settings?did=<uuid>&scope=model` (`DEEPSEEK_WEB_SETTINGS_PATH`) answered
 * **HTTP 200** for a signed-in session *and* for an anonymous one on the signed-in capture
 * (`doc/deepseek-web.md` §6.1 rows 3 and 14, §7):
 *
 * ```text
 * signed in    {"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{…}}}
 * anonymous    {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"SETTINGS_NOT_FOUND"}}
 * no/expired   the token family (40002 / 40003 / "INVALID_TOKEN") at whichever layer carries it
 * ```
 *
 * So the HTTP status proves nothing and the top-level `code` proves nothing on its own: the answer is
 * the **business layer nested beside a success-shaped top level**. This module reads both layers once
 * through {@link deepSeekEnvelope} — the provider's single envelope owner — and requires **both** to be
 * zero before it says "authenticated". A 200 that carries a refusal is never read as success, and an
 * answer that carries no business layer at all is never read as success either.
 *
 * ## The credential is the page's, read at call time
 *
 * The web app's API calls carry `Authorization: Bearer <opaque token>` built from
 * `localStorage["userToken"]`, and the `x-client-*` / `x-device-*` / `x-hif-leim` family built from the
 * page's own locale, timezone, region and device identity (`page-identity.ts`). A cookie-only request
 * from a request context is therefore *not* how the page calls its own API, and the WAF in front of
 * `chat.deepseek.com` answers a real browser differently than a Node client. The predicate therefore:
 *
 * 1. reads the identity from the live page at call time ({@link readDeepSeekPageIdentity});
 * 2. issues the settings call from inside the same page, same-origin, through the provider-neutral
 *    `requestInPageContext` — cookies, `Origin`, `Referer` and `Sec-Fetch-*` are the page's own;
 * 3. classifies the answer into one honest verdict class.
 *
 * No token, cookie, device id or leim token is ever returned by a verdict, logged or put in a refusal.
 *
 * ## The `did` this predicate sends, and the one observation that could refine it
 *
 * The settings call is keyed by `did`. The pre-capture recon recorded `did=<device id>` (recon §2.5),
 * and §6.1 row 4 measured that the signed-in settings answer's `did` was **not** the completion's
 * `x-device-id` — the app keeps its own `__ds_remote_feature_did` for it. This predicate sends the
 * page's own device identity (the value the capture's required `deepseek-device-id:chat` entry holds),
 * because that is the identity this build can read without inventing a second storage key. If the
 * provider keys settings strictly by that other id, the answer is the provider's own settings refusal,
 * which this module reports as `settings-refused` — never as `authenticated`. One live import settles
 * whether the two ids matter; until then the verdict stays the provider's answer, not a guess.
 */
import type { Page } from "playwright-core";

import { requestInPageContext } from "../page-context-request";
import {
  DEEPSEEK_WEB_MAX_ANSWER_CHARS,
  DEEPSEEK_WEB_SETTINGS_PATH,
  DEEPSEEK_WEB_SETTINGS_SCOPE,
  deepSeekAccessVerificationAnswer,
  deepSeekApiHeaders,
  deepSeekEnvelope,
  deepSeekUrl,
} from "./provider";
import { DEEPSEEK_WEB_JSON_TIMEOUT_MS } from "./network-turn";
import {
  deepSeekAuthorizationHeader,
  deepSeekClientHeaders,
  readDeepSeekPageIdentity,
  type DeepSeekPageIdentity,
} from "./page-identity";

/** One assembled probe request. */
export interface DeepSeekProbeRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** What the page answered, plus the two facts the verdict needs to stay honest. */
export interface DeepSeekProbeAnswer {
  readonly status: number;
  /** The parsed JSON body, or the raw text when it was not JSON. */
  readonly payload: unknown;
  readonly contentType?: string;
  /** The (bounded) raw body text, so an HTML answer can be classified instead of thrown away. */
  readonly bodyText?: string;
  /** Whether the transport cut the body at its bound. */
  readonly truncated?: boolean;
}

/** One probe observation: the answer plus what the request itself carried (never the values). */
export interface DeepSeekProbeObservation extends DeepSeekProbeAnswer {
  /** Whether the page's own `Authorization` header accompanied the request (the value never leaves). */
  readonly sentAuthorization: boolean;
}

/** Sends one assembled request. Production binds this to the provider's page. */
export type DeepSeekProbeSender = (request: DeepSeekProbeRequest) => Promise<DeepSeekProbeAnswer>;

/**
 * The verdict classes: one per honest answer this predicate can give.
 *
 * - `authenticated` — both envelope layers said success (`code:0` **and** `data.biz_code:0`);
 * - `token-refused` — the provider's own token refusal (`40002`/`40003`, `INVALID_TOKEN`);
 * - `settings-refused` — the provider refused the settings call at either layer (e.g.
 *   `data.biz_code:1 SETTINGS_NOT_FOUND`), with its code preserved;
 * - `access-verification` — an AWS-WAF/challenge answer instead of the API: the operator's action, a
 *   different problem from a wrong session;
 * - `http-refused` — a non-2xx answer that carries no readable envelope (401/403 included);
 * - `unreadable` — a 2xx answer this build cannot read (an HTML document, an empty body, JSON without
 *   the measured business layer). Nothing was proved, so nothing is claimed.
 */
export type DeepSeekProbeVerdictClass =
  | "authenticated"
  | "token-refused"
  | "settings-refused"
  | "access-verification"
  | "http-refused"
  | "unreadable";

/** One typed verdict. Credential-free by construction. */
export interface DeepSeekProbeVerdict {
  readonly kind: DeepSeekProbeVerdictClass;
  /** `true` only for `kind: "authenticated"`. */
  readonly authenticated: boolean;
  /** The provider's own numeric code, from whichever envelope layer carried it. */
  readonly providerCode?: number;
  /** The provider's own short message (`msg`/`biz_msg`), only when it is a plain code-like token. */
  readonly providerMessage?: string;
  /** One non-secret sentence naming the operator's next action. Absent when authenticated. */
  readonly refusal?: string;
}

/** The `40002`/`40003` family the provider uses at either layer (recon §2.2). */
const TOKEN_REFUSAL_CODES = new Set([40002, 40003]);

/** The provider's own token message markers. */
const TOKEN_REFUSAL_MARKERS = /INVALID_TOKEN|Missing Token/i;

/** A provider message is quoted only when it is a plain code-like token: never a prose blob. */
const QUOTABLE_PROVIDER_MESSAGE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Whether a settings payload means "authenticated".
 *
 * Both measured layers must say success: the top level `code` **and** the nested `data.biz_code`. The
 * nested layer is the decisive one — a 200 with `code:0` and `data.biz_code:1` is exactly the
 * anonymous answer, and treating the top level alone as the answer is the bug this predicate avoids.
 */
export function deepSeekSettingsAuthenticated(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const envelope = deepSeekEnvelope({ status: 200, body: payload });
  return envelope.code === 0 && envelope.bizCode === 0;
}

/** The informative (non-zero) code an envelope carried, whichever layer held it. */
function informativeCode(envelope: ReturnType<typeof deepSeekEnvelope>): number | undefined {
  if (envelope.code !== undefined && envelope.code !== 0) return envelope.code;
  if (envelope.bizCode !== undefined && envelope.bizCode !== 0) return envelope.bizCode;
  return undefined;
}

/**
 * Whether the envelope is the provider's **token** refusal, and the code to preserve.
 *
 * The `40002`/`40003` family is decisive at either layer; the provider's own message markers are the
 * fallback, because a refusal nested deeper than `msg`/`biz_msg` still says the same thing. A
 * message-only match preserves the informative non-zero code when there is one, and reports no code
 * rather than a misleading `0` when there is not.
 */
function tokenRefusal(envelope: ReturnType<typeof deepSeekEnvelope>): { readonly code?: number } | undefined {
  if (envelope.code !== undefined && TOKEN_REFUSAL_CODES.has(envelope.code)) return { code: envelope.code };
  if (envelope.bizCode !== undefined && TOKEN_REFUSAL_CODES.has(envelope.bizCode)) return { code: envelope.bizCode };
  const byMessage = TOKEN_REFUSAL_MARKERS.test(envelope.msg ?? "")
    || TOKEN_REFUSAL_MARKERS.test(envelope.bizMsg ?? "");
  if (!byMessage) return undefined;
  const code = informativeCode(envelope);
  return code === undefined ? {} : { code };
}

/** The provider's own message, when it is safe and useful to quote. */
function quotableMessage(envelope: ReturnType<typeof deepSeekEnvelope>): string | undefined {
  for (const candidate of [envelope.bizMsg, envelope.msg]) {
    if (candidate !== undefined && QUOTABLE_PROVIDER_MESSAGE.test(candidate.trim())) return candidate.trim();
  }
  return undefined;
}

/**
 * The next action for a session that has to be captured again.
 *
 * Deliberately no absolute URL and no site path: the import pipeline reduces every provider sentence
 * through `nonSecretDiagnosticText`, which rewrites URLs to `[url]` and bounds the line at 300
 * characters. A sentence that survives that reduction unchanged is the one the operator actually gets
 * to read, in the CLI, in the control API's 4xx and in the session-health row alike.
 */
const CAPTURE_INSTRUCTION =
  "Sign in at chat.deepseek.com in the browser that holds the account, then re-import the capture "
  + "(auth import --provider deepseek-web).";

/** A readable "HTTP 200, content-type application/json" descriptor. */
function answerDescriptor(observation: DeepSeekProbeObservation): string {
  return `HTTP ${observation.status}`
    + (observation.contentType === undefined || observation.contentType.length === 0
      ? ""
      : `, content-type ${observation.contentType}`);
}

/** A readable " (code 40003, INVALID_TOKEN)" clause, from the verdict's own preserved facts. */
function codeClause(verdict: Pick<DeepSeekProbeVerdict, "providerCode" | "providerMessage">): string {
  const parts = [
    ...(verdict.providerCode === undefined ? [] : [`code ${verdict.providerCode}`]),
    ...(verdict.providerMessage === undefined ? [] : [verdict.providerMessage]),
  ];
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * The one non-secret refusal sentence for a verdict class.
 *
 * The wording separates the three problems an operator actually has to distinguish: a session that is
 * not signed in (capture it again), a challenge in front of the API (clear it in a browser), and an
 * answer this build cannot read (nothing was judged). A challenge is never dressed up as a wrong
 * password, and no credential is ever named. Every sentence is short enough to survive
 * `nonSecretDiagnosticText` unchanged (it bounds a line at 300 characters).
 */
function refusalFor(
  observation: DeepSeekProbeObservation,
  kind: Exclude<DeepSeekProbeVerdictClass, "authenticated">,
  facts: Pick<DeepSeekProbeVerdict, "providerCode" | "providerMessage">,
): string {
  const code = codeClause(facts);
  switch (kind) {
    case "token-refused":
      return observation.sentAuthorization
        ? `DeepSeek refused the session check: the capture's bearer is not accepted${code}. `
          + CAPTURE_INSTRUCTION
        : "DeepSeek refused the session check with a token error, but the page sent no bearer at all "
          + `(its userToken handle is empty)${code}. ${CAPTURE_INSTRUCTION}`;
    case "settings-refused":
      return `DeepSeek answered the settings call but its business layer refused it${code}, which is `
        + `not a signed-in answer. ${CAPTURE_INSTRUCTION}`;
    case "access-verification":
      return "DeepSeek answered the session check with an access-verification challenge instead of the "
        + "API. Open chat.deepseek.com in the browser that holds the signed-in session, clear the "
        + "challenge there, then re-capture and import again — this provider never retries past a "
        + "challenge itself.";
    case "http-refused":
      return `DeepSeek refused the session check before it reached the API `
        + `(${answerDescriptor(observation)})${code}, so the capture's cookies are not accepted by `
        + `its edge. ${CAPTURE_INSTRUCTION}`;
    case "unreadable":
      return `DeepSeek answered the session check with something this build cannot read `
        + `(${answerDescriptor(observation)}), so nothing was claimed about the session. `
        + CAPTURE_INSTRUCTION;
  }
}

/**
 * Decide the verdict from one observation.
 *
 * The order is the policy:
 *
 * 1. an access-verification answer is its own class (shared with the turn path's classifier);
 * 2. the provider's token family is `token-refused`, whichever layer and whichever HTTP status carried
 *    it — the provider's own code is preserved;
 * 3. a non-2xx answer with no readable envelope is `http-refused`;
 * 4. a 2xx answer that is not a JSON object, or that lacks the measured business layer, is `unreadable`;
 * 5. only `code:0` **and** `data.biz_code:0` is `authenticated`;
 * 6. any other non-zero code is `settings-refused`, with that code preserved.
 *
 * Nothing here can return `authenticated` for an answer that carries a refusal, and nothing here reads
 * a credential.
 */
export function deepSeekSettingsVerdict(observation: DeepSeekProbeObservation): DeepSeekProbeVerdict {
  const bodyText = observation.bodyText ?? "";
  if (deepSeekAccessVerificationAnswer({
    status: observation.status,
    body: observation.payload,
    ...(bodyText.length === 0 ? {} : { bodyText }),
  })) {
    return { kind: "access-verification", authenticated: false, refusal: refusalFor(observation, "access-verification", {}) };
  }

  const record = observation.payload !== null
    && typeof observation.payload === "object"
    && !Array.isArray(observation.payload)
    ? observation.payload
    : undefined;
  const envelope = deepSeekEnvelope({ status: observation.status, body: record });
  const providerMessage = quotableMessage(envelope);
  /** The facts a refusal may quote: the provider's informative code, never a success-shaped `0`. */
  const facts = {
    ...(informativeCode(envelope) === undefined ? {} : { providerCode: informativeCode(envelope)! }),
    ...(providerMessage === undefined ? {} : { providerMessage }),
  };

  const token = tokenRefusal(envelope);
  if (token !== undefined) {
    // The provider said which check failed; its code is preserved whether or not a layer also nested it.
    const codeFacts = {
      ...(token.code === undefined ? {} : { providerCode: token.code }),
      ...(providerMessage === undefined ? {} : { providerMessage }),
    };
    return {
      kind: "token-refused",
      authenticated: false,
      ...codeFacts,
      refusal: refusalFor(observation, "token-refused", codeFacts),
    };
  }

  if (observation.status < 200 || observation.status >= 400) {
    return { kind: "http-refused", authenticated: false, ...facts, refusal: refusalFor(observation, "http-refused", facts) };
  }

  if (record === undefined) {
    return { kind: "unreadable", authenticated: false, refusal: refusalFor(observation, "unreadable", {}) };
  }

  if (envelope.code === 0 && envelope.bizCode === 0) {
    return { kind: "authenticated", authenticated: true };
  }

  if (informativeCode(envelope) !== undefined) {
    return {
      kind: "settings-refused",
      authenticated: false,
      ...facts,
      refusal: refusalFor(observation, "settings-refused", facts),
    };
  }

  // `code:0` with no business layer is not the measured success shape: nothing is claimed.
  return { kind: "unreadable", authenticated: false, ...facts, refusal: refusalFor(observation, "unreadable", facts) };
}

/** The refusal sentence for one observation, for a caller that only wants the operator's line. */
export function deepSeekProbeRefusal(observation: DeepSeekProbeObservation): string {
  const verdict = deepSeekSettingsVerdict(observation);
  return verdict.refusal ?? "";
}

/**
 * Build the settings probe in the app's own shape.
 *
 * Everything except the URL query and the identity headers is the provider's recorded base header set
 * (`deepSeekApiHeaders`); the `Authorization` value and the client/device family come from the page, at
 * call time. The `did` is the page's device identity — see this module's header for what that choice
 * does and does not claim.
 */
export function deepSeekSettingsProbeRequest(identity: DeepSeekPageIdentity): DeepSeekProbeRequest {
  const query: Record<string, string> = { scope: DEEPSEEK_WEB_SETTINGS_SCOPE };
  if (identity.deviceId.length > 0) query["did"] = identity.deviceId;
  return {
    url: deepSeekUrl(DEEPSEEK_WEB_SETTINGS_PATH, query),
    headers: deepSeekApiHeaders({
      ...deepSeekClientHeaders(identity),
      ...deepSeekAuthorizationHeader(identity),
    }),
  };
}

/** The page-bound sender: the request is issued from the page's own browsing context. */
export function createDeepSeekPageProbeSender(page: Page): DeepSeekProbeSender {
  return async request => {
    const answer = await requestInPageContext(page, {
      url: request.url,
      headers: request.headers,
      timeoutMs: DEEPSEEK_WEB_JSON_TIMEOUT_MS,
      maxAnswerChars: DEEPSEEK_WEB_MAX_ANSWER_CHARS,
    });
    return {
      status: answer.status,
      payload: answer.payload ?? answer.text,
      contentType: answer.contentType,
      bodyText: answer.text,
      truncated: answer.truncated,
    };
  };
}

/**
 * Probe with an explicit identity read and a sender, so the request shape is testable without a browser.
 *
 * This is the production assembly split in two: the request builder above and the observation here.
 * A test drives both with a recording sender and asserts exactly what the page would have sent.
 */
export async function probeDeepSeekSettings(
  identity: DeepSeekPageIdentity,
  send: DeepSeekProbeSender,
): Promise<DeepSeekProbeObservation> {
  const request = deepSeekSettingsProbeRequest(identity);
  const answer = await send(request);
  return {
    status: answer.status,
    payload: answer.payload,
    ...(answer.contentType === undefined ? {} : { contentType: answer.contentType }),
    ...(answer.bodyText === undefined ? {} : { bodyText: answer.bodyText }),
    ...(answer.truncated === undefined ? {} : { truncated: answer.truncated }),
    sentAuthorization: identity.authorization !== undefined,
  };
}

/**
 * Probe from the live page: its identity is read now, and the request is issued from that same page.
 *
 * The token is read per call, not cached, because the page's token is the page's to rotate — the same
 * rule the turn facility applies (`network-turn.ts`).
 */
export async function probeDeepSeekSessionFromPage(page: Page): Promise<DeepSeekProbeObservation> {
  const identity = await readDeepSeekPageIdentity(page);
  return await probeDeepSeekSettings(identity, createDeepSeekPageProbeSender(page));
}
