import { strict as assert } from "node:assert";
import {
  BrowserAccountLeaseRegistry,
  ChatGptWebProviderCore,
} from "../src/adapters/chatgpt-web/provider-core";

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
  const turn = core.begin(leaseInput("state"));
  assert.equal(turn.snapshot().state, "LEASED");
  turn.markSurfaceReady();
  turn.markSendActivated();
  assert.equal(turn.snapshot().state, "SUBMITTED");
  assert.equal(turn.canAutomaticallyRetry(), false);
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
  turn.markSurfaceReady();
  turn.markSubmitted();
  turn.markRunning();

  let resolveSettlement!: () => void;
  const settlement = new Promise<void>(resolve => { resolveSettlement = resolve; });
  core.bindPhysicalSettlement(turn.provenance.executionKey, settlement);
  assert.equal(turn.snapshot().physicalSettlementAttached, true);
  assert.equal(turn.snapshot().physicalSettled, false);
  assert.equal(turn.lease.isActive(), true);

  resolveSettlement();
  await turn.waitForPhysicalSettlement();

  assert.equal(turn.snapshot().physicalSettled, true);
  assert.equal(turn.snapshot().state, "RETIRED");
  assert.equal(turn.lease.isActive(), false);
  assert.throws(() => turn.assertCanAct(), /retired/i);
  console.log("ok logical vs physical settlement");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("retry"));
  turn.markSurfaceReady();
  assert.equal(turn.canAutomaticallyRetry(), true);
  turn.markSendActivated();
  assert.equal(turn.canAutomaticallyRetry(), false);
  console.log("ok post-submit retry boundary");
}

{
  const core = new ChatGptWebProviderCore();
  const first = core.begin(leaseInput("resume"));
  const same = core.begin(leaseInput("resume"));
  assert.equal(first, same);
  assert.throws(
    () => first.assertNotSelfReentrant("native-resume"),
    /re-enter itself/i,
  );
  assert.equal(first.snapshot().recovery, "NEW");

  const resumed = core.begin({
    ...leaseInput("resume"),
    executionKey: "execution-resume-2",
    traceId: "trace-resume-2",
    nativeTurnId: "native-resume-2",
    recovery: "EXACT_RESUME",
  });
  assert.equal(resumed.snapshot().recovery, "EXACT_RESUME");
  resumed.markRecovery("REPLAY");
  assert.equal(resumed.snapshot().recovery, "REPLAY");
  resumed.markRecovery("FAILED");
  assert.equal(resumed.snapshot().recovery, "FAILED");
  console.log("ok continuity classification and reentrancy guard");
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
  registry.release(lease);
  assert.equal(registry.activeCount(), 0);
  console.log("ok browser/account lease ownership");
}

{
  const core = new ChatGptWebProviderCore();
  const turn = core.begin(leaseInput("preflight"));
  turn.markSurfaceReady();
  turn.failBeforePhysicalSettlement();
  assert.equal(turn.snapshot().state, "RETIRED");
  assert.equal(turn.snapshot().physicalSettled, true);
  assert.equal(turn.lease.isActive(), false);
  console.log("ok pre-browser failure retirement");
}

console.log("Issue #9 ProviderCore contract tests passed.");
