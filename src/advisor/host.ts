/**
 * The provider-neutral Advisor host (issue #224).
 *
 * It is the orchestration owner the issue asks for: it selects an already-registered public model
 * route, resolves it to the provider composition that serves it, keeps the review conversation
 * separate from the normal WebChat conversation, accepts a review as a tracked background task, and
 * exposes status/result by exact `reviewId`.
 *
 * It imports no provider: providers arrive as {@link WebChatProviderRuntime} contributions, and the
 * only provider-facing operations it uses are the driver contract and the text-turn port. It is also
 * not a second registry: the route is resolved against the same composition the driver belongs to,
 * and an unknown or unavailable route fails explicitly instead of being substituted.
 */
import { randomUUID } from "node:crypto";
import {
  ADVISOR_DUPLICATE_REVIEW_CODE,
  ADVISOR_MODEL_UNAVAILABLE_CODE,
  ADVISOR_RECOVERY_UNAVAILABLE_CODE,
  ADVISOR_TASK_UNAVAILABLE_CODE,
  ADVISOR_TURN_FAILED_CODE,
  composeAdvisorReviewText,
  type AdvisorReviewSource,
} from "./message";
import { advisorConversationAffinity } from "./affinity";
import {
  buildAdvisorModelCatalogue,
  deterministicAdvisorChoice,
  type AdvisorModelCatalogue,
} from "./catalogue";
import {
  createAdvisorTaskRegistry,
  type AdvisorTaskProvenance,
  type AdvisorTaskRecord,
  type AdvisorTaskRegistry,
} from "./tasks";
import type { AdvisorRecoveryRequest } from "./recovery";
import {
  resolveWebChatProviderRuntime,
  resolveWebChatRouteModel,
  webChatRouteModelId,
  type WebChatProviderRuntime,
} from "../web-chat/host/text-turn";
import { webChatAccountBindingId } from "../web-chat/core";

/** A typed Advisor host failure, so the control API can answer with a stable code. */
export class AdvisorHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AdvisorHostError";
  }
}

/** What a caller supplies to start one review. */
export interface AdvisorStartRequest {
  readonly source: AdvisorReviewSource;
  /** The already-selected public route. */
  readonly route: string;
  /** Provider-advertised variant explicitly selected, when any. */
  readonly reasoningMode?: string;
}

/** The accepted review, plus whether it was an idempotent duplicate of a running one. */
export interface AdvisorStartResult {
  readonly task: AdvisorTaskRecord;
  readonly duplicate: boolean;
}

/** The typed result of one read-only recovery. */
export interface AdvisorRecoveryResult {
  readonly ok: boolean;
  readonly reviewId: string;
  readonly route?: string;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly modelId?: string;
  readonly modelLabel?: string;
  readonly text?: string;
  readonly capturedAt?: number;
  readonly code?: string;
  readonly message?: string;
}

/** The Advisor host the control API talks to. */
export interface AdvisorHost {
  /** The currently eligible model catalogue, rebuilt from the composed providers. */
  catalogue(): Promise<AdvisorModelCatalogue>;
  /** Accept one review as a tracked background task. */
  start(request: AdvisorStartRequest): Promise<AdvisorStartResult>;
  /** Read one task by its exact review id, or `undefined` when it is gone. */
  status(reviewId: string): AdvisorTaskRecord | undefined;
  /** Read tracked tasks, newest first. */
  list(options?: { readonly sessionId?: string; readonly limit?: number }): readonly AdvisorTaskRecord[];
  /** Read the finalized answer of one session's retained Advisor conversation. */
  recover(request: AdvisorRecoveryRequest): Promise<AdvisorRecoveryResult>;
  /** Interrupt every active task; the future has no owner once this process stops. */
  dispose(): void;
}

/** Options of {@link createAdvisorHost}. */
export interface AdvisorHostOptions {
  /**
   * The composed provider contributions.
   *
   * A function is accepted so a deployment can rebuild a provider composition whose configuration
   * changed, while the host — and therefore the tracked tasks — stays the same owner for the life of
   * the process.
   */
  readonly runtimes: readonly WebChatProviderRuntime[] | (() => readonly WebChatProviderRuntime[]);
  readonly tasks?: AdvisorTaskRegistry;
  readonly now?: () => number;
}

