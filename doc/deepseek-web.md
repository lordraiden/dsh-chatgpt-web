# DeepSeek Web provider (`chat.deepseek.com`)

> **Scope.** The evidence record and the honest boundary for the **DeepSeek** WebChat provider: what was
> measured, what the adapter implements, which recon unknowns it refuses to guess, and what an operator
> must do — and still cannot do — today. It is not architecture ([`architecture.md`](./architecture.md)),
> not a README ([`README.md`](../README.md)) and not the onboarding procedure
> ([`provider-onboarding.md`](./provider-onboarding.md)). Where this document and the code disagree, the
> code and its tests win.

The pre-capture brief is [`provider-recon.md`](./provider-recon.md) §2. Everything this document now
states as measured was measured twice: once from the vendor's shipped bundle, and once from a **real
signed-in HAR of `chat.deepseek.com`** supplied by the operator on **2026-10-24** (two completions, one
`chat_session/create`, one `chat/create_pow_challenge`, the model settings call, the app's SHA3 WASM
worker asset and its two bundle chunks). The capture itself is evidence, not a repository artifact: it
is not committed, and no cookie, token, device id, prompt or header **value** from it appears in this
document, the code or the tests.

## 1. What this slice is, and what it is not

Implemented, and covered by tests that need no network:

- the **stream vocabulary**: a named-SSE reader plus the app's own delta parser — sticky `SET`/`APPEND`
  defaults, `-1` = the last array element, and **relative** `BATCH` children — assembling
  `response.fragments[i].content`, with `finish`, `close` and stream end as the three terminators. The
  recorded answer is the `RESPONSE` fragment; `THINK` is reasoning, excluded and counted;
- the **transport**: the recorded completion body over the provider-neutral page-context relay
  (`src/adapters/page-context-request.ts`);
- the **proof of work**: a fresh proof per completion, produced by **the page's own SHA3 WASM worker**
  (`pow.ts`), with the worker asset discovered from the page's live bundle at call time — no
  reimplementation, no hard-coded proof, no fabricated header;
- the **page identity**: `Authorization` (the page's own `localStorage["userToken"]`), the
  `x-client-*` / `x-device-*` family and `x-hif-leim`, all read from the page **at call time**
  (`page-identity.ts`); a page without a token sends no bearer and the provider's `40002`/`40003`
  becomes `AUTH_REQUIRED`;
- the **provider skeleton**: configurable catalogue rows with no invented ids, continuity keyed to
  `chat_session_id` + `parent_message_id`, ephemeral turns that create no session, and the two-layer
  envelope refusal mapping.

**Not implemented, on purpose:** the interactive sign-in controller and the authenticated **import
predicate** (§7). A fresh `auth import --provider deepseek-web` still stores the capture *unverified*,
and the session's `ready()` gate refuses before launching the page. That is the one rung between a good
capture and a live turn; §6 and §7 name it.

- **Provider id / public route:** `deepseek-web`. A row is `deepseek-web/<model_type>`.
- **Files:** `src/adapters/deepseek-web/**`; tests
  `tests/deepseek-web-{sse,protocol,pow,route}.test.ts`.

## 2. The id is the existing one, not a new spelling

`deepseek-web` is already the deployment's DeepSeek capture id
(`DEEPSEEK_WEB_IMPORT_PROVIDER_ID`, `src/auth-import.ts`). A provider must not have two spellings
([`provider-onboarding.md`](./provider-onboarding.md) §1.3), so the catalogue, the driver, the session
path and `auth import --provider deepseek-web` all address the same literal. The session lives at
`providers/deepseek-web/storage-state.json`, which is exactly where that import already writes.

## 3. The turn, as implemented

```text
POST /api/v0/chat/create_pow_challenge  { target_path: "/api/v0/chat/completion" }
      -> {code:0, data:{biz_code:0, biz_data:{challenge:{algorithm, challenge, salt, signature,
                                    difficulty, expire_at, expire_after, target_path}}}}
POST /api/v0/chat_session/create        {}                       (only when the conversation has none)
      -> {code:0, data:{biz_code:0, biz_data:{chat_session:{id, …}, ttl_seconds}}}
POST /api/v0/chat/completion            { chat_session_id, parent_message_id, model_type, prompt,
                                          ref_file_ids: [], thinking_enabled, search_enabled,
                                          action: null, preempt: false }
      -> text/event-stream, named + unnamed SSE
```

**The proof comes first.** The challenge is fetched and solved *before* a session is created, so a build
that cannot produce a proof fails the turn with nothing created and nothing sent — no empty session left
in the operator's account by a build limitation. The recorded `target_path` is the completion route, not
a session, so the order is not a protocol claim.

**The body is the measured one.** Both captured completions carry exactly nine keys — the seven above
plus `action: null` and `preempt: false`. The pre-capture brief had listed `source` as a completion key
and no value for `action`/`preempt`; the capture shows `source` is **not** sent at all, so the adapter no
longer omits the two booleans and no longer models `source`
(`DEEPSEEK_WEB_RECORDED_BODY_KEYS`, `DEEPSEEK_WEB_UNSENT_BODY_KEYS = []`).

`thinking_enabled` and `search_enabled` are the recorded plain booleans (recon §2.5). They are
**deployment configuration per model**, not caller-selectable modes: no named mode labels were measured,
so the catalogue publishes `supported_reasoning_levels: []` and a caller that selects a reasoning level
gets a typed `400 unknown_reasoning_mode` that says exactly that. The default for both is `false` — the
off switch is the only value this build can defend without claiming a reasoning pass or a web search the
caller did not ask for.

## 4. The stream parser (the part that is independent of the model list)

Named SSE **plus unnamed delta frames**. `DeepSeekSseReader` assembles `event:`/`data:`/`id:` blocks
(comments and heartbeats ignored, multi-line `data` joined, CRLF and chunk boundaries irrelevant, a
trailing event without its blank line flushed once). `parseDeepSeekSseEvent` classifies them, and an
unnamed `data:` frame is the recorded delta case — the capture's turn is carried mostly that way:
`ready`, then `update_session`, then dozens of unnamed patches, then `title` and `close`.

The delta payload is `{p?, o?, v}`. **`p` and `o` are optional**, exactly as the app's own parser (`SI`
in the bundle) treats them: the previous operation and path are the defaults, starting at `SET` and `""`.
The measured forms are:

