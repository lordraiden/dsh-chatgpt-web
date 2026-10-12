import { describe, expect, test } from "bun:test";
import {
  chatGptWebProjectName,
  chatGptWebRepositoryUrl,
  compileChatGptWebContinuation,
  compileChatGptWebInstall,
  compileRetainedChatGptWebInstall,
} from "../src/adapters/chatgpt-web/prompt";
import { ADVISOR_SYSTEM_PROMPT, buildAdvisorTurnRequest } from "../src/adapters/chatgpt-web/advisor";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

/**
 * Normal Chat Mode is a minimal conversational transport: the deterministic
 * project header plus the current user message, then only the current user
 * message. Advisor Mode is a different feature with its own context.
 */

function parsed(messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "low" },
    context: { systemPrompt: ["ignored normal Chat system text"], messages },
  };
}

const user = (content: string): CodexMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (content: string): CodexMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  timestamp: 2,
});

describe("normal Chat Mode request contract", () => {
  test("the first message is the deterministic header plus the current user message only", () => {
    const compiled = compileChatGptWebInstall(parsed([
      user("old user message"),
      assistant("old assistant message"),
      user("current user message"),
    ]));
    expect(compiled.text).toBe(
      'Project: "dsh-chatgpt-web"\ngithub: "https://github.com/lordraiden/dsh-chatgpt-web"\n\ncurrent user message',
    );
    expect(compiled.text).not.toContain("old user message");
    expect(compiled.text).not.toContain("old assistant message");
    expect(compiled.text).not.toContain("ignored normal Chat system text");
    for (const marker of ["<codex_context_json>", "<dsh_transport_resume>"]) {
      expect(compiled.text).not.toContain(marker);
    }
  });

  test("subsequent messages carry only the current user message, and images stay projected", () => {
    const compiled = compileChatGptWebContinuation(parsed([
      user("old user message"),
      assistant("old assistant message"),
      {
        role: "user",
        content: [
          { type: "text", text: "current user message" },
          { type: "image", imageUrl: "https://example.com/image.png" },
        ],
        timestamp: 3,
      },
    ]));
    expect(compiled.text).toBe("current user message");
    expect(compiled.images).toHaveLength(1);
    expect(compiled.images[0]!.imageUrl).toBe("https://example.com/image.png");
    expect(compiled.text).not.toContain("old user message");
    expect(compiled.text).not.toContain("old assistant message");
    expect(compiled.text).not.toContain("Project:");
  });

  test("a compaction request is refused by the minimal Chat Mode compiler", () => {
    const compaction = parsed([user("hola")]);
    compaction._compactionRequest = true;
    expect(() => compileChatGptWebInstall(compaction)).toThrow("normal Chat Mode install");
    expect(() => compileChatGptWebContinuation(compaction)).toThrow("normal Chat Mode continuation");
  });
});

describe("deterministic repository identity", () => {
  test("the project name and repository URL come from authoritative package metadata", () => {
    expect(chatGptWebProjectName("@lordraiden/dsh-chatgpt-web")).toBe("dsh-chatgpt-web");
    expect(chatGptWebProjectName("packages/web")).toBe("web");
    expect(chatGptWebRepositoryUrl("git+https://github.com/lordraiden/dsh-chatgpt-web.git"))
      .toBe("https://github.com/lordraiden/dsh-chatgpt-web");
    expect(chatGptWebRepositoryUrl({ url: "https://github.com/lordraiden/dsh-chatgpt-web" }))
      .toBe("https://github.com/lordraiden/dsh-chatgpt-web");
  });

  test("unresolvable metadata is omitted instead of being fabricated", () => {
    expect(chatGptWebProjectName(undefined)).toBeUndefined();
    expect(chatGptWebProjectName("")).toBeUndefined();
    expect(chatGptWebRepositoryUrl(undefined)).toBeUndefined();
    expect(chatGptWebRepositoryUrl("")).toBeUndefined();
    expect(chatGptWebRepositoryUrl("git+ssh://git@github.com/lordraiden/dsh-chatgpt-web.git")).toBeUndefined();
    expect(chatGptWebRepositoryUrl("not a url")).toBeUndefined();
  });
});

describe("Chat Mode never inherits Advisor Mode context", () => {
  const ADVISOR_INPUT = {
    sessionId: "session-advisor-separation",
    humanRequest: "Add a retry to the login flow",
    dshResponse: "I added a retry with exponential backoff in src/login.ts",
    instructions: "Review the retry implementation for correctness",
    mode: "normal" as const,
    project: "dsh-chatgpt-web",
  };
  const ROUTE = { slug: "chatgpt-web/light", backendModel: "gpt-5.6-sol", effort: "low" as const };

  test("the Advisor install still carries the reviewer prompt and the review message", () => {
    const advisor = buildAdvisorTurnRequest(ADVISOR_INPUT, ROUTE, "review-1");
    const install = compileRetainedChatGptWebInstall(advisor, {});
    expect(install.text).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(install.text).toContain("Review the retry implementation for correctness");
    expect(install.text).toContain("Add a retry to the login flow");
  });

  test("the minimal Chat Mode install never contains Advisor-specific instructions", () => {
    const normal = compileChatGptWebInstall(parsed([user("hola")]));
    expect(normal.text).not.toContain(ADVISOR_SYSTEM_PROMPT);
    expect(normal.text).not.toContain("Review instructions:");
  });
});
