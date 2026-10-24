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
  type QwenCodeImportedSessionPageOpener,
  type QwenCodeImportedSessionProbe,
} from "./adapters/qwen-code/session-import";
import type { QwenPageHydrationOptions } from "./adapters/qwen-code/session-probe";
import {
  QWEN_CHAT_AUTH_PROVIDER_LABEL,
  QWEN_CHAT_PROVIDER_ID,
} from "./adapters/qwen-chat/provider";
import {
  storeQwenChatSession,
  validateQwenChatSessionStorageState,
} from "./adapters/qwen-chat/session-store";
import {
  verifyQwenChatImportedSession,
  type QwenChatImportedSessionPageOpener,
  type QwenChatImportedSessionProbe,
} from "./adapters/qwen-chat/session-import";
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
  /**
   * One short, non-secret note about **how** the predicate read the provider's answer, when that is
   * worth recording.
   *
   * It exists so a stored-session log line can say which reading won (issue #299: a valid answer was
   * read from its envelope because the transport had to cut it) without the host having to understand
   * any provider's protocol. Omitted when the provider has nothing to add, and it is never a
   * credential: it is composed from non-secret diagnostics only.
   */
  readonly reading?: string;
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
  /**
   * How the predicate read the provider's answer, when the provider reported it (issue #299).
   *
   * The host logs it beside `verified`, so "the answer was cut and its envelope decided" is visible in
   * the service log and not only in the CLI's own detail line.
   */
  readonly reading?: string;
}

/** DeepSeek Web's provider id: a capture-only participant until its adapter exists. */
export const DEEPSEEK_WEB_IMPORT_PROVIDER_ID = "deepseek-web";
export const DEEPSEEK_WEB_IMPORT_PROVIDER_LABEL = "DeepSeek Web";

/** Every provider `auth import` accepts. Unknown values are refused, never silently defaulted. */
export const AUTH_IMPORT_PROVIDER_IDS = [
  CHATGPT_WEB_AUTH_PROVIDER_ID,
  QWEN_CODE_PROVIDER_ID,
  QWEN_CHAT_PROVIDER_ID,
  DEEPSEEK_WEB_IMPORT_PROVIDER_ID,
] as const;

/**
 * The honest success line for a DeepSeek capture.
 *
 * Deliberately states both halves: the session was stored, and it cannot be used. A caller must not
 * mistake `verified: false` for a transient failure of an otherwise working login.
 *
 * The adapter now exists (`src/adapters/deepseek-web/**`) and the page token's provenance is measured
 * (`localStorage["userToken"]`), but no authenticated predicate has been accepted as this provider's
 * verification step, so no probe claims the capture works. The sentence therefore says "no
 * authenticated predicate has accepted it" — not "there is no adapter" — and the remaining rung is
 * `doc/deepseek-web.md` §7.
 */
export const DEEPSEEK_WEB_UNVERIFIED_MESSAGE =
  "Captured and stored, but not verified: no authenticated predicate has accepted this DeepSeek Web "
  + "session yet (doc/deepseek-web.md §7), so it cannot be used for turns.";

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
 * Validate one capture and run its provider's authenticated predicate. **Writes nothing.**
 *
 * This is the shared middle of an import (the CLI, the control API) *and* of a session-health check:
 * one acceptance policy, one predicate, one refusal vocabulary. The caller decides whether the
 * proved material is stored (`runProviderImport` does; the session-health surface stores only a
 * renewal it produced) and what a refusal means to it.
 *
 * `authentication.storageState` is **the state to persist**, which is not necessarily the state that
 * was handed in: a provider whose predicate drives its own page (Qwen Chat) returns what the page
 * holds after it renewed its token, so the caller stores the renewal rather than the snapshot the
 * provider just consumed.
 *
 * @throws {AuthImportRefusal} `import_expired`/`import_foreign_domain`/… for a capture the provider
 *   will not accept, or `import_predicate_failed` for one its predicate rejected (the provider's own
 *   sentence is preserved as `cause`).
 */
