/**
 * Qwen Chat (`chat.qwen.ai`) provider constants, modes and wire vocabulary.
 *
 * ## Why this is a second provider and not an option on `qwen-code`
 *
 * `chat.qwen.ai` is a different product from `coder.qwen.ai`: a different API family
 * (`/api/v2/chat/completions`, `/api/v2/chats/new` instead of `/coder/api/v2/task/*`), a different
 * turn body, a different stream frame set and a different client version
 * ([`doc/provider-recon.md`](../../../doc/provider-recon.md) §0, §3.1). The two share the vendor's
 * auth host and conventions, not a request shape.
 *
 * Every path, header name and key below is **measured** or read from the vendor's own shipped bundle
 * (recon §1.2–§1.8); none is invented. The single exception is called out where it occurs
 * (`QWEN_CHAT_SUB_CHAT_TYPE`), and it exists as a named constant precisely so it can be corrected in
 * one place when a signed-in capture settles it.
 */

/**
 * The catalogue/driver/auth provider id.
 *
 * One id serves all three roles (catalogue route, driver, sign-in) — the rule
 * `doc/provider-onboarding.md` §1.3 states for the sign-in surface, so the operator page can never
 * list a provider the catalogue does not have.
 */
export const QWEN_CHAT_PROVIDER_ID = "qwen-chat";

/** The catalogue route id. Equal to the provider id by definition (`<providerId>/<modelId>`). */
export const QWEN_CHAT_ROUTE_ID = QWEN_CHAT_PROVIDER_ID;

/** The driver id; the same value, named for the contract it satisfies. */
export const QWEN_CHAT_DRIVER_ID = QWEN_CHAT_PROVIDER_ID;

/** The operator-facing label for this provider on the sign-in page. */
export const QWEN_CHAT_AUTH_PROVIDER_LABEL = "Qwen Chat";

/** The web product's origin. Every request the adapter makes is same-origin with it. */
export const QWEN_CHAT_ORIGIN = "https://chat.qwen.ai";

/** Where the sign-in browser starts. The app shell is public; its write API is anti-bot gated. */
export const QWEN_CHAT_ROOT_URL = `${QWEN_CHAT_ORIGIN}/`;

/** `POST /api/v2/chats/new` creates a chat and answers `{ success, request_id, data: { id } }`. */
export const QWEN_CHAT_CHATS_NEW_PATH = "/api/v2/chats/new";

/** `POST /api/v2/chat/completions?chat_id=<id>` streams the turn (`text/event-stream`). */
export const QWEN_CHAT_COMPLETIONS_PATH = "/api/v2/chat/completions";

/** `GET /api/v2/chats` is the simplest endpoint that refuses an anonymous caller. */
export const QWEN_CHAT_CHATS_PATH = "/api/v2/chats";

/** The public model list. **Read-only and unauthenticated** (recon §1.2, §1.6). */
export const QWEN_CHAT_MODELS_PATH = "/api/v2/models";

/** The v1 envelope of the same list, used as a fallback when the v2 path changes. */
export const QWEN_CHAT_MODELS_V1_PATH = "/api/models";

/**
 * The client version the app sends as the `Version` header.
 *
 * Recon §1.1 pins it three ways (CDN path segment, the interceptor's literal and the Sentry release):
 * **0.3.20** for the front end, while the backend reports `0.4.4` on `/api/config`. The header the API
 * checks is the front-end one.
 */
export const QWEN_CHAT_CLIENT_VERSION = "0.3.20";

/** The completion body's `version`; the recorded sender defaults it to `"2.1"` (recon §1.3). */
export const QWEN_CHAT_COMPLETION_VERSION = "2.1";

/** `chat_mode` is the **unrelated** product axis (`normal` | `share`), never the thinking mode. */
export const QWEN_CHAT_CHAT_MODE = "normal";

/**
 * The plain-text `chat_type` the app uses for a text turn.
 *
 * Recon §1.9 lists this as an **unknown**: `t2t` is observed in the bundle's `chat_type` enum but was
 * not proven on the wire for a text-only turn. It is therefore a named constant and the one place a
 * signed-in capture would correct it.
 */
export const QWEN_CHAT_CHAT_TYPE = "t2t";

/**
 * The message-level `sub_chat_type` for a plain text turn.
 *
 * **Assumption, stated plainly** (recon §1.9): the app sends a `sub_chat_type` per message, but the
 * value for a plain text turn was not recorded. `t2t` is the value the same enum uses for
 * text-to-text, so it is the most defensible shape available; this constant is the single correction
 * point if a capture shows another value.
 */
