/**
 * Advisor recovery request contract (issue #214, kept by #224).
 *
 * Recovery reads the finalized answer of the retained Advisor conversation of one DSH session. It is
 * read-only by construction: it never submits, never navigates and never creates a conversation, so
 * it can be retried freely and a review the provider's own turn gave up on stays recoverable.
 *
 * The request names the **public route** whose provider conversation is read, so recovery no longer
 * needs a ChatGPT-specific Normal/Think mode. When the route is omitted the host resolves its
 * deterministic eligible route, which keeps the existing "read whatever this session already has"
 * behavior without reintroducing a provider-shaped control.
 */

/** Upper bound one recovery wait may ask for (30 minutes). */
export const ADVISOR_RECOVERY_TIMEOUT_MAX_MS = 30 * 60_000;

/** One read-only recovery request. */
export interface AdvisorRecoveryRequest {
  /** The DSH session whose retained Advisor conversation is read. */
  readonly sessionId: string;
  /** Public route whose provider conversation is read; the host default applies when absent. */
  readonly route?: string;
  /** Bounded wait for the finalized answer; the provider default applies when absent. */
  readonly timeoutMs?: number;
  /** Cancellation of this read, when the caller tracks one. */
  readonly signal?: AbortSignal;
}

/**
 * Validate one recovery request.
 *
 * @param body - the parsed request body.
 * @returns the normalized recovery request.
 * @throws {Error} with a stable message when the body is malformed.
 */
export function validateAdvisorRecoveryRequest(body: unknown): AdvisorRecoveryRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Advisor recovery body must be an object");
  }
  const raw = body as Record<string, unknown>;
  const sessionId = raw.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error('Advisor recovery field "sessionId" must be a non-empty string');
  }
  let route: string | undefined;
  if (raw.route !== undefined) {
    if (typeof raw.route !== "string" || raw.route.trim().length === 0) {
      throw new Error('Advisor recovery field "route" must be a non-empty string when present');
    }
    route = raw.route.trim();
  }
  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      throw new Error('Advisor recovery field "timeoutMs" must be a positive finite number when present');
    }
    if (raw.timeoutMs > ADVISOR_RECOVERY_TIMEOUT_MAX_MS) {
      throw new Error(`Advisor recovery field "timeoutMs" must not exceed ${ADVISOR_RECOVERY_TIMEOUT_MAX_MS}`);
    }
    timeoutMs = raw.timeoutMs;
  }
  return {
    sessionId: sessionId.trim(),
    ...(route !== undefined ? { route } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
