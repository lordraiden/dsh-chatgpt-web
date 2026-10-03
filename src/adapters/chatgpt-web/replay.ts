import type { CanonicalChatGptWebContext } from "./context-projection";
import type { ProviderRecovery } from "./provider-core";

export interface ChatGptReplayIdentity {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly capabilitySnapshotId: string;
  readonly capabilityBindingId: string;
}

export interface ChatGptReplayBoundary {
  /**
   * Tool executions whose authoritative result is already settled.
   * Replaying their result is data reconstruction only; they must never execute again.
   */
  readonly settledToolCallIds: readonly string[];
  /**
   * Tool executions that were not settled at the exhaustion boundary.
   * Replay reconstructs their pending model-visible state; execution remains owned by DSH.
   */
  readonly pendingToolCallIds: readonly string[];
}

export interface ChatGptConversationHandle {
  readonly id: string;
  readonly generation: number;
}

export type ChatGptReplayPhase =
  | "NEW"
  | "CONTEXT_EXHAUSTED"
  | "REPLACING_CONVERSATION"
  | "REPLACEMENT_READY"
  | "REPLAYING_CANONICAL_CONTEXT"
  | "RESUMING"
  | "COMPLETED"
  | "FAILED";

export interface ChatGptReplaySnapshot {
  readonly recovery: ProviderRecovery;
  readonly phase: ChatGptReplayPhase;
  readonly generation: number;
  readonly oldConversation?: ChatGptConversationHandle;
  readonly activeConversation?: ChatGptConversationHandle;
  readonly staleConversationIds: readonly string[];
}

export interface ChatGptReplayBinding {
  readonly conversation: ChatGptConversationHandle;
  readonly identity: ChatGptReplayIdentity;
}

export interface ChatGptReplayTransport {
  invalidateConversation(
    conversation: ChatGptConversationHandle,
    identity: ChatGptReplayIdentity,
  ): Promise<void>;

  createReplacementConversation(
    identity: ChatGptReplayIdentity,
  ): Promise<ChatGptConversationHandle>;

  waitForReplacementReady(
    conversation: ChatGptConversationHandle,
    identity: ChatGptReplayIdentity,
  ): Promise<void>;

  bindReplacementConversation(
    previous: ChatGptConversationHandle,
    replacement: ChatGptConversationHandle,
    identity: ChatGptReplayIdentity,
  ): Promise<ChatGptReplayBinding>;

  replayCanonicalContext(
    conversation: ChatGptConversationHandle,
    context: CanonicalChatGptWebContext,
    boundary: ChatGptReplayBoundary,
    identity: ChatGptReplayIdentity,
  ): Promise<void>;

  resume(
    conversation: ChatGptConversationHandle,
    identity: ChatGptReplayIdentity,
  ): Promise<void>;
}

export class ChatGptReplayError extends Error {
  readonly phase: ChatGptReplayPhase;
  readonly code = "chatgpt_replay_failed" as const;

