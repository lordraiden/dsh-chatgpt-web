import { describe, expect, test } from "bun:test";
import { isChatGptConversationUrl } from "../src/chatgpt-session";
import { formatDshToolCapabilities } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptToolStreamParser, ChatGptToolProtocolError } from "../src/adapters/chatgpt-web/tool-stream-parser";

describe("persistent ChatGPT surface", () => {
  test("accepts the account root and persisted conversation URLs", () => {
    expect(isChatGptConversationUrl("https://chatgpt.com/")).toBe(true);
    expect(isChatGptConversationUrl("https://chatgpt.com/c/abc123")).toBe(true);
  });

  test("rejects Temporary Chat and unrelated ChatGPT routes", () => {
    expect(isChatGptConversationUrl("https://chatgpt.com/?temporary-chat=true")).toBe(false);
    expect(isChatGptConversationUrl("https://chatgpt.com/share/abc123")).toBe(false);
    expect(isChatGptConversationUrl("https://example.com/")).toBe(false);
  });
});

describe("DSH text tool protocol", () => {
  test("parses a tool frame split across stream chunks", () => {
    const parser = new ChatGptToolStreamParser();
    let text = "";

    const first = parser.feed("Before <dsh_tool_call>{\"version\":1,");
    text += first.text;
    expect(first.toolCalls).toEqual([]);

    const second = parser.feed("\"id\":\"call_12345678\",\"name\":\"fs.read\",");
    text += second.text;
    expect(second.toolCalls).toEqual([]);

    const result = parser.feed("\"arguments\":{\"path\":\"README.md\"}}</dsh_tool_call> after");
    text += result.text;

    expect(result.toolCalls).toEqual([
      {
        id: "call_12345678",
        name: "fs.read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(text).toBe("Before  after");
  });

  test("fails closed on duplicate model correlation ids", () => {
    const parser = new ChatGptToolStreamParser();
    const frame = "<dsh_tool_call>{\"version\":1,\"id\":\"call_12345678\",\"name\":\"fs.read\",\"arguments\":{\"path\":\"a\"}}</dsh_tool_call>";

    expect(parser.feed(frame).toolCalls).toHaveLength(1);
    expect(() => parser.feed(frame)).toThrow(ChatGptToolProtocolError);
  });

  test("exposes only the model-facing tool schema", () => {
    const text = formatDshToolCapabilities([
      {
        name: "read",
        namespace: "fs",
        description: "Read one UTF-8 file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: true,
      },
    ]);

    const capabilities = JSON.parse(text);
    expect(capabilities).toEqual([
      {
        name: "fs__read",
        description: "Read one UTF-8 file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(text).not.toContain('"strict"');
  });
});
