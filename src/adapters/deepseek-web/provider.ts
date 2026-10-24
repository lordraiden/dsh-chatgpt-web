/**
 * DeepSeek Web (`chat.deepseek.com`) provider constants, envelope and wire vocabulary.
 *
 * ## Where every fact below comes from
 *
 * [`doc/provider-recon.md`](../../../doc/provider-recon.md) §2 is the pre-capture brief, and
 * [`doc/deepseek-web.md`](../../../doc/deepseek-web.md) §6 is the settled inventory. Nothing in this
 * module is invented: a path, a key and an event name are either **measured** over the wire, read from
 * the vendor's own shipped bundle, or measured on the signed-in capture the operator supplied. The one
 * list that stays a documented non-catalogue is `DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES`; the body's
 * `action`/`preempt` are now sent with their measured values and `source` is not sent because the
 * captured completion body does not carry it.
 *
 * ## The id is not new
 *
 * `deepseek-web` is already the deployment's DeepSeek capture id
 * (`src/auth-import.ts`, `DEEPSEEK_WEB_IMPORT_PROVIDER_ID`). Catalogue, driver and sign-in must not
 * have a second spelling (`doc/provider-onboarding.md` §1.3), so this adapter reuses that literal
 * rather than minting `deepseek-chat`.
 *
 * ## Two envelope layers, not one
 *
 * DeepSeek answers `{"code":<int>,"msg":"…","data":…}` and **also** nests a business status inside
 * `data` (`{"code":0,"data":{"biz_code":1,"biz_msg":"SETTINGS_NOT_FOUND"}}`, recon §2.2). A call
 * succeeded only when **both** layers say so, and an authentication refusal is the same
 * `40002`/`40003` family whichever layer carries it. {@link deepSeekEnvelope} reads both layers once
 * so no caller has to remember that.
 */
import { createHash } from "node:crypto";

import { isWebChatError, webChatError, type WebChatError } from "../../web-chat/core";

/**
 * The catalogue/driver/session provider id.
 *
 * Equal to the id `auth import --provider deepseek-web` already writes, so a stored capture and the
 * provider that would read it can never address two different directories.
 */
export const DEEPSEEK_WEB_PROVIDER_ID = "deepseek-web";

/** The catalogue route id. Equal to the provider id by definition (`<providerId>/<modelType>`). */
export const DEEPSEEK_WEB_ROUTE_ID = DEEPSEEK_WEB_PROVIDER_ID;

/** The driver id; the same value, named for the contract it satisfies. */
export const DEEPSEEK_WEB_DRIVER_ID = DEEPSEEK_WEB_PROVIDER_ID;

/** The operator-facing label, already used by the capture import. */
export const DEEPSEEK_WEB_PROVIDER_LABEL = "DeepSeek Web";

/** The web product's origin. Every request this adapter makes is same-origin with it. */
export const DEEPSEEK_WEB_ORIGIN = "https://chat.deepseek.com";

/** Where the session browser starts. Normal routes are behind an AWS WAF challenge (recon §2.1). */
export const DEEPSEEK_WEB_ROOT_URL = `${DEEPSEEK_WEB_ORIGIN}/`;

/** `POST /api/v0/chat/completion` streams one turn as named SSE events (recon §2.2, §2.4). */
export const DEEPSEEK_WEB_COMPLETION_PATH = "/api/v0/chat/completion";

/** `POST /api/v0/chat/create_pow_challenge` issues one proof-of-work challenge (recon §2.2, §2.6). */
export const DEEPSEEK_WEB_POW_CHALLENGE_PATH = "/api/v0/chat/create_pow_challenge";

/** `POST /api/v0/chat_session/create` is the recorded session-creating endpoint (recon §2.2). */
export const DEEPSEEK_WEB_SESSION_CREATE_PATH = "/api/v0/chat_session/create";

