/**
 * The host surface for interactive sign-in (issue #276, slice 2a).
 *
 * This is the layer between the operator's page and the provider-neutral contract: it owns the
 * provider *listing*, the HTTP-facing session view, the "store the capture once" handoff, and the
 * frame relay the page consumes. It owns no browser and no provider knowledge:
 *
 * - **The host selects, the provider signs in.** A registration is an already-selected provider plus
 *   its `ProviderAuthController`; an unknown provider id is refused here naming the valid ones. That
 *   is the same rule the rest of the host follows — this surface is not a second provider registry.
 * - **No pixel is mandatory.** A provider whose `view()` refuses (device code, OTP, an API key) is
 *   streamed as state only. The relay never requires a frame to reach `captured`, and a frame
 *   failure is never a session failure.
 * - **No credential is examined.** Captured material travels from the provider's own session to the
 *   provider's own `storeCapture`, once. This module validates the *envelope* (`isAuthCapture`) and
 *   never reads `storageState`/`payload`, never stores it, and never serializes it.
 * - **Frames arrive when something changed.** The relay is a per-session wake signal plus a slow
 *   tick, not a busy poll: an operator input wakes the stream immediately and `invalidate()`s the
 *   manager's frame cache, so the frame after an input is freshly produced rather than replayed.
 * - **A terminal session is eventually collected.** The manager collects it after its grace period
 *   (never before its capture handoff was released); this surface forgets its own reference in the
 *   same step, so a collected id answers exactly like an unknown one instead of being served from a
 *   stale closure.
 *
 * It orchestrates a sign-in; it is not an execution path for turns.
 */
import {
  isAuthCapture,
  isAuthInput,
  webChatError,
  type AuthCapture,
  type AuthInput,
  type AuthSessionState,
  type ProviderAuthController,
} from "../core";
import {
  createWebChatAuthSessionManager,
  type WebChatAuthSession,
  type WebChatAuthSessionCloseReason,
  type WebChatAuthSessionManager,
  type WebChatAuthSessionManagerOptions,
} from "./auth-sessions";

/** One provider offering interactive sign-in, as the host composed it. */
export interface WebChatAuthProviderRegistration {
  /** The catalogue provider id; the host already selected it, and it is never invented here. */
  readonly providerId: string;
  /** Human-readable name for the operator page. */
  readonly label: string;
  /** The provider's own auth capability. */
  readonly controller: ProviderAuthController;
}

/** Construction options for {@link createWebChatAuthSurface}. */
export interface WebChatAuthSurfaceOptions {
  /** The providers this deployment offers; omit (or empty) for a surface that lists none. */
  readonly providers?: readonly WebChatAuthProviderRegistration[];
  /** TTL, clock, sweep and terminal-grace seams, forwarded to the session manager; tests inject them. */
  readonly session?: WebChatAuthSessionManagerOptions;
  /** Frame cadence of the relay in milliseconds. Default 400 (2-3 fps). */
  readonly frameIntervalMs?: number;
}

/** What the page needs to know about a provider's frame geometry. */
export interface WebChatAuthViewport {
  readonly width: number;
  readonly height: number;
}

/** The reported outcome of the provider's own `storeCapture`. */
export interface WebChatAuthCaptureReport {
  readonly stored: boolean;
  readonly location?: string;
  /** Non-secret provider diagnostic for a stored capture whose side effect did not fully complete. */
  readonly detail?: string;
}

/** One provider as the operator page may list it. */
export interface WebChatAuthProviderListing {
  readonly providerId: string;
  readonly label: string;
}

/**
 * What an observer may read about one sign-in session.
 *
 * Deliberately carries no cookie, no storage state, no frame bytes and no page URL: the frame is the
 * stream's business, and the captured material is the provider's.
 */
export interface WebChatAuthSessionView {
  readonly id: string;
  readonly providerId: string;
  readonly state: AuthSessionState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly closeReason?: WebChatAuthSessionCloseReason;
  /** Non-secret provider diagnostic (a cancellation failure, for instance). */
  readonly detail?: string;
  /** The provider's frame geometry, once a frame has been relayed. */
  readonly viewport?: WebChatAuthViewport;
  /** A provider failure while reading or storing the capture. Never captured material itself. */
  readonly error?: string;
  /** The provider's own answer about where the capture landed, once it stored it. */
  readonly capture?: WebChatAuthCaptureReport;
}

