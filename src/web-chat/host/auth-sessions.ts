/**
 * Sign-in session manager: lifecycle, TTL and frame cache for {@link ProviderAuthSession} (issue
 * #276).
 *
 * This module owns **lifecycle, not pixels**. It never sees a `Page`, a CDP session, a selector or a
 * URL, and it never decodes a frame; it relays what the provider produced and forgets it on request.
 * The provider keeps owning navigation, input interpretation and completion detection, which is what
 * lets a provider with no browser at all (device code, OTP, API key) be served exactly like one with
 * a browser.
 *
 * What it owns:
 *
 * - **One active session per provider.** A second `open` for the same provider is refused
 *   (`TRANSPORT_UNAVAILABLE`) until the first is terminal, so two sign-ins can never race over one
 *   account's state. Provider selection itself stays with the host, which is why `open` is given the
 *   already-selected provider id and the manager only verifies the session it got back belongs to it.
 * - **A fixed TTL with an expiry sweep.** Past `expiresAt` a session becomes `expired`, its provider
 *   session is cancelled, and its provider slot is released. The sweep timer is `unref`'d and is
 *   always cancelled by `close()`, so it can never keep the process alive or outlive the manager.
 * - **A frame cache.** A late subscriber gets the last frame immediately without touching the
 *   provider. `input()` invalidates the cache while the session can still change, and `invalidate()`
 *   is public, so the caller can paint a fresh frame right after an input without this module
 *   knowing anything about the mechanism behind it.
 *
 * What it deliberately does not own:
 *
 * - **Storage.** On `captured` the manager writes nothing. It hands the provider's opaque session to
 *   the caller through {@link WebChatAuthSession.capturedSession}, and the caller persists it.
 * - **The captured material.** No cookie, token or storage state crosses this boundary; the manager
 *   only knows that the provider reported `captured`.
 *
 * The close reason is a diagnostic convenience: `state()` always speaks the six-value contract
 * vocabulary, so a caller that only understands the contract sees the same six states everywhere.
 */
import { randomUUID } from "node:crypto";

import {
  isAuthInput,
  isAuthSessionState,
  isProviderAuthView,
  webChatError,
  type AuthInput,
  type AuthSessionState,
  type ProviderAuthController,
  type ProviderAuthSession,
  type ProviderAuthView,
} from "../core";

/** Why a session stopped being usable. Diagnostics only; `state()` never widens the vocabulary. */
export type WebChatAuthSessionCloseReason = "captured" | "cancelled" | "expired" | "failed";

/** What an observer may ask about one session, without touching the provider. */
export interface WebChatAuthSessionSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly state: AuthSessionState;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** How it ended, when it has. */
  readonly closeReason?: WebChatAuthSessionCloseReason;
  /** Non-secret diagnostic detail (a provider cancellation failure, for instance). */
  readonly detail?: string;
}

/** One managed sign-in session. */
export interface WebChatAuthSession {
  readonly id: string;
  readonly providerId: string;
  /** Current state; reads the provider, so a `captured`/`failed` transition is observed eagerly. */
  state(): AuthSessionState;
  /** The lifecycle facts, including the TTL and the close reason. */
  snapshot(): WebChatAuthSessionSnapshot;
  /**
   * The current frame: the cache when one is valid, otherwise a fresh `view()` from the provider.
   *
   * A late subscriber therefore gets the last frame immediately. A `captured` session serves its
   * cached frame without asking the provider again (its mechanism may already be gone).
   */
  view(): Promise<ProviderAuthView>;
  /**
   * Relay one input and invalidate the cached frame while the session is still interactive, so the
   * caller's next `view()` is fresh.
   *
   * This is the whole "a frame after every input" primitive; the manager does not need to know what
   * changed, or how the provider produces a frame. An input that terminalizes the session keeps the
   * last relayed frame instead, so `view()` still answers at the moment sign-in completed.
   */
  input(event: AuthInput): Promise<void>;
  /** Drop the cached frame, so the next `view()` asks the provider again. */
  invalidate(): void;
  /**
   * Cancel the sign-in and release the provider session.
   *
   * Deterministic and idempotent: the manager always reaches a terminal state even if the provider's
   * `cancel()` rejects (the failure is recorded as `detail`), and a second call does nothing. A
   * `captured` session is *not* terminalized by this — but its provider session is still cancelled,
   * which is how a caller releases the mechanism after it has stored the captured material.
   */
  cancel(): Promise<void>;
  /**
   * The provider's own session once the provider reported `captured` — the handoff the caller
   * stores. Refused with `CONVERSATION_STATE_MISMATCH` before that, so captured material can never
   * be read before the provider proved the sign-in succeeded. The manager never inspects it.
   */
  capturedSession(): ProviderAuthSession;
}

