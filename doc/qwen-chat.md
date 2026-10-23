# Qwen Chat provider (`chat.qwen.ai`)

> **Scope.** The evidence record and operator procedure for the **second Qwen product** as a WebChat
> provider: what was measured, what the driver does, which recon unknowns had to be assumed and where
> the single correction point is, and what an operator must do to use it. It is not architecture
> ([`architecture.md`](./architecture.md)), not a README ([`README.md`](../README.md)) and not the
> onboarding procedure ([`provider-onboarding.md`](./provider-onboarding.md)). Where this document and
> the code disagree, the code and its tests win.

The measured brief this provider implements is [`provider-recon.md`](./provider-recon.md) §1. Nothing
in that document is re-measured here.

## 1. Why a second provider (and not an option on Qwen Code)

`chat.qwen.ai` is a different product from `coder.qwen.ai` (recon §0):

| | `qwen-code` (`coder.qwen.ai`) | `qwen-chat` (`chat.qwen.ai`) |
| --- | --- | --- |
| API family | `/coder/api/v2/task/*` | `/api/v2/chat*` |
| Turn body | `models[]`, `chat_mode`, `model`, `messages[]` | `chatId`/`chat_id`, `parentId`/`parent_id`, `model`, `messages[]` |
| Mode location | `feature_config.thinking_enabled` | `feature_config.thinking_mode` (label) + `thinking_enabled` + `auto_thinking` |
| Stream | `data:` frames, three signals | `data:` frames + `[DONE]`, `response.stopped`, `status:"finished"` |
| Model menu | one configured id | a real multi-model menu (public list + per-model modes) |
| Writes | anti-bot gated | anti-bot gated (TMD/`x5sec`, `aliyun_waf`) |

The operator's requirement is the last row's positive side: `coder.qwen.ai` offers one model and no
selector, while `chat.qwen.ai` has many models and three modes. This provider is what makes that menu
usable; the Qwen Code provider is unchanged.

- **Provider id / public route:** `qwen-chat`. A row is `qwen-chat/<modelId>` (e.g.
  `qwen-chat/qwen3.7-plus`).
- **Files:** `src/adapters/qwen-chat/**`; tests `tests/issue-333-qwen-chat-*.test.ts`.

## 2. Models and modes

### 2.1 The model list is configuration with a measured seed and a public hint

`GET /api/v2/models` (and `/api/models`) answers without a session and carries each model's `id`,
`name`, `abilities`, `auto_thinking`, `thinking_format` and `max_context_length` (recon §1.2, §1.6).
The recon also records that the anonymous answer is **probably the visitor subset**
(`is_visitor_active`, `features.limits.model_display_count:3`). The provider therefore treats it as a
hint, in this order:

1. `webChat.providers["qwen-chat"].models` — authoritative when present;
2. `providers/qwen-chat/models.json` — the last successful refresh;
3. the **seed** in `src/adapters/qwen-chat/models.ts` — the three ids the recon measured
   (`qwen3.7-plus`, `qwen3.8-max`, `qwen3.8-omni-flash`), with their measured abilities.

An id is never invented. The model block accepts plain ids or objects:

```json
{
  "webChat": {
    "providers": {
      "qwen-chat": {
        "accountIdentityFingerprint": "<recorded at sign-in, optional>",
        "models": [
          "qwen3.7-plus",
          { "id": "qwen3.8-max", "label": "Qwen3.8-Max", "thinking": 1, "autoThinking": true },
          { "id": "some-account-model", "thinking": 4, "autoThinking": true, "thinkingFormat": "summary" }
        ]
      }
    }
  }
}
```

`thinking` is the numeric `abilities.thinking` enum (`0..5`, recon §1.5) or a boolean; `autoThinking`
is `info.meta.auto_thinking`. When an entry omits them, the seed/cache entry of the same id supplies
them; when no hint exists the recorded fallback branch applies (`Thinking`, `Fast`; see §2.2).

### 2.2 The three modes are DSH reasoning levels

The mode rule is the vendor bundle's own (`mv`/`gv`), ported in `provider.ts`:

