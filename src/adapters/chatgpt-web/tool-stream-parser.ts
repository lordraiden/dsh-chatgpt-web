export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface StreamParseChunk {
  text: string;
  thinking: string;
  toolCalls: ParsedToolCall[];
}

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";
const TOOL_OPEN_TAGS = ["<dsh_tool_call>"] as const;
const TOOL_CLOSE_TAGS = ["</dsh_tool_call>"] as const;
const TOOL_PROTOCOL_VERSION = 1 as const;
const MAX_TOOL_FRAME_CHARS = 128 * 1024;
const MAX_TOOL_ID_CHARS = 96;
const MAX_TOOL_NAME_CHARS = 128;
const TOOL_ID_PATTERN = /^call_[A-Za-z0-9_-]{8,96}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export class ChatGptToolProtocolError extends Error {
  readonly code = "chatgpt_tool_protocol_violation";

  constructor(message: string) {
    super(message);
    this.name = "ChatGptToolProtocolError";
  }
}

function findEarliestTag(str: string, tags: readonly string[]): { tag: string; index: number } | null {
  let earliestTag: string | null = null;
  let earliestIdx = -1;
  for (const tag of tags) {
    const idx = str.indexOf(tag);
    if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
      earliestTag = tag;
    }
  }
  return earliestTag !== null ? { tag: earliestTag, index: earliestIdx } : null;
}

