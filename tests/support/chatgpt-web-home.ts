/**
 * Shared test fixture: the data-home redirection every suite that touches persisted configuration
 * performs.
 *
 * Suites that exercise the durable store, the provider configuration or the doctor must never read
 * or write the operator's real `<data dir>`, so they point `DSH_CHATGPT_WEB_HOME` at a fresh
 * temporary directory and restore the previous environment afterwards. This module owns that
 * capture/redirect/restore cycle once, instead of the same setUp/tearDown block in every file.
 *
 * It is a plain module, not a test file: it defines no test and is never added to the `test` script.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The two home variables a suite may redirect, captured exactly as they were. */
export interface SavedChatGptWebHome {
  readonly chatGptWebHome: string | undefined;
  readonly freeHome: string | undefined;
}

/** Capture the home variables so {@link restoreChatGptWebHome} can put them back verbatim. */
export function captureChatGptWebHome(): SavedChatGptWebHome {
  return {
    chatGptWebHome: process.env.DSH_CHATGPT_WEB_HOME,
    freeHome: process.env.DSH_CHATGPT_FREE_HOME,
  };
}

/**
 * Create a fresh temporary data home and point `DSH_CHATGPT_WEB_HOME` at it.
 *
 * @param prefix - the `mkdtemp` prefix, so a stray directory names the suite that leaked it.
 * @param options.clearFreeHome - also clear the legacy `DSH_CHATGPT_FREE_HOME`, for the suites that
 *   deliberately test the alias boundary.
 * @returns the temporary directory, to pass back to {@link restoreChatGptWebHome}.
 */
export function useTemporaryChatGptWebHome(
  prefix: string,
  options: { readonly clearFreeHome?: boolean } = {},
): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  if (options.clearFreeHome === true) delete process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = home;
  return home;
}

/** Restore the captured home variables and, when given, remove the temporary directory. */
export function restoreChatGptWebHome(saved: SavedChatGptWebHome, home?: string): void {
  if (saved.freeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
  else process.env.DSH_CHATGPT_FREE_HOME = saved.freeHome;
  if (saved.chatGptWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = saved.chatGptWebHome;
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
}
