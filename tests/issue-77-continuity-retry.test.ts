import { strict as assert } from "node:assert";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptWebRetry } from "../src/adapters/chatgpt-web/retry-policy";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { ChatGptWebProviderCore } from "../src/adapters/chatgpt-web/provider-core";
import type { CodexParsedRequest } from "../src/types";
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
  const capabilitySnapshot: CapabilitySnapshot = {
    snapshotId: "snapshot-77",
    sessionId: "session-77",
    agentId: "session-77",
    turnId: "turn-77",
    createdAt: Date.now(),
    lifecycle: "active",
    tools: [],
  };

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
  // A retryable browser error is logically settled after the physical cleanup completes.
  // The replacement turn must inherit the execution-scoped retry budget rather than reset it.
  first.markLogicalSettled("failed");
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

// ---------------------------------------------------------------------------------------------------
// Issue #287 slice 3 — the ProviderCore retry-budget semantics.
//
// Restored from the deleted `scripts/test-issue-9-provider-core.ts` ("default retry budget remains
// three automatic retries", "terminal retry decisions do not allocate retry budgets" and "retry
// budgets expire by TTL"), re-read against the owner as it is today rather than re-described from the
// old file: `DEFAULT_MAX_RETRY_ATTEMPTS` is 3 and `RETRY_BUDGET_TTL_MS` is 30 minutes. Both constants
// stay private to `provider-core.ts`; this suite pins their values so the public surface is not
// widened with test-only accessors.
// ---------------------------------------------------------------------------------------------------

const DEFAULT_ATTEMPT_BUDGET = 3;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;

function retryBudgetTurn(core: ChatGptWebProviderCore, executionKey: string) {
  const turn = core.begin({
    executionKey,
    traceId: `${executionKey}-trace`,
    nativeTurnId: `${executionKey}-native`,
    nativeThreadId: `${executionKey}-thread`,
    accountIdentity: "account-287-retry",
    browserProfile: "managed-chrome",
    browserContext: "context-287-retry",
    pageIdentity: `page-${executionKey}`,
    capabilitySnapshot: {
      snapshotId: `snapshot-${executionKey}`,
      sessionId: "session-287-retry",
      agentId: "session-287-retry",
      turnId: `${executionKey}-native`,
      createdAt: 1_700_000_000_000,
      lifecycle: "active",
      tools: [],
    },
    retryPolicy: "strict",
  });
  // A bound, ready surface is what makes this turn retryable at all.
  turn.bindPhysicalResource({
    resourceId: `surface-${executionKey}`,
    browserContextId: "context-287-retry",
    pageId: `page-${executionKey}`,
    profileId: "profile-287-retry",
    accountId: "chatgpt-account:account-287-retry",
  });
  turn.markSurfaceReady();
  return turn;
}

{
  const core = new ChatGptWebProviderCore();
  const executionKey = "issue-287-default-retry-budget";
  const now = 1_000_000;
  const turn = retryBudgetTurn(core, executionKey);

  // The whole default allowance is three recorded attempts, and the decision reports the bound.
  assert.equal(core.recordRetryAttempt(executionKey, turn, now).attempt, 1);
  assert.equal(core.recordRetryAttempt(executionKey, turn, now).attempt, 2);
  const third = core.recordRetryAttempt(executionKey, turn, now);
  assert.equal(third.attempt, 3);
  assert.equal(third.maxAttempts, DEFAULT_ATTEMPT_BUDGET);

  // The fourth is refused, names the budget, and never advances the count.
  const exhausted = core.recordRetryAttempt(executionKey, turn, now);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reason, "budget_exhausted");
  assert.equal(exhausted.attempt, DEFAULT_ATTEMPT_BUDGET);
  assert.equal(exhausted.maxAttempts, DEFAULT_ATTEMPT_BUDGET);
  assert.equal(core.retryDecision(executionKey, turn, now).allowed, false);
  assert.equal(core.retryDecision(executionKey, turn, now).attempt, DEFAULT_ATTEMPT_BUDGET);

  turn.failBeforePhysicalSettlement();
  console.log("ok the default attempt budget is three retries and a fourth refusal");
}

