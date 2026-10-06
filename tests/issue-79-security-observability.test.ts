import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  safeErrorDescriptor,
  safeTextDescriptor,
  toolCallDiagnosticSummary,
} from "../src/lib/safe-diagnostics";

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("issue #79 security and observability hardening", () => {
  test("tool diagnostics never serialize arguments or freeform input", () => {
    const calls = [
      { name: "exec_command", arguments: { command: "cat /secret.txt", token: "secret-value" } },
      { name: "view_image", input: "private image payload" },
      { name: "exec_command", arguments: { command: "echo second" } },
    ] as const;

    const summary = toolCallDiagnosticSummary(calls);
    expect(summary).toContain("count=3");
    expect(summary).toContain("exec_commandx2");
    expect(summary).toContain("view_image");
    expect(summary).toContain("argumentChars=");
    expect(summary).toContain("inputChars=");
    expect(summary).not.toContain("/secret.txt");
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("private image payload");
  });

  test("error diagnostics preserve stable identity but never expose the error message", () => {
    const descriptor = safeErrorDescriptor({
      name: "ChatGptWebAdapterError",
      code: "provider_timeout",
      errorType: "server_error",
      status: 504,
      message: "prompt text and tool output must not be logged",
    });

    expect(descriptor).toContain("name=ChatGptWebAdapterError");
    expect(descriptor).toContain("code=provider_timeout");
    expect(descriptor).toContain("type=server_error");
    expect(descriptor).toContain("status=504");
    expect(descriptor).not.toContain("prompt text");
    expect(descriptor).not.toContain("tool output");
  });

  test("arbitrary sidecar text is represented only by safe metadata", () => {
    const descriptor = safeTextDescriptor("browser credential and tool output");
    expect(descriptor).toMatch(/^chars=\d+ fp=[a-f0-9]{12}$/);
    expect(descriptor).not.toContain("browser credential");
    expect(descriptor).not.toContain("tool output");
  });

  test("browser account binding uses authenticated session identity, not mutable storage-state hashing", () => {
    const runtime = source("src/adapters/chatgpt-web/browser-worker.ts");
    expect(runtime).toContain("detectChatGptAuthenticatedAccountIdentity(page)");
    expect(runtime).not.toContain("accountIdentityFromStorageState(storageState)");
  });

  test("runtime log sites do not contain known raw payload/error patterns", () => {
    const runtime = [
      source("src/adapters/chatgpt-web/index.ts"),
      source("src/adapters/chatgpt-web/browser-worker.ts"),
      source("src/adapters/chatgpt-web/turn-broker.ts"),
      source("src/plugin.ts"),
      source("src/server.ts"),
    ].join("\n");
    const lines = runtime.split("\n");
    const logCalls = lines.flatMap((line, index) => {
      if (!/(?:console|logger)\.(?:log|info|warn|error|debug)\s*\(/.test(line)) return [];
      return [lines.slice(index, Math.min(index + 5, lines.length)).join("\n")];
    }).join("\n");

    expect(logCalls).not.toContain("JSON.stringify(collectedToolCalls)");
    expect(logCalls).not.toContain("[sidecar] ${text}");
    expect(logCalls).not.toContain("[sidecar:err] ${text}");
    expect(logCalls).not.toContain("controlError.message");
    expect(logCalls).not.toContain("captureError.message");
    expect(logCalls).not.toContain("surfacedError instanceof Error ? surfacedError.message");
    expect(logCalls).not.toContain("error instanceof Error ? error.message : String(error)");
    expect(logCalls).not.toContain("failure instanceof Error ? failure.message : String(failure)");
    expect(logCalls).not.toContain("String(result.reason)");

  });
});
