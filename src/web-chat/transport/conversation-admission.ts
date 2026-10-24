/**
 * Conversation admission — the serialising half of "one active turn per conversation".
 *
 * A provider that owns one conversation's transport resource must order the turns that address it.
 * The refusal for a busy conversation is correct, but the conflict is usually *transient*: this
 * product's harness issues its session-title housekeeping call at the same moment as the user's first
 * message, and `@earendil-works/pi-ai` never maps `GenerateOptions.purpose` onto an OpenAI-compatible
 * wire, so that call arrives **undeclared** and shares the session's conversation. Failing the user's
 * turn in ~0 ms because the title won the race loses a real turn.
 *
 * This module owns exactly one mechanism: a bounded, cancellable, event-driven **admission slot** per
 * conversation. It owns no provider knowledge, no lease, no physical resource and no error vocabulary —
 * the caller supplies the refusal it publishes, so the shared transport layer and the provider that
 * predates it express the same rule through one implementation instead of two copies that can drift.
 *
 * Waiters hold nothing while they wait and are woken by a release, never by a poller. The holder stays
 * the only authority on when the conversation frees; the bound only decides which arrives first, and
 * an expired bound fails closed with exactly the refusal the caller already publishes for a busy
 * conversation.
 */

/**
 * Default bound of one **conversation admission wait**, in milliseconds.
 *
 * A caller that requires a conversation's transport while another exchange is using it waits this
 * long before the turn fails closed with the same refusal it already publishes. The number is chosen
 * from the measured competitor rather than from taste: this product's own harness runs the
 * session-title housekeeping call with a 60-second deadline
 * (`@deepseek-ai/dsh-experimental-session-titles-bundle`: `timeoutMs: 60000`), so a courtesy window
 * of the same size never pre-empts that call's own deadline — a housekeeping call blocked by a long
 * user turn is aborted by the caller's own cancellation, never by this bound — while a genuine
 * concurrency violation still fails closed within a minute instead of queueing behind a 15-minute
 * turn ceiling.
 *
 * One measured example of a slow title call in this project took 1 m 5 s, which is why a shorter
 * courtesy window (the former ChatGPT-specific 30 s) refused real turns. There is one number, owned
 * here, shared by every admission: do not add a second bound.
 */
export const DEFAULT_TRANSPORT_ADMISSION_WAIT_MS = 60_000;

/** One request for a conversation's admission slot. */
export interface ConversationAdmissionRequest {
  /** Identity of the requester, so its own re-admission is re-entrant and only it may release. */
  readonly holder: string;
  readonly conversationKey: string;
  /** Cancellation of the whole turn; a cancelled wait fails through `abortError`. */
  readonly signal?: AbortSignal;
  /**
   * An extra, caller-owned reason the conversation must not be admitted yet.
   *
   * A caller that holds a reservation outside the slot map (for example a begun-turn guard) reports it
   * here, so the same bounded wait covers it. The caller must notify
   * {@link ConversationAdmissionGate.notifyReleased} when that condition clears.
   */
  readonly blocked?: () => boolean;
}

/** The refusal vocabulary the gate publishes, supplied by its owner. */
export interface ConversationAdmissionGateOptions {
  /**
   * Bound of one admission wait. `0` (the default) keeps the historical immediate refusal; a positive
   * value serialises a transient overlap instead of failing it.
   */
  readonly admissionWaitMs?: number;
  /** The refusal published when the bound expires while the conversation is still owned. */
  readonly busyError: () => Error;
  /** The cancellation published when the caller's signal aborts the wait. */
  readonly abortError: (signal?: AbortSignal) => Error;
  /** The refusal published when the gate has been closed (shutdown). */
  readonly closedError: () => Error;
}

