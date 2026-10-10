/**
 * Durable conversation continuity store (architecture §6.3, §7.3, §18).
 *
 * The store holds *continuity state only*: which provider conversation belongs to which affinity,
 * its generation, its opaque handle, whether that handle is authoritative, and which initialization
 * state is physically installed in the current generation.
 *
 * It is not a transcript (canonical history stays with the host, and nothing here stores messages),
 * and it is explicitly not:
 *
 * - a lease or exchange owner: the exchange lifecycle owns transport readiness and settlement
 *   (issue #191 / PR 3) — a record says nothing about whether a turn is running;
 * - a transport representation: a physical page/context/session is never conversation identity.
 *
 * The provider handle is opaque: the store persists, versions, compares and returns it verbatim and
 * never interprets it (architecture §4.2).
 *
 * This module owns the record, the invariants and the port; a durable backend lives outside the core
 * (`src/web-chat/persistence`), because byte-level storage is infrastructure, not core semantics.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import { webChatError, type WebChatError } from "./errors";
import type { WebChatConversationHandle, WebChatConversationStatus } from "./conversation";

/** Identity of one affinity: provider, account binding and affinity key. */
export interface WebChatConversationIdentity {
  readonly providerId: string;
  readonly bindingId: string;
  readonly key: string;
}

/**
 * The initialization state physically installed in one generation of a conversation.
 *
 * A fingerprint recorded for generation N is never current for generation N+1: a new physical
 * generation reinstalls its initialization state (the rule the existing provider path established in
 * #172, generalized here).
 */
export interface WebChatConversationInitialization {
  readonly generation: number;
  readonly fingerprint: string;
}

/** What the store persists per affinity (architecture §7.3). */
export interface WebChatConversationRecord {
  readonly identity: WebChatConversationIdentity;
  /** Physical/logical generation of this conversation; positive, never moves backwards. */
  readonly generation: number;
  /** Opaque provider conversation handle, when the provider has established one. */
  readonly handle?: WebChatConversationHandle;
  /** What the driver last established about this conversation. */
  readonly status: WebChatConversationStatus;
  /**
   * Whether the stored continuity is authoritative.
   *
   * `status` says what the driver last *established*; `checkpoint` says whether that state may be
   * acted on. Only a `confirmed` checkpoint may be resumed: an attempt that may have reached the
   * provider but whose outcome is unknown stays `unconfirmed` until the driver reconciles it, so an
   * attempted request is never proof of continuation (architecture §7.3).
   */
  readonly checkpoint: "confirmed" | "unconfirmed";
  /** Initialization state installed in the current generation, when one is installed. */
  readonly initialization?: WebChatConversationInitialization;
  /** Last turn the provider confirmed for this conversation. */
  readonly lastConfirmedTurn?: { readonly turnId: string; readonly at: number };
  /** Monotonic revision of this record, owned by the store. */
  readonly revision: number;
  /** Creation time (epoch ms), owned by the store. */
  readonly createdAt: number;
  /** Last update time (epoch ms), owned by the store. */
  readonly updatedAt: number;
}

/** A record as a caller proposes it: the store owns revision and timestamps. */
export type WebChatConversationDraft = Omit<
  WebChatConversationRecord,
  "revision" | "createdAt" | "updatedAt"
>;

/** The store port. Implementations must apply the rules below; the helper does. */
export interface WebChatConversationStore {
  /** Read one affinity's record. */
  read(identity: WebChatConversationIdentity): Promise<WebChatConversationRecord | undefined>;
  /** Every record this store holds, for diagnostics and reconciliation. */
  list(): Promise<readonly WebChatConversationRecord[]>;
  /**
   * Atomically read-modify-write one affinity's record.
   *
   * The mutator sees the current record (or undefined) and returns the next state. Concurrent
   * updates of the same affinity are serialized, so no update is lost. The store owns `revision`,
   * `createdAt` and `updatedAt`, and refuses a mutator that changes the identity, moves the
   * generation backwards, or proposes a record carrying a secret.
   */
  update(
    identity: WebChatConversationIdentity,
    mutate: (current: WebChatConversationRecord | undefined) => WebChatConversationDraft,
  ): Promise<WebChatConversationRecord>;
  /**
   * Forget one affinity explicitly.
   *
   * Nothing forgets a conversation implicitly: a lost conversation stays recorded (as `lost`) until
   * a caller decides to start a new one.
   */
  forget(identity: WebChatConversationIdentity): Promise<boolean>;
}

