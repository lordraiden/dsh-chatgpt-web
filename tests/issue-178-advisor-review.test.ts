import { describe, expect, test } from "bun:test";
import {
  ADVISOR_INPUT_INVALID_CODE,
  ADVISOR_PRESET_LABEL_MAX,
  ADVISOR_TURN_FAILED_CODE,
  ADVISOR_SYSTEM_PROMPT,
  advisorConversationThread,
  buildAdvisorTurnRequest,
  composeAdvisorMessage,
  resolveAdvisorRouteSlug,
  runAdvisorReview,
  validateAdvisorReviewInput,
  type AdvisorRoute,
  type AdvisorTurnRunner,
} from "../src/adapters/chatgpt-web/advisor";
import {
  chatGptConversationKey,
  chatGptSystemFingerprint,
  resolveChatGptResumeBranch,
  systemFingerprintRecordedOnBranch,
} from "../src/adapters/chatgpt-web/conversation-key";
import {
  compileRetainedChatGptWebContinuation,
  compileRetainedChatGptWebInstall,
} from "../src/adapters/chatgpt-web/prompt";
import {
  chatGptWebExecutionNamespace,
  shouldRetainChatGptWebConversation,
} from "../src/adapters/chatgpt-web/index";
import { ChatGptTurnSessions, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const PROVIDER = { adapter: "chatgpt-web" as const, baseUrl: "http://127.0.0.1:17841" };
const NAMESPACE = chatGptWebExecutionNamespace(PROVIDER);
const SESSION = "dsh-session-abc";

const INPUT = {
  sessionId: SESSION,
  humanRequest: "Add a retry to the login flow",
  dshResponse: "I added a retry with exponential backoff in src/login.ts",
  instructions: "Review the retry implementation for correctness",
  mode: "normal" as const,
  project: "dsh-chatgpt-web",
};

const SOL_NORMAL: AdvisorRoute = { slug: "chatgpt-web/light", backendModel: "gpt-5.6-sol", effort: "low" };
const SOL_THINK: AdvisorRoute = { slug: "chatgpt-web/high", backendModel: "gpt-5.6-sol", effort: "high" };
const LUNA_NORMAL: AdvisorRoute = { slug: "chatgpt-web/luna", backendModel: "gpt-5.6-luna", effort: "low" };
const LUNA_THINK: AdvisorRoute = { slug: "chatgpt-web/think", backendModel: "gpt-5.6-luna", effort: "medium" };

function advisorKey(parsed: CodexParsedRequest): string | undefined {
  return chatGptConversationKey(parsed, NAMESPACE);
}

describe("issue #178 advisor payload", () => {
  test("the review message contains only project + instructions + human + response", () => {
    const text = composeAdvisorMessage(INPUT);
    expect(text).toContain('Project: "dsh-chatgpt-web"');
    expect(text).toContain("Review instructions:\nReview the retry implementation for correctness");
    expect(text).toContain("Human request:\nAdd a retry to the login flow");
    expect(text).toContain("DSH response:\nI added a retry with exponential backoff in src/login.ts");
  });

  test("the project line is omitted when no project is provided", () => {
    const text = composeAdvisorMessage({ ...INPUT, project: undefined });
    expect(text).not.toContain("Project:");
  });

  test("the turn request carries no tools, no full history, and no transport markers", () => {
    const parsed = buildAdvisorTurnRequest(INPUT, SOL_NORMAL, "review-1");
    expect(parsed.context.tools).toBeUndefined();
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]!.role).toBe("user");
    const content = parsed.context.messages[0]!.content as string;
    // No Aegis bootstrap, no Codex/bridge internals, no transport envelopes.
    expect(content).not.toContain("AEGIS_DSH_ROUTING_BOOTSTRAP");
    expect(content).not.toContain("<codex_context_json>");
    expect(content).not.toContain("<dsh_transport_resume>");
    // No absolute paths: the project is a name, and the content is the input verbatim.
    expect(content).not.toMatch(/\/home\/|\/Users\//);
    // The Advisor system block is the only system prompt.
    expect(parsed.context.systemPrompt).toEqual([ADVISOR_SYSTEM_PROMPT]);
    // The synthetic Advisor identity and the retention marker are present.
    expect(parsed._dshContext?.threadId).toBe(advisorConversationThread(SESSION));
    expect(parsed._dshContext?.turnId).toBe("review-1");
    expect(parsed._dshContext?.dshSessionId).toBe(SESSION);
    expect(parsed._advisorReview).toEqual({ reviewId: "review-1" });
    // The backend model + effort come from the resolved route.
    expect(parsed.modelId).toBe(SOL_NORMAL.backendModel);
    expect(parsed.options.reasoning).toBe(SOL_NORMAL.effort);
  });
});

