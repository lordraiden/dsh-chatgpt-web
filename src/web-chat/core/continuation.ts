/**
 * Provider-neutral continuation decisions (architecture §7.1, §7.2, §10, §11).
 *
 * The core defines exactly three semantic outcomes — EXACT_RESUME, REPLAY and FAILED — plus the
 * explicit NEW_CONVERSATION intent a caller may express. Two rules dominate this module:
 *
 * - **No silent fork.** A continuity loss, an unknown remote checkpoint, an unsupported request or
 *   a stale generation never becomes a new provider conversation by itself. Only an explicit caller
 *   intent (`new_conversation` / `replay`) does that, and the plan says so.
 * - **Provider-driven.** Whether a conversation can continue is the driver's verdict
 *   (`assessConversation`), because it may depend on provider model rules, reasoning selection,
 *   instructions or remote state. The core decides what that verdict *means* for continuity.
 *
 * A handle is committed only after the driver has established it (architecture §7.3): if the driver
 * refuses or fails, the stored record does not change.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import { webChatAccountBindingId } from "./account-binding";
import { webChatAffinityKey } from "./conversation-key";
import type { WebChatAccountBinding, WebChatConversation, WebChatDshSessionIdentity } from "./conversation";
import {
  assertNoWebChatSecrets,
  type WebChatConversationDraft,
  type WebChatConversationIdentity,
  type WebChatConversationRecord,
  type WebChatConversationStore,
} from "./conversation-store";
import { webChatError, type WebChatError } from "./errors";
import type { WebChatReplayMessage } from "./exchange";
import type { WebChatProviderDriver } from "./provider";

/** The three semantic outcomes of §10, plus the explicit new-conversation intent. */
export type WebChatContinuationOutcome = "exact_resume" | "new_conversation" | "replay" | "failed";

/**
 * What the caller wants for this affinity.
 *
 * Nothing is inferred: replay and a new conversation are deliberate decisions, and a caller that
 * only asks to continue gets a failure rather than a replacement conversation when continuity
 * cannot be established.
 */
export type WebChatContinuationIntent =
  | { readonly kind: "continue" }
  | { readonly kind: "new_conversation"; readonly reason: string }
  | { readonly kind: "replay"; readonly reason: string; readonly history: readonly WebChatReplayMessage[] };

/** Everything the core needs to decide continuity for one turn. */
export interface WebChatContinuationRequest {
  /** Authenticated provider/account binding this turn runs under. */
  readonly binding: WebChatAccountBinding;
  /** Canonical host session identity. */
  readonly dshSession: WebChatDshSessionIdentity;
  /** Provider-private logical thread identity for that session. */
  readonly threadId: string;
  /** Execution namespace of the provider deployment. */
  readonly namespace?: string;
  /** Host-selected model route. */
  readonly model: string;
  /** Provider-neutral reasoning selection. */
  readonly reasoningMode?: string;
  /** Instructions the caller wants installed in the conversation, when it supplies any. */
  readonly systemInstructions?: readonly string[];
  /**
   * The generation the caller believes is current, when it holds one.
   *
   * A stale expectation is refused instead of silently continuing a conversation the caller no
   * longer owns.
   */
  readonly expectedGeneration?: number;
  readonly intent: WebChatContinuationIntent;
}

/** The decision, with the record and conversation the caller should use next. */
export interface WebChatContinuationPlan {
  readonly outcome: WebChatContinuationOutcome;
  readonly identity: WebChatConversationIdentity;
  /** The stored record, unless this affinity has none yet. */
  readonly record?: WebChatConversationRecord;
  /** The conversation to continue, create or replay; absent when the outcome is `failed`. */
  readonly conversation?: WebChatConversation;
  /** Always present: why this outcome, for diagnostics and for the caller's decision. */
  readonly reason: string;
  /** The semantic failure, when the outcome is `failed`. */
  readonly error?: WebChatError;
}

