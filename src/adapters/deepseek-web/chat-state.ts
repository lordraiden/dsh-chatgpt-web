/**
 * DeepSeek Web conversation continuity state.
 *
 * ## What this owns
 *
 * The core's durable conversation store records *which provider conversation belongs to which
 * affinity*, its generation and an **opaque** handle; it never interprets provider state
 * (`src/web-chat/core/conversation-store.ts`, AGENTS.md → *Provider conversation is opaque*). What
 * DeepSeek needs to continue a turn is provider-private and is exactly the pair the recorded body
 * uses (recon §2.3):
 *
 * - `chat_session_id` — the session `chat_session/create` returned;
 * - `parent_message_id` — the assistant message the previous turn ended on, i.e. the cursor the next
 *   turn hangs off. `ready.response_message_id` is where it comes from (recon §2.4).
 *
 * Both are continuity state only: never a transcript, never a credential.
 *
 * ## Why it is durable
 *
 * The session lives server-side and survives this process; only the mapping from the caller's affinity
 * to that id and cursor is ours. AGENTS.md → *Durable continuity* requires that mapping to survive a
 * runtime restart, so it is written atomically (mode 0600) inside this provider's own directory. A
 * deployment with no writable home keeps it in memory and then declares `explicit_replay` (see
 * `provider-runtime.ts`), because an in-memory mapping cannot honestly claim exact resume.
 *
 * ## Failure posture
 *
 * A missing or unreadable file is **not** a fresh conversation: the driver reports
 * `replay_required`, which makes the core refuse an implicit continuation and requires an explicit
 * replay. A rejected session is recorded as `lost` so no later turn silently continues it — the whole
 * point of "*no silent fork*".
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";

/** One provider chat session this deployment created for an affinity. */
export interface DeepSeekSessionRecord {
  /** The id `chat_session/create` returned (or the id an ephemeral turn streamed into). */
  readonly chatSessionId: string;
  /**
   * The cursor the next turn sends as `parent_message_id`.
   *
   * This is the previous answer's assistant message id: `ready.response_message_id`, falling back to
   * the `update_parent_message` payload only when the stream never announced one.
   */
  readonly parentMessageId?: string;
  /** The response message id of the last settled turn, when the stream reported one. */
  readonly responseMessageId?: string;
  /** The `model_type` the provider said answered (`ready.model_type`), for diagnosis. */
  readonly modelType?: string;
  /** `active` continues the session; `lost` means the provider no longer accepts it. */
  readonly status: "active" | "lost";
  /** Why the session is lost, for diagnostics. Never a secret. */
  readonly reason?: string;
  readonly updatedAt: number;
}

/** The state this provider keeps per affinity key. */
export interface DeepSeekConversationEntry {
  /** The provider's own epoch counter; the core records the same number the driver handed it. */
  readonly generation: number;
  readonly session?: DeepSeekSessionRecord;
}

/** The continuity state port. All operations are synchronous: the payload is a few hundred bytes. */
export interface DeepSeekConversationState {
  /** The entry recorded for an affinity, or `undefined` when this provider never saw it. */
  read(key: string): DeepSeekConversationEntry | undefined;
  /** The epoch to hand the core: the recorded one, or `1` for a key this provider never saw. */
  generation(key: string): number;
  /** Record the epoch the core accepted for this key (never moves backwards). */
  beginGeneration(key: string, generation: number): void;
  /** Record (or refresh) the session and cursor of an affinity. */
  recordSession(
    key: string,
    session: Omit<DeepSeekSessionRecord, "updatedAt"> & { readonly updatedAt?: number },
  ): void;
  /** Record that the provider no longer accepts the session. The entry is kept, never dropped. */
  markLost(key: string, reason: string): void;
  /** Abandon the session of an affinity without inventing a replacement (an explicit replay does this). */
  forgetSession(key: string): void;
  /** Every entry, for diagnostics. No secrets: affinity keys and opaque session ids only. */
  entries(): readonly { readonly key: string; readonly generation: number; readonly session?: DeepSeekSessionRecord }[];
  /** Release the file, when this state owns one. Idempotent. */
  close?(): void;
}

