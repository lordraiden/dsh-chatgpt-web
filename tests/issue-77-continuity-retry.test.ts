import { strict as assert } from "node:assert";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptWebRetry } from "../src/adapters/chatgpt-web/retry-policy";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import type { CodexParsedRequest } from "../src/types";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";
import type { CapabilitySnapshot } from "../src/adapters/chatgpt-web/capability-projector";


function parsedWithoutTrustedEnvironment(): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/light",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _rawBody: {},
    _dshContext: undefined,
  };
}

const classified = classifyChatGptWebRetry(new ChatGptWebAdapterError("temporary", {
  status: 503,
  errorType: "server_error",
  code: "temporary",
  retryable: true,
}));
assert.equal(classified.retryable, true);
assert.equal(classified.status, 503);

const store = new ChatGptThreadEnvironmentStore();
const parsed = parsedWithoutTrustedEnvironment();
assert.throws(
  () => store.resolve(parsed),
  /trusted Codex cwd|environment|sandbox mode/i,
);

console.log("Issue #77 targeted retry classification and continuity fail-closed contracts passed.");


{
  const core = new ChatGptWebProviderCore();
  const executionKey = "issue-77-retry-budget";
  const capabilitySnapshot: CapabilitySnapshot = projectChatGptCapabilities({
    sessionId: "session-77",
    agentId: "session-77",
    turnId: "turn-77",
    tools: [],
  });

  const begin = () => core.begin({
    executionKey,
    traceId: "trace-77",
    nativeTurnId: "turn-77",
    nativeThreadId: "thread-77",
    accountIdentity: "account-77",
    browserProfile: "profile-77",
    browserContext: "context-77",
    pageIdentity: "page-77",
    capabilitySnapshot,
    retryPolicy: "strict",
  });

  const first = begin();
  let decision = core.retryDecision(executionKey, first, 1_000);
  assert.equal(decision.allowed, true);
  assert.equal(decision.attempt, 1);
  assert.equal(core.recordRetryAttempt(executionKey, first, 1_000).attempt, 1);

  core.bindPhysicalSettlement(executionKey, Promise.resolve());
  await core.waitForRetirement(executionKey);

  const second = begin();
  decision = core.retryDecision(executionKey, second, 2_000);
  assert.equal(decision.allowed, true);
  assert.equal(decision.attempt, 2);
  assert.equal(core.recordRetryAttempt(executionKey, second, 2_000).attempt, 2);

  assert.equal(
    core.retryDecision(executionKey, second, 3_000, 2).allowed,
    false,
    "a replacement ProviderTurn must not reset the execution-scoped retry budget",
  );
}

