import { strict as assert } from "node:assert";
import {
  BrowserAccountLeaseRegistry,
  ChatGptWebProviderCore,
} from "../src/adapters/chatgpt-web/provider-core";
import {
  ChatGptToolProtocolError,
  ChatGptToolStreamParser,
} from "../src/adapters/chatgpt-web/tool-stream-parser";

function leaseInput(turnId: string) {
  return {
    executionKey: `execution-${turnId}`,
    traceId: `trace-${turnId}`,
    nativeTurnId: `native-${turnId}`,
    nativeThreadId: "thread-1",
    accountIdentity: "account-1",
    browserProfile: "managed-chrome",
    browserContext: "context-1",
    pageIdentity: `page-${turnId}`,
  };
}

{
  const core = new ChatGptWebProviderCore();
  const unbound = core.begin(leaseInput("surface-before-bind"));
  assert.throws(
    () => unbound.markSurfaceReady(),
    /physical browser resource is bound/i,
  );
  unbound.failBeforePhysicalSettlement();
  console.log("ok surface readiness requires physical resource");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("state"));
  assert.equal(turn.snapshot().state, "LEASED");
  turn.bindPhysicalResource({
    resourceId: "surface-state",
    browserContextId: "ctx-state",
    pageId: "page-state",
    profileId: "profile-state",
    accountId: "account-state",
  });
  turn.markSurfaceReady();
  turn.markSendActivated();
  assert.equal(turn.snapshot().state, "SUBMITTED");
  assert.equal(turn.snapshot().submission, "send_activated");
  assert.equal(turn.canAutomaticallyRetry(), false);
  assert.throws(() => turn.markRunning(), /before submission is accepted/i);
  turn.markSubmitted();
  turn.markRunning();
  turn.markCapabilityWait();
  assert.equal(turn.snapshot().activity, "capability_wait");
  turn.markRunning();
  assert.equal(turn.snapshot().state, "RUNNING");
  await Promise.resolve();
  console.log("ok lifecycle state machine");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("settlement"));
  turn.bindPhysicalResource({
    resourceId: "surface-settlement",
    browserContextId: "ctx-settlement",
    pageId: "page-settlement",
    profileId: "profile-settlement",
    accountId: "account-settlement",
  });
  turn.markSurfaceReady();
  turn.markSubmitted();
  turn.markRunning();

  let resolveSettlement!: () => void;
  const settlement = new Promise<void>(resolve => { resolveSettlement = resolve; });
  core.bindPhysicalSettlement(turn.provenance.executionKey, settlement);
  assert.equal(turn.snapshot().physicalSettlementAttached, true);
  assert.equal(turn.snapshot().physicalSettlementOutcome, "pending");
  assert.equal(turn.snapshot().physicalSettled, false);
  assert.equal(turn.lease.isActive(), true);
  turn.markLogicalSettled("completed");
  assert.equal(turn.snapshot().logicalOutcome, "completed");

  resolveSettlement();
  await turn.waitForPhysicalSettlement();

  assert.equal(turn.snapshot().physicalSettled, true);
  assert.equal(turn.snapshot().physicalSettlementOutcome, "fulfilled");
  assert.equal(turn.snapshot().state, "RETIRED");
  assert.equal(turn.lease.isActive(), false);
  assert.throws(() => turn.assertCanAct(), /retired/i);
  console.log("ok logical vs physical settlement");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("settlement-failure"));
  turn.bindPhysicalResource({
    resourceId: "surface-settlement-failure",
    browserContextId: "ctx-settlement-failure",
    pageId: "page-settlement-failure",
    profileId: "profile-settlement-failure",
    accountId: "account-settlement-failure",
  });
  turn.markSurfaceReady();
  turn.markSubmitted();
  turn.markRunning();

  let rejectSettlement!: (error: Error) => void;
  const settlement = new Promise<void>((_resolve, reject) => { rejectSettlement = reject; });
  core.bindPhysicalSettlement(turn.provenance.executionKey, settlement);

  const settlementError = new Error("launcher /turn/end failed");
  rejectSettlement(settlementError);
  await assert.rejects(turn.waitForPhysicalSettlement(), /launcher \/turn\/end failed/);

  assert.equal(turn.snapshot().physicalSettled, true);
  assert.equal(turn.snapshot().physicalSettlementOutcome, "rejected");
  assert.equal(turn.snapshot().physicalSettlementError, settlementError.message);
  assert.equal(turn.snapshot().recovery, "FAILED");
  assert.equal(turn.snapshot().state, "RETIRED");
  assert.equal(turn.lease.isActive(), false);
  console.log("ok rejected physical settlement remains observable");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("retry"));
  turn.bindPhysicalResource({
    resourceId: "surface-retry",
    browserContextId: "ctx-retry",
    pageId: "page-retry",
    profileId: "profile-retry",
    accountId: "account-retry",
  });
  turn.markSurfaceReady();
  assert.equal(turn.canAutomaticallyRetry(), true);
  turn.authorizeSurfaceReplay();
  turn.markSendActivated();
  assert.equal(turn.canAutomaticallyRetry(), false);
  console.log("ok post-submit retry boundary");
}

