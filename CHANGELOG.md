# Changelog

## Unreleased

## 1.4.3

- Survive a Temporary Chat re-render mid-turn. 1.4.2's position fallback stopped the abort but exposed
  the next assumption: a re-render can change an identity's **scheme** (the provider attribute
  disappears and the position fallback takes over) without adding a turn, and the bridge read that as
  "another user turn" and aborted. The check now compares counts, so a scheme change is a re-render and
  a genuinely new turn (which increases the count) is still refused. A rebound turn whose identity is
  `position-turn-<n>` now resolves its locator by position on the assistant-turn selector instead of an
  attribute selector that would match nothing.

## 1.4.2

- Fix the turn that failed with "ChatGPT conversation turn has no stable identity". The identity
  resolution **threw** when a turn element did not expose a `conversation-turn-*` / `fallback-turn-*`
  attribute, which the Temporary Chat surface does after a re-render — aborting a turn whose answer was
  already visible (observed live on a consolidation turn). The identity is used for change detection
  and duplicate detection, not as a protocol value, so it now falls back to the element's position
  (`position-turn-<n>`), which is stable for an ordered, append-only conversation and cannot collide
  with a provider id. A repeated provider id is still refused.

## 1.4.1

- A failed browser turn now logs a **sanitized message** next to its descriptor. The line said
  `name=Error code=unknown` and nothing else, which is exactly the case that cannot be diagnosed: a
  plain `Error` (the Markdown-consistency and DOM-health checks are the usual ones) carries its reason
  in the message, and the descriptor deliberately omits it. The message goes through the same
  redaction the sign-in diagnostics use — URLs removed, whitespace collapsed, cut to 300 characters —
  so a failure names its check without carrying page text.

## 1.4.0

- The operator console becomes **one page with one authentication**. It replaces the "three documents
  and no map" shape (and the per-page token cards) with a single document that authenticates once and
  then shows, explains and edits everything:
  - **Overview** — version, mode, accepting turns, live counters, effective visibility, catalogue size.
  - **Visibility** — the global default **and** every profile's override in one table, so the
    precedence is visible: a profile's value wins for turns on that profile.
  - **Profiles** — the endpoint-profile editor, moved in (create, edit, delete).
  - **Tuning** — the transport knobs grouped by the stage they affect.
  - **Memory** — the per-operation routing generator.
  - **Doctor** — the probe, with its cost stated.
  - **Reference** — every setting: what, when, affects, default, precedence.
  The token is the same `sessionStorage` key the standalone pages use, so one entry unlocks both; the
  API key is explicitly named as a different credential. Writes still go through the existing
  `PUT /v1/control/config` and `/v1/control/endpoint-profiles*`, and a refusal is shown as the owner
  returned it. The standalone pages keep working.

## 1.3.1

- Fix the operator console's data paths and links. The console is served at `/v1/control/` **and**
  `/v1/control/console/`, so the relative `../status` inherited from the settings page resolved to
  `/v1/status` from the first alias and the page answered `401` after the token was accepted. Every
  data path and link is now a same-origin absolute path (`/v1/control/status`, `/v1/control/config`,
  `/v1/control/settings/`, …), which is the only shape that works from both aliases; the test pins it.

## 1.3.0

- New **operator console** at `/v1/control/`: one entry point for every operator surface, with a
  navigation that names each one and a reference that explains **every** setting — what it does, when
  to change it, what it affects, its default, and which value wins when two overlap (global vs profile
  visibility, profile concurrency vs the process-wide limit, the bridge's turn clock vs the memory
  backend's timeout). The console is a client like the pages it links to: it owns no validator, no
  routing decision and no probe, and the controls stay on their own pages. The explanations come from
  one catalogue (`src/web-chat/host/console-content.ts`), so a setting cannot be described one way in
  a section and another way in the reference. Served anonymously by design, control token in
  `sessionStorage`, no data, no secret, no absolute URL; the inline script compiles (the 1.1.1 lesson).

## 1.2.5

- Optional: return the **partial answer** when the turn clock expires, instead of discarding it. A
  generation that hits the provider's output budget on this account never completes — the bridge waits
  for a completion action that does not arrive, and the turn dies on its own clock with `504
  turn_timeout`, throwing away 14 000+ visible characters. With
  `chatgptWeb.partialOnTurnTimeout: true` (or `DSH_CHATGPT_WEB_PARTIAL_ON_TIMEOUT=1`) the turn instead
  concludes with the text it already has and `finish_reason: "length"`, and logs
  `turn_timeout partial=true chars=<n>`. **Off by default**: without the switch the `504 turn_timeout`
  behaviour is unchanged, and a malformed switch value fails closed naming the variable. The other
  deadline checks (multipart and observation) still throw.

## 1.2.4

- The truncation probe now runs every 30 seconds while a turn is waiting, instead of only when the
  generation has stopped. A live truncation kept `running=true` for ten minutes (the Stop control never
  disappeared), so the previous probe could never fire; a periodic probe records the affordance the
  moment it appears, with `running` and the visible character count. Only presence is logged: a
  periodic "absent" line would drown the log, and the completion-time probe already proves absence on
  ordinary turns.

## 1.2.3

- The structured-output instruction now forbids web search. Observed live: a `response_format`
  request whose answer triggered ChatGPT's own web search came back as Markdown prose with a citation
  and ignored the schema entirely, so a structured caller lost the turn. The instruction says "Do not
  use web search or cite sources: answer from the conversation only", in both the `json_object` and
  `json_schema` modes. Same soft enforcement as the rest of `response_format`: it is an instruction,
  not a guarantee, and a reply that still ignores it is the caller's schema validation.

## 1.2.2

- Record the truncation affordance where it actually appears. A generation cut by the output budget
  stops **without** the completion action and leaves a "continue generating" affordance instead, so the
  turn never completes: it stalls until the bridge's own clock kills it (observed as
  `12-response-stalled-30s` with 14 207 visible characters and `completionActionVisible=false`). The
  probe now fires when the generation has stopped and no completion action is present — the truncation
  signature — and logs `truncation-affordance-stall` with the visible character count. No behaviour
  change yet: the turn still waits; this is the evidence the terminal mapping needs.

