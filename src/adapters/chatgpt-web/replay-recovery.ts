
import type { CanonicalChatGptWebContext } from "./context-projection";
import { serializeCanonicalChatGptWebContext } from "./context-projection";

export type ChatGptReplayContinuity = "EXACT_RESUME" | "REPLAY" | "FAILED";

export type ChatGptReplayPhase =
  | "BOUND"
  | "CONTEXT_EXHAUSTED"
  | "REPLACING_CONVERSATION"
  | "REPLACEMENT_READY"
  | "REPLAYING"
  | "RESUMED"
  | "FAILED";

export type ChatGptReplayFailureCode =
  | "canonical_replay_state_missing"
  | "canonical_replay_boundary_ambiguous"
  | "replacement_failed"
  | "replacement_not_ready"
  | "replacement_identity_mismatch"
  | "replacement_handle_invalid"
  | "stale_conversation_handle"
  | "replay_invalid_state";

export interface ChatGptReplayIdentity {
  readonly dshSessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly capabilitySnapshotId: string;
  readonly capabilityBindingId: string;
}

export interface ChatGptReplayBoundary {
  readonly canonicalRevision: string;
  readonly canonicalMessageCount: number;
  readonly settledToolCallIds: readonly string[];
  readonly pendingToolCallIds: readonly string[];
}

export interface ChatGptReplayPlan {
  readonly identity: ChatGptReplayIdentity;
  readonly canonicalContext: CanonicalChatGptWebContext;
  readonly canonicalJson: string;
  readonly canonicalRevision: string;
  readonly conversationHandle: string;
  readonly replayProof: string;
  readonly settledToolCallIds: readonly string[];
  readonly pendingToolCallIds: readonly string[];
}

export interface ChatGptReplacementConversation {
  readonly conversationHandle: string;
  readonly transportGeneration: string;
}

export interface ChatGptReplacementReady extends ChatGptReplacementConversation {
  readonly readinessProof: string;
}

export interface ChatGptReplacementBinding extends ChatGptReplacementReady {
  readonly identityProof: ChatGptReplayIdentity;
}

export interface ChatGptReplaySubmission {
  readonly canonicalContext: CanonicalChatGptWebContext;
  readonly canonicalJson: string;
  readonly canonicalRevision: string;
  readonly settledToolCallIds: readonly string[];
  readonly pendingToolCallIds: readonly string[];
  readonly replacement: ChatGptReplacementBinding;
}

export interface ChatGptReplaySubmissionProof {
  readonly replayProof: string;
}

export interface ChatGptWebRecoveryTransport {
  invalidateConversation(conversationHandle: string, signal?: AbortSignal): Promise<void>;
  createReplacementConversation(
    input: { identity: ChatGptReplayIdentity; reason: "context_exhausted" },
    signal?: AbortSignal,
  ): Promise<ChatGptReplacementConversation>;
  confirmReplacementReady(
    replacement: ChatGptReplacementConversation,
    signal?: AbortSignal,
  ): Promise<ChatGptReplacementReady>;
  bindReplacement(
    replacement: ChatGptReplacementReady,
    identity: ChatGptReplayIdentity,
    signal?: AbortSignal,
  ): Promise<ChatGptReplacementBinding>;
  /**
   * Submit the already-projected canonical DSH context to the ready replacement. The transport may
   * serialize or attach browser-side content, but it cannot alter DSH semantics or execution state.
   */
  replayCanonicalContext(
    submission: ChatGptReplaySubmission,
    signal?: AbortSignal,
  ): Promise<ChatGptReplaySubmissionProof>;
}

export class ChatGptReplayRecoveryError extends Error {
  constructor(
    message: string,
    readonly code: ChatGptReplayFailureCode,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptReplayRecoveryError";
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ChatGptReplayRecoveryError(
      `Replay ${label} is missing or invalid`,
      "canonical_replay_state_missing",
    );
  }
  return value;
}

function uniqueIds(ids: readonly string[], label: string): readonly string[] {
  const normalized = ids.map((id, index) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ChatGptReplayRecoveryError(
        `Replay ${label}[${index}] is invalid`,
        "canonical_replay_boundary_ambiguous",
      );
    }
    return id;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ChatGptReplayRecoveryError(
      `Replay ${label} contains duplicates`,
      "canonical_replay_boundary_ambiguous",
    );
  }
  return Object.freeze([...normalized]);
}

