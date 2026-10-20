/**
 * Qwen Code conversation continuity state (issue #299, slice 2).
 *
 * ## What this owns, and why it is not the core's store
 *
 * The core's durable conversation store records *which provider conversation belongs to which
 * affinity*, its generation and an **opaque** handle; it never interprets provider state
 * (`src/web-chat/core/conversation-store.ts`, AGENTS.md → *Provider conversation is opaque*). What
 * Qwen needs in order to continue a chat is provider-private: the chat id `task/new` returned, and
 * the parent cursor the last turn ended on. Those facts are this module's, keyed by the core's
 * affinity key, and they are **continuity state only** — never a transcript, never a credential.
 *
 * ## Why it is durable
 *
 * The provider's conversation lives server-side and survives this process; only the mapping from the
 * caller's affinity to that chat id is ours. AGENTS.md → *Durable continuity* requires exactly that
 * mapping to survive a runtime restart, so it is written atomically (mode 0600) next to the verified
 * session, inside this provider's own directory. A deployment with no writable home keeps the state
 * in memory and then declares `explicit_replay` (see `provider-runtime.ts`), because an in-memory
 * mapping cannot honestly claim exact resume.
 *
 * ## Failure posture
 *
 * A missing or unreadable file is **not** a fresh conversation: `assessConversation` reports
 * `replay_required`, which makes the core refuse an implicit continuation and requires an explicit
 * replay. A lost or rejected chat is recorded as `lost` so the next turn cannot silently continue the
 * abandoned conversation — the whole point of "*no silent fork*".
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { nonSecretDiagnosticText } from "../../lib/safe-diagnostics";

/** One provider chat this deployment created for an affinity. */
export interface QwenCodeChatRecord {
  /** The chat id `task/new` returned (or the id an ephemeral turn streamed into). */
  readonly chatId: string;
  /**
   * The parent cursor of the last settled turn, when the stream reported one.
   *
   * The recorded app sends `parentId`/`parent_id` and links its next message to the previous one, so
   * a continuation uses the cursor the previous turn ended on instead of pretending every turn is the
   * first of the chat.
   */
  readonly parentId?: string;
  /** `active` continues the chat; `lost` means the provider no longer accepts it. */
  readonly status: "active" | "lost";
  /** Why the chat is lost, for diagnostics. Never a secret. */
  readonly reason?: string;
  readonly updatedAt: number;
}

/** The state this provider keeps per affinity key. */
export interface QwenCodeConversationEntry {
  /** The provider's own epoch counter; the core records the same number the driver handed it. */
  readonly generation: number;
  readonly chat?: QwenCodeChatRecord;
}

/** The continuity state port. All operations are synchronous: the payload is a few hundred bytes. */
export interface QwenCodeConversationState {
  /** The entry recorded for an affinity, or `undefined` when this provider never saw it. */
  read(key: string): QwenCodeConversationEntry | undefined;
  /** The epoch to hand the core: the recorded one, or `1` for a key this provider never saw. */
  generation(key: string): number;
  /** Record the epoch the core accepted for this key (never moves backwards). */
  beginGeneration(key: string, generation: number): void;
  /** Record (or refresh) the chat of an affinity. */
  recordChat(key: string, chat: Omit<QwenCodeChatRecord, "updatedAt"> & { readonly updatedAt?: number }): void;
  /** Record that the provider no longer accepts the chat. The entry is kept, never silently dropped. */
  markLost(key: string, reason: string): void;
  /** Abandon the chat of an affinity without inventing a replacement (an explicit replay does this). */
  forgetChat(key: string): void;
  /** Every entry, for diagnostics. No secrets: affinity keys and opaque chat ids only. */
  entries(): readonly { readonly key: string; readonly generation: number; readonly chat?: QwenCodeChatRecord }[];
  /** Release the file, when this state owns one. Idempotent. */
  close?(): void;
}

/** The on-disk shape. `version` is the contract: an unknown version is never guessed. */
interface QwenCodeStateFile {
  version: 1;
  conversations: Record<string, { generation: number; chat?: QwenCodeChatRecord }>;
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
function parseChat(value: unknown): QwenCodeChatRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const chatId = record["chatId"];
  if (typeof chatId !== "string" || chatId.length === 0) return undefined;
  const parentId = record["parentId"];
  const status = record["status"] === "lost" ? "lost" : record["status"] === "active" ? "active" : undefined;
  if (status === undefined) return undefined;
  const reason = typeof record["reason"] === "string" ? record["reason"] : undefined;
  const updatedAt = record["updatedAt"];
  return {
    chatId,
    ...(typeof parentId === "string" && parentId.length > 0 ? { parentId } : {}),
    status,
    ...(reason !== undefined ? { reason } : {}),
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

/** Parse the whole file, or answer `undefined` when it is not this module's format. */
function parseStateFile(raw: unknown): QwenCodeStateFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== STATE_FILE_VERSION) return undefined;
  const conversations = record["conversations"];
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) return undefined;
  const parsed: Record<string, { generation: number; chat?: QwenCodeChatRecord }> = {};
  for (const [key, value] of Object.entries(conversations)) {
    if (key.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const generation = entry["generation"];
    if (!positiveInteger(generation)) continue;
    const chat = parseChat(entry["chat"]);
    parsed[key] = { generation, ...(chat ? { chat } : {}) };
  }
  return { version: STATE_FILE_VERSION, conversations: parsed };
}