/**
 * `GET /api/v0/users/current` is the recorded "who am I" endpoint, and the anonymous answer is
 * `40002 Missing Token` (recon §2.2).
 *
 * Recorded here because it is the endpoint a future authenticated predicate must use; this slice
 * does **not** implement that predicate (see `doc/deepseek-web.md` §6), so nothing calls it yet.
 */
export const DEEPSEEK_WEB_USERS_CURRENT_PATH = "/api/v0/users/current";

/**
 * The bundle commit the recorded protocol was read from (`<meta name="commit-id">`, recon §2.1).
 *
 * DeepSeek pins a commit id rather than a semver. It is exported because a capture compared against
 * the wrong bundle is a real source of confusion. It is **not** the `x-client-bundle-id` value: the
 * page sends the app bundle identifier (`com.deepseek.chat`) there, which `page-identity.ts` derives
 * from the page's own region.
 */
export const DEEPSEEK_WEB_BUNDLE_COMMIT_ID = "6c40ca01";

/**
 * The deep-link prefill literal from the bundle — **not** a model catalogue.
 *
 * Recon §2.5 records `["default","expert","vision"]` as the set the deep-link parser accepts, while
 * the real `model_type` values arrive as a session-only remote setting (`model_configs`, scope
 * `model`). Presenting this list in `/v1/models` would be a fabricated catalogue, so it is exported
 * only so the code and the tests can name the thing this provider must never serve from.
 */
export const DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES = ["default", "expert", "vision"] as const;

/**
 * The completion body keys **measured** on the signed-in turn (one capture, two completions).
 *
 * The captured bodies carry exactly these nine keys, in this order — both a first turn
 * (`parent_message_id: null`) and a continuation. `action` is `null` and `preempt` is `false` on both,
 * and `source` — which the pre-capture recon listed as free-form — is **not** part of the completion
 * body at all. The capture is the evidence; `doc/deepseek-web.md` §3 records it.
 */
export const DEEPSEEK_WEB_RECORDED_BODY_KEYS = [
  "chat_session_id",
  "parent_message_id",
  "model_type",
  "prompt",
  "ref_file_ids",
  "thinking_enabled",
  "search_enabled",
  "action",
  "preempt",
] as const;

/**
 * The recorded body keys this build does **not** send.
 *
 * Empty: every recorded key now has a measured value. In particular `source` is not reported here any
 * more, because the capture shows the completion body does not carry it — the pre-capture brief
 * listed a key the app does not send.
 */
export const DEEPSEEK_WEB_UNSENT_BODY_KEYS = [] as const;

/** The named SSE events the bundle's own `onServerEvent` switch handles (recon §2.4). */
export const DEEPSEEK_WEB_SSE_EVENTS = [
  "delta",
  "ready",
  "close",
  "finish",
  "title",
  "toast",
  "update_session",
  "hint",
  "update_parent_message",
  "update_file",
] as const;

/** One recorded SSE event name. */
export type DeepSeekSseEventName = (typeof DEEPSEEK_WEB_SSE_EVENTS)[number];

/** The three JSON-patch operations the bundle's delta schema permits (recon §2.4). */
export const DEEPSEEK_WEB_PATCH_OPERATIONS = ["SET", "BATCH", "APPEND"] as const;

/** One permitted patch operation. */
export type DeepSeekPatchOperation = (typeof DEEPSEEK_WEB_PATCH_OPERATIONS)[number];

/** The only fragment `type` whose content this adapter treats as the assistant's answer (measured). */
export const DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE = "RESPONSE";

/**
 * The fragment `type` that carries the model's reasoning (measured: the paired `THINK` frame).
 *
 * Its content is **excluded** from the answer and counted, never returned — the same rule the other
 * providers apply to a reasoning phase.
 */
export const DEEPSEEK_WEB_REASONING_FRAGMENT_TYPE = "THINK";

