import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADVISOR_DUPLICATE_REVIEW_CODE,
  ADVISOR_MODEL_UNAVAILABLE_CODE,
  ADVISOR_RECOVERY_UNAVAILABLE_CODE,
  ADVISOR_TASK_UNAVAILABLE_CODE,
  ADVISOR_TURN_FAILED_CODE,
  advisorAffinityKey,
  advisorChoiceForRoute,
  advisorConversationAffinity,
  advisorConversationThread,
  AdvisorHostError,
  buildAdvisorModelCatalogue,
  composeAdvisorReviewText,
  createAdvisorHost,
  createAdvisorTaskRegistry,
  deterministicAdvisorChoice,
  preferredAdvisorChoice,
  projectReferenceName,
  validateAdvisorRecoveryRequest,
  validateAdvisorReviewSource,
  type AdvisorHost,
} from "../src/advisor";
import {
  resolveWebChatProviderRuntime,
  resolveWebChatRouteModel,
  webChatPublicRoute,
  webChatRouteModelId,
  webChatRouteProviderId,
  type WebChatProviderRuntime,
  type WebChatTextTurnRequest,
} from "../src/web-chat/host/text-turn";
import type {
  WebChatAccountInspection,
  WebChatConversation,
  WebChatConversationAssessment,
  WebChatModelDescriptor,
  WebChatProviderDriver,
  WebChatProviderHealth,
} from "../src/web-chat/core";

/**
 * Issue #224 — the provider-neutral Advisor host.
 *
 * Every provider below is a fixture: the point of the suite is that the Advisor orchestration,
 * catalogue, task lifetime and recovery are provider-neutral, so they are proved without importing
 * or emulating any provider implementation.
 */

interface FixtureOptions {
  readonly id: string;
  readonly label?: string;
  readonly authenticated?: boolean;
  readonly models?: readonly WebChatModelDescriptor[];
  readonly accountFails?: boolean;
  readonly listFails?: boolean;
  readonly answer?: (request: WebChatTextTurnRequest) => Promise<{ ok: boolean; text?: string; code?: string; message?: string }>;
  readonly recovery?: (request: { dshSession: { sessionId: string }; route: string }) => Promise<{ ok: boolean; text?: string; capturedAt?: number; code?: string; message?: string }>;
}

interface FixtureRuntime extends WebChatProviderRuntime {
  readonly calls: WebChatTextTurnRequest[];
  readonly recoveries: Array<{ sessionId: string; route: string }>;
}

function fixtureRuntime(options: FixtureOptions): FixtureRuntime {
  const calls: WebChatTextTurnRequest[] = [];
  const recoveries: Array<{ sessionId: string; route: string }> = [];
  const models = options.models ?? [
    { id: "one", label: "Model One", text: true as const, reasoningModes: ["fast"] },
    { id: "two", label: "Model Two", text: true as const },
  ];
  const driver: WebChatProviderDriver = {
    id: options.id,
    async inspectAccount(): Promise<WebChatAccountInspection> {
      if (options.accountFails) throw new Error("account inspection failed");
      return { authenticated: options.authenticated !== false, accountFingerprint: "fp-" + options.id };
    },
    async listModels(): Promise<readonly WebChatModelDescriptor[]> {
      if (options.listFails) throw new Error("model listing failed");
      return models;
    },
    async resolveModel(model) {
      // The driver resolves the provider-qualified public route it advertises, which is the identity
      // the DSH catalogue exposes for it.
      return models.find((candidate) => `${options.id}/${candidate.id}` === model);
    },
    async assessConversation(): Promise<WebChatConversationAssessment> {
      return { status: "resumable" };
    },
    async createConversation(): Promise<WebChatConversation> {
      throw new Error("not used by the Advisor host");
    },
    async resumeConversation(): Promise<WebChatConversation> {
      throw new Error("not used by the Advisor host");
    },
    async replayConversation(): Promise<WebChatConversation> {
      throw new Error("not used by the Advisor host");
    },
    async health(): Promise<WebChatProviderHealth> {
      return { ok: true };
    },
    async shutdown(): Promise<void> {},
  };
  return {
    driver,
    ...(options.label !== undefined ? { providerLabel: options.label } : {}),
    calls,
    recoveries,
    async runTextTurn(request) {
      calls.push(request);
      if (options.answer) return options.answer(request);
      return { ok: true, text: "review from " + options.id };
    },
    ...(options.recovery
      ? {
        async recoverTextTurn(request: { dshSession: { sessionId: string }; route: string }) {
          recoveries.push({ sessionId: request.dshSession.sessionId, route: request.route });
          return options.recovery!(request);
        },
      }
      : {}),
  };
}