| Abilities | Modes offered | Default |
| --- | --- | --- |
| `auto_thinking: true`, `thinking: 4` | `Auto`, `Thinking` | `Auto` |
| `auto_thinking: true`, any other `thinking` | `Auto`, `Thinking`, `Fast` | `Auto` |
| `thinking: 1` / `3` / unknown, no auto | `Thinking`, `Fast` | `Fast` |
| `thinking: 2` (Hidden) | none | none |
| `thinking: 4`, no auto | `Thinking` | `Thinking` |

The catalogue publishes exactly those labels in `supported_reasoning_levels`, with
`default_reasoning_level` from `gv`. A model with no selectable mode publishes an empty level list and
`default_reasoning_level: null`; its turns send no thinking selection at all (the app resolves none for
it either), rather than an invented `Fast`.

**Selecting a mode.** `POST /v1/responses` accepts `reasoning_effort: "Auto" | "Thinking" | "Fast"`
(or `reasoning: { "effort": … }`), and `/v1/chat/completions` preserves the standard
`reasoning_effort` field. A label the selected model does not offer is a typed `400`
(`unknown_reasoning_mode`) that names the valid ones — never a silent fallback.

**The wire payload** (per message, not top-level, recon §1.5):

```json
"feature_config": {
  "thinking_enabled": true,
  "auto_thinking": true,
  "thinking_mode": "Auto",
  "thinking_format": "summary",
  "output_schema": "phase"
}
```

`thinking_enabled` is true for `Thinking`/`Auto`, `auto_thinking` only for `Auto`, `thinking_mode` is
the label verbatim, and `thinking_format` is written only while thinking is on. `chat_mode` stays
`"normal"` — it is a different product axis.

### 2.3 Refresh

```bash
dsh-chatgpt-web models refresh --provider qwen-chat
```

The command reads the public endpoint (trying `/api/v2/models`, then `/api/models`), validates the
list, and writes `providers/qwen-chat/models.json` atomically (mode 0600). It carries **no** cookie,
token or API key. It never deletes the previous cache on failure. The running service composes the
model list at startup, so **restart** to serve a refreshed list.

## 3. A turn

```text
POST /api/v2/chats/new                    (only when the conversation has no chat)
  -> { success, request_id, data: { id } }
POST /api/v2/chat/completions?chat_id=<id>
  body: { stream, version:"2.1", incremental_output, chatId, parentId, chat_id, chat_mode,
          model, parent_id, messages[], timestamp }
  header: X-Request-Id (the app builds it inside the body and strips it)
```

The recorded body keys and message keys are quoted in recon §1.3. The stream is parsed as `data:`-only
SSE (recon §1.4): the **answer** phases' `choices[].delta.content` is concatenated in order (§3.0);
`phase:"KeepAlive"` is neither content nor a terminator; `sources` is citations.

**The request body is now measured, not assumed.** The operator's signed-in HAR of one turn confirms
the shape below: `stream: true`, `version: "2.1"`, `incremental_output: true`, `chatId`/`chat_id`,
`chat_mode`, `model`, `messages[]` and `timestamp`, with **no `headers` or `X-Request-Id` inside the
body** (the app builds the id in the body and strips it, and this adapter sends it as the `X-Request-Id`
header instead), `parentId` a **string** at the top level and `parent_id: null` for a first turn. The
`messages[]` key set, `sub_chat_type`/`chat_type`, `source` and the ephemeral-chat-id question in §6
remain as recorded there. `response_index` arrives in `response.created` and is kept with the
continuity record for diagnosis; the cursor a continuation sends stays `response_id` (falling back to
`parent_id`) until a second recorded turn proves the index is what the next turn expects.

### 3.0 What a recorded turn looks like: phases, statuses, and the bug they caused

The operator's HAR of one real turn (2026-10-22) is 28 frames:

```text
frame 0     {response.created: {chat_id, parent_id, response_id, response_index}}
frames 1-5  thinking_summary ×5 (empty content), the last of them closing with status "finished"
frames 6-27 answer ×22, of which 19 carry content (278 characters) and the last closes "finished"
statuses: typing ×25, finished ×2     phases: thinking_summary ×5, answer ×22
```

The first `finished` closes **`thinking_summary`** — before the first `answer` delta. The rule this
adapter had inherited from the Qwen Code parser treated *any* status other than `typing` as the end of
the turn, so it stopped after frame 5 and reported an empty answer: that is the `EMPTY_RESPONSE` the
harness showed, with the operator's chat left without its message.