function collectCanonicalToolState(context: CanonicalChatGptWebContext): {
  calls: Set<string>;
  results: Set<string>;
} {
  const calls = new Set<string>();
  const results = new Set<string>();

  for (const message of context.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        if ((block as { type?: unknown }).type !== "tool_call") continue;
        const id = (block as { id?: unknown }).id;
        if (typeof id !== "string" || id.trim().length === 0) {
          throw new ChatGptReplayRecoveryError(
            "Canonical assistant tool call has no stable execution identity",
            "canonical_replay_boundary_ambiguous",
          );
        }
        if (calls.has(id)) {
          throw new ChatGptReplayRecoveryError(
            `Canonical replay contains duplicate tool call id ${id}`,
            "canonical_replay_boundary_ambiguous",
          );
        }
        calls.add(id);
      }
    }
    if (message.role === "tool_result") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new ChatGptReplayRecoveryError(
          "Canonical tool result has no stable tool_call_id",
          "canonical_replay_boundary_ambiguous",
        );
      }
      if (results.has(id)) {
        throw new ChatGptReplayRecoveryError(
          `Canonical replay contains duplicate settled tool result ${id}`,
          "canonical_replay_boundary_ambiguous",
        );
      }
      results.add(id);
    }
  }
  return { calls, results };
}

export function validateChatGptReplayBoundary(
  context: CanonicalChatGptWebContext,
  boundary: ChatGptReplayBoundary,
): ChatGptReplayBoundary {
  nonEmpty(boundary.canonicalRevision, "canonicalRevision");
  if (!Number.isSafeInteger(boundary.canonicalMessageCount)
    || boundary.canonicalMessageCount !== context.messages.length) {
    throw new ChatGptReplayRecoveryError(
      "Canonical replay message boundary cannot be proven against the canonical projection",
      "canonical_replay_boundary_ambiguous",
    );
  }

  const settled = uniqueIds(boundary.settledToolCallIds, "settledToolCallIds");
  const pending = uniqueIds(boundary.pendingToolCallIds, "pendingToolCallIds");
  const overlap = settled.find(id => pending.includes(id));
  if (overlap) {
    throw new ChatGptReplayRecoveryError(
      `Replay tool call ${overlap} is simultaneously settled and pending`,
      "canonical_replay_boundary_ambiguous",
    );
  }

  const { calls, results } = collectCanonicalToolState(context);
  const classified = new Set([...settled, ...pending]);

  for (const id of calls) {
    if (!classified.has(id)) {
      throw new ChatGptReplayRecoveryError(
        `Canonical tool call ${id} has no trusted replay classification`,
        "canonical_replay_boundary_ambiguous",
      );
    }
  }
  for (const id of classified) {
    if (!calls.has(id)) {
      throw new ChatGptReplayRecoveryError(
        `Replay boundary references unknown tool call ${id}`,
        "canonical_replay_boundary_ambiguous",
      );
    }
  }
  for (const id of results) {
    if (!settled.includes(id)) {
      throw new ChatGptReplayRecoveryError(
        `Canonical tool result ${id} is not classified as settled`,
        "canonical_replay_boundary_ambiguous",
      );
    }
  }
  for (const id of settled) {
    if (!results.has(id)) {
      throw new ChatGptReplayRecoveryError(
        `Replay marks tool call ${id} as settled but its canonical result is missing`,
        "canonical_replay_boundary_ambiguous",
      );
    }
  }
  for (const id of pending) {
    if (results.has(id)) {
      throw new ChatGptReplayRecoveryError(
        `Replay marks tool call ${id} as pending although a canonical result is already settled`,
        "canonical_replay_boundary_ambiguous",
      );
    }
  }

  return Object.freeze({
    canonicalRevision: boundary.canonicalRevision,
    canonicalMessageCount: boundary.canonicalMessageCount,
    settledToolCallIds: settled,
    pendingToolCallIds: pending,
  });
}