/**
 * The measured location of the id in a `chat_session/create` answer.
 *
 * The signed-in create answer is `{code:0, msg:"", data:{biz_code:0, biz_msg:"", biz_data:{chat_session:
 * {id, title, title_type, model_type, pinned, updated_at, seq_id, agent, version, is_empty,
 * current_message_id, inserted_at}, ttl_seconds}}}`; the id is `data.biz_data.chat_session.id`. The list
 * stays a list (one measured path) because {@link readDeepSeekCreatedSessionId} names every path it
 * tried in its refusal, so a future shape change is a readable failure instead of an empty id.
 */
export const DEEPSEEK_WEB_SESSION_ID_PATHS = [
  ["data", "biz_data", "chat_session", "id"],
] as const;

/** How long one sign-in/session navigation may take. */
export const DEEPSEEK_WEB_NAVIGATION_TIMEOUT_MS = 60_000;

/** The frame geometry the session browser is launched with; reported truthfully by `view()`. */
export const DEEPSEEK_WEB_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * How much of a JSON answer this adapter reads before it stops.
 *
 * These endpoints answer small objects; the bound is a transport fact, so a cut body is reported as
 * truncated instead of being read as a refusal.
 */
export const DEEPSEEK_WEB_MAX_ANSWER_CHARS = 20_000;

/** Whether a value is one of the recorded patch operations. */
export function isDeepSeekPatchOperation(value: unknown): value is DeepSeekPatchOperation {
  return typeof value === "string" && (DEEPSEEK_WEB_PATCH_OPERATIONS as readonly string[]).includes(value);
}

/** A numeric field that may arrive as a JSON number or a numeric string. */
function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A string field, or `undefined` when the provider did not send one. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The two envelope layers of one DeepSeek answer, read once. */
export interface DeepSeekEnvelope {
  /** The HTTP status that carried the answer. */
  readonly status: number;
  /** The top-level `code`, when it was a number (or a numeric string). */
  readonly code?: number;
  /** The top-level `msg`. */
  readonly msg?: string;
  /** `data.biz_code`, when the answer nested one. */
  readonly bizCode?: number;
  /** `data.biz_msg`. */
  readonly bizMsg?: string;
  /** What the provider said the business payload was, for a caller's own reading. */
  readonly bizData?: unknown;
  /** Whether **both** layers report success (`code === 0`, and no non-zero `biz_code`). */
  readonly accepted: boolean;
}

/**
 * Read both envelope layers of one DeepSeek answer.
 *
 * A non-object body (an HTML WAF page) has no envelope, so `accepted` is `false`: a body this build
 * cannot read is never treated as success. `data.biz_code` is read the same way whether the business
 * payload sits at `data.biz_data` or directly on `data` — both were recorded, and neither is an
 * authentication decision on its own.
 */
export function deepSeekEnvelope(input: {
  readonly status: number;
  readonly body: unknown;
}): DeepSeekEnvelope {
  const record = (input.body && typeof input.body === "object" && !Array.isArray(input.body)
    ? input.body
    : undefined) as Record<string, unknown> | undefined;
  const code = numeric(record?.["code"]);
  const msg = text(record?.["msg"]);
  const data = record?.["data"];
  const dataRecord = (data && typeof data === "object" && !Array.isArray(data)
    ? data
    : undefined) as Record<string, unknown> | undefined;
  const bizCode = numeric(dataRecord?.["biz_code"]);
  const bizMsg = text(dataRecord?.["biz_msg"]);
  const accepted = record !== undefined
    && code === 0
    && (bizCode === undefined || bizCode === 0);
  return {
    status: input.status,
    ...(code === undefined ? {} : { code }),
    ...(msg === undefined ? {} : { msg }),
    ...(bizCode === undefined ? {} : { bizCode }),
    ...(bizMsg === undefined ? {} : { bizMsg }),
    ...(dataRecord?.["biz_data"] === undefined ? {} : { bizData: dataRecord["biz_data"] }),
    accepted,
  };
}

/** The first non-empty string, so an empty top-level `msg` cannot hide a nested `biz_msg`. */
function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