**Termination is exactly one of** `[DONE]`, `response.stopped`, an in-band `error`, a delta
`status:"finished"` that closes the answer, or the stream closing. The delta-status rule is the
**narrow** one, because a status closes a *phase*, not the turn (recon §1.4's status enum is
`typing|waiting_input|finished|error|pause`; the vendor bundle's stream only reports `done` for
`[DONE]`/`response.stopped`/`error`/the reader closing, and its merge rules stop merging a phase once
that phase's status leaves `typing`). `waiting_input` frames are dropped by the app outright. So a
delta ends the turn only when its `status` is `finished` **and** it closes the answer phase, or — with
no phase at all — only once the answer has produced content. The single owner of that rule is
`qwenChatDeltaClosesTurn` (`sse.ts`); the coder's looser rule is deliberately **not** transferred.

**The answer is the `answer` phase.** The measured turn streams `thinking_summary` (the model thinking
aloud, empty in this capture) before `answer`, so content is taken from the answer phases
(`answer`/`slides`) and from phase-less deltas only (`qwenChatDeltaCarriesAnswer`). A reasoning phase's
text is not returned as the caller's answer; it is **counted** — `excludedChars`/`reasoningChars` in
the turn's frame observation, and the characters-and-reasoning clause of the empty-answer diagnostic —
so it is never dropped silently. Exposing reasoning as its own explicit channel is not done: the
common contract is text-only and nothing would consume it.

**The server can re-route the model.** A `selected_model_id` frame is surfaced (the turn result and one
`model-rerouted` diagnostic line); the requested model is never silently overwritten.

Requests are issued **from inside the provider's page** (`createQwenChatPageRequestFacility`), because
the write paths are anti-bot gated (recon §1.7). That is the established `page-context-request` seam,
not a disguise: no user-agent override, no stealth flag, no synthesized baxia/x5sec token. If the page
itself is challenged, the turn fails with an `AUTH_REQUIRED`/access-verification message telling the
operator to complete it in the sign-in page — it is never retried past the challenge.

### 3.1 A refusal keeps its evidence

Both write requests answer **HTTP 200** for their refusals, so the status proves nothing; the body
does. A non-stream answer on `chats/new` **and** on `chat/completions` therefore reaches the operator
with three facts, in the error itself and in one `qwen_chat_refusal` log line:

```text
Qwen Chat answered the stream-a-completion request with an access-verification challenge
(HTTP 200, content-type: application/json; body snippet: {"ret":["FAIL_SYS_USER_VALIDATE",…}).
Open the operator sign-in surface /v1/control/auth/ …
```

The status, the `content-type` and a **bounded, redacted snippet of the actual body** come from the
same machinery the Qwen Code probe uses, factored into `src/adapters/refusal-evidence.ts` (redaction by
credential-shaped field name first and by token shape after, control characters stripped, bounded last)
so there is no second scrubber. The category distinguishes the kinds, because they lead to different
fixes:

| Kind | `providerCode` | What it means |
| --- | --- | --- |
| access verification | `QWEN_CHAT_ACCESS_VERIFICATION` | the TMD/`x5sec` HTML page, the `aliyun_waf` page, or the `FAIL_SYS_USER_VALIDATE`/`RGV587_ERROR` JSON envelope — the operator completes it in the sign-in page |
| session unauthorized | `QWEN_CHAT_SESSION_UNAUTHORIZED` | `401`/`403`, or the app's own dead-token envelope (`success:false` + `data.code` `Unauthorized`/`Invalid Token`) — re-sign-in |
| chat lost | `QWEN_CHAT_CHAT_LOST` | `404`/`ChatNotFound` **on a chat this conversation was continuing** — continuity loss, explicit replay only |
| request refused | `QWEN_CHAT_COMPLETION_REFUSED` | the provider answered its own refusal — the body is the diagnosis (§6) |
| empty answer | `QWEN_CHAT_EMPTY_ANSWER` | HTTP `<status>` with an empty body instead of a stream |

### 3.2 A completed stream with no answer text is a typed failure, with the frame evidence

An empty answer used to be a *successful* turn: the transport published `completed` with `""`, the
harness reported only `EMPTY_RESPONSE` ("a completed response with no content"), and the frames the
provider actually sent were thrown away. The measured bug behind the first `EMPTY_RESPONSE` is fixed
in §3.0, and this failure is now the **safety net**: if a future turn still extracts nothing, it is a
typed `UPSTREAM_ERROR` whose provider code is `QWEN_CHAT_EMPTY_STREAM`, and the operator's message and
**one** `qwen_chat_empty_stream` log line carry the same bounded, redacted evidence:

- how many frames were seen;
- the distinct frame **shapes** with their counts — key paths and value kinds only, never a value
  (`qwenChatFrameShape`: the `scripts/har-shape.mjs` frame-shape idea applied to this vocabulary);
- which signal ended the stream (`done`/`response_stopped`/`delta_status`/`stream_end`, with the
  terminal status when there is one);
- how many `delta` frames carried a `content` field at all, how many of those held a non-string, and
  how many characters arrived in phases that are not the answer (naming the reasoning share) — so
  "the model only reasoned" is distinguishable from "the provider sent nothing";
- at most one short redacted payload fragment: the last frame the parser could not model.

Redaction and bounding are the shared refusal-evidence rules (`sanitizedBodyFragment`,
`truncateWithEllipsis`), so there is no second scrubber. This is not a guess: if a turn still comes
back empty, that one line names the shape the answer is hiding in.

### 3.3 The first message of a conversation installs the project identity

The first physical message of a normal Chat Mode conversation is not the operator's bare text: it is
the deterministic project header plus the current user turn, exactly as on ChatGPT
([`architecture.md`](./architecture.md) §20.1):

```text
Project: "<package name>"
github: "<package repository URL>"

<the current user turn>
```

- The identity comes from the installed package's own `package.json` through the provider-neutral
  owner `src/project-identity.ts` — the **same** owner the ChatGPT minimal Chat Mode install compiles
  from. The name is a package name (never a filesystem path) and the URL is the manifest's own
  repository URL normalised to an `https:`/`http:` URL. Metadata that cannot be resolved is
  **omitted, never fabricated**: no name, no URL, no header.
- The header is initialization metadata for the **first physical message only**. A continuation sends
  just the new human text (the provider chat already carries the conversation), and an explicit
  replay/rebuild re-projects canonical host history alone, so the header is never re-injected and can
  never be duplicated (injection is idempotent by construction).
- A declared-purpose (ephemeral) turn is **not** an install and carries no header, and neither does
  the Advisor's neutral text seam. No host-context snapshot, runtime block, tool or system text
  travels with any of them.
- An install that would carry no human message is refused — the compiler refuses it, and the route's
  own projection reports `no_user_message` — exactly like the ChatGPT install.

## 4. Continuity and ephemeral turns

**Continuity state** (`chat-state.ts`, `providers/qwen-chat/conversations.json`, mode 0600) is the
provider-private mapping from the core affinity key to:

- the chat id `chats/new` returned;
- the parent/response cursor (`response_id` from `response.created`, with `parent_id` as fallback),
  which the next turn sends as `parentId`/`parent_id` and on its message;
- the response index, for diagnosis.

That state is durable, so a restart continues the same chat (`exact_resume`), and the core still owns
the record, generation and opaque handle. A rejected chat (404/`ChatNotFound`) is recorded `lost` and
reported as `CONVERSATION_LOST`; recovery is an **explicit replay** from canonical history, which
creates a new chat and advances the generation. Nothing silently forks.

**Ephemeral turns** (a declared housekeeping `purpose`, e.g. a session title) create **no** chat and
record nothing. They stream into a chat id this process generated. Whether the provider accepts an id
it did not create is **not measured** (recon §1.9); if it refuses, the turn fails with the provider's
typed category and never falls back to creating a chat. The route tests assert zero `chats/new` calls
and no recorded conversation for this path.

## 5. Sign-in, re-capture, and what the operator must do

The Qwen account family is shared: `auth.qwen.ai` is the refresh host for both products and the app's
token lives under the same `localStorage["qwen_access_token_state"]` key (recon §1.8). The
**request-writing machinery is reused** where it is genuinely shared: the page token reader, the
bounded hydration wait, the relay/gesture controller, and the single session writer
(`storeProviderSession`).

**But cookies and `localStorage` are per-domain.** A Qwen Code capture made at `coder.qwen.ai` is not a
Qwen Chat session unless its `qwen.ai` cookie is a parent-domain cookie; the importer refuses a capture
that provably has no `chat.qwen.ai`/`qwen.ai` cookie and says so. In practice:

1. **Sign in at `chat.qwen.ai`** — either through the operator surface
   `GET /v1/control/auth/` and choose **Qwen Chat**, or capture at `chat.qwen.ai` with
   `scripts/qwen-storage-state.mjs` and run
   `auth import --provider qwen-chat --from <file>`.
2. The account is usually the same Qwen account as Qwen Code; the *capture* is not.
3. **No restart is needed after signing in**: the session marker is read at call time, and the
   catalogue becomes visible on the next `/v1/models` request. A **restart is needed** after adding a
   `webChat.providers["qwen-chat"]` block or refreshing the model cache, because the listener composes
   its providers and model list once at startup.

The sign-in completion predicate is `GET /api/v2/chats` answering `success:true` (the anonymous answer
is HTTP 200 with `success:false` + `data.code:"Unauthorized"`, recon §1.2). The probe reads the token
from the live page at call time and issues the request from inside that page.

`doctor` reports `webchat-qwen-chat` on the same terms as the other providers, once configured or
signed in.

### 5.1 What the refresh actually needs, measured

The operator's stored capture (`providers/qwen-chat/storage-state.json`) stopped authenticating a day
after it was imported, although a real answer had been delivered from it hours earlier. The service
reported, after a 20 s wait, that *the app still reports no token*. This is what the capture and the
app's own token manager say about why, measured on the deployment on **2026-10-23** with a read of
that file that printed **names, domains, expiry classes and local-storage keys only** — never a cookie
value, a token or a storage value.

#### 5.1.1 The cookie inventory

| Fact | Measured |
| --- | --- |
| Cookies in the capture | 16, **all persistent** (every `expires` is a future epoch; none is `-1`) |
| The refresh credential | `refresh_token`, domain `.qwen.ai`, `httpOnly`, `secure`, `SameSite=Lax`, expires **2026-11-21T13:51:21Z** — exactly 30 days after the sign-in |
| Anti-bot / analytics | `alicfw`, `alicfw_gfver` (24 h), `acw_tc` (30 min), `xlly_s`, `cna`, `cnaui`, `aui`, `isg`, `tfstk`, `ssxmod_itna*`, `_c_WBKFRo` |
| UI | `qwen-locale`, `qwen-theme` |
| Session-only cookies | **none** |
| Access token | `localStorage["qwen_access_token_state"]` — a 281-character JWT, `expiresAt` **2026-10-22T14:06:22Z**, i.e. **899 seconds** (≈15 min) after `updatedAt` |
| Capture / verification | `2026-10-22T13:51:35Z` (the marker beside the file) |

**The blocker is not the Firefox session-cookie limitation.** Firefox never writes session-only
cookies to disk, which would make this path structurally unable to capture a session that needs one —
but this capture contains no session cookie at all, and the one credential the refresh uses
(`refresh_token`) is a persistent, 30-day cookie that a Firefox profile *does* contain. A capture can
therefore hold the refresh credential.

#### 5.1.2 How the refresh is performed

The app's token manager (`KY.refreshToken()` → `performRefresh()` → `performHttpRefresh()` in the
vendor bundle) calls `GET https://auth.qwen.ai/api/v2/auths/refresh` with `withCredentials: true` and
**no** `Authorization` header — the interceptor deliberately omits the bearer for `/auths/refresh`. The
browser therefore supplies the cookies, which is how the httpOnly `refresh_token` reaches the auth host;
the JavaScript never reads that cookie, and the renewed access token is written back into
`qwen_access_token_state`.

