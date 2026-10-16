import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADVISOR_DUPLICATE_REVIEW_CODE,
  ADVISOR_MODEL_UNAVAILABLE_CODE,
  ADVISOR_RECOVERY_TIMEOUT_MAX_MS,
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
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import type { ChatGptWebProviderAdapter } from "../src/adapters/chatgpt-web/index";
import { createChatGptWebProviderRuntime } from "../src/adapters/chatgpt-web/provider-runtime";
import { awaitChatGptSubmissionPhase, createChatGptTurnEventQueue } from "../src/adapters/chatgpt-web/text-turn";
import {
  resolveWebChatProviderRuntime,
  resolveWebChatRouteModel,
  webChatPublicRoute,
  webChatRouteModelId,
  webChatRouteProviderId,
  type WebChatProviderRuntime,
  type WebChatTextRecoveryRequest,
  type WebChatTextTurnRequest,
} from "../src/web-chat/host/text-turn";
import { runWebChatTextExchange, type WebChatTextExchangeHandoff } from "../src/web-chat/host/text-exchange";
import {
  createWebChatTransportLeaseRegistry,
  type WebChatTextTransport,
} from "../src/web-chat/transport";
import { webChatError } from "../src/web-chat/core";
import type {
  WebChatAccountInspection,
  WebChatConversation,
  WebChatConversationAssessment,
  WebChatModelDescriptor,
  WebChatProviderDriver,
  WebChatProviderHealth,
} from "../src/web-chat/core";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

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
    /**
     * Open one exchange over a scripted provider transport.
     *
     * The fixture is still provider-neutral: it satisfies the same exchange contract ChatGPT does,
     * so the host suite exercises the production path rather than a bespoke seam.
     */
    async openTextExchange(request: WebChatTextTurnRequest): Promise<WebChatTextExchangeHandoff> {
      calls.push(request);
      const outcome = options.answer
        ? await options.answer(request)
        : { ok: true as const, text: "review from " + options.id };
      const conversationKey = `fixture:${request.affinity.threadId}`;
      const transport: WebChatTextTransport = {
        id: `fixture-${options.id}`,
        async ready() {},
        async submit() {
          return "accepted";
        },
        async *stream(context) {
          if (outcome.ok) {
            const text = typeof outcome.text === "string" ? outcome.text : "";
            if (text.length > 0) yield { type: "text_delta", epoch: context.epoch, text };
            yield { type: "completed", epoch: context.epoch, text };
            return;
          }
          yield {
            type: "error",
            epoch: context.epoch,
            // The provider's own code rides as detail; the shared category is the semantic failure.
            error: webChatError("UPSTREAM_ERROR", outcome.message ?? "the provider failed", {
              providerDetail: { code: outcome.code },
            }),
          };
        },
        async settle() {
          return "fulfilled";
        },
      };
      return {
        transport,
        identity: {
          bindingId: request.affinity.bindingId,
          conversationKey,
          turnId: request.turnId,
          dshSessionId: request.dshSession.sessionId,
        },
        turn: { userText: request.userText, model: request.route },
        leases: createWebChatTransportLeaseRegistry(),
        createResource: async () => ({ id: `${conversationKey}:1`, conversationKey, epoch: 1 }),
      };
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
    expect(settled?.failure).toEqual({ code: "UPSTREAM_ERROR", message: "the provider gave up" });
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
});

/**
 * Merged: the read-only recovery of a finished Advisor answer, through the real ChatGPT provider
 * runtime (issue #214, kept by #224).
 *
 * The reported failure was a review the provider finished while its caller had already given up on
 * the browser turn. The recovery must read the answer back from the *same* retained Advisor
 * conversation the review turn used, without ever submitting, navigating or creating anything. The
 * orchestration is provider-neutral (the host asks the selected provider's runtime), so what this
 * section adds over the fixture-based host tests above is the provider-side invariant that makes it
 * safe: the review turn and the recovery resolve to one conversation, and a recovery carries no
 * message at all.
 */
const RECOVERY_SESSION = "dsh-session-recovery";
const RECOVERY_NAMESPACE = "dsh-chatgpt-web";
const RECOVERY_ROUTE = "chatgpt-web/light";

const recoveryProvider = {
  baseUrl: "http://127.0.0.1:17841",
  chatgptWeb: {
    accountIdentityFingerprint: "account-214",
    browserInteractionMode: "automatic",
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  },
} as unknown as CodexProviderConfig;

interface CapturedAdapter {
  readonly adapter: ChatGptWebProviderAdapter;
  readonly turns: CodexParsedRequest[];
  readonly recoveries: Array<{ parsed: CodexParsedRequest; timeoutMs?: number; signal?: AbortSignal }>;
}