/** Options shared by the store implementations. */
export interface WebChatConversationStoreOptions {
  /** Clock, injectable so identity and timing are deterministic in tests. */
  readonly now?: () => number;
}

/** Field names that must never appear in a stored record. */
const FORBIDDEN_RECORD_KEYS = /^(?:cookie|cookies|token|tokens|password|secret|authorization|authToken|storageState|sessionToken|bearer)$/i;

/** Value shapes that must never be persisted inside a record's structured fields. */
const FORBIDDEN_RECORD_VALUE = /\bcookie\b|\bBearer\s+[A-Za-z0-9._-]{8,}|storageState|_authToken/i;

const RECORD_KEYS = new Set([
  "identity",
  "generation",
  "handle",
  "status",
  "checkpoint",
  "initialization",
  "lastConfirmedTurn",
  "revision",
  "createdAt",
  "updatedAt",
]);

const CONVERSATION_STATUSES: readonly WebChatConversationStatus[] = [
  "new",
  "resumable",
  "replay_required",
  "lost",
  "unreachable",
  "unsupported",
];

/**
 * Refuse a stored record that could carry authentication material.
 *
 * Applies to the structured, core-authored fields only. The opaque provider handle is deliberately
 * exempt: the core may not interpret provider-private state, so it cannot judge its contents — a
 * driver must never place a credential there, and the record shape gives it nowhere else to go.
 *
 * @param value - a record, a draft, or any value a caller proposes to persist.
 * @throws {WebChatError} `UNSUPPORTED_OPTION` when an unknown or credential-bearing field is present.
 */
export function assertNoWebChatSecrets(value: unknown): void {
  const inspect = (candidate: unknown, path: string, insideHandle: boolean): void => {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      if (!insideHandle && FORBIDDEN_RECORD_VALUE.test(candidate)) {
        throw webChatError("UNSUPPORTED_OPTION", `${path} looks like authentication material and is never persisted`);
      }
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      if (FORBIDDEN_RECORD_KEYS.test(key)) {
        throw webChatError("UNSUPPORTED_OPTION", `${path}.${key} is authentication material and is never persisted`);
      }
      inspect(nested, `${path}.${key}`, insideHandle || key === "handle");
    }
  };
  inspect(value, "record", false);
}

/** Refuse a record shape the store does not own, so no unplanned field can be persisted. */
function assertKnownRecordKeys(draft: WebChatConversationDraft): void {
  for (const key of Object.keys(draft)) {
    if (!RECORD_KEYS.has(key)) {
      throw webChatError("UNSUPPORTED_OPTION", `WebChat conversation records have no "${key}" field`);
    }
  }
}

