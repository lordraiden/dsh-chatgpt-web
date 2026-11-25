# DSH plugin — design and operations

The repository ships two artifacts from one package:

- the **container service** (`serve`, the shipping distribution), and
- a **thin DeepSeek Harness (DSH) plugin** that registers that service as a text-only LLM
  provider in DSH.

The plugin is a DSH provider, not a second execution engine: it owns the DSH-facing contract
(session identity, model catalogue, streaming, errors) and delegates every turn to the service over
HTTP. The service keeps owning the browser, the provider conversations, continuity, retries and
concurrency. That split is what lets the plugin inherit every improvement the service gains without
a second implementation.

This document is the authoritative description of the plugin. The container's own operations manual
is [`doc/container.md`](./container.md); the service's architecture and ownership rules are
[`doc/architecture.md`](./architecture.md).

## 1. Decisions

| Decision | Value |
|---|---|
| Integration | Thin plugin over the service HTTP API (attach, never spawn) |
| Providers | `chatgpt-web/*` and `qwen-chat/*` |
| Scope | Text chat only. No tools, no MCP, no Advisor, no Codex/native, no Responses compat |
| Context sent to the provider | Only the workspace name, on the first message of a conversation |
| Session mapping | New DSH session → new provider conversation; reopening a DSH session resumes it |
| Context exhaustion | Declared `contextWindow` per model, so DSH compaction owns the decision |
| Accounts | One account per service instance; two instances for two accounts |
| Packaging | Same repo/package, installable from GitHub tags (`github:lordraiden/dsh-chatgpt-web#vX.Y.Z`) |
| Distribution | The container image remains the primary distribution; the plugin is an optional artifact |

## 2. Architecture

```text
DSH profile (web)
  └── plugin @lordraiden/dsh-chatgpt-web        (lib/plugin.js, client.js)
        ├── apply(ctx, config)                   settings row = settings namespace
        ├── ctx.llm.registerAdapter([...])       text-only LlmAdapter
        ├── adapter.stream(options)  ──HTTP──▶   service /v1/chat/completions (SSE)
        ├── adapter.listModels()     ──HTTP──▶   service /v1/models
        └── settings page            ──HTTP──▶   host route /plugins/dsh-chatgpt-web/status
                                                 (the host proxies the service; the
                                                  control token never reaches the browser)
                                                   │
                                     ┌─────────────┴──────────────┐
                                     │  container service (one    │
                                     │  account per instance)     │
                                     │  Playwright ChatGPT Web /  │
                                     │  Qwen Chat                 │
                                     └────────────────────────────┘
```

The plugin host (`src/plugin.ts`) owns only the DSH-facing seam:

- the loader configuration (`src/plugin/config.ts`) and its live reads;
- the DSH session → workspace-name lookup the adapter sends as first-message context;
- the sanitized logger and the settings-page policy;
- the single `ctx.llm.registerAdapter` registration for both provider routes;
- the same-origin status route, when the profile has a web server.

It owns no transport, no browser, no conversation state and no service lifecycle. The adapter
(`src/plugin/adapter.ts`) is the only place the service wire format is touched. The plugin never
spawns the service, never reads its data volume and never stores a transcript.

Two service instances, one per account:

- instance A (`:17841`) — Hindsight, endpoint profile `hidden` (`temporary` chat);
- instance B (`:17842`) — the DSH plugin, `persistent` chat.