/** The on-disk shape. `version` is the contract: an unknown version is never guessed. */
interface DeepSeekStateFile {
  version: 1;
  conversations: Record<string, { generation: number; session?: DeepSeekSessionRecord }>;
}

const STATE_FILE_VERSION = 1;

/** Whether a value is a positive safe integer. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read one persisted session record, refusing anything this module does not understand.
 *
 * A malformed record is dropped, which makes the affinity look like "no session recorded" — a state
 * the driver reports as `replay_required`, never as a fresh session.
 */
function parseSession(value: unknown): DeepSeekSessionRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const chatSessionId = record["chatSessionId"];
  if (typeof chatSessionId !== "string" || chatSessionId.length === 0) return undefined;
  const status = record["status"] === "lost" ? "lost" : record["status"] === "active" ? "active" : undefined;
  if (status === undefined) return undefined;
  const parentMessageId = typeof record["parentMessageId"] === "string" && record["parentMessageId"].length > 0
    ? record["parentMessageId"]
    : undefined;
  const responseMessageId = typeof record["responseMessageId"] === "string" && record["responseMessageId"].length > 0
    ? record["responseMessageId"]
    : undefined;
  const modelType = typeof record["modelType"] === "string" && record["modelType"].length > 0
    ? record["modelType"]
    : undefined;
  const reason = typeof record["reason"] === "string" ? record["reason"] : undefined;
  const updatedAt = record["updatedAt"];
  return {
    chatSessionId,
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    ...(responseMessageId === undefined ? {} : { responseMessageId }),
    ...(modelType === undefined ? {} : { modelType }),
    status,
    ...(reason === undefined ? {} : { reason }),
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

/** Parse the whole file, or answer `undefined` when it is not this module's format. */
function parseStateFile(raw: unknown): DeepSeekStateFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== STATE_FILE_VERSION) return undefined;
  const conversations = record["conversations"];
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) return undefined;
  const parsed: Record<string, { generation: number; session?: DeepSeekSessionRecord }> = {};
  for (const [key, value] of Object.entries(conversations)) {
    if (key.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const generation = entry["generation"];
    if (!positiveInteger(generation)) continue;
    const session = parseSession(entry["session"]);
    parsed[key] = { generation, ...(session ? { session } : {}) };
  }
  return { version: STATE_FILE_VERSION, conversations: parsed };
}

/** A shared in-memory implementation, and the durable one's base. */
class DeepSeekConversationStore implements DeepSeekConversationState {
  protected readonly conversations: Map<string, { generation: number; session?: DeepSeekSessionRecord }>;
  protected readonly now: () => number;

  constructor(initial: Record<string, { generation: number; session?: DeepSeekSessionRecord }>, options: { now?: () => number }) {
    this.conversations = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
    this.now = options.now ?? Date.now;
  }

  /** The hook a durable implementation uses; the in-memory one persists nothing. */
  protected persist(): void {}

  read(key: string): DeepSeekConversationEntry | undefined {
    const entry = this.conversations.get(key);
    if (!entry) return undefined;
    return { generation: entry.generation, ...(entry.session ? { session: entry.session } : {}) };
  }

  generation(key: string): number {
    return this.conversations.get(key)?.generation ?? 1;
  }

  beginGeneration(key: string, generation: number): void {
    if (!positiveInteger(generation)) {
      throw new TypeError("A DeepSeek conversation generation must be a positive safe integer");
    }
    const entry = this.conversations.get(key);
    if (entry === undefined) {
      this.conversations.set(key, { generation });
      this.persist();
      return;
    }
    if (generation < entry.generation) {
      throw new Error("A DeepSeek conversation generation cannot move backwards");
    }
    if (generation === entry.generation) return;
    // A new epoch abandons the previous session: the next turn of this affinity must create a new one
    // instead of continuing the conversation the caller explicitly replaced.
    this.conversations.set(key, { generation });
    this.persist();
  }