/** Validate a proposed next state and commit it with store-owned revision and timestamps. */
export function commitWebChatConversationDraft(
  identity: WebChatConversationIdentity,
  previous: WebChatConversationRecord | undefined,
  draft: WebChatConversationDraft,
  now: number,
): WebChatConversationRecord {
  assertNoWebChatSecrets(draft);
  assertKnownRecordKeys(draft);
  if (draft.identity.providerId !== identity.providerId
    || draft.identity.bindingId !== identity.bindingId
    || draft.identity.key !== identity.key) {
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      "A conversation record may not change its own affinity identity",
    );
  }
  if (!Number.isSafeInteger(draft.generation) || draft.generation < 1) {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "A conversation generation must be a positive safe integer");
  }
  if (previous && draft.generation < previous.generation) {
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      `Conversation generation cannot move backwards (${previous.generation} -> ${draft.generation})`,
    );
  }
  if (!CONVERSATION_STATUSES.includes(draft.status)) {
    throw webChatError("CONVERSATION_STATE_MISMATCH", `Unknown conversation status "${String(draft.status)}"`);
  }
  if (draft.checkpoint !== "confirmed" && draft.checkpoint !== "unconfirmed") {
    throw webChatError("CONVERSATION_STATE_MISMATCH", `Unknown checkpoint state "${String(draft.checkpoint)}"`);
  }
  if (draft.initialization && draft.initialization.generation !== draft.generation) {
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      "Initialization state belongs to the generation it was installed in",
    );
  }
  return {
    ...draft,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Validate one record read back from durable storage.
 *
 * A backend must refuse a record it cannot vouch for — a tampered or corrupted entry is an explicit
 * failure, never a silently trusted conversation.
 *
 * @param value - the value read from storage.
 * @returns the validated record.
 * @throws {WebChatError} `CONVERSATION_STATE_MISMATCH` when the shape is not a conversation record.
 */
export function validateWebChatConversationRecord(value: unknown): WebChatConversationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "Stored conversation state is not a record");
  }
  const candidate = value as Partial<WebChatConversationRecord>;
  const identity = candidate.identity;
  if (!identity || typeof identity.providerId !== "string" || typeof identity.bindingId !== "string" || typeof identity.key !== "string") {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "Stored conversation state has no affinity identity");
  }
  assertNoWebChatSecrets(candidate);
  assertKnownRecordKeys(candidate as WebChatConversationDraft);
  const revalidated = commitWebChatConversationDraft(identity, undefined, {
    identity,
    generation: candidate.generation as number,
    status: candidate.status as WebChatConversationStatus,
    checkpoint: candidate.checkpoint as "confirmed" | "unconfirmed",
    ...(candidate.handle !== undefined ? { handle: candidate.handle } : {}),
    ...(candidate.initialization !== undefined ? { initialization: candidate.initialization } : {}),
    ...(candidate.lastConfirmedTurn !== undefined ? { lastConfirmedTurn: candidate.lastConfirmedTurn } : {}),
  }, candidate.updatedAt ?? candidate.createdAt ?? 0);
  if (typeof candidate.revision !== "number" || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "Stored conversation state has no usable revision");
  }
  if (typeof candidate.createdAt !== "number" || typeof candidate.updatedAt !== "number") {
    throw webChatError("CONVERSATION_STATE_MISMATCH", "Stored conversation state has no timestamps");
  }
  return {
    ...revalidated,
    revision: candidate.revision,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

/**
 * Refuse a generation that is no longer current.
 *
 * @throws {WebChatError} `CONVERSATION_STATE_MISMATCH` when the record has moved on.
 */
export function assertCurrentWebChatGeneration(
  record: WebChatConversationRecord,
  generation: number,
): void {
  if (record.generation !== generation) {
    throw webChatError(
      "CONVERSATION_STATE_MISMATCH",
      `Conversation generation ${generation} is stale; the current generation is ${record.generation}`,
    );
  }
}

/**
 * Whether the initialization state installed in a conversation is current for exactly this
 * generation. A fingerprint recorded for another generation is never current.
 */
export function isWebChatInitializationCurrent(
  record: WebChatConversationRecord,
  generation: number,
  fingerprint: string,
): boolean {
  const initialization = record.initialization;
  if (!initialization) return false;
  return initialization.generation === generation && initialization.fingerprint === fingerprint;
}

/**
 * In-memory store.
 *
 * Holds the same invariants as the durable backend, and is what a runtime with no configured
 * backend uses. It keeps continuity for the lifetime of the process only.
 */
export function createMemoryConversationStore(
  options: WebChatConversationStoreOptions = {},
): WebChatConversationStore {
  const now = options.now ?? (() => Date.now());
  const records = new Map<string, WebChatConversationRecord>();
  const inFlight = new Map<string, Promise<WebChatConversationRecord>>();
  const id = (identity: WebChatConversationIdentity): string =>
    `${identity.providerId}\u0000${identity.bindingId}\u0000${identity.key}`;

  return {
    async read(identity) {
      return records.get(id(identity));
    },
    async list() {
      return [...records.values()];
    },
    async update(identity, mutate) {
      const key = id(identity);
      // Serialize per affinity: a concurrent update waits for the previous one instead of
      // overwriting its result.
      const previousRun = inFlight.get(key);
      const run = (async () => {
        if (previousRun) await previousRun.catch(() => undefined);
        const committed = commitWebChatConversationDraft(identity, records.get(key), mutate(records.get(key)), now());
        records.set(key, committed);
        return committed;
      })();
      inFlight.set(key, run);
      try {
        return await run;
      } finally {
        if (inFlight.get(key) === run) inFlight.delete(key);
      }
    },
    async forget(identity) {
      return records.delete(id(identity));
    },
  };
}