function findPartialTagPrefix(str: string, tag: string): number {
  for (let len = tag.length - 1; len >= 1; len--) {
    if (str.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

function findMaxPartialPrefix(str: string, tags: readonly string[]): number {
  let max = 0;
  for (const tag of tags) {
    const len = findPartialTagPrefix(str, tag);
    if (len > max) max = len;
  }
  return max;
}

function normalizeToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  userContext?: string,
): Record<string, unknown> {
  const normalized = { ...args };
  if (toolName === "write" || toolName === "read" || toolName === "edit") {
    if (typeof normalized.file_path !== "string" || !normalized.file_path.trim()) {
      const candidates = [
        normalized.path,
        normalized.filePath,
        normalized.filepath,
        normalized.file,
        normalized.filename,
        normalized.fileName,
        normalized.target_file,
        normalized.targetFile,
        normalized.dest,
        normalized.destination,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          normalized.file_path = candidate.trim();
          break;
        }
      }
    }

    // Fallback: If file_path is still missing, extract filename from justification, description, or user prompt context
    if (typeof normalized.file_path !== "string" || !normalized.file_path.trim()) {
      const searchContext = [
        typeof normalized.justification === "string" ? normalized.justification : "",
        typeof normalized.description === "string" ? normalized.description : "",
        userContext || "",
      ].filter(Boolean).join(" ");

      if (searchContext) {
        const cleaned = searchContext
          .replace(/https?:\/\/[^\s]+/g, "")
          .replace(/\b(?:AGENTS|CLAUDE)\.md\b/gi, "");
        const match = cleaned.match(/\b([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]{1,10})\b/);
        if (match && match[1]) {
          normalized.file_path = match[1];
        }
      }
    }
    if (typeof normalized.file_path === "string") {
      normalized.file_path = normalized.file_path.replace(/\\([_*[\]])/g, "$1").trim();
    }
  }

  if (toolName === "write") {
    if (typeof normalized.content !== "string") {
      const contentCandidates = [
        normalized.text,
        normalized.data,
        normalized.body,
      ];
      for (const candidate of contentCandidates) {
        if (typeof candidate === "string") {
          normalized.content = candidate;
          break;
        }
      }
    }
    if (typeof normalized.content === "string") {
      let content = normalized.content;
      if (content.includes("\\n") && !content.includes("\n")) {
        content = content.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
      }
      normalized.content = content.replace(/\*\*([a-zA-Z0-9_]+)\*\*/g, "__$1__");
    }
  }

  if (toolName === "edit") {
    if (typeof normalized.old_string !== "string") {
      const oldCandidates = [
        normalized.old_str,
        normalized.oldStr,
        normalized.old_text,
        normalized.oldText,
        normalized["old-string"],
        normalized["old-str"],
        normalized.old,
        normalized.search,
        normalized.target,
        normalized.original,
        normalized.from,
        normalized.find,
      ];
      for (const candidate of oldCandidates) {
        if (typeof candidate === "string" && candidate.trim()) {
          normalized.old_string = candidate;
          break;
        }
      }
    }
    if (typeof normalized.new_string !== "string") {
      const newCandidates = [
        normalized.new_str,
        normalized.newStr,
        normalized.new_text,
        normalized.newText,
        normalized["new-string"],
        normalized["new-str"],
        normalized.new,
        normalized.replace,
        normalized.replacement,
        normalized.update,
        normalized.to,
      ];
      for (const candidate of newCandidates) {
        if (typeof candidate === "string" && candidate.trim()) {
          normalized.new_string = candidate;
          break;
        }
      }
    }

    if (
      (typeof normalized.old_string !== "string" || !normalized.old_string.trim())
      || (typeof normalized.new_string !== "string" || !normalized.new_string.trim())
    ) {
      const searchContext = [
        typeof normalized.justification === "string" ? normalized.justification : "",
        typeof normalized.description === "string" ? normalized.description : "",
        userContext || "",
      ].filter(Boolean).join(" ");

      if (searchContext) {
        const englishRegex = /(?:replace|change)\s+['"‘“]?([a-zA-Z0-9_.-]+)['"’”]?\s+(?:with|to|into)\s+['"‘“]?([a-zA-Z0-9_.-]+)['"’”]?/i;
        const match = searchContext.match(englishRegex);
        if (match && match[1] && match[2]) {
          if (!normalized.old_string) normalized.old_string = match[1];
          if (!normalized.new_string) normalized.new_string = match[2];
        }
      }
    }
    const oldStr = normalized.old_string;
    if (typeof oldStr === "string") {
      normalized.old_string = oldStr.replace(/\\([_*[\]])/g, "$1").replace(/\*\*([a-zA-Z0-9_]+)\*\*/g, "__$1__");
      if (normalized.replace_all === undefined && oldStr.trim().length <= 2) {
        normalized.replace_all = true;
      }
    }
    if (typeof normalized.new_string === "string") {
      normalized.new_string = normalized.new_string.replace(/\\([_*[\]])/g, "$1").replace(/\*\*([a-zA-Z0-9_]+)\*\*/g, "__$1__");
    }
  }

  if (toolName === "pwsh" || toolName === "bash") {
    if (typeof normalized.command !== "string" || !normalized.command.trim()) {
      const cmdCandidates = [
        normalized.cmd,
        normalized.script,
        normalized.code,
        normalized.exec,
      ];
      for (const candidate of cmdCandidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          normalized.command = candidate.trim();
          break;
        }
      }
    }
    if (typeof normalized.command === "string") {
      normalized.command = normalized.command.replace(/\\([_*[\]])/g, "$1").trim();
    }
    // Auto-supply description if missing so DSH schema validation never rejects it
    if (typeof normalized.description !== "string" || !normalized.description.trim()) {
      const descCandidates = [
        normalized.desc,
        normalized.justification,
        normalized.explanation,
        normalized.reason,
      ];
      for (const candidate of descCandidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          normalized.description = candidate.trim();
          break;
        }
      }
      if (typeof normalized.description !== "string" || !normalized.description.trim()) {
        normalized.description = typeof normalized.command === "string" && normalized.command.trim()
          ? `Run: ${normalized.command.trim().replace(/\s+/g, " ").slice(0, 60)}`
          : `Execute ${toolName} command`;
      }
    }
  }

  if (toolName === "glob") {
    if (typeof normalized.pattern !== "string" || !normalized.pattern.trim()) {
      const patternCandidates = [
        normalized.glob,
        normalized.query,
        normalized.path,
        normalized.search,
        normalized.filter,
      ];
      for (const candidate of patternCandidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          normalized.pattern = candidate.trim();
          break;
        }
      }
      if (!normalized.pattern) {
        normalized.pattern = "**/*";
      }
    }
    if (typeof normalized.pattern === "string") {
      normalized.pattern = normalized.pattern.replace(/\\([_*[\]])/g, "$1");
    }
  }

  if (toolName === "grep") {
    const patternCandidates = [
      normalized.pattern,
      normalized.query,
      normalized.search,
      normalized.regex,
      normalized.text,
      normalized.find,
    ];
    for (const candidate of patternCandidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        normalized.pattern = candidate.trim();
        normalized.query = candidate.trim();
        break;
      }
    }
    if (!normalized.pattern) {
      normalized.pattern = "";
      normalized.query = "";
    }
    if (typeof normalized.pattern === "string") {
      normalized.pattern = normalized.pattern.replace(/\\([_*[\]])/g, "$1");
      normalized.query = normalized.pattern;
    }
  }

  if (toolName === "web_search") {
    if (!Array.isArray(normalized.queries)) {
      const q = normalized.query || normalized.q || normalized.search;
      if (typeof q === "string" && q.trim()) {
        normalized.queries = [q.trim()];
      }
    }
  }

  if (toolName === "web_fetch") {
    if (typeof normalized.url !== "string" || !normalized.url.trim()) {
      const urlCandidates = [normalized.link, normalized.href, normalized.uri, normalized.target];
      for (const candidate of urlCandidates) {
        if (typeof candidate === "string" && candidate.trim()) {
          normalized.url = candidate.trim();
          break;
        }
      }
    }
  }

  return normalized;
}

