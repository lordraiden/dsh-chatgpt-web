/**
 * The operator console's content catalogue: one entry per setting the console explains.
 *
 * This is the single source of the *words* the console shows. The console renders the same record in
 * its section cards and in its reference table, so an explanation cannot say one thing in "Chat" and
 * another in "Reference". It carries no behaviour, no default resolution and no validation: those stay
 * with their owners (`src/config.ts`, `endpoint-profiles.ts`, the provider config). A wrong default
 * here is a documentation bug, never a runtime one.
 *
 * Every field answers the operator's question, in this order: *what does it do*, *when would I change
 * it*, *what does it affect*, *what is the default*, and — when it overlaps with something else —
 * *which one wins*.
 */
export interface ConsoleSettingDoc {
  /** Stable id, also the anchor the reference links to. */
  readonly id: string;
  /** The operator-facing name. */
  readonly label: string;
  /** Where the setting lives: the console section that owns it. */
  readonly section: "chat" | "endpoints" | "memory" | "security";
  /** What it does. */
  readonly what: string;
  /** When to change it. */
  readonly when: string;
  /** What it affects. */
  readonly affects: string;
  /** The default, as the operator would see it. */
  readonly defaultValue: string;
  /** Which setting wins when two of them overlap. */
  readonly precedence?: string;
  /** A relationship with a system this bridge does not configure. */
  readonly external?: string;
}

