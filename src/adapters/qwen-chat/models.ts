/**
 * The Qwen Chat model list: configured, cached, and seeded from the **public** endpoint.
 *
 * ## What is measured, and what is only a hint
 *
 * `GET https://chat.qwen.ai/api/v2/models` (and `/api/models`) answers **200 without a session**,
 * with each model's `id`, its `info.meta.abilities`, `auto_thinking` and `thinking_format`
 * (recon §1.2, §1.6). That is the only model discovery this provider has.
 *
 * The recon also records the caveat that matters more than the list: every entry carries
 * `is_visitor_active` and `/api/config` advertises `features.limits.model_display_count:3`, while the
 * operator reports a much longer menu. So the anonymous answer is **probably the visitor subset**.
 * This module therefore treats it as a **hint**:
 *
 * - the deployment's `webChat.providers["qwen-chat"].models` is authoritative when present;
 * - otherwise a cached list refreshed from the public endpoint is used;
 * - otherwise a documented seed of the three ids the recon actually measured is used.
 *
 * An id is never invented: the seed is quoted from the measured answer, and the refresh either
 * returns ids the endpoint sent or fails.
 *
 * ## Refresh
 *
 * {@link refreshQwenChatModels} fetches, validates and writes the cache atomically (mode 0600). It is
 * exposed to the operator as
 *
 * ```text
 * dsh-chatgpt-web models refresh --provider qwen-chat
 * ```
 *
 * and it is the **only** path that changes the cached list. The request carries no cookie, token or
 * API key: the endpoint is public, so the refresh has no secret to leak.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";
import {
  QWEN_CHAT_MODELS_PATH,
  QWEN_CHAT_MODELS_V1_PATH,
  QWEN_CHAT_ORIGIN,
  QWEN_CHAT_CLIENT_VERSION,
  qwenChatModesForModel,
  qwenChatThinkingAbility,
  type QwenChatMode,
  type QwenChatModelAbilities,
  type QwenThinkingAbility,
} from "./provider";

/** One provider-local model this deployment can serve, with the abilities the mode rule needs. */
export interface QwenChatModelEntry extends QwenChatModelAbilities {
  /** The wire model id (e.g. `qwen3.7-plus`). Provider-local, never a public route. */
  readonly id: string;
  /** Human label, from the endpoint's `name` when it supplied one. */
  readonly label: string;
  /** Normalized `abilities.thinking`, when known. */
  readonly thinking?: QwenThinkingAbility;
  /** `info.meta.auto_thinking`, when known. */
  readonly autoThinking?: boolean;
  /** `info.meta.thinking_format` (observed `"summary"`), when known. */
  readonly thinkingFormat?: string;
  /** `info.meta.max_context_length`, when known. Published as the catalogue context window. */
  readonly contextWindow?: number;
}

/**
 * The three ids the recon **measured** on 2026-10-20 (recon §1.6), with their measured metadata.
 *
 * This is a seed, not a truth: it makes a fresh deployment usable before its first refresh and makes
 * the provider's assumptions explicit. `qwen3.8-omni-flash` carries no `auto_thinking` in the
 * recorded table, so the bundle's `!!meta.auto_thinking` rule offers `Thinking`/`Fast` for it — the
 * same result the app would compute for a missing flag.
 */
export const QWEN_CHAT_SEED_MODELS: readonly QwenChatModelEntry[] = [
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7-Plus",
    thinking: 1,
    autoThinking: true,
    thinkingFormat: "summary",
    contextWindow: 1_000_000,
  },
  {
    id: "qwen3.8-max",
    label: "Qwen3.8-Max",
    thinking: 1,
    autoThinking: true,
    thinkingFormat: "summary",
    contextWindow: 1_000_000,
  },
  {
    id: "qwen3.8-omni-flash",
    label: "Qwen3.8-Omni-Flash",
    thinking: 1,
    contextWindow: 1_000_000,
  },
];

/** The on-disk cache shape. `version` is the contract: an unknown version is never guessed. */
interface QwenChatModelsFile {
  version: 1;
  fetchedAt: string;
  models: QwenChatModelEntry[];
}

