/**
 * Per-request and per-operation browser-turn accounting (issue #359).
 *
 * ## Why this owner exists
 *
 * Every Hindsight LLM call becomes one full ChatGPT browser turn: navigate/hydrate the surface,
 * select model and effort, submit, wait for generation, detect completion. Hindsight's volume is not
 * small — `retain` extracts per chunk, consolidation runs on its own schedule and `reflect` is a
 * multi-turn loop — so "fewer browser turns per operation" is only a measurement if the bridge
 * publishes the numbers. Before this module the control surface gave the operator no number to reason
 * about: how many browser turns did one `retain` cost, how much of the request was spent waiting for
 * an account slot, and how much context did a stateless caller replay?
 *
 * This module owns exactly that: a bounded, read-only observation of the turns a request actually
 * started. It never decides reuse, never merges calls, never caches an answer and never touches a
 * provider conversation. The provider core and the adapter record facts into it; the control surface
 * publishes the snapshot beside `turnQueue` (issue #358).
 *
 * ## The operation scope (reuse within, never across)
 *
 * The unit the metric groups by is the **operation**: the caller's declared conversation identity —
 * the native `dsh_session_id`/`thread_id`, an OpenAI `user`/`session_id`, or the `prompt_cache_key`
 * channel (`src/web-chat/host/turn-identity.ts`). A `reflect` loop that declares one operation
 * identity continues one provider conversation, so its turns are continuations; a different operation
 * gets a different conversation and can never see the first one's context. A caller that declares no
 * identity gets the content-derived identity, which is isolation rather than continuity: each distinct
 * content is its own operation (see `src/web-chat/host/api-projection.ts`).
 *
 * That boundary is enforced by the conversation key the provider already derives from the same
 * identity — this module only observes it, so it cannot become a second authority over reuse. The
 * operation is stored as a fingerprint: no prompt text, no raw session identity and no conversation
 * key ever reaches the control surface.
 *
 * ## Browser turns, continuations and replay size
 *
 * - A **browser turn** is one physical provider submission (`WebSurfaceTransport.run`): the expensive
 *   unit. A request that is refused before the browser is reached started none. A request can also be
 *   answered by observing a turn another request started (a reconnect): it started no browser turn of
 *   its own, so it reports none — the field describes this request's work, not the conversation's.
 * - A **continuation** is a browser turn whose prompt was compiled as a delta on the operation's
 *   existing provider conversation; a **replay** is one that had to compile the canonical history
 *   (install/replay). The split is what shows the effect of an operation identity: the same 3-call
 *   workload is 3 replays without one and 1 replay + 2 continuations with one.
 * - The **replay size** is reported twice, because the two facts answer different questions:
 *   `replayMessages` is the number of messages the request transmitted to the provider (the
 *   projection's output — a stateless caller sends its whole history, a session-addressed caller sends
 *   only the newest user message), and `replayChars` is the size of the prompt the browser turn
 *   actually compiled. A continuation reports only its delta in both, so the metric makes the cost of
 *   a stateless caller observable.
 *
 * ## Absent is not zero
 *
 * A request that never reached the provider has **no** `browserTurns`, `turnMs` or `replayMessages`
 * field. Reporting `0` would be a measurement of something that never happened; a caller can tell
 * "the turn never reached ChatGPT" from "the turn reached it and cost nothing" by the field's absence,
 * exactly as the API omits an unmeasured `usage` block (`doc/container.md`).
 *
 * This is deliberately **not** token accounting: the bridge reports an **estimated** `usage` block
 * (locally produced by tiktoken, see `doc/container.md`), and this module never invents a token
 * measurement. It counts turns, waits and prompt sizes — facts the provider actually observed.
 *
 * ## Bounds and privacy
 *
 * The recent-request ring and the per-operation table are bounded, so a deployment that serves many
 * sessions cannot grow the control surface without limit. Operation keys are the 12-hex fingerprint
 * this product already uses for diagnostics (`fingerprintDiagnosticValue`), and the snapshot carries
 * counters only: no prompt text, no raw identity, no credential, no conversation key.
 */
import { fingerprintDiagnosticValue } from "../../lib/safe-diagnostics";

/** How one request ended, as the adapter observed it. `pending` is an in-flight request. */
export type ChatGptTurnAccountingOutcome = "pending" | "completed" | "failed" | "refused" | "cancelled";

