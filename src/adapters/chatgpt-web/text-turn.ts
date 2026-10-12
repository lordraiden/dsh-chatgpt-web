/**
 * The ChatGPT turn exposed as phases (issue #236, architecture §8.3/§9).
 *
 * The provider already owns every fact a shared exchange needs — the surface readiness, the
 * submission boundary, the rendered answer and the physical settlement — but `runTurn` reports them
 * to a single callback over one call. This contract names them, so a provider transport can project
 * them onto `WebChatTextTransport` without re-interpreting (and never re-detecting) anything.
 *
 * Two deliberate properties:
 *
 * - **The phase facts are read from the provider, never inferred.** `submissionPhase()` reports the
 *   phase the provider proved, and `settled()` resolves with the provider's own settlement outcome.
 * - **The browser pipeline begins when the turn is opened**, because ChatGPT prepares its composer
 *   and activates Send inside one pipeline the provider's worker owns. `submit()` on the transport
 *   therefore *resolves at* — rather than triggers — the send boundary: it waits for the provider's
 *   proven phase, which is the boundary the exchange's retry rules key on. Only one turn is ever
 *   opened per exchange, so at-most-once submission is unchanged.
 *
 * This module has no dependency on the adapter and carries no browser object.
 */
import type { AdapterEvent } from "../../types";
import type { PhysicalSettlementOutcome, SubmissionPhase } from "./provider-core";

/**
 * The provider's own phase signals, reported as they happen.
 *
 * The adapter calls these from the hooks it already owns, so nothing new is detected: `ready` comes
 * from the surface-ready transition, and the two submission signals are exactly the ones that set
 * the provider's live submission phase.
 */
export interface ChatGptTurnPhaseReporter {
  /** The retained surface is ready (authentication/model/composer prepared). Idempotent. */
  ready(): void;
  /** Send activation was observed: the provider may have accepted the prompt. */
  sendActivated(): void;
  /** The provider proved the prompt was accepted. */
  submitted(): void;
  /** The provider established its physical settlement. Idempotent. */
  settled(outcome: PhysicalSettlementOutcome): void;
}

/**
 * One ChatGPT turn as the phases a shared exchange consumes.
 *
 * The events are the provider's normalized `AdapterEvent`s, in order; the last one is terminal.
 */
export interface ChatGptWebTextTurn {
  /** Resolves when the provider proved the surface is ready. */
  readonly ready: Promise<void>;
  /** The submission phase the provider proved, at the moment it is asked. */
  submissionPhase(): SubmissionPhase;
  /** Resolves with the phase the provider proved, or with the final phase if the turn ended first. */
  awaitSubmission(): Promise<SubmissionPhase>;
  /** The provider's normalized events for this turn, until its terminal event. */
  readonly events: AsyncIterable<AdapterEvent>;
  /** Resolves with the provider's physical settlement outcome. */
  settled(): Promise<PhysicalSettlementOutcome>;
  /** Cancel this turn. Idempotent. */
  abort(reason?: unknown): Promise<void>;
  /** Resolves when the turn's logical execution finished, whether it succeeded or failed. */
  readonly finished: Promise<void>;
}

/**
 * The queue behind {@link ChatGptWebTextTurn.events}, plus the phase facts the same turn reports.
 *
 * It is a plain push queue, not a scheduler: the adapter pushes the provider's normalized events, and
 * the phases are resolved as they happen. `ready` and `settled()` always settle even when the turn
 * dies early, so a consumer can never hang on a turn that produced nothing. A settlement the provider
 * never established makes `settled()` reject instead of inventing a verdict — the exchange then
 * retires the resource, which is the fail-closed behaviour architecture §9.3 requires.
 */
export interface ChatGptTurnEventQueue extends AsyncIterable<AdapterEvent> {
  push(event: AdapterEvent): void;
  close(): void;
  markReady(): void;
  markSubmission(phase: SubmissionPhase): void;
  markSettled(outcome: PhysicalSettlementOutcome): void;
  submission(): SubmissionPhase;
  /** Resolves when the provider proved either submission phase, or when the turn ended. */
  whenSubmissionProven(): Promise<void>;
  /** Resolves when the provider proved acceptance, or when the turn ended. */
  whenSubmissionAccepted(): Promise<void>;
  settled(): Promise<PhysicalSettlementOutcome>;
  readonly ready: Promise<void>;
}

