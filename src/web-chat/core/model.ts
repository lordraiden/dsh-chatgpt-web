/**
 * Provider-neutral model metadata (architecture §14).
 *
 * The common layer describes *what a model is* without describing where it lives: the host selects
 * the route, the driver maps it to the web product, and this descriptor is what the shared layer may
 * reason about. Provider product slugs, endpoints and capability discovery stay in the driver.
 *
 * This module has no provider knowledge and no runtime dependency.
 */

/** Provider-neutral reasoning selection. */
export type WebChatReasoningMode = string;

/**
 * One selectable provider model.
 *
 * `text: true` records the common contract: this layer is text-only (architecture §1.2). A driver
 * that later exposes richer modalities does so outside the common contract.
 */
export interface WebChatModelDescriptor {
  /** Stable model identity inside the provider. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** The common layer is text-only. */
  readonly text: true;
  /** Reasoning selections this model accepts, when it has any. */
  readonly reasoningModes?: readonly WebChatReasoningMode[];
  /** Advertised context capacity, when the provider publishes one. */
  readonly contextWindow?: number;
  /** Provider-private metadata, opaque to the common layer. */
  readonly providerDetail?: unknown;
}

/** Whether a value is a usable model descriptor. */
export function isWebChatModelDescriptor(value: unknown): value is WebChatModelDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; label?: unknown; text?: unknown };
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.label === "string"
    && candidate.text === true;
}