#### 5.1.3 Why the snapshot stopped working

The timeline the deployment recorded:

```text
2026-10-22 13:51:35Z  capture verified; access token valid until 14:06:22Z
        (hours later) one real answer was delivered — the token had expired, so the app refreshed
                      at least once, using the stored `refresh_token`
2026-10-23 14:09Z     the service container restarted (its log starts here)
2026-10-23 16:30Z     a turn failed: "after 20000ms the app still reports no token"
```

An access token that lives 15 minutes cannot explain a failure *after* a successful turn hours later,
and the `refresh_token` cookie was still unexpired (until November 21) when the failure happened. What
fits every recorded fact is that the auth host **rotates** the refresh token when it renews: the new
cookie exists only in the browsing context that performed the refresh, and that context is deliberately
thrown away (a probe, the import verification, or a turn's session). The file on disk kept the
**consumed** token, so once the process that held the live context was gone, nothing could renew again.

This rotation is an **inference**, not an observed header: seeing the refresh response's `Set-Cookie`
requires a signed-in capture of that response, which this work did not make. What *is* measured is the
credential class (persistent httpOnly cookie), its 30-day life, the 15-minute access token, and the
success-then-failure timeline above. No other explanation accounts for all four; a session-only cookie
is ruled out by §5.1.1.

#### 5.1.4 What was changed, and what remains the operator's step

A snapshot cannot follow a credential the server rotates, but the deployment can stop **throwing the
rotation away**. Three call sites now keep the state the page produced, all through the one session
writer (`storeProviderSession`, via `storeQwenChatSession`) and only when it changed:

1. **Import** (`session-import.ts`, `auth-import.ts`): the verification page's own `storageState()` is
   what gets stored, not the capture the verification just consumed. An import can therefore no longer
   shorten the session it proves.
2. **A turn** (`browser-session.ts`): after a successful hydration and after the turn settles, the live
   context's state is compared with the file and written back when it moved. A restart now resumes from
   the last rotated `refresh_token`, not from the one a previous turn consumed.
3. **The session-health check** (`auth-health.ts`): a check that made the page renew persists the
   renewal; a failed check writes nothing.

**The shared-credential caveat, stated rather than hidden.** The session check and a live turn can
both hold the same stored credential at once, and the app refreshes on *every* page load whose
token is near expiry (its threshold is 15–18 min; the token's own life is 15 min), so a check is
normally also a renewal. Each renewal is written back (§5.1.4), which is what makes the deployment
recover, but the context that lost the race still holds the old cookie: a turn running across that
rotation can fail one `AUTH_REQUIRED` boundary and then recover from the persisted state on the next
attempt, and the row will say `expired` in between rather than pretending otherwise. Serializing the
check against turns would need a lock shared by two owners that currently do not have one, and was
not invented for this change.

What cannot be fixed from here: once the *server-side* refresh chain ends — a rotation the deployment
was down for, a sign-out on another device, or the 30-day expiry — no stored snapshot can renew, and
the only recovery is a new sign-in. That is why the plugin row shows **Expired — renew** and the
renew action starts the sign-in flow, instead of the operator discovering it by sending a message.

## 6. Recon unknowns, and the single correction point

Recon §1.9 is explicit that a signed-in capture is required to settle several facts. This provider
does **not** fabricate them; each is isolated:

| Unknown | Most defensible shape used | Correction point |
| --- | --- | --- |
| Exact accepted `messages[]` key set | the recorded coder message keys plus every key the chat bundle is shown writing; the operator's HAR confirms the app sends no `headers`/`X-Request-Id` in the body, a string `parentId`, and `parent_id: null` — which keys the server *ignores* is still unmeasured | `qwenChatCompletionRequest` (`network-turn.ts`) |
| Plain-text `sub_chat_type` | `t2t` (the enum's text-to-text value) | `QWEN_CHAT_SUB_CHAT_TYPE` (`provider.ts`) |
| Plain-text `chat_type` | `t2t` | `QWEN_CHAT_CHAT_TYPE` (`provider.ts`) |
| `source` header value | `web` (the sibling Qwen web capture's value) | `QWEN_CHAT_SOURCE` (`provider.ts`) |
| Whether a generated chat id is accepted for an ephemeral turn | send it; never create a chat | `#resolveChat` (`text-transport.ts`) |
| Whether `response.info` can terminate | treat as control only (recon's terminator list excludes it) | `createQwenChatCompletionAccumulator` (`sse.ts`) |
| Whether a continuation cursor is `response_id` or `response_index` | keep `response_id` (falling back to `parent_id`) as the cursor, and record `response_index` in the continuity state for diagnosis only — nothing is switched on an unproven cursor | `#execute` (`text-transport.ts`), `chat-state.ts` |
| Which phase/status closes the turn | §3.0: a status closes a phase (the measured turn's first `finished` closes `thinking_summary`); only the answer phase's `finished`, `[DONE]`, `response.stopped`, an in-band error or the stream close end the turn | `qwenChatDeltaClosesTurn` (`sse.ts`) |
| Whether the anonymous model list is the full menu | hint only; configuration wins | `qwenChatModelList` (`models.ts`) |
| Which refusal the write paths answer with for a **signed-in** page (the recon measured the anonymous ones): a WAF/punish document, a dead session, an unknown chat, a body-shape refusal, or nothing | report the status, the content type and a redacted bounded body snippet, classified into those kinds; do not guess which one | `readQwenChatRefusal` / `qwenChatRefusal` (`network-turn.ts`) |

A single signed-in HAR settles the first four rows; each is a named constant or one function, so the
change is local and its tests already pin the surrounding behaviour. The last row is not settled by a HAR: it
is settled by the **next turn's own refusal**, which §3.1 now preserves verbatim. Nothing is
re-measured and no shape is changed on a guess.

## 7. Tests

| File | What it pins |
| --- | --- |
| `tests/issue-333-qwen-chat-sse.test.ts` | recorded frame shape, content order, KeepAlive ignored, every terminator, in-band error, model re-route, chunk boundaries |
| `tests/issue-333-qwen-chat-empty-stream.test.ts` | the operator's **measured** turn (28 frames: `thinking_summary`×5 closing `finished`, then `answer`×22) producing its 278 characters instead of an empty answer; a reasoning phase's `finished` is a phase close; a role-only opening delta cannot end the stream; the answer is the `answer` phase (reasoning is counted, not returned); `[DONE]`/`response.stopped`/error/stream-close still terminate; the frame observation (frames/shapes/content deltas/excluded chars/signal); the redacted bounded empty-stream message and its single log line; and the transport failing an empty extraction instead of reporting success |
| `tests/issue-333-qwen-chat-modes.test.ts` | the `mv`/`gv` mode matrix, `feature_config` per mode, completion body shape, catalogue levels per ability, public-list parsing/refresh/seed |
| `tests/issue-333-qwen-chat-route.test.ts` | same key → same chat and cursor, lost-chat → typed loss → explicit replay, ephemeral with zero creations, mode selection through the real listener, auth refusal, route/model catalogue |
| `tests/issue-333-qwen-chat-provider-conformance.test.ts` | the shared conformance suite over the production transport/continuity path |
| `tests/issue-333-qwen-chat-session-store.test.ts` | the per-domain capture rule (a Qwen Code capture is refused), origin sanitisation, and the provider-scoped session layout |
| `tests/issue-333-qwen-chat-session-renewal.test.ts` | the capture survives the renewal it causes: an import stores the page's post-verification state (not the snapshot its probe consumed), a live session writes back a changed state after `ready()` and after a turn, an unchanged state and a failed hydration write nothing, and a configured custom path is left to the writer that owns it |
| `tests/session-health-endpoint.test.ts` | `GET /v1/control/auth/health`: present+verified, present+expired (the provider's own validator and its predicate), absent, unverifiable, unreadable, `unknown` on a bound, the cache/TTL, single-flight, the import-seeded cache, the control-token authority, no secret or path in any body, and a renewal written through the single writer |
| `tests/issue-333-qwen-chat-refusal.test.ts` | every refusal kind (punish HTML/JSON, auth, unknown chat, request refusal, empty body), the message and the one `qwen_chat_refusal` log line carrying status + content-type + a redacted snippet, the production facility preserving the raw answer for `chats/new` and `completions`, and a successful stream unaffected |
| `tests/issue-333-qwen-chat-project-header.test.ts` | the install is the deterministic project header plus the user's message only, byte-for-byte the ChatGPT install's identity (§3.3); the continuation sends only the new text; the refusal when an install carries no human message; unresolvable metadata omits the header instead of fabricating one; idempotent injection; the declared-purpose turn and the Advisor seam carry no header; the replay rebuilds canonical history and never duplicates the header |