/** The authentication codes the provider uses at either layer (recon §2.2). */
const AUTH_REFUSAL_CODES = new Set([40002, 40003]);

/** The proof-of-work refusal codes the bundle shows to the user (recon §2.6). */
const POW_REFUSAL_MARKERS = /POW_HEADER_ERROR|INVALID_POW_RESPONSE/i;

/** The WAF / challenge markers an answer can carry instead of an envelope (recon §2.6). */
const WAF_MARKERS = /x-amzn-waf-action|awsChallenge|awsCaptcha|captcha|challenge-container|_____tmd_____/i;

/** A chat/session the provider no longer holds, as far as its own words go. */
const SESSION_LOST_MARKERS = /SESSION_NOT_FOUND|session[^a-z]{0,4}not[^a-z]{0,4}found|chat_session[^a-z]{0,6}not/i;

/** What a refused DeepSeek call was attempting, for the message the operator reads. */
export type DeepSeekRefusedOperation = "create-a-session" | "stream-a-completion" | "read-a-challenge";

/** Options for {@link deepSeekRefusal}. */
export interface DeepSeekRefusalInput {
  readonly status: number;
  readonly contentType?: string;
  /** The parsed body when the answer was JSON. */
  readonly body?: unknown;
  /** The raw body when it was not. */
  readonly bodyText?: string;
  readonly what: DeepSeekRefusedOperation;
  /** Whether a conversation's recorded session was the target (a refusal then means "lost"). */
  readonly continuedSession: boolean;
}

/**
 * Classify a refused DeepSeek call into a shared category, from the provider's own answer.
 *
 * DeepSeek answers its refusals with **HTTP 200** and a non-zero `code` (recon §2.2), so the status is
 * never the decision: the envelope is. The order below matters —
 *
 * 1. a WAF/challenge page is access verification (the operator's action, never a retry);
 * 2. a `40002`/`40003` at **either** layer is an authentication refusal, whatever the HTTP status;
 * 3. a proof-of-work refusal is the provider rejecting the one step this build cannot produce;
 * 4. a recorded session that the provider no longer has is a lost conversation (never a silent fork);
 * 5. anything else is an upstream failure, with the provider's own codes kept for diagnosis.
 *
 * No branch retries, and no branch claims a credential was rejected without the provider saying so.
 */