  constructor(phase: ChatGptReplayPhase, options?: { cause?: unknown }) {
    super(
      "ChatGPT Web conversation replay could not establish safe continuity",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ChatGptReplayError";
    this.phase = phase;
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error("ChatGPT replay requires a non-empty " + name);
}

function validateIdentity(identity: ChatGptReplayIdentity): void {
  requireNonEmpty(identity.sessionId, "session id");
  requireNonEmpty(identity.agentId, "agent id");
  requireNonEmpty(identity.turnId, "turn id");
  requireNonEmpty(identity.capabilitySnapshotId, "capability snapshot id");
  requireNonEmpty(identity.capabilityBindingId, "capability binding id");
}

function validateHandle(handle: ChatGptConversationHandle, name: string): void {
  requireNonEmpty(handle.id, name + " conversation id");
  if (!Number.isSafeInteger(handle.generation) || handle.generation < 0) {
    throw new Error("ChatGPT replay requires a valid " + name + " conversation generation");
  }
}

function sameReplayIdentity(left: ChatGptReplayIdentity, right: ChatGptReplayIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.agentId === right.agentId
    && left.turnId === right.turnId
    && left.capabilitySnapshotId === right.capabilitySnapshotId
    && left.capabilityBindingId === right.capabilityBindingId;
}

function validateBoundary(boundary: ChatGptReplayBoundary): void {
  const settled = new Set<string>();
  for (const id of boundary.settledToolCallIds) {
    requireNonEmpty(id, "settled tool call id");
    if (settled.has(id)) {
      throw new Error("ChatGPT replay boundary contains duplicate settled tool call id");
    }
    settled.add(id);
  }

  const pending = new Set<string>();
  for (const id of boundary.pendingToolCallIds) {
    requireNonEmpty(id, "pending tool call id");
    if (pending.has(id)) {
      throw new Error("ChatGPT replay boundary contains duplicate pending tool call id");
    }
    if (settled.has(id)) {
      throw new Error("ChatGPT replay boundary classifies a tool call as both settled and pending");
    }
    pending.add(id);
  }
}

export interface ChatGptReplayRequest {
  readonly exhaustedConversation: ChatGptConversationHandle;
  readonly identity: ChatGptReplayIdentity;
  readonly context: CanonicalChatGptWebContext;
  readonly boundary: ChatGptReplayBoundary;
}

/**
 * Small deterministic state machine for replacing an exhausted ChatGPT conversation.
 *
 * It deliberately knows nothing about DOM selectors, Playwright, browser pages, or ChatGPT UI
 * mechanics. Those concerns are supplied later through ChatGptReplayTransport.
 */
export class ChatGptReplayCoordinator {
  private phase: ChatGptReplayPhase = "NEW";
  private generation = 0;
  private activeConversation?: ChatGptConversationHandle;
  private oldConversation?: ChatGptConversationHandle;
  private readonly staleConversationIds = new Set<string>();

  snapshot(): ChatGptReplaySnapshot {
    const recovery: ProviderRecovery = this.phase === "FAILED"
      ? "FAILED"
      : this.phase === "NEW"
        ? "NEW"
        : "REPLAY";

    return {
      recovery,
      phase: this.phase,
      generation: this.generation,
      ...(this.oldConversation ? { oldConversation: this.oldConversation } : {}),
      ...(this.activeConversation ? { activeConversation: this.activeConversation } : {}),
      staleConversationIds: [...this.staleConversationIds],
    };
  }

  /**
   * This operation is entered only after a trusted exhaustion signal. There is no path here that
   * silently turns EXACT_RESUME into REPLAY.
   */
  async replay(
    request: ChatGptReplayRequest,
    transport: ChatGptReplayTransport,
  ): Promise<ChatGptReplaySnapshot> {
    if (this.phase !== "NEW") {
      throw new ChatGptReplayError(this.phase);
    }

    try {
      validateIdentity(request.identity);
      validateHandle(request.exhaustedConversation, "exhausted");
      validateBoundary(request.boundary);

      this.phase = "CONTEXT_EXHAUSTED";
      this.oldConversation = { ...request.exhaustedConversation };
      this.generation = request.exhaustedConversation.generation;

      this.phase = "REPLACING_CONVERSATION";
      const replacement = await transport.createReplacementConversation(request.identity);
      validateHandle(replacement, "replacement");
      if (
        replacement.id === request.exhaustedConversation.id
        || replacement.generation <= request.exhaustedConversation.generation
      ) {
        throw new Error("ChatGPT replay replacement did not produce a fresh conversation identity");
      }

      await transport.waitForReplacementReady(replacement, request.identity);
      this.phase = "REPLACEMENT_READY";

      await transport.invalidateConversation(request.exhaustedConversation, request.identity);
      this.staleConversationIds.add(request.exhaustedConversation.id);

      const binding = await transport.bindReplacementConversation(
        request.exhaustedConversation,
        replacement,
        request.identity,
      );
      if (!sameReplayIdentity(binding.identity, request.identity)) {
        throw new Error("ChatGPT replay replacement changed the trusted DSH identity");
      }
      if (
        binding.conversation.id !== replacement.id
        || binding.conversation.generation !== replacement.generation
      ) {
        throw new Error("ChatGPT replay replacement binding does not match the replacement conversation");
      }
      this.activeConversation = { ...binding.conversation };

      this.phase = "REPLAYING_CANONICAL_CONTEXT";
      await transport.replayCanonicalContext(
        replacement,
        request.context,
        request.boundary,
        request.identity,
      );

      this.phase = "RESUMING";
      await transport.resume(replacement, request.identity);

      this.phase = "COMPLETED";
      return this.snapshot();
    } catch (error) {
      this.phase = "FAILED";
      throw error instanceof ChatGptReplayError
        ? error
        : new ChatGptReplayError(this.phase, { cause: error });
    }
  }

  /** Old browser callbacks can never attach to the replacement conversation. */
  acceptsConversationEvent(conversation: ChatGptConversationHandle): boolean {
    if (
      this.phase !== "REPLACEMENT_READY"
      && this.phase !== "REPLAYING_CANONICAL_CONTEXT"
      && this.phase !== "RESUMING"
      && this.phase !== "COMPLETED"
    ) {
      return false;
    }

    return this.activeConversation?.id === conversation.id
      && this.activeConversation.generation === conversation.generation
      && !this.staleConversationIds.has(conversation.id);
  }

  recoveryOutcome(): ProviderRecovery {
    return this.phase === "FAILED" ? "FAILED" : this.phase === "NEW" ? "NEW" : "REPLAY";
  }
}
