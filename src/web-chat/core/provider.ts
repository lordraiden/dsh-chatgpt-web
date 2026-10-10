/**
 * Provider driver contract (architecture §8.1, §8.2, §8.4, §17).
 *
 * A driver is what turns a host-selected route into provider behaviour. It may use a DOM, a
 * browser-network exchange, a hybrid, or another web-native mechanism — the common layer only ever
 * sees this interface, so nothing here may expose a browser object, a selector, an endpoint or a
 * provider response DTO.
 *
 * The contract is deliberately *resolution-only*: it maps an already-selected host route to a
 * driver. Provider selection, public model routing and retry policy stay with the host runtime
 * (architecture §8.4); implementing this interface never grants routing authority.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import { webChatError } from "./errors";
import type { WebChatAccountBinding, WebChatConversation, WebChatConversationAffinity, WebChatDshSessionIdentity } from "./conversation";
import type { WebChatReplayMessage } from "./exchange";
import type { WebChatModelDescriptor, WebChatReasoningMode } from "./model";

/** What the driver can establish about the authenticated account, without exposing credentials. */
export interface WebChatAccountInspection {
  /** Whether an authenticated session currently exists. */
  readonly authenticated: boolean;
  /** Stable account fingerprint, when the provider can establish one. */
  readonly accountFingerprint?: string;
  /** Product capability state the driver could establish, keyed by provider-defined name. */
  readonly capabilities?: Readonly<Record<string, "supported" | "unsupported" | "unknown">>;
}

/** Driver health, for diagnostics. */
export interface WebChatProviderHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

/** What the driver needs in order to judge an existing conversation. */
export interface WebChatConversationAssessmentInput {
  readonly dshSession: WebChatDshSessionIdentity;
  readonly binding: WebChatAccountBinding;
  readonly affinity: WebChatConversationAffinity;
  readonly model: string;
  readonly reasoningMode?: WebChatReasoningMode;
  readonly systemInstructions?: readonly string[];
  /** The conversation as last known, when one exists. */
  readonly conversation?: WebChatConversation;
}

/**
 * The driver's verdict for an existing conversation (architecture §10).
 *
 * The verdict is the driver's, because it may depend on provider model rules, reasoning selection,
 * instructions, remote conversation state or provider-native constraints.
 */
export interface WebChatConversationAssessment {
  readonly status: WebChatConversation["status"];
  /** Short provider-visible reason, for diagnostics. */
  readonly reason?: string;
  /**
   * The conversation the driver reconciled itself, when it can establish one the core has not
   * recorded (for example the remote conversation still exists after a store loss).
   *
   * Continuity is provider-driven: only the driver can establish remote state, so the core adopts
   * what it hands back instead of guessing. Without it, a `resumable` verdict for an unrecorded
   * affinity is refused rather than turned into a new conversation.
   */
  readonly conversation?: WebChatConversation;
}

/** Identity and selection shared by every conversation operation. */
export interface WebChatConversationSelection {
  readonly dshSession: WebChatDshSessionIdentity;
  readonly binding: WebChatAccountBinding;
  readonly affinity: WebChatConversationAffinity;
  readonly model: string;
  readonly reasoningMode?: WebChatReasoningMode;
  readonly systemInstructions?: readonly string[];
}

/** Open a new provider conversation for the affinity. */
export type WebChatConversationCreateInput = WebChatConversationSelection;

/** Continue an existing provider conversation. */
export interface WebChatConversationResumeInput extends WebChatConversationSelection {
  readonly conversation: WebChatConversation;
}

/**
 * Re-establish a conversation from canonical host history after an explicit replay decision.
 *
 * The predecessor is optional: a replay rebuilds from canonical host history, so it can also be the
 * first conversation of an affinity whose continuity is gone (architecture §10).
 */
export interface WebChatConversationReplayInput extends WebChatConversationSelection {
  readonly conversation?: WebChatConversation;
  /** Canonical text history for the replay; never a second persistent transcript. */
  readonly history: readonly WebChatReplayMessage[];
}