{
  const core = new ChatGptWebProviderCore();
  const executionKey = "issue-287-retry-budget-ttl";
  const base = 1_000_000;
  const turn = retryBudgetTurn(core, executionKey);

  assert.equal(core.recordRetryAttempt(executionKey, turn, base).attempt, 1);
  assert.equal(core.recordRetryAttempt(executionKey, turn, base).attempt, 2);
  assert.equal(core.recordRetryAttempt(executionKey, turn, base).attempt, 3);

  // One millisecond inside the window the allowance is still spent...
  const justInside = core.retryDecision(executionKey, turn, base + RETRY_BUDGET_TTL_MS - 1);
  assert.equal(justInside.allowed, false);
  assert.equal(justInside.reason, "budget_exhausted");

  // ...and at the window the budget is forgotten, so the same execution starts a fresh allowance.
  const atExpiry = core.retryDecision(executionKey, turn, base + RETRY_BUDGET_TTL_MS);
  assert.equal(atExpiry.allowed, true);
  assert.equal(atExpiry.attempt, 1);
  assert.equal(core.recordRetryAttempt(executionKey, turn, base + RETRY_BUDGET_TTL_MS).attempt, 1);

  turn.failBeforePhysicalSettlement();
  console.log("ok retry budgets expire by TTL");
}

{
  const core = new ChatGptWebProviderCore();
  const executionKey = "issue-287-terminal-retry-decision";
  const now = 1_000_000;
  const turn = retryBudgetTurn(core, executionKey);

  // A confirmed submission is the retry boundary: no second attempt is authorised.
  turn.markSubmitted();
  assert.equal(turn.snapshot().submission, "accepted");
  assert.equal(turn.canAutomaticallyRetry(), false);

  const decision = core.retryDecision(executionKey, turn, now);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "submitted");
  assert.equal(decision.attempt, 0);
  const recorded = core.recordRetryAttempt(executionKey, turn, now);
  assert.equal(recorded.allowed, false);
  assert.equal(recorded.reason, "submitted");

  // A terminal decision allocates no budget at all. An allocated-but-unspent budget is behaviourally
  // invisible (it reports the same attempt number), so the core's own map is the only observable of
  // the allocation itself — the deleted original read it the same way.
  const budgets = (core as unknown as { retryBudgets: Map<string, unknown> }).retryBudgets;
  assert.equal(budgets.has(executionKey), false);

  turn.failBeforePhysicalSettlement();
  console.log("ok a terminal decision consumes no budget and a confirmed submission is not retryable");
}

{
  const core = new ChatGptWebProviderCore();
  const executionKey = "issue-287-surface-replay-authorisation";
  const turn = retryBudgetTurn(core, executionKey);

  // Before any submission the automatic surface replay is authorised. The refusal below means
  // something only because this legitimate case is allowed.
  assert.equal(turn.canAutomaticallyRetry(), true);
  assert.doesNotThrow(() => turn.authorizeSurfaceReplay());

  // Once the send may have been activated, a duplicate submission is not authorised...
  turn.markSendActivated();
  assert.equal(turn.canAutomaticallyRetry(), false);
  assert.throws(() => turn.authorizeSurfaceReplay(), /replay is forbidden/i);

  // ...and a confirmed submission never restores it.
  turn.markSubmitted();
  assert.equal(turn.snapshot().submission, "accepted");
  assert.equal(turn.canAutomaticallyRetry(), false);
  assert.throws(() => turn.authorizeSurfaceReplay(), /replay is forbidden/i);

  turn.failBeforePhysicalSettlement();
  console.log("ok automatic surface replay is authorised only before submission");
}