{
  const core = new ChatGptWebProviderCore();
  const first = core.begin(leaseInput("resume"));
  const same = core.begin(leaseInput("resume"));
  assert.equal(first, same);
  assert.equal(first.snapshot().recovery, "NEW");
  assert.throws(
    () => core.begin({
      ...leaseInput("resume-conflict"),
      nativeThreadId: "thread-1",
    }),
    /second provider turn for an active native DSH thread/i,
  );
  first.failBeforePhysicalSettlement();

  const resumed = core.begin({
    ...leaseInput("resume-exact"),
    accountIdentity: "account-2",
    nativeThreadId: "thread-2",
    recovery: "EXACT_RESUME",
  });
  assert.equal(resumed.snapshot().recovery, "EXACT_RESUME");
  assert.throws(
    () => resumed.markRecovery("REPLAY"),
    /cannot downgrade exact resume to replay/i,
  );
  assert.equal(resumed.snapshot().recovery, "EXACT_RESUME");

  resumed.failBeforePhysicalSettlement();

  const replay = core.begin({
    ...leaseInput("resume-replay"),
    accountIdentity: "account-3",
    nativeThreadId: "thread-3",
    recovery: "REPLAY",
  });
  replay.markRecovery("FAILED");
  assert.equal(replay.snapshot().recovery, "FAILED");
  assert.throws(
    () => replay.markRecovery("REPLAY"),
    /cannot downgrade/i,
  );
  replay.failBeforePhysicalSettlement();
  console.log("ok monotonic continuity classification and native-thread isolation");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("late-callback"));
  turn.bindPhysicalResource({
    resourceId: "surface-late-callback",
    browserContextId: "ctx-late-callback",
    pageId: "page-late-callback",
    profileId: "profile-late-callback",
    accountId: "account-late-callback",
  });
  turn.markSurfaceReady();
  turn.markSubmitted();
  turn.markRunning();

  let resolveSettlement!: () => void;
  const settlement = new Promise<void>(resolve => { resolveSettlement = resolve; });
  core.bindPhysicalSettlement(turn.provenance.executionKey, settlement);
  resolveSettlement();
  await turn.waitForPhysicalSettlement();

  assert.equal(turn.snapshot().state, "RETIRED");
  assert.throws(() => turn.markRunning(), /cannot accept lifecycle mutations/i);
  assert.throws(() => turn.markCapabilityWait(), /cannot accept lifecycle mutations/i);
  assert.throws(() => turn.markRecovery("FAILED"), /cannot accept lifecycle mutations/i);
  assert.throws(() => turn.markLogicalSettled(), /cannot accept lifecycle mutations/i);
  console.log("ok late lifecycle callbacks fail closed");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("replay-guard"));
  turn.bindPhysicalResource({
    resourceId: "surface-replay",
    browserContextId: "ctx-replay",
    pageId: "page-replay",
    profileId: "profile-replay",
    accountId: "account-replay",
  });
  turn.markSurfaceReady();
  turn.markSendActivated();
  assert.equal(turn.canAutomaticallyRetry(), false);
  assert.throws(() => turn.authorizeSurfaceReplay(), /replay is forbidden/i);
  console.log("ok post-submit surface replay is forbidden");
}

