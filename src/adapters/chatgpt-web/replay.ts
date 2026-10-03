import { createHash } from "node:crypto";
import type { CanonicalChatGptWebContext } from "./context-projection";
import { CHATGPT_CONTEXT_EXHAUSTED_CODE } from "./adapter-error";
import type { ProviderRecovery } from "./provider-core";

const CHATGPT_REPLAY_BOUNDARY_BRAND = Symbol("chatgpt-replay-boundary");

export interface ChatGptReplayTrigger {
  readonly code: typeof CHATGPT_CONTEXT_EXHAUSTED_CODE;
}

export interface ChatGptReplayIdentity {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly capabilitySnapshotId: string;
  readonly capabilityBindingId: string;
}

/**
 * Trusted provider execution state at the exhaustion boundary.
 *
 * The caller is expected to obtain these sets from DSH/ProviderCore state. The replay coordinator
 * never infers settled/pending execution state from the ChatGPT transcript.
 */
export interface ChatGptReplayExecutionState {
  readonly settledToolCallIds: readonly string[];
  readonly pendingToolCallIds: readonly string[];
}

export interface ChatGptReplayBoundary {
  readonly canonicalRevision: string;
  readonly canonicalMessageCount: number;
  readonly settledToolCallIds: readonly string[];
  readonly pendingToolCallIds: readonly string[];
  readonly [CHATGPT_REPLAY_BOUNDARY_BRAND]: true;
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

function validateTrigger(trigger: ChatGptReplayTrigger): void {
  if (trigger.code !== CHATGPT_CONTEXT_EXHAUSTED_CODE) {
    throw new Error("ChatGPT replay requires the context_exhausted recovery condition");
  }
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

function uniqueToolIds(ids: readonly string[], label: string): string[] {
  const normalized = ids.map(id => {
    requireNonEmpty(id, label + " tool call id");
    return id;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("ChatGPT replay boundary contains duplicate " + label + " tool call id");
  }
  return normalized;
}

function collectCanonicalToolState(context: CanonicalChatGptWebContext): {
  calls: Set<string>;
  results: Set<string>;
} {
  const calls = new Set<string>();
  const results = new Set<string>();

  for (const message of context.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool_call") continue;
        const id = record.id;
        if (typeof id !== "string" || !id.trim()) {
          throw new Error("Canonical assistant tool call has no stable execution identity");
        }
        if (calls.has(id)) {
          throw new Error("Canonical replay contains duplicate tool call id " + id);
        }
        calls.add(id);
      }
    }
    if (message.role === "tool_result") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("Canonical tool result has no stable tool_call_id");
      }
      if (results.has(id)) {
        throw new Error("Canonical replay contains duplicate settled tool result " + id);
      }
      results.add(id);
    }
  }

  return { calls, results };
}

/**
 * Build an immutable replay boundary from canonical DSH projection + trusted DSH/provider execution
 * state. The browser transcript is never consulted.
 */
export function createChatGptReplayBoundary(
  context: CanonicalChatGptWebContext,
  state: ChatGptReplayExecutionState,
): ChatGptReplayBoundary {
  if (!Number.isSafeInteger(context.messages.length) || context.messages.length < 0) {
    throw new Error("Canonical replay message count is invalid");
  }

  const settledToolCallIds = uniqueToolIds(state.settledToolCallIds, "settled");
  const pendingToolCallIds = uniqueToolIds(state.pendingToolCallIds, "pending");
  const settled = new Set(settledToolCallIds);
  const pending = new Set(pendingToolCallIds);

  for (const id of pending) {
    if (settled.has(id)) {
      throw new Error("ChatGPT replay boundary classifies a tool call as both settled and pending");
    }
  }

  const { calls, results } = collectCanonicalToolState(context);
  const classified = new Set([...settled, ...pending]);

  for (const id of calls) {
    if (!classified.has(id)) {
      throw new Error("Canonical tool call " + id + " has no trusted replay classification");
    }
  }
  for (const id of classified) {
    if (!calls.has(id)) {
      throw new Error("Replay boundary references unknown canonical tool call " + id);
    }
  }
  for (const id of results) {
    if (!settled.has(id)) {
      throw new Error("Canonical tool result " + id + " is not classified as settled");
    }
  }
  for (const id of settled) {
    if (!results.has(id)) {
      throw new Error("Replay marks tool call " + id + " as settled but its canonical result is missing");
    }
  }
  for (const id of pending) {
    if (results.has(id)) {
      throw new Error("Replay marks tool call " + id + " as pending although a canonical result is settled");
    }
  }

  const canonicalRevision = createHash("sha256")
    .update(JSON.stringify({
      version: context.version,
      system: context.system,
      messages: context.messages,
      images: context.images,
    }))
    .digest("hex");

  return Object.freeze({
    canonicalRevision,
    canonicalMessageCount: context.messages.length,
    settledToolCallIds: Object.freeze([...settledToolCallIds]),
    pendingToolCallIds: Object.freeze([...pendingToolCallIds]),
    [CHATGPT_REPLAY_BOUNDARY_BRAND]: true,
  });
}

function validateBoundary(
  context: CanonicalChatGptWebContext,
  boundary: ChatGptReplayBoundary,
): void {
  if (boundary?.[CHATGPT_REPLAY_BOUNDARY_BRAND] !== true) {
    throw new Error("ChatGPT replay requires a boundary created from trusted DSH/provider execution state");
  }
  if (!boundary.canonicalRevision.trim()) {
    throw new Error("ChatGPT replay boundary is missing its canonical revision");
  }
  if (boundary.canonicalMessageCount !== context.messages.length) {
    throw new Error("ChatGPT replay message boundary cannot be proven against canonical state");
  }

  // Re-run the invariant check at the runtime seam. This protects the coordinator if a future caller
  // bypasses the factory through an unsafe cast or deserialized data.
  const rebuilt = createChatGptReplayBoundary(context, {
    settledToolCallIds: boundary.settledToolCallIds,
    pendingToolCallIds: boundary.pendingToolCallIds,
  });
  if (rebuilt.canonicalRevision !== boundary.canonicalRevision) {
    throw new Error("ChatGPT replay canonical revision does not match canonical state");
  }
  if (
    rebuilt.settledToolCallIds.join("\u0000") !== boundary.settledToolCallIds.join("\u0000")
    || rebuilt.pendingToolCallIds.join("\u0000") !== boundary.pendingToolCallIds.join("\u0000")
  ) {
    throw new Error("ChatGPT replay boundary changed after canonical validation");
  }
}

export interface ChatGptReplayRequest {
  readonly trigger: ChatGptReplayTrigger;
  readonly exhaustedConversation: ChatGptConversationHandle;
  readonly identity: ChatGptReplayIdentity;
  readonly context: CanonicalChatGptWebContext;
  /** Boundary must be produced from trusted DSH/provider execution state via createChatGptReplayBoundary. */
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

  async replay(
    request: ChatGptReplayRequest,
    transport: ChatGptReplayTransport,
  ): Promise<ChatGptReplaySnapshot> {
    if (this.phase !== "NEW") {
      throw new ChatGptReplayError(this.phase);
    }

    try {
      validateTrigger(request.trigger);
      validateIdentity(request.identity);
      validateHandle(request.exhaustedConversation, "exhausted");
      validateBoundary(request.context, request.boundary);

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
      this.generation = replacement.generation;

      await transport.invalidateConversation(request.exhaustedConversation, request.identity);
      this.staleConversationIds.add(request.exhaustedConversation.id);

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
