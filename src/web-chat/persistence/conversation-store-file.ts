/**
 * Durable file backend for the WebChat conversation store (architecture §7.3).
 *
 * This is infrastructure, deliberately outside `src/web-chat/core`: the core owns the record, the
 * invariants and the port; this module owns bytes on disk. It reuses the project's existing atomic
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
 * - updates are serialized per store instance and per affinity, and `close()` waits for that queue:
 *   releasing the writer slot never races an accepted update that has not reached the file yet.
 *
 * The provider handle is stored and returned verbatim: this module never parses it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/**
 * Durable files this process already owns.
 *
 * Two stores over one file would each keep their own queue and write the whole document, so a second
 * instance is refused instead of silently overwriting the first one's updates.
 */
const ownedStoreFiles = new Set<string>();

/** The durable store could not be written because another writer changed it first. */
export class WebChatConversationStoreConflictError extends WebChatConversationStoreUnavailableError {
  constructor(file: string, options: { cause?: unknown } = {}) {
    super(file, "another writer changed it while this update was being prepared", options);
    this.name = "WebChatConversationStoreConflictError";
  }
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
  return readDocumentWithRaw(file).document;
}

/**
 * Read and validate the document, keeping the exact bytes it was read from.
 *
 * The bytes are what makes a lost update detectable: the writer refuses to replace a document that
 * another writer changed in the meantime, instead of overwriting that change.
 */
function readDocumentWithRaw(file: string): { document: ConversationStoreDocument; raw: string | undefined } {
  if (!existsSync(file)) {
    return { document: { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records: [] }, raw: undefined };
  }
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
  return { document: { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records }, raw };
}

/**
 * Refuse to write over a document another writer changed since it was read.
 *
 * This is detection, not mutual exclusion: the window between this check and the atomic replace is
 * still open, which is why the store also refuses a second instance for the same file. Cross-process
 * mutual exclusion is the host's decision (the deployment chooses the path and whether more than one
 * runtime may open it).
 */
function assertUnchangedSinceRead(file: string, raw: string | undefined): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current !== raw) throw new WebChatConversationStoreConflictError(file);
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
  if (typeof options.file !== "string" || options.file.length === 0) {
    throw new TypeError("The durable WebChat conversation store requires a file path");
  }
  // One writer per file in this process: a second store would keep its own queue and write the whole
  // document, so its updates could silently overwrite the first one's.
  const file = resolve(options.file);
  if (ownedStoreFiles.has(file)) {
    throw new WebChatConversationStoreUnavailableError(file, "another store instance in this process already owns it");
  }
  ownedStoreFiles.add(file);
  let closed = false;
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
        const { document, raw } = readDocumentWithRaw(file);
        const key = identityKey(identity);
        const previous = document.records.find((record) => identityKey(record.identity) === key);
        const draft: WebChatConversationDraft = mutate(previous);
        const committed = commitWebChatConversationDraft(identity, previous, draft, now());
        const records = previous
          ? document.records.map((record) => (identityKey(record.identity) === key ? committed : record))
          : [...document.records, committed];
        assertUnchangedSinceRead(file, raw);
        writeDocument(file, { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records });
        return committed;
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      // Drain before releasing: every update/forget this store accepted is serialized on `queue`, and
      // releasing the writer slot while one is still running would hand the file to a second writer
      // (or let the process exit) with a committed update not yet on disk.
      await queue.catch(() => undefined);
      ownedStoreFiles.delete(file);
    },
    forget(identity) {
      return serialized(() => {
        const { document, raw } = readDocumentWithRaw(file);
        const key = identityKey(identity);
        const records = document.records.filter((record) => identityKey(record.identity) !== key);
        if (records.length === document.records.length) return false;
        assertUnchangedSinceRead(file, raw);
        writeDocument(file, { version: WEB_CHAT_CONVERSATION_STORE_VERSION, records });
        return true;
      });
    },
  };
}