/** How one browser turn's prompt was compiled: a fresh conversation or a delta on an existing one. */
export type ChatGptTurnPromptKind = "install" | "continuation";

/** One request's observable turn accounting. Fields are absent when the fact never happened. */
export interface ChatGptTurnAccountingRequestSnapshot {
  /** Monotonic request sequence within this process. Not an identity. */
  readonly seq: number;
  /** Fingerprint of the operation the request belongs to. */
  readonly operation: string;
  /** When the request began, epoch milliseconds. */
  readonly at: number;
  /** Browser turns this request started. Absent when it never reached the provider. */
  readonly browserTurns?: number;
  /** Of those, turns that compiled the canonical history (install/replay). Absent when none. */
  readonly replayTurns?: number;
  /** Of those, turns that compiled a delta on the operation's conversation. Absent when none. */
  readonly continuationTurns?: number;
  /** Messages the request's compiled prompt(s) carried. Absent when no prompt was compiled. */
  readonly replayMessages?: number;
  /** Characters of the request's compiled prompt(s). Absent when no prompt was compiled. */
  readonly replayChars?: number;
  /** How long the request waited for an account slot, milliseconds. Absent when it never queued. */
  readonly waitMs?: number;
  /** Total browser-turn wall time, milliseconds. Absent when no browser turn started. */
  readonly turnMs?: number;
  readonly outcome: ChatGptTurnAccountingOutcome;
}

/** One operation's aggregate view: how many requests, turns, continuations and how much wait. */
export interface ChatGptTurnAccountingOperationSnapshot {
  /** Fingerprint of the operation. */
  readonly operation: string;
  readonly requests: number;
  readonly browserTurns: number;
  readonly replayTurns: number;
  readonly continuationTurns: number;
  readonly replayMessages: number;
  readonly replayChars: number;
  readonly waitMsTotal: number;
  readonly waitMsMax: number;
  readonly turnMsTotal: number;
  readonly turnMsMax: number;
  /** When this operation was last observed, epoch milliseconds. */
  readonly lastSeenAt: number;
}

/** The whole observable state. Counters only: no prompt text and no raw identity. */
export interface ChatGptTurnAccountingSnapshot {
  readonly requests: number;
  readonly browserTurns: number;
  readonly replayTurns: number;
  readonly continuationTurns: number;
  readonly replayMessages: number;
  readonly replayChars: number;
  readonly waitMsTotal: number;
  readonly waitMsMax: number;
  readonly turnMsTotal: number;
  readonly turnMsMax: number;
  /** Most recent requests, oldest first. Bounded. */
  readonly recent: readonly ChatGptTurnAccountingRequestSnapshot[];
  /** Operations seen, most recently active first. Bounded. */
  readonly operations: readonly ChatGptTurnAccountingOperationSnapshot[];
}

/** What the adapter tells the accounting when a request begins. */
export interface ChatGptTurnAccountingRequestInput {
  /**
   * The operation the request belongs to, raw (the adapter's resolved conversation identity).
   * It is fingerprinted before storage and never published.
   */
  readonly operation: string;
}

/** One browser turn, as the adapter observes it. */
export interface ChatGptTurnBrowserTurn {
  /** Record the prompt this turn compiled. Called once, when the surface prepares it. */
  recordPrompt(kind: ChatGptTurnPromptKind, messages: number, chars: number): void;
  /** Record how the browser turn ended. Idempotent. */
  settle(outcome: "completed" | "failed"): void;
}

/** One request's accounting handle. */
export interface ChatGptTurnAccountingRequest {
  /** Record how long the request waited for an account slot. The last value wins. */
  recordWait(waitMs: number): void;
  /** Begin one browser turn. The caller must settle it exactly once. */
  beginBrowserTurn(): ChatGptTurnBrowserTurn;
  /** Record how the request ended. Idempotent; the first call wins. */
  finish(outcome: ChatGptTurnAccountingOutcome): void;
}

/** The accounting owner for one provider core. */
export interface ChatGptTurnAccounting {
  begin(input: ChatGptTurnAccountingRequestInput): ChatGptTurnAccountingRequest;
  snapshot(): ChatGptTurnAccountingSnapshot;
  /** Forget every request and aggregate. Used on shutdown; counters are process-lifetime otherwise. */
  clear(): void;
}

