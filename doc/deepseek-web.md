# DeepSeek Web provider (`chat.deepseek.com`)

> **Scope.** The evidence record and the honest boundary for the **DeepSeek** WebChat provider: what was
> measured, what the adapter implements, which recon unknowns it refuses to guess, and what an operator
> must do — and still cannot do — today. It is not architecture ([`architecture.md`](./architecture.md)),
> not a README ([`README.md`](../README.md)) and not the onboarding procedure
> ([`provider-onboarding.md`](./provider-onboarding.md)). Where this document and the code disagree, the
> code and its tests win.

The measured brief this provider implements is [`provider-recon.md`](./provider-recon.md) §2. Nothing in
that document is re-measured here.

## 1. What this slice is, and what it is not

Implemented, and covered by tests that need no network:

- the **stream vocabulary**: a named-SSE reader plus the JSON-patch fragment assembler
  (`SET | BATCH | APPEND` against `response.fragments[i].content`), with `finish`, `close` and stream
  end as the three terminators;
- the **transport**: the recorded completion body over the provider-neutral page-context relay
  (`src/adapters/page-context-request.ts`), with the proof-of-work step isolated behind **one seam** and
  the `Authorization` provenance behind **a second**;
- the **provider skeleton**: configurable catalogue rows with no invented ids, continuity keyed to
  `chat_session_id` + `parent_message_id`, ephemeral turns that create no session, and the two-layer
  envelope refusal mapping.

**Not implemented, on purpose:** a live turn cannot succeed end to end. The proof of work and the page
token are unproven (§6), and the adapter says so with typed errors rather than pretending. There is also
no interactive sign-in controller and no authenticated import predicate (§7).

- **Provider id / public route:** `deepseek-web`. A row is `deepseek-web/<model_type>`.
- **Files:** `src/adapters/deepseek-web/**`; tests `tests/deepseek-web-{sse,protocol,route}.test.ts`.

## 2. The id is the existing one, not a new spelling

`deepseek-web` is already the deployment's DeepSeek capture id
(`DEEPSEEK_WEB_IMPORT_PROVIDER_ID`, `src/auth-import.ts`). A provider must not have two spellings
([`provider-onboarding.md`](./provider-onboarding.md) §1.3), so the catalogue, the driver, the session
path and `auth import --provider deepseek-web` all address the same literal. The session lives at
`providers/deepseek-web/storage-state.json`, which is exactly where that import already writes.

## 3. The turn, as implemented

```text
POST /api/v0/chat/create_pow_challenge  { target_path: "/api/v0/chat/completion" }
      -> {code:0, data:{biz_data:{challenge:{challenge, difficulty, …}}}}
POST /api/v0/chat_session/create        {}                       (only when the conversation has none)
POST /api/v0/chat/completion            { chat_session_id, parent_message_id, model_type, prompt,
                                          ref_file_ids: [], thinking_enabled, search_enabled }
      -> text/event-stream, named events
```

**The proof comes first.** The challenge is fetched and solved *before* a session is created, so a build
that cannot produce a proof fails the turn with nothing created and nothing sent — no empty session left
in the operator's account by a build limitation. The recorded `target_path` is the completion route, not
a session, so the order is not a protocol claim.

**The body is built from the keys the recon settles.** Recon §2.3 records ten keys; this adapter sends the
seven whose values are measured (`chat_session_id`, `parent_message_id`, `model_type`, `prompt`,
`ref_file_ids`, `thinking_enabled`, `search_enabled`) and **omits** `source`, `action` and `preempt`.
The recon calls `source` free-form and `action`/`preempt` nullable extras, but records no value for any
of them, so filling them would be a guess. `DEEPSEEK_WEB_RECORDED_BODY_KEYS` and
`DEEPSEEK_WEB_UNSENT_BODY_KEYS` name both halves in one place.

`thinking_enabled` and `search_enabled` are the recorded plain booleans (recon §2.5). They are
**deployment configuration per model**, not caller-selectable modes: no named mode labels were measured,
so the catalogue publishes `supported_reasoning_levels: []` and a caller that selects a reasoning level
gets a typed `400 unknown_reasoning_mode` that says exactly that. The default for both is `false` — the
off switch is the only value this build can defend without claiming a reasoning pass or a web search the
caller did not ask for.