describe("issue #178 advisor mode/model resolution", () => {
  test("normal/think resolve per resolved capability state", () => {
    expect(resolveAdvisorRouteSlug("normal", "supported")).toBe("chatgpt-web/light");
    expect(resolveAdvisorRouteSlug("think", "supported")).toBe("chatgpt-web/high");
    expect(resolveAdvisorRouteSlug("normal", "unsupported")).toBe("chatgpt-web/luna");
    expect(resolveAdvisorRouteSlug("think", "unsupported")).toBe("chatgpt-web/think");
    // No Pro/xhigh/max route ever surfaces for the Advisor.
    for (const slug of ["chatgpt-web/light", "chatgpt-web/high", "chatgpt-web/luna", "chatgpt-web/think"]) {
      expect(slug).not.toMatch(/xhigh|max/);
    }
  });

  test("an unknown Sol capability refuses model selection fail-closed", () => {
    expect(() => resolveAdvisorRouteSlug("normal", "unknown")).toThrow("Sol capability is unknown");
    expect(() => resolveAdvisorRouteSlug("think", "unknown")).toThrow("Sol capability is unknown");
  });

  test("the routes map to the expected backend models and efforts", () => {
    expect(SOL_NORMAL.backendModel).toBe("gpt-5.6-sol");
    expect(SOL_THINK.effort).toBe("high");
    expect(LUNA_NORMAL.backendModel).toBe("gpt-5.6-luna");
    expect(LUNA_THINK.effort).toBe("medium");
  });

  test("validateAdvisorReviewInput accepts a valid body and rejects invalid ones", () => {
    const ok = validateAdvisorReviewInput(INPUT);
    expect(ok.sessionId).toBe(SESSION);
    expect(ok.mode).toBe("normal");
    expect(() => validateAdvisorReviewInput({ ...INPUT, mode: "turbo" })).toThrow("mode");
    expect(() => validateAdvisorReviewInput({ ...INPUT, instructions: "" })).toThrow("instructions");
    expect(() => validateAdvisorReviewInput("nope")).toThrow("object");
    expect(ADVISOR_INPUT_INVALID_CODE).toBe("advisor_input_invalid");
  });

  test("a bare project name passes through unchanged", () => {
    expect(validateAdvisorReviewInput(INPUT).project).toBe("dsh-chatgpt-web");
    // Nested-style names (monorepo package paths) keep their last segment.
    expect(validateAdvisorReviewInput({ ...INPUT, project: "packages/web" }).project).toBe("web");
  });

  test("a local filesystem path is normalized to its name and never leaks the path", () => {
    const unix = validateAdvisorReviewInput({ ...INPUT, project: "/home/raiden/Documents/dsh-chatgpt-web" });
    expect(unix.project).toBe("dsh-chatgpt-web");
    expect(composeAdvisorMessage(unix)).not.toContain("/home/raiden");
    const win = validateAdvisorReviewInput({ ...INPUT, project: "C:\\repo\\dsh-chatgpt-web" });
    expect(win.project).toBe("dsh-chatgpt-web");
    // A name that resolves to nothing is omitted, mirroring the install.
    const empty = validateAdvisorReviewInput({ ...INPUT, project: "///" });
    expect(empty.project).toBeUndefined();
  });
});