/**
 * Create the Advisor host.
 *
 * @param options - the composed provider contributions and the task registry.
 * @returns the host.
 */
export function createAdvisorHost(options: AdvisorHostOptions): AdvisorHost {
  const resolveRuntimes = typeof options.runtimes === "function" ? options.runtimes : () => options.runtimes as readonly WebChatProviderRuntime[];
  const now = options.now ?? Date.now;
  const tasks = options.tasks ?? createAdvisorTaskRegistry(options.now !== undefined ? { now } : {});
  let disposed = false;

  /** The provider composition that serves one public route, or a typed refusal. */
  const requireRuntime = (route: string): WebChatProviderRuntime => {
    const runtime = resolveWebChatProviderRuntime(resolveRuntimes(), route);
    if (!runtime) {
      throw new AdvisorHostError(
        ADVISOR_MODEL_UNAVAILABLE_CODE,
        `No integrated WebChat provider serves the route "${route}".`,
      );
    }
    return runtime;
  };

  /** The provider-qualified provenance of one accepted review, frozen at creation. */
  const provenanceOf = async (
    runtime: WebChatProviderRuntime,
    route: string,
    reasoningMode?: string,
  ): Promise<{ provenance: AdvisorTaskProvenance; modelId: string }> => {
    const descriptor = await resolveWebChatRouteModel(runtime, route, reasoningMode);
    const modelId = webChatRouteModelId(route);
    if (!descriptor || modelId === undefined) {
      throw new AdvisorHostError(
        ADVISOR_MODEL_UNAVAILABLE_CODE,
        `The provider cannot currently serve the route "${route}".`,
      );
    }
    const account = await runtime.driver.inspectAccount();
    if (!account.authenticated) {
      throw new AdvisorHostError(
        ADVISOR_MODEL_UNAVAILABLE_CODE,
        `No supported authenticated WebChat model is available for "${route}".`,
      );
    }
    return {
      modelId,
      provenance: {
        route,
        providerId: runtime.driver.id,
        providerLabel: runtime.providerLabel ?? runtime.driver.id,
        modelId,
        modelLabel: descriptor.label,
        ...(reasoningMode !== undefined ? { reasoningMode } : {}),
      },
    };
  };

  /** The core affinity of one session's Advisor conversation for one provider. */
  const affinityOf = async (runtime: WebChatProviderRuntime, sessionId: string) => {
    const account = await runtime.driver.inspectAccount();
    if (!account.authenticated || !account.accountFingerprint) {
      throw new AdvisorHostError(
        ADVISOR_MODEL_UNAVAILABLE_CODE,
        "No supported authenticated WebChat model is available.",
      );
    }
    const bindingId = webChatAccountBindingId({
      providerId: runtime.driver.id,
      accountFingerprint: account.accountFingerprint,
    });
    return advisorConversationAffinity({
      providerId: runtime.driver.id,
      bindingId,
      sessionId,
    });
  };

  /** Run one accepted task to its terminal state. Detached from any request or dialog. */
  const execute = async (
    reviewId: string,
    runtime: WebChatProviderRuntime,
    request: AdvisorStartRequest,
    affinity: { providerId: string; bindingId: string; threadId: string },
    modelId: string,
  ): Promise<void> => {
    let outcome;
    try {
      outcome = await runtime.runTextTurn({
        route: request.route,
        model: modelId,
        ...(request.reasoningMode !== undefined ? { reasoningMode: request.reasoningMode } : {}),
        userText: composeAdvisorReviewText(request.source),
        dshSession: { sessionId: request.source.sessionId },
        affinity,
        turnId: reviewId,
      });
    } catch (error) {
      outcome = {
        ok: false,
        code: ADVISOR_TURN_FAILED_CODE,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (disposed) {
      // The process is going away: the task is explicitly interrupted rather than left running.
      tasks.interrupt(reviewId, "The sidecar stopped before the review produced a result");
      return;
    }
    if (outcome.ok && typeof outcome.text === "string" && outcome.text.trim().length > 0) {
      tasks.complete(reviewId, {
        text: outcome.text.trim(),
        ...(outcome.capturedAt !== undefined ? { capturedAt: outcome.capturedAt } : {}),
      });
      return;
    }
    tasks.fail(reviewId, {
      code: outcome.code ?? ADVISOR_TURN_FAILED_CODE,
      message: outcome.message ?? "The review produced no text",
    });
  };

  return {
    async catalogue() {
      return buildAdvisorModelCatalogue(resolveRuntimes(), now);
    },

    async start(request) {
      if (disposed) {
        throw new AdvisorHostError(ADVISOR_TASK_UNAVAILABLE_CODE, "The Advisor host is shutting down.");
      }
      const runtime = requireRuntime(request.route);
      const active = tasks.activeForSession(request.source.sessionId);
      if (active) {
        if (active.reviewedTurnId === request.source.reviewedTurnId) {
          // The same turn is already being reviewed: the repeated click adopts the running task
          // instead of creating a second one.
          return { task: active, duplicate: true };
        }
        throw new AdvisorHostError(
          ADVISOR_DUPLICATE_REVIEW_CODE,
          "Another review of this session is still running; the Advisor uses one conversation per session.",
        );
      }
      const { provenance, modelId } = await provenanceOf(runtime, request.route, request.reasoningMode);
      const affinity = await affinityOf(runtime, request.source.sessionId);
      const created = tasks.create({
        sessionId: request.source.sessionId,
        reviewedTurnId: request.source.reviewedTurnId,
        provenance,
        source: {
          includedRequest: request.source.include.request,
          includedResponse: request.source.include.response,
          includedProject: request.source.include.project,
          ...(request.source.project !== undefined ? { projectName: request.source.project } : {}),
          instructions: request.source.instructions,
        },
      });
      const running = tasks.start(created.reviewId) ?? created;
      void execute(created.reviewId, runtime, request, affinity, modelId);
      return { task: running, duplicate: false };
    },

    status(reviewId) {
      return tasks.get(reviewId);
    },

    list(listOptions = {}) {
      return tasks.list(listOptions);
    },

    async recover(request) {
      const reviewId = randomUUID();
      let runtime: WebChatProviderRuntime;
      let route = request.route;
      if (route === undefined) {
        const catalogue = await buildAdvisorModelCatalogue(resolveRuntimes(), now);
        const fallback = deterministicAdvisorChoice(catalogue);
        if (!fallback) {
          return {
            ok: false,
            reviewId,
            code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
            message: "No supported authenticated WebChat model is available.",
          };
        }
        route = fallback.route;
      }
      try {
        runtime = requireRuntime(route);
      } catch (error) {
        return {
          ok: false,
          reviewId,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const base = {
        reviewId,
        route,
        providerId: runtime.driver.id,
        ...(runtime.providerLabel !== undefined ? { providerLabel: runtime.providerLabel } : {}),
      };
      const descriptor = await resolveWebChatRouteModel(runtime, route);
      const modelId = webChatRouteModelId(route);
      if (!descriptor || modelId === undefined) {
        return {
          ...base,
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: `The provider cannot currently serve the route "${route}".`,
        };
      }
      const recoverTextTurn = runtime.recoverTextTurn;
      if (typeof recoverTextTurn !== "function") {
        return {
          ...base,
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: "This provider cannot read a retained conversation.",
        };
      }
      let affinity;
      try {
        affinity = await affinityOf(runtime, request.sessionId);
      } catch (error) {
        return {
          ...base,
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        const outcome = await recoverTextTurn.call(runtime, {
          route,
          model: modelId,
          dshSession: { sessionId: request.sessionId },
          affinity,
          turnId: reviewId,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (outcome.ok && typeof outcome.text === "string" && outcome.text.trim().length > 0) {
          return {
            ...base,
            ok: true,
            modelId: descriptor.id,
            modelLabel: descriptor.label,
            text: outcome.text.trim(),
            ...(outcome.capturedAt !== undefined ? { capturedAt: outcome.capturedAt } : {}),
          };
        }
        return {
          ...base,
          ok: false,
          modelId: descriptor.id,
          modelLabel: descriptor.label,
          code: outcome.code ?? ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: outcome.message ?? "The retained Advisor conversation exposed an empty answer",
        };
      } catch (error) {
        return {
          ...base,
          ok: false,
          code: ADVISOR_RECOVERY_UNAVAILABLE_CODE,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    dispose() {
      disposed = true;
      tasks.interruptActive("The sidecar stopped before the review produced a result");
    },
  };
}