export async function proveProviderCapture(
  provider: AuthImportProvider,
  parsed: ImportedStorageState,
  clock: () => number,
): Promise<AuthImportAuthentication> {
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

  if (provider.verification === "unverified") {
    return {
      storageState: accepted,
      detail: provider.unverifiedMessage
        ?? `${provider.label} captures are stored, but this provider has no adapter to verify them yet`,
      verified: false,
    };
  }
  if (!provider.authenticate) {
    throw new Error(
      `The ${provider.label} import provider declares authenticated verification but supplies no predicate`,
    );
  }
  try {
    return { ...(await provider.authenticate(accepted)), verified: true };
  } catch (error) {
    throw new AuthImportRefusal(
      AUTH_IMPORT_REFUSAL_CODES.predicateFailed,
      `The capture could not be verified against the ${provider.label} login surface, so nothing was written: `
      + `${nonSecretDiagnosticText(error)}`,
      // The provider's own sentence, for a surface whose question is "does this session still work?"
      // rather than "may I write this capture?". Preserved here, never re-implemented there.
      { cause: error },
    );
  }
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
  const authentication = await proveProviderCapture(provider, parsed, clock);
  const path = provider.store(authentication);
  return {
    path,
    detail: authentication.detail,
    verified: authentication.verified,
    verifiedAt: authentication.verified ? new Date(clock()).toISOString() : null,
    ...(authentication.reading === undefined ? {} : { reading: authentication.reading }),
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

/** Options for the Qwen Code import; the probe/page seams are what make the gate testable. */
export interface QwenCodeAuthImportOptions {
  readonly chromeExecutablePath?: string;
  readonly probe?: QwenCodeImportedSessionProbe;
  readonly openPage?: QwenCodeImportedSessionPageOpener;
  readonly hydration?: QwenPageHydrationOptions;
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
        ...(options.openPage === undefined ? {} : { openPage: options.openPage }),
        ...(options.hydration === undefined ? {} : { hydration: options.hydration }),
      });
      return {
        storageState: state,
        // Which reading authenticated it is named in the operator's one line: a session proved from a
        // cut answer must never look identical to one proved from a whole body.
        detail: verification.read === "truncated-envelope"
          ? `Authenticated: /coder/api/v2/task/list answered success:true (HTTP ${verification.status}); `
            + `the body was cut at ${verification.bodyChars ?? 0} characters, so its leading envelope `
            + "is what decided it"
          : `Authenticated: /coder/api/v2/task/list answered success:true (HTTP ${verification.status})`,
        ...(verification.read === "truncated-envelope"
          ? { reading: `body truncated at ${verification.bodyChars ?? 0} chars; the envelope reports success:true` }
          : {}),
        verified: true,
      };
    },
    store: authentication => storeQwenSession(authentication.storageState),
  };
}

/** Options for the Qwen Chat import; the probe/page seams are what make the gate testable. */
export interface QwenChatAuthImportOptions {
  readonly chromeExecutablePath?: string;
  readonly probe?: QwenChatImportedSessionProbe;
  readonly openPage?: QwenChatImportedSessionPageOpener;
  readonly hydration?: QwenPageHydrationOptions;
}

/**
 * Qwen Chat: validate the provider's own cookies (including the per-domain chat cookie rule), then
 * the same `GET /api/v2/chats` predicate sign-in uses.
 *
 * A Qwen Code capture is refused before any browser starts — cookies are per-domain, and the refusal
 * says so — instead of being probed and reported as an unauthenticated session.
 */
export function qwenChatAuthImportProvider(options: QwenChatAuthImportOptions = {}): AuthImportProvider {
  return {
    id: QWEN_CHAT_PROVIDER_ID,
    label: QWEN_CHAT_AUTH_PROVIDER_LABEL,
    verification: "authenticated",
    accept: (state, now) => validateQwenChatSessionStorageState(state, now),
    authenticate: async state => {
      const verification = await verifyQwenChatImportedSession(state, {
        ...(options.chromeExecutablePath === undefined ? {} : { chromeExecutablePath: options.chromeExecutablePath }),
        ...(options.probe === undefined ? {} : { probe: options.probe }),
        ...(options.openPage === undefined ? {} : { openPage: options.openPage }),
        ...(options.hydration === undefined ? {} : { hydration: options.hydration }),
      });
      // The page restored its own session with this capture, and a renewal it performed while doing
      // so rotates the credential the capture held (`refresh_token`). Persisting the page's own
      // state means the stored session is the one that was just proved, not the snapshot the proof
      // consumed — otherwise the first verification would shorten the capture's life. A page state
      // that cannot be read back is ignored: it must never discard a session the page just proved.
      let storageState = state;
      if (verification.storageState !== undefined) {
        try {
          storageState = validateImportedStorageState(verification.storageState, "the session page state");
        } catch {
          storageState = state;
        }
      }
      return {
        storageState,
        detail: verification.read === "truncated-envelope"
          ? `Authenticated: /api/v2/chats answered success:true (HTTP ${verification.status}); `
            + `the body was cut at ${verification.bodyChars ?? 0} characters, so its leading envelope `
            + "is what decided it"
          : `Authenticated: /api/v2/chats answered success:true (HTTP ${verification.status})`,
        ...(verification.read === "truncated-envelope"
          ? { reading: `body truncated at ${verification.bodyChars ?? 0} chars; the envelope reports success:true` }
          : {}),
        verified: true,
      };
    },
    store: authentication => storeQwenChatSession(authentication.storageState),
  };
}

/**
 * DeepSeek Web: a capture-only participant (a predicate is still missing).
 *
 * There is deliberately no browser, no request and no `verified` claim here. The descriptor puts the
 * browser's capture in the deployment's standard provider layout, where the adapter's session check
 * reads it — but a capture is not proof, and no authenticated predicate has been measured for this
 * provider yet (`doc/deepseek-web.md` §6), so the answer says exactly that. Only the provider-neutral
 * structural rule is applied — a capture with neither cookies nor `localStorage` is not a capture.
 * With no predicate there is no domain list, expiry rule or "deepseek keeps its token in cookies"
 * assumption to invent.
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
    case QWEN_CHAT_PROVIDER_ID:
      return qwenChatAuthImportProvider({ chromeExecutablePath: (config ?? loadConfig()).chromeExecutablePath });
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
