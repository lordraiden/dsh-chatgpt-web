export interface ParsedToolCall {
  /** Untrusted correlation supplied by the ChatGPT model; the runtime replaces it before DSH execution. */
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
const TOOL_OPEN_TAG = "<dsh_tool_call>";
const TOOL_CLOSE_TAG = "</dsh_tool_call>";
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
  for (let len = tag.length - 1; len >= 1; len -= 1) {
    if (str.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function findMaxPartialPrefix(str: string, tags: readonly string[]): number {
  let max = 0;
  for (const tag of tags) max = Math.max(max, findPartialTagPrefix(str, tag));
  return max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ChatGptToolStreamParser {
  private buffer = "";
  private mode: "text" | "thinking" | "tool_call" = "text";
  private currentTagContent = "";
  private readonly seenToolCallIds = new Set<string>();

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
        const toolTag = findEarliestTag(this.buffer, [TOOL_OPEN_TAG]);
        let nextTag: string | undefined;
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

        if (nextTag === undefined) {
          const partialThinking = findPartialTagPrefix(this.buffer, THINKING_OPEN);
          const partialTool = findPartialTagPrefix(this.buffer, TOOL_OPEN_TAG);
          const partialLen = Math.max(partialThinking, partialTool);
          if (partialLen > 0) {
            outputText += this.buffer.slice(0, this.buffer.length - partialLen);
            this.buffer = this.buffer.slice(this.buffer.length - partialLen);
          } else {
            outputText += this.buffer;
            this.buffer = "";
          }
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
            const chunk = this.buffer.slice(0, this.buffer.length - partialEnd);
            outputThinking += chunk;
            this.currentTagContent += chunk;
            this.buffer = this.buffer.slice(this.buffer.length - partialEnd);
          } else {
            outputThinking += this.buffer;
            this.currentTagContent += this.buffer;
            this.buffer = "";
          }
          break;
        }
        outputThinking += this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + THINKING_CLOSE.length);
        this.mode = "text";
        this.currentTagContent = "";
      } else {
        const endIdx = this.buffer.indexOf(TOOL_CLOSE_TAG);
        if (endIdx === -1) {
          const partialEnd = findPartialTagPrefix(this.buffer, TOOL_CLOSE_TAG);
          if (partialEnd > 0) {
            this.currentTagContent += this.buffer.slice(0, this.buffer.length - partialEnd);
            this.buffer = this.buffer.slice(this.buffer.length - partialEnd);
          } else {
            this.currentTagContent += this.buffer;
            this.buffer = "";
          }
          if (this.currentTagContent.length > MAX_TOOL_FRAME_CHARS) {
            throw new ChatGptToolProtocolError(
              `ChatGPT tool control frame exceeded the ${MAX_TOOL_FRAME_CHARS} character limit`,
            );
          }
          break;
        }

        this.currentTagContent += this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + TOOL_CLOSE_TAG.length);
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

    return { text: outputText, thinking: outputThinking, toolCalls };
  }

  flush(): StreamParseChunk {
    if (this.mode === "tool_call") {
      throw new ChatGptToolProtocolError("ChatGPT stream ended with an incomplete tool control frame");
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

    if (!isRecord(parsed)) {
      throw new ChatGptToolProtocolError("ChatGPT tool control frame must be a JSON object");
    }

    const keys = Object.keys(parsed).sort();
    const expectedKeys = ["arguments", "id", "name", "version"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new ChatGptToolProtocolError(
        `ChatGPT tool control frame fields must be exactly: ${expectedKeys.join(", ")}`,
      );
    }
    if (parsed.version !== TOOL_PROTOCOL_VERSION) {
      throw new ChatGptToolProtocolError(
        `Unsupported ChatGPT tool control protocol version: ${String(parsed.version)}`,
      );
    }
    if (typeof parsed.id !== "string" || parsed.id.length > MAX_TOOL_ID_CHARS || !TOOL_ID_PATTERN.test(parsed.id)) {
      throw new ChatGptToolProtocolError(
        "ChatGPT tool control frame id is invalid; expected a model-generated advisory call_<token> id",
      );
    }
    if (this.seenToolCallIds.has(parsed.id)) {
      throw new ChatGptToolProtocolError(`Duplicate ChatGPT tool control frame id: ${parsed.id}`);
    }
    if (typeof parsed.name !== "string" || parsed.name.length > MAX_TOOL_NAME_CHARS || !TOOL_NAME_PATTERN.test(parsed.name)) {
      throw new ChatGptToolProtocolError("ChatGPT tool control frame name is invalid");
    }
    if (!isRecord(parsed.arguments)) {
      throw new ChatGptToolProtocolError("ChatGPT tool control frame arguments must be an object");
    }

    this.seenToolCallIds.add(parsed.id);
    return {
      id: parsed.id,
      name: parsed.name,
      arguments: { ...parsed.arguments },
    };
  }
}