/** The one admission-slot owner for a registry or provider core. */
export interface ConversationAdmissionGate {
  /**
   * Take the conversation's one admission slot, waiting for its current holder to release it.
   *
   * The wait is bounded ({@link ConversationAdmissionGateOptions.admissionWaitMs}), cancellable through
   * the caller's abort signal, and event-driven: a waiter holds nothing while it waits and is woken by
   * the release, never by polling. On expiry the refusal is `busyError()`.
   */
  admit(request: ConversationAdmissionRequest): Promise<void>;
  /**
   * Take a slot synchronously for a holder that has already been admitted.
   *
   * Used when a turn begins after its admission decision: `begin` must register the same reservation a
   * caller obtained through {@link admit}, so a direct `begin` (without the asynchronous preamble) still
   * enforces per-conversation exclusivity.
   */
  claim(holder: string, conversationKey: string): void;
  /** Release a slot this holder owns. Idempotent, and silent for another holder. */
  release(holder: string, conversationKey: string): void;
  /** Whether a conversation currently has an admission holder. */
  isAdmitted(conversationKey: string): boolean;
  /** The execution holding the conversation's slot, if any. */
  admissionHolder(conversationKey: string): string | undefined;
  /** Diagnostic: how many admissions are currently waiting. */
  waiterCount(): number;
  /**
   * Wake waiters to re-check a caller-owned blocking condition.
   *
   * Called from the release points of a condition passed as
   * {@link ConversationAdmissionRequest.blocked}; a spurious wake is harmless (the waiter re-checks).
   */
  notifyReleased(conversationKey: string): void;
  /** Refuse every waiter and forget every admission. Idempotent; used on shutdown. */
  close(): void;
}

export function createConversationAdmissionGate(
  options: ConversationAdmissionGateOptions,
): ConversationAdmissionGate {
  const admissionWaitMs = options.admissionWaitMs ?? 0;
  if (!Number.isFinite(admissionWaitMs) || admissionWaitMs < 0) {
    throw new Error("A conversation admission wait must be a non-negative finite number");
  }
  const admissions = new Map<string, string>();
  const waiters = new Map<string, Set<() => void>>();
  let closed = false;

  /** Wake every admission waiting on a conversation; called from the release points. */
  const wakeWaiters = (conversationKey: string): void => {
    const waiting = waiters.get(conversationKey);
    if (!waiting) return;
    waiters.delete(conversationKey);
    for (const wake of waiting) wake();
  };

  /**
   * Wait for one admission release on a conversation, bounded and cancellable.
   *
   * Shaped after the provider's existing bounded waits (issue #301): the release owner stays the only
   * authority on the outcome, this bound only decides which arrives first, and the timer and the
   * abort listener are removed in one cleanup, so a wait that ends leaves no handle behind. `false`
   * means the bound expired and the caller must fail closed.
   */
  const waitForRelease = (
    conversationKey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    return new Promise<boolean>((resolve, reject) => {
      if (signal?.aborted) {
        reject(options.abortError(signal));
        return;
      }
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiting = waiters.get(conversationKey) ?? new Set<() => void>();
      waiters.set(conversationKey, waiting);
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiting.delete(wake);
        if (waiting.size === 0 && waiters.get(conversationKey) === waiting) {
          waiters.delete(conversationKey);
        }
      };
      const finish = (released: boolean): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve(released);
      };
      const wake = (): void => finish(true);
      const onAbort = (): void => {
        if (done) return;
        done = true;
        cleanup();
        reject(options.abortError(signal));
      };
      waiting.add(wake);
      timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    async admit({ holder, conversationKey, signal, blocked }) {
      if (!holder) throw new TypeError("A conversation admission requires a holder identity");
      if (!conversationKey) throw new TypeError("A conversation admission requires a conversation key");
      const deadline = Date.now() + admissionWaitMs;
      for (;;) {
        if (signal?.aborted) throw options.abortError(signal);
        if (closed) throw options.closedError();
        const current = admissions.get(conversationKey);
        if ((current === undefined || current === holder) && !blocked?.()) {
          admissions.set(conversationKey, holder);
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw options.busyError();
        // A released slot wakes the waiter; a bound that expires first fails closed with the refusal
        // this owner already publishes, so a genuine concurrency violation is never queued forever.
        if (!await waitForRelease(conversationKey, remaining, signal)) {
          throw options.busyError();
        }
      }
    },
    claim(holder, conversationKey) {
      if (!holder || !conversationKey) return;
      admissions.set(conversationKey, holder);
    },
    release(holder, conversationKey) {
      if (!holder || !conversationKey) return;
      if (admissions.get(conversationKey) !== holder) return;
      admissions.delete(conversationKey);
      wakeWaiters(conversationKey);
    },
    isAdmitted(conversationKey) {
      return admissions.has(conversationKey);
    },
    admissionHolder(conversationKey) {
      return admissions.get(conversationKey);
    },
    waiterCount() {
      let count = 0;
      for (const waiting of waiters.values()) count += waiting.size;
      return count;
    },
    notifyReleased(conversationKey) {
      wakeWaiters(conversationKey);
    },
    close() {
      if (closed) return;
      closed = true;
      admissions.clear();
      for (const conversationKey of [...waiters.keys()]) wakeWaiters(conversationKey);
    },
  };
}
