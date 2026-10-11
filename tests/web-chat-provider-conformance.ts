import { describe, expect, test } from "bun:test";

import {
  assertWebChatReplayStateOwner,
  resolveWebChatContinuation,
  webChatAccountBindingId,
  webChatAffinityKey,
  webChatContinuationIdentity,
  type WebChatConversation,
  type WebChatConversationRecord,
  type WebChatConversationSelection,
  type WebChatConversationStore,
  type WebChatErrorCategory,
  type WebChatExchangeEvent,
  type WebChatProviderDriver,
  type WebChatReplayMessage,
  type WebChatTurnIdentity,
} from "../src/web-chat/core";
import {
  createWebChatExchange,
  createWebChatTransportLeaseRegistry,
  type WebChatTextTransport,
} from "../src/web-chat/transport";

/** Semantic failure modes the provider fixture must drive through its real turn path. */
export type WebChatProviderConformanceScenario =
  | "success"
  | "cancel_active"
  | "authentication_loss"
  | "provider_error"
  | "partial_failure"
  | "ambiguous_submission";

/** Provider-neutral observations collected by the provider-specific test fixture. */
export interface WebChatProviderConformanceTurn {
  readonly outcome: "completed" | "cancelled" | "failed";
  readonly eventTypes: readonly string[];
  readonly text: string;
  /** Send activations, including ambiguous sends; not the count of confirmed submissions. */
  readonly sendAttempts: number;
  readonly confirmedSubmissions: number;
  readonly retryable?: boolean;
  readonly failureCategory?: WebChatErrorCategory;
  readonly record?: WebChatConversationRecord;
  /** Opaque provider-side lineage evidence; the shared suite compares but never interprets it. */
  readonly lineageToken?: unknown;
  /** Whether this turn actually reused the preceding provider conversation, when observable. */
  readonly remoteConversationReused?: boolean;
  /** Canonical text the provider fixture observed after an explicit replay, if applicable. */
  readonly compiledPrompt?: string;
}

export interface WebChatProviderConformanceModelCase {
  /** Public route already selected by DSH. */
  readonly route: string;
  /** Provider-local descriptor id. */
  readonly descriptorId: string;
  /** A route this deployment does not serve. */
  readonly unsupportedRoute: string;
  /** The selected mode this route supports, when any. */
  readonly supportedReasoningMode?: string;
  /** A selected mode this route must reject. */
  readonly unsupportedReasoningMode: string;
}

/**
 * Test-only seam for a real provider implementation. `runNativeTurn` must exercise the provider's
 * actual adapter/continuity path; only physical web I/O may be controlled by the fixture. A future
 * provider can implement this shape without importing or emulating ChatGPT internals.
 */
export interface WebChatProviderConformanceHarness {
  readonly driver: WebChatProviderDriver;
  readonly store: WebChatConversationStore;
  readonly selection: WebChatConversationSelection;
  readonly namespace: string;
  readonly model: WebChatProviderConformanceModelCase;
  /** Recovery the provider actually supports after process state is lost. */
  readonly restartRecovery: "exact_resume" | "explicit_replay" | "unsupported";
  runNativeTurn(input: {
    readonly selection: WebChatConversationSelection;
    readonly turnId: string;
    readonly userText: string;
    readonly history?: readonly WebChatReplayMessage[];
    readonly scenario?: WebChatProviderConformanceScenario;
  }): Promise<WebChatProviderConformanceTurn>;
  /** Recreate process-owned driver/adapter state while preserving only configured durable state. */
  restart(): Promise<WebChatProviderConformanceHarness>;
  /** Exercise a late event from a settled native turn and report whether it contaminates a later turn. */
  assertStaleNativeTurnIsolated(): Promise<boolean>;
  /** Release driver, adapter and provider-owned test resources; must be idempotent. */
  shutdown(): Promise<void>;
}

export interface WebChatProviderConformanceFixture {
  readonly name: string;
  create(): Promise<WebChatProviderConformanceHarness>;
}

async function withHarness<T>(
  fixture: WebChatProviderConformanceFixture,
  run: (harness: WebChatProviderConformanceHarness, track: (next: WebChatProviderConformanceHarness) => void) => Promise<T>,
): Promise<T> {
  const environments: WebChatProviderConformanceHarness[] = [await fixture.create()];
  try {
    return await run(environments[0]!, next => environments.push(next));
  } finally {
    for (const environment of [...environments].reverse()) await environment.shutdown();
  }
}