/** An adapter double that captures the provider requests the runtime builds. */
function capturingAdapter(options: { text?: string; failWith?: string } = {}): CapturedAdapter {
  const turns: CodexParsedRequest[] = [];
  const recoveries: Array<{ parsed: CodexParsedRequest; timeoutMs?: number; signal?: AbortSignal }> = [];
  const adapter = {
    name: "chatgpt-web",
    /**
     * The provider's phased seam (issue #236): a review reaches the provider through the shared
     * exchange, so the fixture reports the same phases a real adapter does.
     */
    async openTextTurn(parsed: CodexParsedRequest) {
      turns.push(parsed);
      const queue = createChatGptTurnEventQueue();
      queue.markReady();
      queue.markSubmission("accepted");
      queue.markSettled("fulfilled");
      if (options.failWith) {
        queue.push({ type: "error", message: options.failWith });
      } else {
        queue.push({ type: "text_delta", text: options.text ?? "the review" });
        queue.push({ type: "done" });
      }
      queue.close();
      const finished = Promise.resolve();
      return {
        ready: queue.ready,
        submissionPhase: () => queue.submission(),
        awaitSubmission: () => awaitChatGptSubmissionPhase(queue, finished),
        events: queue,
        settled: () => queue.settled(),
        abort: async () => {},
        finished,
      };
    },
    async recoverRetainedAnswer(parsed: CodexParsedRequest, recoverOptions: { timeoutMs?: number; signal?: AbortSignal } = {}) {
      recoveries.push({
        parsed,
        ...(recoverOptions.timeoutMs !== undefined ? { timeoutMs: recoverOptions.timeoutMs } : {}),
        ...(recoverOptions.signal ? { signal: recoverOptions.signal } : {}),
      });
      if (options.failWith) throw new Error(options.failWith);
      return { text: options.text ?? "the retained answer", capturedAt: 1_700_000_000_000 };
    },
  } as unknown as ChatGptWebProviderAdapter;
  return { adapter, turns, recoveries };
}

function recoveryRuntime(captured: CapturedAdapter) {
  return createChatGptWebProviderRuntime({
    provider: recoveryProvider,
    adapter: captured.adapter,
  });
}

describe("issue #214 — one retained conversation for review and recovery", () => {
  test("the recovery resolves to the review turn's conversation key for the same session", async () => {
    const captured = capturingAdapter();
    const runtime = recoveryRuntime(captured);
    const affinity = { providerId: "chatgpt-web", bindingId: "binding-1", threadId: advisorConversationThread(RECOVERY_SESSION) };
    await runWebChatTextExchange(await runtime.openTextExchange({
      route: RECOVERY_ROUTE,
      model: "light",
      userText: "review this",
      dshSession: { sessionId: RECOVERY_SESSION },
      affinity,
      turnId: "review-1",
    }));
    const recoveryRequest: WebChatTextRecoveryRequest = {
      route: RECOVERY_ROUTE,
      model: "light",
      dshSession: { sessionId: RECOVERY_SESSION },
      affinity,
      turnId: "recover-1",
    };
    await runtime.recoverTextTurn!(recoveryRequest);

    const reviewParsed = captured.turns[0]!;
    const recoveryParsed = captured.recoveries[0]!.parsed;
    expect(chatGptConversationKey(recoveryParsed, RECOVERY_NAMESPACE))
      .toBe(chatGptConversationKey(reviewParsed, RECOVERY_NAMESPACE));
    // The identity is the synthetic Advisor thread of this session, not the review id.
    expect(recoveryParsed._dshContext?.threadId).toBe(advisorConversationThread(RECOVERY_SESSION));
    expect(recoveryParsed._advisorReview).toEqual({ reviewId: "recover-1" });
  });

  test("another DSH session resolves to its own conversation", () => {
    const captured = capturingAdapter();
    const runtime = recoveryRuntime(captured);
    void runtime;
    const build = (sessionId: string, turnId: string): CodexParsedRequest => ({
      modelId: "gpt-5.6-luna",
      context: { messages: [] },
      stream: false,
      options: {},
      _dshContext: { dshSessionId: sessionId, threadId: advisorConversationThread(sessionId), turnId },
      _advisorReview: { reviewId: turnId },
    });
    expect(chatGptConversationKey(build(RECOVERY_SESSION, "r"), RECOVERY_NAMESPACE))
      .not.toBe(chatGptConversationKey(build("another-session", "r"), RECOVERY_NAMESPACE));
  });

  test("the recovery request carries no message, tools or system prompt: it can only read", async () => {
    const captured = capturingAdapter();
    const runtime = recoveryRuntime(captured);
    await runtime.recoverTextTurn!({
      route: RECOVERY_ROUTE,
      model: "light",
      dshSession: { sessionId: RECOVERY_SESSION },
      affinity: { providerId: "chatgpt-web", bindingId: "b", threadId: advisorConversationThread(RECOVERY_SESSION) },
      turnId: "recover-1",
      timeoutMs: 5_000,
    });
    const parsed = captured.recoveries[0]!.parsed;
    expect(parsed.context.messages).toEqual([]);
    expect(parsed.context.systemPrompt).toBeUndefined();
    expect(parsed.context.tools).toBeUndefined();
    expect(parsed.stream).toBe(false);
    expect(captured.recoveries[0]!.timeoutMs).toBe(5_000);
  });

  test("the review turn submits one portable user message and never a system block", async () => {
    const captured = capturingAdapter();
    const runtime = recoveryRuntime(captured);
    await runWebChatTextExchange(await runtime.openTextExchange({
      route: RECOVERY_ROUTE,
      model: "light",
      userText: "portable review text",
      dshSession: { sessionId: RECOVERY_SESSION },
      affinity: { providerId: "chatgpt-web", bindingId: "b", threadId: advisorConversationThread(RECOVERY_SESSION) },
      turnId: "review-1",
    }));
    const parsed = captured.turns[0]!;
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]!.role).toBe("user");
    expect(parsed.context.messages[0]!.content).toBe("portable review text");
    expect(parsed.context.systemPrompt).toBeUndefined();
  });
});