/** One relay event of {@link WebChatAuthSurface.stream}. */
export interface WebChatAuthStreamEvent {
  /** Monotonic per stream. */
  readonly seq: number;
  readonly state: AuthSessionState;
  /** The provider's opaque frame bytes, when it relays one. Never decoded here. */
  readonly png?: Uint8Array;
  readonly viewport?: WebChatAuthViewport;
  readonly capture?: WebChatAuthCaptureReport;
  readonly closeReason?: WebChatAuthSessionCloseReason;
  readonly error?: string;
  /** `true` when the session reached a terminal state: this is the last event of the stream. */
  readonly terminal: boolean;
}

/** The surface. In-process, provider-selected, and deliberately not a scheduler or a store. */
export interface WebChatAuthSurface {
  /** The providers that expose an auth controller, in registration order. */
  providers(): readonly WebChatAuthProviderListing[];
  /**
   * Open one sign-in session for an already-selected provider.
   *
   * @throws {WebChatError} `MODEL_UNAVAILABLE` when no provider with that id is registered.
   * @throws {WebChatError} `TRANSPORT_UNAVAILABLE` when another session for that provider is active.
   */
  open(providerId: string): Promise<WebChatAuthSessionView>;
  /** One session by id, refreshing TTL and the capture handoff. `undefined` when unknown *or* collected. */
  view(id: string): Promise<WebChatAuthSessionView | undefined>;
  /** Relay one input, invalidate the frame cache and wake the relay. Throws on a state refusal. */
  input(id: string, event: AuthInput): Promise<WebChatAuthSessionView | undefined>;
  /** Cancel the sign-in. Idempotent; `undefined` when the session is unknown. */
  cancel(id: string): Promise<WebChatAuthSessionView | undefined>;
  /**
   * The frame/state relay of one session.
   *
   * Yields the current state (and frame, when the provider relays one) immediately, then again after
   * every input and on the frame cadence, and ends after one terminal event.
   */
  stream(id: string, signal?: AbortSignal): AsyncGenerator<WebChatAuthStreamEvent>;
  /** Release the manager and its sessions. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_FRAME_INTERVAL_MS = 400;

/** A one-shot wake signal: `signal()` releases every waiter, and a wake with no waiter is latched. */
interface SessionWake {
  signal(): void;
  /** Resolves on a wake or after `timeoutMs`, whichever first; `signal` aborts it. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>;
}

function createSessionWake(): SessionWake {
  const waiters = new Set<() => void>();
  let pending = false;
  return {
    signal(): void {
      const waiting = [...waiters];
      waiters.clear();
      if (waiting.length === 0) {
        // Nobody is listening yet: remember it, so the next `wait` does not sleep through an input
        // that arrived between two relay iterations.
        pending = true;
        return;
      }
      for (const resolve of waiting) resolve();
    },
    wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.resolve();
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(finish);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        // Never a reason for the process to stay alive: the stream's socket already is one.
        timer.unref?.();
        waiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    },
  };
}

interface SurfaceEntry {
  readonly handle: WebChatAuthSession;
  readonly controller: ProviderAuthController;
  readonly wake: SessionWake;
  viewport?: WebChatAuthViewport;
  capture?: WebChatAuthCaptureReport;
  storeError?: string;
  /** The in-flight (or finished) one-shot store handoff, shared by every concurrent observer. */
  storeRun?: Promise<void>;
  /**
   * How many inputs this session relayed.
   *
   * The relay compares it against the epoch it last observed and calls `invalidate()` when it moved:
   * an input that lands while a `view()` is already in flight is re-cached by the manager *after* the
   * input invalidated the cache, and without this the relay would serve that pre-input frame forever.
   */
  inputEpoch: number;
}

/**
 * Create the host's sign-in surface.
 *
 * @param options - provider registrations, manager seams and frame cadence. Tests inject the seams.
 * @returns the surface.
 */
export function createWebChatAuthSurface(options: WebChatAuthSurfaceOptions = {}): WebChatAuthSurface {
  const frameIntervalMs = options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
  if (!Number.isSafeInteger(frameIntervalMs) || frameIntervalMs < 1) {
    throw new TypeError("A WebChat auth surface requires a positive frame interval");
  }
  const manager: WebChatAuthSessionManager = createWebChatAuthSessionManager(options.session);
  const registrations = new Map<string, WebChatAuthProviderRegistration>();
  for (const registration of options.providers ?? []) {
    if (!registration || typeof registration.providerId !== "string" || registration.providerId.length === 0) {
      throw new TypeError("A WebChat auth provider registration requires a provider identity");
    }
    if (registrations.has(registration.providerId)) {
      throw new TypeError(`Provider ${registration.providerId} is registered twice for interactive sign-in`);
    }
    registrations.set(registration.providerId, registration);
  }
  const entries = new Map<string, SurfaceEntry>();

  const listing = (): readonly WebChatAuthProviderListing[] =>
    [...registrations.values()].map(registration => ({
      providerId: registration.providerId,
      label: registration.label,
    }));

  /** Sweep expired sessions, and forget the ones the manager has collected. */
  const sweepExpired = async (): Promise<void> => {
    await manager.sweep();
    // The manager is the authority on which sessions still exist. This map is a second reference (the
    // handle's closure is a third), so a session the manager collected must be forgotten here too —
    // otherwise the surface would keep serving an id the manager no longer knows. A collected id then
    // answers exactly like an unknown one.
    for (const id of [...entries.keys()]) {
      if (manager.get(id) === undefined) entries.delete(id);
    }
  };

  /**
   * The one-shot capture handoff.
   *
   * Set synchronously before the first await, so two concurrent observers (a stream tick and a status
   * poll) share one `storeCapture` call rather than racing two. A capture or store failure is
   * recorded as the session's non-secret `error` — never thrown, so a provider defect cannot turn a
   * readable session into an unreadable one.
   *
   * When the run settles, the handoff is released: the material was read through `capturedSession`
   * and stored (or its failure recorded), so the manager may collect the session once its grace
   * period passes. Releasing any earlier would risk the sweep collecting captured material the caller
   * had not read yet.
   */
  const storeOnce = (entry: SurfaceEntry): Promise<void> => {
    if (entry.storeRun) return entry.storeRun;
    // Latched only for a captured session: an early read must never consume the one handoff.
    try {
      if (entry.handle.state() !== "captured") return Promise.resolve();
    } catch (error) {
      entry.storeError = error instanceof Error ? error.message : String(error);
      return Promise.resolve();
    }
    entry.storeRun = (async () => {
      try {
        const material: AuthCapture = await entry.handle.capturedSession().capture();
        if (!isAuthCapture(material)) {
          entry.storeError = `Provider ${entry.handle.providerId} returned a malformed auth capture`;
          return;
        }
        const result = await entry.controller.storeCapture(material);
        if (!result || typeof result.stored !== "boolean") {
          entry.storeError = `Provider ${entry.handle.providerId} returned a malformed capture store result`;
          return;
        }
        entry.capture = {
          stored: result.stored,
          ...(typeof result.location === "string" && result.location.length > 0
            ? { location: result.location }
            : {}),
          // A provider's non-secret explanation for a stored capture whose provider-side side effect
          // did not fully complete, relayed verbatim like a session's own `detail`.
          ...(typeof result.detail === "string" && result.detail.length > 0
            ? { detail: result.detail }
            : {}),
        };
      } catch (error) {
        entry.storeError = error instanceof Error ? error.message : String(error);
      } finally {
        entry.handle.releaseCapture();
      }
    })();
    return entry.storeRun;
  };

  /** Read one session into the HTTP-facing view, refreshing TTL and the capture handoff first. */
  const sessionView = async (entry: SurfaceEntry): Promise<WebChatAuthSessionView> => {
    await sweepExpired();
    const snapshot = entry.handle.snapshot();
    if (snapshot.state === "captured") await storeOnce(entry);
    const error = entry.storeError
      ?? (snapshot.state === "failed" ? snapshot.detail : undefined);
    return {
      id: snapshot.id,
      providerId: snapshot.providerId,
      state: snapshot.state,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      ...(snapshot.closeReason !== undefined ? { closeReason: snapshot.closeReason } : {}),
      ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
      ...(entry.viewport !== undefined ? { viewport: entry.viewport } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(entry.capture !== undefined ? { capture: entry.capture } : {}),
    };
  };

  return {
    providers() {
      return listing();
    },

    async open(providerId) {
      if (typeof providerId !== "string" || providerId.length === 0) {
        throw new TypeError("A WebChat auth session requires a provider identity");
      }
      const registration = registrations.get(providerId);
      if (!registration) {
        throw webChatError(
          "MODEL_UNAVAILABLE",
          `No interactive sign-in provider is registered as "${providerId}". `
          + `Available: ${listing().map(entry => entry.providerId).join(", ") || "none"}.`,
          { providerId },
        );
      }
      const handle = await manager.open({ providerId, controller: registration.controller });
      const entry: SurfaceEntry = {
        handle,
        controller: registration.controller,
        wake: createSessionWake(),
        inputEpoch: 0,
      };
      entries.set(handle.id, entry);
      return sessionView(entry);
    },

    async view(id) {
      // Sweep *before* the lookup: a session the manager has collected must answer like an unknown
      // id, and an entry still in this map is not proof the manager still knows it.
      await sweepExpired();
      const entry = entries.get(id);
      if (!entry) return undefined;
      return sessionView(entry);
    },

    async input(id, event) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (!isAuthInput(event)) {
        throw new TypeError("A WebChat auth input must be one of click, drag, type, key, scroll or navigate");
      }
      await entry.handle.input(event);
      entry.inputEpoch += 1;
      // The manager already invalidated its cached frame; waking the relay paints the frame that
      // input produced instead of waiting for the next tick.
      entry.wake.signal();
      return sessionView(entry);
    },

    async cancel(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      await entry.handle.cancel();
      entry.wake.signal();
      return sessionView(entry);
    },

    async *stream(id, signal) {
      const entry = entries.get(id);
      if (!entry) return;
      let seq = 0;
      let observedEpoch = entry.inputEpoch;
      try {
        for (;;) {
          if (signal?.aborted) return;
          // A frame cached by a `view()` that was already in flight when an input landed is stale:
          // drop it, so what follows the input is what the provider produced after it. Only while the
          // session can still change — an input that *terminalized* the session deliberately keeps the
          // last relayed frame (the manager's own rule), and dropping it would lose the final frame of
          // a completed sign-in.
          if (observedEpoch !== entry.inputEpoch) {
            observedEpoch = entry.inputEpoch;
            const current = entry.handle.state();
            if (current === "starting" || current === "awaiting_input" || current === "verifying") {
              entry.handle.invalidate();
            }
          }
          await sweepExpired();
          const state = entry.handle.state();
          let png: Uint8Array | undefined;
          let viewport: WebChatAuthViewport | undefined;
          try {
            const frame = await entry.handle.view();
            png = frame.png;
            viewport = { width: frame.width, height: frame.height };
            entry.viewport = viewport;
          } catch {
            // A provider with no display refuses `view()` by category, and a captured session that
            // relayed nothing refuses it too. Neither is a session failure: the state still streams.
          }
          const terminal = state === "captured" || state === "failed" || state === "expired";
          if (state === "captured") await storeOnce(entry);
          const snapshot = terminal ? entry.handle.snapshot() : undefined;
          const error = entry.storeError ?? (state === "failed" ? snapshot?.detail : undefined);
          yield {
            seq: seq++,
            state,
            ...(png !== undefined ? { png } : {}),
            ...(viewport !== undefined ? { viewport } : {}),
            ...(entry.capture !== undefined ? { capture: entry.capture } : {}),
            ...(snapshot?.closeReason !== undefined ? { closeReason: snapshot.closeReason } : {}),
            ...(error !== undefined ? { error } : {}),
            terminal,
          };
          if (terminal) return;
          await entry.wake.wait(frameIntervalMs, signal);
        }
      } catch {
        // The socket died or the provider could not be read at all: the stream ends here. Nothing of
        // this stream outlives it (the wait timer is cleared by `wait` itself), and the session stays
        // readable for the client that still has to acknowledge the capture.
        return;
      }
    },

    async close() {
      await manager.close();
      entries.clear();
    },
  };
}
