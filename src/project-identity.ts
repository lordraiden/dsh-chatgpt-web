/**
 * Deterministic project identity for the first message of a provider conversation.
 *
 * Normal Chat Mode introduces a conversation with initialization metadata instead of with harness
 * context (architecture §20.1): the project's name and its authoritative repository URL, generated
 * programmatically from the installed package's own `package.json`. The provider owns the
 * conversation from that message on, so nothing of the DSH session travels with it.
 *
 * This is deliberately a small, provider-neutral, text-only owner — the same kind of owner
 * `conversation-sanitizer.ts` is for host-injected text. ChatGPT Web's minimal Chat Mode install and
 * Qwen Chat's conversation install both compile their header from this one source of truth rather
 * than keeping a copy each, and the honesty rules live here once:
 *
 * - the name is a package name, never a filesystem path;
 * - the URL comes from the package manifest, never from the user's message, the conversation, the
 *   working directory or a model answer;
 * - metadata that cannot be resolved is **omitted, never fabricated**: no header is emitted unless
 *   both the name and the URL resolve, and an unknown/private-scheme/invalid URL yields no `github:`
 *   line instead of a guessed one.
 */
import { createRequire } from "node:module";

/** The deterministic project identity one install header carries. */
export interface ProjectIdentity {
  readonly name: string;
  readonly repositoryUrl: string;
}

/** The package-manifest fields this owner reads. Everything else is not identity. */
export interface ProjectPackageMetadata {
  readonly name?: unknown;
  readonly repository?: unknown;
}

const packageRequire = createRequire(import.meta.url);

/**
 * Deterministic project name from authoritative package metadata. A name is a name, never a
 * filesystem path; `undefined` means the metadata carries none.
 */
export function projectNameFromPackageName(name: unknown): string | undefined {
  const value = typeof name === "string" ? name.trim() : "";
  const last = value.split("/").filter(Boolean).pop();
  return last && last.length > 0 ? last : undefined;
}

/**
 * Deterministic repository URL from authoritative package metadata. The package manifest is the
 * single source of repository identity: the URL is never inferred from the user's message, the
 * conversation, the working directory, or a model answer, and invalid/missing metadata returns
 * `undefined` instead of a fabricated URL.
 */
export function repositoryUrlFromPackageMetadata(repository: unknown): string | undefined {
  const value = typeof repository === "string"
    ? repository.trim()
    : repository && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string"
      ? (repository as { url: string }).url.trim()
      : "";
  if (!value) return undefined;
  const normalized = (value.startsWith("git+") ? value.slice(4) : value).replace(/\.git$/, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return normalized;
}

/**
 * The identity a package manifest carries, or `undefined` when it does not resolve **both** fields.
 *
 * All-or-nothing on purpose: a header with a fabricated half would be worse than no header, and this
 * is the rule the existing ChatGPT install has always applied.
 */
export function projectIdentityFromMetadata(metadata: ProjectPackageMetadata | undefined): ProjectIdentity | undefined {
  if (!metadata) return undefined;
  const name = projectNameFromPackageName(metadata.name);
  const repositoryUrl = repositoryUrlFromPackageMetadata(metadata.repository);
  return name && repositoryUrl ? { name, repositoryUrl } : undefined;
}

/**
 * Read the installed package's own metadata; source and bundled layouts differ.
 *
 * Package metadata is optional at runtime: every candidate that cannot be loaded (or resolves no
 * identity) is skipped, and the caller omits the header instead of inventing one.
 */
export function installedProjectIdentity(): ProjectIdentity | undefined {
  for (const candidate of [
    "@lordraiden/dsh-chatgpt-web/package.json",
    "../package.json",
    "../../../package.json",
  ]) {
    try {
      const loaded = packageRequire(candidate) as ProjectPackageMetadata & { default?: ProjectPackageMetadata };
      const identity = projectIdentityFromMetadata(loaded.default ?? loaded);
      if (identity) return identity;
    } catch {
      // Package metadata is optional at runtime; invalid/missing metadata is omitted.
    }
  }
  return undefined;
}

/**
 * The deterministic first-message header for one identity, or `undefined` when there is none.
 *
 * The exact two lines are the contract an operator reads at the top of the provider conversation:
 * `Project: "<name>"` and `github: "<url>"`.
 */
export function formatProjectIdentityHeader(identity: ProjectIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  return `Project: "${identity.name}"\ngithub: "${identity.repositoryUrl}"`;
}

/** This installation's own install header, or `undefined` when its metadata cannot resolve one. */
export function projectIdentityHeader(): string | undefined {
  return formatProjectIdentityHeader(installedProjectIdentity());
}

/**
 * The install text: the deterministic header, then the turn's own human text.
 *
 * Idempotent: a text that already carries the header is returned unchanged, so a caller that compiles
 * an install twice (a replay of an install, a rebuilt conversation) can never duplicate it. With no
 * header (metadata that did not resolve) the text is returned exactly as it is — the header is
 * omitted, not fabricated.
 *
 * The header is a parameter rather than a default so "this installation resolves no identity" stays
 * expressible: a caller passes `projectIdentityHeader()` for production, or `undefined` to prove the
 * omission rule.
 */
export function withProjectIdentityHeader(text: string, header: string | undefined): string {
  if (header === undefined || text.startsWith(header)) return text;
  return [header, text].filter(part => part.length > 0).join("\n\n");
}
