/**
 * A pressed-pointer gesture over a browser mouse, owned by one provider sign-in session.
 *
 * The neutral contract sends a live gesture as several inputs (`pointer-down`, `pointer-move`,
 * `pointer-up`, `pointer-cancel`), so the *pressed button* is state that must survive between
 * requests. That state lives here, beside the only code that can actually lift the button, and this
 * module is the one owner of the invariant that matters: **the provider's mouse button is never left
 * down**. It is released by the close of a gesture, by a cancellation, by the deal-with-the-browser
 * teardown, and by a safety timeout when the page simply stops talking (a closed laptop, a lost
 * request, a tab killed mid-drag).
 *
 * Nothing here invents motion: a request is one `move`, a press is `move` + `down`, a release is
 * `move` + `up`, and a cancel is `up` where the pointer already is. The controller validates the
 * coordinates against the provider's viewport before calling in, exactly like a click.
 *
 * This is a browser-transport primitive, not part of the neutral contract: a provider that is not
 * backed by a page never sees it.
 */

import { webChatError } from "../web-chat/core";

/** How long a gesture may go silent before the safety release lifts the button. */
export const AUTH_POINTER_GESTURE_TIMEOUT_MS = 10_000;

/** The mouse operations a gesture needs, so tests need no browser and the helper needs no Playwright. */
export interface AuthPointerSink {
  move(x: number, y: number): Promise<unknown>;
  down(): Promise<unknown>;
  up(): Promise<unknown>;
}

/** Construction options for {@link createAuthPointerGesture}. */
export interface AuthPointerGestureOptions {
  /** The provider id carried on a typed refusal, for diagnosis only. */
  readonly providerId: string;
  /** Safety release after this long without a gesture event. Default 10 seconds. */
  readonly timeoutMs?: number;
}

/** One session-owned pressed-pointer gesture. */
export interface AuthPointerGesture {
  /** Whether the provider's mouse button is currently down. */
  pressed(): boolean;
  /** Move to the press position and press. An already-open gesture is released first. */
  down(x: number, y: number): Promise<void>;
  /** One real observed sample, applied on arrival. Refused with no open gesture. */
  move(x: number, y: number): Promise<void>;
  /** Move to the exact release and lift. Refused with no open gesture. */
  up(x: number, y: number): Promise<void>;
  /** Lift without a release position. Idempotent. */
  cancel(): Promise<void>;
  /** Best-effort lift for teardown and safety timeouts; never throws and never reports a release. */
  release(): Promise<void>;
  /** Release and stop the safety timer. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Create one gesture for one session.
 *
 * Every operation is serialised, so a `pointer-up` can never overtake a `pointer-move` that is still
 * in flight, whatever order two requests happen to reach the process in. A failed operation never
 * poisons the queue: the next one still runs (the controller reports the failure and releases).
 */
export function createAuthPointerGesture(
  sink: AuthPointerSink,
  options: AuthPointerGestureOptions,
): AuthPointerGesture {
  const providerId = options.providerId;
  const timeoutMs = options.timeoutMs ?? AUTH_POINTER_GESTURE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("An auth pointer gesture requires a positive safety timeout");
  }

  let pressed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    // The queue is always healthy: a failed operation is reported to its caller, not to the next one.
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const disarm = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const lift = async (): Promise<void> => {
    if (!pressed) return;
    // Cleared before the await: a failed `up` must not make a later release try to lift a button the
    // browser may already consider lifted (or may not — the failure is reported by the caller).
    pressed = false;
    disarm();
    await sink.up();
  };

  const release = (): Promise<void> => enqueue(async () => {
    try {
      await lift();
    } catch {
      // Teardown and the safety timer have nowhere to report a failure to; the session is already
      // settling or the browser is already gone.
    }
  });

  const arm = (): void => {
    disarm();
    timer = setTimeout(() => {
      timer = undefined;
      // The page stopped talking. The physical button is the thing that must not stay down; a later
      // event finds the gesture closed and receives the typed refusal instead of moving a held mouse.
      void release();
    }, timeoutMs);
    timer.unref?.();
  };

  const notOpen = (action: string): never => {
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      `The sign-in pointer gesture is not open and cannot ${action}`,
      { providerId, providerCode: "AUTH_POINTER_GESTURE_NOT_OPEN" },
    );
  };

  return {
    pressed: () => pressed,

    down(x, y) {
      return enqueue(async () => {
        // A second press is a new gesture, not a wedged one: close the old press instead of stacking
        // buttons. The release is physical only; no synthetic release input is invented.
        if (pressed) await lift();
        await sink.move(x, y);
        await sink.down();
        pressed = true;
        arm();
      });
    },

    move(x, y) {
      return enqueue(async () => {
        if (!pressed) notOpen("relay a move");
        await sink.move(x, y);
        arm();
      });
    },

    up(x, y) {
      return enqueue(async () => {
        if (!pressed) notOpen("relay a release");
        // The release is the exact coordinate the page mapped from `pointerup`, never the last
        // throttled move: that older position is exactly how a slider stops short.
        await sink.move(x, y);
        await lift();
      });
    },

    cancel() {
      return enqueue(async () => {
        await lift();
      });
    },

    release,

    async dispose() {
      disarm();
      await release();
    },
  };
}