const MODELS_FILE_VERSION = 1;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Read one entry from the endpoint's shape, or `undefined` when it is not a model. */
function parseModelEntry(value: unknown): QwenChatModelEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = nonEmptyString(record["id"]);
  if (id === undefined) return undefined;
  // `info.meta` is where the measured answer puts the abilities; `info.abilities` is accepted too
  // because the recon quotes both spellings across the v1/v2 envelopes.
  const info = (record["info"] && typeof record["info"] === "object" && !Array.isArray(record["info"])
    ? record["info"]
    : {}) as Record<string, unknown>;
  const meta = (info["meta"] && typeof info["meta"] === "object" && !Array.isArray(info["meta"])
    ? info["meta"]
    : info) as Record<string, unknown>;
  const abilities = (meta["abilities"] && typeof meta["abilities"] === "object" && !Array.isArray(meta["abilities"])
    ? meta["abilities"]
    : {}) as Record<string, unknown>;
  const thinking = qwenChatThinkingAbility(abilities["thinking"]);
  const autoThinking = meta["auto_thinking"] === true ? true : meta["auto_thinking"] === false ? false : undefined;
  const thinkingFormat = nonEmptyString(meta["thinking_format"]);
  const contextWindow = positiveInteger(meta["max_context_length"]);
  return {
    id,
    label: nonEmptyString(record["name"]) ?? id,
    ...(thinking === undefined ? {} : { thinking }),
    ...(autoThinking === undefined ? {} : { autoThinking }),
    ...(thinkingFormat === undefined ? {} : { thinkingFormat }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

/**
 * The model array inside either public envelope.
 *
 * Measured shapes: `{ data: [ … ] }` (v1) and `{ success, request_id, data: { data: [ … ] } }` (v2).
 * Both are accepted structurally, and anything else is a refusal rather than an empty list.
 */
export function qwenChatPublicModelArray(payload: unknown): readonly unknown[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const data = record["data"];
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)["data"];
    if (Array.isArray(nested)) return nested;
  }
  return undefined;
}

/** Parse a public model-list answer into entries. Throws when it contains no model. */
export function parseQwenChatPublicModels(payload: unknown): readonly QwenChatModelEntry[] {
  const array = qwenChatPublicModelArray(payload);
  if (array === undefined) {
    throw new Error("the Qwen Chat model list did not contain a models array");
  }
  const seen = new Set<string>();
  const models: QwenChatModelEntry[] = [];
  for (const value of array) {
    const entry = parseModelEntry(value);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
  }
  if (models.length === 0) {
    throw new Error("the Qwen Chat model list contained no usable model id");
  }
  return models;
}

/** Parse a cached file. Unknown versions and malformed entries are refused, never guessed. */
export function parseQwenChatModelsFile(raw: unknown): readonly QwenChatModelEntry[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== MODELS_FILE_VERSION) return undefined;
  if (!Array.isArray(record["models"])) return undefined;
  const models = record["models"].flatMap(value => {
    const entry = parseModelEntry(value);
    return entry === undefined ? [] : [entry];
  });
  return models.length === 0 ? undefined : models;
}

/**
 * Read a cached model list, or `undefined` when there is none.
 *
 * A file that cannot be read is reported (sanitized) and ignored: the caller falls back to the seed,
 * which is a real measured list, instead of failing a deployment over a cache problem.
 */
