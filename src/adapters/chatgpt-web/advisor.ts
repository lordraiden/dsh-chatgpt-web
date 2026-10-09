/**
 * ChatGPT Advisor review flow (issue #178).
 *
 * Runs a review of one DSH development step in an Advisor conversation that is
 * independent of the normal ChatGPT Web conversation. The Advisor reuses the
 * existing retained-conversation infrastructure end to end:
 *
 * - the Advisor conversationKey is derived by the existing
 *   `chatGptConversationKey` from a synthetic, stable per-DSH-session
 *   threadId (`advisorConversationThread`), so successive reviews of the same
 *   DSH chat continue in the same Advisor conversation and the Advisor
 *   conversation can never collide with the normal ChatGPT Web conversation of
 *   the same DSH chat;
 * - the `ChatGptTurnSessions` generation + system-fingerprint state and the
 *   plain composer install/continue transport carry the continuity — there is
 *   no second retention implementation;
 * - the turn executes through the provider adapter's `runTurn` (the same seam
 *   as the native-llm endpoint), so the sidecar never participates in the DSH
 *   session loop and a review writes nothing to the main DSH history.
 *
 * The review content is deliberately minimal: project reference (a name, never
 * an absolute path), the DSH agent-preset label the reviewed step ran under
 * (review context only, never a DSH session), review instructions, the last
 * human request, and the last final DSH response. No full DSH history, no
 * Aegis/Codex/bridge details, no transport markers.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "../../types";
import { projectContextName } from "./prompt";
import type { IncomingMeta } from "../base";

export type AdvisorMode = "normal" | "think";

export interface AdvisorReviewInput {
  /** The DSH session under review. */
  sessionId: string;
  /** The last human request of the target turn. */
  humanRequest: string;
  /** The last final DSH response of that turn. */
  dshResponse: string;
  /** User-chosen review instructions. */
  instructions: string;
  /** Review mode. */
  mode: AdvisorMode;
  /** Project/repository name (a name, never an absolute path). Optional. */
  project?: string;
  /**
   * The DSH agent preset the reviewed step ran under, as the label the reviewer reads.
   * Optional: a deployment without an agent-preset roster simply omits it. It is review
   * context only — the Advisor never composes a DSH session.
   */
  preset?: string;
}

export interface AdvisorReviewResult {
  ok: boolean;
  /** Identifier associating the result with the requested review. */
  reviewId: string;
  /** The requested mode, echoed. */
  mode: AdvisorMode;
  /** The model route used (public slug), echoed. */
  model: string;
  /** The requested agent-preset label, echoed when the request carried one. */
  preset?: string;
  /** The final review text (ok only). */
  text?: string;
  /** Stable failure code (not-ok only). */
  code?: string;
  /** Human-readable failure message (not-ok only). */
  message?: string;
}

export const ADVISOR_INPUT_INVALID_CODE = "advisor_input_invalid";
export const ADVISOR_TURN_FAILED_CODE = "advisor_turn_failed";
/** Bound on the optional agent-preset label carried into the review content. */
export const ADVISOR_PRESET_LABEL_MAX = 120;

/**
 * The Advisor persona. It is installed on the first Advisor turn of a
 * conversation through the existing retained composer install and stays frozen
 * for the rest of that physical conversation by the existing fingerprint
 * mechanism; a change to this constant only takes effect in the next physical
 * Advisor conversation.
 */
export const ADVISOR_SYSTEM_PROMPT =
  "You are a senior software engineering reviewer. Review the single DSH development step provided. " +
  "Respond in the same language as the review instructions. Be direct and specific: lead with the verdict, " +
  "then concrete findings (correctness, edge cases, tests, security, performance) ordered by severity, " +
  "each pointing at the exact location in the provided step. Do not restate the full context, do not invent " +
  "content that is not present in the provided step, and do not add transport metadata.";

/**
 * Stable synthetic thread identity for the Advisor conversation of one DSH
 * session. Deliberately distinct from a normal DSH thread (the `advisor-`
 * prefix and the salted hash) so the Advisor conversationKey can never collide
 * with the normal ChatGPT Web conversationKey of the same DSH chat.
 */
