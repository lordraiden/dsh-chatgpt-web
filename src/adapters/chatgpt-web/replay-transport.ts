import { createHash } from "node:crypto";
import type { CapabilitySnapshot } from "./capability-projector";
import type {
  ChatGptConversationHandle,
  ChatGptReplayBinding,
  ChatGptReplayTransport,
} from "./replay";
import type {
  ChatGptTurnRuntime,
  ChatGptTurnSession,
  ChatGptTurnSessions,
} from "./turn-execution";

export interface ChatGptWebReplayRuntimeOptions {
  conversationGeneration: number;
  onSurfaceReady: () => void | Promise<void>;
}

export interface ChatGptWebReplayTransportDependencies {
  readonly sessions: ChatGptTurnSessions;
  readonly executionKey: string;
  readonly ownerKey: string;
  readonly traceId: string;
  readonly nativeTurnId: string;
  readonly nativeThreadId?: string;
  readonly conversationKey: string;
  readonly exhaustedConversation: ChatGptConversationHandle;
  readonly capabilitySnapshot: CapabilitySnapshot;
  readonly startRuntime: (options: ChatGptWebReplayRuntimeOptions) => ChatGptTurnRuntime;
  readonly signal?: AbortSignal;
}

export interface ChatGptWebReplayTransportHandle {
  readonly transport: ChatGptReplayTransport;
  readonly replacement: ChatGptConversationHandle;
  getSession(): ChatGptTurnSession | undefined;
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new DOMException("ChatGPT web replay aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("ChatGPT web replay aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function chatGptConversationHandleForEpoch(
  conversationKey: string,
  generation: number,
): ChatGptConversationHandle {
  if (!conversationKey.trim()) throw new Error("ChatGPT conversation handle requires a conversation key");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("ChatGPT conversation handle requires a positive safe generation");
  }
  return Object.freeze({
    id: createHash("sha256")
      .update(JSON.stringify({ provider: "chatgpt-web", conversationKey, generation }))
      .digest("hex"),
    generation,
  });
}

function assertHandle(handle: ChatGptConversationHandle, expected: ChatGptConversationHandle, label: string): void {
  if (handle.id !== expected.id || handle.generation !== expected.generation) {
    throw new Error("ChatGPT replay " + label + " conversation handle does not match the expected conversation epoch");
  }
}

export function createChatGptWebReplayTransport(
  dependencies: ChatGptWebReplayTransportDependencies,
): ChatGptWebReplayTransportHandle {
  const currentGeneration = dependencies.sessions.conversationGeneration(dependencies.conversationKey);
  const replacementGeneration = Math.max(
    dependencies.exhaustedConversation.generation + 1,
    currentGeneration + 1,
  );
  if (!Number.isSafeInteger(replacementGeneration)) {
    throw new Error("ChatGPT replay replacement conversation generation overflowed");
  }

  const replacement = chatGptConversationHandleForEpoch(
    dependencies.conversationKey,
    replacementGeneration,
  );

  let session: ChatGptTurnSession | undefined;
  let surfaceReady = false;
  let replacementBound = false;
  let replayAccepted = false;
  let replacementStarted = false;

  let resolveSurfaceReady!: () => void;
  let rejectSurfaceReady!: (error: Error) => void;
  const surfaceReadyPromise = new Promise<void>((resolve, reject) => {
    resolveSurfaceReady = resolve;
    rejectSurfaceReady = reject;
  });

  let resolveResumeGate!: () => void;
  const resumeGate = new Promise<void>(resolve => {
    resolveResumeGate = resolve;
  });

  const transport: ChatGptReplayTransport = {
    async createReplacementConversation() {
      if (replacementStarted) throw new Error("ChatGPT replay replacement conversation was already created");
      replacementStarted = true;
      await awaitWithAbort(
        dependencies.sessions.waitForConversationRetirement(dependencies.conversationKey),
        dependencies.signal,
      );
      dependencies.sessions.setConversationGeneration(
        dependencies.conversationKey,
        replacementGeneration,
      );
      session = await dependencies.sessions.getOrCreateAfterOwnerRetirement(
        dependencies.executionKey,
        dependencies.ownerKey,
        () => dependencies.startRuntime({
          conversationGeneration: replacementGeneration,
          onSurfaceReady: async () => {
            surfaceReady = true;
            resolveSurfaceReady();
            await resumeGate;
          },
        }),
        dependencies.traceId,
        dependencies.signal,
        dependencies.nativeTurnId,
        dependencies.nativeThreadId,
      );

      if (session.runtime.conversationGeneration !== replacementGeneration) {
        throw new Error("ChatGPT replay replacement runtime has the wrong conversation generation");
      }
      if (session.runtime.conversationKey?.trim() !== dependencies.conversationKey) {
        throw new Error("ChatGPT replay replacement runtime is not attached to the retained conversation");
      }

      void session.browserOutcome.then(outcome => {
        if (!surfaceReady) {
          rejectSurfaceReady(
            outcome.type === "error"
              ? outcome.error
              : new Error("ChatGPT replay replacement completed before its surface became ready"),
          );
        }
      });

      return replacement;
    },

    async waitForReplacementReady(conversation) {
      assertHandle(conversation, replacement, "replacement");
      await awaitWithAbort(surfaceReadyPromise, dependencies.signal);
      if (!surfaceReady) throw new Error("ChatGPT replay replacement readiness was not proven");
      if (!session) throw new Error("ChatGPT replay replacement session is missing");
      if (session.runtime.capabilitySnapshot !== dependencies.capabilitySnapshot) {
        throw new Error("ChatGPT replay replacement changed the trusted capability snapshot");
      }
    },

    async bindReplacementConversation(previous, next, identity): Promise<ChatGptReplayBinding> {
      assertHandle(previous, dependencies.exhaustedConversation, "exhausted");
      assertHandle(next, replacement, "replacement");
      if (!session) throw new Error("ChatGPT replay replacement session is missing");
      if (!surfaceReady) throw new Error("ChatGPT replay replacement cannot bind before readiness");
      if (session.runtime.capabilitySnapshot !== dependencies.capabilitySnapshot) {
        throw new Error("ChatGPT replay replacement changed the trusted capability snapshot");
      }
      if (session.runtime.conversationKey !== dependencies.conversationKey) {
        throw new Error("ChatGPT replay replacement changed the retained conversation key");
      }
      if (session.runtime.conversationGeneration !== replacement.generation) {
        throw new Error("ChatGPT replay replacement changed the conversation epoch");
      }
      replacementBound = true;
      return {
        conversation: replacement,
        identity,
      };
    },

    async invalidateConversation(conversation) {
      assertHandle(conversation, dependencies.exhaustedConversation, "exhausted");
      if (!replacementBound) {
        throw new Error("ChatGPT replay cannot retire the exhausted conversation before replacement binding");
      }
      await awaitWithAbort(
        dependencies.sessions.waitForConversationRetirement(dependencies.conversationKey),
        dependencies.signal,
      );
      const head = dependencies.sessions.findConversationHead(dependencies.conversationKey);
      if (head && head.runtime.conversationGeneration !== replacementGeneration) {
        throw new Error("ChatGPT replay found the exhausted conversation still attached after replacement binding");
      }
    },

    async replayCanonicalContext(conversation, _context, boundary, identity) {
      assertHandle(conversation, replacement, "replacement");
      if (!replacementBound) throw new Error("ChatGPT replay cannot submit canonical context before replacement binding");
      if (identity.sessionId !== dependencies.capabilitySnapshot.sessionId
        || identity.agentId !== dependencies.capabilitySnapshot.agentId
        || identity.turnId !== dependencies.capabilitySnapshot.turnId
        || identity.capabilitySnapshotId !== dependencies.capabilitySnapshot.snapshotId) {
        throw new Error("ChatGPT replay canonical handoff changed the trusted DSH identity");
      }
      if (!boundary.canonicalRevision.trim()) {
        throw new Error("ChatGPT replay canonical handoff is missing its canonical revision");
      }
      replayAccepted = true;
    },

    async resume(conversation) {
      assertHandle(conversation, replacement, "replacement");
      if (!replayAccepted) {
        throw new Error("ChatGPT replay cannot resume before canonical context acceptance");
      }
      if (!session) throw new Error("ChatGPT replay replacement session is missing");
      resolveResumeGate();
      const outcome = await awaitWithAbort(session.browserOutcome, dependencies.signal);
      if (outcome.type === "error") throw outcome.error;
    },
  };

  return {
    transport,
    replacement,
    getSession: () => session,
  };
}