export const QWEN_CHAT_SUB_CHAT_TYPE = "t2t";

/**
 * The `source` header.
 *
 * Recon §1.8 records the app using `h5 | web | desktop` and §1.9 lists "is `web` accepted?" as an
 * unknown. `web` is the value the sibling Qwen Code capture showed this vendor's web client sending,
 * so it is the documented choice — not a claim that only this value works.
 */
export const QWEN_CHAT_SOURCE = "web";

/** `feature_config.output_schema:"phase"` is what makes `delta.phase` meaningful (recon §1.5). */
export const QWEN_CHAT_OUTPUT_SCHEMA = "phase";

/** The frame geometry the sign-in browser is launched with; reported truthfully by `view()`. */
export const QWEN_CHAT_AUTH_VIEWPORT = { width: 1280, height: 800 } as const;

/** How long the controller polls the authenticated API before reporting `failed`. */
export const QWEN_CHAT_AUTH_POLL_TIMEOUT_MS = 8 * 60_000;

/** How often the authenticated endpoint is polled while the operator works. Never a busy loop. */
export const QWEN_CHAT_AUTH_POLL_INTERVAL_MS = 1_500;

/** How long one navigation (the initial one and any operator `navigate`) may take. */
export const QWEN_CHAT_AUTH_NAVIGATION_TIMEOUT_MS = 60_000;

/** How long one authenticated-session probe may take before it counts as "not yet". */
export const QWEN_CHAT_AUTH_PROBE_TIMEOUT_MS = 15_000;

/**
 * How much of one `/api/v2/chats` answer the probe reads before it stops.
 *
 * The same account-sized-answer reasoning as `QWEN_CODE_TASK_LIST_MAX_ANSWER_CHARS`: the endpoint
 * returns the account's chat list, and the authenticated predicate reads only the envelope, so a cut
 * body must not be mistaken for a refusal.
 */
export const QWEN_CHAT_CHATS_MAX_ANSWER_CHARS = 65_536;

/** How long the import probe waits for the app to restore its own session (same boot shape). */
export const QWEN_CHAT_SESSION_HYDRATION_TIMEOUT_MS = 20_000;

/** How often the hydration wait re-reads the page's own token state. */
export const QWEN_CHAT_SESSION_HYDRATION_POLL_INTERVAL_MS = 250;

/**
 * The localStorage token key — **the same key** the Qwen Code app uses.
 *
 * Recon §1.8 measured `localStorage["qwen_access_token_state"]` on `chat.qwen.ai` (plus the legacy
 * bare `token`), and the sibling adapter already reads that shape. The key is re-exported from the
 * Qwen Code provider rather than copied, so the two adapters cannot drift about a value the vendor
 * actually shares.
 */
export {
  QWEN_CODE_ACCESS_TOKEN_STORAGE_KEY as QWEN_CHAT_ACCESS_TOKEN_STORAGE_KEY,
  QWEN_CODE_LEGACY_ACCESS_TOKEN_STORAGE_KEY as QWEN_CHAT_LEGACY_ACCESS_TOKEN_STORAGE_KEY,
} from "../qwen-code/provider";

/**
 * The three modes the operator sees (`Auto`, `Thinking`, `Fast`).
 *
 * They are **client labels resolved per model** and then written as two booleans plus the literal
 * label (recon §1.5). They are unrelated to `chat_mode`.
 */
export const QWEN_CHAT_MODES = ["Auto", "Thinking", "Fast"] as const;

/** One selectable Qwen Chat mode. */
export type QwenChatMode = (typeof QWEN_CHAT_MODES)[number];

/** The numeric `abilities.thinking` enum read from the bundle (`ff`), plus the booleans the API uses. */
export type QwenThinkingAbility = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Normalize the model's `abilities.thinking` field.
 *
 * The bundle compares the field to numeric enum values (`4===o`), while the public model list renders
 * it as a boolean in the recon table. Accepting both is deliberate: the list is a **hint**, and a
 * shape difference between the v1 and v2 envelopes must not silently change which modes are offered.
 */
export function qwenChatThinkingAbility(value: unknown): QwenThinkingAbility | undefined {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5) {
    return value as QwenThinkingAbility;
  }
  return undefined;
}