function reviewSource(overrides: Record<string, unknown> = {}) {
  return validateAdvisorReviewSource({
    sessionId: "sess-1",
    reviewedTurnId: "dsh-turn:4",
    humanRequest: "the human request",
    dshResponse: "the DSH response",
    instructions: "review this",
    project: "/home/user/projects/my-proj",
    ...overrides,
  });
}

describe("issue #224 — portable review text", () => {
  test("validation defaults both text sources and the project to included", () => {
    const source = reviewSource();
    expect(source.include).toEqual({ request: true, response: true, project: true });
    expect(source.project).toBe("my-proj");
  });

  test("a local path can never reach the review text: only the basename survives", () => {
    expect(projectReferenceName("/home/user/projects/my-proj")).toBe("my-proj");
    expect(projectReferenceName("C:\\dev\\win-proj")).toBe("win-proj");
    expect(projectReferenceName("plain-name")).toBe("plain-name");
    expect(projectReferenceName("///")).toBeUndefined();
    expect(composeAdvisorReviewText(reviewSource())).not.toContain("/home/user/projects");
  });

  test("a review with no substantive selected source is refused", () => {
    expect(() => reviewSource({ includeRequest: false, includeResponse: false, includeProject: false })).toThrow(
      "at least one substantive selected source",
    );
    // Deselecting one source is fine while another remains.
    expect(() => reviewSource({ includeRequest: false })).not.toThrow();
  });

  test("malformed bodies are refused with a stable message", () => {
    expect(() => validateAdvisorReviewSource(null)).toThrow("must be an object");
    expect(() => validateAdvisorReviewSource({ sessionId: "s" })).toThrow('"reviewedTurnId"');
    expect(() => validateAdvisorReviewSource({ sessionId: "s", reviewedTurnId: "t" })).toThrow('"instructions"');
    expect(() => reviewSource({ includeRequest: "yes" })).toThrow('"includeRequest"');
  });

  test("the composed text is one portable user prompt: persona, selected blocks only", () => {
    const text = composeAdvisorReviewText(reviewSource({ includeResponse: false }));
    expect(text).toContain("senior software engineering reviewer");
    expect(text).toContain('Project: "my-proj"');
    expect(text).toContain("Review instructions:\nreview this");
    expect(text).toContain("Human request:\nthe human request");
    expect(text).not.toContain("DSH response:");
  });

  test("the Advisor thread is stable per session and distinct from a normal thread", () => {
    expect(advisorConversationThread("sess-1")).toBe(advisorConversationThread("sess-1"));
    expect(advisorConversationThread("sess-1")).not.toBe(advisorConversationThread("sess-2"));
    expect(advisorConversationThread("sess-1").startsWith("advisor-")).toBe(true);
  });
});

describe("issue #224 — Advisor conversation affinity", () => {
  test("provider and account binding are part of the key, so two providers never collide", () => {
    const base = { sessionId: "sess-1" };
    const chatgpt = advisorAffinityKey({ providerId: "chatgpt-web", bindingId: "a", ...base });
    const qwen = advisorAffinityKey({ providerId: "qwen-web", bindingId: "a", ...base });
    const otherAccount = advisorAffinityKey({ providerId: "chatgpt-web", bindingId: "b", ...base });
    expect(new Set([chatgpt, qwen, otherAccount]).size).toBe(3);
  });

  test("the Advisor affinity is a synthetic thread of the session", () => {
    const affinity = advisorConversationAffinity({ providerId: "chatgpt-web", bindingId: "a", sessionId: "sess-1" });
    expect(affinity.threadId).toBe(advisorConversationThread("sess-1"));
    expect(affinity.providerId).toBe("chatgpt-web");
  });

  test("a missing identity is refused instead of producing an unaddressable key", () => {
    expect(() => advisorConversationAffinity({ providerId: "chatgpt-web", bindingId: "", sessionId: "sess-1" })).toThrow();
  });
});