export function readQwenChatModelsFile(file: string): readonly QwenChatModelEntry[] | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = parseQwenChatModelsFile(JSON.parse(readFileSync(file, "utf8")));
    if (parsed === undefined) {
      console.warn(
        `[qwen-chat] model cache has an unknown shape and is ignored ${JSON.stringify({ reason: "unknown-shape" })}`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn(
      `[qwen-chat] model cache is unreadable and is ignored ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
    );
    return undefined;
  }
}

/** Write the cache atomically and privately. Exported so a test can prove the format it asserts. */
export function writeQwenChatModelsFile(file: string, models: readonly QwenChatModelEntry[], now = Date.now()): void {
  const payload: QwenChatModelsFile = {
    version: MODELS_FILE_VERSION,
    fetchedAt: new Date(now).toISOString(),
    models: models.map(model => ({ ...model })),
  };
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Write-then-rename: a crash cannot leave a half-written cache that looks like a model list.
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** The response surface the refresh needs. Injectable so the refresh is testable without network. */
export type QwenChatFetch = (url: string, init: {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** Options for {@link refreshQwenChatModels}. */
export interface QwenChatRefreshOptions {
  /** Where to persist the cache. Omitted = fetch and return without writing. */
  readonly file?: string;
  /** Fetch seam; defaults to the process's `fetch` (no cookie, no token, no API key). */
  readonly fetchImpl?: QwenChatFetch;
  /** Per-attempt timeout. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Clock seam for the cache's `fetchedAt`. */
  readonly now?: () => number;
}

/**
 * The headers the unauthenticated model read sends.
 *
 * No `Authorization` and no cookie: this endpoint needs neither. The client `Version`/`source`
 * headers are the app's own non-secret shape, so the request is the same *kind* of read the page
 * makes. The user agent is deliberately **not** overridden: an honest `fetch` default is used, and
 * if the endpoint ever refuses it, that is reported instead of disguised.
 */
function publicModelHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    Version: QWEN_CHAT_CLIENT_VERSION,
    source: "web",
  };
}

/** Fetch one candidate path; `undefined` when it is unreachable or does not answer the list shape. */
async function fetchModelsFrom(
  path: string,
  options: Required<Pick<QwenChatRefreshOptions, "timeoutMs">> & QwenChatRefreshOptions,
): Promise<readonly QwenChatModelEntry[] | undefined> {
  const fetchImpl: QwenChatFetch = options.fetchImpl
    ?? (async (url, init) => {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => await response.json(),
      };
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${QWEN_CHAT_ORIGIN}${path}`, {
      method: "GET",
      headers: publicModelHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseQwenChatPublicModels(await response.json());
  } catch {
    // A candidate path that fails is not a deployment failure yet: the sibling path may answer.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the model list from the public endpoint and (when a file is given) cache it.
 *
 * Tries `/api/v2/models` first — the path the app itself calls — then `/api/models`, which the recon
 * measured as the v1 envelope of the same data. A failure leaves any existing cache untouched and
 * rejects with a sanitized message; an empty answer is a failure, never "this account has no models".
 */
export async function refreshQwenChatModels(
  options: QwenChatRefreshOptions = {},
): Promise<readonly QwenChatModelEntry[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("A Qwen Chat model refresh requires a positive timeout");
  }
  const v2 = await fetchModelsFrom(QWEN_CHAT_MODELS_PATH, { ...options, timeoutMs });
  const models = v2 ?? await fetchModelsFrom(QWEN_CHAT_MODELS_V1_PATH, { ...options, timeoutMs });
  if (models === undefined) {
    throw new Error(
      `Qwen Chat's public model list could not be read from ${QWEN_CHAT_ORIGIN}${QWEN_CHAT_MODELS_PATH} `
      + `or ${QWEN_CHAT_ORIGIN}${QWEN_CHAT_MODELS_V1_PATH}; the configured model list and the seed are unchanged`,
    );
  }
  if (options.file !== undefined) writeQwenChatModelsFile(options.file, models, options.now?.() ?? Date.now());
  return models;
}

/**
 * The model entries one deployment serves: configured, else cached, else the measured seed.
 *
 * `configured` is resolved by the provider configuration module (it validates the operator's block);
 * the caller passes `undefined` when the block omits `models`.
 */
export function qwenChatModelList(input: {
  readonly configured?: readonly QwenChatModelEntry[];
  readonly cacheFile?: string;
}): readonly QwenChatModelEntry[] {
  if (input.configured !== undefined && input.configured.length > 0) return input.configured;
  if (input.cacheFile !== undefined) {
    const cached = readQwenChatModelsFile(input.cacheFile);
    if (cached !== undefined) return cached;
  }
  return QWEN_CHAT_SEED_MODELS;
}

/** The selectable modes one entry offers, as the catalogue and the driver publish them. */
export function qwenChatEntryModes(entry: QwenChatModelEntry): readonly QwenChatMode[] {
  return qwenChatModesForModel(entry);
}
