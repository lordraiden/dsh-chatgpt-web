/**
 * `auth import` — adopt a session captured **outside** the deployment (issues #249 and #299).
 *
 * The command is deliberately one pipeline, not one branch per provider:
 *
 * ```text
 * read + shape-check the capture     (secret-free; a bad capture never reaches a browser)
 *         ↓
 * provider.accept                    (provider-scoped: this provider's cookies, still fresh)
 *         ↓
 * provider.authenticate              (the provider's own authenticated predicate)
 *         ↓
 * provider.store                     (always `storeProviderSession`, the single session writer)
 * ```
 *
 * The second provider is why the seam exists: the old command hard-coded a ChatGPT DOM inspection, a
 * ChatGPT result (`capabilities`) and the default provider path, so a second provider could only be
 * added by duplicating the command. A provider now supplies its own validation, predicate and writer
 * entry point, while the layout, the atomic write and the verified marker stay owned in one place.
 *
 * **Two callers, one policy.** The CLI reads a file; `POST /v1/control/auth/import` hands the same
 * pipeline an already-parsed storage state. Neither entry point validates on its own: both reach
 * {@link runProviderImport}, and a refusal is an {@link AuthImportRefusal} carrying the machine code
 * the control surface returns to its caller.
 *
 * **Verified and unverified are distinct.** A provider with an adapter proves the capture with its
 * own authenticated predicate. A provider with no adapter yet (DeepSeek) is stored as a *capture*
 * with `verified: false` and no `.verified.json` marker — it is never dressed up as a working
 * session.
 *
 * Nothing here prints or echoes a cookie value: names, counts and provider codes only, and any
 * provider failure is reduced by `nonSecretDiagnosticText` before it becomes a message.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { storeProviderSession, verifyStoredSession } from "./browser-login";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";
import { CHATGPT_WEB_AUTH_PROVIDER_ID } from "./adapters/chatgpt-web/auth-controller";
import {
  QWEN_CODE_AUTH_PROVIDER_LABEL,
  QWEN_CODE_PROVIDER_ID,
} from "./adapters/qwen-code/provider";
import {
  storeQwenSession,
  validateQwenCodeSessionStorageState,
} from "./adapters/qwen-code/session-store";
import {
  verifyQwenCodeImportedSession,
  type QwenCodeImportedSessionProbe,
} from "./adapters/qwen-code/session-import";
import { nonSecretDiagnosticText } from "./lib/safe-diagnostics";
import {
  AUTH_IMPORT_REFUSAL_CODES,
  AuthImportRefusal,
  isAuthImportRefusal,
} from "./auth-import-errors";

/** A parsed capture: the two arrays a Playwright `storageState` carries. */
export interface ImportedStorageState {
  readonly cookies: readonly unknown[];
  readonly origins: readonly unknown[];
}

/** What the authenticated predicate proved, plus the exact state that may be stored. */
export interface AuthImportAuthentication {
  /** The state to persist (providers may restrict it further during validation). */
  readonly storageState: ImportedStorageState;
  /** One non-secret line for the operator. */
  readonly detail: string;
  /** Provider-specific evidence the writer needs (ChatGPT's account capabilities); opaque here. */
  readonly evidence?: unknown;
  /**
   * Whether an authenticated predicate proved this capture.
   *
   * The pipeline sets it: `true` after a provider's predicate resolved, `false` for a provider whose
   * descriptor is `unverified`. The writer reads it so an unverified capture never gains a marker
   * that other readers treat as "this session works".
   */
  readonly verified: boolean;
}

/**
 * How a provider makes a capture trustworthy.
 *
 * - `authenticated` — `authenticate` must resolve before anything is written.
 * - `unverified` — the provider has no adapter/predicate yet. The capture is stored, but the result
 *   says so and no verified marker is written. This is not a shortcut around verification: it is
 *   the honest representation of "captured, not usable".
 */
export type AuthImportVerification = "authenticated" | "unverified";