/** Create the queue one phased turn reports through. */
export function createChatGptTurnEventQueue(): ChatGptTurnEventQueue {
  const buffered: AdapterEvent[] = [];
  let closed = false;
  let resolveNext: ((value: IteratorResult<AdapterEvent>) => void) | undefined;
  let phase: SubmissionPhase = "prepared";
  let settledOutcome: PhysicalSettlementOutcome | undefined;
  let settledFailure: Error | undefined;
  let readyResolved = false;
  let submissionResolved = false;
  const readyWaiters: Array<() => void> = [];
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  let resolveSubmission: () => void = () => {};
  const submissionProven = new Promise<void>(resolve => { resolveSubmission = resolve; });
  let acceptedResolved = false;
  let resolveAccepted: () => void = () => {};
  const accepted = new Promise<void>(resolve => { resolveAccepted = resolve; });
  let resolveSettled: (outcome: PhysicalSettlementOutcome) => void = () => {};
  let rejectSettled: (error: Error) => void = () => {};
  const settled = new Promise<PhysicalSettlementOutcome>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  settled.catch(() => undefined);

  const settleReady = (): void => {
    if (readyResolved) return;
    readyResolved = true;
    resolveReady();
    for (const waiter of readyWaiters.splice(0)) waiter();
  };
  const settleSubmission = (): void => {
    if (submissionResolved) return;
    submissionResolved = true;
    resolveSubmission();
  };
  const settleAccepted = (): void => {
    if (acceptedResolved) return;
    acceptedResolved = true;
    resolveAccepted();
  };

  return {
    ready,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const value = buffered.shift();
        if (value !== undefined) {
          yield value;
          continue;
        }
        if (closed) return;
        const next = await new Promise<IteratorResult<AdapterEvent>>(resolve => { resolveNext = resolve; });
        if (next.done) return;
        yield next.value;
      }
    },
    push(event) {
      if (closed) return;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: event, done: false });
        return;
      }
      buffered.push(event);
    },
    close() {
      if (closed) return;
      closed = true;
      // A turn that ended without proving readiness or settlement must not hang its consumer.
      settleReady();
      settleSubmission();
      settleAccepted();
      if (settledOutcome === undefined && settledFailure === undefined) {
        settledFailure = new Error("The ChatGPT turn ended without establishing a physical settlement");
        rejectSettled(settledFailure);
      }
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: undefined as unknown as AdapterEvent, done: true });
      }
    },
    markReady: settleReady,
    markSubmission(nextPhase) {
      // The provider's phase is monotonic: an `accepted` proof always outranks an earlier
      // `send_activated`, and `send_activated` only promotes a still-prepared turn.
      if (nextPhase === "accepted" || phase === "prepared") phase = nextPhase;
      settleSubmission();
      if (phase === "accepted") settleAccepted();
    },
    markSettled(outcome) {
      if (settledOutcome !== undefined || settledFailure !== undefined) return;
      settledOutcome = outcome;
      resolveSettled(outcome);
    },
    submission: () => phase,
    whenSubmissionProven: () => submissionProven,
    whenSubmissionAccepted: () => accepted,
    settled: () => settled,
  };
}

/**
 * Resolve the phase one submission reached.
 *
 * The shared exchange cannot stream after an ambiguous submission, so this waits for the provider's
 * **final** phase: acceptance, or the end of the turn. A turn that ended while its send was only
 * activated therefore answers `send_activated` — the provider's honest, ambiguous verdict — and a
 * turn that never sent answers `prepared`. Both are facts, not guesses.
 */
export async function awaitChatGptSubmissionPhase(
  queue: ChatGptTurnEventQueue,
  finished: Promise<void>,
): Promise<SubmissionPhase> {
  await Promise.race([
    queue.whenSubmissionAccepted(),
    finished.then(() => undefined, () => undefined),
  ]);
  return queue.submission();
}
