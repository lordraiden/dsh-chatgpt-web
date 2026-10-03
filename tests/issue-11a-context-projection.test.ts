import { expect, test } from "bun:test";
import {
  projectCanonicalChatGptWebContext,
  serializeCanonicalChatGptWebContext,
  withoutRetiredTurnHandles,
  withoutSupersededModelSwitchContracts,
} from "../src/adapters/chatgpt-web/context-projection";
import type { CodexMessage } from "../src/types";

const image = "https://example.com/diagram.png";

function sampleMessages(): CodexMessage[] {
  return [
    { role: "developer", content: "<model_switch>old</model_switch>", timestamp: 1 },
    { role: "developer", content: "<skills_instructions>old skill catalog</skills_instructions>", timestamp: 2 },
    {
      role: "user",
      content: [
        { type: "text", text: "Build the feature." },
        { type: "image", imageUrl: image, detail: "high" },
      ],
      timestamp: 3,
    },
    { role: "agentMessage", author: "planner", recipient: "worker", content: "Review the implementation.", timestamp: 4 },
    {
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "text", text: "I will inspect the code." },
        {
          type: "thinking",
          thinking: "working",
          signature: "sig-1",
          itemId: "reasoning-1",
          redacted: ["redacted-1"],
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          namespace: "mcp__fs",
          arguments: { path: "src/index.ts" },
          thoughtSignature: "tool-sig-1",
        },
      ],
      timestamp: 5,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      toolNamespace: "mcp__fs",
      content: "file contents",
      isError: false,
      timestamp: 6,
    },
    { role: "developer", content: "<model_switch>new</model_switch>", timestamp: 7 },
    { role: "developer", content: "<skills_instructions>new skill catalog</skills_instructions>", timestamp: 8 },
  ];
}

test("canonical projection preserves ordering and semantic tool results", () => {
  const projected = projectCanonicalChatGptWebContext(["system instruction"], sampleMessages());
  expect(projected.version).toBe(3);
  expect(projected.system).toEqual(["system instruction"]);
  expect(projected.messages.map(message => message.role)).toEqual([
    "user", "agent_message", "assistant", "tool_result", "developer", "developer",
  ]);
  expect(projected.messages[2]!.content).toEqual([
    { type: "text", text: "I will inspect the code." },
    {
      type: "thinking_summary",
      text: "working",
      signature: "sig-1",
      item_id: "reasoning-1",
      redacted: ["redacted-1"],
    },
    {
      type: "tool_call",
      id: "call-1",
      name: "read_file",
      namespace: "mcp__fs",
      arguments: { path: "src/index.ts" },
      thought_signature: "tool-sig-1",
    },
  ]);
  expect(projected.messages[3]).toEqual({
    role: "tool_result",
    tool_call_id: "call-1",
    tool_name: "read_file",
    tool_namespace: "mcp__fs",
    is_error: false,
    content: "file contents",
  });
});

test("canonical projection keeps images structured and separate from text", () => {
  const projected = projectCanonicalChatGptWebContext([], sampleMessages());
  expect(projected.images).toEqual([{ ref: "codex-input-image-1", imageUrl: image, detail: "high" }]);
  expect(projected.messages[0]!.content).toEqual([
    { type: "text", text: "Build the feature." },
    { type: "image_attachment", attachment_ref: "codex-input-image-1", detail: "high" },
  ]);
});

test("canonical projection is deterministic and does not mutate source state", () => {
  const source = sampleMessages();
  const before = structuredClone(source);
  const first = projectCanonicalChatGptWebContext(["sys"], source);
  const second = projectCanonicalChatGptWebContext(["sys"], structuredClone(source));
  expect(source).toEqual(before);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(serializeCanonicalChatGptWebContext(first)).toBe(serializeCanonicalChatGptWebContext(second));
});

test("transport handles are sanitized without corrupting semantic tool ids", () => {
  const raw = JSON.stringify({
    version: 3,
    system: ["system"],
    messages: [
      { role: "tool_result", tool_call_id: "turn_abcdefghijklmnopqrstuvwxyz", content: "x" },
      {
        role: "assistant",
        content: [{
          type: "tool_call",
          id: "binding_abcdefghijklmnopqrstuvwxyz",
          name: "x",
          arguments: {},
        }],
      },
    ],
    __transport_handle: "turn_transport_abcdefghijklmnopqrstuvwxyz",
  });
  const sanitized = withoutRetiredTurnHandles(raw);
  expect(sanitized).toContain("turn_abcdefghijklmnopqrstuvwxyz");
  expect(sanitized).toContain("binding_abcdefghijklmnopqrstuvwxyz");
  expect(sanitized).toContain("[retired transport handle]");
  expect(sanitized).not.toContain("turn_transport_abcdefghijklmnopqrstuvwxyz");
});


test("superseded model-switch contracts are removed without losing current history", () => {
  const normalized = withoutSupersededModelSwitchContracts(sampleMessages());
  expect(normalized.map(message => typeof message.content === "string" ? message.content : "")).toEqual([
    "",
    "Review the implementation.",
    "",
    "file contents",
    "<model_switch>new</model_switch>",
    "<skills_instructions>new skill catalog</skills_instructions>",
  ]);
});

test("replay fixture is generated entirely from canonical DSH state", () => {
  const projected = projectCanonicalChatGptWebContext(["system instruction"], sampleMessages());
  const replayFixture = serializeCanonicalChatGptWebContext(projected);
  expect(replayFixture).toContain("<model_switch>new</model_switch>");
  expect(replayFixture).toContain("call-1");
  expect(replayFixture).toContain("file contents");
  expect(replayFixture).not.toContain("chatgpt.com");
  expect(replayFixture).not.toContain("conversationId");
  expect(replayFixture).not.toContain("threadId");
});