/** One provider's participation in `auth import`. */
export interface AuthImportProvider {
  /** The `--provider` value. */
  readonly id: string;
  /** Human label used in refusals. */
  readonly label: string;
  /**
   * Validate the capture for this provider before any browser starts.
   *
   * Must throw an actionable, credential-free {@link AuthImportRefusal} (or any `Error`) when the
   * capture cannot be this provider's session. Returns the state that will be probed and stored.
   */
  readonly accept: (storageState: ImportedStorageState, now: number) => ImportedStorageState;
  /** Whether {@link authenticate} is allowed to decide this capture's readiness. */
  readonly verification: AuthImportVerification;
  /** Run this provider's authenticated predicate. Required for `verification: "authenticated"`. */
  readonly authenticate?: (storageState: ImportedStorageState) => Promise<AuthImportAuthentication>;
  /**
   * The non-secret explanation stored and returned for an `unverified` provider.
   *
   * It must say plainly that the session is captured but not usable yet; never imply verification.
   */
  readonly unverifiedMessage?: string;
  /** Persist through the single session owner; returns where it landed. */
  readonly store: (authentication: AuthImportAuthentication) => string;
}

/** Everything `auth import` needs, with seams so the pipeline is testable without a browser. */
export interface AuthImportRequest {
  readonly provider: AuthImportProvider;
  /** `--from`: a storage-state file or a directory containing `storage-state.json`. */
  readonly from: string;
  /** File reader seam; defaults to `readFileSync(..., "utf8")`. */
  readonly readFile?: (path: string) => string;
  /** Clock seam for the freshness checks. */
  readonly now?: () => number;
}

/** The same pipeline, for a capture that arrived in memory (the control API). */
export interface AuthImportStorageStateRequest {
  readonly provider: AuthImportProvider;
  /** The Playwright storage state exactly as the caller supplied it; validated here, not by the route. */
  readonly storageState: unknown;
  /** Clock seam for the freshness checks. */
  readonly now?: () => number;
}

export interface AuthImportResult {
  /** Where the session was written. */
  readonly path: string;
  /** The provider's non-secret confirmation line. */
  readonly detail: string;
  /** Whether the provider's authenticated predicate proved the capture. */
  readonly verified: boolean;
  /** The verification time as ISO 8601, or `null` for an unverified capture. */
  readonly verifiedAt: string | null;
}

/** DeepSeek Web's provider id: a capture-only participant until its adapter exists. */
export const DEEPSEEK_WEB_IMPORT_PROVIDER_ID = "deepseek-web";
export const DEEPSEEK_WEB_IMPORT_PROVIDER_LABEL = "DeepSeek Web";

/** Every provider `auth import` accepts. Unknown values are refused, never silently defaulted. */
export const AUTH_IMPORT_PROVIDER_IDS = [
  CHATGPT_WEB_AUTH_PROVIDER_ID,
  QWEN_CODE_PROVIDER_ID,
  DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
] as const;

/**
 * The honest success line for a DeepSeek capture.
 *
 * Deliberately states both halves: the session was stored, and it cannot be used. A caller must not
 * mistake `verified: false` for a transient failure of an otherwise working login.
 */
export const DEEPSEEK_WEB_UNVERIFIED_MESSAGE =
  "Captured and stored, but not verified: DeepSeek Web has no adapter yet, so this session cannot be "
  + "used for turns until one is added.";

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Validate a value that claims to be a Playwright storage state.
 *
 * This is the *only* shape check: the file path decodes JSON and delegates here, and the HTTP body
 * hands its parsed `storageState` member here. A caller cannot reach a provider with a value this
 * function has not normalised.
 */
export function validateImportedStorageState(value: unknown, sourceLabel: string): ImportedStorageState {
  const state = value as { cookies?: unknown; origins?: unknown } | null;
  if (!state || typeof state !== "object" || (!Array.isArray(state.cookies) && !Array.isArray(state.origins))) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.shapeInvalid,
      `${sourceLabel} does not look like a Playwright storage state (expected a "cookies" or "origins" array)`,
    );
  }
  return {
    cookies: Array.isArray(state.cookies) ? state.cookies : [],
    origins: Array.isArray(state.origins) ? state.origins : [],
  };
}

/** Decode a captured file's text, then shape-check it. */
function parseImportedStorageStateText(text: string, sourceFile: string): ImportedStorageState {
  if (text.trim() === "") {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.empty,
      `${sourceFile} is empty; export the session again from the browser where the provider is signed in`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // `JSON.parse` quotes a fragment of its input, which is exactly where a cookie value would come
    // from. The parser's message is therefore deliberately not included.
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.malformed,
      `${sourceFile} is not valid JSON; export the session again from the browser where the provider is signed in`,
    );
  }

  return validateImportedStorageState(parsed, sourceFile);
}

