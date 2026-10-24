/**
 * Qwen Chat conversation continuity state.
 *
 * ## What this owns
 *
 * The core's durable conversation store records *which provider conversation belongs to which
 * affinity*, its generation and an **opaque** handle; it never interprets provider state
 * (`src/web-chat/core/conversation-store.ts`, AGENTS.md → *Provider conversation is opaque*). What
 * Qwen Chat needs to continue a turn is provider-private: the chat id `chats/new` returned and the
 * **parent/response cursor** the previous turn ended on (recon §1.3–§1.4). Both are this module's,
 * keyed by the core's affinity key, and they are continuity state only — never a transcript, never a
 * credential.
 *
 * It also records one **install fact**: whether the conversation has already sent its first human
 * message ({@link QwenChatConversationEntry.humanMessageSent}). The deterministic project header
 * belongs to that first human turn, and deciding it from this recorded fact — instead of from "does a
 * provider chat exist" — is what keeps a provider chat created by something other than the caller's
 * human turn from consuming the install.
 *
 * ## Why it is durable
 *
 * The chat lives server-side and survives this process; only the mapping from the caller's affinity
 * to that chat id and cursor is ours. AGENTS.md → *Durable continuity* requires that mapping to
 * survive a runtime restart, so it is written atomically (mode 0600) inside this provider's own
 * directory. A deployment with no writable home keeps it in memory and then declares
 * `explicit_replay` (see `provider-runtime.ts`), because an in-memory mapping cannot honestly claim
 * exact resume.
 *
 * ## Failure posture
 *
 * A missing or unreadable file is **not** a fresh conversation: `assessConversation` reports
 * `replay_required`, which makes the core refuse an implicit continuation and requires an explicit
 * replay. A lost or rejected chat is recorded as `lost` so no later turn silently continues it — the
 * whole point of "*no silent fork*".
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";

/** One provider chat this deployment created for an affinity. */
export interface QwenChatChatRecord {
  /** The chat id `chats/new` returned (or the id an ephemeral turn streamed into). */
  readonly chatId: string;
  /**
   * The cursor the next turn hangs off.
   *
   * The completion stream's `response_id` is the assistant message id, i.e. exactly the
   * `parentId`/`parent_id` a continuation sends; `response.created.parent_id` is the *request's*
   * parent and is kept only when the stream never reported a response id.
   */
  readonly parentId?: string;
  /** The response id of the last settled turn, when the stream reported one. */
  readonly responseId?: string;
  /** The response index the stream announced, when it did. Opaque continuity data. */
  readonly responseIndex?: number;
  /** `active` continues the chat; `lost` means the provider no longer accepts it. */
  readonly status: "active" | "lost";
  /** Why the chat is lost, for diagnostics. Never a secret. */
  readonly reason?: string;
  readonly updatedAt: number;
}

/** The state this provider keeps per affinity key. */
export interface QwenChatConversationEntry {
  /** The provider's own epoch counter; the core records the same number the driver handed it. */
  readonly generation: number;
  readonly chat?: QwenChatChatRecord;
  /**
   * Whether this conversation has already sent its **first human message**.
   *
   * This is the recorded fact the conversation's install decision reads. The deterministic project
   * header belongs to the first turn of a conversation that carries a human message, and it is decided
   * from what this deployment recorded — **never** from whether a provider chat exists, because a
   * provider chat can be created by something that is not the caller's human turn (a non-installing
   * seam, or a housekeeping call the caller failed to declare). It survives a generation change: an
   * explicit replay rebuilds canonical history and must not re-inject the header afterwards.
   */
  readonly humanMessageSent: boolean;
}

/** The continuity state port. All operations are synchronous: the payload is a few hundred bytes. */
export interface QwenChatConversationState {
  /** The entry recorded for an affinity, or `undefined` when this provider never saw it. */
  read(key: string): QwenChatConversationEntry | undefined;
  /** The epoch to hand the core: the recorded one, or `1` for a key this provider never saw. */
  generation(key: string): number;
  /** Record the epoch the core accepted for this key (never moves backwards). */
  beginGeneration(key: string, generation: number): void;
  /** Record (or refresh) the chat and cursor of an affinity. */
  recordChat(key: string, chat: Omit<QwenChatChatRecord, "updatedAt"> & { readonly updatedAt?: number }): void;
  /**
   * Record that this conversation has sent its first human message.
   *
   * Once set it is never cleared: the install is initialization metadata of the conversation's first
   * physical message, so a later turn of the same conversation (or of a replay of it) must not send it
   * again. Idempotent.
   */
  recordHumanMessage(key: string): void;
  /** Record that the provider no longer accepts the chat. The entry is kept, never silently dropped. */
  markLost(key: string, reason: string): void;
  /** Abandon the chat of an affinity without inventing a replacement (an explicit replay does this). */
  forgetChat(key: string): void;
  /** Every entry, for diagnostics. No secrets: affinity keys and opaque chat ids only. */
  entries(): readonly {
    readonly key: string;
    readonly generation: number;
    readonly humanMessageSent: boolean;
    readonly chat?: QwenChatChatRecord;
  }[];
  /** Release the file, when this state owns one. Idempotent. */
  close?(): void;
}

