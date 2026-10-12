/**
 * Advisor review task registry (issue #224).
 *
 * A review is a **server-owned task**, not a request: it is accepted promptly, it keeps running when
 * the dialog closes, the DSH session changes or the browser navigates, and its status/result can be
 * read back by its exact `reviewId`. Nothing here is coupled to an HTTP request, a modal or a
 * provider.
 *
 * The registry is deliberately in-process and bounded. It is not a scheduler, not a durable job
 * subsystem and not a second conversation engine: it records exactly what the task contract requires
 * (identity, provenance, source summary, explicit states, timestamps, terminal result or typed
 * failure) and keeps a bounded number of recent records. A task whose id is gone after a restart is
 * reported as unavailable by the caller and never as still running.
 *
 * States are explicit (`queued`, `running`, `completed`, `failed`, `interrupted`); nothing here
 * invents percentage progress.
 */
import { randomUUID } from "node:crypto";

/** The explicit lifecycle state of one review task. */
export type AdvisorTaskState = "queued" | "running" | "completed" | "failed" | "interrupted";

/** The frozen provider/model provenance of one task. */
export interface AdvisorTaskProvenance {
  /** Public route identity the task was created with. */
  readonly route: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly modelLabel: string;
  /** Provider-advertised variant explicitly selected, when any. */
  readonly reasoningMode?: string;
}

/** What the user chose to include, recorded for the result's provenance. */
export interface AdvisorTaskSourceSummary {
  readonly includedRequest: boolean;
  readonly includedResponse: boolean;
  readonly includedProject: boolean;
  readonly projectName?: string;
  readonly instructions: string;
}

/** One tracked review task. */
export interface AdvisorTaskRecord {
  readonly reviewId: string;
  readonly state: AdvisorTaskState;
  /** Originating DSH session. */
  readonly sessionId: string;
  /** Stable identity of the reviewed turn inside that session. */
  readonly reviewedTurnId: string;
  readonly provenance: AdvisorTaskProvenance;
  readonly source: AdvisorTaskSourceSummary;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  /** The review text, on success. */
  readonly text?: string;
  /** When a recovered text was read instead of produced, epoch milliseconds. */
  readonly capturedAt?: number;
  /** Typed failure, when the task did not produce text. */
  readonly failure?: { readonly code: string; readonly message: string };
}

/** What a caller supplies to register a new task. */
export interface AdvisorTaskCreateInput {
  readonly sessionId: string;
  readonly reviewedTurnId: string;
  readonly provenance: AdvisorTaskProvenance;
  readonly source: AdvisorTaskSourceSummary;
}