/**
 * How many recent requests the control surface keeps.
 *
 * Bounded so a deployment that serves many sessions cannot grow the snapshot without limit. The
 * per-operation table is bounded the same way: a stateless caller mints one operation per distinct
 * content, so an unbounded table would itself be a leak.
 */
export const MAX_ACCOUNTED_REQUESTS = 64;
/** How many operations the control surface keeps. */
export const MAX_ACCOUNTED_OPERATIONS = 32;

interface MutableRequestRecord {
  readonly seq: number;
  readonly operation: string;
  readonly at: number;
  browserTurns: number;
  replayTurns: number;
  continuationTurns: number;
  replayMessages: number;
  replayChars: number;
  waitMs?: number;
  turnMs: number;
  outcome: ChatGptTurnAccountingOutcome;
  finished: boolean;
}

interface MutableOperationRecord {
  readonly operation: string;
  requests: number;
  browserTurns: number;
  replayTurns: number;
  continuationTurns: number;
  replayMessages: number;
  replayChars: number;
  waitMsTotal: number;
  waitMsMax: number;
  turnMsTotal: number;
  turnMsMax: number;
  lastSeenAt: number;
}

interface Totals {
  requests: number;
  browserTurns: number;
  replayTurns: number;
  continuationTurns: number;
  replayMessages: number;
  replayChars: number;
  waitMsTotal: number;
  waitMsMax: number;
  turnMsTotal: number;
  turnMsMax: number;
}

function emptyTotals(): Totals {
  return {
    requests: 0,
    browserTurns: 0,
    replayTurns: 0,
    continuationTurns: 0,
    replayMessages: 0,
    replayChars: 0,
    waitMsTotal: 0,
    waitMsMax: 0,
    turnMsTotal: 0,
    turnMsMax: 0,
  };
}

