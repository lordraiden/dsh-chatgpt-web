import type { RequestMessage } from "@deepseek-ai/dsh-llm";

const CODEX_CONTEXT_OPEN = "<codex_context_json>";
const CODEX_CONTEXT_CLOSE = "</codex_context_json>";
const TRANSPORT_BLOCKS = [
  ["<hindsight_knowledge>", "</hindsight_knowledge>"],
  ["<hindsight_memory>", "</hindsight_memory>"],
  ["<hindsight_knowledge_refresh>", "</hindsight_knowledge_refresh>"],
  ["<environment_context>", "</environment_context>"],
  ["<dsh_transport_resume>", "</dsh_transport_resume>"],
] as const;

const OPERATIONAL_LINE_PREFIXES = [
  "Time sampled while preparing turn ",
  "Browser time zone for this request:",
  "Elapsed since the preceding model-visible message:",
] as const;

const TRANSPORT_PROTOCOL_MARKER =
  "Act as the model backend for the task encoded below.";
const PRIVATE_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2";

export class ConversationalContextProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationalContextProjectionError";
  }
}

/**
 * Convert the DSH bridge's transport-heavy message envelope into only the
 * conversational history that ChatGPT Web should see.
 *
 * When the bridge envelope is present, this is intentionally fail-closed:
 * malformed transport is rejected instead of falling back to sending the raw
 * protocol/context to ChatGPT.
 */
export function projectConversationalMessages(
  messages: readonly RequestMessage[],
): RequestMessage[] {
  const projected: RequestMessage[] = [];
  const transportEnvelopePresent = messages.some(message => {
    const text = textContent(message);
    return text !== undefined && (
      text.includes(CODEX_CONTEXT_OPEN)
      || text.includes(TRANSPORT_PROTOCOL_MARKER)
      || TRANSPORT_BLOCKS.some(([open, close]) => text.includes(open) || text.includes(close))
      || text.includes(PRIVATE_CHECKPOINT_MARKER)
    );
  });

  if (!transportEnvelopePresent) return [...messages];

  for (const message of messages) {
    const text = textContent(message);
    if (text === undefined) continue;

    const embedded = extractCodexContext(text);
    if (embedded !== undefined) {
      projected.push(...projectEmbeddedMessages(embedded));
      continue;
    }

    if (text.includes(CODEX_CONTEXT_OPEN) || text.includes(TRANSPORT_PROTOCOL_MARKER)) {
      throw new ConversationalContextProjectionError(
        "ChatGPT Web refused to forward an unparsed DSH transport envelope.",
      );
    }

    const role = (message as unknown as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;

    // A pure transport envelope is canonical history. The only outer content we
    // retain alongside it is a user/assistant message that explicitly contains
    // one of the known internal blocks, after sanitization.
    if (!containsSanitizationMarker(text)) continue;
    const sanitized = projectStandaloneConversationMessage(message);
    if (sanitized !== undefined) projected.push(sanitized);
  }

  if (projected.length === 0) {
    throw new ConversationalContextProjectionError(
      "ChatGPT Web did not receive any conversational messages after context projection.",
    );
  }

  return projected;
}

function projectEmbeddedMessages(rawMessages: unknown[]): RequestMessage[] {
  const projected: RequestMessage[] = [];

  for (const rawMessage of rawMessages) {
    if (!isRecord(rawMessage)) continue;
    const role = rawMessage.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = conversationalContent(rawMessage.content);
    if (content === undefined) continue;

    projected.push({
      ...rawMessage,
      role,
      content,
    } as unknown as RequestMessage);
  }

  return projected;
}

function extractCodexContext(text: string): unknown[] | undefined {
  const marker = text.indexOf(CODEX_CONTEXT_OPEN);
  if (marker < 0) return undefined;

  let cursor = marker + CODEX_CONTEXT_OPEN.length;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;

  if (text[cursor] !== "{") {
    throw new ConversationalContextProjectionError(
      "ChatGPT Web received a malformed <codex_context_json> envelope.",
    );
  }

  const json = extractBalancedJsonObject(text, cursor);
  const afterJson = cursor + json.length;
  let closeCursor = afterJson;
  while (closeCursor < text.length && /\s/.test(text[closeCursor] ?? "")) closeCursor += 1;
  if (!text.startsWith(CODEX_CONTEXT_CLOSE, closeCursor)) {
    throw new ConversationalContextProjectionError(
      "ChatGPT Web received an incomplete <codex_context_json> envelope.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConversationalContextProjectionError(
      "ChatGPT Web received invalid JSON inside <codex_context_json>.",
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    throw new ConversationalContextProjectionError(
      "<codex_context_json> does not contain a valid messages array.",
    );
  }

  return parsed.messages;
}

function extractBalancedJsonObject(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  throw new ConversationalContextProjectionError(
    "ChatGPT Web received an unterminated <codex_context_json> envelope.",
  );
}

function conversationalContent(content: unknown): string | unknown[] | undefined {
  if (typeof content === "string") {
    const sanitized = sanitizeConversationText(content);
    return sanitized.length > 0 ? sanitized : undefined;
  }

  if (!Array.isArray(content)) return undefined;

  const blocks = content.filter(isTextBlock).map(block => ({
    ...block,
    text: sanitizeConversationText(block.text),
  })).filter(block => block.text.length > 0);

  return blocks.length > 0 ? blocks : undefined;
}

function projectStandaloneConversationMessage(message: RequestMessage): RequestMessage | undefined {
  const content = conversationalContent((message as unknown as { content?: unknown }).content);
  if (content === undefined) return undefined;
  return { ...(message as object), content } as unknown as RequestMessage;
}

function containsSanitizationMarker(text: string): boolean {
  return TRANSPORT_BLOCKS.some(([open, close]) => text.includes(open) || text.includes(close))
    || OPERATIONAL_LINE_PREFIXES.some(prefix => text.trimStart().startsWith(prefix))
    || text.includes(PRIVATE_CHECKPOINT_MARKER);
}

function sanitizeConversationText(text: string): string {
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
  // <hindsight_...> namespace as plugin-private and fail closed on an
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

function textContent(message: RequestMessage): string | undefined {
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const textBlocks = content.filter(isTextBlock).map(block => block.text);
  return textBlocks.length > 0 ? textBlocks.join("\n") : undefined;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  if (!isRecord(value)) return false;
  return value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