/** Options of {@link createAdvisorTaskRegistry}. */
export interface AdvisorTaskRegistryOptions {
  /** Bounded retention: the most recent records kept, terminal ones first to be dropped. */
  readonly maxTasks?: number;
  /** Bounded retention: terminal records older than this are dropped. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

/** The in-process review task registry. */
export interface AdvisorTaskRegistry {
  /** Register a queued task. */
  create(input: AdvisorTaskCreateInput): AdvisorTaskRecord;
  /** Move a queued task to running. */
  start(reviewId: string): AdvisorTaskRecord | undefined;
  /** Record a successful terminal result. */
  complete(reviewId: string, result: { readonly text: string; readonly capturedAt?: number }): AdvisorTaskRecord | undefined;
  /** Record a typed terminal failure. */
  fail(reviewId: string, failure: { readonly code: string; readonly message: string }): AdvisorTaskRecord | undefined;
  /** Record an interruption (a shutdown, or a task whose execution stopped without a result). */
  interrupt(reviewId: string, message?: string): AdvisorTaskRecord | undefined;
  /** Interrupt every active task; the future has no owner once this process stops. */
  interruptActive(message?: string): void;
  /** The active (queued or running) task of one reviewed turn, when one exists. */
  activeFor(sessionId: string, reviewedTurnId: string): AdvisorTaskRecord | undefined;
  /**
   * The active task of one DSH session, when one exists.
   *
   * The Advisor uses one provider conversation per session, so two reviews of different turns in the
   * same session would race on that one conversation; the host refuses instead of interleaving them.
   */
  activeForSession(sessionId: string): AdvisorTaskRecord | undefined;
  get(reviewId: string): AdvisorTaskRecord | undefined;
  /** Records, newest first, optionally scoped to one session. */
  list(options?: { readonly sessionId?: string; readonly limit?: number }): readonly AdvisorTaskRecord[];
}

const DEFAULT_MAX_TASKS = 50;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Whether a state is terminal (holds no execution any more). */
export function isAdvisorTaskTerminal(state: AdvisorTaskState): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

/**
 * Create one task registry.
 *
 * @param options - retention bounds and the clock (tests inject both).
 * @returns the registry.
 */
export function createAdvisorTaskRegistry(
  options: AdvisorTaskRegistryOptions = {},
): AdvisorTaskRegistry {
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  /** Insertion order is creation order, which is the pruning order for terminal records. */
  const tasks = new Map<string, AdvisorTaskRecord>();

  const prune = (): void => {
    const cutoff = now() - maxAgeMs;
    for (const [reviewId, task] of tasks) {
      if (isAdvisorTaskTerminal(task.state) && (task.completedAt ?? task.createdAt) < cutoff) {
        tasks.delete(reviewId);
      }
    }
    // Insertion order keeps the oldest first, and a terminal record is always droppable; an active
    // task is never dropped, so retention can never make a running review unreadable.
    while (tasks.size > maxTasks) {
      const oldest = [...tasks.entries()].find(([, task]) => isAdvisorTaskTerminal(task.state));
      if (!oldest) break;
      tasks.delete(oldest[0]);
    }
  };

  const replace = (reviewId: string, next: AdvisorTaskRecord): AdvisorTaskRecord => {
    tasks.set(reviewId, next);
    prune();
    return next;
  };

  return {
    create(input) {
      const reviewId = randomUUID();
      const task: AdvisorTaskRecord = {
        reviewId,
        state: "queued",
        sessionId: input.sessionId,
        reviewedTurnId: input.reviewedTurnId,
        provenance: input.provenance,
        source: input.source,
        createdAt: now(),
      };
      tasks.set(reviewId, task);
      prune();
      return task;
    },

    start(reviewId) {
      const task = tasks.get(reviewId);
      if (!task || task.state !== "queued") return undefined;
      return replace(reviewId, { ...task, state: "running", startedAt: now() });
    },

    complete(reviewId, result) {
      const task = tasks.get(reviewId);
      if (!task || isAdvisorTaskTerminal(task.state)) return undefined;
      return replace(reviewId, {
        ...task,
        state: "completed",
        completedAt: now(),
        text: result.text,
        ...(result.capturedAt !== undefined ? { capturedAt: result.capturedAt } : {}),
        ...(task.startedAt === undefined ? { startedAt: now() } : {}),
      });
    },

    fail(reviewId, failure) {
      const task = tasks.get(reviewId);
      if (!task || isAdvisorTaskTerminal(task.state)) return undefined;
      return replace(reviewId, {
        ...task,
        state: "failed",
        completedAt: now(),
        failure: { code: failure.code, message: failure.message },
        ...(task.startedAt === undefined ? { startedAt: now() } : {}),
      });
    },

    interrupt(reviewId, message) {
      const task = tasks.get(reviewId);
      if (!task || isAdvisorTaskTerminal(task.state)) return undefined;
      return replace(reviewId, {
        ...task,
        state: "interrupted",
        completedAt: now(),
        failure: {
          code: "advisor_task_interrupted",
          message: message ?? "The review was interrupted before it produced a result",
        },
      });
    },

    interruptActive(message) {
      for (const [reviewId, task] of [...tasks]) {
        if (!isAdvisorTaskTerminal(task.state)) {
          replace(reviewId, {
            ...task,
            state: "interrupted",
            completedAt: now(),
            failure: {
              code: "advisor_task_interrupted",
              message: message ?? "The review was interrupted before it produced a result",
            },
          });
        }
      }
    },

    activeFor(sessionId, reviewedTurnId) {
      return [...tasks.values()].find(task =>
        task.sessionId === sessionId
        && task.reviewedTurnId === reviewedTurnId
        && !isAdvisorTaskTerminal(task.state)
      );
    },

    activeForSession(sessionId) {
      return [...tasks.values()].find(task =>
        task.sessionId === sessionId && !isAdvisorTaskTerminal(task.state)
      );
    },

    get(reviewId) {
      return tasks.get(reviewId);
    },

    list(listOptions = {}) {
      const limit = listOptions.limit ?? maxTasks;
      return [...tasks.values()]
        .filter(task => listOptions.sessionId === undefined || task.sessionId === listOptions.sessionId)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, Math.max(0, limit));
    },
  };
}