/** What a caller supplies to start one session. */
export interface WebChatAuthSessionOpenInput {
  /** The provider the host already selected; the manager never routes or invents one. */
  readonly providerId: string;
  /** The provider's auth capability. */
  readonly controller: ProviderAuthController;
}

/** Construction options for {@link createWebChatAuthSessionManager}. */
export interface WebChatAuthSessionManagerOptions {
  /** Session lifetime, from creation. Default 10 minutes. */
  readonly ttlMs?: number;
  /** Clock seam; tests inject one so expiry needs no real time. */
  readonly now?: () => number;
  /** How often expired sessions are swept. `0` disables the timer; `sweep()` still works. */
  readonly sweepIntervalMs?: number;
  /**
   * Timer seam: the manager schedules its recurring sweep through this and cancels it with the
   * returned function on `close()`. Injected so a test can prove the wiring — and that no timer
   * survives `close()` — without depending on real time.
   */
  readonly schedule?: (run: () => void | Promise<void>, intervalMs: number) => () => void;
}

/** The manager. In-process, and deliberately not a scheduler, a store or a second routing authority. */
export interface WebChatAuthSessionManager {
  /**
   * Start one sign-in session for the given provider.
   *
   * @throws {WebChatError} `TRANSPORT_UNAVAILABLE` when another session for that provider is active.
   * @throws {WebChatError} `CONVERSATION_STATE_MISMATCH` when the started session does not belong to
   *   the requested provider (a provider defect; the session is cancelled rather than served).
   * @throws {WebChatError} `SHUTDOWN` when the manager was closed.
   * @throws {TypeError} when the input is malformed.
   */
  open(input: WebChatAuthSessionOpenInput): Promise<WebChatAuthSession>;
  /** One session by id, whatever its state. */
  get(id: string): WebChatAuthSession | undefined;
  /** The active (non-terminal) session of one provider, when one exists. */
  activeFor(providerId: string): WebChatAuthSession | undefined;
  /** Expire every session past its TTL now. Returns how many were expired. */
  sweep(): Promise<number>;
  /** Cancel the sweep timer and every active session. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** Whether a state means the session holds no more sign-in work. */
function isTerminalAuthState(state: AuthSessionState): boolean {
  return state === "captured" || state === "failed" || state === "expired";
}

/** The default sweep timer: recurring, and never a reason for the process to stay alive. */
function defaultSchedule(run: () => void | Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void Promise.resolve().then(run).catch(() => {
      // A sweep that throws must not become an unhandled rejection; `sweep()` itself records
      // per-provider cancellation failures on the session instead.
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

interface AuthSessionEntry {
  readonly id: string;
  readonly providerId: string;
  readonly provider: ProviderAuthSession;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: AuthSessionState;
  frameValid: boolean;
  cancelRequested: boolean;
  closeReason?: WebChatAuthSessionCloseReason;
  detail?: string;
  frame?: ProviderAuthView;
  /** Stable handle identity: reading the same session twice returns the same object. */
  handle?: WebChatAuthSession;
}

/**
 * Create one session manager.
 *
 * @param options - TTL, clock, sweep interval and timer seam. Tests inject the last two.
 * @returns the manager.
 */
export function createWebChatAuthSessionManager(
  options: WebChatAuthSessionManagerOptions = {},
): WebChatAuthSessionManager {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError("A WebChat auth session manager requires a positive session TTL");
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) {
    throw new TypeError("A WebChat auth session manager requires a non-negative sweep interval");
  }
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const sessions = new Map<string, AuthSessionEntry>();
  /** Providers whose `startAuth()` is in flight; reserved before the first await. */
  const starting = new Set<string>();
  let closed = false;
  let cancelSweep: (() => void) | undefined;

  /** Ask the provider, and refuse a state outside the vocabulary rather than guessing one. */
  const readProviderState = (entry: AuthSessionEntry): AuthSessionState => {
    const state = entry.provider.state();
    if (!isAuthSessionState(state)) {
      throw webChatError(
        "UPSTREAM_ERROR",
        `Provider ${entry.providerId} reported an unknown auth session state`,
        { providerId: entry.providerId },
      );
    }
    return state;
  };

  /** Move a session to its terminal state. Only `captured` keeps its frame (the caller's handoff). */
  const terminalize = (entry: AuthSessionEntry, reason: WebChatAuthSessionCloseReason): void => {
    if (reason === "captured") entry.state = "captured";
    else if (reason === "failed") entry.state = "failed";
    else entry.state = "expired";
    entry.closeReason = reason;
    if (reason !== "captured") {
      entry.frame = undefined;
      entry.frameValid = false;
    }
  };

  /**
   * Read the provider's state into the entry, terminalizing when it finished.
   *
   * A session already terminal in the manager is never re-opened by a late provider report.
   */
  const refresh = (entry: AuthSessionEntry): AuthSessionState => {
    if (isTerminalAuthState(entry.state)) return entry.state;
    const state = readProviderState(entry);
    entry.state = state;
    if (state === "captured") terminalize(entry, "captured");
    else if (state === "failed") terminalize(entry, "failed");
    return entry.state;
  };

  /** Cancel the provider session once per session; a failure is recorded, never thrown. */
  const cancelProvider = async (entry: AuthSessionEntry): Promise<void> => {
    if (entry.cancelRequested) return;
    entry.cancelRequested = true;
    try {
      await entry.provider.cancel();
    } catch (error) {
      entry.detail = error instanceof Error ? error.message : String(error);
    }
  };

  /** Refuse an operation that a terminal session cannot serve, by the semantic category. */
  const assertInteractive = (entry: AuthSessionEntry, action: string): void => {
    if (entry.state === "starting" || entry.state === "awaiting_input" || entry.state === "verifying") {
      return;
    }
    if (entry.state === "expired") {
      throw webChatError(
        "AUTH_EXPIRED",
        `The sign-in session for ${entry.providerId} expired and cannot ${action}`,
        { providerId: entry.providerId },
      );
    }
    if (entry.state === "failed") {
      throw webChatError(
        "UPSTREAM_ERROR",
        `The sign-in session for ${entry.providerId} failed and cannot ${action}`,
        { providerId: entry.providerId },
      );
    }
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      `The sign-in session for ${entry.providerId} already captured and cannot ${action}`,
      { providerId: entry.providerId },
    );
  };

  const handleOf = (entry: AuthSessionEntry): WebChatAuthSession => {
    if (entry.handle) return entry.handle;
    const handle: WebChatAuthSession = {
      id: entry.id,
      providerId: entry.providerId,

      state() {
        return refresh(entry);
      },

      snapshot() {
        refresh(entry);
        return {
          id: entry.id,
          providerId: entry.providerId,
          state: entry.state,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          ...(entry.closeReason !== undefined ? { closeReason: entry.closeReason } : {}),
          ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        };
      },

      async view() {
        const state = refresh(entry);
        if (state === "captured") {
          if (entry.frame) return entry.frame;
          throw webChatError(
            "CONVERSATION_STATE_MISMATCH",
            `The sign-in session for ${entry.providerId} already captured and relayed no frame`,
            { providerId: entry.providerId },
          );
        }
        assertInteractive(entry, "relay a frame");
        if (entry.frameValid && entry.frame) return entry.frame;
        const frame = await entry.provider.view();
        if (!isProviderAuthView(frame)) {
          throw webChatError(
            "UPSTREAM_ERROR",
            `Provider ${entry.providerId} returned a malformed auth frame`,
            { providerId: entry.providerId },
          );
        }
        // The provider may have finished while the frame was produced: a captured session still
        // relays this last frame, but a session that expired or failed underneath must not hand one
        // back as if it were live.
        if (refresh(entry) !== "captured") assertInteractive(entry, "relay a frame");
        entry.frame = frame;
        entry.frameValid = true;
        return frame;
      },

      async input(event) {
        refresh(entry);
        assertInteractive(entry, "accept input");
        if (!isAuthInput(event)) {
          throw new TypeError("A WebChat auth input must be one of click, type, key, scroll or navigate");
        }
        await entry.provider.input(event);
        // The provider may have completed the sign-in while handling this very input.
        refresh(entry);
        // Invalidate-after-input, while the session can still change: the next view() must ask the
        // provider again, so the caller can paint the immediately-following frame without this module
        // knowing what changed. A terminal input (captured/failed) keeps the last relayed frame, so a
        // caller's final view() is served gracefully at the exact moment sign-in succeeded instead of
        // failing on a provider whose mechanism may already be gone.
        if (!isTerminalAuthState(entry.state)) {
          entry.frame = undefined;
          entry.frameValid = false;
        }
      },

      invalidate() {
        entry.frame = undefined;
        entry.frameValid = false;
      },

      async cancel() {
        await cancelProvider(entry);
        if (!isTerminalAuthState(entry.state)) {
          terminalize(entry, "cancelled");
          if (entry.detail === undefined) entry.detail = "The sign-in session was cancelled";
        }
      },

      capturedSession() {
        if (refresh(entry) !== "captured") {
          throw webChatError(
            "CONVERSATION_STATE_MISMATCH",
            `The sign-in session for ${entry.providerId} has not captured`,
            { providerId: entry.providerId },
          );
        }
        return entry.provider;
      },
    };
    entry.handle = handle;
    return handle;
  };

  const manager: WebChatAuthSessionManager = {
    async open(input) {
      if (closed) {
        throw webChatError("SHUTDOWN", "The WebChat auth session manager is closed");
      }
      const providerId = input?.providerId;
      if (typeof providerId !== "string" || providerId.length === 0) {
        throw new TypeError("A WebChat auth session requires a provider identity");
      }
      if (!input.controller || typeof input.controller.startAuth !== "function") {
        throw new TypeError("A WebChat auth session requires a provider auth controller");
      }
      if (starting.has(providerId) || manager.activeFor(providerId)) {
        throw webChatError(
          "TRANSPORT_UNAVAILABLE",
          `A sign-in session for provider ${providerId} is already active`,
          { providerId },
        );
      }
      // Reserved before the first await, so two concurrent opens cannot both start one.
      starting.add(providerId);
      let provider: ProviderAuthSession | undefined;
      try {
        provider = await input.controller.startAuth();
      } finally {
        starting.delete(providerId);
      }
      if (!provider || provider.providerId !== providerId) {
        // Fail closed: a session that does not belong to the requested provider is never served, and
        // is released rather than left running.
        if (provider) {
          try {
            await provider.cancel();
          } catch {
            // Releasing is best effort; the mismatch is the failure being reported.
          }
        }
        throw webChatError(
          "CONVERSATION_STATE_MISMATCH",
          `The started auth session does not belong to provider ${providerId}`,
          { providerId },
        );
      }
      const createdAt = now();
      const entry: AuthSessionEntry = {
        id: randomUUID(),
        providerId,
        provider,
        createdAt,
        expiresAt: createdAt + ttlMs,
        state: "starting",
        frameValid: false,
        cancelRequested: false,
      };
      sessions.set(entry.id, entry);
      try {
        // Observe the provider at once: the sign-in may already be interactive (or already done).
        refresh(entry);
      } catch (error) {
        // A provider that cannot even report its state is never handed to a caller: release it
        // instead of leaving an orphan session registered under the provider's slot.
        sessions.delete(entry.id);
        try {
          await provider.cancel();
        } catch {
          // The observation failure is the error being reported.
        }
        throw error;
      }
      return handleOf(entry);
    },

    get(id) {
      const entry = sessions.get(id);
      return entry ? handleOf(entry) : undefined;
    },

    activeFor(providerId) {
      for (const entry of sessions.values()) {
        if (entry.providerId !== providerId) continue;
        if (!isTerminalAuthState(refresh(entry))) return handleOf(entry);
      }
      return undefined;
    },

    async sweep() {
      let expired = 0;
      // A snapshot of the entries: sweep never adds or removes sessions, but providers are awaited.
      for (const entry of [...sessions.values()]) {
        refresh(entry);
        if (isTerminalAuthState(entry.state)) continue;
        if (now() < entry.expiresAt) continue;
        terminalize(entry, "expired");
        if (entry.detail === undefined) entry.detail = "The sign-in session expired";
        expired += 1;
        await cancelProvider(entry);
      }
      return expired;
    },

    async close() {
      if (closed) return;
      closed = true;
      cancelSweep?.();
      cancelSweep = undefined;
      for (const entry of [...sessions.values()]) {
        // A captured session is deliberately left alone: the caller still has to store the material
        // it hands over, and cancelling the provider would destroy it first.
        if (isTerminalAuthState(entry.state)) continue;
        terminalize(entry, "cancelled");
        if (entry.detail === undefined) entry.detail = "The auth session manager was closed";
        await cancelProvider(entry);
      }
    },
  };

  if (sweepIntervalMs > 0) {
    cancelSweep = schedule(async () => {
      await manager.sweep();
    }, sweepIntervalMs);
  }
  return manager;
}
