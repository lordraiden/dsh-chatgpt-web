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
SSE (recon §1.4): `choices[].delta.content` is concatenated in order; `phase:"KeepAlive"` is neither
content nor a terminator; `sources` is citations. Termination is exactly one of `[DONE]`,
`response.stopped`, a delta `status` other than `typing` (`finished`), an in-band `error`, or the
stream closing.

**The server can re-route the model.** A `selected_model_id` frame is surfaced (the turn result and one
`model-rerouted` diagnostic line); the requested model is never silently overwritten.

Requests are issued **from inside the provider's page** (`createQwenChatPageRequestFacility`), because
the write paths are anti-bot gated (recon §1.7). That is the established `page-context-request` seam,
not a disguise: no user-agent override, no stealth flag, no synthesized baxia/x5sec token. If the page
itself is challenged, the turn fails with an `AUTH_REQUIRED`/access-verification message telling the
operator to complete it in the sign-in page — it is never retried past the challenge.

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

## 6. Recon unknowns, and the single correction point

Recon §1.9 is explicit that a signed-in capture is required to settle several facts. This provider
does **not** fabricate them; each is isolated:

| Unknown | Most defensible shape used | Correction point |
| --- | --- | --- |
| Exact accepted `messages[]` key set | the recorded coder message keys plus every key the chat bundle is shown writing | `qwenChatCompletionRequest` (`network-turn.ts`) |
| Plain-text `sub_chat_type` | `t2t` (the enum's text-to-text value) | `QWEN_CHAT_SUB_CHAT_TYPE` (`provider.ts`) |
| Plain-text `chat_type` | `t2t` | `QWEN_CHAT_CHAT_TYPE` (`provider.ts`) |
| `source` header value | `web` (the sibling Qwen web capture's value) | `QWEN_CHAT_SOURCE` (`provider.ts`) |
| Whether a generated chat id is accepted for an ephemeral turn | send it; never create a chat | `#resolveChat` (`text-transport.ts`) |
| Whether `response.info` can terminate | treat as control only (recon's terminator list excludes it) | `createQwenChatCompletionAccumulator` (`sse.ts`) |
| Whether the anonymous model list is the full menu | hint only; configuration wins | `qwenChatModelList` (`models.ts`) |

A single signed-in HAR settles the first four; each is a named constant or one function, so the change
is local and its tests already pin the surrounding behaviour.

## 7. Tests

| File | What it pins |
| --- | --- |
| `tests/issue-333-qwen-chat-sse.test.ts` | recorded frame shape, content order, KeepAlive ignored, every terminator, in-band error, model re-route, chunk boundaries |
| `tests/issue-333-qwen-chat-modes.test.ts` | the `mv`/`gv` mode matrix, `feature_config` per mode, completion body shape, catalogue levels per ability, public-list parsing/refresh/seed |
| `tests/issue-333-qwen-chat-route.test.ts` | same key → same chat and cursor, lost-chat → typed loss → explicit replay, ephemeral with zero creations, mode selection through the real listener, auth refusal, route/model catalogue |
| `tests/issue-333-qwen-chat-provider-conformance.test.ts` | the shared conformance suite over the production transport/continuity path |
| `tests/issue-333-qwen-chat-session-store.test.ts` | the per-domain capture rule (a Qwen Code capture is refused), origin sanitisation, and the provider-scoped session layout |
