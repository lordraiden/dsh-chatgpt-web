/**
 * Conversation-text sanitization.
 *
 * The host injects its own transport blocks and operational lines into the conversation stream —
 * skills catalogues, runtime context, Hindsight recall, the Aegis bootstrap, time snapshots. None of
 * that is the conversation, so it is stripped from one piece of conversational text before the text
 * reaches a provider.
 *
 * This is deliberately a small, provider-neutral, text-only owner: every caller that must strip the
 * same blocks uses this one source of truth rather than keeping its own marker list.
 */
const TRANSPORT_BLOCKS = [
  // The harness's own skills catalogue arrives as one system reminder; it is host context, never
  // part of the conversation (issue: normal chat must not carry DSH context to the provider).
  ["<system-reminder>", "</system-reminder>"],
  ["<hindsight_knowledge>", "</hindsight_knowledge>"],
  ["<hindsight_memory>", "</hindsight_memory>"],
  ["<hindsight_knowledge_refresh>", "</hindsight_knowledge_refresh>"],
  ["<environment_context>", "</environment_context>"],
  ["<dsh_transport_resume>", "</dsh_transport_resume>"],
  ["<AEGIS_DSH_ROUTING_BOOTSTRAP>", "</AEGIS_DSH_ROUTING_BOOTSTRAP>"],
] as const;

const OPERATIONAL_LINE_PREFIXES = [
  "Time sampled while preparing turn ",
  "Browser time zone for this request:",
  "Elapsed since the preceding model-visible message:",
] as const;

const PRIVATE_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2";

/**
 * Remove internal transport blocks (Hindsight, environment, Aegis bootstrap,
 * transport resume markers), private checkpoint tails, and operational line
 * prefixes from one piece of conversational text. Shared by the prompt compiler
 * and the retained composer transport so both strip the same blocks from the
 * same source of truth.
 */
export function sanitizeConversationText(text: string): string {
  let sanitized = stripTaggedBlocks(text);

  if (sanitized.includes(PRIVATE_CHECKPOINT_MARKER)) {
    sanitized = sanitized.slice(0, sanitized.indexOf(PRIVATE_CHECKPOINT_MARKER));
  }

  sanitized = sanitized
    .split(/\r?\n/)
    .filter(line => !OPERATIONAL_LINE_PREFIXES.some(prefix => line.trimStart().startsWith(prefix)))
    .join("\n");

  return sanitized.trim();
}

function stripTaggedBlocks(text: string): string {
  let current = text;

  for (const [open, close] of TRANSPORT_BLOCKS) {
    for (;;) {
      const start = current.indexOf(open);
      if (start < 0) break;
      const end = current.indexOf(close, start + open.length);
      current = end < 0
        ? current.slice(0, start)
        : current.slice(0, start) + current.slice(end + close.length);
    }
  }

  // Hindsight may add new named sections over time. Treat the whole
  // <hindsight_...> namespace as host-private and fail closed on an
  // unterminated section so future memory formats cannot leak by default.
  for (;;) {
    const match = /<hindsight_[a-z0-9_-]+>/i.exec(current);
    if (!match || match.index === undefined) break;

    const open = match[0];
    const start = match.index;
    const tagName = open.slice(1, -1);
    const closingTag = new RegExp(`</${tagName}>`, "i");
    const closingMatch = closingTag.exec(current.slice(start + open.length));
    if (!closingMatch || closingMatch.index === undefined) {
      current = current.slice(0, start);
      break;
    }

    const end = start + open.length + closingMatch.index + closingMatch[0].length;
    current = current.slice(0, start) + current.slice(end);
  }

  return current;
}