/** The affinity identity a request resolves to. */
export function webChatContinuationIdentity(request: {
  binding: WebChatAccountBinding;
  dshSession: WebChatDshSessionIdentity;
  threadId: string;
  namespace?: string;
}): WebChatConversationIdentity {
  const dshSessionId = request.dshSession.sessionId;
  if (!dshSessionId) {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "A provider conversation affinity requires a host session identity");
  }
  const providerId = request.binding.providerId;
  const bindingId = webChatAccountBindingId(request.binding);
  return {
    providerId,
    bindingId,
    key: webChatAffinityKey({
      providerId,
      bindingId,
      dshSessionId,
      threadId: request.threadId,
      ...(request.namespace !== undefined ? { namespace: request.namespace } : {}),
    }),
  };
}

/**
 * Record that a turn is about to be attempted.
 *
 * The attempt is not proof of anything: the record becomes `unconfirmed`, which no continuation may
 * resume until a driver reconciles it (architecture §7.3).
 */
export async function beginWebChatConversationAttempt(
  store: WebChatConversationStore,
  identity: WebChatConversationIdentity,
  attempt: { readonly generation: number },
): Promise<WebChatConversationRecord> {
  return store.update(identity, (current) => {
    if (!current) {
      throw webChatError("CONVERSATION_STATE_MISMATCH", "Cannot attempt a turn on an unrecorded conversation");
    }
    if (current.generation !== attempt.generation) {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `Cannot attempt generation ${attempt.generation}; the current generation is ${current.generation}`,
      );
    }
    return { ...current, checkpoint: "unconfirmed" };
  });
}

/**
 * Confirm a settled turn.
 *
 * Only a driver-confirmed settlement reaches this: the generation it confirms must still be the
 * current one, so a late settlement of a replaced conversation can never re-authorize it.
 */
export async function confirmWebChatConversation(
  store: WebChatConversationStore,
  identity: WebChatConversationIdentity,
  settled: { readonly generation: number; readonly turnId: string; readonly at: number },
): Promise<WebChatConversationRecord> {
  return store.update(identity, (current) => {
    if (!current) {
      throw webChatError("CONVERSATION_STATE_MISMATCH", "Cannot confirm a turn on an unrecorded conversation");
    }
    if (current.generation !== settled.generation) {
      throw webChatError(
        "CONVERSATION_STATE_MISMATCH",
        `Cannot confirm generation ${settled.generation}; the current generation is ${current.generation}`,
      );
    }
    return {
      ...current,
      status: "resumable",
      checkpoint: "confirmed",
      lastConfirmedTurn: { turnId: settled.turnId, at: settled.at },
    };
  });
}

/** A failed decision, never a replacement conversation. */
function failure(
  identity: WebChatConversationIdentity,
  category: Parameters<typeof webChatError>[0],
  reason: string,
  record?: WebChatConversationRecord,
): WebChatContinuationPlan {
  return {
    outcome: "failed",
    identity,
    reason,
    error: webChatError(category, reason),
    ...(record ? { record } : {}),
  };
}

/**
 * Resolve continuity for one turn.
 *
 * The driver is always consulted, because only it can establish whether remote continuity exists —
 * including after a store loss, when it may reconcile the conversation itself and hand it back.
 *
 * @param deps - the durable store and the selected provider driver.
 * @param request - the affinity, the turn selection and the caller's explicit intent.
 * @returns the plan: `exact_resume`, `new_conversation`, `replay`, or `failed` with the reason.
 */