{
  const registry = new BrowserAccountLeaseRegistry();
  const descriptor = {
    serviceId: "chatgpt-web",
    accountIdentity: "account-1",
    browserProfile: "profile-1",
    browserContext: "context-1",
    pageIdentity: "page-1",
    turnId: "trace-1",
  };
  const lease = registry.acquire(descriptor);
  assert.equal(registry.activeCount(), 1);
  assert.throws(() => registry.acquire(descriptor), /already leased/i);
  registry.bindPhysicalResource(lease, {
    resourceId: "surface-1",
    browserContextId: "ctx-1",
    pageId: "page-1",
    profileId: "profile-1",
    accountId: "account-1",
  });
  registry.bindPhysicalResource(lease, {
    resourceId: "surface-1",
    browserContextId: "ctx-1",
    pageId: "page-2",
    profileId: "profile-1",
    accountId: "account-1",
  });
  assert.throws(
    () => lease.bindPhysicalResource({
      resourceId: "surface-2",
      browserContextId: "ctx-2",
      pageId: "page-3",
      profileId: "profile-2",
      accountId: "account-2",
    }),
    /cannot move to a different physical resource/i,
  );
  assert.equal(lease.provenance().physicalResourceBound, true);

  assert.throws(
    () => registry.acquire({
      ...descriptor,
      pageIdentity: "page-account-conflict",
      turnId: "trace-account-conflict",
    }),
    /authenticated ChatGPT account is already leased/i,
  );

  const second = registry.acquire({
    ...descriptor,
    accountIdentity: "account-2",
    pageIdentity: "page-2",
    turnId: "trace-2",
  });
  assert.throws(
    () => registry.bindPhysicalResource(second, {
      resourceId: "surface-1",
      browserContextId: "ctx-1",
      pageId: "page-2",
      profileId: "profile-1",
      accountId: "account-1",
    }),
    /already leased by turn trace-1/i,
  );
  registry.release(second);
  registry.release(lease);
  assert.equal(registry.activeCount(), 0);
  console.log("ok browser/account lease physical ownership");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("preflight"));
  turn.bindPhysicalResource({
    resourceId: "surface-preflight",
    browserContextId: "ctx-preflight",
    pageId: "page-preflight",
    profileId: "profile-preflight",
    accountId: "account-preflight",
  });
  turn.markSurfaceReady();
  turn.failBeforePhysicalSettlement();
  assert.equal(turn.snapshot().state, "RETIRED");
  assert.equal(turn.snapshot().physicalSettled, true);
  assert.equal(turn.snapshot().physicalSettlementOutcome, "not_started");
  assert.equal(turn.snapshot().recovery, "FAILED");
  assert.equal(turn.lease.isActive(), false);
  console.log("ok pre-browser failure retirement");
}


{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin({
    ...leaseInput("side-effect-free"),
    retryPolicy: "side_effect_free",
  });
  turn.bindPhysicalResource({
    resourceId: "surface-side-effect-free",
    browserContextId: "ctx-side-effect-free",
    pageId: "page-side-effect-free",
    profileId: "profile-side-effect-free",
    accountId: "account-side-effect-free",
  });
  turn.markSurfaceReady();
  turn.markSendActivated();
  assert.equal(turn.canAutomaticallyRetry(), false);
  assert.throws(() => turn.authorizeSurfaceReplay(), /replay is forbidden/i);
  console.log("ok side-effect-free retry remains blocked after send activation");
}

{
  const parser = new ChatGptToolStreamParser();
  const parsed = parser.feed(
    'before<dsh_tool_call>{"version":1,"id":"call_12345678","name":"read","arguments":{"file_path":"README.md"}}</dsh_tool_call>after',
  );
  assert.equal(parsed.text, "beforeafter");
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]?.id, "call_12345678");
  assert.equal(parsed.toolCalls[0]?.name, "read");
  assert.equal(parsed.toolCalls[0]?.arguments.file_path, "README.md");

  const exactArguments = new ChatGptToolStreamParser().feed(
    '<dsh_tool_call>{"version":1,"id":"call_abcdefgh","name":"read","arguments":{"path":"README.md","justification":"read the file"}}</dsh_tool_call>',
  );
  assert.deepEqual(exactArguments.toolCalls[0]?.arguments, {
    path: "README.md",
    justification: "read the file",
  });

  assert.throws(
    () => parser.feed(
      '<dsh_tool_call>{"version":1,"id":"call_12345678","name":"read","arguments":{}}</dsh_tool_call>',
    ),
    ChatGptToolProtocolError,
  );

  const malformedClosed = new ChatGptToolStreamParser();
  assert.throws(
    () => malformedClosed.feed(
      '<dsh_tool_call>{"version":1,"id":"call_abcdefgh","name":"read"}</dsh_tool_call>',
    ),
    ChatGptToolProtocolError,
  );

  const incomplete = new ChatGptToolStreamParser();
  incomplete.feed('<dsh_tool_call>{"version":1,"id":"call_abcdefgh","name":"read","arguments":{}}');
  assert.throws(() => incomplete.flush(), ChatGptToolProtocolError);

  const wrongVersion = new ChatGptToolStreamParser();
  assert.throws(
    () => wrongVersion.feed(
      '<dsh_tool_call>{"version":2,"id":"call_abcdefgh","name":"read","arguments":{}}</dsh_tool_call>',
    ),
    ChatGptToolProtocolError,
  );

  const oversized = new ChatGptToolStreamParser();
  assert.throws(
    () => oversized.feed(
      '<dsh_tool_call>{"version":1,"id":"call_abcdefgh","name":"read","arguments":{"value":"'
      + "x".repeat(128 * 1024)
      + '"}}</dsh_tool_call>',
    ),
    ChatGptToolProtocolError,
  );
  console.log("ok strict tool control protocol");
}

console.log("Issue #9 ProviderCore contract tests passed.");