## 4. The stream parser (the part that is independent of the model list)

Named SSE, not `data:`-only frames. `DeepSeekSseReader` assembles `event:`/`data:`/`id:` blocks
(comments and heartbeats ignored, multi-line `data` joined, CRLF and chunk boundaries irrelevant, a
trailing event without its blank line flushed once), and `parseDeepSeekSseEvent` classifies them with the
bundle's own `onServerEvent` switch (recon §2.4). An unnamed data frame is the recorded delta case.

The `delta` payload is a JSON patch `{p, o, v}`:

| Operation | Rule implemented |
| --- | --- |
| `SET` | write the value at the slash path |
| `APPEND` | concatenate text onto text; append a value to an array |
| `BATCH` | apply an array of patches, in order, recursively (bounded depth) |

`DeepSeekFragmentAssembler` applies them to the provider's response document. Fragments are keyed by
their **index in the document**, never by arrival order, so a patch that fills `fragments/1` before
`fragments/0` cannot shift the answer. The answer is the content of fragments whose `type` is `RESPONSE`;
content on any other (or undeclared) fragment is reported by `unattributedText()` and the transport
**fails the turn** rather than returning an empty successful answer.

**Termination is exactly one of** `finish`, `close` and the stream ending. There is no `[DONE]` sentinel
anywhere in the bundle (0 occurrences, recon §2.4). `ready`, `title`, `toast`, `hint`, `update_session`,
`update_parent_message` and `update_file` are control frames: counted, never content, never terminal.

**A malformed patch throws `DeepSeekProtocolError`** with a stable code (missing path, unknown operation,
missing value, non-array `BATCH`, `APPEND` of a number to text, a path that traverses a scalar, nesting
too deep). It is never skipped and never coerced: skipping corrupts the answer silently, and a
plausible-looking wrong answer is worse than a failed turn.

**An in-band error** is read from the provider's own envelope: any frame that declares a non-zero `code`
or a non-zero `data.biz_code` becomes an error frame, and a frame that carries no code at all is still
reported as a provider error. Recon §2.4 records no dedicated stream error event, so the measured
envelope is the only error shape applied (see §6).

## 5. Continuity, ephemeral turns, and the route

**Continuity** (`chat-state.ts`, `providers/deepseek-web/conversations.json`, mode 0600) is the
provider-private mapping from the core affinity key to the pair the completion body uses:

- `chatSessionId` — the id `chat_session/create` returned;
- `parentMessageId` — the previous answer's assistant message id (`ready.response_message_id`), which the
  next turn sends as `parent_message_id`.

That state is durable, so a restart continues the same session (`exact_resume`), and the core still owns
the record, generation and opaque handle. A rejected session is recorded `lost` and reported as
`CONVERSATION_LOST` (409); recovery is an **explicit replay** from canonical history, which creates a new
session and advances the generation. Nothing silently forks.

**Ephemeral turns** (a declared housekeeping `purpose`, e.g. a session title) create **no** session and
record nothing; they stream into a session id this process generated. Whether the provider accepts an id
it did not create is unproven (§6); if it refuses, the turn fails with the provider's typed category and
never falls back to creating a session. The route tests assert zero creations and no recorded
conversation for this path.

**The route claim.** The composition owns the `deepseek-web/` prefix even when nothing is configured, so
a caller is answered by this provider's typed `400 not_configured` (with the reason) instead of being
forwarded to an unrelated backend. Serving an exact model still requires it to be configured; the
chat-completions surface refuses an unadvertised route at the catalogue layer, which is the service's
routing authority.

## 6. The unproven inventory

Every row is a fact this adapter **does not know**. Each names what the code does instead, and the single
observation that settles it. Until then the behaviour is a typed refusal, never a guess.