export class ChatGptToolStreamParser {
  private buffer = "";
  private mode: "text" | "thinking" | "tool_call" = "text";
  private currentTagContent = "";
  private readonly seenToolCallIds = new Set<string>();

  constructor(private readonly userContext?: string) {}

  feed(delta: string): StreamParseChunk {
    if (typeof delta !== "string") {
      throw new ChatGptToolProtocolError("ChatGPT tool protocol received a non-string text delta");
    }
    this.buffer += delta;
    let outputText = "";
    let outputThinking = "";
    const toolCalls: ParsedToolCall[] = [];

    while (this.buffer.length > 0) {
      if (this.mode === "text") {
        const thinkingIdx = this.buffer.indexOf(THINKING_OPEN);
        const toolTag = findEarliestTag(this.buffer, TOOL_OPEN_TAGS);

        let nextTag: string | null = null;
        let nextIdx = -1;
        let isThinking = false;

        if (thinkingIdx !== -1 && toolTag !== null) {
          if (thinkingIdx < toolTag.index) {
            nextTag = THINKING_OPEN;
            nextIdx = thinkingIdx;
            isThinking = true;
          } else {
            nextTag = toolTag.tag;
            nextIdx = toolTag.index;
          }
        } else if (thinkingIdx !== -1) {
          nextTag = THINKING_OPEN;
          nextIdx = thinkingIdx;
          isThinking = true;
        } else if (toolTag !== null) {
          nextTag = toolTag.tag;
          nextIdx = toolTag.index;
        }

        if (nextTag === null) {
          const partialThinking = findPartialTagPrefix(this.buffer, THINKING_OPEN);
          const partialTool = findMaxPartialPrefix(this.buffer, TOOL_OPEN_TAGS);
          const partialLen = Math.max(partialThinking, partialTool);

          if (partialLen > 0) {
            outputText += this.buffer.slice(0, this.buffer.length - partialLen);
            this.buffer = this.buffer.slice(this.buffer.length - partialLen);
            break;
          }

          outputText += this.buffer;
          this.buffer = "";
          break;
        }

        outputText += this.buffer.slice(0, nextIdx);
        this.buffer = this.buffer.slice(nextIdx + nextTag.length);
        this.mode = isThinking ? "thinking" : "tool_call";
        this.currentTagContent = "";
      } else if (this.mode === "thinking") {
        const endIdx = this.buffer.indexOf(THINKING_CLOSE);
        if (endIdx === -1) {
          const partialEnd = findPartialTagPrefix(this.buffer, THINKING_CLOSE);
          if (partialEnd > 0) {
            outputThinking += this.buffer.slice(0, this.buffer.length - partialEnd);
            this.currentTagContent += this.buffer.slice(0, this.buffer.length - partialEnd);
            this.buffer = this.buffer.slice(this.buffer.length - partialEnd);
            break;
          }
          outputThinking += this.buffer;
          this.buffer = "";
          break;
        }
        outputThinking += this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + THINKING_CLOSE.length);
        this.mode = "text";
      } else {
        const endTag = findEarliestTag(this.buffer, TOOL_CLOSE_TAGS);
        if (endTag === null) {
          const partialEnd = findMaxPartialPrefix(this.buffer, TOOL_CLOSE_TAGS);
          if (partialEnd > 0) {
            this.currentTagContent += this.buffer.slice(0, this.buffer.length - partialEnd);
            this.buffer = this.buffer.slice(this.buffer.length - partialEnd);
            break;
          }
          this.currentTagContent += this.buffer;
          this.buffer = "";
          if (this.currentTagContent.length > MAX_TOOL_FRAME_CHARS) {
            throw new ChatGptToolProtocolError(
              `ChatGPT tool control frame exceeded the ${MAX_TOOL_FRAME_CHARS} character limit`,
            );
          }
          break;
        }

        this.currentTagContent += this.buffer.slice(0, endTag.index);
        this.buffer = this.buffer.slice(endTag.index + endTag.tag.length);
        this.mode = "text";

        if (this.currentTagContent.length > MAX_TOOL_FRAME_CHARS) {
          throw new ChatGptToolProtocolError(
            `ChatGPT tool control frame exceeded the ${MAX_TOOL_FRAME_CHARS} character limit`,
          );
        }
        toolCalls.push(this.parseToolCallFrame(this.currentTagContent));
        this.currentTagContent = "";
      }
    }

