/**
 * Provider-neutral text exchange contract (architecture §8.3) and the text-only admission rule
 * (§1.2, §8.3).
 *
 * The common layer carries a small semantic input and normalizes nothing else. A driver owns how
 * that input becomes transport data. The exchange **interface** lives here; its state machine,
 * transport readiness and physical settlement are owned by the exchange lifecycle work
 * (issue #191 / PR 3).
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import { webChatError } from "./errors";
import type { WebChatExchangeEvent } from "./events";
import type { WebChatExchangeSnapshot } from "./exchange-state";
import type { WebChatRetrySafety } from "./retry-authority";

/** One canonical text message used only for an explicit replay. */
export interface WebChatReplayMessage {
  readonly role: "system" | "developer" | "user" | "assistant";
  readonly text: string;
}

/**
 * The semantic input of one text turn.
 *
 * `replayHistory` is present only when the provider cannot continue its own remote conversation and
 * an explicit replay was selected; it is derived from canonical host history and is never a second
 * persistent transcript (architecture §8.3, §11.3).
 */
export interface WebChatTurnInput {
  /** System instructions for this turn, when the host supplies them. */
  readonly systemInstructions?: readonly string[];
  /** Developer instructions for this turn, when the host supplies them. */
  readonly developerInstructions?: readonly string[];
  /** The current human text. */
  readonly userText: string;
  /** The model route already selected by the host. */
  readonly model: string;
  /** Provider-neutral reasoning selection, resolved by the driver. */
  readonly reasoningMode?: string;
  /** Canonical text history, only for an explicit replay. */
  readonly replayHistory?: readonly WebChatReplayMessage[];
}

/** Logical identity of one exchange (architecture §6.1, §6.2, §6.5). */
export interface WebChatTurnIdentity {
  /** Host session identity, when the caller is session-bound. */
  readonly dshSessionId?: string;
  /** Provider/account binding this exchange runs under. */
  readonly bindingId: string;
  /** Conversation key, once a conversation is established. */
  readonly conversationKey?: string;
  /** Host-issued turn identity for this exchange. */
  readonly turnId: string;
}

/**
 * One text exchange (architecture §8.3).
 *
 * The host drives `prepare` → `submit` → `stream`, and may `abort` at any point; a driver owns how
 * each step maps onto its transport. `submitted` in the stream is the semantic boundary the retry
 * rules key on.
 */
export interface WebChatExchange {
  readonly identity: WebChatTurnIdentity;
  /** Establish transport readiness for this exchange. */
  prepare(): Promise<void>;
  /** Attempt submission. May reject with `SUBMISSION_AMBIGUOUS` when the outcome is unknown. */
  submit(): Promise<void>;
  /** Normalized events for this exchange, until its terminal event. */
  stream(): AsyncIterable<WebChatExchangeEvent>;
  /** Cancel this exchange. Idempotent. */
  abort(reason?: unknown): Promise<void>;
  /** The lifecycle facts of this exchange (state, submission phase, settlements). */
  snapshot(): WebChatExchangeSnapshot;
  /**
   * What the host layer may do with this turn if it failed.
   *
   * The exchange owns the classification, so the host's route-level retry and the exchange's own
   * retry cannot both act on the same submitted turn.
   */
  retrySafety(): WebChatRetrySafety;
}

/**
 * Request features that exist outside the text-only common layer.
 *
 * They are named explicitly so a caller sees exactly which feature was refused. Presence (not
 * shape) is the signal: an empty array or object carries nothing and is admitted.
 */
const UNSUPPORTED_WEB_CHAT_FEATURES = [
  "files",
  "images",
  "audio",
  "video",
  "attachments",
  "tools",
  "toolChoice",
  "mcp",
] as const;

type UnsupportedWebChatFeature = (typeof UNSUPPORTED_WEB_CHAT_FEATURES)[number];