describe("issue #214 — recovery input validation (control API contract)", () => {
  test("accepts a session and an optional route/timeout, trimming both", () => {
    expect(validateAdvisorRecoveryRequest({ sessionId: "  s-1  " })).toEqual({ sessionId: "s-1" });
    expect(validateAdvisorRecoveryRequest({ sessionId: "s-1", route: " chatgpt-web/light ", timeoutMs: 1_000 }))
      .toEqual({ sessionId: "s-1", route: "chatgpt-web/light", timeoutMs: 1_000 });
  });

  test("rejects a body that is not an object with a session identity", () => {
    expect(() => validateAdvisorRecoveryRequest(null)).toThrow(/must be an object/);
    expect(() => validateAdvisorRecoveryRequest([])).toThrow(/must be an object/);
    expect(() => validateAdvisorRecoveryRequest({})).toThrow(/sessionId/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "   " })).toThrow(/sessionId/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: 7 })).toThrow(/sessionId/);
  });

  test("rejects a blank route and a non-positive, non-finite or oversized timeout", () => {
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", route: "  " })).toThrow(/route/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: Number.POSITIVE_INFINITY })).toThrow(/timeoutMs/);
    expect(() => validateAdvisorRecoveryRequest({ sessionId: "s", timeoutMs: ADVISOR_RECOVERY_TIMEOUT_MAX_MS + 1 }))
      .toThrow(/must not exceed/);
  });
});

describe("issue #214 — recovery results through the Advisor host", () => {
  function recoveryHostWith(captured: CapturedAdapter) {
    return createAdvisorHost({ runtimes: [recoveryRuntime(captured)] });
  }

  test("a read answer becomes an ok result carrying its route and provider provenance", async () => {
    const captured = capturingAdapter({ text: "  **Verdict: request changes.**  " });
    const result = await recoveryHostWith(captured).recover({ sessionId: RECOVERY_SESSION, route: RECOVERY_ROUTE, timeoutMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("**Verdict: request changes.**");
    expect(result.capturedAt).toBe(1_700_000_000_000);
    expect(result.route).toBe(RECOVERY_ROUTE);
    expect(result.providerId).toBe("chatgpt-web");
    expect(result.modelId).toBe("light");
    expect(captured.recoveries[0]!.timeoutMs).toBe(60_000);
  });

  test("nothing retained, a lost surface, a busy conversation and a timeout are all typed unavailable", async () => {
    for (const message of [
      "The retained ChatGPT conversation is no longer available.",
      "The retained ChatGPT Web conversation was lost and can no longer be continued.",
      "Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not allowed.",
      "The retained ChatGPT Web conversation did not expose a finalized answer within 900000 ms.",
    ]) {
      const result = await recoveryHostWith(capturingAdapter({ failWith: message }))
        .recover({ sessionId: RECOVERY_SESSION, route: RECOVERY_ROUTE });
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
      expect(result.message).toBe(message);
      expect(result.text).toBeUndefined();
    }
  });

  test("an empty answer is a typed failure, never an empty success", async () => {
    const result = await recoveryHostWith(capturingAdapter({ text: "   " })).recover({ sessionId: RECOVERY_SESSION, route: RECOVERY_ROUTE });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADVISOR_RECOVERY_UNAVAILABLE_CODE);
  });

  test("the cancellation signal reaches the read", async () => {
    const controller = new AbortController();
    const captured = capturingAdapter();
    await recoveryHostWith(captured).recover({ sessionId: RECOVERY_SESSION, route: RECOVERY_ROUTE, signal: controller.signal });
    expect(captured.recoveries[0]!.signal).toBe(controller.signal);
  });
});