export async function resolveWebChatContinuation(
  deps: { readonly store: WebChatConversationStore; readonly driver: WebChatProviderDriver },
  request: WebChatContinuationRequest,
): Promise<WebChatContinuationPlan> {
  const identity = webChatContinuationIdentity(request);
  const stored = await deps.store.read(identity);

  if (stored && request.expectedGeneration !== undefined && stored.generation !== request.expectedGeneration) {
    return failure(
      identity,
      "CONVERSATION_STATE_MISMATCH",
      `Conversation generation ${request.expectedGeneration} is stale; the current generation is ${stored.generation}`,
      stored,
    );
  }

  const assessment = await deps.driver.assessConversation({
    dshSession: request.dshSession,
    binding: request.binding,
    affinity: { providerId: identity.providerId, bindingId: identity.bindingId, threadId: request.threadId },
    model: request.model,
    ...(request.reasoningMode !== undefined ? { reasoningMode: request.reasoningMode } : {}),
    ...(request.systemInstructions !== undefined ? { systemInstructions: request.systemInstructions } : {}),
    ...(stored ? { conversation: conversationOf(stored) } : {}),
  });

  // An explicit new conversation or replay is honored only through the driver, and the record is
  // committed only after the driver established the new conversation (§7.3).
  if (request.intent.kind === "new_conversation") {
    return startNewConversation(deps, identity, request, stored, request.intent.reason);
  }
  if (request.intent.kind === "replay") {
    if (request.intent.history.length === 0) {
      return failure(
        identity,
        "CONVERSATION_STATE_MISMATCH",
        "Replay requires canonical host history to reconstruct the conversation from",
        stored,
      );
    }
    return replayConversation(deps, identity, request, stored, request.intent.reason);
  }

  // intent: continue
  if (assessment.conversation) {
    // The driver reconciled continuity itself (e.g. it found the remote conversation after a store
    // loss). Adopting it is explicit: the driver established it, the core records it.
    const adopted = await deps.store.update(identity, () => draftFromConversation(assessment.conversation!));
    return {
      outcome: "exact_resume",
      identity,
      record: adopted,
      conversation: conversationOf(adopted),
      reason: `the driver reconciled the provider conversation${assessment.reason ? ` (${assessment.reason})` : ""}`,
    };
  }

  if (assessment.status === "unsupported") {
    return failure(identity, "UNSUPPORTED_OPTION", assessment.reason ?? "The provider cannot serve this turn in this conversation", stored);
  }
  if (assessment.status === "lost") {
    return failure(identity, "CONVERSATION_LOST", assessment.reason ?? "The provider conversation is lost", stored);
  }
  if (assessment.status === "replay_required") {
    return failure(
      identity,
      "CONVERSATION_STATE_MISMATCH",
      assessment.reason ?? "The provider requires an explicit replay; a continuation is refused",
      stored,
    );
  }
  if (!stored) {
    if (assessment.status === "resumable") {
      return failure(
        identity,
        "CONVERSATION_STATE_MISMATCH",
        "The provider believes the conversation can continue but this affinity has no recorded handle",
      );
    }
    return startNewConversation(deps, identity, request, undefined, "no prior conversation for this affinity");
  }

  if (assessment.status === "unreachable") {
    return failure(identity, "TRANSPORT_UNAVAILABLE", assessment.reason ?? "The provider conversation state is unknown", stored);
  }
  if (stored.status === "lost" || stored.status === "unreachable" || stored.status === "unsupported") {
    return failure(
      identity,
      stored.status === "lost" ? "CONVERSATION_LOST" : "CONVERSATION_STATE_MISMATCH",
      `The recorded conversation is ${stored.status}; a continuation is refused and nothing is replaced silently`,
      stored,
    );
  }
  if (stored.checkpoint !== "confirmed") {
    return failure(
      identity,
      "CONVERSATION_STATE_MISMATCH",
      "The last attempt on this conversation was never confirmed; the provider must reconcile it before it can be resumed",
      stored,
    );
  }
  if (!stored.handle) {
    return failure(identity, "CONVERSATION_STATE_MISMATCH", "A resumable conversation has no provider handle", stored);
  }

  // Exact resume: the same generation and the same opaque handle, re-confirmed.
  const resumed = await deps.store.update(identity, (current) => ({
    ...(current as WebChatConversationRecord),
    status: "resumable",
    checkpoint: "confirmed",
  }));
  return {
    outcome: "exact_resume",
    identity,
    record: resumed,
    conversation: conversationOf(resumed),
    reason: assessment.reason ?? "the provider confirmed the conversation can continue",
  };
}