/** A candidate turn handed to the common layer, including anything it must refuse. */
export type WebChatTurnCandidate = Partial<WebChatTurnInput>
  & Partial<Record<UnsupportedWebChatFeature, unknown>>;

/** Whether a feature slot actually carries something. */
function carriesFeature(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * Refuse any request that carries features outside the text-only common layer.
 *
 * The common layer must never silently drop or reinterpret unsupported content (architecture
 * §8.3): a caller that carries files, images, audio/video, attachments, tool definitions or MCP
 * state gets a stable `UNSUPPORTED_OPTION` failure naming them.
 *
 * @param candidate - the turn candidate, or any request-shaped value.
 * @throws {WebChatError} `UNSUPPORTED_OPTION` when an unsupported feature is present.
 */
export function rejectUnsupportedWebChatFeatures(candidate: unknown): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
  const record = candidate as Record<string, unknown>;
  const present = UNSUPPORTED_WEB_CHAT_FEATURES.filter((feature) => carriesFeature(record[feature]));
  if (present.length === 0) return;
  throw webChatError(
    "UNSUPPORTED_OPTION",
    `The WebChat common layer is text-only; unsupported request features: ${present.join(", ")}.`,
    { providerDetail: { unsupported: present } },
  );
}

/** Require a non-empty string field of the semantic input. */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    // A malformed candidate is a caller defect, not a provider failure: it is not one of the
    // semantic categories.
    throw new TypeError(`WebChat turn input requires a non-empty ${field}`);
  }
  return value.trim();
}

/** Admit an optional list of instruction strings. */
function optionalInstructionList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`WebChat turn input ${field} must be an array of strings`);
  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`WebChat turn input ${field} must contain non-empty strings`);
    }
    return entry;
  });
  return strings;
}

/** Admit canonical replay history. */
function optionalReplayHistory(value: unknown): readonly WebChatReplayMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("WebChat turn input replayHistory must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new TypeError("WebChat turn input replayHistory entries must be objects");
    const message = entry as { role?: unknown; text?: unknown };
    if (message.role !== "system" && message.role !== "developer" && message.role !== "user" && message.role !== "assistant") {
      throw new TypeError("WebChat turn input replayHistory entry has an unknown role");
    }
    if (typeof message.text !== "string") throw new TypeError("WebChat turn input replayHistory entry requires text");
    return { role: message.role, text: message.text } satisfies WebChatReplayMessage;
  });
}

/**
 * Admit a turn into the text-only common layer, or fail explicitly.
 *
 * Refuses unsupported features first (so a caller always learns what the layer cannot carry), then
 * validates and normalizes the semantic input. Only admitted fields survive, so a driver can never
 * observe provider-irrelevant request state through this contract.
 *
 * @param candidate - the turn candidate.
 * @returns the normalized semantic input.
 * @throws {WebChatError} `UNSUPPORTED_OPTION` for features outside the text-only layer.
 * @throws {TypeError} for a malformed candidate (a caller defect).
 */
export function assertTextOnlyWebChatTurn(candidate: unknown): WebChatTurnInput {
  rejectUnsupportedWebChatFeatures(candidate);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("WebChat turn input must be an object");
  }
  const record = candidate as Record<string, unknown>;
  const userText = requiredText(record.userText, "userText");
  const model = requiredText(record.model, "model");
  const systemInstructions = optionalInstructionList(record.systemInstructions, "systemInstructions");
  const developerInstructions = optionalInstructionList(record.developerInstructions, "developerInstructions");
  const replayHistory = optionalReplayHistory(record.replayHistory);
  let reasoningMode: string | undefined;
  if (record.reasoningMode !== undefined) reasoningMode = requiredText(record.reasoningMode, "reasoningMode");
  return {
    userText,
    model,
    ...(systemInstructions ? { systemInstructions } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(reasoningMode ? { reasoningMode } : {}),
    ...(replayHistory ? { replayHistory } : {}),
  };
}
