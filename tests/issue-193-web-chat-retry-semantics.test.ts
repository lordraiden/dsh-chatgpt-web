/**
 * Issue #193 (P5) — the retryability DSH sees comes from the exchange rule.
 *
 * The DSH-facing adapter validated the sidecar's `retryable` flag and then dropped it, so DSH could
 * not tell a failure proven to be before submission from one whose submission may already have been
 * accepted. The failure now carries the retryability derived through the core's single rule
 * (`dshFailureSemanticsFor`), by submission state: `prepared` may be retried, `send_activated`
 * (ambiguous) and `accepted` (confirmed) never. Failures that report no submission evidence keep
 * exactly the shape they have today.
 */
import { describe, expect, test } from "bun:test";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

import {
  ChatGptWebLlmAdapter,
  CHATGPT_WEB_PROVIDER_ID,
  dshFailureRetryableOf,
} from "../src/adapters/chatgpt-web/llm-adapter";
import { dshFailureSemanticsForSubmission } from "../src/web-chat/host/dsh-integration";
import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

const PROVIDER = {
  adapter: "chatgpt-web",
  baseUrl: "https://chatgpt.com",
  defaultModel: "gpt-5.6-luna",
  models: ["gpt-5.6-luna"],
  liveModels: false,
  contextWindow: 1_050_000,
  modelInputModalities: { "gpt-5.6-luna": ["text", "image"] },
  modelReasoningEfforts: { "gpt-5.6-luna": ["low", "medium"] },
  modelDefaultReasoningEfforts: { "gpt-5.6-luna": "low" },
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

function scriptedBackend(events: AdapterEvent[]): ProviderAdapter {
  return {
    name: "chatgpt-web",
    async runTurn(_parsed, _incoming, emit) {
      for (const event of events) emit(event);
    },
  };
}

function userRequest(): GenerateOptions {
  return {
    provider: CHATGPT_WEB_PROVIDER_ID,
    model: "chatgpt-web/luna",
    messages: [
      {
        role: "user",
        id: "msg-1",
        source: { kind: "user" },
        content: [{ type: "text", text: "hola" }],
      } as unknown as GenerateOptions["messages"][number],
    ],
  };
}

async function finishFailure(events: AdapterEvent[]) {
  const adapter = new ChatGptWebLlmAdapter({
    loadProvider: () => PROVIDER,
    createBackend: () => scriptedBackend(events),
  });
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(userRequest())) chunks.push(chunk);
  const finish = chunks[chunks.length - 1];
  expect(finish?.type).toBe("finish");
  const reason = (finish as Extract<StreamChunk, { type: "finish" }>).reason;
  expect(reason.kind).toBe("error");
  return (reason as Extract<typeof reason, { kind: "error" }>).failure as {
    message: string;
    code: string;
    status?: number;
    retryable?: boolean;
  };
}

describe("issue #193 — the exchange rule owns DSH retryability", () => {
  test("only a pre-submission state is retryable", () => {
    const preSubmit = dshFailureSemanticsForSubmission({ phase: "prepared" });
    expect(preSubmit).toEqual({
      retryable: true,
      safety: "retry_safe",
      reason: "pre_submit",
      detail: "the failure is proven to be before submission",
    });

    const ambiguous = dshFailureSemanticsForSubmission({ phase: "send_activated" });
    expect(ambiguous.retryable).toBe(false);
    expect(ambiguous.safety).toBe("ambiguous");
    expect(ambiguous.reason).toBe("confirmed_or_ambiguous");
    expect(ambiguous.detail).toContain("may have accepted");

    const confirmed = dshFailureSemanticsForSubmission({ phase: "accepted" });
    expect(confirmed.retryable).toBe(false);
    expect(confirmed.safety).toBe("not_retry_safe");
    expect(confirmed.detail).toContain("never retried automatically");

    // Evidence that a retry is unsafe whatever the phase: partial output, or a retired conversation.
    expect(dshFailureSemanticsForSubmission({ phase: "prepared", partialOutputObserved: true }).retryable).toBe(false);
    expect(dshFailureSemanticsForSubmission({ phase: "prepared", retired: true }).retryable).toBe(false);
    expect(dshFailureSemanticsForSubmission({ phase: "prepared", state: "STREAMING" }).retryable).toBe(false);
    expect(dshFailureSemanticsForSubmission({ phase: "prepared", state: "SUBMISSION_AMBIGUOUS" }).retryable).toBe(false);
  });

  test("the adapter translates the provider's submission verdict into that state", () => {
    // Pre-submit proven: retryable.
    expect(dshFailureRetryableOf({ retryable: true })).toBe(true);
    // Confirmed or ambiguous: never retryable.
    expect(dshFailureRetryableOf({ retryable: false })).toBe(false);
    // An explicit submission state wins over the boolean verdict.
    expect(dshFailureRetryableOf({ retryable: true, phase: "send_activated" })).toBe(false);
    expect(dshFailureRetryableOf({ retryable: false, phase: "prepared" })).toBe(true);
    // No evidence: no retryability is invented.
    expect(dshFailureRetryableOf({})).toBeUndefined();
  });
});