/**
 * Read and shape-check `--from`.
 *
 * The checks are independent so each refusal names its own fix: an empty file, invalid JSON, or
 * something that is not a storage state at all. A parser's own message is deliberately **not**
 * included — `JSON.parse` quotes a fragment of its input, which is exactly where a cookie value would
 * come from.
 */
export function readImportedStorageState(
  from: string,
  readFile: (path: string) => string = defaultReadFile,
): ImportedStorageState {
  const source = resolve(from);
  if (!existsSync(source)) throw new Error(`--from does not exist: ${source}`);
  // A directory is the natural way to hand over a Playwright capture directory.
  const sourceFile = statSync(source).isDirectory() ? join(source, "storage-state.json") : source;
  if (!existsSync(sourceFile)) throw new Error(`no storage-state.json in ${source}`);

  let text: string;
  try {
    text = readFile(sourceFile);
  } catch (error) {
    throw new Error(`could not read ${sourceFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseImportedStorageStateText(text, sourceFile);
}

/**
 * Run the shared middle of an import: accept, authenticate, store.
 *
 * Validation precedes probing, and probing precedes the single write: a capture that fails any step
 * writes nothing, so an unusable session can never masquerade as a working one.
 */
async function runProviderImport(
  provider: AuthImportProvider,
  parsed: ImportedStorageState,
  clock: () => number,
): Promise<AuthImportResult> {
  let accepted: ImportedStorageState;
  try {
    accepted = provider.accept(parsed, clock());
  } catch (error) {
    // A provider's own refusal already carries its machine code; anything else is still a capture
    // problem and is reduced to the one non-secret diagnostic vocabulary.
    if (isAuthImportRefusal(error)) throw error;
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.shapeInvalid,
      `${provider.label} refused the capture: ${nonSecretDiagnosticText(error)}`,
    );
  }

  let authentication: AuthImportAuthentication;
  if (provider.verification === "unverified") {
    authentication = {
      storageState: accepted,
      detail: provider.unverifiedMessage
        ?? `${provider.label} captures are stored, but this provider has no adapter to verify them yet`,
      verified: false,
    };
  } else {
    if (!provider.authenticate) {
      throw new Error(
        `The ${provider.label} import provider declares authenticated verification but supplies no predicate`,
      );
    }
    try {
      authentication = { ...(await provider.authenticate(accepted)), verified: true };
    } catch (error) {
      throw new AuthImportRefusal(
        AUTH_IMPORT_REFUSAL_CODES.predicateFailed,
        `The capture could not be verified against the ${provider.label} login surface, so nothing was written: `
        + `${nonSecretDiagnosticText(error)}`,
      );
    }
  }

  const path = provider.store(authentication);
  return {
    path,
    detail: authentication.detail,
    verified: authentication.verified,
    verifiedAt: authentication.verified ? new Date(clock()).toISOString() : null,
  };
}

/**
 * Run one import end to end from a file (the CLI path).
 *
 * Validation precedes probing, and probing precedes the single write: a capture that fails any step
 * writes nothing, so an unusable session can never masquerade as a working one.
 */
export async function importProviderSession(request: AuthImportRequest): Promise<AuthImportResult> {
  const parsed = readImportedStorageState(request.from, request.readFile);
  return await runProviderImport(request.provider, parsed, request.now ?? Date.now);
}

/**
 * Run the same pipeline for a capture already parsed out of an HTTP body.
 *
 * The route never validates `storageState` itself: this function owns the shape check and delegates
 * to the identical accept/authenticate/store steps the CLI uses.
 */
export async function importProviderStorageState(
  request: AuthImportStorageStateRequest,
): Promise<AuthImportResult> {
  const parsed = validateImportedStorageState(request.storageState, "the import body");
  return await runProviderImport(request.provider, parsed, request.now ?? Date.now);
}

/** ChatGPT Web: the existing behaviour, now behind the shared pipeline. */
export function chatGptWebAuthImportProvider(config: AppConfig): AuthImportProvider {
  return {
    id: CHATGPT_WEB_AUTH_PROVIDER_ID,
    label: "ChatGPT Web",
    verification: "authenticated",
    accept: state => state,
    authenticate: async state => {
      const capabilities = await verifyStoredSession(
        config,
        state as Parameters<typeof verifyStoredSession>[1],
      );
      return {
        storageState: state,
        detail: `Account surface: ${capabilities.url}`,
        evidence: capabilities,
        verified: true,
      };
    },
    store: authentication => storeProviderSession(
      authentication.storageState as Parameters<typeof storeProviderSession>[0],
      authentication.evidence as ChatGptWebAccountCapabilities,
    ),
  };
}

/** Options for the Qwen Code import; the probe seam is what makes the gate testable. */
export interface QwenCodeAuthImportOptions {
  readonly chromeExecutablePath?: string;
  readonly probe?: QwenCodeImportedSessionProbe;
}

/** Qwen Code: validate the provider's own cookies, then the same `task/list` predicate sign-in uses. */
export function qwenCodeAuthImportProvider(options: QwenCodeAuthImportOptions = {}): AuthImportProvider {
  return {
    id: QWEN_CODE_PROVIDER_ID,
    label: QWEN_CODE_AUTH_PROVIDER_LABEL,
    verification: "authenticated",
    accept: (state, now) => validateQwenCodeSessionStorageState(state, now),
    authenticate: async state => {
      const verification = await verifyQwenCodeImportedSession(state, {
        ...(options.chromeExecutablePath === undefined ? {} : { chromeExecutablePath: options.chromeExecutablePath }),
        ...(options.probe === undefined ? {} : { probe: options.probe }),
      });
      return {
        storageState: state,
        detail: `Authenticated: /coder/api/v2/task/list answered success:true (HTTP ${verification.status})`,
        verified: true,
      };
    },
    store: authentication => storeQwenSession(authentication.storageState),
  };
}

/**
 * DeepSeek Web: a capture-only participant (no adapter, no predicate).
 *
 * There is deliberately no browser, no request and no `verified` claim here. The descriptor exists
 * so a plugin can put the browser's capture in the deployment's standard provider layout now, ready
 * for the driver; until then the answer says exactly that. Only the provider-neutral structural rule
 * is applied — a capture with neither cookies nor `localStorage` is not a capture. With no driver
 * there is no domain list, expiry rule or "deepseek keeps its token in cookies" assumption to invent.
 */
export function deepSeekWebAuthImportProvider(): AuthImportProvider {
  return {
    id: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
    label: DEEPSEEK_WEB_IMPORT_PROVIDER_LABEL,
    verification: "unverified",
    accept: state => {
      // No adapter has declared where DeepSeek keeps its session yet, so accept either half of a
      // Playwright storage state. Refusing an origins-only capture would silently encode a guess.
      const hasCookies = state.cookies.length > 0;
      const hasLocalStorage = state.origins.some(origin => {
        const entry = origin as { localStorage?: unknown } | null;
        return Array.isArray(entry?.localStorage) && entry.localStorage.length > 0;
      });
      if (!hasCookies && !hasLocalStorage) {
        throw new AuthImportRefusal(
          AUTH_IMPORT_REFUSAL_CODES.empty,
          "the capture contains no cookies or local storage at all; open DeepSeek Web in the browser "
          + "you signed in with, then export the session again",
        );
      }
      return state;
    },
    unverifiedMessage: DEEPSEEK_WEB_UNVERIFIED_MESSAGE,
    store: authentication => storeProviderSession(
      authentication.storageState as Parameters<typeof storeProviderSession>[0],
      {},
      {
        providerId: DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
        // No predicate proved this capture: the writer omits the marker every reader treats as proof.
        verified: false,
      },
    ),
  };
}

/** Resolve `--provider` to its import provider; unknown ids are refused with the supported list. */
export function authImportProvider(providerId: string, config?: AppConfig): AuthImportProvider {
  switch (providerId) {
    case CHATGPT_WEB_AUTH_PROVIDER_ID:
      return chatGptWebAuthImportProvider(config ?? loadConfig());
    case QWEN_CODE_PROVIDER_ID:
      return qwenCodeAuthImportProvider({ chromeExecutablePath: (config ?? loadConfig()).chromeExecutablePath });
    case DEEPSEEK_WEB_IMPORT_PROVIDER_ID:
      return deepSeekWebAuthImportProvider();
    default:
      throw new AuthImportRefusal(
        AUTH_IMPORT_REFUSAL_CODES.providerUnknown,
        `Unknown provider ${JSON.stringify(providerId)}; supported providers are `
        + `${AUTH_IMPORT_PROVIDER_IDS.join(", ")}`,
      );
  }
}