describe("issue #224 — public route identity", () => {
  test("a route is provider-qualified, because a provider-local id is not globally unique", () => {
    expect(webChatPublicRoute("chatgpt-web", "light")).toBe("chatgpt-web/light");
    expect(webChatRouteProviderId("chatgpt-web/light")).toBe("chatgpt-web");
    expect(webChatRouteModelId("chatgpt-web/light")).toBe("light");
    expect(webChatRouteProviderId("qwen-web/a/b")).toBe("qwen-web");
    expect(webChatRouteModelId("qwen-web/a/b")).toBe("a/b");
    expect(webChatRouteProviderId("light")).toBeUndefined();
    expect(webChatRouteModelId("chatgpt-web/")).toBeUndefined();
  });
});

describe("issue #224 — eligible model catalogue", () => {
  test("only authenticated providers contribute, and each choice names provider and model", async () => {
    const chatgpt = fixtureRuntime({ id: "chatgpt-web", label: "ChatGPT Web" });
    const qwen = fixtureRuntime({ id: "qwen-web", label: "Qwen Chat", authenticated: false });
    const catalogue = await buildAdvisorModelCatalogue([qwen, chatgpt]);
    expect(catalogue.choices.map((choice) => choice.route)).toEqual(["chatgpt-web/one", "chatgpt-web/two"]);
    expect(catalogue.choices[0]!.label).toBe("ChatGPT Web — Model One");
    expect(catalogue.choices[0]!.providerId).toBe("chatgpt-web");
    expect(catalogue.choices[0]!.modelId).toBe("one");
    const qwenEntry = catalogue.providers.find((provider) => provider.providerId === "qwen-web");
    expect(qwenEntry?.authenticated).toBe(false);
    expect(qwenEntry?.unavailableReason).toBe("auth_required");
  });

  test("a provider that cannot answer is reported unavailable, never as an empty healthy provider", async () => {
    const broken = fixtureRuntime({ id: "broken-web", listFails: true });
    const catalogue = await buildAdvisorModelCatalogue([broken]);
    const entry = catalogue.providers[0];
    expect(entry.healthy).toBe(false);
    expect(entry.unavailableReason).toBe("unavailable");
    expect(catalogue.choices).toEqual([]);
  });

  test("a healthy provider with no models reports no_models instead of failing", async () => {
    const empty = fixtureRuntime({ id: "empty-web", models: [] });
    const catalogue = await buildAdvisorModelCatalogue([empty]);
    expect(catalogue.providers[0].unavailableReason).toBe("no_models");
    expect(catalogue.choices).toEqual([]);
  });

  test("the order is deterministic and the preselection prefers the last used route", async () => {
    const one = fixtureRuntime({ id: "b-web" });
    const two = fixtureRuntime({ id: "a-web" });
    const catalogue = await buildAdvisorModelCatalogue([one, two]);
    expect(catalogue.providers.map((provider) => provider.providerId)).toEqual(["a-web", "b-web"]);
    expect(deterministicAdvisorChoice(catalogue)?.route).toBe("a-web/one");
    expect(preferredAdvisorChoice(catalogue, "b-web/two")?.route).toBe("b-web/two");
    // A route that is no longer eligible falls back to the deterministic choice.
    expect(preferredAdvisorChoice(catalogue, "gone-web/x")?.route).toBe("a-web/one");
    expect(advisorChoiceForRoute(catalogue, "b-web/one")?.modelLabel).toBe("Model One");
  });

  test("a route resolves to the composition that serves it, and nothing else does", () => {
    const chatgpt = fixtureRuntime({ id: "chatgpt-web" });
    const runtimes = [chatgpt];
    expect(resolveWebChatProviderRuntime(runtimes, "chatgpt-web/one")).toBe(chatgpt);
    expect(resolveWebChatProviderRuntime(runtimes, "qwen-web/one")).toBeUndefined();
    expect(resolveWebChatProviderRuntime(runtimes, "nonsense")).toBeUndefined();
  });

  test("the provider driver stays authoritative over what it serves", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web" });
    expect((await resolveWebChatRouteModel(runtime, "chatgpt-web/one"))?.label).toBe("Model One");
    expect(await resolveWebChatRouteModel(runtime, "chatgpt-web/unknown")).toBeUndefined();
    expect(await resolveWebChatRouteModel(runtime, "other-web/one")).toBeUndefined();
  });
});