| # | Unknown | What this build does | The one observation that settles it |
| --- | --- | --- | --- |
| 1 | The **proof-of-work header name** | The solver returns `{header, value}`, so the name travels with the solution; the default solver throws `TRANSPORT_UNAVAILABLE` / `DEEPSEEK_POW_UNAVAILABLE` | One signed-in HAR of a completion: the extra request header whose value changes per turn |
| 2 | The **solver contract** (hash, encoding, the bundle's WASM entry point) | Not implemented. The page's own solver (`r1Pow`, recon §2.6) is the only acceptable implementation; no global handle was measured, so invoking it would be an invention | A captured challenge **and** its accepted solution for the same turn, plus the bundle function that computes it |
| 3 | The **real `model_type` values** | Configuration only (`webChat.providers["deepseek-web"].modelTypes`). No rows are published without it | One signed-in `GET /api/v0/client/settings?did=…&scope=model`, read `biz_data.entries[].model_type` |
| 4 | The **`did` provenance/format** | Never sent: the completion body does not need it, and nothing else on this path requires it | The same HAR: the `did` on the settings request versus `__ds_remote_feature_did` in the page |
| 5 | The exact **fragment `type` set** for a plain answer | Only `type === "RESPONSE"` is treated as the answer; anything else is reported and fails the turn as `DEEPSEEK_UNATTRIBUTED_ANSWER` | The first `delta` frames of a signed-in turn: their `p` paths and `response/fragments/<n>/type` values |
| 6 | Whether **`source` / `action` / `preempt`** are required | Omitted (see §3); the completion carries only measured-value keys | The body of one plain first turn in the HAR |
| 7 | **`finish` vs `close`** reliability for a text answer | Both are terminators; `close.click_behavior` is recorded and surfaced, and a `close:"retry"` with no text fails as `DEEPSEEK_CLOSE_RETRY` instead of retrying | The HAR: which event precedes the stream close on a normal answer |
| 8 | The **`chat_session/create` body and success shape** | `{}` is sent (the minimal request), and the id is read from one documented candidate list; an unreadable answer fails as `DEEPSEEK_SESSION_CREATE_UNREADABLE` naming the paths tried | The create call in the same HAR — its request body and its full JSON answer |
| 9 | The **`Authorization` token provenance** | No header is sent by default (`DeepSeekPageFacilityOptions.authorization` is the seam); the provider's `40002`/`40003` is then reported as `AUTH_REQUIRED` | The HAR's `Authorization` header **and** where the page keeps that value (a captured header alone cannot be replayed) |
| 10 | Which event/name carries an **in-band stream error** | The two-layer envelope is applied to every frame; a frame with no code is still a provider error | A rejected completion mid-stream (expired token, quota) and the event it arrives as |
| 11 | Whether **`BATCH` child paths** are absolute or relative to the batch path | Absolute; children are validated as full patches. Recorded as the only reading of the bundle's `d.set(t,l,i)` the recon supports | One `BATCH` frame from a signed-in turn |
| 12 | Whether an **ephemeral turn** is accepted with a process-generated session id | Sent, never created; a refusal is that turn's typed failure | A completion request carrying a `chat_session_id` the provider never issued |
| 13 | Whether **`x-client-*` / `x-device-id`** are required | Not sent: recon §2.7 records those names but not their values, and a guessed client version is worse than a missing one | The HAR's request headers for a completion |

## 7. Sign-in, import and the current operator ladder

This slice deliberately does **not** add:

- an interactive sign-in controller, so `GET /v1/control/auth/` does not list DeepSeek yet;
- an authenticated predicate, so `auth import --provider deepseek-web` still stores a capture
  **unverified** (no `.verified.json` marker) — the import's own message now says *why* (no predicate has
  accepted it) instead of claiming there is no adapter.

The ladder today, in the order each rung blocks the next:

1. **Capture** — `auth import --provider deepseek-web --from <file>` stores the session in the standard
   provider layout. It is *not* proof (§6 rows 9 and 3 are needed before a predicate can exist).
2. **Verified session** — not reachable yet. `ready()` requires the deployment's verified marker, so it
   refuses before launching a browser; the refusal names the capture command and says the session is not
   verified.
3. **A turn** — blocked by the proof of work (§6 rows 1–2) even with a verified session.
4. **A catalogue** — needs row 3; the model list is a **session-only remote setting**, so no public
   endpoint and no `models refresh` command exist for this provider.

`doctor` reports `webchat-deepseek-web` once a `model_type` is configured, and its health detail states
the exact missing rung. A deployment that only stored a capture gets no doctor check, because an
unverified capture is not an account.

## 8. Deliberately not implemented

- **`regenerate` / `continue` / `edit_message`** — recorded in the bundle (recon §2.3) but not part of a
  text turn this bridge sends; adding them without a capture would be a protocol guess.