/** The per-model abilities the mode mapping needs (recon §1.5, `mv`). */
export interface QwenChatModelAbilities {
  /** `info.meta.abilities.thinking`. */
  readonly thinking?: unknown;
  /** `info.meta.auto_thinking`. */
  readonly autoThinking?: unknown;
}

/**
 * The modes one model offers, mirroring the bundle's `mv(e)` exactly.
 *
 * This is a **port of the vendor's own rule**, not a guess:
 *
 * ```js
 * if (!e) return ["Thinking","Fast"];
 * const r = !!e.info?.meta?.auto_thinking;
 * const o = e.info?.meta?.abilities?.thinking;
 * if (r) return 4===o ? ["Auto","Thinking"] : ["Auto","Thinking","Fast"];
 * switch (o) { case 1: case 3: default: return ["Thinking","Fast"];
 *              case 2: return []; case 4: return ["Thinking"] }
 * ```
 *
 * An unknown ability follows the recorded `default`/`no model` branch (`Thinking`, `Fast`) instead of
 * offering `Auto` on a guess — the list is a hint, and inventing a capability is worse than omitting
 * one the model may have.
 */
export function qwenChatModesForModel(abilities: QwenChatModelAbilities): readonly QwenChatMode[] {
  const thinking = qwenChatThinkingAbility(abilities.thinking);
  if (abilities.autoThinking === true) {
    return thinking === 4 ? ["Auto", "Thinking"] : ["Auto", "Thinking", "Fast"];
  }
  switch (thinking) {
    case 2:
      // Hidden: the product offers no mode for this model at all.
      return [];
    case 4:
      return ["Thinking"];
    case 1:
    case 3:
    default:
      return ["Thinking", "Fast"];
  }
}

/**
 * The mode a model starts in, mirroring the bundle's `gv(e)`.
 *
 * `undefined` means "this model offers no selectable mode" (the hidden `thinking: 2` case), which the
 * catalogue publishes as `default_reasoning_level: null` and the driver refuses as a selection.
 */
export function qwenChatDefaultMode(abilities: QwenChatModelAbilities): QwenChatMode | undefined {
  if (abilities.autoThinking === true) return "Auto";
  switch (qwenChatThinkingAbility(abilities.thinking)) {
    case 2:
      return undefined;
    case 3:
    case 4:
      return "Thinking";
    case 1:
    default:
      return "Fast";
  }
}

/** Whether a value is one of the three modes this provider sends. */
export function isQwenChatMode(value: unknown): value is QwenChatMode {
  return typeof value === "string" && (QWEN_CHAT_MODES as readonly string[]).includes(value);
}

/**
 * The per-message `feature_config` for one mode (recon §1.5, the bundle's builder).
 *
 * The label travels **verbatim** in `thinking_mode`; the two booleans are derived from it exactly as
 * the app derives them (`thinking_enabled` for Thinking|Auto, `auto_thinking` for Auto only).
 * `thinking_format` is only written when thinking is on — the app mutates it onto the object at that
 * point, and a model whose meta does not publish it must not get an invented one.
 */
export function qwenChatFeatureConfig(input: {
  readonly mode: QwenChatMode;
  readonly thinkingFormat?: string;
}): Record<string, unknown> {
  const thinkingEnabled = input.mode === "Thinking" || input.mode === "Auto";
  return {
    thinking_enabled: thinkingEnabled,
    auto_thinking: input.mode === "Auto",
    thinking_mode: input.mode,
    ...(thinkingEnabled && input.thinkingFormat !== undefined
      ? { thinking_format: input.thinkingFormat }
      : {}),
    output_schema: QWEN_CHAT_OUTPUT_SCHEMA,
  };
}

/**
 * The non-secret headers every Qwen Chat API request carries (recon §1.8).
 *
 * `Authorization` is **not** part of this set: it is read from the live page at call time, so a
 * credential can never be baked into a constant. `x-request-id` is per call and supplied by the
 * caller. The request facility adds `x-accel-buffering: no` for the streaming call only.
 */
export function qwenChatApiHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    // The app spells this header with a capital `V`; header names are case-insensitive, and matching
    // the recorded spelling keeps a packet capture easy to compare with the bundle.
    Version: QWEN_CHAT_CLIENT_VERSION,
    source: QWEN_CHAT_SOURCE,
    ...extra,
  };
}

/** Build an absolute Qwen Chat URL from a path. Pure, so a request URL is assertable without a page. */
export function qwenChatUrl(path: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(path, QWEN_CHAT_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}