## 1.2.1

- Two surface diagnostics, recorded as one sanitized line per event and with no behaviour change:
  - `truncation-affordance` at turn completion — whether ChatGPT left a "continue generating"
    affordance behind (localised labels included). The bridge still reports `finish_reason: "stop"`
    because it cannot prove the reason yet; this line is the evidence that decides a future
    `stopReason: "max_tokens"` mapping.
  - `rate-limit-dialog` before a rate-limit refusal — the dialog's own text (truncated, whitespace
    collapsed) and its action labels, which is what a future `Retry-After` parser has to match.
  Both carry labels and counts only: no prompt text, no credential, and a diagnostic can never fail a
  turn.

## 1.2.0

- `doctor` gains a `model-availability` check: it reports which catalogue rows the configured account
  can actually serve (`available` / `unavailable` / `unknown`), from the one route authority the
  refusal path uses. Pure configuration — no browser, no network, no credential — and an unknown
  capability state is a `warning`, never a failure. Pointing a client at a row the account cannot
  answer is a typed `400` on the first call; this surfaces it before a real request.
- New operator **settings page** at `/v1/control/settings/`: status (version, account tier, session
  health, catalogue, `turnQueue`, `turnAccounting`), chat visibility and the live-editable tuning
  fields, a link to the endpoint profiles, a **memory-backend routing generator** (per operation:
  bridge profile, external base URL or disabled, rendered as a copy-paste env block with placeholders
  only) and a doctor button that warns it performs one real browser turn. Same authority boundary as
  the other operator pages: served anonymously by design, every data endpoint control-token guarded,
  no secret in the page, a URL or a log. New control endpoints: `GET /v1/control/catalogue` and
  `POST /v1/control/doctor`.
- README correction: `chatgpt-web/luna`/`think` are the **Luna-only** account's rows, not "every
  account" — a Sol account is served `light`/`medium`/`high` instead. The catalogue table was already
  correct; two prose claims were not.

## 1.1.3

