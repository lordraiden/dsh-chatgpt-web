/**
 * Provider-neutral interactive-authentication contract (issue #276).
 *
 * A provider that needs a human to sign in exposes this as an **optional capability**. The host
 * relays pixels and input between the operator's page and the provider; it never navigates, never
 * reads a DOM, never speaks CDP and never decides when sign-in is done. The provider decides all of
 * that, and reports only its state and a frame.
 *
 * Rules of the contract — these are the point, not decoration:
 *
 * 1. **No browser in the contract.** Nothing here is `Page`, Playwright, CDP, DOM or a URL-shaped
 *    assumption. The host is a pixel/input relay. `AuthInput` may carry a `navigate` *intent* (a
 *    string the provider interprets), but the contract never implies that a URL exists to read back,
 *    that navigation is the mechanism, or that the provider has a page at all.
 * 2. **Pixels are optional and opaque.** `view()` may return a static instruction image (device
 *    code, OTP, "paste an API key") for a provider with no browser at all. The host must not require
 *    a frame to reach `captured`: a provider whose sign-in completes without a single `view()` is a
 *    first-class provider. The host never decodes, resizes or interprets the bytes.
 * 3. **Credential-free.** `state()` and the view never expose cookies, storage state, tokens or any
 *    other authentication material. The captured material is the provider's business; the common
 *    layer only knows that sign-in *reached* `captured`.
 * 4. **Transport-agnostic.** SSE today, anything tomorrow: this contract describes a sign-in, not a
 *    wire format. No `WebSocket`, `EventSource`, HTTP status or frame rate appears here.
 *
 * This module has no provider knowledge and no runtime dependency.
 */

/**
 * The explicit lifecycle state of one sign-in session.
 *
 * `starting` is the provider bringing its mechanism up; `awaiting_input` and `verifying` are the
 * two interactive states (the second means the provider is checking what the operator submitted);
 * `captured`, `failed` and `expired` are terminal for the session.
 */
export type AuthSessionState =
  | "starting"
  | "awaiting_input"
  | "verifying"
  | "captured"
  | "failed"
  | "expired";

/**
 * One input event the operator produced.
 *
 * These are *intents*, not browser commands: `click` names viewport coordinates in the provider's
 * own frame geometry, and `navigate` is a request the provider may honour, refuse or translate. The
 * host never inspects or rewrites them beyond relaying the recognized shape.
 */
export type AuthInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "navigate"; url: string };

/**
 * One relayed frame.
 *
 * `png` is opaque bytes: the host relays them byte-for-byte and never decodes them. `width` and
 * `height` exist so the page can map a click into the frame's coordinate space without the host
 * knowing how the frame was produced.
 */
export interface ProviderAuthView {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * One provider-owned sign-in session.
 *
 * The provider owns navigation, input interpretation and completion detection. The manager owns
 * lifecycle, TTL and frame caching; see `src/web-chat/host/auth-sessions.ts`.
 */
export interface ProviderAuthSession {
  /** Stable provider identity; a session may only ever be served under this provider. */
  readonly providerId: string;
  /**
   * The provider's current state.
   *
   * Synchronous and side-effect free: the host may read it on every frame tick with no provider work.
   */
  state(): AuthSessionState;
  /**
   * The current frame.
   *
   * A provider without a browser returns a static instruction image here; a provider whose sign-in
   * needs no pixels may reject this call, which is why nothing in the manager requires a frame.
   */
  view(): Promise<ProviderAuthView>;
  /** Relay one operator input. The provider decides what it means. */
  input(event: AuthInput): Promise<void>;
  /** Abandon the sign-in and release whatever the provider owns. Idempotent. */
  cancel(): Promise<void>;
}

/**
 * The optional provider capability: start a sign-in.
 *
 * A driver that implements this can be signed in from the operator's page; a driver that does not is
 * simply not offered for interactive sign-in. Implementing it grants no routing authority.
 */
export interface ProviderAuthController {
  /** Begin a sign-in. The returned session is owned by the caller through its lifecycle. */
  startAuth(): Promise<ProviderAuthSession>;
}

/**
 * The vocabulary, derived from a map so a state cannot be added to the list and forgotten in the
 * type (or the other way around), exactly like the error categories.
 */
const AUTH_SESSION_STATE_MAP = {
  starting: true,
  awaiting_input: true,
  verifying: true,
  captured: true,
  failed: true,
  expired: true,
} as const;

/** Every state, in lifecycle order, for exhaustive checks and diagnostics. */
export const AUTH_SESSION_STATES = Object.keys(AUTH_SESSION_STATE_MAP) as readonly AuthSessionState[];

/** Whether a value is one of the six session states. */
export function isAuthSessionState(value: unknown): value is AuthSessionState {
  return typeof value === "string" && Object.hasOwn(AUTH_SESSION_STATE_MAP, value);
}

/**
 * Whether a value is one of the five relayable input events.
 *
 * Structural and strict about the recognized shape: an unknown `type`, a missing field, a
 * non-finite coordinate or an empty string is refused, so a malformed page event fails at the relay
 * instead of reaching a provider as half an instruction.
 */
export function isAuthInput(value: unknown): value is AuthInput {
  if (!value || typeof value !== "object") return false;
  const event = value as { type?: unknown; [key: string]: unknown };
  switch (event.type) {
    case "click":
      return Number.isFinite(event.x) && Number.isFinite(event.y);
    case "type":
      return typeof event.text === "string" && event.text.length > 0;
    case "key":
      return typeof event.key === "string" && event.key.length > 0;
    case "scroll":
      return Number.isFinite(event.dy);
    case "navigate":
      return typeof event.url === "string" && event.url.length > 0;
    default:
      return false;
  }
}

/** Whether a value is a well-formed relayable frame. */
export function isProviderAuthView(value: unknown): value is ProviderAuthView {
  if (!value || typeof value !== "object") return false;
  const frame = value as { png?: unknown; width?: unknown; height?: unknown };
  return frame.png instanceof Uint8Array
    && frame.png.length > 0
    && Number.isSafeInteger(frame.width) && (frame.width as number) > 0
    && Number.isSafeInteger(frame.height) && (frame.height as number) > 0;
}
