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
 *
 * ## The harness's runtime-context snapshot
 *
 * The harness opens a turn with one prose snapshot, introduced by a preamble line and then a run of
 * blank-line-separated sections, each keyed by a `Current <thing>:` / `Approval …:` line — the working
 * directory, the DSH file policy, the approval policy, the implementation checkout, the Web GUI URL,
 * and whatever section the harness adds next. It has no delimiters, so it is recognized
 * **structurally**: the preamble names the snapshot, and everything from it through the contiguous run
 * of blank separators and section-key lines belongs to it. The first line that is neither ends the
 * block, so a human instruction placed after the snapshot in the same text is kept.
 *
 * The trigger is the preamble and never a lone section line: a human message that merely mentions a
 * "current working directory" in prose carries no preamble and is left untouched.
 *
 * ## The Hindsight namespace
 *
 * Hindsight injects its knowledge preamble, its `_refresh` reminder and its recall results as tagged
 * blocks (`<hindsight_knowledge>`, `<hindsight_knowledge_refresh>`, `<hindsight_memory>`, …). The whole
 * `hindsight_…` namespace is host context, so it is recognized **structurally** — by the family prefix
 * on an element's own opening tag, and by that element's own close tag — rather than by a list of
 * literal tag names. A sibling the harness adds later is therefore stripped from the moment it
 * appears, and a tag rendered with a stray space or newline inside it (`<hindsight_knowledge\n>`) is
 * still host context. The prefix is required, so prose that merely mentions "hindsight" or "knowledge
 * pages" is never touched.
 */
// The whole `hindsight_…` namespace is host-private and is owned by `stripHindsightElements` below,
// never by a literal pair here: the harness's knowledge preamble (`<hindsight_knowledge>`), its
// `_refresh` sibling, its `<hindsight_memory>` recall and whatever name it adds next all belong to the
// same family, so listing today's spellings would leak tomorrow's.
const TRANSPORT_BLOCKS = [
  // The harness's own skills catalogue arrives as one system reminder; it is host context, never
  // part of the conversation (issue: normal chat must not carry DSH context to the provider).
  ["<system-reminder>", "</system-reminder>"],
  ["<environment_context>", "</environment_context>"],
  ["<dsh_transport_resume>", "</dsh_transport_resume>"],
  ["<AEGIS_DSH_ROUTING_BOOTSTRAP>", "</AEGIS_DSH_ROUTING_BOOTSTRAP>"],
] as const;

/**
 * Opening tag of any element in the Hindsight namespace, matched **structurally** by the family prefix
 * rather than by a list of literal tag names, so the sibling the harness adds next (`_refresh` today,
 * something else tomorrow) is host context from the moment it appears.
 *
 * The tag body is tolerated because the reminder is assembled from templates and re-rendered into the
 * conversation stream: attributes, an internal space or newline before `>` (`<hindsight_knowledge\n>`),
 * and a self-closing form must not turn a host-private block into human content. The `hindsight_`
 * prefix is required, so prose that merely mentions "hindsight" or "knowledge pages" is never matched.
 */
const HINDSIGHT_OPEN_TAG = /<(hindsight_[a-z0-9_-]+)(?:\s[^<>]*?)?\s*\/?>/i;

const OPERATIONAL_LINE_PREFIXES = [
  "Time sampled while preparing turn ",
  "Browser time zone for this request:",
  "Elapsed since the preceding model-visible message:",
] as const;

/**
 * Opening line of the harness's runtime-context snapshot. Anchored to the stable phrase, not to the
 * whole current sentence, so the harness can reword its explanation without the block leaking.
 */
const RUNTIME_CONTEXT_PREAMBLE = /^Current runtime context\b/;

/**
 * Section keys the snapshot introduces: `Current ….`, `Approval …` (the approval policy and the
 * "approval prompts are disabled" note) and `Delegation depth …` (the sub-agent variant of the same
 * snapshot). A line that is none of these and not blank ends the block.
 */
const RUNTIME_CONTEXT_SECTION_LINE = /^(?:Current\b|Approval\b|Delegation depth\b)/;

const PRIVATE_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2";

/**
 * Remove internal transport blocks (Hindsight, environment, Aegis bootstrap,
 * transport resume markers), the harness's runtime-context snapshot, private
 * checkpoint tails, and operational line prefixes from one piece of
 * conversational text. Shared by the prompt compiler and the retained composer
 * transport so both strip the same blocks from the same source of truth.
 */
export function sanitizeConversationText(text: string): string {
  let sanitized = stripTaggedBlocks(text);
  sanitized = stripRuntimeContextSnapshot(sanitized);

  if (sanitized.includes(PRIVATE_CHECKPOINT_MARKER)) {
    sanitized = sanitized.slice(0, sanitized.indexOf(PRIVATE_CHECKPOINT_MARKER));
  }

  sanitized = sanitized
    .split(/\r?\n/)
    .filter(line => !OPERATIONAL_LINE_PREFIXES.some(prefix => line.trimStart().startsWith(prefix)))
    .join("\n");

  return sanitized.trim();
}

/**
 * Remove the harness's runtime-context snapshot (see the module contract). The block is recognized by
 * its preamble plus the contiguous run of blank separators and `Current …:` / `Approval …:` section
 * lines it introduces; the first line outside that family ends it, so a human instruction that
 * follows the snapshot in the same piece of text survives.
 */
function stripRuntimeContextSnapshot(text: string): string {
  const kept: string[] = [];
  let inSnapshot = false;

  for (const line of text.split(/\r?\n/)) {
    if (!inSnapshot) {
      if (RUNTIME_CONTEXT_PREAMBLE.test(line.trimStart())) {
        inSnapshot = true;
        continue;
      }
      kept.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "" || RUNTIME_CONTEXT_SECTION_LINE.test(trimmed)) continue;

    inSnapshot = false;
    kept.push(line);
  }

  return kept.join("\n");
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

  return stripHindsightElements(current);
}

/**
 * Remove every element of the Hindsight namespace (see `HINDSIGHT_OPEN_TAG`), including repeated
 * occurrences in one piece of text. Each opening tag is paired with its own close tag, tolerating the
 * same internal whitespace on the way out (`</hindsight_knowledge >`); a body that mentions a tag
 * cannot end a different block, because the close tag searched for is the one named by its own opening
 * tag.
 *
 * An opening tag with no close tag is not a licence to keep the text: Hindsight may add new named
 * sections over time, so the remainder is treated as part of the host-private block and removed — fail
 * closed, exactly as before, so a future memory format cannot leak by default.
 */
function stripHindsightElements(text: string): string {
  let current = text;

  for (;;) {
    const opening = HINDSIGHT_OPEN_TAG.exec(current);
    if (!opening || opening.index === undefined) break;

    // The capture is constrained to `[a-z0-9_-]`, so the name is safe to interpolate into a RegExp.
    const tagName = opening[1]!;
    const start = opening.index;
    const closing = new RegExp(`</${tagName}\\s*>`, "i").exec(current.slice(start + opening[0].length));

    if (!closing || closing.index === undefined) {
      current = current.slice(0, start);
      break;
    }

    const end = start + opening[0].length + closing.index + closing[0].length;
    current = current.slice(0, start) + current.slice(end);
  }

  return current;
}
