import { isAbsolute, relative, resolve } from "node:path";

/**
 * Shared owner of the JSON-record narrowing and path-identity helpers that the ChatGPT Web
 * environment resolvers used to copy privately: `adapters/chatgpt-web/environment.ts`,
 * `thread-environment.ts` and `codex-rollout-environment.ts`.
 *
 * The three consumers keep their own *policies* — which error a rejected value produces and
 * whether their input is decoded first — because those genuinely differ. The identity,
 * containment, absolute-path validation and de-duplication logic lives here once.
 */

/** Narrow an unknown JSON value to a plain record, rejecting null and arrays. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Canonical comparable identity for a filesystem path (case-insensitive on Windows). */
export function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when `path` is `root` itself or lies inside it. */
export function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve and de-duplicate already-validated paths, keeping the first spelling seen. */
export function uniqueResolvedPaths(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const path of values.map(value => resolve(value))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

export interface AbsolutePathPolicy {
  /** Error for a malformed value: not an array, or an entry that is not an absolute path string. */
  invalid: (field: string) => Error;
  /** Error for an empty array. Omit to accept an empty array as `[]`. */
  empty?: (field: string) => Error;
  /** Optional per-entry decoding (for example XML text) applied before validation. */
  decode?: (value: string) => string;
}

/**
 * Validate a trusted path list and return its unique resolved forms. The policy carries the only
 * things that legitimately differ between callers: the error (and its type), whether an empty
 * list is rejected, and whether entries are decoded first.
 */
export function absolutePaths(value: unknown, field: string, policy: AbsolutePathPolicy): string[] {
  if (!Array.isArray(value)) throw policy.invalid(field);
  const entries = policy.decode ? value.map(entry => policy.decode!(entry as string)) : value;
  if (entries.length === 0 && policy.empty) throw policy.empty(field);
  if (entries.some(entry => typeof entry !== "string" || !isAbsolute(entry))) throw policy.invalid(field);
  return uniqueResolvedPaths(entries as string[]);
}