The plugin only needs a base URL, the service API key (optional on loopback) and, for status/auth
reads, the control token. See §8 and
[`doc/container.md` §5.6](./container.md#56-two-accounts-a-second-instance).

## 3. Contracts

### 3.1 DSH → plugin

The plugin registers one `LlmAdapter` for `chatgpt-web` and `qwen-chat`. `stream(options)` is the only
required method; the adapter also implements `providerInfo`, `providerRetryPolicy`, `listModels`,
`resolveModel` and `prepareCall`. It uses:

- `options.sessionId` — the DSH session identity, the conversation affinity key;
- `options.messages` — the conversation; `system`/`developer`/`tool` roles are dropped (§5);
- `options.purpose` — `compaction` / `session-title` auxiliary calls;
- `options.reasoningEffort` — forwarded as `reasoning_effort` for `qwen-chat` only;
- `options.signal` — cancellation propagated to the HTTP request.

`options.tools` is ignored and no tool-call chunk is ever emitted. A text-only provider completes the
agent-loop turn after one step; DSH needs no capability declaration for that.

`resolveModel` returns `context.contextWindow` from the service catalogue and
`inputModalities: ['text']`. Every provider HTTP request carries `attributionHeaders()`.

`providerRetryPolicy` resolves to `maxRetries: 0`: the service already owns browser-turn retry and
turn settlement, so DSH's retry layer must not become a second authority. A turn that reached the
service may already have been submitted to the provider, and resending it because its response was
not observed is the duplicate the architecture forbids.

`prepareCall` binds one model resolution and its eventual request dispatch to the same configuration
read, so a live settings edit cannot pair one generation's `contextWindow` with another generation's
endpoint.

### 3.2 Plugin → service

One turn (streaming):

```http
POST {baseUrl}/v1/chat/completions
authorization: Bearer <apiKey>          # optional on loopback
content-type: application/json
accept: text/event-stream
```

```json
{
  "model": "chatgpt-web/luna",
  "messages": [{ "role": "user", "content": "<current human turn>" }],
  "stream": true,
  "client_metadata": {
    "x-codex-turn-metadata": "{\"dsh_session_id\":\"<session>\",\"workspace\":\"<name>\"}"
  }
}
```

- `baseUrl` is the service root (`http://127.0.0.1:17842`); an endpoint profile is expressed in the
  URL (`http://127.0.0.1:17842/p/<profile>`). The adapter appends `/v1/...`.
- The metadata channel is the strongest identity (`dsh_session_id`), so a DSH session always maps to
  one provider conversation. `workspace` is the first-message header (§3.3) and is sent only on a
  normal turn; an auxiliary call declares `purpose` instead and never declares a workspace.
- A normal turn sends only the newest user message that still carries human text: with identity, the
  service projects exactly that message, so sending the whole history would be redundant. An
  auxiliary call sends the full user/assistant conversation, because the service treats a declared
  `purpose` as an ephemeral turn.
- "Human text" is the service's rule, not a local one: the adapter selects with the same
  `sanitizeConversationText` the service uses, so a trailing runtime or time snapshot the harness
  appended as a `user` message is skipped instead of being sent as the turn. Selecting on raw
  non-empty text would send that snapshot and the service would refuse the request with
  `host_context_only_turn`, losing the human instruction that was still in the conversation.
- SSE: tolerate `: keep-alive` comments, `data: <json>`, `data: [DONE]`, the empty terminal `delta`
  and the absence of `usage`. Errors mid-stream arrive as `data: {"error":{message,type}}` with HTTP
  200 and **no `code`**; non-streaming errors carry `error.code`. Map by code, honour `retry-after`
  on `429`, never resend a submitted turn.
- Models: `GET {baseUrl}/v1/models` → `models[]` (`slug`, `display_name`, `context_window`,
  `supported_reasoning_levels`). `data[]` is accepted only when `models[]` is absent, and rows read
  from it declare no window, so resolution fails closed. The plugin serves `chatgpt-web/*` and
  `qwen-chat/*` only.
- Status/auth: `GET {baseUrl}/v1/control/status` and `/v1/control/auth/health` with the control
  token; the sign-in page is `{baseUrl}/v1/control/auth/` (anonymous by design).

Failure mapping is code-first, because the service re-derives the HTTP status from its adapter code
(a `context_exhausted` failure arrives as HTTP 400, not 409). The codes that matter:

| Service `error.code` | DSH code |
|---|---|
| `context_exhausted`, `context_length_exceeded` | `CONTEXT_WINDOW_EXCEEDED` |
| `turn_queue_timeout`, `turn_queue_full`, `rate_limit_exceeded` | `RATE_LIMIT` |
| `endpoint_profile_concurrency_exceeded` | `RATE_LIMIT` |
| `insufficient_quota` | `QUOTA` |
| `chatgpt_session_expired`, `qwen_session_missing`, `invalid_api_key` | `AUTH` |
| `unknown_model` | `UNKNOWN_MODEL` |
| `endpoint_profile_*` | `UNSUPPORTED_OPTION` |
| `retained_surface_lost`, `settlement_wait_timeout`, `turn_timeout`, `qwen_chat_lost` | `SERVER` |
| `client_cancelled`, `client_closed_request` | `ABORTED` |

HTTP 401/403 map to `AUTH`, 429 to `RATE_LIMIT`, 5xx to `SERVER`; `retry-after` becomes
`providerRetryAfterMs` and `x-request-id` becomes the opaque request id. A mid-stream failure is
classified from `type`/`message` only, and defaults to `SERVER`.

### 3.3 Service change: declared workspace in the first-message header

The normal-chat install header is the **service package identity**
(`Project: "dsh-chatgpt-web"` plus a `github:` line). The plugin needs the **workspace name**
instead, and only on the first message of a conversation.

The service accepts an optional `workspace` field in `client_metadata["x-codex-turn-metadata"]`
(parsed next to `dsh_session_id`/`thread_id`/`purpose`) and the ChatGPT Web and Qwen Chat install
compilers use it:

```text
Project: "<workspace>"

<first human message>
```

Rules:

- the workspace is a **name, never a path** — the last non-empty path segment is used, so a caller
  cannot put a local filesystem path into a provider's first message;
- a declared workspace wins and carries **no `github:` line**;
- without one, the existing package-identity header is kept unchanged, so other callers (Hindsight,
  OpenAI-compatible clients) see no regression;
- the header is emitted only by the install path, never by a continuation;
- the workspace is initialization context, not identity: it never participates in the conversation
  key.

## 4. Session mapping and continuity

- The plugin sends `dsh_session_id` on every turn. The service derives the conversation key from
  `{providerId, bindingId, dshSessionId, threadId, namespace}`; the model is not part of the key.
- A new DSH session has a new id → a new provider conversation.
- Reopening a DSH session reuses the id → the service resumes the durable provider conversation
  (`<data dir>/web-chat/conversations.json`). Continuity loss is a typed failure, never a silent
  fork.
- The plugin keeps no transcript and no conversation state of its own. If the session id is absent
  the service falls back to its own identity chain, which is isolation, not continuity — DSH always
  supplies the id.

## 5. Text-only behaviour

- `system`/`developer`/`tool` messages are not forwarded on a normal turn. The only initialization
  context is the workspace header of §3.3, on the first message.
- `options.tools` is ignored; no tool-call chunk is emitted; `toolHistory` is never read.
- For `purpose: "compaction"` / `"session-title"`, the system instruction is **prepended to the last
  user message** (the service has no system slot), because those auxiliary calls are instructions,
  not DSH context. The conversation messages are sent in full for those calls.
- Images/files/audio are refused: the plugin declares `inputModalities: ['text']`, so DSH projects
  images to text before the adapter, and a non-text block that still arrives fails the turn with
  `UNSUPPORTED_CONTENT` instead of being dropped.

## 6. Context window and compaction

`resolveModel` reads `context_window` from the service catalogue and returns it as
`context.contextWindow`, which is what DSH compaction uses to decide when a session is under
pressure. The plugin does not estimate or invent a window: an unavailable catalogue, a row without a
`context_window`, or a row read from the `data[]` shape fails model resolution with `UNKNOWN_MODEL`
instead of guessing.

The catalogue is cached for 30 s per service root. A failed refresh never falls back to a stale
catalogue — a model that disappeared must fail resolution rather than be served from a previous
generation. `listModels` is advisory and never throws: an unavailable catalogue yields an empty list
and one sanitized diagnostic per distinct failure.

`compaction` and `session-title` calls are served like any other text call. A compaction call that
ends with `max-tokens` is an error in DSH, so the adapter reports the finish reason truthfully
instead of truncating silently.

## 7. Settings page, status route and sign-in link

`client.js` registers a `settings.section` page (DSH `dsh.client` manifest, `platform: web`). The
settings namespace is the loader row id `dsh-chatgpt-web`, so the page, the `configForms` entry and
the `cordis.patch.yml` row all address the same value. Fields:

| Field | Kind | Notes |
|---|---|---|
| `baseUrl` | text | service root; may include `/p/<profile>` |
| `apiKey` | secret | service API key; optional on loopback |
| `controlToken` | secret | status/auth only; never persisted in browser storage |
| `model` | select | from the live catalogue, `chatgpt-web/*` + `qwen-chat/*` |
| `requestTimeoutMs` | number | 0 = no client timeout (the service sends keep-alive) |
| status | read-only | service health, account/auth state, catalogue count |
| auth page | link | `{baseUrl}/v1/control/auth/` |

The Host owns schema, defaults and persistence (`configForms`); every field is declared `volatile()`,
so saving applies the change live without a restart and without remounting the plugin. `apiKey` and
`controlToken` are `role('secret')`: the Host redacts them from descriptors and the page only learns
whether one is configured. The page holds a typed secret in component memory until it is saved —
never in browser storage, never in a URL.

**The browser never talks to the service.** The page runs in the GUI's browser origin and the
service is a different origin whose CORS covers only `/v1/control/*`, so the plugin host answers the
page on the same origin:

```text
GET /plugins/dsh-chatgpt-web/status     # exact route, registered by the plugin host
```

The host queries the service server-side (`/healthz`, the guarded `/v1/control/status` and
`/v1/control/auth/health`, and the catalogue) and returns one JSON body:

```json
{
  "service": { "reachable": true, "version": "<service version>", "status": "ok", "error": null },
  "auth": { "configured": true, "state": "verified", "detail": null },
  "models": ["chatgpt-web/luna", "qwen-chat/qwen3.7-plus"],
  "controlBase": "http://127.0.0.1:17842",
  "authPageUrl": "http://127.0.0.1:17842/v1/control/auth/"
}
```

- The route is read-only and total: it always answers `200 application/json` (also for `HEAD`), even
  when the service is down or the token is rejected, so a status panel can say "unreachable" instead
  of failing the page load. Any other method gets `405` with `Allow: GET, HEAD`.
- The whole read is bounded (5 s), and every echoed string is truncated and has the configured
  secrets redacted. The response never carries `apiKey` or `controlToken`.
- `auth` is `null` when no control token is configured, because the guarded surface cannot be read
  at all — the page then shows "control token required" rather than a guessed state.
- `baseUrl` is split into the control root (for `/healthz` and `/v1/control/*`) and the full API base
  (for `/v1/models`), because the service resolves the control surface before the endpoint-profile
  prefix.
- The route is optional: a profile whose host has no web server simply has no status route, and the
  provider registration is unaffected. The sign-in link is a plain navigation to the service's own
  page; the control token is never put in the URL.

## 8. Two accounts

`docker-compose.plugin.yml` adds a second instance:

```text
chatgpt-web        :17841  volume dsh-chatgpt-web-data        account A (Hindsight)
chatgpt-web-plugin :17842  volume dsh-chatgpt-web-data-plugin account B (DSH plugin)
```

```bash
docker compose up -d --wait                                # instance A, :17841
docker compose -f docker-compose.plugin.yml up -d --wait    # instance B, :17842
```

Each instance signs in its own account through its own `/v1/control/auth/` page. Hindsight points at
`http://chatgpt-web:17841/p/hidden/v1`; the plugin points at `http://127.0.0.1:17842`. The accounts
never share a browser profile, a conversation store or a concurrency budget. The full operational
detail (ports, volumes, backup, Compose projects) is
[`doc/container.md` §5.6](./container.md#56-two-accounts-a-second-instance).

## 9. Packaging, release and installation

One package, two artifacts:

- `package.json`: `main: ./lib/plugin.js`, `exports` for `.`, `./client`, `./cordis.patch.yml`,
  `./package.json`; `files` includes `lib`, `src`, `client.js`, `cordis.patch.yml`, `assets`,
  `LICENSE`; `dsh.bundle.patch` and `dsh.client` (`platform: web`, `immediately: true`);
  `engines.dsh` and peers matching the supported DSH (`cordis ^4.1.0`, `dsh-llm ^0.2.2-rc.3`);
  `prepare: bun run build` so a git install builds the bundles.
- `build` compiles `src/cli.ts` **and** `src/plugin.ts`; `client.js` is a hand-written browser
  module (no bundler required).
- CI builds both entries and the tarball smoke test asserts the plugin entry, `client.js`,
  `cordis.patch.yml` and the `dsh.bundle.patch` / `dsh.client` manifest fields are present.
- Tags are created by CI from the verified `main` commit (unchanged release contract). A tag
  therefore contains the built plugin bundles.

Install from a tag:

```bash
dsh plugin add github:lordraiden/dsh-chatgpt-web#vX.Y.Z
# or via the plugin manager UI with the same spec
```

A git install runs `prepare`, so the plugin manager asks for build approval (`allowBuilds`) once.
`engines.dsh` is the compatibility gate: a DSH release outside the supported range is refused rather
than loaded silently. The container image remains the primary distribution; the plugin is an
optional artifact of the same package, and there is no private npm registry and no
`dsh plugin update` contract.

## 10. Verification

```bash
bun run typecheck      # both entries, no emit
bun run build          # lib/cli.js and lib/plugin.js
bun run test           # the CI gate: service, contracts, container pin, authority, tarball smoke
bun run test:plugin    # the plugin suite (adapter, SSE, errors, catalogue, host, status route)
node scripts/smoke-tarball.mjs [path/to.tgz]   # packaging: both artifacts and the manifest fields
```

The plugin suite (`tests/plugin/`) covers:

- SSE parsing: keep-alive comments, `[DONE]`, the empty terminal delta, a mid-stream error frame, a
  frame split across reads, a missing terminal frame;
- error mapping: the code table of §3.2, `retry-after`, `x-request-id`, bounded and credential-free
  detail;
- catalogue: `models[]` and `data[]`, `context_window`, reasoning levels, the 30 s cache, never
  throwing when the service is down;
- payload: the exact request body (model, metadata, no tools), normal versus auxiliary messages,
  workspace extraction, system prepending, non-text refusal;
- host: one registration for both routes, the workspace lookup, the status route, the settings
  policy.

The service side of §3.3 — metadata parsing, the ChatGPT install header, the Qwen install header and
the fallback to the package identity — is pinned by `tests/plugin-workspace-header.test.ts`.

End-to-end (manual, real account): install in the DSH profile, run one real ChatGPT Web turn,
reopen the session and confirm continuation, and confirm the first-message workspace header.

## 11. Known limits

- **Streaming has no `usage`.** The service does not emit it, so DSH token accounting for this
  provider is absent; the service reports its own counters through `/v1/control/status`. The adapter
  forwards a usage chunk if a future service includes one.
- **The compaction prompt can carry the package identity header.** An auxiliary call declares
  `purpose` and no workspace, so the service compiles its normal install header
  (`Project: "dsh-chatgpt-web"` plus the `github:` line) into the summarization prompt. It is
  internal context for a summarization call and is never shown to the user; a declared workspace
  cannot be used there because it would pollute the summary instruction.
- **A git install needs build approval.** `prepare` runs `bun run build`, which pnpm gates behind
  `allowBuilds`; the first install therefore waits for one approval. A `bun` on the host is
  required.
- **The container remains the primary distribution.** The plugin adds a DSH provider to an existing
  service; it does not replace the image, the Compose stacks or the CLI.
- **No tools, no Advisor, no Codex/native, no Responses compatibility.** Those stay ChatGPT-specific
  service functionality and are not part of the plugin's contract.
- **DSH version drift.** `engines.dsh` pins the supported range; a new DSH release is a deliberate
  compatibility check, not a silent upgrade.

## 12. Out of scope

Advisor, Codex/native passthrough, Responses compatibility, tools/MCP, images/files, the old
sidecar spawn/agreement, and the private npm registry contract.

## 13. Further reading

- [`doc/container.md`](./container.md) — the container operations manual, including
  [§5.6 two accounts](./container.md#56-two-accounts-a-second-instance).
- [`doc/architecture.md`](./architecture.md) — the ownership model and durable rationale.
- [`README.md`](../README.md#dsh-plugin) — installation and configuration summary.
- [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md#24-the-dsh-plugin) — plugin-specific diagnosis.
