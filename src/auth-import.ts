/**
 * `auth import` — adopt a session captured **outside** the deployment (issues #249 and #299).
 *
 * The command is deliberately one pipeline, not one branch per provider:
 *
 * ```text
 * read + shape-check the file        (secret-free; a bad file never reaches a browser)
 *         ↓
 * provider.validate                  (provider-scoped: this provider's cookies, still fresh)
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
}

/** One provider's participation in `auth import`. */
export interface AuthImportProvider {
  /** The `--provider` value. */
  readonly id: string;
  /** Human label used in refusals. */
  readonly label: string;
  /**
   * Validate the capture for this provider before any browser starts.
   *
   * Must throw an actionable, credential-free `Error` when the file cannot be this provider's
   * session. Returns the state that will be probed and stored.
   */
  readonly accept: (storageState: ImportedStorageState, now: number) => ImportedStorageState;
  /** Run this provider's authenticated predicate. Resolving is the only permission to store. */
  readonly authenticate: (storageState: ImportedStorageState) => Promise<AuthImportAuthentication>;
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

export interface AuthImportResult {
  /** Where the session was written. */
  readonly path: string;
  /** The provider's non-secret confirmation line. */
  readonly detail: string;
}

/** Every provider `auth import` accepts. Unknown values are refused, never silently defaulted. */
export const AUTH_IMPORT_PROVIDER_IDS = [CHATGPT_WEB_AUTH_PROVIDER_ID, QWEN_CODE_PROVIDER_ID] as const;

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
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
  if (text.trim() === "") {
    throw new Error(
      `${sourceFile} is empty; export the session again from the browser where the provider is signed in`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${sourceFile} is not valid JSON; export the session again from the browser where the provider is signed in`,
    );
  }

  const state = parsed as { cookies?: unknown; origins?: unknown };
  if (!state || typeof state !== "object" || (!Array.isArray(state.cookies) && !Array.isArray(state.origins))) {
    throw new Error(
      `${sourceFile} does not look like a Playwright storage state (expected a "cookies" or "origins" array)`,
    );
  }
  return {
    cookies: Array.isArray(state.cookies) ? state.cookies : [],
    origins: Array.isArray(state.origins) ? state.origins : [],
  };
}

/**
 * Run one import end to end.
 *
 * Validation precedes probing, and probing precedes the single write: a capture that fails any step
 * writes nothing, so an unusable session can never masquerade as a working one.
 */
export async function importProviderSession(request: AuthImportRequest): Promise<AuthImportResult> {
  const parsed = readImportedStorageState(request.from, request.readFile);
  const accepted = request.provider.accept(parsed, (request.now ?? Date.now)());

  let authentication: AuthImportAuthentication;
  try {
    authentication = await request.provider.authenticate(accepted);
  } catch (error) {
    throw new Error(
      `The capture could not be verified against the ${request.provider.label} login surface, so nothing was written: `
      + `${nonSecretDiagnosticText(error)}`,
    );
  }

  const path = request.provider.store(authentication);
  return { path, detail: authentication.detail };
}

/** ChatGPT Web: the existing behaviour, now behind the shared pipeline. */
export function chatGptWebAuthImportProvider(config: AppConfig): AuthImportProvider {
  return {
    id: CHATGPT_WEB_AUTH_PROVIDER_ID,
    label: "ChatGPT Web",
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
    accept: (state, now) => validateQwenCodeSessionStorageState(state, now),
    authenticate: async state => {
      const verification = await verifyQwenCodeImportedSession(state, {
        ...(options.chromeExecutablePath === undefined ? {} : { chromeExecutablePath: options.chromeExecutablePath }),
        ...(options.probe === undefined ? {} : { probe: options.probe }),
      });
      return {
        storageState: state,
        detail: `Authenticated: /coder/api/v2/task/list answered success:true (HTTP ${verification.status})`,
      };
    },
    store: authentication => storeQwenSession(authentication.storageState),
  };
}

/** Resolve `--provider` to its import provider; unknown ids are refused with the supported list. */
export function authImportProvider(providerId: string, config?: AppConfig): AuthImportProvider {
  switch (providerId) {
    case CHATGPT_WEB_AUTH_PROVIDER_ID:
      return chatGptWebAuthImportProvider(config ?? loadConfig());
    case QWEN_CODE_PROVIDER_ID:
      return qwenCodeAuthImportProvider({ chromeExecutablePath: (config ?? loadConfig()).chromeExecutablePath });
    default:
      throw new Error(
        `Unknown provider ${JSON.stringify(providerId)}; supported providers are `
        + `${AUTH_IMPORT_PROVIDER_IDS.join(", ")}`,
      );
  }
}