describe("issue #193 — the failure DSH sees carries that retryability", () => {
  test("an error that reports a pre-submission state is retryable and otherwise unchanged", async () => {
    const failure = await finishFailure([
      { type: "error", message: "browser session lost", code: "browser_unavailable", status: 503, retryable: true },
    ]);
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("browser_unavailable");
    expect(failure.status).toBe(503);
    expect(failure.message).toBe("browser session lost");
  });

  test("an error after send_activated or acceptance is never retryable", async () => {
    const ambiguous = await finishFailure([
      { type: "error", message: "ChatGPT did not confirm that the prompt was sent.", code: "chatgpt_submission_ambiguous", status: 502, retryable: false },
    ]);
    expect(ambiguous.retryable).toBe(false);
    expect(ambiguous.code).toBe("chatgpt_submission_ambiguous");

    const confirmed = await finishFailure([
      { type: "error", message: "ChatGPT stopped responding after the task started.", code: "chatgpt_submitted_turn_failed", status: 502, retryable: false },
    ]);
    expect(confirmed.retryable).toBe(false);
    expect(confirmed.code).toBe("chatgpt_submitted_turn_failed");
  });

  test("an incomplete stream reports the same derived retryability", async () => {
    const retryable = await finishFailure([{ type: "incomplete", reason: "upstream_unavailable", retryable: true }]);
    expect(retryable.retryable).toBe(true);
    expect(retryable.code).toBe("PROVIDER_ERROR");

    const notRetryable = await finishFailure([{ type: "incomplete", reason: "submission_ambiguous", retryable: false }]);
    expect(notRetryable.retryable).toBe(false);
  });

  test("a failure without submission evidence keeps exactly today's shape", async () => {
    const failure = await finishFailure([
      { type: "error", message: "browser session lost", code: "browser_unavailable", status: 503 },
    ]);
    expect("retryable" in failure).toBe(false);
    expect(failure).toEqual({ message: "browser session lost", code: "browser_unavailable", status: 503 });

    // The failures the adapter itself produces (here: an unrepresentable request) are unchanged too.
    const options = userRequest();
    options.messages[0] = {
      role: "user",
      id: "msg-1",
      source: { kind: "user" },
      content: [{ type: "image", attachment: { attachmentId: "img-1" } }],
    } as unknown as GenerateOptions["messages"][number];
    const adapter = new ChatGptWebLlmAdapter({
      loadProvider: () => PROVIDER,
      createBackend: () => scriptedBackend([]),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(options)) chunks.push(chunk);
    const reason = (chunks[chunks.length - 1] as Extract<StreamChunk, { type: "finish" }>).reason;
    expect(reason.kind).toBe("error");
    if (reason.kind === "error") {
      expect(reason.failure).toEqual({
        message: expect.stringContaining("does not accept image input"),
        code: "UNSUPPORTED_OPTION",
      });
      expect("retryable" in reason.failure).toBe(false);
    }
  });
});