function selectionWithAccount(
  selection: WebChatConversationSelection,
  accountFingerprint: string,
): WebChatConversationSelection {
  const binding = { ...selection.binding, accountFingerprint };
  return {
    ...selection,
    binding,
    affinity: { ...selection.affinity, bindingId: webChatAccountBindingId(binding) },
  };
}

function selectionWithSession(
  selection: WebChatConversationSelection,
  sessionId: string,
): WebChatConversationSelection {
  return {
    ...selection,
    dshSession: { ...selection.dshSession, sessionId },
    affinity: { ...selection.affinity, threadId: `${selection.affinity.threadId}:${sessionId}` },
  };
}

function conversationIdentity(conversation: WebChatConversation) {
  return {
    providerId: conversation.providerId,
    bindingId: conversation.bindingId,
    key: conversation.key,
  };
}

function continuationInput(
  harness: WebChatProviderConformanceHarness,
  record: WebChatConversationRecord,
  intent:
    | { readonly kind: "continue" }
    | { readonly kind: "replay"; readonly history: readonly WebChatReplayMessage[]; readonly reason: string },
) {
  const { selection } = harness;
  return {
    binding: selection.binding,
    dshSession: selection.dshSession,
    threadId: selection.affinity.threadId,
    namespace: harness.namespace,
    model: harness.model.route,
    ...(selection.reasoningMode !== undefined ? { reasoningMode: selection.reasoningMode } : {}),
    expectedGeneration: record.generation,
    intent: intent.kind === "continue"
      ? intent
      : { ...intent, expectedGeneration: record.generation },
  };
}

function turnIdentity(harness: WebChatProviderConformanceHarness, conversation: WebChatConversation, turnId: string): WebChatTurnIdentity {
  return {
    dshSessionId: harness.selection.dshSession.sessionId,
    bindingId: conversation.bindingId,
    conversationKey: conversation.key,
    turnId,
  };
}

function scriptedTransport(events: readonly WebChatExchangeEvent[] = []) {
  const calls = { settle: 0, abort: 0 };
  const transport: WebChatTextTransport = {
    id: "issue-194-contract-transport",
    async ready() {},
    async submit() { return "accepted"; },
    async *stream() { for (const event of events) yield event; },
    async settle() { calls.settle += 1; return "fulfilled"; },
    async abort() { calls.abort += 1; },
  };
  return { transport, calls };
}