function validateIdentity(identity: ChatGptReplayIdentity): ChatGptReplayIdentity {
  const normalized = {
    dshSessionId: nonEmpty(identity.dshSessionId, "dshSessionId"),
    agentId: nonEmpty(identity.agentId, "agentId"),
    turnId: nonEmpty(identity.turnId, "turnId"),
    capabilitySnapshotId: nonEmpty(identity.capabilitySnapshotId, "capabilitySnapshotId"),
    capabilityBindingId: nonEmpty(identity.capabilityBindingId, "capabilityBindingId"),
  };
  if (normalized.agentId !== identity.agentId
    || normalized.dshSessionId !== identity.dshSessionId
    || normalized.turnId !== identity.turnId) {
    throw new ChatGptReplayRecoveryError(
      "Trusted DSH identity contains invalid whitespace-normalized identifiers",
      "canonical_replay_state_missing",
    );
  }
  return Object.freeze(normalized);
}

function sameIdentity(a: ChatGptReplayIdentity, b: ChatGptReplayIdentity): boolean {
  return a.dshSessionId === b.dshSessionId
    && a.agentId === b.agentId
    && a.turnId === b.turnId
    && a.capabilitySnapshotId === b.capabilitySnapshotId
    && a.capabilityBindingId === b.capabilityBindingId;
}

function validateHandle(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_024) {
    throw new ChatGptReplayRecoveryError(
      `${label} is missing or invalid`,
      "replacement_handle_invalid",
    );
  }
  return value;
}

function validateReadiness(
  replacement: ChatGptReplacementReady,
  candidate: ChatGptReplacementConversation,
): ChatGptReplacementReady {
  const candidateHandle = validateHandle(candidate.conversationHandle, "replacement conversation handle");
  if (replacement.conversationHandle !== candidateHandle
    || replacement.transportGeneration !== candidate.transportGeneration) {
    throw new ChatGptReplayRecoveryError(
      "Replacement readiness proof does not belong to the created conversation",
      "replacement_not_ready",
    );
  }
  if (typeof replacement.readinessProof !== "string" || replacement.readinessProof.trim().length === 0) {
    throw new ChatGptReplayRecoveryError(
      "Replacement conversation readiness was not explicitly proven",
      "replacement_not_ready",
    );
  }
  return Object.freeze({ ...replacement });
}

export class ChatGptWebReplayCoordinator {
  private phase: ChatGptReplayPhase = "BOUND";
  private continuity: ChatGptReplayContinuity = "EXACT_RESUME";
  private readonly retiredConversationHandles = new Set<string>();
  private currentConversationHandle: string;
  private currentIdentity: ChatGptReplayIdentity;

  constructor(identity: ChatGptReplayIdentity, conversationHandle: string) {
    this.currentIdentity = validateIdentity(identity);
    this.currentConversationHandle = validateHandle(conversationHandle, "initial conversation handle");
  }

  snapshot(): {
    phase: ChatGptReplayPhase;
    continuity: ChatGptReplayContinuity;
    conversationHandle: string;
    identity: ChatGptReplayIdentity;
    retiredConversationHandles: readonly string[];
  } {
    return Object.freeze({
      phase: this.phase,
      continuity: this.continuity,
      conversationHandle: this.currentConversationHandle,
      identity: this.currentIdentity,
      retiredConversationHandles: Object.freeze([...this.retiredConversationHandles]),
    });
  }

  reportContextExhausted(conversationHandle: string): void {
    if (this.phase !== "BOUND" && this.phase !== "RESUMED") {
      throw new ChatGptReplayRecoveryError(
        `Context exhaustion cannot be reported from phase ${this.phase}`,
        "replay_invalid_state",
      );
    }
    this.assertCurrentConversation(conversationHandle);
    // The exhaustion condition itself invalidates the old browser conversation. From this point on,
    // late events from that handle are stale even before the replacement is ready.
    this.retiredConversationHandles.add(conversationHandle);
    this.continuity = "REPLAY";
    this.phase = "CONTEXT_EXHAUSTED";
  }

  isCurrentConversationHandle(conversationHandle: string): boolean {
    return this.phase !== "FAILED"
      && this.currentConversationHandle === conversationHandle
      && !this.retiredConversationHandles.has(conversationHandle);
  }

