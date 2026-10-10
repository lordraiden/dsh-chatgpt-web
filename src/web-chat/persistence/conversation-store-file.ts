/**
 * Durable file backend for the WebChat conversation store (architecture §7.3).
 *
 * This is infrastructure, deliberately outside `src/web-chat/core`: the core owns the record, the
 * invariants and the port; this module owns bytes on disk. It reuses the plugin's existing atomic
 * write helper, so the durability machinery has one owner.
 *
 * Durability rules:
 *
 * - one JSON document `{ version, records }`, written by atomic replace (`atomicWriteFile`);
 * - **no in-memory cache**: every operation re-reads the file, so a second process or a restarted
 *   runtime observes the committed state, and no stale view can overwrite a newer record;
 * - a corrupt file, a document with an unknown `version`, an invalid record or one carrying
 *   authentication material is an explicit failure — never an empty store, because an empty store
 *   would silently turn a lost conversation into a new one;
 * - updates are serialized per store instance and per affinity.
 *
 * The provider handle is stored and returned verbatim: this module never parses it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import {
  commitWebChatConversationDraft,
  validateWebChatConversationRecord,
  type WebChatConversationDraft,
  type WebChatConversationIdentity,
  type WebChatConversationRecord,
  type WebChatConversationStore,
  type WebChatConversationStoreOptions,
} from "../core";

/** Schema version of the durable document. An unknown version is refused, never reinterpreted. */
export const WEB_CHAT_CONVERSATION_STORE_VERSION = 1;

/** The durable store could not be read or written as a conversation store. */
export class WebChatConversationStoreUnavailableError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string, options: { cause?: unknown } = {}) {
    super(`The WebChat conversation store at ${path} is unavailable: ${reason}`,
      options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WebChatConversationStoreUnavailableError";
    this.path = path;
    this.reason = reason;
  }
}

interface ConversationStoreDocument {
  version: number;
  records: WebChatConversationRecord[];
}

/** Where a deployment keeps its durable conversation continuity state. */
export function defaultWebChatConversationStorePath(): string {
  return join(getConfigDir(), "web-chat", "conversations.json");
}

/** The identity tuple a record is addressed by (never the provider handle). */
function identityKey(identity: WebChatConversationIdentity): string {
  return `${identity.providerId}\u0000${identity.bindingId}\u0000${identity.key}`;
}

/** Read and validate the whole document. */
function readDocument(file: string): ConversationStoreDocument {
  if (!existsSync(file)) return { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records: [] };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new WebChatConversationStoreUnavailableError(file, "it could not be read", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WebChatConversationStoreUnavailableError(file, "its contents are not valid JSON", { cause: error });
  }
  const document = parsed as Partial<ConversationStoreDocument>;
  if (!document || typeof document !== "object" || !Array.isArray(document.records)) {
    throw new WebChatConversationStoreUnavailableError(file, "its contents are not a conversation store document");
  }
  if (document.version !== WEB_CHAT_CONVERSATION_STORE_VERSION) {
    throw new WebChatConversationStoreUnavailableError(
      file,
      `its schema version ${String(document.version)} is not supported (expected ${WEB_CHAT_CONVERSATION_STORE_VERSION})`,
    );
  }
  let records: WebChatConversationRecord[];
  try {
    records = document.records.map((record) => validateWebChatConversationRecord(record));
  } catch (error) {
    throw new WebChatConversationStoreUnavailableError(file, (error as Error).message, { cause: error });
  }
  return { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records };
}

/** Write the document atomically. */
function writeDocument(file: string, document: ConversationStoreDocument): void {
  try {
    atomicWriteFile(file, `${JSON.stringify(document, null, 2)}\n`);
  } catch (error) {
    throw new WebChatConversationStoreUnavailableError(file, "it could not be written", { cause: error });
  }
}

/**
 * Create the durable conversation store over one file.
 *
 * @param options - the file to use and an optional clock.
 * @returns the store.
 * @throws {TypeError} when no file is given.
 */
export function createFileConversationStore(
  options: WebChatConversationStoreOptions & { readonly file: string },
): WebChatConversationStore {
  const file = options.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new TypeError("The durable WebChat conversation store requires a file path");
  }
  const now = options.now ?? (() => Date.now());
  // One writer per store instance: every mutation is a whole-document read-modify-write.
  let queue: Promise<unknown> = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    async read(identity) {
      const document = readDocument(file);
      return document.records.find((record) => identityKey(record.identity) === identityKey(identity));
    },
    async list() {
      return readDocument(file).records;
    },
    update(identity, mutate) {
      return serialized(() => {
        const document = readDocument(file);
        const key = identityKey(identity);
        const previous = document.records.find((record) => identityKey(record.identity) === key);
        const draft: WebChatConversationDraft = mutate(previous);
        const committed = commitWebChatConversationDraft(identity, previous, draft, now());
        const records = previous
          ? document.records.map((record) => (identityKey(record.identity) === key ? committed : record))
          : [...document.records, committed];
        writeDocument(file, { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records });
        return committed;
      });
    },
    forget(identity) {
      return serialized(() => {
        const document = readDocument(file);
        const key = identityKey(identity);
        const records = document.records.filter((record) => identityKey(record.identity) !== key);
        if (records.length === document.records.length) return false;
        writeDocument(file, { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records });
        return true;
      });
    },
  };
}

/** The directory the durable store lives in, exposed for diagnostics. */
export function webChatConversationStoreDirectory(file: string): string {
  return dirname(file);
}