  recordSession(
    key: string,
    session: Omit<DeepSeekSessionRecord, "updatedAt"> & { readonly updatedAt?: number },
  ): void {
    if (typeof session.chatSessionId !== "string" || session.chatSessionId.length === 0) {
      throw new TypeError("A DeepSeek session record requires a non-empty chat session id");
    }
    const existing = this.conversations.get(key);
    const generation = existing?.generation ?? 1;
    this.conversations.set(key, {
      generation,
      session: {
        chatSessionId: session.chatSessionId,
        ...(session.parentMessageId !== undefined && session.parentMessageId.length > 0
          ? { parentMessageId: session.parentMessageId }
          : {}),
        ...(session.responseMessageId !== undefined && session.responseMessageId.length > 0
          ? { responseMessageId: session.responseMessageId }
          : {}),
        ...(session.modelType !== undefined && session.modelType.length > 0 ? { modelType: session.modelType } : {}),
        status: session.status,
        ...(session.reason !== undefined ? { reason: session.reason } : {}),
        updatedAt: session.updatedAt ?? this.now(),
      },
    });
    this.persist();
  }

  markLost(key: string, reason: string): void {
    const existing = this.conversations.get(key);
    if (!existing?.session) return;
    this.conversations.set(key, {
      generation: existing.generation,
      session: { ...existing.session, status: "lost", reason, updatedAt: this.now() },
    });
    this.persist();
  }

  forgetSession(key: string): void {
    const existing = this.conversations.get(key);
    if (!existing?.session) return;
    this.conversations.set(key, { generation: existing.generation });
    this.persist();
  }

  entries(): readonly { readonly key: string; readonly generation: number; readonly session?: DeepSeekSessionRecord }[] {
    return [...this.conversations.entries()].map(([key, entry]) => ({
      key,
      generation: entry.generation,
      ...(entry.session ? { session: entry.session } : {}),
    }));
  }
}

/** Options shared by both backends. */
export interface DeepSeekConversationStateOptions {
  /** Clock seam. */
  readonly now?: () => number;
}

/**
 * A durable backend: one JSON file, written atomically with mode 0600 on every mutation.
 *
 * The file holds affinity keys, opaque session ids and cursors — continuity state, never a transcript
 * or a credential. A file that cannot be read, or is not this format, is reported once (sanitized) and
 * treated as "nothing recorded", which fails closed into an explicit replay rather than a new session.
 */
export function createFileDeepSeekConversationState(
  file: string,
  options: DeepSeekConversationStateOptions = {},
): DeepSeekConversationState {
  let initial: Record<string, { generation: number; session?: DeepSeekSessionRecord }> = {};
  if (existsSync(file)) {
    try {
      const parsed = parseStateFile(JSON.parse(readFileSync(file, "utf8")));
      if (parsed === undefined) {
        console.warn(
          `[deepseek-web] conversation state file has an unknown shape and is ignored ${JSON.stringify({ reason: "unknown-shape" })}`,
        );
      } else {
        initial = parsed.conversations;
      }
    } catch (error) {
      console.warn(
        `[deepseek-web] conversation state file is unreadable and is ignored ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
      );
    }
  }

  class FileState extends DeepSeekConversationStore {
    constructor() {
      super(initial, options);
    }

    protected override persist(): void {
      const payload: DeepSeekStateFile = {
        version: STATE_FILE_VERSION,
        conversations: Object.fromEntries(this.conversations.entries()),
      };
      const directory = dirname(file);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Write-then-rename: a crash can never leave a half-written continuity file behind, and a
      // partial file can never be mistaken for a recorded conversation.
      const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    }
  }

  return new FileState();
}

/** An in-memory backend, for a deployment with no durable home and for tests. */
export function createMemoryDeepSeekConversationState(
  options: DeepSeekConversationStateOptions = {},
): DeepSeekConversationState {
  return new DeepSeekConversationStore({}, options);
}