  assertCurrentConversation(conversationHandle: string): void {
    if (!this.isCurrentConversationHandle(conversationHandle)) {
      throw new ChatGptReplayRecoveryError(
        "Browser event belongs to a retired or stale ChatGPT conversation",
        "stale_conversation_handle",
      );
    }
  }

  async recover(
    input: {
      canonicalContext: CanonicalChatGptWebContext;
      replayBoundary: ChatGptReplayBoundary;
      signal?: AbortSignal;
    },
    transport: ChatGptWebRecoveryTransport,
  ): Promise<ChatGptReplayPlan> {
    if (this.phase !== "CONTEXT_EXHAUSTED") {
      throw new ChatGptReplayRecoveryError(
        `Replay cannot start from phase ${this.phase}`,
        "replay_invalid_state",
      );
    }

    const boundary = validateChatGptReplayBoundary(input.canonicalContext, input.replayBoundary);
    const canonicalJson = serializeCanonicalChatGptWebContext(input.canonicalContext);
    const oldConversationHandle = this.currentConversationHandle;
    const identity = this.currentIdentity;

    try {
      this.phase = "REPLACING_CONVERSATION";
      this.retiredConversationHandles.add(oldConversationHandle);
      await transport.invalidateConversation(oldConversationHandle, input.signal);

      const replacement = await transport.createReplacementConversation(
        { identity, reason: "context_exhausted" },
        input.signal,
      );
      const replacementHandle = validateHandle(replacement.conversationHandle, "replacement conversation handle");
      if (replacementHandle === oldConversationHandle) {
        throw new ChatGptReplayRecoveryError(
          "Replacement conversation reused the exhausted conversation handle",
          "replacement_handle_invalid",
        );
      }

      const ready = validateReadiness(
        await transport.confirmReplacementReady(replacement, input.signal),
        replacement,
      );
      this.phase = "REPLACEMENT_READY";

      this.phase = "REPLAYING";
      const binding = await transport.bindReplacement(ready, identity, input.signal);
      const boundHandle = validateHandle(binding.conversationHandle, "bound replacement conversation handle");
      if (boundHandle !== replacement.conversationHandle) {
        throw new ChatGptReplayRecoveryError(
          "Replacement binding changed the conversation handle after readiness was proven",
          "replacement_handle_invalid",
        );
      }
      if (!sameIdentity(binding.identityProof, identity)) {
        throw new ChatGptReplayRecoveryError(
          "Replacement binding changed trusted DSH session/agent/turn/capability identity",
          "replacement_identity_mismatch",
        );
      }

      const replayProof = await transport.replayCanonicalContext(
        {
          canonicalContext: input.canonicalContext,
          canonicalJson,
          canonicalRevision: boundary.canonicalRevision,
          settledToolCallIds: boundary.settledToolCallIds,
          pendingToolCallIds: boundary.pendingToolCallIds,
          replacement: binding,
        },
        input.signal,
      );
      if (typeof replayProof.replayProof !== "string" || replayProof.replayProof.trim().length === 0) {
        throw new ChatGptReplayRecoveryError(
          "Canonical replay was submitted without an explicit acceptance proof",
          "replacement_failed",
        );
      }

      this.currentConversationHandle = boundHandle;
      this.currentIdentity = identity;
      this.phase = "RESUMED";

      return Object.freeze({
        identity,
        canonicalContext: input.canonicalContext,
        canonicalJson,
        canonicalRevision: boundary.canonicalRevision,
        conversationHandle: boundHandle,
        replayProof: replayProof.replayProof,
        settledToolCallIds: boundary.settledToolCallIds,
        pendingToolCallIds: boundary.pendingToolCallIds,
      });
    } catch (error) {
      this.phase = "FAILED";
      this.continuity = "FAILED";
      if (error instanceof ChatGptReplayRecoveryError) throw error;
      throw new ChatGptReplayRecoveryError(
        `ChatGPT Web conversation replacement/replay failed: ${error instanceof Error ? error.message : String(error)}`,
        "replacement_failed",
        { cause: error },
      );
    }
  }

  assertResumed(): void {
    if (this.phase !== "RESUMED" || this.continuity !== "REPLAY") {
      throw new ChatGptReplayRecoveryError(
        "ChatGPT Web replay has not reached RESUMED state",
        "replay_invalid_state",
      );
    }
  }
}