describe("issue #178 advisor continuity and separation", () => {
  test("successive reviews of the same DSH session share the Advisor conversationKey", () => {
    const first = buildAdvisorTurnRequest(INPUT, SOL_NORMAL, "review-1");
    const second = buildAdvisorTurnRequest(
      { ...INPUT, humanRequest: "Another request", dshResponse: "Another response" },
      SOL_THINK,
      "review-2",
    );
    expect(advisorKey(first)).toBe(advisorKey(second));
    expect(advisorKey(first)).toBeDefined();
  });

  test("the Advisor conversation is retained and continues after the first review settles", () => {
    const sessions = new ChatGptTurnSessions();
    const first = buildAdvisorTurnRequest(INPUT, SOL_NORMAL, "review-1");
    const key = advisorKey(first)!;
    // The retention marker forces retention even in chat-only (no local tools) mode.
    expect(shouldRetainChatGptWebConversation(first, { localTools: false })).toBe(true);
    // First review: no fingerprint for the generation → install.
    const generation = sessions.conversationGeneration(key);
    expect(resolveChatGptResumeBranch(sessions, key, generation)).toBe("install");
    expect(systemFingerprintRecordedOnBranch("install")).toBe(true);
    // The settled install records the Advisor fingerprint for the generation.
    sessions.recordSentSystemFingerprint(key, generation, chatGptSystemFingerprint(first.context.systemPrompt));
    // Second review: the fingerprint exists → continue (only the new delta is sent).
    const second = buildAdvisorTurnRequest(
      { ...INPUT, humanRequest: "Another request", dshResponse: "Another response" },
      SOL_THINK,
      "review-2",
    );
    const key2 = advisorKey(second)!;
    expect(key2).toBe(key);
    expect(resolveChatGptResumeBranch(sessions, key2, sessions.conversationGeneration(key2))).toBe("continue");
    expect(systemFingerprintRecordedOnBranch("continue")).toBe(false);
  });

  test("the Advisor conversation never collides with the normal ChatGPT conversation of the same DSH chat", () => {
    const normal: CodexParsedRequest = {
      modelId: "gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      stream: true,
      options: {},
      _dshContext: { dshSessionId: SESSION, threadId: "normal-thread-123", turnId: "turn-1" },
    };
    const advisor = buildAdvisorTurnRequest(INPUT, SOL_NORMAL, "review-1");
    const normalKey = chatGptConversationKey(normal, NAMESPACE);
    const advisorKey = chatGptConversationKey(advisor, NAMESPACE);
    expect(normalKey).toBeDefined();
    expect(advisorKey).toBeDefined();
    expect(normalKey).not.toBe(advisorKey);
    // Installing the Advisor prefix does not touch the normal conversation's fingerprint state.
    const sessions = new ChatGptTurnSessions();
    const gen = sessions.conversationGeneration(advisorKey!);
    sessions.recordSentSystemFingerprint(advisorKey!, gen, chatGptSystemFingerprint(advisor.context.systemPrompt));
    expect(sessions.sentSystemFingerprint(normalKey!, sessions.conversationGeneration(normalKey!))).toBeUndefined();
    expect(resolveChatGptResumeBranch(sessions, normalKey!, sessions.conversationGeneration(normalKey!))).toBe("install");
  });
});

describe("issue #178 advisor no full history retransmission", () => {
  test("the first review installs the single composed message; a second review sends only its new delta", () => {
    const first = buildAdvisorTurnRequest(INPUT, SOL_NORMAL, "review-1");
    const install = compileRetainedChatGptWebInstall(first, {});
    expect(install.text).toContain(INPUT.humanRequest);
    expect(install.text).toContain(INPUT.instructions);

    const second = buildAdvisorTurnRequest(
      {
        ...INPUT,
        humanRequest: "Second request text",
        dshResponse: "Second response text",
        instructions: "Second review instructions",
      },
      SOL_THINK,
      "review-2",
    );
    const continuation = compileRetainedChatGptWebContinuation(second, {});
    // The continuation carries ONLY the new review content — not the first review's.
    expect(continuation.text).toContain("Second request text");
    expect(continuation.text).toContain("Second response text");
    expect(continuation.text).toContain("Second review instructions");
    expect(continuation.text).not.toContain(INPUT.humanRequest);
    expect(continuation.text).not.toContain(INPUT.dshResponse);
    expect(continuation.text).not.toContain(INPUT.instructions);
  });
});

