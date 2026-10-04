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



test("canonical projection never infers a missing write.file_path from user text", () => {
  const source: CodexMessage[] = [
    { role: "user", content: "Please update src/inferred.ts and read docs/README.md", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: {
          contents: "keep this payload unchanged",
          nested: { file_path: "user-authored/nested.txt", value: "untouched" },
        },
      }],
      timestamp: 2,
    },
  ];
  const projected = projectCanonicalChatGptWebContext([], source);
  expect(projected.messages[1]!.content).toEqual([{
    type: "tool_call",
    id: "write-1",
    name: "write",
    arguments: {
      contents: "keep this payload unchanged",
      nested: { file_path: "user-authored/nested.txt", value: "untouched" },
    },
  }]);
});

test("missing write.file_path remains missing even when user text contains a filename", () => {
  const source: CodexMessage[] = [
    { role: "user", content: "Edit AGENTS.md before continuing.", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-2",
        name: "write",
        arguments: { contents: "payload" },
      }],
      timestamp: 2,
    },
  ];
  const projected = projectCanonicalChatGptWebContext([], source);
  const call = (projected.messages[1]!.content as Array<Record<string, unknown>>)[0]!;
  expect(call.arguments).toEqual({ contents: "payload" });
});

test("retired-handle scrubbing does not mutate similarly named user data", () => {
  const raw = JSON.stringify({
    metadata: {
      handle: "__turn_handle",
      value: "__request_handle",
    },
    userPayload: {
      fieldName: "__turn_handle",
      literal: "turn_transport_abcdefghijklmnopqrstuvwxyz",
    },
    __turn_handle: "owned-turn-handle",
  });
  const sanitized = JSON.parse(withoutRetiredTurnHandles(raw)) as Record<string, any>;
  expect(sanitized.metadata).toEqual({
    handle: "__turn_handle",
    value: "__request_handle",
  });
  expect(sanitized.userPayload).toEqual({
    fieldName: "__turn_handle",
    literal: "turn_transport_abcdefghijklmnopqrstuvwxyz",
  });
  expect(sanitized.__turn_handle).toBe("[retired transport handle]");
});

test("nested tool arguments survive canonical projection without semantic mutation", () => {
  const argumentsValue = {
    request: {
      file_path: "keep/me.txt",
      nested: { arbitrary: ["a", { handle: "__surface_handle", file_path: "nested.md" }] },
    },
    __turn_handle: "user-authored-field",
  };
  const source: CodexMessage[] = [{
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "nested-1",
      name: "custom_tool",
      arguments: structuredClone(argumentsValue),
    }],
    timestamp: 1,
  }];
  const projected = projectCanonicalChatGptWebContext([], source);
  const call = (projected.messages[0]!.content as Array<Record<string, unknown>>)[0]!;
  expect(call.arguments).toEqual(argumentsValue);
});

test("reprojecting the same canonical DSH history is replay-stable", () => {
  const source = sampleMessages();
  const first = serializeCanonicalChatGptWebContext(projectCanonicalChatGptWebContext(["sys"], source));
  const second = serializeCanonicalChatGptWebContext(projectCanonicalChatGptWebContext(["sys"], structuredClone(source)));
  expect(second).toBe(first);
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
