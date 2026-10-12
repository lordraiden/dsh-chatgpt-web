/**
 * Provider-neutral Advisor review text (issue #224).
 *
 * The Advisor submits **one portable, ordinary user-text prompt**: the reviewer persona, the selected
 * source material and the editable review instructions, as plain text. It never relies on
 * API-only system/developer roles, hidden system-prompt injection, or a provider-specific private
 * prompt mechanism — the text is what a human would type into the provider's visible composer
 * (architecture §12, §20).
 *
 * This module has no provider knowledge: it never imports a provider adapter, a driver, a browser
 * object or a DOM selector. Provider-local model resolution and transport stay behind the provider
 * runtime the host resolves the route to.
 */

/** The review request is malformed, or no substantive source text remains selected. */
export const ADVISOR_INPUT_INVALID_CODE = "advisor_input_invalid";
/** The review turn ran but did not produce a usable answer. */
export const ADVISOR_TURN_FAILED_CODE = "advisor_turn_failed";
/** The selected public route cannot currently be served by any integrated provider. */
export const ADVISOR_MODEL_UNAVAILABLE_CODE = "advisor_model_unavailable";
/** No tracked task exists for the requested review id (for example after a sidecar restart). */
export const ADVISOR_TASK_UNAVAILABLE_CODE = "advisor_task_unavailable";
/** A concurrent review already owns the requested session/turn affinity. */
export const ADVISOR_DUPLICATE_REVIEW_CODE = "advisor_duplicate_review";
/** The retained conversation could not be read (issue #214 recovery). */
export const ADVISOR_RECOVERY_UNAVAILABLE_CODE = "advisor_recovery_unavailable";

/**
 * The Advisor persona, folded into the portable user text.
 *
 * It is ordinary text a human could type, so it survives any provider whose only shared surface is
 * the visible composer. It is deliberately provider-neutral: no transport metadata, no provider
 * name, no tool/system role.
 */
export const ADVISOR_REVIEWER_PERSONA =
  "You are a senior software engineering reviewer. Review the single development step provided. " +
  "Respond in the same language as the review instructions. Be direct and specific: lead with the verdict, " +
  "then concrete findings (correctness, edge cases, tests, security, performance) ordered by severity, " +
  "each pointing at the exact location in the provided step. Do not restate the full context, do not invent " +
  "content that is not present in the provided step, and do not add transport metadata.";

/** Which parts of the captured turn the user chose to send. */
export interface AdvisorReviewInclusion {
  readonly request: boolean;
  readonly response: boolean;
  readonly project: boolean;
}

/**
 * The immutable snapshot of the reviewed turn plus the user's inclusion choices.
 *
 * `project` is a **name**, never an absolute local path: the value is normalized through
 * {@link projectReferenceName} before it can reach the review text.
 */
export interface AdvisorReviewSource {
  /** The DSH session under review. */
  readonly sessionId: string;
  /** Stable identity of the reviewed turn inside that session. */
  readonly reviewedTurnId: string;
  /** The reviewed human request, when captured. */
  readonly humanRequest?: string;
  /** The reviewed final DSH response, when captured. */
  readonly dshResponse?: string;
  /** Project/repository name (never a path), when captured. */
  readonly project?: string;
  readonly include: AdvisorReviewInclusion;
  /** The user's editable review instructions. */
  readonly instructions: string;
}

/**
 * Normalize a project reference to a bare name.
 *
 * A name passes through unchanged; anything path-shaped collapses to its last segment, so a local
 * filesystem path can never reach a provider's visible composer. A reference that resolves to
 * nothing is omitted rather than sent as an empty line.
 */
export function projectReferenceName(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  const segments = reference.split(/[\\/]+/).filter(segment => segment.length > 0);
  const name = segments[segments.length - 1];
  return name && name.length > 0 ? name : undefined;
}

/** Require one non-empty trimmed string field of the review input. */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Advisor review field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

/** Admit an optional non-empty trimmed string field. */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Advisor review field "${field}" must be a string when present`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Admit an optional inclusion flag, defaulting to `fallback`. */
function inclusionFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`Advisor review field "${field}" must be a boolean when present`);
  }
  return value;
}

/** The stable reviewed-turn identity carried by a start request. */
function reviewedTurnIdOf(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error('Advisor review field "reviewedTurnId" must be a non-empty string or a finite number');
}

/**
 * Validate one review start request.
 *
 * The request/response inclusion defaults to on and the project inclusion defaults to on when a
 * project is present, mirroring the dialog. Submission is refused when no substantive selected
 * source remains, so an empty review can never be launched.
 *
 * @param body - the parsed request body.
 * @returns the normalized review source.
 * @throws {Error} with a stable message when the body is malformed.
 */
export function validateAdvisorReviewSource(body: unknown): AdvisorReviewSource {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Advisor review body must be an object");
  }
  const raw = body as Record<string, unknown>;
  const sessionId = requiredText(raw.sessionId, "sessionId");
  const reviewedTurnId = reviewedTurnIdOf(raw.reviewedTurnId);
  const instructions = requiredText(raw.instructions, "instructions");
  const humanRequest = optionalText(raw.humanRequest, "humanRequest");
  const dshResponse = optionalText(raw.dshResponse, "dshResponse");
  const projectName = projectReferenceName(optionalText(raw.project, "project"));
  const include: AdvisorReviewInclusion = {
    request: inclusionFlag(raw.includeRequest, "includeRequest", true),
    response: inclusionFlag(raw.includeResponse, "includeResponse", true),
    project: inclusionFlag(raw.includeProject, "includeProject", true),
  };
  const includedRequest = include.request ? humanRequest : undefined;
  const includedResponse = include.response ? dshResponse : undefined;
  const includedProject = include.project ? projectName : undefined;
  if (!includedRequest && !includedResponse && !includedProject) {
    throw new Error("Advisor review requires at least one substantive selected source");
  }
  return {
    sessionId,
    reviewedTurnId,
    ...(humanRequest !== undefined ? { humanRequest } : {}),
    ...(dshResponse !== undefined ? { dshResponse } : {}),
    ...(projectName !== undefined ? { project: projectName } : {}),
    include,
    instructions,
  };
}

/**
 * Compose the portable review text.
 *
 * Only the selected source blocks are emitted; the persona always leads so a provider that carries
 * nothing but visible user text still receives the reviewer instruction.
 */
export function composeAdvisorReviewText(source: AdvisorReviewSource): string {
  const blocks: string[] = [ADVISOR_REVIEWER_PERSONA];
  const project = source.include.project ? source.project : undefined;
  if (project !== undefined) blocks.push(`Project: "${project}"`);
  blocks.push(`Review instructions:\n${source.instructions}`);
  const humanRequest = source.include.request ? source.humanRequest : undefined;
  if (humanRequest !== undefined) blocks.push(`Human request:\n${humanRequest}`);
  const dshResponse = source.include.response ? source.dshResponse : undefined;
  if (dshResponse !== undefined) blocks.push(`DSH response:\n${dshResponse}`);
  return blocks.join("\n\n");
}