/** Register shared semantic assertions against one provider's actual native turn path. */
export function defineWebChatProviderConformanceSuite(fixture: WebChatProviderConformanceFixture): void {
  describe(`issue #194 — ${fixture.name} WebChat provider conformance`, () => {
    test("authentication readiness and model/reasoning compatibility are explicit", async () => {
      await withHarness(fixture, async ({ driver, model }) => {
        const account = await driver.inspectAccount();
        expect(account.authenticated).toBe(true);
        expect((await driver.health()).ok).toBe(true);

        const models = await driver.listModels();
        const descriptor = models.find(candidate => candidate.id === model.descriptorId);
        expect(descriptor).toBeDefined();
        expect(descriptor?.id).not.toBe(model.route);
        expect((await driver.resolveModel(model.route))?.id).toBe(model.descriptorId);
        expect(await driver.resolveModel(model.unsupportedRoute)).toBeUndefined();
        if (model.supportedReasoningMode !== undefined) {
          expect(descriptor?.reasoningModes).toContain(model.supportedReasoningMode);
          expect((await driver.resolveModel(model.route, model.supportedReasoningMode))?.id).toBe(model.descriptorId);
        }
        expect(await driver.resolveModel(model.route, model.unsupportedReasoningMode)).toBeUndefined();
      });
    });

    test("account and DSH-session identities produce isolated affinities", async () => {
      await withHarness(fixture, async ({ driver, selection }) => {
        const base = await driver.createConversation(selection);
        const otherAccount = await driver.createConversation(
          selectionWithAccount(selection, `${selection.binding.accountFingerprint}:other`),
        );
        const otherSession = await driver.createConversation(
          selectionWithSession(selection, `${selection.dshSession.sessionId}:other`),
        );
        expect(new Set([base.key, otherAccount.key, otherSession.key]).size).toBe(3);
        expect(new Set([base.handle, otherAccount.handle, otherSession.handle]).size).toBe(3);
        expect(base.providerId).toBe(driver.id);
        expect(base.bindingId).toBe(webChatAccountBindingId(selection.binding));
      });
    });

    test("durable records and opaque replay state reject cross-provider reuse", async () => {
      await withHarness(fixture, async harness => {
        const { selection } = harness;
        const turn = await harness.runNativeTurn({
          selection,
          turnId: "provider-scope-turn",
          userText: "provider-scoped conversation",
          history: [{ role: "user", text: "provider-scoped conversation" }],
          scenario: "success",
        });
        const record = turn.record;
        expect(record).toBeDefined();
        if (!record) return;

        const peerProviderId = `${record.identity.providerId}:peer`;
        const peerBinding = { ...selection.binding, providerId: peerProviderId };
        const peerIdentity = webChatContinuationIdentity({
          binding: peerBinding,
          dshSession: selection.dshSession,
          threadId: selection.affinity.threadId,
          namespace: harness.namespace,
        });
        expect(await harness.store.read(record.identity)).toEqual(record);
        expect(peerIdentity.providerId).toBe(peerProviderId);
        expect(peerIdentity.key).not.toBe(record.identity.key);
        expect(await harness.store.read(peerIdentity)).toBeUndefined();

        const replayState = {
          providerId: record.identity.providerId,
          bindingId: record.identity.bindingId,
          conversationKey: record.identity.key,
          detail: record.handle,
        };
        expect(() => assertWebChatReplayStateOwner(replayState, {
          providerId: peerProviderId,
          bindingId: record.identity.bindingId,
          conversationKey: record.identity.key,
        })).toThrow(/Replay state does not belong/);
      });
    });

    test("the real provider path preserves lineage across first, second and third turns", async () => {
      await withHarness(fixture, async (harness) => {
        const { selection, model } = harness;
        const identity = {
          providerId: selection.binding.providerId,
          bindingId: webChatAccountBindingId(selection.binding),
          key: webChatAffinityKey({
            providerId: selection.affinity.providerId,
            bindingId: selection.affinity.bindingId,
            dshSessionId: selection.dshSession.sessionId!,
            threadId: selection.affinity.threadId,
            namespace: harness.namespace,
          }),
        };
        expect(await harness.store.read(identity)).toBeUndefined();

        const history: WebChatReplayMessage[] = [];
        const observations: WebChatProviderConformanceTurn[] = [];
        for (const turnId of ["turn-1", "turn-2", "turn-3"]) {
          const userText = `conformance ${turnId}`;
          history.push({ role: "user", text: userText });
          const observation = await harness.runNativeTurn({
            selection,
            turnId,
            userText,
            history,
            scenario: "success",
          });
          observations.push(observation);
          if (observation.outcome === "completed") history.push({ role: "assistant", text: observation.text });
        }

        const [first, second, third] = observations;
        expect(first?.outcome).toBe("completed");
        expect(second?.outcome).toBe("completed");
        expect(third?.outcome).toBe("completed");
        expect(first?.lineageToken).toBeDefined();
        expect(first?.text.length).toBeGreaterThan(0);
        expect(second?.compiledPrompt).toBe("conformance turn-2");
        expect(third?.compiledPrompt).toBe("conformance turn-3");
        for (const [index, observation] of observations.entries()) {
          expect(observation.eventTypes).toContain("text_delta");
          expect(observation.eventTypes).toContain("completed");
          expect(observation.sendAttempts).toBe(1);
          expect(observation.confirmedSubmissions).toBe(1);
          expect(observation.record?.checkpoint).toBe("confirmed");
          expect(observation.record?.lastConfirmedTurn?.turnId).toBe(`turn-${index + 1}`);
          expect(observation.record?.identity.key).toBe(identity.key);
          expect(observation.record?.identity.providerId).toBe(driverIdOf(harness));
          expect(observation.record?.identity.bindingId).toBe(identity.bindingId);
          expect(observation.record?.generation).toBe(first?.record?.generation);
          expect(observation.record?.handle).toBe(first?.record?.handle);
          expect(observation.lineageToken).toBe(first?.lineageToken);
          expect(observation.remoteConversationReused).toBe(index > 0);
        }

        const conversation = await harness.driver.createConversation(selection);
        const assessed = await harness.driver.assessConversation({ ...selection, model: model.route, conversation });
        expect(assessed.status).toBe("resumable");
        const exact = await resolveWebChatContinuation({ store: harness.store, driver: harness.driver },
          continuationInput(harness, first!.record!, { kind: "continue" }));
        expect(exact.outcome).toBe("exact_resume");
        expect(exact.conversation?.key).toBe(identity.key);
        expect(exact.conversation?.handle).toBe(first?.record?.handle);
      });
    });

    test("cancellation, provider errors, partial output and ambiguous sends are classified safely", async () => {
      const scenarios: Array<{
        scenario: WebChatProviderConformanceScenario;
        outcome: "cancelled" | "failed";
        sendAttempts: number;
        confirmedSubmissions: number;
        retryable: boolean;
        partial?: boolean;
      }> = [
        { scenario: "cancel_active", outcome: "cancelled", sendAttempts: 1, confirmedSubmissions: 1, retryable: false },
        { scenario: "authentication_loss", outcome: "failed", sendAttempts: 0, confirmedSubmissions: 0, retryable: false },
        { scenario: "provider_error", outcome: "failed", sendAttempts: 1, confirmedSubmissions: 1, retryable: false },
        { scenario: "partial_failure", outcome: "failed", sendAttempts: 1, confirmedSubmissions: 1, retryable: false, partial: true },
        { scenario: "ambiguous_submission", outcome: "failed", sendAttempts: 1, confirmedSubmissions: 0, retryable: false },
      ];

      for (const item of scenarios) {
        await withHarness(fixture, async (harness) => {
          const scenarioSelection = {
            ...harness.selection,
            dshSession: { ...harness.selection.dshSession, sessionId: `${harness.selection.dshSession.sessionId}:${item.scenario}` },
            affinity: { ...harness.selection.affinity, threadId: `${harness.selection.affinity.threadId}:${item.scenario}` },
          };
          const result = await harness.runNativeTurn({
            selection: scenarioSelection,
            turnId: `scenario-${item.scenario}`,
            userText: "semantic failure probe",
            history: [{ role: "user", text: "semantic failure probe" }],
            scenario: item.scenario,
          });
          expect(result.outcome).toBe(item.outcome);
          expect(result.sendAttempts).toBe(item.sendAttempts);
          expect(result.confirmedSubmissions).toBe(item.confirmedSubmissions);
          if (result.retryable !== item.retryable) {
            throw new Error(`${item.scenario}: expected retryable=${item.retryable}, got ${String(result.retryable)} (${result.eventTypes.join(",")})`);
          }
          if (item.partial) expect(result.eventTypes).toContain("text_delta");
          expect(result.eventTypes).toContain(item.outcome === "cancelled" ? "cancelled" : "error");
        });
      }
    });

    test("lost process-local continuity fails closed until explicit replay is selected", async () => {
      await withHarness(fixture, async (beforeRestart, track) => {
        const first = await beforeRestart.runNativeTurn({
          selection: beforeRestart.selection,
          turnId: "turn-before-loss",
          userText: "canonical history before restart",
          history: [{ role: "user", text: "canonical history before restart" }],
          scenario: "success",
        });
        expect(first.record).toBeDefined();
        const restarted = await beforeRestart.restart();
        track(restarted);
        const record = first.record!;

        const implicit = await resolveWebChatContinuation(
          { store: restarted.store, driver: restarted.driver },
          continuationInput(restarted, record, { kind: "continue" }),
        );
        expect(implicit.outcome).toBe("failed");

        const replay = await resolveWebChatContinuation(
          { store: restarted.store, driver: restarted.driver },
          continuationInput(restarted, record, {
            kind: "replay",
            reason: "provider state was lost at restart",
            history: [
              { role: "user", text: "canonical history before restart" },
              { role: "assistant", text: first.text },
            ],
          }),
        );
        expect(replay.outcome).toBe("replay");
        expect(replay.conversation?.key).toBe(record.identity.key);
        expect(replay.conversation?.generation).toBe(record.generation + 1);
        expect(replay.record?.checkpoint).toBe("unconfirmed");
      });
    });

    test("restart follows the provider's declared recovery mode through its native path", async () => {
      await withHarness(fixture, async (beforeRestart, track) => {
        const firstText = "history retained across restart";
        const first = await beforeRestart.runNativeTurn({
          selection: beforeRestart.selection,
          turnId: "restart-turn-1",
          userText: firstText,
          history: [{ role: "user", text: firstText }],
          scenario: "success",
        });
        expect(first.record).toBeDefined();
        const restarted = await beforeRestart.restart();
        track(restarted);
        const nextText = "current turn after restart";
        const second = await restarted.runNativeTurn({
          selection: restarted.selection,
          turnId: "restart-turn-2",
          userText: nextText,
          history: [
            { role: "user", text: firstText },
            { role: "assistant", text: first.text },
            { role: "user", text: nextText },
          ],
          scenario: "success",
        });

        if (restarted.restartRecovery === "exact_resume") {
          expect(second.outcome).toBe("completed");
          expect(second.record?.generation).toBe(first.record?.generation);
          expect(second.record?.handle).toBe(first.record?.handle);
        } else if (restarted.restartRecovery === "explicit_replay") {
          expect(second.outcome).toBe("completed");
          expect(second.record?.identity.key).toBe(first.record?.identity.key);
          expect(second.record?.generation).toBe(first.record!.generation + 1);
          expect(second.record?.checkpoint).toBe("confirmed");
          expect(second.compiledPrompt).toContain([
            `User: ${firstText}`,
            `Assistant: ${first.text}`,
            `User: ${nextText}`,
          ].join("\n"));
        } else {
          expect(second.outcome).toBe("failed");
          expect(second.sendAttempts).toBe(0);
        }
      });
    });

    test("shared exchange ownership rejects concurrent turns and stale epochs", async () => {
      await withHarness(fixture, async (harness) => {
        const conversation = await harness.driver.createConversation(harness.selection);
        const identityBase = {
          bindingId: conversation.bindingId,
          conversationKey: conversation.key,
          dshSessionId: harness.selection.dshSession.sessionId,
        };
        const leases = createWebChatTransportLeaseRegistry();
        const firstTransport = scriptedTransport();
        const first = createWebChatExchange({
          identity: { ...identityBase, turnId: "lease-turn-1" },
          turn: { userText: "first", model: harness.model.route },
          transport: firstTransport.transport,
          leases,
          createResource: async () => ({ id: `resource:${conversation.key}`, conversationKey: conversation.key, epoch: conversation.generation }),
        });
        await first.prepare();
        const second = createWebChatExchange({
          identity: { ...identityBase, turnId: "lease-turn-2" },
          turn: { userText: "second", model: harness.model.route },
          transport: scriptedTransport().transport,
          leases,
          createResource: async () => ({ id: `resource:${conversation.key}`, conversationKey: conversation.key, epoch: conversation.generation }),
        });
        await expect(second.prepare()).rejects.toThrow(/Another exchange still owns/);
        await first.abort("conformance cleanup");
        expect(leases.isLeased(conversation.key)).toBe(false);

        const stale = createWebChatExchange({
          identity: { ...identityBase, turnId: "stale-epoch-turn" },
          turn: { userText: "stale", model: harness.model.route },
          transport: scriptedTransport([
            { type: "text_delta", epoch: conversation.generation, text: "stale output" },
            { type: "completed", epoch: conversation.generation, text: "stale output" },
          ]).transport,
          leases: createWebChatTransportLeaseRegistry(),
          epoch: conversation.generation + 1,
          createResource: async () => ({ id: `stale:${conversation.key}`, conversationKey: conversation.key, epoch: conversation.generation + 1 }),
        });
        await stale.prepare();
        await stale.submit();
        const accepted: WebChatExchangeEvent[] = [];
        for await (const event of stale.stream()) accepted.push(event);
        expect(accepted).toEqual([]);
        expect(stale.snapshot().state).toBe("FAILED");
        expect(stale.retrySafety()).toBe("not_retry_safe");
      });
    });

    test("a late native event from a settled turn cannot alter another turn", async () => {
      await withHarness(fixture, async harness => {
        expect(await harness.assertStaleNativeTurnIsolated()).toBe(true);
      });
    });

    test("provider shutdown is idempotent", async () => {
      await withHarness(fixture, async harness => {
        await harness.shutdown();
        await harness.shutdown();
      });
    });
  });
}

function driverIdOf(harness: WebChatProviderConformanceHarness): string {
  return harness.driver.id;
}