describe("issue #224 — tracked task registry", () => {
  const provenance = {
    route: "chatgpt-web/one",
    providerId: "chatgpt-web",
    providerLabel: "ChatGPT Web",
    modelId: "one",
    modelLabel: "Model One",
  };
  const source = {
    includedRequest: true,
    includedResponse: true,
    includedProject: false,
    instructions: "i",
  };

  test("states move queued → running → completed and the result is recorded", () => {
    const tasks = createAdvisorTaskRegistry({ now: () => 1_000 });
    const created = tasks.create({ sessionId: "s", reviewedTurnId: "t", provenance, source });
    expect(created.state).toBe("queued");
    expect(tasks.start(created.reviewId)?.state).toBe("running");
    const done = tasks.complete(created.reviewId, { text: "the review" });
    expect(done?.state).toBe("completed");
    expect(done?.text).toBe("the review");
    // A terminal task is not moved again.
    expect(tasks.fail(created.reviewId, { code: "x", message: "y" })).toBeUndefined();
  });

  test("the active task of one session is discoverable, and retention drops only terminal records", () => {
    const tasks = createAdvisorTaskRegistry({ maxTasks: 2, now: () => 1_000 });
    const first = tasks.create({ sessionId: "s", reviewedTurnId: "t1", provenance, source });
    tasks.start(first.reviewId);
    expect(tasks.activeFor("s", "t1")?.reviewId).toBe(first.reviewId);
    expect(tasks.activeForSession("s")?.reviewId).toBe(first.reviewId);
    const second = tasks.create({ sessionId: "s", reviewedTurnId: "t2", provenance, source });
    const third = tasks.create({ sessionId: "s", reviewedTurnId: "t3", provenance, source });
    // The active task is never dropped, however small the bound.
    expect(tasks.get(first.reviewId)?.state).toBe("running");
    tasks.complete(second.reviewId, { text: "b" });
    tasks.complete(third.reviewId, { text: "c" });
    expect(tasks.get(second.reviewId)).toBeUndefined();
  });

  test("interrupting active work never leaves a task looking like it still runs", () => {
    const tasks = createAdvisorTaskRegistry();
    const created = tasks.create({ sessionId: "s", reviewedTurnId: "t", provenance, source });
    tasks.start(created.reviewId);
    tasks.interruptActive("sidecar stopped");
    expect(tasks.get(created.reviewId)?.state).toBe("interrupted");
    expect(tasks.activeForSession("s")).toBeUndefined();
  });
});

