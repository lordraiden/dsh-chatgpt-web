import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  hasRawChatGptEnvironmentContext,
  MissingTrustedCodexEnvironmentError,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
} from "./environment";
import { resolveCurrentCodexChildRolloutEnvironment } from "./codex-rollout-environment";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const unique = new Map<string, string>();
  for (const path of value.map(path => resolve(path as string))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.some(path => !roots.some(root => contains(root, path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
  };
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only legacy Codex continuity across turns. Native
 * DSH turns bypass this store and carry the current DSH-authoritative sandbox projection directly.
 * Tool declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
  ) {}

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    // Current DSH/native context is the only authoritative source for capability elevation.
    if (parsed._dshContext) {
      try {
        return extractChatGptTurnEnvironment(parsed);
      } catch (error) {
        throw error instanceof MissingTrustedCodexEnvironmentError
          ? error
          : new Error(`ChatGPT Web native DSH environment is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const identity = extractChatGptTurnIdentity(parsed);
    try {
      const environment = extractChatGptTurnEnvironment(parsed);
      if (identity.threadId) this.set(identity.threadId, environment);
      return environment;
    } catch (error) {
      // Persisted environment is continuity/cache state only. It cannot authorize a fresh turn.
      // A missing current trusted envelope therefore fails closed, even when a matching cached
      // environment exists. Explicit child-rollout evidence remains authoritative when available.
      if (!(error instanceof MissingTrustedCodexEnvironmentError)) throw error;
      if (!identity.threadId) throw error;
      if (hasRawChatGptEnvironmentContext(parsed)) throw error;

      const lineage = extractChatGptThreadSpawnLineage(parsed);
      if (lineage && identity.turnId) {
        const rolloutEnvironment = resolveCurrentCodexChildRolloutEnvironment({
          codexHome: this.codexHome,
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage,
          turnId: identity.turnId,
          tools: parsed.context.tools,
        });
        if (rolloutEnvironment) {
          this.set(lineage.threadId, rolloutEnvironment);
          return rolloutEnvironment;
        }
      }

      const cached = this.get(identity.threadId);
      if (cached) {
        throw new MissingTrustedCodexEnvironmentError(
          "persisted ChatGPT thread environment is continuity cache only; current trusted DSH/Codex environment evidence is required",
        );
      }
      throw error;
    }
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment): void {
    this.load();
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, this.now()));
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredThreadEnvironmentFile>;
    const rawThreads = record(parsed.threads);
    if (parsed.version !== 1 || !rawThreads) {
      throw new Error(`Invalid ChatGPT thread environment store: ${this.path}`);
    }
    const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
    const entries = Object.entries(rawThreads)
      .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
      .filter(([, environment]) => environment.updatedAt >= cutoff)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(-MAX_THREAD_ENVIRONMENTS);
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