/** A shared in-memory implementation, and the durable one's base. */
class QwenCodeConversationStore implements QwenCodeConversationState {
  protected readonly conversations: Map<string, { generation: number; chat?: QwenCodeChatRecord }>;
  protected readonly now: () => number;

  constructor(initial: Record<string, { generation: number; chat?: QwenCodeChatRecord }>, options: { now?: () => number }) {
    this.conversations = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
    this.now = options.now ?? Date.now;
  }

  /** The hook a durable implementation uses; the in-memory one persists nothing. */
  protected persist(): void {}

  read(key: string): QwenCodeConversationEntry | undefined {
    const entry = this.conversations.get(key);
    if (!entry) return undefined;
    return { generation: entry.generation, ...(entry.chat ? { chat: entry.chat } : {}) };
  }

  generation(key: string): number {
    return this.conversations.get(key)?.generation ?? 1;
  }

  beginGeneration(key: string, generation: number): void {
    if (!positiveInteger(generation)) {
      throw new TypeError("A Qwen Code conversation generation must be a positive safe integer");
    }
    const entry = this.conversations.get(key);
    if (entry === undefined) {
      this.conversations.set(key, { generation });
      this.persist();
      return;
    }
    if (generation < entry.generation) {
      throw new Error("A Qwen Code conversation generation cannot move backwards");
    }
    if (generation === entry.generation) return;
    // A new epoch abandons the previous chat: the next turn of this affinity must create a new one
    // instead of continuing the conversation the caller explicitly replaced.
    this.conversations.set(key, { generation });
    this.persist();
  }

  recordChat(key: string, chat: Omit<QwenCodeChatRecord, "updatedAt"> & { readonly updatedAt?: number }): void {
    if (typeof chat.chatId !== "string" || chat.chatId.length === 0) {
      throw new TypeError("A Qwen Code chat record requires a non-empty chat id");
    }
    const existing = this.conversations.get(key);
    const generation = existing?.generation ?? 1;
    this.conversations.set(key, {
      generation,
      chat: {
        chatId: chat.chatId,
        ...(chat.parentId !== undefined && chat.parentId.length > 0 ? { parentId: chat.parentId } : {}),
        status: chat.status,
        ...(chat.reason !== undefined ? { reason: chat.reason } : {}),
        updatedAt: chat.updatedAt ?? this.now(),
      },
    });
    this.persist();
  }

  markLost(key: string, reason: string): void {
    const existing = this.conversations.get(key);
    if (!existing?.chat) return;
    this.conversations.set(key, {
      generation: existing.generation,
      chat: {
        chatId: existing.chat.chatId,
        ...(existing.chat.parentId !== undefined ? { parentId: existing.chat.parentId } : {}),
        status: "lost",
        reason,
        updatedAt: this.now(),
      },
    });
    this.persist();
  }

  forgetChat(key: string): void {
    const existing = this.conversations.get(key);
    if (!existing?.chat) return;
    this.conversations.set(key, { generation: existing.generation });
    this.persist();
  }

  entries(): readonly { readonly key: string; readonly generation: number; readonly chat?: QwenCodeChatRecord }[] {
    return [...this.conversations.entries()].map(([key, entry]) => ({
      key,
      generation: entry.generation,
      ...(entry.chat ? { chat: entry.chat } : {}),
    }));
  }
}

/** Options shared by both backends. */
export interface QwenCodeConversationStateOptions {
  /** Clock seam. */
  readonly now?: () => number;
}

/**
 * A durable backend: one JSON file, written atomically with mode 0600 on every mutation.
 *
 * The file holds affinity keys and opaque chat ids — continuity state, never a transcript or a
 * credential. A file that cannot be read, or is not this format, is reported once (sanitized) and
 * treated as "nothing recorded", which fails closed into an explicit replay rather than a new chat.
 */
export function createFileQwenCodeConversationState(
  file: string,
  options: QwenCodeConversationStateOptions = {},
): QwenCodeConversationState {
  let initial: Record<string, { generation: number; chat?: QwenCodeChatRecord }> = {};
  if (existsSync(file)) {
    try {
      const parsed = parseStateFile(JSON.parse(readFileSync(file, "utf8")));
      if (parsed === undefined) {
        console.warn(
          `[qwen-code] conversation state file has an unknown shape and is ignored ${JSON.stringify({ reason: "unknown-shape" })}`,
        );
      } else {
        initial = parsed.conversations;
      }
    } catch (error) {
      console.warn(
        `[qwen-code] conversation state file is unreadable and is ignored ${JSON.stringify({ detail: nonSecretDiagnosticText(error) })}`,
      );
    }
  }

  class FileState extends QwenCodeConversationStore {
    constructor() {
      super(initial, options);
    }

    protected override persist(): void {
      const payload: QwenCodeStateFile = {
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
export function createMemoryQwenCodeConversationState(
  options: QwenCodeConversationStateOptions = {},
): QwenCodeConversationState {
  return new QwenCodeConversationStore({}, options);
}