    if (this.mode === "tool_call" && this.currentTagContent.length > MAX_TOOL_FRAME_CHARS) {
      throw new ChatGptToolProtocolError(
        `ChatGPT tool control frame exceeded the ${MAX_TOOL_FRAME_CHARS} character limit`,
      );
    }

    return { text: outputText, thinking: outputThinking, toolCalls };
  }

  flush(): StreamParseChunk {
    if (this.mode === "tool_call") {
      throw new ChatGptToolProtocolError(
        "ChatGPT stream ended with an incomplete tool control frame",
      );
    }

    const remaining = this.buffer;
    this.buffer = "";
    if (this.mode === "thinking") {
      this.mode = "text";
      return { text: "", thinking: remaining, toolCalls: [] };
    }
    return { text: remaining, thinking: "", toolCalls: [] };
  }

  private parseToolCallFrame(rawContent: string): ParsedToolCall {
    const raw = rawContent.trim();
    if (!raw) throw new ChatGptToolProtocolError("ChatGPT tool control frame is empty");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ChatGptToolProtocolError(
        `ChatGPT tool control frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ChatGptToolProtocolError("ChatGPT tool control frame must be a JSON object");
    }

    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = ["arguments", "id", "name", "version"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new ChatGptToolProtocolError(
        `ChatGPT tool control frame fields must be exactly: ${expectedKeys.join(", ")}`,
      );
    }
    if (record.version !== TOOL_PROTOCOL_VERSION) {
      throw new ChatGptToolProtocolError(
        `Unsupported ChatGPT tool control protocol version: ${String(record.version)}`,
      );
    }
    if (typeof record.id !== "string" || record.id.length > MAX_TOOL_ID_CHARS || !TOOL_ID_PATTERN.test(record.id)) {
      throw new ChatGptToolProtocolError(
        "ChatGPT tool control frame id is invalid; expected opaque call_<token> correlation",
      );
    }
    if (this.seenToolCallIds.has(record.id)) {
      throw new ChatGptToolProtocolError(
        `Duplicate ChatGPT tool control frame id: ${record.id}`,
      );
    }
    if (typeof record.name !== "string" || record.name.length > MAX_TOOL_NAME_CHARS || !TOOL_NAME_PATTERN.test(record.name)) {
      throw new ChatGptToolProtocolError("ChatGPT tool control frame name is invalid");
    }
    if (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments)) {
      throw new ChatGptToolProtocolError("ChatGPT tool control frame arguments must be an object");
    }

    const normalized = normalizeToolArguments(
      record.name,
      record.arguments as Record<string, unknown>,
      this.userContext,
    );
    this.seenToolCallIds.add(record.id);
    return {
      id: record.id,
      name: record.name,
      arguments: normalized,
    };
  }
}
