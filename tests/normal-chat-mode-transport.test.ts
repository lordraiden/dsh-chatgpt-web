import { describe, expect, test } from "bun:test";
import {
  chatGptWebProjectName,
  chatGptWebRepositoryUrl,
  compileChatGptWebContinuation,
  compileChatGptWebInstall,
  compileRetainedChatGptWebInstall,
} from "../src/adapters/chatgpt-web/prompt";
import { ADVISOR_REVIEWER_PERSONA, composeAdvisorReviewText, validateAdvisorReviewSource } from "../src/advisor";
import type { CodexMessage, CodexParsedRequest, CodexProviderConfig } from "../src/types";

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
  const ADVISOR_SOURCE = validateAdvisorReviewSource({
    sessionId: "session-advisor-separation",
    reviewedTurnId: "dsh-turn:1",
    humanRequest: "Add a retry to the login flow",
    dshResponse: "I added a retry with exponential backoff in src/login.ts",
    instructions: "Review the retry implementation for correctness",
    project: "dsh-chatgpt-web",
  });

  test("the Advisor install carries the reviewer prompt and the review message, never the Chat Mode header", () => {
    // Issue #224: the Advisor submits one portable ordinary user-text prompt — the persona is part of
    // the text, never a hidden system block — and the retained install passes exactly that text.
    const text = composeAdvisorReviewText(ADVISOR_SOURCE);
    const advisor = {
      modelId: "gpt-5.6-sol",
      stream: true,
      options: { reasoning: "low" },
      context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
      _dshContext: { dshSessionId: ADVISOR_SOURCE.sessionId, threadId: "advisor-session", turnId: "review-1" },
      _advisorReview: { reviewId: "review-1" },
    } as unknown as CodexParsedRequest;
    const install = compileRetainedChatGptWebInstall(advisor, {});
    expect(install.text).toContain(ADVISOR_REVIEWER_PERSONA);
    expect(install.text).toContain("Review the retry implementation for correctness");
    expect(install.text).toContain("Add a retry to the login flow");
    // The normal Chat Mode project header is never injected into an Advisor install.
    expect(install.text).not.toContain('github: "https://github.com/lordraiden/dsh-chatgpt-web"');
  });

  test("the minimal Chat Mode install never contains Advisor-specific instructions", () => {
    const normal = compileChatGptWebInstall(parsed([user("hola")]));
    expect(normal.text).not.toContain(ADVISOR_REVIEWER_PERSONA);
    expect(normal.text).not.toContain("Review instructions:");
  });
});