/** A non-negative finite millisecond measurement, or `undefined` for a value that is not one. */
function measurement(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createChatGptTurnAccounting(): ChatGptTurnAccounting {
  const recent: MutableRequestRecord[] = [];
  const operations = new Map<string, MutableOperationRecord>();
  const totals = emptyTotals();
  let sequence = 0;

  const operationFor = (fingerprint: string): MutableOperationRecord => {
    let operation = operations.get(fingerprint);
    if (operation) {
      // A Map keeps insertion order; re-inserting moves the operation to the back so the bound
      // evicts the least recently active one, never a busy operation that happens to be old.
      operations.delete(fingerprint);
      operations.set(fingerprint, operation);
      return operation;
    }
    if (operations.size >= MAX_ACCOUNTED_OPERATIONS) {
      const oldest = operations.keys().next().value as string | undefined;
      if (oldest !== undefined) operations.delete(oldest);
    }
    operation = {
      operation: fingerprint,
      requests: 0,
      browserTurns: 0,
      replayTurns: 0,
      continuationTurns: 0,
      replayMessages: 0,
      replayChars: 0,
      waitMsTotal: 0,
      waitMsMax: 0,
      turnMsTotal: 0,
      turnMsMax: 0,
      lastSeenAt: 0,
    };
    operations.set(fingerprint, operation);
    return operation;
  };

  const begin = (input: ChatGptTurnAccountingRequestInput): ChatGptTurnAccountingRequest => {
    const operationKey = input.operation.trim() !== "" ? input.operation : "unaddressed";
    const fingerprint = fingerprintDiagnosticValue(operationKey);
    sequence += 1;
    const record: MutableRequestRecord = {
      seq: sequence,
      operation: fingerprint,
      at: Date.now(),
      browserTurns: 0,
      replayTurns: 0,
      continuationTurns: 0,
      replayMessages: 0,
      replayChars: 0,
      turnMs: 0,
      outcome: "pending",
      finished: false,
    };
    recent.push(record);
    if (recent.length > MAX_ACCOUNTED_REQUESTS) recent.splice(0, recent.length - MAX_ACCOUNTED_REQUESTS);
    const operation = operationFor(fingerprint);
    operation.requests += 1;
    operation.lastSeenAt = record.at;
    totals.requests += 1;

    const recordWait = (waitMs: number): void => {
      const measured = measurement(waitMs);
      if (measured === undefined) return;
      // A request may wait more than once (a context replay re-queues for a slot); the request's
      // wait is the sum of the waits it actually spent, and the operation's totals agree.
      record.waitMs = (record.waitMs ?? 0) + measured;
      operation.waitMsTotal += measured;
      operation.waitMsMax = Math.max(operation.waitMsMax, measured);
      totals.waitMsTotal += measured;
      totals.waitMsMax = Math.max(totals.waitMsMax, measured);
    };

    const beginBrowserTurn = (): ChatGptTurnBrowserTurn => {
      const startedAt = Date.now();
      record.browserTurns += 1;
      operation.browserTurns += 1;
      totals.browserTurns += 1;
      let settled = false;
      return {
        recordPrompt(kind, messages, chars) {
          const messageCount = Number.isSafeInteger(messages) && messages >= 0 ? messages : 0;
          const charCount = Number.isSafeInteger(chars) && chars >= 0 ? chars : 0;
          record.replayMessages += messageCount;
          record.replayChars += charCount;
          operation.replayMessages += messageCount;
          operation.replayChars += charCount;
          totals.replayMessages += messageCount;
          totals.replayChars += charCount;
          if (kind === "continuation") {
            record.continuationTurns += 1;
            operation.continuationTurns += 1;
            totals.continuationTurns += 1;
          } else {
            record.replayTurns += 1;
            operation.replayTurns += 1;
            totals.replayTurns += 1;
          }
        },
        settle(outcome) {
          if (settled) return;
          settled = true;
          const duration = Math.max(0, Date.now() - startedAt);
          record.turnMs += duration;
          operation.turnMsTotal += duration;
          operation.turnMsMax = Math.max(operation.turnMsMax, duration);
          totals.turnMsTotal += duration;
          totals.turnMsMax = Math.max(totals.turnMsMax, duration);
          // The last browser turn's outcome is the request's provisional outcome; the terminal event
          // the adapter observes afterwards is authoritative and overwrites it in `finish`.
          if (!record.finished) record.outcome = outcome;
        },
      };
    };

    const finish = (outcome: ChatGptTurnAccountingOutcome): void => {
      if (record.finished) return;
      record.finished = true;
      if (record.browserTurns === 0) {
        // The request started no browser turn. A completed one was answered by observing a turn
        // another request started (a reconnect); a cancellation is a cancellation; anything else is
        // the service refusing the request before any browser work started.
        record.outcome = outcome === "completed"
          ? "completed"
          : outcome === "cancelled"
            ? "cancelled"
            : "refused";
      } else if (outcome !== "pending") {
        record.outcome = outcome;
      }
      operation.lastSeenAt = Date.now();
    };

    return { recordWait, beginBrowserTurn, finish };
  };

  const requestSnapshot = (record: MutableRequestRecord): ChatGptTurnAccountingRequestSnapshot => ({
    seq: record.seq,
    operation: record.operation,
    at: record.at,
    ...(record.browserTurns > 0
      ? {
        browserTurns: record.browserTurns,
        replayTurns: record.replayTurns,
        continuationTurns: record.continuationTurns,
        turnMs: record.turnMs,
      }
      : {}),
    ...(record.replayTurns + record.continuationTurns > 0
      ? { replayMessages: record.replayMessages, replayChars: record.replayChars }
      : {}),
    ...(record.waitMs !== undefined ? { waitMs: record.waitMs } : {}),
    outcome: record.outcome,
  });

  const operationSnapshot = (operation: MutableOperationRecord): ChatGptTurnAccountingOperationSnapshot => ({
    operation: operation.operation,
    requests: operation.requests,
    browserTurns: operation.browserTurns,
    replayTurns: operation.replayTurns,
    continuationTurns: operation.continuationTurns,
    replayMessages: operation.replayMessages,
    replayChars: operation.replayChars,
    waitMsTotal: operation.waitMsTotal,
    waitMsMax: operation.waitMsMax,
    turnMsTotal: operation.turnMsTotal,
    turnMsMax: operation.turnMsMax,
    lastSeenAt: operation.lastSeenAt,
  });

  return {
    begin,
    snapshot() {
      return {
        ...totals,
        recent: recent.map(requestSnapshot),
        operations: [...operations.values()]
          .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
          .map(operationSnapshot),
      };
    },
    clear() {
      recent.splice(0);
      operations.clear();
      Object.assign(totals, emptyTotals());
      sequence = 0;
    },
  };
}
