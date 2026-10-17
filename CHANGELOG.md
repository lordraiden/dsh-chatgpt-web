# Changelog

## Unreleased

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