export function deepSeekRefusal(input: DeepSeekRefusalInput): WebChatError {
  const parsed = input.body === undefined && typeof input.bodyText === "string"
    ? (() => {
      try {
        return JSON.parse(input.bodyText) as unknown;
      } catch {
        return undefined;
      }
    })()
    : input.body;
  const envelope = deepSeekEnvelope({ status: input.status, body: parsed });
  const rawText = input.bodyText ?? "";
  const providerCodeOf = (code: number | undefined): string =>
    code === undefined ? "DEEPSEEK_UPSTREAM_REFUSED" : `DEEPSEEK_CODE_${code}`;

  // The WAF branch is narrow on purpose: a marker, or the recorded challenge status carrying HTML. An
  // arbitrary HTML error page (a proxy, a 502) must stay an upstream failure instead of telling the
  // operator to clear a challenge that does not exist.
  const wafChallenge = WAF_MARKERS.test(rawText)
    || (envelope.code === undefined
      && (input.status === 202 || input.status === 405 || input.status === 403)
      && /<html|<!doctype/i.test(rawText));
  if (wafChallenge) {
    return webChatError(
      "AUTH_REQUIRED",
      "DeepSeek answered with an access-verification challenge instead of the API. Open "
      + "https://chat.deepseek.com in the browser that holds the signed-in session, clear the "
      + "challenge there, then re-capture the session and retry — this provider never retries past a "
      + "challenge itself.",
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_ACCESS_VERIFICATION" },
    );
  }

  const authAtEitherLayer = (envelope.code !== undefined && AUTH_REFUSAL_CODES.has(envelope.code))
    || (envelope.bizCode !== undefined && AUTH_REFUSAL_CODES.has(envelope.bizCode))
    || /INVALID_TOKEN|Missing Token/i.test(envelope.msg ?? "")
    || /INVALID_TOKEN|Missing Token/i.test(envelope.bizMsg ?? "");
  if (authAtEitherLayer) {
    const layer = envelope.code !== undefined && AUTH_REFUSAL_CODES.has(envelope.code)
      ? `code ${envelope.code}`
      : `data.biz_code ${envelope.bizCode ?? "?"}`;
    const said = envelope.msg ?? envelope.bizMsg;
    return webChatError(
      "AUTH_REQUIRED",
      `DeepSeek refused to ${input.what}: the stored session is not accepted (${layer}`
      + `${said === undefined ? "" : `, ${said}`}). Capture a fresh signed-in session at `
      + "https://chat.deepseek.com and import it with `auth import --provider deepseek-web`.",
      {
        providerId: DEEPSEEK_WEB_PROVIDER_ID,
        providerCode: layer.includes("biz_code") ? "DEEPSEEK_BIZ_INVALID_TOKEN" : "DEEPSEEK_INVALID_TOKEN",
      },
    );
  }

  const powMarker = POW_REFUSAL_MARKERS.test(envelope.msg ?? "") || POW_REFUSAL_MARKERS.test(envelope.bizMsg ?? "");
  if (powMarker) {
    return webChatError(
      "UPSTREAM_ERROR",
      `DeepSeek rejected the proof of work this turn's page produced for ${input.what} `
      + "(`POW_HEADER_ERROR` / `INVALID_POW_RESPONSE`). A proof is valid for one completion and is never "
      + "replayed, so this is a typed refusal: fetch a fresh challenge (a new attempt), never resend the "
      + "same proof.",
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_POW_REJECTED" },
    );
  }

  if (input.continuedSession
    && (input.status === 404
      || SESSION_LOST_MARKERS.test(rawText)
      || SESSION_LOST_MARKERS.test(envelope.msg ?? "")
      || SESSION_LOST_MARKERS.test(envelope.bizMsg ?? ""))) {
    return webChatError(
      "CONVERSATION_LOST",
      `DeepSeek no longer holds the chat session this conversation was continuing (HTTP ${input.status}), `
      + "so it was not reused; a new session requires an explicit replay",
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_SESSION_LOST" },
    );
  }

  if (input.status === 401 || input.status === 403) {
    return webChatError(
      "AUTH_REQUIRED",
      `DeepSeek refused to ${input.what} (HTTP ${input.status}); the stored session is no longer accepted. `
      + "Capture a fresh signed-in session and import it with `auth import --provider deepseek-web`.",
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_SESSION_UNAUTHORIZED" },
    );
  }

  // The informative code is the non-zero one: a success-shaped `code:0` must not hide the business
  // status nested beside it (recon §2.2).
  const code = envelope.code !== undefined && envelope.code !== 0 ? envelope.code : envelope.bizCode;
  const said = firstNonEmpty(envelope.msg, envelope.bizMsg);
  return webChatError(
    "UPSTREAM_ERROR",
    `DeepSeek refused to ${input.what} (HTTP ${input.status}, ${input.contentType || "no content type"}`
    + `${code === undefined ? "" : `, code ${code}`}${said === undefined ? "" : `, ${said}`})`,
    {
      providerId: DEEPSEEK_WEB_PROVIDER_ID,
      providerCode: providerCodeOf(code),
      ...(envelope.bizData === undefined ? {} : { providerDetail: { bizData: envelope.bizData } }),
    },
  );
}

