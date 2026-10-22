/**
 * The prompt content of one Qwen Chat turn.
 *
 * This is the provider-local answer to "what text does this turn put in `messages[0].content`?". The
 * protocol shape (`network-turn.ts`) carries it, the transport sends it, and the turn runner
 * (`provider-runtime.ts`) decides which of these two compilers a turn uses:
 *
 * - {@link compileQwenChatReplayPrompt} — an explicit replay/rebuild from canonical host history: the
 *   conversation is created fresh, so the rebuilt conversation has to arrive as text;
 * - {@link compileQwenChatInstallPrompt} — a **normal Chat Mode install** (the first physical message
 *   of a brand-new conversation): the deterministic project header, then only the current human turn.
 *
 * A **continuation** uses neither: the provider chat already carries the conversation, so the turn
 * sends only the new human text (`provider-runtime.ts`).
 *
 * ## The install header is not this provider's to define
 *
 * The header comes from the provider-neutral owner (`src/project-identity.ts`), the same one the
 * ChatGPT minimal Chat Mode install compiles from, so both providers introduce a conversation with
 * the identical deterministic identity. It carries the project name and its authoritative repository
 * URL and nothing else — never a host-context snapshot, a runtime block, a tool definition or a
 * system prompt. When that metadata cannot be resolved the header is omitted, never fabricated.
 */
import { withProjectIdentityHeader } from "../../project-identity";
import type { WebChatReplayMessage } from "../../web-chat/core";

/**
 * Compile canonical history into the one prompt a replay sends.
 *
 * A replay creates a **new** chat, so the rebuilt conversation has to arrive as text: `User:` /
 * `Assistant:` lines, the same convention the ChatGPT and Qwen Code compilers use, built only from
 * the canonical messages the caller sent (never from provider state and never from a stored
 * transcript). A replay is not an install, so it carries no project header: the header is
 * initialization metadata of the conversation's first physical message, and canonical history does
 * not contain it.
 */
export function compileQwenChatReplayPrompt(history: readonly WebChatReplayMessage[]): string {
  const lines: string[] = [];
  for (const message of history) {
    if (message.text.trim().length === 0) continue;
    const label = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : message.role === "system" ? "System" : "Developer";
    lines.push(`${label}: ${message.text}`);
  }
  return lines.join("\n");
}

/**
 * The first physical message of a brand-new Qwen Chat conversation: the deterministic project header
 * plus ONLY the current human turn.
 *
 * The header is resolution metadata for the provider, not conversation: no canonical history, no host
 * context and no system text travels with it. Injection is idempotent
 * (`withProjectIdentityHeader`), so compiling the same install twice can never duplicate the header,
 * and an install that would carry no human message is refused exactly like the ChatGPT install —
 * never sent as a header with nothing to answer.
 *
 * @param currentUserText - the current human turn, already sanitized by the caller.
 * @param header - the deterministic header for this installation (`projectIdentityHeader()` in
 *   production), or `undefined` when the package metadata resolves no identity; the explicit
 *   parameter is what makes the "metadata cannot be resolved" rule testable without faking the
 *   installed package.
 * @throws {Error} when there is no human message to install.
 */
export function compileQwenChatInstallPrompt(
  currentUserText: string,
  header: string | undefined,
): string {
  if (currentUserText.trim().length === 0) {
    throw new Error("A Qwen Chat normal Chat Mode install must carry a human message");
  }
  return withProjectIdentityHeader(currentUserText, header);
}