/** Every setting the console explains. */
export const CONSOLE_SETTINGS: readonly ConsoleSettingDoc[] = [
  {
    id: "chatVisibility",
    label: "Chat visibility",
    section: "chat",
    what: "Whether a turn runs in a Temporary Chat (no conversation id, nothing in the account's history) "
      + "or in a persistent chat the bridge can continue.",
    when: "Keep Temporary Chat for a memory backend or any client that sends its own transcript; use "
      + "persistent when the client relies on the bridge to remember the conversation.",
    affects: "Every turn that does not select an endpoint profile with its own visibility.",
    defaultValue: "persistent",
    precedence: "The endpoint profile's value wins for turns on that profile; the provider-scoped "
      + "webChat.providers[\"chatgpt-web\"].chatVisibility pin wins over the global value.",
  },
  {
    id: "profileChatVisibility",
    label: "Profile chat visibility",
    section: "endpoints",
    what: "The visibility a turn uses when it arrives through /p/<name>/v1.",
    when: "When one client needs Temporary Chat and another needs a persistent conversation against the "
      + "same account.",
    affects: "Only turns on that profile.",
    defaultValue: "inherits the global value",
    precedence: "This value is authoritative for its profile: it wins over the global and the "
      + "provider-scoped value.",
  },
  {
    id: "composerCharLimit",
    label: "Composer character limit",
    section: "chat",
    what: "The largest prompt the bridge will type into the ChatGPT composer.",
    when: "Only if the provider's own limit changes; a value above the real limit makes the turn fail at "
      + "send time.",
    affects: "The context budget: a prompt above it is refused before the browser is opened.",
    defaultValue: "120000 (measured on a Free account)",
  },
  {
    id: "responseDomGraceMs",
    label: "Response DOM grace",
    section: "chat",
    what: "How long the bridge keeps watching for the assistant's first visible text before it treats the "
      + "turn as silent.",
    when: "A slow account that routinely takes longer to show the first token.",
    affects: "First-response detection only, not the total turn time.",
    defaultValue: "60000 ms",
  },
  {
    id: "responseDomGraceMaxMs",
    label: "Response DOM grace ceiling",
    section: "chat",
    what: "The upper bound the per-character grace may grow to for a long prompt.",
    when: "Only alongside composerCharLimit, when prompts are much larger than usual.",
    affects: "The same first-response window, capped.",
    defaultValue: "240000 ms",
  },
  {
    id: "responseDomGracePerCharMs",
    label: "Response DOM grace per character",
    section: "chat",
    what: "How much extra first-response time each character of prompt buys.",
    when: "Rarely; it exists to scale the grace with prompt size.",
    affects: "The first-response window, bounded by the ceiling above.",
    defaultValue: "2.5 ms per character",
  },
  {
    id: "sendEnableGraceMs",
    label: "Send enable grace",
    section: "chat",
    what: "How long the bridge waits for the composer's send control to become usable after typing.",
    when: "A slow surface that disables send for longer than usual.",
    affects: "The send step only.",
    defaultValue: "5000 ms",
  },
  {
    id: "generationRunningStallMs",
    label: "Generation stall budget",
    section: "chat",
    what: "How long one continuous visible generation may run without new text before the bridge treats "
      + "it as stuck.",
    when: "A route that legitimately generates for many minutes (Free and Think do).",
    affects: "One generation window, never the total turn time.",
    defaultValue: "900000 ms",
  },
  {
    id: "turnTimeoutMs",
    label: "Turn timeout",
    section: "chat",
    what: "The bridge's own absolute clock for one turn. When it expires the turn is declared lost with a "
      + "typed 504 (turn_timeout), not a provider failure.",
    when: "Keep it below the timeout of whatever calls the bridge, so a caller can fail over instead of "
      + "abandoning a live turn.",
    affects: "Every turn; the browser turn is aborted when it expires.",
    defaultValue: "900000 ms (the deployment sets 540000)",
    external: "Hindsight waits HINDSIGHT_API_LLM_TIMEOUT (600 s). Keep this value below it.",
  },
  {
    id: "partialOnTurnTimeout",
    label: "Partial answer on timeout",
    section: "chat",
    what: "When the turn clock expires, return the text the model already produced with "
      + "finish_reason \"length\" instead of a 504.",
    when: "For a chat client that prefers a partial answer to an error. Not for a structured caller: a "
      + "truncated JSON is unusable.",
    affects: "The turn-timeout outcome only.",
    defaultValue: "off",
    precedence: "Off unless chatgptWeb.partialOnTurnTimeout or DSH_CHATGPT_WEB_PARTIAL_ON_TIMEOUT is set.",
  },
  {
    id: "profileModels",
    label: "Profile model allowlist",
    section: "endpoints",
    what: "Which catalogue rows a turn on this profile may request.",
    when: "To keep one client on one route, or to fail a wrong model id at the profile instead of at the "
      + "provider.",
    affects: "Only turns on that profile; the rows still come from the public catalogue.",
    defaultValue: "every catalogue row",
  },
  {
    id: "profileMaxConcurrentTurns",
    label: "Profile concurrent turns",
    section: "endpoints",
    what: "How many turns this profile may have in flight at once.",
    when: "When one client must not consume the whole account's fan-out.",
    affects: "Admission for that profile only; a turn above it is refused with a typed 429.",
    defaultValue: "unlimited (bounded by the process-wide limit)",
    precedence: "The process-wide DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS still applies on top.",
  },
  {
    id: "memoryRouting",
    label: "Memory backend routing",
    section: "memory",
    what: "Which endpoint each memory operation (retain, consolidation, reflect) calls, rendered as the "
      + "client's environment block.",
    when: "When the memory backend should use a profile, an external URL, or no override at all.",
    affects: "The client's configuration only: the console writes an env block, it does not configure the "
      + "client.",
    defaultValue: "the client's own global chain",
    external: "The block is for Hindsight (HINDSIGHT_API_<OP>_LLM_*); it is pasted into that service, not here.",
  },
  {
    id: "doctor",
    label: "Doctor probe",
    section: "chat",
    what: "Runs the CLI's own doctor, including one real browser turn.",
    when: "When a turn fails and you need to know whether the session, the catalogue or the provider is "
      + "the problem.",
    affects: "Nothing persistent; it costs one real turn.",
    defaultValue: "not run",
  },
  {
    id: "apiKeyVsControlToken",
    label: "API key vs control token",
    section: "security",
    what: "The API key authenticates /v1/* callers; the control token authenticates /v1/control/* and "
      + "/admin/*. They are different credentials with different scope.",
    when: "Never interchangeable: a client that calls the completion API needs the API key, an operator "
      + "page needs the control token.",
    affects: "Every request: a control token on /v1/* is refused, and an API key on /v1/control/* is "
      + "refused.",
    defaultValue: "both required (a non-loopback bind always has an API key)",
  },
];

/** The settings of one console section, in catalogue order. */
export function consoleSettingsFor(section: ConsoleSettingDoc["section"]): readonly ConsoleSettingDoc[] {
  return CONSOLE_SETTINGS.filter(setting => setting.section === section);
}