/** The on-disk shape. `version` is the contract: an unknown version is never guessed. */
interface QwenChatStateFile {
  version: 1;
  /**
   * `humanMessageSent` is always written now; a file written before it existed lacks it, and the
   * reader adopts that case (see {@link parseStateFile}).
   */
  conversations: Record<string, StoredEntry>;
}

/** One entry as this module keeps it in memory. */
interface StoredEntry {
  generation: number;
  chat?: QwenChatChatRecord;
  humanMessageSent: boolean;
}

const STATE_FILE_VERSION = 1;

/** Whether a value is a positive safe integer. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read one persisted chat record, refusing anything this module does not understand.
 *
 * A malformed record is dropped, which makes the affinity look like "no chat recorded" — a state the
 * driver reports as `replay_required`, never as a fresh chat.
 */
function parseChat(value: unknown): QwenChatChatRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const chatId = record["chatId"];
  if (typeof chatId !== "string" || chatId.length === 0) return undefined;
  const status = record["status"] === "lost" ? "lost" : record["status"] === "active" ? "active" : undefined;
  if (status === undefined) return undefined;
  const parentId = typeof record["parentId"] === "string" && record["parentId"].length > 0 ? record["parentId"] : undefined;
  const responseId = typeof record["responseId"] === "string" && record["responseId"].length > 0
    ? record["responseId"]
    : undefined;
  const responseIndex = typeof record["responseIndex"] === "number" && Number.isSafeInteger(record["responseIndex"])
    ? record["responseIndex"]
    : undefined;
  const reason = typeof record["reason"] === "string" ? record["reason"] : undefined;
  const updatedAt = record["updatedAt"];
  return {
    chatId,
    ...(parentId === undefined ? {} : { parentId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(responseIndex === undefined ? {} : { responseIndex }),
    status,
    ...(reason === undefined ? {} : { reason }),
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

/** Parse the whole file, or answer `undefined` when it is not this module's format. */
function parseStateFile(raw: unknown): QwenChatStateFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== STATE_FILE_VERSION) return undefined;
  const conversations = record["conversations"];
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) return undefined;
  const parsed: Record<string, StoredEntry> = {};
  for (const [key, value] of Object.entries(conversations)) {
    if (key.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const generation = entry["generation"];
    if (!positiveInteger(generation)) continue;
    const chat = parseChat(entry["chat"]);
    // A file written before this fact existed records a chat but no flag. Such a conversation has
    // already had its first physical message (that is what a recorded chat means), so it is adopted as
    // "human message sent": the fail-safe direction, because re-installing the header into a live
    // conversation would duplicate it. An **explicit** `false` beside a chat is a chat created by a
    // non-installing seam in this format, and it keeps the install available.
    const recorded = entry["humanMessageSent"];
    const humanMessageSent = recorded === true || (recorded === undefined && chat !== undefined);
    parsed[key] = { generation, humanMessageSent, ...(chat ? { chat } : {}) };
  }
  return { version: STATE_FILE_VERSION, conversations: parsed };
}

/** A shared in-memory implementation, and the durable one's base. */
class QwenChatConversationStore implements QwenChatConversationState {
  protected readonly conversations: Map<string, StoredEntry>;
  protected readonly now: () => number;

  constructor(initial: Record<string, StoredEntry>, options: { now?: () => number }) {
    this.conversations = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
    this.now = options.now ?? Date.now;
  }

  /** The hook a durable implementation uses; the in-memory one persists nothing. */
  protected persist(): void {}

  read(key: string): QwenChatConversationEntry | undefined {
    const entry = this.conversations.get(key);
    if (!entry) return undefined;
    return {
      generation: entry.generation,
      humanMessageSent: entry.humanMessageSent,
      ...(entry.chat ? { chat: entry.chat } : {}),
    };
  }

  generation(key: string): number {
    return this.conversations.get(key)?.generation ?? 1;
  }

  beginGeneration(key: string, generation: number): void {
    if (!positiveInteger(generation)) {
      throw new TypeError("A Qwen Chat conversation generation must be a positive safe integer");
    }
    const entry = this.conversations.get(key);
    if (entry === undefined) {
      this.conversations.set(key, { generation, humanMessageSent: false });
      this.persist();
      return;
    }
    if (generation < entry.generation) {
      throw new Error("A Qwen Chat conversation generation cannot move backwards");
    }
    if (generation === entry.generation) return;
    // A new epoch abandons the previous chat: the next turn of this affinity must create a new one
    // instead of continuing the conversation the caller explicitly replaced. The recorded install
    // fact survives, because a replay rebuilds canonical history rather than reintroducing the
    // conversation.
    this.conversations.set(key, { generation, humanMessageSent: entry.humanMessageSent });
    this.persist();
  }

  recordChat(key: string, chat: Omit<QwenChatChatRecord, "updatedAt"> & { readonly updatedAt?: number }): void {
    if (typeof chat.chatId !== "string" || chat.chatId.length === 0) {
      throw new TypeError("A Qwen Chat chat record requires a non-empty chat id");
    }
    const existing = this.conversations.get(key);
    const generation = existing?.generation ?? 1;
    this.conversations.set(key, {
      generation,
      humanMessageSent: existing?.humanMessageSent ?? false,
      chat: {
        chatId: chat.chatId,
        ...(chat.parentId !== undefined && chat.parentId.length > 0 ? { parentId: chat.parentId } : {}),
        ...(chat.responseId !== undefined && chat.responseId.length > 0 ? { responseId: chat.responseId } : {}),
        ...(chat.responseIndex !== undefined ? { responseIndex: chat.responseIndex } : {}),
        status: chat.status,
        ...(chat.reason !== undefined ? { reason: chat.reason } : {}),
        updatedAt: chat.updatedAt ?? this.now(),
      },
    });
    this.persist();
  }

  recordHumanMessage(key: string): void {
    const existing = this.conversations.get(key);
    if (existing?.humanMessageSent === true) return;
    this.conversations.set(key, {
      generation: existing?.generation ?? 1,
      humanMessageSent: true,
      ...(existing?.chat ? { chat: existing.chat } : {}),
    });
    this.persist();
  }

  markLost(key: string, reason: string): void {
    const existing = this.conversations.get(key);
    if (!existing?.chat) return;
    this.conversations.set(key, {
      generation: existing.generation,
      humanMessageSent: existing.humanMessageSent,
      chat: { ...existing.chat, status: "lost", reason, updatedAt: this.now() },
    });
    this.persist();
  }

  forgetChat(key: string): void {
    const existing = this.conversations.get(key);
    if (!existing?.chat) return;
    this.conversations.set(key, {
      generation: existing.generation,
      humanMessageSent: existing.humanMessageSent,
    });
    this.persist();
  }

  entries(): readonly {
    readonly key: string;
    readonly generation: number;
    readonly humanMessageSent: boolean;
    readonly chat?: QwenChatChatRecord;
  }[] {
    return [...this.conversations.entries()].map(([key, entry]) => ({
      key,
      generation: entry.generation,
      humanMessageSent: entry.humanMessageSent,
      ...(entry.chat ? { chat: entry.chat } : {}),
    }));
  }
}

/** Options shared by both backends. */
export interface QwenChatConversationStateOptions {
  /** Clock seam. */
  readonly now?: () => number;
}

/**
 * A durable backend: one JSON file, written atomically with mode 0600 on every mutation.
 *
 * The file holds affinity keys, opaque chat ids and cursors — continuity state, never a transcript
 * or a credential. A file that cannot be read, or is not this format, is reported once (sanitized)
 * and treated as "nothing recorded", which fails closed into an explicit replay rather than a new
 * chat.
 */
export function createFileQwenChatConversationState(
  file: string,
  options: QwenChatConversationStateOptions = {},
): QwenChatConversationState {
  let initial: Record<string, StoredEntry> = {};
  if (existsSync(file)) {
    try {
      const parsed = parseStateFile(JSON.parse(readFileSync(file, "utf8")));
      if (parsed === undefined) {
        console.warn(
          `[qwen-chat] conversation state file has an unknown shape and is ignored ${JSON.stringify({ reason: "unknown-shape" })}`,
        );
      } else {
        initial = parsed.conversations;
      }
    } catch (error) {
      console.warn(
        `[qwen-chat] conversation state file is unreadable and is ignored ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
      );
    }
  }

  class FileState extends QwenChatConversationStore {
    constructor() {
      super(initial, options);
    }

    protected override persist(): void {
      const payload: QwenChatStateFile = {
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
export function createMemoryQwenChatConversationState(
  options: QwenChatConversationStateOptions = {},
): QwenChatConversationState {
  return new QwenChatConversationStore({}, options);
}