- Normalize invalid JSON escapes in a structured reply. A consumer-web model renders JSON keys as if
  they were Markdown, so a key `max_tokens` came back as `"max\\_tokens"`; JSON has no `\\_` escape, so
  the reply was invalid and a structured caller (a memory backend's reflect loop) lost the turn on
  every attempt. When the request asked for `response_format`, the surface now drops the backslash of
  every escape JSON does not define. It is a **transport** normalization, not schema enforcement:
  nothing is validated, reordered or invented, every valid escape is preserved byte-for-byte, and a
  request without `response_format` still receives the model's text verbatim. Streaming replies are
  not normalized (a delta boundary can split an escape); the documented structured caller path is
  non-streaming.

## 1.1.2

- Harden the structured-output instruction: it now explicitly forbids escaping characters inside JSON
  string values (no backslashes before underscores or asterisks, no Markdown escaping). A consumer-web
  model that Markdown-escaped a key (`"max\\_results"`) produced invalid JSON, and a structured caller
  rejected every such reply as a parse error. The instruction is the only lever this bridge has — it
  carries a schema as text and never parses or repairs the reply — so the wording is now explicit.

## 1.1.1

- Fix the endpoint-profiles page at `/v1/control/endpoints/`: an escaped quote written inside the
  page's TypeScript template literal resolved into the served document, which broke its inline script
  at parse time. No handler was registered, the native form submit is blocked by the page's
  `form-action 'none'` CSP, and the result was an operator clicking "Use token" and seeing nothing
  happen. The page's script now compiles, and a regression test compiles the exact string the server
  serves for both operator pages (endpoint profiles and sign-in), so a template-literal escape can
  never silently disable a page again.

## 1.1.0

- `POST /v1/chat/completions` accepts the OpenAI structured-output shapes: `{"type":"json_object"}` and
  `{"type":"json_schema","json_schema":{"name","strict","schema"}}`. A consumer web chat has no native
  schema channel, so the schema is carried into the turn as text on the internal `instructions` field,
  the reply is returned **verbatim** (never parsed, repaired or re-serialized), and the response
  declares the soft mode with `x-dsh-chatgpt-web-structured-output: soft`. `{"type":"text"}` and a
  request without `response_format` are unchanged, and a malformed or unknown shape is a typed `400`
  (`error.code: invalid_response_format`) before any provider work.
- `max_completion_tokens` is accepted as an alias of `max_tokens`; sending both with different values is
  a typed `400` (`conflicting_max_tokens`) instead of silently picking one. `finish_reason` is
  `"length"` only for the one provable truncation signal (`status:"incomplete"` with
  `incomplete_details.reason:"max_output_tokens"`), in both the batch body and the streaming terminal
  frame; every other incomplete reason keeps `"stop"`, because relabelling a filter, cancel or EOF
  would invent a signal the provider never reported.
- Configurable ChatGPT conversation visibility: `chatgptWeb.chatVisibility` is `persistent` (default,
  history-visible, ChatGPT memory applies, provider continuity kept) or `temporary` (ChatGPT Temporary
  Chat: no history, no memory, no continuity). It flows through the one provider-facts resolver, is
  overridable through `webChat.providers["chatgpt-web"]`, and is readable and writable through
  `GET`/`PUT /v1/control/config` with live reload. A temporary turn claims no conversation key, records
  no installed-prefix fingerprint and publishes no conversation handle: it replays the caller's
  canonical history explicitly, and the features that need a retained provider conversation fail closed.
  `temporary` on the launcher browser host is refused rather than silently running persistent.
- Endpoint profiles: `POST /v1/control/endpoint-profiles` (and the page at
  `/v1/control/endpoints/`) exposes named public endpoints under `/p/<name>/v1`, each with its own chat
  visibility, optional catalogue-model allow-list and optional turn budget. A profile is a host-owned
  view over the configured catalogue — no new provider, route or execution engine — the API key stays
  global, `/p/<name>/v1/models` advertises exactly what the profile serves, and a deleted profile's
  path answers a typed `404` instead of falling back to the default endpoint.
- The account fan-out bound is now a bounded wait instead of an immediate refusal: a turn that finds
  all `MAX_CHATGPT_BROWSER_TABS` slots in use waits for one, and is refused with a typed `429`
  (`turn_queue_timeout` / `turn_queue_full`) carrying `Retry-After` only when the wait budget or the
  queue depth is exhausted. Housekeeping turns are served before conversational ones, one caller cannot
  hold every slot while another waits, and `GET /v1/control/status` publishes `turnQueue` (depth,
  grants, wait times, refusals, per caller). The bound itself is unchanged.
- `GET /v1/control/status` publishes `turnAccounting`: per-request and per-operation browser turns,
  continuations, replayed messages and characters, the wait for an account slot, and the operation
  fingerprint. Fields are absent — never zero — when the fact never happened, and no prompt text, raw
  identity, conversation key or credential appears in the snapshot.
- `doctor` gains a structured-output probe that proves an authenticated OpenAI-compatible request end
  to end (one real browser turn on a stable probe conversation) and reports `ok`, `warning`, `error` or
  `skipped` — skipped, never failed, when the deployment has no API key or the service is not
  listening. It reports the measured latency and the estimated token usage, and never prints the key.
- Documentation: a real Configuration section (data volume, the fields an operator touches, the two
  separate credentials), a ChatGPT setup walkthrough, an explicit
  temporary-vs-persistent comparison, structured-output documentation with its documented limit, and
  TROUBLESHOOTING §17–§21 for `400 response_format`, `finish_reason`, the queue `429`, an expired
  provider session and the temporary-surface readiness risk.

- The project header now opens the first turn that carries a **human message**, and the decision is
  recorded state instead of an inference from the provider's chat id (Qwen Chat, operator report on
  `chat.qwen.ai`). The install used to be "the turn that creates the chat"
  (`!planned.replay && planned.chat === undefined`), so a conversation whose Qwen chat already existed —
  created by anything that is not the caller's human turn — got **no** header on the first real message.
  The provider's conversation record now stores the install fact (`humanMessageSent`,
  `src/adapters/qwen-chat/chat-state.ts`), the header installs on the first turn where it is absent, and
  the fact survives a replay's generation change. A state file written before the fact existed (a chat,
  no flag) is adopted as "already installed": re-headering a live conversation would duplicate the
  header. Every existing property holds — a continuation sends only the new text, a replay rebuilds
  canonical history with no header, a declared-purpose turn and the Advisor seam carry none, an install
  with no human message is refused, unresolvable metadata omits the header. **Stated plainly:** the
  harness's session-title call still arrives *undeclared* (`@earendil-works/pi-ai` drops `purpose`), so
  when that call reaches the provider first it is indistinguishable from a human turn and consumes the
  install; the bridge honours both declared channels (`purpose` in the native metadata, or the
  `x-dsh-turn-purpose` header a static per-route header carries), and `doc/qwen-chat.md` §3.3 records the
  one-step operator fix (point the title route at a provider entry carrying that header).