export function advisorConversationThread(sessionId: string): string {
  return "advisor-" + createHash("sha256").update("advisor:" + sessionId).digest("hex").slice(0, 24);
}

/**
 * Resolve the Advisor model route slug for one mode against the account's
 * model family. `normal` maps to the lightest non-Pro route; `think` maps to
 * the deepest non-Pro route: Sol accounts use `chatgpt-web/light` /
 * `chatgpt-web/high`, Luna-only accounts use `chatgpt-web/luna` /
 * `chatgpt-web/think`.
 *
 * The model FAMILY decision takes the route authority's RESOLVED capability
 * state (`ChatgptWebRouteAuthority.capabilities.solAvailable`), never a raw
 * boolean: the authority is the single source of truth for what the account
 * can use (it folds `capabilityState` over the legacy boolean). `unknown`
 * refuses model selection fail-closed, exactly like the rest of the route
 * authority. The caller validates the slug through `requireChatGptWebRoute`
 * on the same authority, which also yields the backend model and the adapter
 * effort — no model discovery or new configuration.
 */
export function resolveAdvisorRouteSlug(
  mode: AdvisorMode,
  solAvailable: "supported" | "unsupported" | "unknown",
): string {
  if (solAvailable === "unknown") {
    throw new Error("ChatGPT Web Sol capability is unknown; the Advisor cannot select a model family");
  }
  if (solAvailable === "unsupported") return mode === "think" ? "chatgpt-web/think" : "chatgpt-web/luna";
  return mode === "think" ? "chatgpt-web/high" : "chatgpt-web/light";
}

/**
 * Compose the single plain-text review message: project reference (a name,
 * never an absolute path), the review instructions, the last human request,
 * and the last final DSH response. No full DSH history, no Aegis/Codex/bridge
 * details, no transport markers.
 */
export function composeAdvisorMessage(input: AdvisorReviewInput): string {
  const blocks: string[] = [];
  if (input.project !== undefined) {
    blocks.push(`Project: "${input.project}"`);
  }
  if (input.preset !== undefined) {
    blocks.push(`Agent preset: "${input.preset}"`);
  }
  blocks.push(
    `Review instructions:\n${input.instructions}`,
    `Human request:\n${input.humanRequest}`,
    `DSH response:\n${input.dshResponse}`,
  );
  return blocks.join("\n\n");
}