/** Wrap a non-WebChat failure in this provider's transport category, without leaking a page error. */
export function deepSeekTransportFailure(error: unknown, what: string, diagnostic: string): WebChatError {
  if (isWebChatError(error)) return error;
  return webChatError(
    "TRANSPORT_UNAVAILABLE",
    `DeepSeek could not ${what}: ${diagnostic}`,
    { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_TURN_TRANSPORT", cause: error },
  );
}

/** Build an absolute DeepSeek URL from a path. Pure, so a request URL is assertable without a page. */
export function deepSeekUrl(path: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(path, DEEPSEEK_WEB_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * The non-secret headers every DeepSeek API request carries.
 *
 * The capture shows the app sends the wildcard `accept` media range and `content-type:
 * application/json` on the JSON calls
 * *and* on the completion stream, so those two are the recorded base. `Authorization`, the proof of
 * work and the `x-client-*` / `x-device-*` family are **not** part of this set: the first two are
 * credentials/proofs and the rest are the page's own identity, all supplied by
 * `network-turn.ts`/`page-identity.ts` at call time. This function stays pure and secret-free.
 */
export function deepSeekApiHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    accept: "*/*",
    "content-type": "application/json",
    ...extra,
  };
}

/**
 * Build the one-turn completion body from the keys whose value the recon settles.
 *
 * ```js
 * // recon §2.3 (bundle: the completion branch of i.http({json: …}))
 * { chat_session_id, parent_message_id, model_type, prompt, ref_file_ids,
 *   thinking_enabled, search_enabled, source, action, preempt }
 * ```
 *
 * `parent_message_id` is `null` for a session's first turn, exactly as the bundle writes it
 * (`cH.o(parentMessageId) ? null : parentMessageId`). `ref_file_ids` is the recorded empty list for a
 * text turn: this bridge is text-only, so it never carries a file id.
 *
 * `action: null` and `preempt: false` are the measured values on both captured completions; they are
 * sent because the capture shows them (the pre-capture brief had no value for them).
 */
export function deepSeekCompletionRequest(input: {
  readonly chatSessionId: string;
  /** The cursor the session's previous answer ended on; omitted/`null` for a first turn. */
  readonly parentMessageId?: string;
  readonly modelType: string;
  readonly prompt: string;
  /** `thinking_enabled`: the recorded plain boolean toggle (recon §2.5). */
  readonly thinkingEnabled: boolean;
  /** `search_enabled`: the recorded plain boolean toggle (recon §2.5). */
  readonly searchEnabled: boolean;
}): Record<string, unknown> {
  if (input.chatSessionId.length === 0) {
    throw new TypeError("A DeepSeek completion requires a chat session id");
  }
  if (input.modelType.length === 0) {
    throw new TypeError("A DeepSeek completion requires a model type");
  }
  return {
    chat_session_id: input.chatSessionId,
    parent_message_id: input.parentMessageId !== undefined && input.parentMessageId.length > 0
      ? input.parentMessageId
      : null,
    model_type: input.modelType,
    prompt: input.prompt,
    ref_file_ids: [],
    thinking_enabled: input.thinkingEnabled,
    search_enabled: input.searchEnabled,
    action: null,
    preempt: false,
  };
}

/**
 * The `chat_session/create` body.
 *
 * The signed-in capture measured this exact body: `{}`. The success shape is measured too
 * (`data.biz_data.chat_session.id`), so {@link readDeepSeekCreatedSessionId} now reads the recorded
 * path rather than a provisional one; its typed failure stays for an answer that stops carrying it.
 */
export function deepSeekSessionCreateRequest(): Record<string, unknown> {
  return {};
}

/** Read one value at a documented candidate path. */
function valueAtPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Read the session id a `chat_session/create` answer carries.
 *
 * **Unproven shape, refused rather than guessed.** The answer must first pass the two-layer envelope,
 * then one of {@link DEEPSEEK_WEB_SESSION_ID_PATHS} must hold a non-empty string. When none does, the
 * turn fails with a typed error that names the paths, so the first signed-in capture turns this list
 * into the recorded one instead of the build silently continuing with an empty id.
 */
export function readDeepSeekCreatedSessionId(input: {
  readonly status: number;
  readonly body: unknown;
  readonly bodyText?: string;
  readonly contentType?: string;
}): string {
  const envelope = deepSeekEnvelope({ status: input.status, body: input.body });
  if (!envelope.accepted) {
    throw deepSeekRefusal({
      status: input.status,
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.bodyText === undefined ? {} : { bodyText: input.bodyText }),
      what: "create-a-session",
      continuedSession: false,
    });
  }
  for (const path of DEEPSEEK_WEB_SESSION_ID_PATHS) {
    const candidate = valueAtPath(input.body, path);
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw webChatError(
    "UPSTREAM_ERROR",
    "DeepSeek created a chat session but this build could not read its id from the answer: the "
    + `success shape of ${DEEPSEEK_WEB_SESSION_CREATE_PATH} is unproven and this build looks in `
    + `${DEEPSEEK_WEB_SESSION_ID_PATHS.map(path => path.join(".")).join(", ")}. One signed-in capture `
    + "of the create call replaces that list.",
    { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_SESSION_CREATE_UNREADABLE" },
  );
}

/** The challenge a `create_pow_challenge` answer issued, with the raw object kept for the solver. */
export interface DeepSeekProofChallenge {
  /** The whole recorded challenge object, including fields this build does not name. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** `challenge` (recon §2.6). */
  readonly challenge?: string;
  /** `difficulty`. */
  readonly difficulty?: number;
  /** `salt`, when the challenge carries one. */
  readonly salt?: string;
  /** `signature`, when the challenge carries one. */
  readonly signature?: string;
  /** `expire_at` (epoch seconds at the provider's own resolution). */
  readonly expireAt?: number;
  /** `expire_after` (seconds). */
  readonly expireAfter?: number;
}

/**
 * Read the proof-of-work challenge from a `create_pow_challenge` answer.
 *
 * The recorded location is `data.biz_data.challenge` (recon §2.6), and the recorded shape is
 * `{challenge, difficulty, salt?, signature?, expire_at, expire_after}`. The raw object is handed to
 * the solver untouched, so a field this build did not name is still available to it.
 */
export function readDeepSeekProofChallenge(input: { readonly status: number; readonly body: unknown }): DeepSeekProofChallenge {
  const envelope = deepSeekEnvelope({ status: input.status, body: input.body });
  if (!envelope.accepted) {
    throw deepSeekRefusal({
      status: input.status,
      ...(input.body === undefined ? {} : { body: input.body }),
      what: "read-a-challenge",
      continuedSession: false,
    });
  }
  const raw = valueAtPath(input.body, ["data", "biz_data", "challenge"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw webChatError(
      "UPSTREAM_ERROR",
      "DeepSeek issued a proof-of-work challenge this build could not read: the recorded location is "
      + "`data.biz_data.challenge` (recon §2.6) and the answer did not carry an object there.",
      { providerId: DEEPSEEK_WEB_PROVIDER_ID, providerCode: "DEEPSEEK_POW_CHALLENGE_INVALID" },
    );
  }
  const record = raw as Record<string, unknown>;
  return {
    raw: record,
    ...(text(record["challenge"]) === undefined ? {} : { challenge: text(record["challenge"]) }),
    ...(numeric(record["difficulty"]) === undefined ? {} : { difficulty: numeric(record["difficulty"]) }),
    ...(text(record["salt"]) === undefined ? {} : { salt: text(record["salt"]) }),
    ...(text(record["signature"]) === undefined ? {} : { signature: text(record["signature"]) }),
    ...(numeric(record["expire_at"]) === undefined ? {} : { expireAt: numeric(record["expire_at"]) }),
    ...(numeric(record["expire_after"]) === undefined ? {} : { expireAfter: numeric(record["expire_after"]) }),
  };
}

/** A short, stable digest of a session id: enough to correlate two log lines, useless as a lookup key. */
export function deepSeekSessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}