/**
 * One provider implementation of the text-only WebChat layer.
 *
 * Every method is expressed in common types only: a driver must not return a browser object, a
 * selector, an endpoint or a provider response DTO as part of its public provider contract
 * (architecture §8.1).
 */
export interface WebChatProviderDriver {
  /** Stable driver identity; this is the value the host route resolves to. */
  readonly id: string;

  /** Establish the authenticated account state, without touching web product internals. */
  inspectAccount(): Promise<WebChatAccountInspection>;
  /** List the models this driver can currently serve. */
  listModels(): Promise<readonly WebChatModelDescriptor[]>;
  /** Resolve one already-selected model, or report that it is unavailable. */
  resolveModel(model: string, reasoningMode?: WebChatReasoningMode): Promise<WebChatModelDescriptor | undefined>;
  /** Judge whether an existing conversation can serve the requested turn state. */
  assessConversation(input: WebChatConversationAssessmentInput): Promise<WebChatConversationAssessment>;
  /** Open a new conversation. */
  createConversation(input: WebChatConversationCreateInput): Promise<WebChatConversation>;
  /** Continue an existing conversation. */
  resumeConversation(input: WebChatConversationResumeInput): Promise<WebChatConversation>;
  /** Re-establish a conversation from canonical text history. */
  replayConversation(input: WebChatConversationReplayInput): Promise<WebChatConversation>;
  /** Report driver health. */
  health(): Promise<WebChatProviderHealth>;
  /** Release everything this driver owns. */
  shutdown(): Promise<void>;
}

/**
 * Host replay state tagged with the provider conversation it belongs to (architecture §8.4).
 *
 * Host replay state is optional transport metadata, never the durable WebChat conversation store.
 * It may only be consumed when it provably belongs to the requested provider conversation, so it
 * always carries the provider and binding it was produced for.
 */
export interface WebChatProviderReplayState {
  readonly providerId: string;
  readonly bindingId: string;
  /** Conversation key it was produced for, when the provider tags one. */
  readonly conversationKey?: string;
  /** Opaque provider payload. */
  readonly detail: unknown;
}

/** Whether a value is a provider-tagged replay state. */
export function isWebChatProviderReplayState(value: unknown): value is WebChatProviderReplayState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { providerId?: unknown; bindingId?: unknown; detail?: unknown };
  return typeof candidate.providerId === "string"
    && candidate.providerId.length > 0
    && typeof candidate.bindingId === "string"
    && candidate.bindingId.length > 0
    && candidate.detail !== undefined;
}

/** The conversation a caller claims a replay state belongs to. */
export interface WebChatReplayStateOwner {
  readonly providerId: string;
  readonly bindingId: string;
  readonly conversationKey?: string;
}

/**
 * Whether tagged replay state may be consumed for the requested conversation.
 *
 * Fails closed: unowned, malformed, cross-provider or cross-binding state is never owned, and a
 * caller that names a conversation key requires the state to name the same one.
 */
export function webChatReplayStateOwnedBy(
  state: unknown,
  expected: WebChatReplayStateOwner,
): state is WebChatProviderReplayState {
  if (!isWebChatProviderReplayState(state)) return false;
  if (state.providerId !== expected.providerId || state.bindingId !== expected.bindingId) return false;
  if (expected.conversationKey !== undefined && state.conversationKey !== expected.conversationKey) return false;
  return true;
}

/**
 * Assert replay-state ownership, or fail with the semantic mismatch category.
 *
 * @returns the owned replay state, so a caller consumes it only through this gate.
 * @throws {WebChatError} `CONVERSATION_STATE_MISMATCH` when the state is not provably owned.
 */
export function assertWebChatReplayStateOwner(
  state: unknown,
  expected: WebChatReplayStateOwner,
): WebChatProviderReplayState {
  if (!webChatReplayStateOwnedBy(state, expected)) {
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      `Replay state does not belong to provider ${expected.providerId} binding ${expected.bindingId}`,
    );
  }
  return state;
}