/** Validate the public review input. Throws with a stable message on failure. */
export function validateAdvisorReviewInput(body: unknown): AdvisorReviewInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Advisor review body must be an object");
  }
  const raw = body as Record<string, unknown>;
  const stringField = (name: string): string => {
    const value = raw[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Advisor review field "${name}" must be a non-empty string`);
    }
    return value.trim();
  };
  const mode = raw.mode;
  if (mode !== "normal" && mode !== "think") {
    throw new Error('Advisor review field "mode" must be "normal" or "think"');
  }
  const project = raw.project;
  if (project !== undefined && (typeof project !== "string" || project.trim().length === 0)) {
    throw new Error('Advisor review field "project" must be a non-empty string when present');
  }
  const preset = raw.preset;
  if (preset !== undefined) {
    if (typeof preset !== "string" || preset.trim().length === 0) {
      throw new Error('Advisor review field "preset" must be a non-empty string when present');
    }
    if (preset.trim().length > ADVISOR_PRESET_LABEL_MAX) {
      throw new Error(`Advisor review field "preset" must not exceed ${ADVISOR_PRESET_LABEL_MAX} characters`);
    }
  }
  // Normalize the project identifier through the same owner the retained
  // install uses (`projectContextName`): a bare name passes through
  // unchanged, a path collapses to its last segment, so a local filesystem
  // path can never reach the review content. A name that resolves to
  // nothing is omitted, mirroring the install's "line omitted" behavior.
  const projectName = typeof project === "string" ? projectContextName(project.trim()) : undefined;
  return {
    sessionId: stringField("sessionId"),
    humanRequest: stringField("humanRequest"),
    dshResponse: stringField("dshResponse"),
    instructions: stringField("instructions"),
    mode,
    ...(projectName !== undefined ? { project: projectName } : {}),
    ...(typeof preset === "string" ? { preset: preset.trim() } : {}),
  };
}

/**
 * A resolved Advisor model route: the public slug (the client-facing model
 * identity), the backend model the adapter executes, and the adapter effort.
 * The server resolves this through the existing route authority
 * (`requireChatGptWebRoute`) — no model discovery.
 */
export interface AdvisorRoute {
  slug: string;
  backendModel: string;
  effort: string;
}

/**
 * Build the provider turn request for one Advisor review. The turn carries
 * exactly one user message (the composed review), the Advisor system block,
 * the synthetic Advisor thread identity, and the `_advisorReview` retention
 * marker — nothing else. No tools, no full DSH history.
 */
export function buildAdvisorTurnRequest(
  input: AdvisorReviewInput,
  route: AdvisorRoute,
  reviewId: string,
): CodexParsedRequest {
  const message: CodexMessage = {
    role: "user",
    content: composeAdvisorMessage(input),
    timestamp: Date.now(),
  };
  return {
    modelId: route.backendModel,
    context: {
      systemPrompt: [ADVISOR_SYSTEM_PROMPT],
      messages: [message],
    },
    stream: true,
    options: { reasoning: route.effort },
    _dshContext: {
      dshSessionId: input.sessionId,
      threadId: advisorConversationThread(input.sessionId),
      turnId: reviewId,
    },
    _advisorReview: { reviewId },
  };
}

/** The seam `runAdvisorReview` executes one review turn through. */
export interface AdvisorTurnRunner {
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}

/**
 * Execute one Advisor review turn and collect its result. The turn runs
 * through the provider adapter's `runTurn` (the same seam as the native-llm
 * endpoint); the Advisor writes nothing to the main DSH history because the
 * sidecar never participates in the DSH session loop. A turn failure becomes a
 * typed `ok: false` result, never an unhandled rejection.
 *
 * `options.abortSignal` (the tracked HTTP execution signal) is forwarded into
 * the turn's incoming meta exactly like `nativeDshTurnRequest` does: when the
 * client disconnects, the sidecar aborts the browser turn and releases the
 * Advisor surface instead of letting it run on in the background.
 */
export async function runAdvisorReview(
  runner: AdvisorTurnRunner,
  input: AdvisorReviewInput,
  route: AdvisorRoute,
  reviewId?: string,
  options: { abortSignal?: AbortSignal } = {},
): Promise<AdvisorReviewResult> {
  const id = reviewId ?? randomUUID();
  const parsed = buildAdvisorTurnRequest(input, route, id);
  const base: AdvisorReviewResult = {
    ok: false,
    reviewId: id,
    mode: input.mode,
    model: route.slug,
    ...(input.preset !== undefined ? { preset: input.preset } : {}),
  };
  let text = "";
  let terminal: "done" | "incomplete" | "error" | undefined;
  let failure: { code?: string; message?: string } | undefined;
  try {
    await runner.runTurn(parsed, { headers: new Headers(), abortSignal: options.abortSignal }, event => {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "done":
          terminal = "done";
          break;
        case "incomplete":
          terminal = "incomplete";
          failure = { code: ADVISOR_TURN_FAILED_CODE, message: event.reason ?? "Advisor turn ended incomplete" };
          break;
        case "error":
          terminal = "error";
          failure = {
            code: event.code ?? ADVISOR_TURN_FAILED_CODE,
            message: event.message ?? "Advisor turn failed",
          };
          break;
        default:
          break;
      }
    });
  } catch (error) {
    terminal = "error";
    failure = { code: ADVISOR_TURN_FAILED_CODE, message: error instanceof Error ? error.message : String(error) };
  }
  if (terminal === "done" && text.trim().length > 0) {
    return { ...base, ok: true, text: text.trim() };
  }
  return {
    ...base,
    code: failure?.code ?? ADVISOR_TURN_FAILED_CODE,
    message: failure?.message ?? "Advisor turn produced no text",
  };
}
