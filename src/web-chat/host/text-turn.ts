/**
 * Provider-neutral text-turn port (issue #224, staged).
 *
 * This is the host-boundary seam the provider-neutral Advisor submits a review through. It carries
 * **one portable ordinary user text** to the provider the selected public route resolved to; nothing
 * here knows a browser, a selector, a provider endpoint or a provider response shape.
 *
 * ## Why this port exists next to the WebChat exchange
 *
 * The architecture expects a text turn to run through the shared WebChat exchange
 * (`createWebChatExchange` + a provider `WebChatTextTransport`, architecture §8.3/§9). The ChatGPT
 * provider does not implement that transport yet: its turn still runs through the provider's own
 * browser execution path, while the core is used for continuity. The Advisor therefore needs the
 * smallest honest seam in the meantime, and this is it:
 *
 * - it is provider-neutral, so the Advisor never imports a provider adapter;
 * - it is composed **once** per provider together with that provider's driver, so it is not a second
 *   provider registry and cannot advertise a route the composition cannot serve;
 * - it carries an explicit retirement trigger: when a provider gains its `WebChatTextTransport`, its
 *   runtime delegates `runTextTurn` to the exchange runner and this request shape is translated to
 *   `WebChatTurnInput`. No Advisor caller changes.
 *
 * The route is *already selected* by its caller (DSH's public catalogue identity); this module only
 * maps that route to the provider composition that already serves it — it is never a routing policy
 * (architecture §8.4, §17).
 */
import type { WebChatConversationAffinity, WebChatModelDescriptor, WebChatProviderDriver } from "../core";

/** One public WebChat route identity: `providerId` + `/` + provider-local model id. */
export function webChatPublicRoute(providerId: string, modelId: string): string {
  if (!providerId.trim() || !modelId.trim()) {
    throw new TypeError("A public WebChat route requires a provider id and a provider-local model id");
  }
  return `${providerId}/${modelId}`;
}

/**
 * The provider id of a public route, or `undefined` when the value is not a public route identity.
 *
 * The identity is provider-qualified by construction because a provider-local model id is not
 * globally unique (architecture §14).
 */
export function webChatRouteProviderId(route: string): string | undefined {
  if (typeof route !== "string") return undefined;
  const separator = route.indexOf("/");
  if (separator <= 0 || separator === route.length - 1) return undefined;
  const providerId = route.slice(0, separator).trim();
  const modelId = route.slice(separator + 1).trim();
  return providerId && modelId ? providerId : undefined;
}

/** The provider-local model id of a public route, or `undefined` when it is not one. */
export function webChatRouteModelId(route: string): string | undefined {
  if (typeof route !== "string") return undefined;
  const separator = route.indexOf("/");
  if (separator <= 0 || separator === route.length - 1) return undefined;
  const modelId = route.slice(separator + 1).trim();
  return modelId.length > 0 ? modelId : undefined;
}

/**
 * One semantic text turn the Advisor submits.
 *
 * There is deliberately no system/developer instruction channel: the review is portable ordinary
 * text (issue #224), so a provider that only offers a visible composer can always carry it.
 */
export interface WebChatTextTurnRequest {
  /** Public route identity already selected by the caller. */
  readonly route: string;
  /** Provider-local model identity the provider resolves for that route. */
  readonly model: string;
  /** Provider-advertised reasoning variant, when one is explicitly selected. */
  readonly reasoningMode?: string;
  /** The one ordinary user text to submit. */
  readonly userText: string;
  /** Host session the turn logically belongs to. */
  readonly dshSession: { readonly sessionId: string };
  /** Core affinity of the conversation this turn continues. */
  readonly affinity: WebChatConversationAffinity;
  /** Host-issued turn identity (unique per logical turn). */
  readonly turnId: string;
  /** Cancellation of this turn, when the caller tracks one. */
  readonly signal?: AbortSignal;
}

/** The typed outcome of one text turn. */
export interface WebChatTextTurnOutcome {
  readonly ok: boolean;
  /** The answer text, on success. */
  readonly text?: string;
  /** When the text was read instead of produced (recovery), epoch milliseconds. */
  readonly capturedAt?: number;
  /** Stable failure code, on failure. */
  readonly code?: string;
  /** Human-readable failure message, on failure. */
  readonly message?: string;
}

/**
 * One read-only recovery of a retained provider conversation (issue #214).
 *
 * A recovery carries the same conversation identity as a turn but no text: it never submits, so it
 * is always safe to retry.
 */
export interface WebChatTextRecoveryRequest {
  /** Public route whose provider conversation is read. */
  readonly route: string;
  /** Provider-local model identity the provider resolves for that route. */
  readonly model: string;
  /** Host session the retained conversation logically belongs to. */
  readonly dshSession: { readonly sessionId: string };
  /** Core affinity of the conversation being read. */
  readonly affinity: WebChatConversationAffinity;
  /** Host-issued identity for this read. */
  readonly turnId: string;
  /** Bounded wait for the finalized answer; the provider default applies when absent. */
  readonly timeoutMs?: number;
  /** Cancellation of this read. */
  readonly signal?: AbortSignal;
}

/**
 * One provider composition: the provider's driver plus the text-turn seam that serves it.
 *
 * `providerLabel` is presentation metadata for a provider-qualified choice label; it carries no
 * routing authority (the driver id does).
 */
export interface WebChatProviderRuntime {
  readonly driver: WebChatProviderDriver;
  readonly providerLabel?: string;
  /** Run one ordinary user-text turn through this provider. */
  runTextTurn(request: WebChatTextTurnRequest): Promise<WebChatTextTurnOutcome>;
  /**
   * Read the finalized answer of a retained provider conversation, when this provider can.
   *
   * Providers that retain nothing simply omit it; a caller then reports recovery as unavailable
   * instead of pretending it read something.
   */
  recoverTextTurn?(request: WebChatTextRecoveryRequest): Promise<WebChatTextTurnOutcome>;
}

/** The runtime that serves a provider id, when this composition includes one. */
export function webChatRuntimeForProvider(
  runtimes: readonly WebChatProviderRuntime[],
  providerId: string,
): WebChatProviderRuntime | undefined {
  return runtimes.find(runtime => runtime.driver.id === providerId);
}

/**
 * Resolve an already-selected public route to its provider composition.
 *
 * No policy lives here: the provider id must be served by exactly the composed driver that owns it,
 * and an unknown route or a provider this composition does not implement simply does not resolve.
 */
export function resolveWebChatProviderRuntime(
  runtimes: readonly WebChatProviderRuntime[],
  route: string,
): WebChatProviderRuntime | undefined {
  const providerId = webChatRouteProviderId(route);
  if (providerId === undefined) return undefined;
  return webChatRuntimeForProvider(runtimes, providerId);
}

/**
 * Resolve the provider-local model descriptor of an already-selected public route.
 *
 * The provider driver remains the authority on what it can serve: this asks it for the route, and a
 * route the provider does not confirm does not resolve — the host never invents a catalogue entry.
 */
export async function resolveWebChatRouteModel(
  runtime: WebChatProviderRuntime,
  route: string,
  reasoningMode?: string,
): Promise<WebChatModelDescriptor | undefined> {
  if (webChatRouteProviderId(route) !== runtime.driver.id) return undefined;
  return runtime.driver.resolveModel(route, reasoningMode);
}