describe("issue #178 advisor error handling", () => {
  function runner(events: AdapterEvent[], throwAfter?: Error): AdvisorTurnRunner {
    return {
      async runTurn(_parsed, _incoming, emit) {
        for (const event of events) emit(event);
        if (throwAfter) throw throwAfter;
      },
    };
  }

  test("a turn error becomes a typed ok:false result with no side effects", async () => {
    const result = await runAdvisorReview(
      runner([{ type: "text_delta", text: "partial " }, { type: "error", message: "browser turn failed" }]),
      INPUT,
      SOL_NORMAL,
      "review-err",
    );
    expect(result.ok).toBe(false);
    expect(result.reviewId).toBe("review-err");
    expect(result.mode).toBe("normal");
    expect(result.model).toBe(SOL_NORMAL.slug);
    expect(result.code).toBe(ADVISOR_TURN_FAILED_CODE);
    expect(result.message).toBe("browser turn failed");
    expect(result.text).toBeUndefined();
  });

  test("an incomplete turn is a typed failure", async () => {
    const result = await runAdvisorReview(
      runner([{ type: "incomplete", reason: "response cut short" }]),
      INPUT,
      SOL_THINK,
      "review-incomplete",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADVISOR_TURN_FAILED_CODE);
    expect(result.message).toBe("response cut short");
  });

  test("a throwing runner is a typed failure, never an unhandled rejection", async () => {
    const result = await runAdvisorReview(
      runner([], new Error("adapter exploded")),
      INPUT,
      LUNA_NORMAL,
      "review-throw",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADVISOR_TURN_FAILED_CODE);
    expect(result.message).toBe("adapter exploded");
  });

  test("a done turn without text is a typed failure", async () => {
    const result = await runAdvisorReview(
      runner([{ type: "done" }]),
      INPUT,
      LUNA_THINK,
      "review-empty",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADVISOR_TURN_FAILED_CODE);
    expect(result.message).toBe("Advisor turn produced no text");
  });

  test("a successful turn returns the review text, mode, model, and reviewId", async () => {
    const result = await runAdvisorReview(
      runner([{ type: "text_delta", text: "Verdict: " }, { type: "text_delta", text: "looks good." }, { type: "done" }]),
      { ...INPUT, mode: "think" },
      SOL_THINK,
      "review-ok",
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Verdict: looks good.");
    expect(result.mode).toBe("think");
    expect(result.model).toBe(SOL_THINK.slug);
    expect(result.reviewId).toBe("review-ok");
    expect(result.code).toBeUndefined();
  });

  test("the tracked execution signal is propagated into the turn's incoming meta", async () => {
    let observed: AbortSignal | undefined;
    const capturing: AdvisorTurnRunner = {
      async runTurn(_parsed, incoming, emit) {
        observed = incoming.abortSignal;
        emit({ type: "done" });
      },
    };
    const controller = new AbortController();
    await runAdvisorReview(capturing, INPUT, SOL_NORMAL, "review-signal", { abortSignal: controller.signal });
    expect(observed).toBe(controller.signal);
    // An already-aborted signal is forwarded verbatim (the adapter decides the outcome).
    const aborted = new AbortController();
    aborted.abort("client disconnected");
    const captured: { signal?: AbortSignal } = {};
    await runAdvisorReview(
      {
        async runTurn(_parsed, incoming, emit) {
          captured.signal = incoming.abortSignal;
          emit({ type: "done" });
        },
      },
      INPUT,
      SOL_NORMAL,
      "review-signal-aborted",
      { abortSignal: aborted.signal },
    );
    expect(captured.signal?.aborted).toBe(true);
    expect(captured.signal?.reason).toBe("client disconnected");
  });
});

describe("issue #208 advisor round identity", () => {
  test("an internal advisor turn resolves a round identity instead of failing", () => {
    // The reported failure: the round key demanded the complete native Responses input, which a
    // request built by `buildAdvisorTurnRequest` never carries, so the review never reached the
    // browser turn.
    const parsed = buildAdvisorTurnRequest(INPUT, LUNA_NORMAL, "review-round");
    expect(() => chatGptTurnRoundKey(parsed)).not.toThrow();
    const key = chatGptTurnRoundKey(parsed);
    // Same canonical review -> same round; a different review stays a different round.
    expect(chatGptTurnRoundKey(buildAdvisorTurnRequest(INPUT, LUNA_NORMAL, "review-round"))).toBe(key);
    const other = buildAdvisorTurnRequest(
      { ...INPUT, instructions: "Review it as a security engineer instead" },
      LUNA_NORMAL,
      "review-round",
    );
    expect(chatGptTurnRoundKey(other)).not.toBe(key);
  });

  test("a wire request without its complete input still fails closed", () => {
    const parsed = buildAdvisorTurnRequest(INPUT, LUNA_NORMAL, "review-wire");
    const wire = { ...parsed, _dshContext: undefined, _rawBody: { model: "gpt" } } as unknown as CodexParsedRequest;
    expect(() => chatGptTurnRoundKey(wire)).toThrow(/complete native Codex input/i);
  });

  test("a wire request keys by its own input, not by the canonical user revision", () => {
    const parsed = buildAdvisorTurnRequest(INPUT, LUNA_NORMAL, "review-input");
    const first = { ...parsed, _rawBody: { input: [{ role: "user", content: "one" }] } } as CodexParsedRequest;
    const second = { ...parsed, _rawBody: { input: [{ role: "user", content: "two" }] } } as CodexParsedRequest;
    expect(chatGptTurnRoundKey(first)).not.toBe(chatGptTurnRoundKey(second));
  });
});

describe("issue #208 advisor agent-preset context", () => {
  const WITH_PRESET = { ...INPUT, preset: "Senior reviewer" };

  test("the preset label is review context and never a DSH session", () => {
    const text = composeAdvisorMessage(WITH_PRESET);
    expect(text).toContain('Agent preset: "Senior reviewer"');
    const parsed = buildAdvisorTurnRequest(WITH_PRESET, LUNA_NORMAL, "review-preset");
    expect(parsed.context.messages[0]!.content).toContain('Agent preset: "Senior reviewer"');
    // The preset never changes the synthetic Advisor identity or the retention marker.
    expect(parsed._dshContext).toEqual({
      dshSessionId: SESSION,
      threadId: advisorConversationThread(SESSION),
      turnId: "review-preset",
    });
    expect(parsed._advisorReview).toEqual({ reviewId: "review-preset" });
  });

  test("the preset line is omitted when no preset is provided", () => {
    expect(composeAdvisorMessage(INPUT)).not.toContain("Agent preset:");
    expect(buildAdvisorTurnRequest(INPUT, LUNA_NORMAL, "review-none").context.messages[0]!.content)
      .not.toContain("Agent preset:");
  });

  test("validateAdvisorReviewInput trims, bounds and rejects an invalid preset", () => {
    expect(validateAdvisorReviewInput({ ...INPUT, preset: "  Senior reviewer  " })).toMatchObject({ preset: "Senior reviewer" });
    expect(validateAdvisorReviewInput(INPUT).preset).toBeUndefined();
    expect(() => validateAdvisorReviewInput({ ...INPUT, preset: "" })).toThrow(/preset/);
    expect(() => validateAdvisorReviewInput({ ...INPUT, preset: "   " })).toThrow(/preset/);
    expect(() => validateAdvisorReviewInput({ ...INPUT, preset: 42 })).toThrow(/preset/);
    expect(() => validateAdvisorReviewInput({ ...INPUT, preset: "x".repeat(ADVISOR_PRESET_LABEL_MAX + 1) }))
      .toThrow(/must not exceed/);
  });

  test("the successful result echoes the requested preset", async () => {
    const runner: AdvisorTurnRunner = {
      async runTurn(_parsed, _incoming, emit) {
        emit({ type: "text_delta", text: "review body" });
        emit({ type: "done" });
      },
    };
    const result = await runAdvisorReview(runner, WITH_PRESET, LUNA_NORMAL, "review-echo");
    expect(result.ok).toBe(true);
    expect(result.preset).toBe("Senior reviewer");
    expect(result.text).toBe("review body");
  });

  test("a failure without a preset stays preset-free", async () => {
    const result = await runAdvisorReview(
      { async runTurn(_parsed, _incoming, emit) { emit({ type: "error", message: "browser turn failed" }); } },
      INPUT,
      LUNA_NORMAL,
      "review-no-preset",
    );
    expect(result.ok).toBe(false);
    expect(result.preset).toBeUndefined();
  });
});
