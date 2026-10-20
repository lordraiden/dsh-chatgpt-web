/**
 * Types for the dependency-free capture script, so the test suite can import the pure pieces and the
 * capture pipeline without adding `allowJs` to the project's TypeScript program.
 *
 * The script is plain ESM that runs under Node with no dependencies; this file names only what the
 * capture/import tests use. Keep it in sync with `qwen-storage-state.mjs`.
 */

export interface CdpCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  session?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  partitionKey?: unknown;
}

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface PlaywrightStorageState {
  cookies: StorageStateCookie[];
  origins: { origin: string; localStorage: unknown[] }[];
}

export interface CaptureScriptOptions {
  out: string;
  host: string;
  port: number;
  help: boolean;
}

export const QWEN_COOKIE_DOMAINS: readonly string[];
export const QWEN_STORAGE_ORIGINS: readonly string[];

export function hostAllowed(host: string, allowed?: readonly string[]): boolean;
export function cdpCookiesToStorageState(
  payload: unknown,
  now?: number,
  storageEntries?: unknown,
): PlaywrightStorageState;
export function localStorageToOrigins(entries: unknown): PlaywrightStorageState["origins"];
export function captureToFile(options: {
  payload: unknown;
  outPath: string;
  stdout?: (line: string) => void;
  now?: number;
  storage?: unknown;
}): { path: string; cookies: number; domains: string[]; storageKeys: number };
export function fetchChromeCookies(options?: {
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<CdpCookie[]>;
export function fetchChromeLocalStorage(options?: {
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<unknown[]>;
export function parseArgs(argv: string[]): CaptureScriptOptions;
export function main(argv?: string[], io?: { stdout?: (line: string) => void }): Promise<number>;