- **The heartbeat watchdog** (`x-ds-sse-heartbeat-timeout-secs`, recon §2.4) as its own timer. The turn
  ceiling (15 min) and the bridge's stall budget bound the turn; a dedicated watchdog waits for a capture
  that shows the header's value and the client's behaviour on expiry.
- **Files** — `ref_file_ids` is always `[]`; this bridge is text-only, and a file id would be content it
  cannot deliver.
- **Tools / MCP / provider-native loops** — refused-or-discarded by the shared rule
  (`rejectUnsupportedWebChatFeatures`), never forwarded.
- **The shared conformance suite** — it drives a *successful* turn through the real path, which would
  require fabricating the two unproven steps. The protocol tests cover the same vocabulary with an
  injected solver instead, and no test claims a live turn works.
- **Automatic retry after a rejected proof or a `close:"retry"`** — both are typed failures. A confirmed
  submission is never resent, and a build limitation never becomes a retry storm.

## 9. Tests

| File | What it pins |
| --- | --- |
| `tests/deepseek-web-sse.test.ts` | named-SSE framing (comments, multi-line data, CRLF split, trailing event), every recorded event, the patch assembler (`SET`/`APPEND`/`BATCH`, ordered fragments, repeated deltas), every terminator, `update_session` mid-stream, an in-band envelope error at either layer, unattributed content, and each malformed patch refused with its typed code |
| `tests/deepseek-web-protocol.test.ts` | the completion body's exact key set and the three unmeasured keys omitted, `parent_message_id: null` on a first turn, both envelope layers, the auth / PoW / WAF / lost-session / upstream refusal mapping, the provisional session-id paths, the challenge location, the default solver's typed refusal, catalogue visibility (no rows, no seed, no invented levels/windows), and the driver's own unproven facts |
| `tests/deepseek-web-route.test.ts` | same key → same `chat_session_id` and `parent_message_id`; lost session → typed loss → explicit replay; ephemeral with zero creations; PoW-unavailable failing before anything is created; auth refusal mapped from `code:40003`; reasoning selection refused; capability declaration discarded and declared; the configured and unconfigured listener paths (rows, stream, honest `not_configured`); a `ready.model_type` that differs from the requested one surfaced, never hidden |

## 10. What one HAR of a signed-in turn changes

The deliverable question is: **how many things must change before turns can work, and which are data?**

Six changes, in this order. **One is substantial code (the solver), one is small code (the token
reader), and four are data** — a header name, a session-create shape, the model types, and at most one
constant or branch for the fragment/body/error details.

| # | Change | Kind | Where |
| --- | --- | --- | --- |
| 1 | The proof-of-work **solver** — invoke the page's own `r1Pow` WASM flow, returning `{header, value}` | **Code** | One function behind `DeepSeekProofOfWorkSolver`; the HAR settles the header *name* and the challenge/solution pair, but the solver itself is code |
| 2 | The **header name** (if it is not supplied by the solver) | **Data** | `DeepSeekProofOfWork.header`, already data in this build's seam |
| 3 | The **`Authorization` provenance** — read the token where the page keeps it | **Code** + one **data** constant (the storage key) | `DeepSeekPageFacilityOptions.authorization` |
| 4 | The **`chat_session/create`** request body and response shape | **Data** | `deepSeekSessionCreateRequest()` (`{}` today) and `DEEPSEEK_WEB_SESSION_ID_PATHS` |
| 5 | The **`model_type` values** | **Data** (configuration) | `webChat.providers["deepseek-web"].modelTypes` — no code change at all |
| 6 | The fragment `type` / body extras / in-band error event, **if** the capture differs from the recon | **Data** (a constant or one branch) | `DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE`, `deepSeekCompletionRequest`, `frameEnvelopeError` |

Two things a HAR cannot give you, because they are per-turn secrets rather than recorded values: a
**replayable proof** (it expires, and one challenge is valid for one completion) and a **replayable
token**. That is why row 1 is code — it must *produce* proofs, not carry a recorded one — and why the
allowlist around the page's own solver is the only honest route for it.

The moment rows 1–3 exist, the parser, the assembler, the body, the continuity and the ephemeral rule
need no change: they are already pinned by the tests in §9.
