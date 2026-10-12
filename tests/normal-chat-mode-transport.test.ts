import { describe, expect, test } from "bun:test";
import {
  chatGptWebProjectName,
  chatGptWebRepositoryUrl,
  compileChatGptWebContinuation,
  compileChatGptWebInstall,
  compileRetainedChatGptWebInstall,
} from "../src/adapters/chatgpt-web/prompt";
import { toCodexParsedRequest } from "../src/adapters/chatgpt-web/llm-adapter";
import { ADVISOR_REVIEWER_PERSONA, composeAdvisorReviewText, validateAdvisorReviewSource } from "../src/advisor";
import type { CodexMessage, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";

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


/**
 * The DSH host marks every context block it injects with its own `source.kind`, and every one of them
 * arrives as a *user-role* message. None of them is the conversation, and the one that happens to be
 * last must never become the provider input: that is what sent the harness's skills catalogue to
 * ChatGPT Web in place of the user's message.
 */
describe("DSH host context never becomes the provider turn", () => {
  const PROVIDER = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    defaultModel: "gpt-5.6-luna",
    models: ["gpt-5.6-luna"],
    liveModels: false,
    contextWindow: 1_050_000,
    modelInputModalities: { "gpt-5.6-luna": ["text"] },
    modelReasoningEfforts: { "gpt-5.6-luna": ["medium"] },
    modelDefaultReasoningEfforts: { "gpt-5.6-luna": "medium" },
    noReasoningModels: [],
    chatgptWeb: {
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      storageStatePath: "/tmp/chatgpt-state.json",
      chromeExecutablePath: "/usr/bin/chromium",
      brokerSocketPath: "/tmp/chatgpt-broker.sock",
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
    },
  } as unknown as CodexProviderConfig;

  const HARNESS_CONTEXT: ReadonlyArray<readonly [string, string]> = [
    ["Current runtime context. This snapshot supersedes earlier runtime-context.", "runtime-context"],
    ["<system-reminder>\nA skill is a reusable set of task-specific instructions.\n<available_skills>\n- `systematic-debugging`: ...\n</available_skills>\n</system-reminder>", "skill-catalog"],
    ["<hindsight_knowledge>\nThis repository has a Hindsight memory.\n</hindsight_knowledge>", "plugin:hindsight"],
    ["<AEGIS_DSH_ROUTING_BOOTSTRAP>\nYou have Aegis.\n</AEGIS_DSH_ROUTING_BOOTSTRAP>", "plugin:aegis"],
    ["Time sampled while preparing turn 1, step 1: 2026-10-12T21:19:42+02:00[Europe/Madrid]", "time-context"],
  ];

  function requestOptions(humanText: string, extra: ReadonlyArray<readonly [string, string]> = []): GenerateOptions {
    const message = (text: string, kind: string) => ({
      role: "user" as const,
      id: `msg-${kind}`,
      content: [{ type: "text" as const, text }],
      source: { kind },
    } as unknown as GenerateOptions["messages"][number]);
    return {
      provider: "chatgpt-web",
      model: "chatgpt-web/think",
      messages: [
        message(humanText, "user"),
        ...HARNESS_CONTEXT.map(([text, kind]) => message(text, kind)),
        ...extra.map(([text, kind]) => message(text, kind)),
      ],
    } as unknown as GenerateOptions;
  }

  const HEADER = 'Project: "dsh-chatgpt-web"\ngithub: "https://github.com/lordraiden/dsh-chatgpt-web"';

  test("the install is the project header plus the human message, and nothing the host injected", () => {
    const human = "esto es una prueba sé breve en la respuesta";
    const compiled = compileChatGptWebInstall(toCodexParsedRequest(requestOptions(human), PROVIDER));
    expect(compiled.text).toBe(`${HEADER}\n\n${human}`);
    for (const marker of ["<system-reminder>", "A skill is a reusable", "Current runtime context", "<hindsight", "<AEGIS_DSH_ROUTING_BOOTSTRAP>", "Time sampled"]) {
      expect(compiled.text).not.toContain(marker);
    }
  });

  test("the continuation carries the human message only", () => {
    const human = "no hagas nada simplemente dime hola";
    const compiled = compileChatGptWebContinuation(toCodexParsedRequest(requestOptions(human), PROVIDER));
    expect(compiled.text).toBe(human);
  });

  test("an unrecognized future injection is dropped instead of being sent", () => {
    const human = "sigue con lo tuyo";
    const compiled = compileChatGptWebContinuation(toCodexParsedRequest(
      requestOptions(human, [["<some_future_plugin_block>contenido</some_future_plugin_block>", "plugin:future-thing"]]),
      PROVIDER,
    ));
    expect(compiled.text).toBe(human);
  });

  test("host context inside the human message is stripped, and the message still arrives", () => {
    const human = "hola <system-reminder>catalogo interno</system-reminder> mundo";
    const compiled = compileChatGptWebContinuation(toCodexParsedRequest(requestOptions(human), PROVIDER));
    expect(compiled.text).toContain("hola");
    expect(compiled.text).toContain("mundo");
    expect(compiled.text).not.toContain("catalogo interno");
  });

  test("a turn whose only user message is host context fails closed instead of sending it", () => {
    const onlyHarness = {
      provider: "chatgpt-web",
      model: "chatgpt-web/think",
      messages: HARNESS_CONTEXT.map(([text, kind]) => ({
        role: "user" as const,
        id: `msg-${kind}`,
        content: [{ type: "text" as const, text }],
        source: { kind },
      } as unknown as GenerateOptions["messages"][number])),
    } as unknown as GenerateOptions;
    // The projection rejects a request whose every message is host context before any provider
    // prompt is compiled: fail closed, never "send the catalogue instead".
    expect(() => toCodexParsedRequest(onlyHarness, PROVIDER))
      .toThrow("did not receive any conversational messages");
  });
});