- DeepSeek Web publishes its measured model with **no configuration** (operator report: the model could
  not be selected). The adapter used to publish no rows at all, because DeepSeek's model list is a
  session-only remote setting. The signed-in capture read that setting and settled exactly one **enabled**
  row, so the provider now seeds it: `deepseek-web/default`, label "DeepSeek Chat", and both toggles on
  (`thinking`, `search` — the state both captured completions carried), while `expert`/`vision` stay
  unseeded because the same answer marks them `enabled: false`. `/v1/models` publishes that row and
  `/v1/chat/completions` accepts it out of the box. A `webChat.providers["deepseek-web"]` block is still
  how an operator overrides the row or extends the list (an entry keeps the seeded defaults of its id for
  the fields it omits), an unknown entry field is now a typed configuration error instead of being
  silently ignored, and an explicit empty `modelTypes` list remains the only "serve nothing" state.
  `doc/deepseek-web.md`, `README.md` and `TROUBLESHOOTING.md` no longer tell the operator to configure it.

- DeepSeek Web's continuation is now the measured one (capture of 2026-10-24, second interaction). The
  captured ids are **JSON numbers**, and the adapter read `ready.response_message_id` as a string only,
  so it dropped the cursor and every continuation sent `parent_message_id: null` — not the cursor the
  recorded app sends. The id is now kept with the scalar the provider sent it as (`DeepSeekMessageId`,
  numbers included, never coerced) through the stream parser, the continuity state and the completion
  body. The second measured difference is also reproduced: a session's first turn declares `model_type`
  and a **continuation sends `null`** (the session owns the model; the provider's `ready.model_type` is
  still surfaced by the re-route diagnostic). `doc/deepseek-web.md` §3 records the key-by-key
  difference between the two captured turns.