describe("issue #224 — Advisor host", () => {
  function hostWith(runtimes: readonly WebChatProviderRuntime[], options: { maxTasks?: number } = {}): AdvisorHost {
    return createAdvisorHost({
      runtimes,
      ...(options.maxTasks !== undefined
        ? { tasks: createAdvisorTaskRegistry({ maxTasks: options.maxTasks }) }
        : {}),
    });
  }

  test("start accepts promptly and the task finishes independently of the caller", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web" });
    const host = hostWith([runtime]);
    const started = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    expect(started.duplicate).toBe(false);
    expect(started.task.state).toBe("running");
    expect(started.task.reviewId).toBeTruthy();
    expect(started.task.provenance).toEqual({
      route: "chatgpt-web/one",
      providerId: "chatgpt-web",
      providerLabel: "chatgpt-web",
      modelId: "one",
      modelLabel: "Model One",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = host.status(started.task.reviewId);
    expect(settled?.state).toBe("completed");
    expect(settled?.text).toBe("review from chatgpt-web");
    // The turn was submitted as portable user text through the port, with the Advisor affinity.
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.userText).toContain("senior software engineering reviewer");
    expect(runtime.calls[0]!.affinity.threadId).toBe(advisorConversationThread("sess-1"));
    expect(runtime.calls[0]!.dshSession.sessionId).toBe("sess-1");
    expect(runtime.calls[0]!.turnId).toBe(started.task.reviewId);
  });

  test("a failing turn becomes a typed failure, never an unhandled rejection", async () => {
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      answer: async () => ({ ok: false, code: ADVISOR_TURN_FAILED_CODE, message: "the provider gave up" }),
    });
    const host = hostWith([runtime]);
    const started = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = host.status(started.task.reviewId);
    expect(settled?.state).toBe("failed");
    expect(settled?.failure).toEqual({ code: ADVISOR_TURN_FAILED_CODE, message: "the provider gave up" });
    expect(settled?.text).toBeUndefined();
  });

  test("a rejected turn is reported as a failure of the task", async () => {
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      answer: async () => { throw new Error("browser exploded"); },
    });
    const host = hostWith([runtime]);
    const started = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = host.status(started.task.reviewId);
    expect(settled?.state).toBe("failed");
    expect(settled?.failure?.message).toBe("browser exploded");
  });

  test("repeated clicks adopt the running task instead of creating a second one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      answer: async () => { await gate; return { ok: true, text: "done" }; },
    });
    const host = hostWith([runtime]);
    const first = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    const second = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    expect(second.duplicate).toBe(true);
    expect(second.task.reviewId).toBe(first.task.reviewId);
    expect(runtime.calls).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.status(first.task.reviewId)?.state).toBe("completed");
  });

  test("a concurrent review of another turn in the same session is refused (one conversation per session)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      answer: async () => { await gate; return { ok: true, text: "done" }; },
    });
    const host = hostWith([runtime]);
    await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    await expect(
      host.start({ source: reviewSource({ reviewedTurnId: "dsh-turn:9" }), route: "chatgpt-web/one" }),
    ).rejects.toMatchObject({ code: ADVISOR_DUPLICATE_REVIEW_CODE });
    expect(runtime.calls).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("an unknown or unauthenticated route fails explicitly and creates no task", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web" });
    const unauthenticated = fixtureRuntime({ id: "qwen-web", authenticated: false });
    const host = hostWith([runtime, unauthenticated]);
    await expect(host.start({ source: reviewSource(), route: "qwen-web/one" }))
      .rejects.toBeInstanceOf(AdvisorHostError);
    await expect(host.start({ source: reviewSource(), route: "chatgpt-web/unknown" }))
      .rejects.toMatchObject({ code: ADVISOR_MODEL_UNAVAILABLE_CODE });
    await expect(host.start({ source: reviewSource(), route: "other-web/one" }))
      .rejects.toMatchObject({ code: ADVISOR_MODEL_UNAVAILABLE_CODE });
    expect(host.list()).toHaveLength(0);
  });

  test("status is read by exact review id and an unknown id is simply absent", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web" });
    const host = hostWith([runtime]);
    const started = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    expect(host.status(started.task.reviewId)?.reviewId).toBe(started.task.reviewId);
    expect(host.status("gone")).toBeUndefined();
    await expect(host.start({ source: reviewSource(), route: "chatgpt-web/one" })).resolves.toBeDefined();
  });

  test("dispose interrupts every active task instead of leaving it running", async () => {
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      answer: () => new Promise(() => { /* never settles */ }),
    });
    const host = hostWith([runtime]);
    const started = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    host.dispose();
    const settled = host.status(started.task.reviewId);
    expect(settled?.state).toBe("interrupted");
    expect(settled?.failure?.code).toBe("advisor_task_interrupted");
    await expect(host.start({ source: reviewSource(), route: "chatgpt-web/one" }))
      .rejects.toMatchObject({ code: ADVISOR_TASK_UNAVAILABLE_CODE });
  });

  test("list is newest first and can be scoped to one session", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web" });
    const host = hostWith([runtime]);
    const first = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await host.start({
      source: reviewSource({ sessionId: "sess-2" }),
      route: "chatgpt-web/one",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.list().map((task) => task.reviewId)).toEqual([second.task.reviewId, first.task.reviewId]);
    expect(host.list({ sessionId: "sess-2" }).map((task) => task.reviewId)).toEqual([second.task.reviewId]);
  });

  test("recovery reads through the provider port and names the route it read", async () => {
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      recovery: async () => ({ ok: true, text: "the retained answer", capturedAt: 42 }),
    });
    const host = hostWith([runtime]);
    const recovered = await host.recover({ sessionId: "sess-1", route: "chatgpt-web/two", timeoutMs: 10 });
    expect(recovered.ok).toBe(true);
    expect(recovered.text).toBe("the retained answer");
    expect(recovered.capturedAt).toBe(42);
    expect(recovered.modelId).toBe("two");
    expect(runtime.recoveries).toEqual([{ sessionId: "sess-1", route: "chatgpt-web/two" }]);
  });

  test("recovery without a route uses the deterministic eligible route", async () => {
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      recovery: async () => ({ ok: true, text: "x" }),
    });
    const host = hostWith([runtime]);
    const recovered = await host.recover({ sessionId: "sess-1" });
    expect(recovered.route).toBe("chatgpt-web/one");
    expect(runtime.recoveries[0]!.route).toBe("chatgpt-web/one");
  });

  test("a provider that cannot read a retained conversation reports recovery unavailable", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web" });
    const host = hostWith([runtime]);
    const recovered = await host.recover({ sessionId: "sess-1", route: "chatgpt-web/one" });
    expect(recovered.ok).toBe(false);
    expect(recovered.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
  });

  test("a failing recovery read is typed, and never becomes a thrown control-API error", async () => {
    const runtime = fixtureRuntime({
      id: "chatgpt-web",
      recovery: async () => { throw new Error("surface lost"); },
    });
    const host = hostWith([runtime]);
    const recovered = await host.recover({ sessionId: "sess-1", route: "chatgpt-web/one" });
    expect(recovered.ok).toBe(false);
    expect(recovered.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
    expect(recovered.message).toBe("surface lost");
  });

  test("the recovery request contract rejects malformed bodies", () => {
    expect(() => validateAdvisorRecoveryRequest(null)).toThrow();
    expect(() => validateAdvisorRecoveryRequest({})).toThrow('"sessionId"');
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s" })).not.toThrow();
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: -1 })).toThrow('"timeoutMs"');
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: Number.MAX_SAFE_INTEGER })).toThrow("must not exceed");
  });

  test("the host catalogue is the same single composition the routes resolve against", async () => {
    const runtime = fixtureRuntime({ id: "chatgpt-web", label: "ChatGPT Web" });
    const host = hostWith([runtime]);
    const catalogue = await host.catalogue();
    expect(catalogue.choices.map((choice) => choice.route)).toEqual(["chatgpt-web/one", "chatgpt-web/two"]);
    expect(catalogue.choices[0]!.label).toBe("ChatGPT Web — Model One");
  });

  test("a provider configuration change is picked up while the tracked tasks stay the same owner", async () => {
    const first = fixtureRuntime({ id: "chatgpt-web", models: [{ id: "one", label: "Model One", text: true }] });
    const second = fixtureRuntime({ id: "chatgpt-web", models: [{ id: "two", label: "Model Two", text: true }] });
    let current: readonly WebChatProviderRuntime[] = [first];
    const host = createAdvisorHost({ runtimes: () => current });
    const started = await host.start({ source: reviewSource(), route: "chatgpt-web/one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = [second];
    expect((await host.catalogue()).choices.map((choice) => choice.route)).toEqual(["chatgpt-web/two"]);
    // The already accepted review is still readable from the same owner.
    expect(host.status(started.task.reviewId)?.state).toBe("completed");
  });
});

describe("issue #224 — provider neutrality is enforced, not just intended", () => {
  test("the Advisor host never imports a provider adapter, a driver implementation or a browser module", () => {
    const moduleDir = join(import.meta.dir, "..", "src", "advisor");
    const forbidden = [/(^|\/)\.\.\/adapters\//, /browser-worker/, /playwright/i, /chatgpt-web\/advisor/];
    const sources = [
      "index.ts", "host.ts", "catalogue.ts", "tasks.ts", "message.ts", "affinity.ts", "recovery.ts",
    ];
    for (const file of sources) {
      const source = readFileSync(join(moduleDir, file), "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(source)).toBe(false);
      }
    }
  });

  test("no provider-specific wording survives in the Advisor client surface", () => {
    const client = readFileSync(join(import.meta.dir, "..", "client.js"), "utf8");
    expect(client).not.toContain("Review with ChatGPT");
    expect(client).not.toContain("advisor.dialog.modeNormal");
    expect(client).not.toContain("advisor.dialog.modeThink");
    expect(client).not.toContain("ChatGPT Advisor");
    expect(client).not.toContain("/v1/control/advisor/review'");
  });
});