| Frame form | Meaning |
| --- | --- |
| `{"v":{…}}` | first frame: `SET` the whole response document; later: `APPEND` to the previous path |
| `{"p":"…", "v":…}` | the operation is inherited, the path changes |
| `{"p":"…","o":"SET","v":…}` | fully specified |
| `{"p":"response","o":"BATCH","v":[…]}` | children are **relative** to the batch path (the app prepends it) |

`DeepSeekDeltaParser` implements that inheritance and the relative `BATCH`. `DeepSeekFragmentAssembler`
then mirrors the app's writer (`Sn.write`) over the response document:

| Rule | Detail |
| --- | --- |
| Root | paths start with `response`; `""` (a whole-document `SET`) replaces the document |
| `-1` | resolves as `length + index`, while traversing **and** at the assignment (`response/fragments/-1/content` is the last fragment) |
| `SET` | writes any JSON value; an array index equal to the length appends |
| `APPEND` string | concatenates onto an **existing** string (the app's writer refuses a missing target) |
| `APPEND` array | pushes onto an existing array, or splices at an array index |
| Ordered fragments | fragments are keyed by their **document index**, never arrival order |

**The answer and the reasoning.** A plain answer has exactly two fragment types: `THINK` and `RESPONSE`
(measured on both completions). The answer is the `RESPONSE` content. `THINK` is the model's reasoning:
it is **excluded and counted** (`reasoningChars`), never returned to the caller — the same rule the other
providers apply to a reasoning phase. A turn whose only text is `THINK` (or an unmodelled fragment type)
fails as `DEEPSEEK_UNATTRIBUTED_ANSWER` instead of returning empty successful text.

**Termination** is `finish`, `close`, or the stream ending. There is no `[DONE]` anywhere. The measured
normal answer ends with the patch `response/status: "FINISHED"`, then `update_session`, then `title`, then
`close` with `click_behavior: "none"` — **`finish` did not appear in either captured turn**, so `close` is
the terminator a live text turn actually uses (row 7). `ready`, `title`, `toast`, `hint`,
`update_session`, `update_parent_message` and `update_file` are control frames: counted, never content,
never terminal.

**A malformed patch throws `DeepSeekProtocolError`** with a stable code (unknown operation, missing value,
non-array `BATCH`, a path that does not start at `response`, `APPEND` onto a non-string, a path that
traverses a scalar, nesting too deep). It is never skipped and never coerced: skipping corrupts the
answer silently, and a plausible-looking wrong answer is worse than a failed turn.

**An in-band error** is read from the provider's own envelope: any frame that declares a non-zero `code`
or a non-zero `data.biz_code` becomes an error frame, and a frame that carries no code at all is still
reported as a provider error. Neither captured stream carried one (row 10).

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

## 6. The inventory: what the signed-in capture settled, and what is still open

Every row is now either **measured** (with the evidence and the code that owns it) or **open** with the
one observation that settles it. No row is dropped.

### 6.1 Measured on the capture (2026-10-24)

| # | Fact | Evidence | Owner |
| --- | --- | --- | --- |
| 1 | **`x-ds-pow-response` is the proof header.** Its value is `base64(JSON)` with exactly `{algorithm, challenge, salt, answer, signature, target_path}` (a 368-char value decoding to 274 chars of JSON on both completions). | Both completion requests carry it; `algorithm` is `DeepSeekHashV1`; the second completion's proof matches the captured `create_pow_challenge` answer. | `DEEPSEEK_WEB_POW_HEADER`, `pow.ts` |
| 2 | **The solver contract is the page's own worker.** Algorithm `DeepSeekHashV1`; the page starts a classic worker from its static asset (`static/37627.<hash>.js`, discovered through `new Worker(new URL(publicPath + "static/" + id + "." + hash + ".js", base))`), posts `{type:"pow-challenge", challenge:{…, expireAt}}`, and receives `{type:"pow-answer", answer:{algorithm, challenge, salt, answer, signature}}`. The worker's `answer` is `wasm_solve(challenge, `${salt}_${expireAt}_`, difficulty)`. | The captured worker bundle carries that message switch; the captured `sha3_wasm_bg.*.wasm` reproduces the recorded `answer` for the recorded challenge, salt, `expire_at` and difficulty (checked locally by instantiating the captured WASM, without printing any value). A **fresh proof per completion** is proven by the capture's two distinct proofs for two completions. | `pow.ts` — drives the page's worker; nothing is re-hashed |
| 3 | **The real `model_type` values** are `default`, `expert`, `vision`. `default` = "Instant" (`enabled: true`, `switchable: true`, `is_default: true`); `expert` = "Expert" and `vision` = "Vision" are both `enabled: false`, `switchable: false`. | `GET /api/v0/client/settings?did=…&scope=model` → `code:0`, `data.biz_code:0`, `data.biz_data.settings.model_configs = {id, value:[…]}`. Note the shape: a `{id, value}` wrapper, **not** the `biz_data.entries` array the pre-capture guess named. | Configuration (`webChat.providers["deepseek-web"].modelTypes`); §6.3 example |
| 4 | **The `did` is a UUID** and is **not** the `x-device-id` of the completion (compare the two captured values). The app persists its own `__ds_remote_feature_did` for it. | The settings query is `?did=<uuid>&scope=model`; the completion's `x-device-id` is a different UUID. | Nothing on the turn path sends it; the settings call is not part of a turn |
| 5 | **A plain answer's fragment types are `THINK` and `RESPONSE`.** The complete response document is the first `delta` frame, with the `THINK` fragment already open; the `RESPONSE` fragment is appended later. | Both captured streams: `fragments` = `[{type:"THINK",…}]` then `APPEND response/fragments [{type:"RESPONSE",…}]`; answer = `RESPONSE` content, reasoning = `THINK`. | `DEEPSEEK_WEB_RESPONSE_FRAGMENT_TYPE`, `DEEPSEEK_WEB_REASONING_FRAGMENT_TYPE`, `sse.ts` |
| 6 | **`source` is not sent; `action: null` and `preempt: false` are.** The completion body has exactly nine keys. | Both captured bodies (a first turn and a continuation). | `deepSeekCompletionRequest`, `DEEPSEEK_WEB_RECORDED_BODY_KEYS` |
| 7 | **A normal text answer ends on `close`**, not `finish`. Order: `ready` → `update_session` → patches (including `response/status: "FINISHED"`) → `update_session` → `title` → `close {click_behavior:"none", auto_resume:false}`. `finish` appears in neither capture. | Both captured streams. | `sse.ts` terminators; `text-transport.ts` treats `close`/`finish`/stream end |
| 8 | **`chat_session/create` takes `{}` and answers the measured envelope**; the id is at `data.biz_data.chat_session.id`. The full success shape carries `model_type`, `title`, `seq_id`, `ttl_seconds`, `is_empty`, `current_message_id`, … | The captured create request and answer. | `DEEPSEEK_WEB_SESSION_ID_PATHS`, `readDeepSeekCreatedSessionId` |
| 9 | **`Authorization` is `Bearer <64-char opaque token>`** (not a JWT), and the page keeps it in `localStorage["userToken"]` as `{"value": …, "__version": "0"}`. Its client reads it through the same storage handle for every API call. | The captured completion/settings/create requests carry the header; the live app bundle's storage handle `userToken` and token manager read that key. | `page-identity.ts` — read at call time, per request |
| 11 | **`BATCH` children are relative** to the batch path. The captured frame is `p:"response", o:"BATCH", v:[{p:"accumulated_token_usage"},{p:"quasi_status"}]`. | The captured stream, and the bundle's `SI.parse` prepends `s + "/"`. | `DeepSeekDeltaParser` |
| 13a | **The exact `x-client-*` / `x-device-*` names** are `x-client-bundle-id`, `x-client-platform`, `x-client-version`, `x-client-locale`, `x-client-timezone-offset`, `x-device-id`, `x-device-model`, and `x-hif-leim`. Their measured shapes: bundle id `com.deepseek.chat` (region-mapped), platform `web`, version `2.7.0`, locale `en_US`, offset in seconds (`7200`), device id a UUID, device model empty, leim a cached fingerprint token (its `hif_leim_cached` handle is a JSON string). | Every captured API request carries the set; the live bundle builds it from `staticEnv` + `navigator.language` + the browser offset + `localStorage`. | `page-identity.ts` — values read from the page, except the two documented build constants (`web`, `2.7.0`) |

### 6.2 Still open, with the one observation that settles each

| # | Unknown | What this build does | The one observation that settles it |
| --- | --- | --- | --- |
| 10 | Which event/name carries an **in-band stream error** | The two-layer envelope is applied to every frame; a frame with no code is still a provider error. No captured stream carried one. | A rejected completion mid-stream (expired token, quota, `POW_HEADER_ERROR`/`INVALID_POW_RESPONSE`) and the frame it arrives as |
| 12 | Whether an **ephemeral turn** is accepted with a process-generated session id | Sent, never created; a refusal is that turn's typed failure, never a fallback to creating a session | A completion request carrying a `chat_session_id` the provider never issued |
| 13b | Which client/device headers are **required** (as opposed to merely sent) | All measured ones are sent from the page; none is fabricated. Requirement cannot be proven from one capture. | A signed-in completion with exactly one of them omitted, and the provider's answer |

### 6.3 The catalogue example these values produce

The measured values become the documented configuration — nothing is published without configuration:

```jsonc
{
  "webChat": {
    "providers": {
      "deepseek-web": {
        "accountIdentityFingerprint": "<the operator's recorded account label>",
        "modelTypes": [
          // The only enabled + switchable row in the captured account.
          { "id": "default", "label": "Instant", "thinking": false, "search": false },
          // Captured as enabled:false / switchable:false; configure only if the account offers them.
          { "id": "expert", "label": "Expert" },
          { "id": "vision", "label": "Vision" }
        ]
      }
    }
  }
}
```

`deepseek-web/default` is the route a normal deployment serves. The two toggles default to `false`,
which is the only value the capture does not claim a reasoning pass or a web search for; a row may
configure them when the operator wants them. No rows exist without this block, and `/v1/models` shows
exactly what is configured.

## 7. Sign-in, import and the current operator ladder

This slice deliberately still does **not** add:

- an interactive sign-in controller, so `GET /v1/control/auth/` does not list DeepSeek yet;
- an authenticated **predicate**, so `auth import --provider deepseek-web` still stores a capture
  **unverified** (no `.verified.json` marker). The import's message says exactly that.

The capture now has a measured shape, so what it must contain is no longer a guess:

```text
cookies                        the WAF/session cookies of chat.deepseek.com
origins[chat.deepseek.com].localStorage
  userToken                    {"value": "<opaque bearer>", "__version": "0"}
  deepseek-device-id:chat      the browser's UUID device identity
  hif_leim_cached              the page's cached HIF leim token (optional; omitted when absent)
```

A capture with cookies only is **not** enough: every API call carries the page's bearer, and the page
reads it from `userToken`. A capture with `userToken` only is not enough either: the WAF/session cookies
are the page's own. The storage state is what `auth import` already stores, so no new format is
introduced.

The ladder today, in the order each rung blocks the next:

1. **Capture** — `auth import --provider deepseek-web --from <file>` stores the session in the standard
   provider layout. It is *not* proof: no predicate has accepted it.
2. **Verified session** — **the one remaining rung.** `ready()` requires the deployment's verified
   marker, so it refuses before launching a browser. Nothing in this slice writes that marker, because
   writing it without a predicate would be a claim the deployment cannot prove. The measurement a
   predicate can be built on is now known and cheap: the page's own token makes
   `GET /api/v0/client/settings?did=<uuid>&scope=model` answer `code:0` + `data.biz_code:0` for a signed-in
   session and `data.biz_msg:"SETTINGS_NOT_FOUND"` for an anonymous one (both measured).
3. **A turn** — ready to run once rung 2 exists: the proof, the bearer, the client/device headers and the
   measured stream are implemented and pinned by tests. This slice cannot prove a live run without an
   authenticated session.
4. **A catalogue** — configuration, not discovery: the model list is a session-only remote setting, so
   there is no public endpoint and no `models refresh` command for this provider. §6.3 is the example
   with the measured values.

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
- **The shared conformance suite** — it drives a *successful* turn through the real path, whose session
  gate needs a verified capture. The protocol/PoW/route tests cover the vocabulary with injected seams,
  and no test claims a live authenticated run.
- **Automatic retry after a rejected proof or a `close:"retry"`** — both are typed failures. A confirmed
  submission is never resent, and a rejected proof is never replayed.
- **A synthesized `x-device-id`** — when the page has none, the page generates one with its own
  `crypto.randomUUID()` and stores it under its own key; this build never invents an identity on the
  Node side.

## 9. Tests

| File | What it pins |
| --- | --- |
| `tests/deepseek-web-sse.test.ts` | the measured frame sequence (snapshot, inherited `{v}`, `-1`, relative `BATCH`, `close` termination); named-SSE framing (comments, multi-line data, CRLF split, trailing event); the sticky/default delta parser; `SET`/`APPEND`/`BATCH` semantics; `THINK` excluded and counted, unmodelled types reported; every terminator; `update_session` mid-stream; an in-band envelope error at either layer; each malformed patch refused with its typed code |
| `tests/deepseek-web-protocol.test.ts` | the measured nine-key completion body (`action:null`, `preempt:false`, no `source`), `parent_message_id:null` on a first turn, the measured session-id path, both envelope layers, the auth / PoW / WAF / lost-session / upstream refusal mapping, the challenge location, the no-solver seam, catalogue visibility and the §6.3 example |
| `tests/deepseek-web-pow.test.ts` | the header/value shape (base64 JSON, recorded keys/order), a fresh proof per call, the page answerer's worker call (`expireAt` mapping), solver success/refusal/unavailable/timeout/mismatched-challenge/unknown-algorithm, the page token storage shape, the bundle-id region mapping, the client/device header family, read-at-call-time rotation, facility wiring (auth + client headers on JSON calls, proof only on the completion), and the measured storage keys/header names |
| `tests/deepseek-web-route.test.ts` | same key → same `chat_session_id` and `parent_message_id`; lost session → typed loss → explicit replay; ephemeral with zero creations; PoW-unavailable failing before anything is created; auth refusal mapped from `code:40003`; reasoning selection refused; capability declaration discarded and declared; the configured and unconfigured listener paths (rows, stream, honest `not_configured`); a `ready.model_type` that differs from the requested one surfaced, never hidden |

## 10. What the capture changed

The pre-capture plan expected six changes. The capture confirmed the order and the ownership, and settled
which of them were data, which were code, and which did not exist at all:

| # | Change | Outcome |
| --- | --- | --- |
| 1 | The proof-of-work solver | **Code, delivered.** `pow.ts` drives the page's own worker (asset discovered from the live bundle), composes the measured header blob, and types every failure. Never a reimplementation, never a recorded proof. |
| 2 | The header name | **Data, settled.** `x-ds-pow-response`, exported by `pow.ts`; it had arrived with the solver, not as a constant the solver had to guess. |
| 3 | The `Authorization` provenance | **Code + data, delivered.** The page's `localStorage["userToken"]`, read per request; the storage keys are exported constants. |
| 4 | `chat_session/create` request and response | **Data, settled.** `{}` → `data.biz_data.chat_session.id`; the provisional path list collapsed to the measured one. |
| 5 | The `model_type` values | **Data, settled.** `default`/`expert`/`vision`; §6.3 is the configuration. |
| 6 | Fragment types / body extras / error event | **Partly confirmed, partly corrected.** `THINK` + `RESPONSE` confirmed; `action`/`preempt` are sent (the brief's "omit them" was wrong) and `source` is not; the stream's unnamed `{v}`/`{p,v}` forms, `-1` and relative `BATCH` were **not** in the brief and are now implemented. The in-band error frame remains open (row 10). |

Two things a capture can never give: a **replayable proof** (valid for one completion) and a
**replayable token**. That is why the solver is code and why the token is read from the page at call
time rather than copied anywhere.
