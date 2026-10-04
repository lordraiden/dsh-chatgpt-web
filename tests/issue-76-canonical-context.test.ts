import { expect, test } from "bun:test";
import {
  projectCanonicalChatGptWebContext,
  serializeCanonicalChatGptWebContext,
  withoutRetiredTurnHandles,
} from "../src/adapters/chatgpt-web/context-projection";
import type { CodexMessage } from "../src/types";

test("missing write.file_path is never inferred from surrounding user text", () => {
  const source: CodexMessage[] = [
    { role: "user", content: "Please update src/inferred.ts and docs/README.md.", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { contents: "payload" },
      }],
      timestamp: 2,
    },
  ];

  const projected = projectCanonicalChatGptWebContext([], source);
  const tool = (projected.messages[1]!.content as Array<Record<string, unknown>>)[0]!;

  expect(tool.arguments).toEqual({ contents: "payload" });
});

test("nested tool arguments remain exactly equal after canonical projection", () => {
  const argumentsValue = {
    file_path: "keep/me.txt",
    nested: {
      file_path: "nested.txt",
      handle: "__surface_handle",
      values: ["a", { __turn_handle: "user-authored" }],
    },
  };
  const source: CodexMessage[] = [{
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "tool-1",
      name: "custom_tool",
      arguments: structuredClone(argumentsValue),
    }],
    timestamp: 1,
  }];

  const projected = projectCanonicalChatGptWebContext([], source);
  const tool = (projected.messages[0]!.content as Array<Record<string, unknown>>)[0]!;

  expect(tool.arguments).toEqual(argumentsValue);
});

test("retired-handle scrubbing is limited to exact plugin-owned metadata keys", () => {
  const raw = JSON.stringify({
    metadata: {
      handle: "__turn_handle",
      literal: "turn_transport_abcdefghijklmnopqrstuvwxyz",
    },
    userPayload: {
      field: "__surface_handle",
      value: "user-authored",
    },
    __turn_handle: "owned-turn-handle",
    nested: { __request_handle: "owned-request-handle" },
  });

  const sanitized = JSON.parse(withoutRetiredTurnHandles(raw)) as Record<string, any>;

  expect(sanitized.metadata).toEqual({
    handle: "__turn_handle",
    literal: "turn_transport_abcdefghijklmnopqrstuvwxyz",
  });
  expect(sanitized.userPayload).toEqual({
    field: "__surface_handle",
    value: "user-authored",
  });
  expect(sanitized.__turn_handle).toBe("[retired transport handle]");
  expect(sanitized.nested.__request_handle).toBe("[retired transport handle]");
});

test("canonical serialization is deterministic across repeated replay", () => {
  const source: CodexMessage[] = [
    { role: "user", content: "same", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "src/a.ts", nested: { enabled: true } },
      }],
      timestamp: 2,
    },
  ];

  const first = serializeCanonicalChatGptWebContext(
    projectCanonicalChatGptWebContext([], source),
  );
  const second = serializeCanonicalChatGptWebContext(
    projectCanonicalChatGptWebContext([], structuredClone(source)),
  );

  expect(second).toBe(first);
});