/** The core's view of a stored record. */
function conversationOf(record: WebChatConversationRecord): WebChatConversation {
  if (!record.handle) {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "A stored conversation without a handle cannot be exposed");
  }
  return {
    key: record.identity.key,
    providerId: record.identity.providerId,
    bindingId: record.identity.bindingId,
    generation: record.generation,
    handle: record.handle,
    status: record.status,
  };
}

/** A record draft for a conversation a driver established. */
function draftFromConversation(conversation: WebChatConversation): WebChatConversationDraft {
  assertNoWebChatSecrets({ identity: conversation.key });
  return {
    identity: {
      providerId: conversation.providerId,
      bindingId: conversation.bindingId,
      key: conversation.key,
    },
    generation: conversation.generation,
    handle: conversation.handle,
    status: conversation.status,
    checkpoint: "confirmed",
  };
}

/** Ask the driver for a brand-new conversation and record it only once it exists. */
async function startNewConversation(
  deps: { readonly store: WebChatConversationStore; readonly driver: WebChatProviderDriver },
  identity: WebChatConversationIdentity,
  request: WebChatContinuationRequest,
  stored: WebChatConversationRecord | undefined,
  reason: string,
): Promise<WebChatContinuationPlan> {
  const created = await deps.driver.createConversation({
    dshSession: request.dshSession,
    binding: request.binding,
    affinity: { providerId: identity.providerId, bindingId: identity.bindingId, threadId: request.threadId },
    model: request.model,
    ...(request.reasoningMode !== undefined ? { reasoningMode: request.reasoningMode } : {}),
    ...(request.systemInstructions !== undefined ? { systemInstructions: request.systemInstructions } : {}),
  });
  if (created.generation <= (stored?.generation ?? 0)) {
    return failure(
      identity,
      "CONVERSATION_STATE_MISMATCH",
      "A new provider conversation must advance the generation",
      stored,
    );
  }
  const record = await deps.store.update(identity, () => draftFromConversation(created));
  return {
    outcome: "new_conversation",
    identity,
    record,
    conversation: conversationOf(record),
    reason,
  };
}

/** Ask the driver to rebuild the conversation from canonical host history. */
async function replayConversation(
  deps: { readonly store: WebChatConversationStore; readonly driver: WebChatProviderDriver },
  identity: WebChatConversationIdentity,
  request: WebChatContinuationRequest,
  stored: WebChatConversationRecord | undefined,
  reason: string,
): Promise<WebChatContinuationPlan> {
  if (request.intent.kind !== "replay") {
    return failure(identity, "CONVERSATION_STATE_MISMATCH", "Replay requires an explicit replay intent", stored);
  }
  const replayed = await deps.driver.replayConversation({
    dshSession: request.dshSession,
    binding: request.binding,
    affinity: { providerId: identity.providerId, bindingId: identity.bindingId, threadId: request.threadId },
    model: request.model,
    ...(request.reasoningMode !== undefined ? { reasoningMode: request.reasoningMode } : {}),
    ...(request.systemInstructions !== undefined ? { systemInstructions: request.systemInstructions } : {}),
    ...(stored ? { conversation: conversationOf(stored) } : {}),
    history: request.intent.history,
  });
  if (replayed.generation <= (stored?.generation ?? 0)) {
    return failure(
      identity,
      "CONVERSATION_STATE_MISMATCH",
      "A replayed provider conversation must advance the generation",
      stored,
    );
  }
  const record = await deps.store.update(identity, () => draftFromConversation(replayed));
  return {
    outcome: "replay",
    identity,
    record,
    conversation: conversationOf(record),
    reason,
  };
}
