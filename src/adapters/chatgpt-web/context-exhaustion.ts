export type ChatGptContextExhaustionVariant =
  | "maximum-conversation-length"
  | "conversation-too-long";

export interface ChatGptContextExhaustionObservation {
  role?: string | null;
  testId?: string | null;
  ariaLabel?: string | null;
  text: string;
  actionLabels: readonly string[];
  withinAssistantTurn?: boolean;
}

export interface ChatGptContextExhaustionSignal {
  kind: "context_exhausted";
  variant: ChatGptContextExhaustionVariant;
  source: "surface-structure";
  text: string;
}

const CONVERSATION_TERMS = [
  /\bconversation\b/i,
  /\bconversaci[oó]n\b/i,
  /\bconversazione\b/i,
  /\bconversa[cç][aã]o\b/i,
  /\bunterhaltung\b/i,
  /对话|對話|聊天/i,
  /会話|チャット/i,
  /대화|채팅/i,
];

const MAX_LENGTH_TERMS = [
  /maximum length/i,
  /max(?:imum)? conversation length/i,
  /conversation(?: is| has become)? too long/i,
  /reached the maximum length/i,
  /longitud m[aá]xima/i,
  /conversaci[oó]n(?: es| se ha vuelto)? demasiado larga/i,
  /longueur maximale/i,
  /conversation(?: est| est devenue) trop longue/i,
  /maximale l[aä]nge/i,
  /unterhaltung(?: ist)? zu lang/i,
  /lunghezza massima/i,
  /conversazione(?: [eè] troppo lunga|troppo lunga)/i,
  /comprimento m[aá]ximo/i,
  /conversa[cç][aã]o(?: est[aá]) longa demais/i,
  /最大长度|最大長度|太长|太長/i,
  /最大.*長さ|長すぎ/i,
  /최대 길이|너무 깁니다/i,
];

const NEW_CHAT_ACTION_TERMS = [
  /\bnew chat\b/i,
  /\bnew conversation\b/i,
  /\bstart(?:ing)? a new (?:chat|conversation|one)\b/i,
  /\bnuevo chat\b/i,
  /\bnueva conversaci[oó]n\b/i,
  /\bnouveau chat\b/i,
  /\bnouvelle conversation\b/i,
  /\bneuer chat\b/i,
  /\bneue unterhaltung\b/i,
  /\bnuova chat\b/i,
  /\bnuova conversazione\b/i,
  /\bnovo chat\b/i,
  /\bnova conversa[cç][aã]o\b/i,
  /新聊天|新对话|新對話/i,
  /新しいチャット|新しい会話/i,
  /새 채팅|새 대화/i,
];

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

function variantFor(value: string): ChatGptContextExhaustionVariant | undefined {
  if (/maximum length|reached the maximum length/i.test(value)) return "maximum-conversation-length";
  if (/too long|too long,? please start/i.test(value)) return "conversation-too-long";
  if (/longitud m[aá]xima|maximale l[aä]nge|longueur maximale|lunghezza massima|comprimento m[aá]ximo|最大长度|最大長度|最大.*長さ|최대 길이/i.test(value)) {
    return "maximum-conversation-length";
  }
  if (/demasiado larga|trop longue|zu lang|troppo lunga|longa demais|太长|太長|長すぎ|너무 깁니다/i.test(value)) {
    return "conversation-too-long";
  }
  return undefined;
}

export function detectChatGptContextExhaustion(
  observation: ChatGptContextExhaustionObservation,
): ChatGptContextExhaustionSignal | undefined {
  if (observation.withinAssistantTurn === true) return undefined;

  const role = normalizedText(observation.role).toLowerCase();
  const testId = normalizedText(observation.testId).toLowerCase();
  const ariaLabel = normalizedText(observation.ariaLabel);
  const text = normalizedText(observation.text);
  const actions = observation.actionLabels.map(normalizedText).filter(Boolean);
  const semanticSurfaceText = [ariaLabel, text, testId].filter(Boolean).join(" ");
  const combined = [semanticSurfaceText, ...actions].filter(Boolean).join(" ");
  if (!combined) return undefined;

  const structuralSurface = role === "alert"
    || role === "dialog"
    || role === "status"
    || /(?:error|context|length|limit|conversation)/i.test(testId);

  if (!structuralSurface) return undefined;
  // Conversation evidence must come from the error surface itself, not from a "New chat" button.
  if (!hasAny(semanticSurfaceText, CONVERSATION_TERMS)) return undefined;
  if (!hasAny(semanticSurfaceText, MAX_LENGTH_TERMS)) return undefined;
  if (!hasAny(actions.join(" "), NEW_CHAT_ACTION_TERMS)
    && !hasAny(semanticSurfaceText, NEW_CHAT_ACTION_TERMS)) {
    return undefined;
  }

  const variant = variantFor(semanticSurfaceText);
  if (!variant) return undefined;

  return {
    kind: "context_exhausted",
    variant,
    source: "surface-structure",
    text,
  };
}