- A slow session-title call can no longer fail a ChatGPT Web turn (#336 follow-up, operator report on
  `chatgpt-web/think`). The harness's housekeeping call arrives **undeclared** (`@earendil-works/pi-ai`
  drops `purpose`), so it takes the same conversation as the user's real turn. The ChatGPT native route
  already waited for that holder, but only for its own provider-specific 30 s bound; a measured title
  call took 1 m 5 s, outlived the bound, and the operator's message was refused with
  `Another turn is already using this ChatGPT Web conversation; concurrent turns of one chat are not
  allowed.` (`PI_AI_ERROR`) while the title itself had no answer. The bounded, cancellable,
  event-driven admission now has **one owner** (`src/web-chat/transport/conversation-admission.ts`)
  shared by the ChatGPT provider core and the text providers' transport lease, with one bound,
  `DEFAULT_TRANSPORT_ADMISSION_WAIT_MS` (60 s — the housekeeping call's own measured deadline). The
  ChatGPT per-conversation exclusivity, the account fan-out bound (#201/`MAX_CHATGPT_BROWSER_TABS`) and
  the `retained_surface_busy` category (#305) are unchanged. A refusal at admission still happens
  **before** any submission, so it leaves nothing to reconcile or adopt: the operator's turn was never
  sent, and the title call's empty answer is the harness's own housekeeping deadline/cancellation, not a
  lost reply to the operator's message.

- Serialise a housekeeping call and a real turn of the same conversation instead of refusing one of
  them (issue #336, operator report on the Qwen Code selector). The harness issues its session-title
  call at the same moment as the user's first message, and `@earendil-works/pi-ai` never maps
  `GenerateOptions.purpose` onto an OpenAI-compatible wire, so the call arrives with **no declared
  purpose**: the service classifies it as a conversational turn, it takes the conversation's single
  transport resource, and the user's first message — arriving during that window — was refused by the
  shared transport lease with `Another exchange still owns this conversation's transport resource`
  (`PI_AI_ERROR` at the caller). The shared transport owner
  (`src/web-chat/transport/transport-lease.ts`) now carries a **bounded, event-driven, cancellable
  admission** on the conversation key, taken before the continuity decision and released when the turn
  ends, and the Qwen Code, Qwen Chat and DeepSeek Web compositions use it with
  `DEFAULT_TRANSPORT_ADMISSION_WAIT_MS` (60 s, the harness housekeeping call's own measured deadline). A
  transient overlap now waits and both turns complete; exclusivity is preserved (one conversation never
  runs two provider turns at once); a genuine contention still fails closed with the same category and
  message when the bound expires; and a registry constructed without a bound keeps the historical
  immediate refusal for direct callers. Provider-neutral, outside `src/web-chat/core/**`, no new
  dependency. ChatGPT Web already had its own bounded admission
  (`ChatGptWebProviderCore.acquireConversationAdmission`); this is the same rule at the shared layer the
  other providers use. Stated plainly: after this, a first message to a Qwen (or DeepSeek) provider is
  DELAYED by the housekeeping call rather than failed, and the undeclared housekeeping call still shares
  the session's conversation — making it ephemeral still requires the harness to declare its purpose,
  which this build cannot do from configuration.

- Relay a **drag** through the interactive sign-in surface, so a slider/puzzle verification can be
  answered at all (found while signing in to Qwen Code, issue #299). Two independent gaps blocked it:
  the neutral `AuthInput` vocabulary had no way to express a pressed pointer moved along a path, and
  the relayed page turned every `pointerdown` into a click with no pointer-move path. `AuthInput` now
  carries `{type:"drag", points:[{x,y,atMs}]}` — an ordered sampled path in the same frame
  coordinates as `click`, press first and release last, with each sample's own offset — validated
  like every other input (finite coordinates, at least two points, non-negative and non-decreasing
  timestamps; no clamping). The page captures the operator's real `pointerdown` → throttled
  `pointermove` samples → `pointerup` (pointer capture included, so a release off the picture is
  still seen), publishes `data-drag-sample-ms` / `data-drag-move-threshold-px`, shows
  `#pointer-relay[data-pointer-relay]` while the gesture is live, and sends one drag input; a press
  that does not travel is still relayed as the click it always was. Both controllers replay the
  samples in order with `page.mouse.move/down/up` (one move per sample, no interpolation), pace the
  moves by the carried offsets within a bounded relay budget, and release the button on every failure
  path. No stealth, no UA change, no synthetic motion, no new dependency. What a real captcha does
  with a relayed human drag is unverified; a rejection there is a finding to report, not to disguise.

- Correct the drag relay's replay timing, sample count and release point (issue #299 follow-up, from an
  operator report on a live slider captcha). A 3 s gesture previously took ~4.2 s to replay because each
  `page.mouse.move` already costs about a frame (~17 ms measured) and the controller then slept the
  sample's full delta on top of it. The page now samples at 32 ms — a coarser sampled real path, capped
  at 64 samples by doubling the interval and thinning to every other real point when full — and both
  controllers schedule against the press's own clock, sleeping only the remainder of each offset inside
  a 1 s pacing budget. The same 3 s gesture now replays in ~1.5 s, and a 1 s gesture in ~1 s. The release
  is the mapped `pointerup`, always appended and never the last throttled `pointermove`; mapping keeps
  the exact fractional displayed scale with no integer truncation before scaling, so a screen point has
  one provider coordinate through both the click and drag paths. No stealth, no UA change, no
  interpolation and no new dependency; whether the captcha accepts the relayed path is still a
  live-only question.

- Recognize the harness's runtime-context snapshot in `sanitizeConversationText`, so a session-addressed
  turn whose only `user` message is that block is refused instead of answered (issue #307 follow-up,
  proven against the deployed service). The previous refusal test used the shorter time-snapshot text,
  which the operational-line filter already emptied; the block the harness actually sends — the
  `Current runtime context. …` preamble followed by its `Current <thing>:` / `Approval …:` sections —
  survived as human content and reached ChatGPT Web. The rule stays in the sanitizer, the product's one
  owner of "what is host context": the preamble marks the block and the contiguous run of blank
  separators and section-key lines is consumed with it, so the block empties, a human instruction in the
  same message survives, and prose that merely mentions a phrase like "current working directory" is
  left untouched. No per-call-site special case and no second marker list; the stateless branch, the
  capability/content policy, authority/auth, retention bounds, #301/#302/#305 and the ephemeral path are
  unchanged.

- Refuse a session-addressed turn whose only human content is the host's own context, at the surface,
  before the turn exists (issue #307 follow-up). The message projection already transmitted the newest
  `user` message that still carries human content, so a request ending with the harness's runtime
  snapshot no longer sent the snapshot in place of the human turn; when *no* `user` message carried
  human content the refusal was one flat error, indistinguishable from "you sent no user message". The
  projection now throws one typed refusal (`ApiProjectionRefusalError`) with two stable codes —
  `host_context_only_turn` (a `user` message was there, but every one of them was host context: the
  message tells the caller to send the user's actual instruction as one) and `no_user_message` (none was
  there at all) — and `/v1/chat/completions` publishes the code on its typed `400` (`error.code`) instead
  of leaving the caller to match prose. The refusal happens before the turn exists: no provider run,
  nothing sent to the browser, no conversation state written — the durable store stays byte-identical,
  the conversation's generation does not move, and the next real turn still continues the same
  conversation. Recognition of housekeeping by text stays out of scope: the only notion of host context
  is `sanitizeConversationText`. The stateless branch, the capability/content policy, the install
  compiler refusals, authority, retention bounds, #301/#302/#305 behaviour and the ephemeral path are
  unchanged.

- Make conversation admission survive a short-lived conflict, and stop a refusal from poisoning the
  conversation (#305 follow-up). Measured in a real deployment: a DSH harness's session-title call and
  the user's first message share one provider conversation (identity = session id), the title wins the
  race, and the user's turn was refused in ~0 ms with `retained_surface_busy` — the first message of
  *every* new session. The refusal was correct but the conflict was transient, and the refusal left the
  conversation unusable: the next attempt failed with "the last attempt on this conversation was never
  confirmed; the provider must reconcile it before it can be resumed", because the refused turn's
  continuity decision had already run (a replay advances the generation and writes an unconfirmed
  record) before admission refused it. Two owners are fixed. **Admission** (`ChatGptWebProviderCore`)
  now takes one slot per native DSH thread and waits for a busy conversation to be released before
  refusing: bounded by `DEFAULT_CONVERSATION_BUSY_WAIT_MS` (30 s — 2× the measured 13.3–13.4 s
  competing turn and 2× the 15 s launcher turn-end acknowledgement, below the 60 s settlement-wait
  grace of #301), cancellable by the caller's abort, event-driven with no polling and no held timer or
  lease once it ends, and still failing closed with #305's own category and message when the bound
  expires. **Ordering**: the admission decision now precedes the continuity decision
  (`webChatContinuity.resolveRecovery`), so a turn refused at admission has written nothing: a retry
  after a pure refusal proceeds, and the poisoned state is not reachable from one. #305's category and
  message, #302 continuation, #301's bounded settlement, retention bounds, capability/content policy,
  authority and auth are unchanged; no dependency was added and no provider-specific rule was pushed
  into Core.

- Honour the caller identity the service already understands on `/v1/chat/completions`, and answer a
  harness housekeeping turn without claiming a provider conversation (issue #307). A DSH harness that
  reaches this service through an OpenAI-compatible provider adapter sends no identity at all, so the
  chat surface took its content-derived branch and one harness session became one web conversation **per
  distinct content** (measured: two harness sessions, nine ChatGPT chats). Two causes are fixed, both on
  the service side. First, the surface read identity only from `body.user`/`body.session_id` and then
  **replaced** the caller's `client_metadata`, so a caller that sent the native shape had its
  `dsh_session_id` and its turn `purpose` erased before the adapter could read them; identity now comes
  from one host reader (`src/web-chat/host/turn-identity.ts`) with the precedence the native path already
  applies (a declared session outranks a provider-private thread, which outranks `user`/`session_id`),
  the caller's own metadata fields are preserved on the way through, and the two surfaces finally agree
  about who is talking. Second, nothing consumed a turn `purpose`, so a `session-title` or `compaction`
  call was treated as the user's own turn and claimed the session's retained conversation. The
  classification is now a provider-neutral Core concept (`src/web-chat/core/turn-delivery.ts`): an
  **ephemeral** turn is answered like any other, but the provider must serve it without creating or
  retaining a conversation, without writing any of the session's conversation state, and without the
  concept leaking into provider internals — the contract, and the fail-closed requirement for a provider
  that cannot run ephemerally, are documented there. The ChatGPT adapter satisfies it through the
  retention decision it already owns (`shouldRetainChatGptWebConversation`), never by teaching the
  browser worker about `purpose`. Capability/content policy, authority, retention bounds, #302
  continuation, #301 settlement and #305's refusal category are unchanged. **Still required for "one
  harness session = one web chat": the harness has to forward the identity it already holds** — while it
  sends nothing, this change cannot fuse its turns, and `contentConversationIdentity`'s documented
  behaviour (and its newly explicit limit) is unchanged.

- Answer a session-addressed turn that ends with the harness's own runtime snapshot (issue #307
  regression). Once the caller's identity started arriving on `/v1/chat/completions` (a profile with
  `cacheRetention: "long"` puts the harness session id in `prompt_cache_key`), the message-only
  projection took its session branch and transmitted "the last `user` message" **by role alone**. The
  DSH time-context plugin appends its rendered snapshot — `Time sampled while preparing turn …`, the
  browser-time-zone line, the elapsed line — as one more `user` message *after* the human turn, so that
  branch transmitted a message whose sanitized text is empty, and every turn was refused with
  `A normal Chat Mode install must carry a human message` (generation 1) or `A retained composer install
  must carry at least one human message` (after a replacement epoch). The projection now transmits the
  newest user message that still carries human content, decided by the product's one owner of "what is
  host context" (`sanitizeConversationText`), so the projected turn and the provider's prompt compiler
  agree by construction; the projection's selection and the compiler's rule are the same rule, and host
  context still never reaches the provider. The ephemeral-turn classification is unchanged and was never
  the cause — an ephemeral turn sends no identity, so it already took the stateless branch, which is why
  the auxiliary route was never the broken path. A session-addressed request whose user messages carry no
  human content is now refused at the surface with a typed `400` naming the rule instead of failing deep
  inside the provider, and both install refusals are unchanged for a genuinely human-less install
  (asserted). No capability/content policy, authority, retention bound or #301/#302/#305 behaviour is
  touched.

- Report a concurrent-turn refusal on one conversation as its own category (issue #305). Two overlapping
  requests on the same identity used to answer `200` and, in ~0 ms, `502 upstream_server_error` with
  `ChatGPT Web cannot synchronously start a second provider turn for an active native DSH thread`. The
  refusal is correct — one active turn per logical conversation — but it is a **local admission
  decision**, and `upstream_server_error` means "the provider failed": waiting resolves the first while
  retrying makes the second worse. The admission guard and the other bare `Error` on that path (a
  cancellation callback attached twice because a turn reused the active lifecycle) now throw the existing
  conversation-busy refusal (`retained_surface_busy`, category `TRANSPORT_UNAVAILABLE`, not retryable)
  with a message telling the caller that concurrent turns of one chat are not allowed. The two seams that
  discarded the typed classification — the rejected-turn event of the Responses route, and the
  OpenAI-compatible failure mapping, which re-labelled **every** failed turn as
  `502 upstream_server_error` — now relay the category the turn already published. Admission is
  unchanged: the same refusal still happens at the same point, with the same strictness, and is returned
  concurrently instead of being queued behind the in-flight turn.

- Bound a turn's wait for a *previous* turn's physical settlement (issue #301). A retained ChatGPT page
  whose operation stopped publishing a settlement used to hold every later turn for that conversation
  forever: no error, no progress, and `/healthz` still answering `accepting_turns: true`. Every such wait
  in the turn path is now bounded by a settlement-wait grace (60 s, `DEFAULT_SETTLEMENT_WAIT_GRACE_MS`);
  the settlement owner stays the authority on the outcome, so a settlement that does land is still awaited
  in full and never cut short. When the grace expires the turn fails closed with its own typed,
  actionable category (`settlement_wait_timeout`, `503`, not retryable) — the service's own stuck-resource
  condition, never an upstream one — and the wedged session is retired: its runtime is cancelled (which is
  how the physical owner is told to abort and publish a `rejected` settlement, tombstoning the retained
  key instead of reusing it) and later turns for that conversation take the same bounded, explicit
  outcome instead of hanging, until the settlement lands and normal service resumes. This is the #291
  shutdown discipline applied to the turn path; `TROUBLESHOOTING.md` §15 records the operator response and
  why `accepting_turns` is not the stuck-work signal (`active_browser_turns` is).

- Stop refusing capability declarations on the OpenAI-compatible surface. `tools`, `tool_choice`, `mcp`
  and the legacy `functions`/`function_call` are now accepted and **discarded by design** — never
  executed, never forwarded — because the provider is a consumer web chat reached as text, with no
  execution path and no return channel to the caller's harness; a tool-sending harness gets plain chat
  instead of a 400 on every turn (the previous refusal was the bug). Nothing is silent: an affected
  response declares it in `x-dsh-chatgpt-web-ignored-features` (JSON and SSE) and the service logs one
  line per request naming what it dropped. Attached **content** is unchanged and still refused with a
  typed 400 — files, images, audio, video, attachments and non-text content parts are data the model was
  meant to see, so dropping them would be content loss. The capability/content split is owned once by the
  common layer (`WEB_CHAT_CAPABILITY_FEATURES` / `WEB_CHAT_CONTENT_FEATURES` in
  `src/web-chat/core/exchange.ts`) and recorded in `AGENTS.md` and `doc/architecture.md` so the old
  refusal is not "restored" later.
- Retire the noVNC sign-in image (issue #276 slice 3b). The remote sign-in was verified against a real
  account end to end (`/v1/control/auth/` → session stored in `providers/chatgpt-web/` → a streamed
  turn with `finish_reason: "stop"`), so the `display` fallback's noVNC image is dead weight and is
  gone: `Dockerfile.login`, `docker/entrypoint-login.sh`, the `login` Compose profile, the container
  CI noVNC probe, the publish-image sign-in steps, and every doc/quickstart instruction that told an
  operator to build or run it. `authBrowserMode: "display"` stays in the contract and in the code
  path, but now means the operator supplies a display (an X server/socket, or their own headed
  environment): the container provides none, and `headless` — the default, and what the verified sign-in
  used — is the supported path on a headless host.
- Per-provider credentials and a guided login path (issue #249): the session now lives in
  `providers/<providerId>/` inside the data volume, with the legacy single-provider path kept as a
  read alias so nothing is migrated and `config.json` is never rewritten. `auth import` adopts a
  Playwright capture **only after verifying it** against the provider's login surface and writes both
  files atomically — an unverifiable capture writes nothing — and `doctor --json` reports the resolved
  path per provider. The resolver has one owner (`src/config.ts`) and both resolution points (the CLI
  and the browser worker) use it.
- Add the OpenAI-compatible chat surface (issue #248): `POST /v1/chat/completions` (streaming and
  non-streaming) translated onto the **same** internal turn as `/v1/responses` — no second engine,
  ProviderCore or retry authority — and an additive OpenAI `data[]` array beside the existing
  `models[]` in `GET /v1/models`. Unsupported features are refused with a typed 400 through the common
  layer's own text-only admission rather than silently dropped, an unknown model names the accepted
  ids, and the phase-3 API key guard covers the new route.
- Transmit only the conversation's messages on the API surface (issue #253): with a client session
  identity (`user`/`session_id`) the API sends only the current user message and the provider
  conversation holds the history; without one it is stateless and every non-conversational role is
  dropped. One structural owner (`src/web-chat/host/api-projection.ts`), never per-harness, with the
  residual limit (text inside the current user message) documented and asserted by a test.
- Authenticate and safely expose the containerised API (issue #247): the public `/v1/*` surface now
  requires an API key (`DSH_CHATGPT_WEB_API_KEY` or `<data dir>/api-key`, `Authorization: Bearer` or
  `x-api-key`), a non-loopback bind refuses to start without one, a key too short to authenticate
  anything is refused, and the key is a separate authority from the operator control token. Oversized
  bodies answer a typed 413 (`DSH_CHATGPT_WEB_MAX_REQUEST_BYTES`), an optional in-flight cap answers a
  typed 429 (`DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS`, default off), and the new `exposed` Compose profile
  publishes the port instead of using host networking.
- Add the supported container distribution (issue #246): a multi-stage `Dockerfile` (Playwright base
  pinned to `playwright-core`, `--omit=peer` production install, a build-time assertion that the CLI
  loads without the DSH host peers, non-root by default), `.dockerignore` (build context 649 MB → 6 MB),
  `docker-compose.yml` with a data volume and healthcheck, and an entrypoint that bootstraps an empty
  data volume — so a first `docker compose up -d --wait` becomes healthy with no manual step. A CI job
  builds the image and waits for health, and `scripts/test-246-container-pin.mjs` keeps the base-image
  pin in step with `bun.lock`. `doc/container.md` is now the operations manual; it records the deferred
  Chromium-sandbox hardening and the API "transmit only messages" requirement tracked as #253.

## 1.0.28

- Normal Chat Mode sends only the user's message — plus the deterministic `Project:`/`github:` header on the first message of a conversation. DSH host context (the skills catalogue, runtime context, the Aegis bootstrap, Hindsight recall and the time snapshot) can no longer reach ChatGPT Web, and can no longer be mistaken for the user's turn.
- Scope Advisor state to the DSH session that produced it: the turn result card and the activity list no longer show another session's review, the activity list is requested and persisted per session, and recording a result no longer replaces another session's result for the same turn number.


## 1.0.27

- Reject a healthy-but-outdated sidecar instead of reusing it after a plugin package upgrade.
- Include the running daemon's reported version and PID in the diagnostic, and direct the user to restart the old `serve` process and DSH safely.
- Require sidecar service identity and exact version agreement both when reusing an existing daemon and when waiting for a newly started daemon.


## 1.0.26

- Separate normal Chat Mode from Advisor: normal turns retain provider-native continuity and send only the current user input; deterministic project metadata supplies the optional repository header.
- Route normal ChatGPT Web turns through the shared provider-neutral WebChat exchange lifecycle and transport boundary.
- Include the merged architecture, provider conformance, transport and CLI/sidecar boundary fixes present on `main` at release preparation.


## 1.0.25

- Fix the standalone CLI/sidecar dependency boundary: the CLI no longer imports the host-only `@deepseek-ai/dsh-llm` adapter peer (PR #230).
- Resolve ChatGPT Web provider identity from the canonical WebChat host route while retaining the public native adapter alias.
- Add a clean-tarball regression check that the CLI bundle does not import the host-only peer.

## 1.0.16

- send the retained ChatGPT Web first turn as plain composer text with the persona prefix, project name, and human message.
- send only the new human message on normal retained continuations.
- keep the installed system fingerprint frozen for the physical ChatGPT conversation generation.
- remove the legacy JSON-envelope fallback from retained continuations and fail explicitly when no human delta remains.
- strip Aegis and operational transport content while preserving the persona system prompt.

## 1.0.15

- retain the managed-Chrome ChatGPT Web surface across turns of the same DSH conversation.
- minimize retained ChatGPT Web continuation transport to the newest DSH delta instead of replaying the fixed contract and stable system prompt.
- bind the installed system fingerprint to the physical conversation generation so replacements safely reinstall the system contract.
- remove the ChatGPT Web bridge tool transport contract and synthetic Pure Chat commentary from normal turns.
- preserve native/OAuth/Codex tool infrastructure separately from the ChatGPT Web prompt transport.

## 1.0.14

- declare compatibility with the current DSH `0.2.1-alpha.1` LLM peer runtime.
- fix conversational projection when DSH injects Hindsight or operational context as separate user-role messages.
- preserve clean user/assistant history instead of dropping it when standalone internal context is present.
- detect operational context lines anywhere inside a message and strip them safely.
- reject ambiguous multiple canonical context envelopes and strip hidden metadata from embedded messages.


## 1.0.13

- validate native DSH NDJSON events at the sidecar boundary instead of trusting TypeScript casts at runtime.
- validate every adapter-emitted DSH stream chunk before exposing it to the harness, converting protocol corruption into a serializable terminal error instead of an AssistantStreamAccumulator serialization crash.
- add regressions for malformed error and tool-call events that previously could inject undefined fields into stream chunks.

## 1.0.12

- fix parsing of escaped quotes and backslashes inside the DSH JSON context envelope.
- prevent invalid lossless stream chunks when an input projection error occurs by omitting undefined finish status fields.
- add regression coverage using realistic escaped Hindsight content and DSH stream serialization.

## 1.0.11

- project DSH transport envelopes down to conversational user/assistant history before sending turns to ChatGPT Web.
- remove Hindsight, transport, environment, operational timestamp, and private checkpoint content from the ChatGPT-facing context.
- fail closed when a DSH transport envelope is present but cannot be parsed safely.
- add adversarial regression coverage for nested JSON, malformed envelopes, and unterminated internal blocks.

## 1.0.10

- automatically migrate persisted `releaseVersion` to the installed plugin release during config loading.
- refuse silent downgrades when a persisted config was created by a newer plugin release.
- add regression coverage for config and setup migration paths.

## 1.0.9

1.0.8 is the closed chat-only stability baseline.

1.0.9 focused on optimizing the browser-backed chat path before any tool execution work was reconsidered.

Identity fix:
- authenticate the browser lease against the stable ChatGPT user identity instead of mutable storage-state serialization.
- persist the account fingerprint during login so restarts keep the same logical account identity.

Focus:
- observability and diagnostics;
- chat turn reliability and lifecycle behavior;
- browser submission and streaming robustness;
- latency and unnecessary work in the chat path;
- context/continuity efficiency without changing the external provider contract.

Tools remained intentionally out of scope for this development cycle.
