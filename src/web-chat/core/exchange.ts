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
 * Request features that exist outside the text-only common layer, split by **kind**.
 *
 * The distinction is the policy, not a tunable:
 *
 * - a **capability** declaration (`tools`, `toolChoice`, `mcp`) says nothing the model can use
 *   through this bridge. The provider is a consumer web chat reached as text: it has no execution
 *   channel and no return channel to the caller's harness, so a tool definition is protocol noise
 *   here, not content. Discarding it loses nothing the caller meant the model to read, so it is
 *   **dropped by design** — accepted, never executed, never forwarded, and always declared.
 * - a **content** feature (`files`, `images`, `audio`, `video`, `attachments`) is data the model was
 *   supposed to *see*. Discarding it is silent content loss, so it is **refused** — always. This is
 *   what stops "drop capability declarations" from sliding into "drop attached content".
 *
 * They are named explicitly so a caller can see exactly which capability declaration was discarded or
 * which content feature was refused. Presence (not shape) is the signal: an empty array or object
 * carries nothing and is admitted.
 *
 * The union is derived from the two kinds, so a new feature cannot be added to one list and forgotten
 * in the other (and a refusal always uses this one order).
 */
export const WEB_CHAT_CONTENT_FEATURES = ["files", "images", "audio", "video", "attachments"] as const;
export const WEB_CHAT_CAPABILITY_FEATURES = ["tools", "toolChoice", "mcp"] as const;

const UNSUPPORTED_WEB_CHAT_FEATURES = [...WEB_CHAT_CONTENT_FEATURES, ...WEB_CHAT_CAPABILITY_FEATURES] as const;

export type WebChatContentFeature = (typeof WEB_CHAT_CONTENT_FEATURES)[number];
export type WebChatCapabilityFeature = (typeof WEB_CHAT_CAPABILITY_FEATURES)[number];
type UnsupportedWebChatFeature = (typeof UNSUPPORTED_WEB_CHAT_FEATURES)[number];

/** A candidate turn handed to the common layer, including anything it must refuse or discard. */
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
 * Apply the text-only admission: refuse content features, discard capability declarations.
 *
 * Content features are refused with a stable `UNSUPPORTED_OPTION` failure naming them: the common
 * layer must never silently drop or reinterpret content the caller meant the model to see
 * (architecture §8.3). Capability declarations are returned instead of refused — the caller can then
 * *declare* what it discarded, which is what keeps the drop explicit rather than silent. They are
 * never executed here: this contract has no execution path for them at all, and admits only the
 * text-shaped semantic input.
 *
 * @param candidate - the turn candidate, or any request-shaped value.
 * @returns the capability declarations present and discarded (empty when there were none).
 * @throws {WebChatError} `UNSUPPORTED_OPTION` when a content feature is present.
 */
export function rejectUnsupportedWebChatFeatures(candidate: unknown): readonly WebChatCapabilityFeature[] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
  const record = candidate as Record<string, unknown>;
  const present = UNSUPPORTED_WEB_CHAT_FEATURES.filter((feature) => carriesFeature(record[feature]));
  const refused = present.filter((feature) => !(WEB_CHAT_CAPABILITY_FEATURES as readonly string[]).includes(feature));
  if (refused.length > 0) {
    throw webChatError(
      "UNSUPPORTED_OPTION",
      `The WebChat common layer is text-only; unsupported request features: ${refused.join(", ")}.`,
      { providerDetail: { unsupported: refused } },
    );
  }
  return present as readonly WebChatCapabilityFeature[];
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
 * Refuses content features first (so a caller always learns what the layer cannot carry), then
 * validates and normalizes the semantic input. Only admitted fields survive, so a driver can never
 * observe provider-irrelevant request state through this contract, and a capability declaration can
 * never reach a driver — accepting it cannot execute anything.
 *
 * @param candidate - the turn candidate.
 * @returns the normalized semantic input.
 * @throws {WebChatError} `UNSUPPORTED_OPTION` for content features outside the text-only layer.
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
