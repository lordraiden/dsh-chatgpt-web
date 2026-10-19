# Adding a second WebChat provider

> **Scope — read this first.** This is an **operational procedure** for adding the second (Qwen, then
> DeepSeek) provider to an existing, working WebChat seam. It is deliberately:
>
> - **not architecture.** The ownership model, the identities, the exchange lifecycle and the durable
>   rationale are owned by [`doc/architecture.md`](./architecture.md). This document points there
>   instead of restating it.
> - **not a README.** User-facing behavior, the API surface and the supported features are owned by
>   [`README.md`](../README.md).
> - **not a changelog and not a design proposal.** It records what the repository already decided and
>   already paid for, so the next vendor does not rediscover it.
>
> Where this document and the code disagree, the code and its tests win. Every claim below was checked
> against the tree it was written in; the few claims that could not be verified are marked
> **unverified** with what would verify them.
>
> **The product is currently single-provider by design.** ChatGPT Web is the current and only route
> ([`AGENTS.md`](../AGENTS.md) → *Architectural direction*); Qwen and DeepSeek are roadmap providers. The shared
> contracts, the ChatGPT migration, the service host integration and the conformance suite are the
> delivered stages, and the provider migration order is fixed ([`AGENTS.md`](../AGENTS.md) → *Provider migration
> discipline*). Do not skip them or copy ChatGPT's adapter.

## 0. Authoritative homes (do not keep a second copy)

| Fact | Authoritative home |
| --- | --- |
| Mandatory invariants, provider boundaries, security rules | [`AGENTS.md`](../AGENTS.md) — link, never restate |
| Ownership model, identities, exchange lifecycle, rationale | [`doc/architecture.md`](./architecture.md) §4, §6–§18, §24 |
| Core module map and the provider-consumption reference | [`doc/web-chat-core.md`](./web-chat-core.md) |
| Container operations, data volume, credentials, sign-in | [`doc/container.md`](./container.md) §4.1, §5.5 |
| Operational diagnosis and current limitations | [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) §10, §11.0b, §13 |
| The provider driver / transport / auth contracts in code | `src/web-chat/core/**`, `src/web-chat/transport/**` |
| The shared semantic suite | [`tests/web-chat-provider-conformance.ts`](../tests/web-chat-provider-conformance.ts) |

## 1. The checklist: what a new driver must implement

This list is derived from the **conformance suite as it exists** — [`tests/web-chat-provider-conformance.ts`](../tests/web-chat-provider-conformance.ts),
run by [`tests/issue-194-web-chat-provider-conformance.test.ts`](../tests/issue-194-web-chat-provider-conformance.test.ts) —
and from the interfaces it exercises, not from an idealised design. A provider that does not satisfy
this file is not delivered.

### 1.1 The provider driver contract

`WebChatProviderDriver` in [`src/web-chat/core/provider.ts`](../src/web-chat/core/provider.ts). Every
member is required unless noted:

| Member | What the suite and the host require of it |
| --- | --- |
| `id: string` | The catalogue/provider id this driver serves; the provider id of a public route (`<providerId>/<modelId>`) is matched against it. |
| `inspectAccount()` | `authenticated: true` for a genuinely signed-in account, plus an `accountFingerprint` and optional `capabilities`. A **derived** identity must not be reported as authenticated (see §4.3). |
| `listModels()` | Provider-local `WebChatModelDescriptor`s: `{ id, label, text: true, reasoningModes?, contextWindow?, providerDetail? }`. `id` is provider-local; it is **not** the public route. |
| `resolveModel(model, reasoningMode?)` | Resolves an already-selected route/model to a descriptor, or `undefined`. An unsupported route and an unsupported reasoning mode both return `undefined` — never a substitute. |
| `assessConversation(input)` | The driver's own verdict: `new`, `resumable`, `replay_required`, `lost`, `unreachable`, `unsupported`. May hand back a `conversation` it reconciled itself. |
| `createConversation(input)` | Opens a provider conversation for the affinity. Distinct account/session identities must produce distinct `key`s **and** distinct opaque `handle`s. |
| `resumeConversation(input)` | Continues an existing conversation; the generation does not advance. |
| `replayConversation(input)` | Rebuilds from canonical text history; the generation **advances** and the handle changes. |
| `health()` | `{ ok, detail? }`, surfaced by `doctor` (see §5.2). |
| `shutdown()` | Releases everything the driver owns. **Must be idempotent** — the suite calls it twice. |

Contract rules the suite enforces directly:

- `descriptor.id !== model.route`: the provider-local descriptor id and the public route id are
  different strings.
- `createConversation(...).providerId === driver.id` and `.bindingId === webChatAccountBindingId(binding)`
  — the driver does not invent either.
- The conversation `key` is the core's affinity key (`webChatAffinityKey`), and the `handle` stays
  **opaque**: the core stores, persists, compares and passes it, and never parses it.
- Replay state must fail closed across providers/bindings (`assertWebChatReplayStateOwner` throws
  `CONVERSATION_STATE_MISMATCH` when it does not provably belong to the requested conversation).

### 1.2 The transport contract

`WebChatTextTransport` in [`src/web-chat/transport/text-transport.ts`](../src/web-chat/transport/text-transport.ts).
The host runs it through the shared exchange runner; the provider does **not** re-implement the
lifecycle:

| Member | Required behaviour |
| --- | --- |
| `id: string` | Stable transport identity, for diagnostics. |
| `ready(context)` | Reach readiness. A rejection is a **pre-submission** failure (retry-safe: nothing was sent). |
| `submit(context)` | Return the provider's own admission: `prepared` (nothing sent → retry-safe), `send_activated` (may have been sent → ambiguous, never auto-retried) or `accepted` (confirmed). Throwing is **never** a way to say "nothing happened". |
| `stream(context)` | Yield the normalized event vocabulary (`ready`, `submitted`, `text_delta`, `completed`, `cancelled`, `error`). A transport that cannot continue must end the stream or yield `error`; it must not go silent. |
| `settle(context)` | The only authority on physical settlement. Report `pending` when it cannot be established yet and `rejected` when it cannot be established at all. An error or timeout is never proof the provider stopped. |
| `abort?(context, reason?)` | Optional; idempotent from the caller's perspective. |

The core examines what these methods *report*, never how the provider found it. A DOM transport, a
browser-network transport, a hybrid or a non-page session are all admissible (architecture §12).

### 1.3 The optional interactive-auth capability

A provider that needs a human to sign in implements `ProviderAuthController` and `ProviderAuthSession`
in [`src/web-chat/core/auth.ts`](../src/web-chat/core/auth.ts). This is optional: a provider with no
`ProviderAuthController` is simply not offered for interactive sign-in.

- Controller: `startAuth(): Promise<ProviderAuthSession>` and
  `storeCapture(capture: AuthCapture): Promise<ProviderAuthStoreResult>`.
- Session: `providerId`, `state(): AuthSessionState`, optional `detail()`, `view()`, `input(event)`,
  `capture()`, `cancel()`.
- The state vocabulary is exactly `starting | awaiting_input | verifying | captured | failed | expired`.
- `AuthInput` is exactly `click | drag | type | key | scroll | navigate` — intents, not browser commands.
  A `drag` is an ordered path of sampled points (`{x, y, atMs}[]`, press first, release last) in the
  same coordinate space as a `click`, so a slider-style verification is expressed as the gesture the
  operator made rather than as a synthetic straight line. The page may sample coarsely (it publishes
  its interval and sample cap; a long gesture is thinned, never interpolated), the press and release
  are the mapped `pointerdown`/`pointerup`, and a controller replays the offsets against the press's
  clock within a bounded pacing budget rather than sleeping every delta again.
- `view()` is **optional in practice**: the host must accept a provider that reaches `captured`
  without ever producing a frame (device code, OTP, API-key paste). A frame failure is never a session
  failure.
- The captured material (`AuthCapture`) is opaque: `{kind:"browser-storage"}`, `{kind:"opaque"}` or
  `{kind:"none"}`. The host validates the envelope and never reads inside it.
- `providerId` must be the catalogue/driver id — the ChatGPT controller asserts
  `CHATGPT_WEB_AUTH_PROVIDER_ID === CHATGPT_WEB_ROUTE_ID === CHATGPT_WEB_DRIVER_ID`
  ([`tests/issue-276-chatgpt-auth-controller.test.ts`](../tests/issue-276-chatgpt-auth-controller.test.ts)).
  Do not mint a third id for sign-in.

### 1.4 The host composition (driver + turn seam)

A driver alone does not serve a turn. The provider also composes a `WebChatProviderRuntime` in
[`src/web-chat/host/text-turn.ts`](../src/web-chat/host/text-turn.ts) — the driver plus
`openTextExchange(request)` (returning a `WebChatTextExchangeHandoff` from
[`src/web-chat/host/text-exchange.ts`](../src/web-chat/host/text-exchange.ts)) and, only if it retains
a readable conversation, `recoverTextTurn(request)`. The handoff supplies provider-resolved `identity`,
`turn`, `transport`, optional `epoch`, shared `leases`, `createResource` and one `dispose`. The host
supplies the lifecycle around them; the provider supplies no retry policy.

The ChatGPT reference composition is
[`src/adapters/chatgpt-web/provider-runtime.ts`](../src/adapters/chatgpt-web/provider-runtime.ts).

### 1.5 What the conformance suite actually asserts

The suite (`defineWebChatProviderConformanceSuite(fixture)`) drives a **real** provider path through
the following scenarios. This is the acceptance bar for §1.1–§1.4:

1. **Authentication, model and reasoning compatibility are explicit.** The account reports
   authenticated, health is `ok`, `listModels()` exposes the descriptor, `resolveModel` honours the
   route and rejects an unsupported route and an unsupported reasoning mode.
2. **Account and DSH-session identities produce isolated affinities.** Three different
   (account, session) selections produce three distinct keys and three distinct handles.
3. **Durable records and opaque replay state reject cross-provider reuse.** The turn persists a
   record in the store; a peer provider's identity does not read it; foreign replay state throws.
4. **Lineage is preserved across first, second and third turns.** Each turn completes with
   `text_delta` + `completed`, exactly one send attempt and one confirmed submission, a `confirmed`
   checkpoint, a stable identity/generation/handle/lineage token, and `remoteConversationReused`
   false then true. Only the **new** user text is compiled on continuation
   `compiledPrompt === "conformance turn-2"`. `assessConversation(...)` says `resumable` and
   `resolveWebChatContinuation({kind:"continue"})` says `exact_resume`.
5. **Cancellation, provider errors, partial output and ambiguous sends are classified safely.**
   The exact matrix:

   | Scenario | outcome | sendAttempts | confirmedSubmissions | retryable |
   | --- | --- | --- | --- | --- |
   | `cancel_active` | cancelled | 1 | 1 | false |
   | `authentication_loss` | failed | 0 | 0 | false |
   | `provider_error` | failed | 1 | 1 | false |
   | `partial_failure` | failed (with `text_delta`) | 1 | 1 | false |
   | `ambiguous_submission` | failed | 1 | 0 | false |

6. **Lost process-local continuity fails closed until explicit replay is selected.** After `restart()`,
   an implicit continuation fails; an explicit replay succeeds with `generation + 1` and an
   `unconfirmed` checkpoint.
7. **Restart follows the provider's declared recovery mode** (`exact_resume`, `explicit_replay` or
   `unsupported`), asserted through the native path — see §1.6.
8. **Shared exchange ownership rejects concurrent turns and stale epochs.** This half is shared core
   code; the provider only has to supply a real conversation key and epoch.
9. **A late native event from a settled turn cannot alter another turn**
   (`assertStaleNativeTurnIsolated()`).
10. **Provider shutdown is idempotent.**

### 1.6 The fixture a vendor writes

The suite is parameterized by a `WebChatProviderConformanceFixture`; the ChatGPT one is
`createHarness()` in [`tests/issue-194-web-chat-provider-conformance.test.ts`](../tests/issue-194-web-chat-provider-conformance.test.ts) and is the template to
copy from:

- `name: string`.
- `create(): Promise<WebChatProviderConformanceHarness>` returning
  `{ driver, store, selection, namespace, model, restartRecovery, runNativeTurn, restart, assertStaleNativeTurnIsolated, shutdown }`.
- `restartRecovery` is the provider's **honest** recovery declaration:
  - `"exact_resume"` — after restart the record keeps its generation and handle;
  - `"explicit_replay"` — a successful turn after restart has `generation + 1`, a `confirmed`
    checkpoint, and its compiled prompt contains the replayed canonical history;
  - `"unsupported"` — a turn after restart fails with **zero** send attempts.
- `runNativeTurn` must exercise the provider's **actual** adapter/continuity path; only physical web
  I/O may be replaced by a fixture ([`tests/issue-194-web-chat-provider-conformance.test.ts`](../tests/issue-194-web-chat-provider-conformance.test.ts)
  → `ControlledSurface`). The harness returns provider-neutral observations, including an opaque
  `lineageToken` that the shared suite only compares, never interprets.
- `restart()` recreates process-owned driver/adapter state while preserving only configured durable
  state. `shutdown()` must be idempotent.

### 1.7 Running the suite against a new driver

1. Add the fixture as a new test file, e.g. `tests/issue-<n>-<provider>-provider-conformance.test.ts`,
   importing `defineWebChatProviderConformanceSuite` from `./web-chat-provider-conformance`.
2. Run it directly:
   ```bash
   bun test tests/issue-<n>-<provider>-provider-conformance.test.ts
   ```
3. Add that file to the `test` script in [`package.json`](../package.json). `bun run test` is the CI gate
   ([`AGENTS.md`](../AGENTS.md) → *Verification*); `bun test` alone is **not** it. ChatGPT's entry is
   `bun test ./tests/issue-194-web-chat-provider-conformance.test.ts` — a new suite that is not in
   that chain is not run by CI.
4. Keep the provider-specific transport tests separate (architecture §24.3): authenticated
   readiness, visible model discovery, composer submission activation, submission confirmation, text
   extraction, completion detection, abort, resource close, physical settlement. No transport test may
   read internal network responses to obtain model output (architecture §26.3).

> **Unverified here:** the suite asserts its own neutrality only by construction — there is exactly one
> fixture today, and the file's stated intent ("A future provider can implement this shape without
> importing or emulating ChatGPT internals") is not itself under test. The second fixture is what
> verifies it; if it needs a change to [`tests/web-chat-provider-conformance.ts`](../tests/web-chat-provider-conformance.ts), that change is a
> finding about the shared suite, not a license to fork it.

### 1.8 Definition of done

- [ ] `WebChatProviderDriver` implemented, with honest `inspectAccount`/`health`.
- [ ] `WebChatTextTransport` implemented; submission phases reported truthfully.
- [ ] `WebChatProviderRuntime` composed (`openTextExchange`; `recoverTextTurn` only if it retains).
- [ ] `ProviderAuthController` implemented if it needs interactive sign-in (§1.3, §2.5).
- [ ] Credentials layout (§4.1), catalogue rows (§4.2) and account binding (§4.3) wired.
- [ ] Diagnostics wired from day one (§5).
- [ ] The conformance fixture passes and is in the `bun run test` chain (§1.7).
- [ ] `bun run typecheck` clean; the relevant provider-specific transport tests added.

## 2. What a vendor inherits and must NOT re-litigate

Each row: one sentence of *what*, plus the owner. Do not copy these into the driver, and do not
renegotiate them because a provider's product behaves differently.

1. **The neutral interactive-auth contract.** Sign-in is expressed as provider-owned
   `ProviderAuthController`/`ProviderAuthSession` over the fixed state vocabulary and `AuthInput`
   vocabulary, with opaque captures and optional pixels — the host is a pixel/input relay that never
   navigates, reads a DOM or decides completion. **Owner:** [`src/web-chat/core/auth.ts`](../src/web-chat/core/auth.ts)
   (contract), [`src/web-chat/host/auth-surface.ts`](../src/web-chat/host/auth-surface.ts) and
   [`src/web-chat/host/auth-sessions.ts`](../src/web-chat/host/auth-sessions.ts) (relay/lifecycle).

2. **Capability declarations are discarded and declared; attached content is refused.** A
   *capability* (`tools`, `toolChoice`, `mcp`, and the legacy aliases) is accepted, discarded, never
   forwarded, and declared to the caller via `x-dsh-chatgpt-web-ignored-features` plus one log line; a
   *content* feature (files, images, audio, video, attachments, non-text parts) fails explicitly with a
   stable `UNSUPPORTED_OPTION`-class refusal. Do not "restore" the old refusal of tools.
   **Owner:** [`src/web-chat/core/exchange.ts`](../src/web-chat/core/exchange.ts)
   (`WEB_CHAT_CAPABILITY_FEATURES` vs `WEB_CHAT_CONTENT_FEATURES`) — one list, no second copy.
   Rationale in [`AGENTS.md`](../AGENTS.md) → *Text-only common scope* and
   [`README.md`](../README.md) → *Text-only*.

3. **Per-caller conversation identity.** An API caller's provider conversation is decided once, by the
   projection: an explicit `user`/`session_id` **is** the identity; with none it is derived from the
   canonical content of the transmitted messages (`dsh-chat-<hash>`), never per request — so a caller
   cannot be fused with another and a retry does not fork a second conversation. A provider must not
   mint its own conversation identity from session state, and must not collapse callers onto a
   constant. **Owner:** [`src/web-chat/host/api-projection.ts`](../src/web-chat/host/api-projection.ts)
   (`projectApiConversation`, `contentConversationIdentity`); reached on the Responses side through
   `extractChatGptTurnIdentity` in [`src/adapters/chatgpt-web/environment.ts`](../src/adapters/chatgpt-web/environment.ts).
   The core affinity key requires a non-empty host session identity
   ([`src/web-chat/core/conversation-key.ts`](../src/web-chat/core/conversation-key.ts)).

4. **Bounded retained-surface eviction, if the provider retains a physical resource.** A provider that
   keeps a physical page/session per conversation must bound it: the ChatGPT registry keeps at most
   `DEFAULT_MAX_RETAINED_SURFACES` (16) surfaces, retires one idle beyond
   `DEFAULT_RETAINED_SURFACE_IDLE_TIMEOUT_MS` (30 min), and treats **eviction as retirement, never
   reuse** — the key is tombstoned and a later turn fails with a continuity-loss error until an
   explicit replay/reset. The idle sweep must actually run outside acquisition (the ChatGPT worker
   drives it from its steady tick), and a surface with an active turn or an unpublished settlement is
   never retired. **Owner:** [`src/adapters/chatgpt-web/retained-surface.ts`](../src/adapters/chatgpt-web/retained-surface.ts)
   (provider-local — the core owns no page); the invariant to reproduce is in
   [`AGENTS.md`](../AGENTS.md) → *One active turn per logical conversation* and architecture §9.3/§15.3/§19.1.

5. **The sign-in surface already serves any provider.** `GET /v1/control/auth/` and its endpoints are
   provider-neutral: they list registered providers, open one session per provider, relay
   frames/input, and hand the provider's own capture back to the provider's own `storeCapture` once.
   A new provider becomes available there by being **registered**, not by touching the page.
   **Owner:** [`src/web-chat/host/auth-surface.ts`](../src/web-chat/host/auth-surface.ts),
   [`src/web-chat/host/auth-page.ts`](../src/web-chat/host/auth-page.ts); registration in
   [`src/server.ts`](../src/server.ts) (`createWebChatAuthSurface({ providers: [...] })`), documented
   in [`doc/container.md`](./container.md) §5.5.

Also inherited and not to be re-litigated: the **retry boundary** (the exchange owns retry safety; a
provider may not add its own automatic resend), **one active turn per logical conversation**, **no
silent fork** (explicit resume/replay/failure only), and **durable continuity** as opaque state the
core stores and the provider interprets. See [`AGENTS.md`](../AGENTS.md) → *WebChat architecture
invariants* and [`doc/web-chat-core.md`](./web-chat-core.md).

## 3. What the driver owns (vendor-specific)

The other half of the boundary: these are **yours**, and none of them may leak into
`src/web-chat/core/**`. Do not invent an API-level protocol for them, and do not make the core aware
of a selector, an endpoint or a provider DTO.

- authentication/session bootstrap — including persistent browser state, interactive verification and
  anti-bot/access-verification behavior;
- account binding (which account this deployment signed in as — §4.3);
- model discovery/resolution for the Web product, and reasoning/mode mapping;
- provider conversation identifiers/cursors (kept opaque behind the handle);
- submission activation and completion detection;
- response parsing;
- the provider-specific transport (DOM, browser-network, hybrid, or another authenticated web-native
  mechanism);
- provider-specific recovery and retention (if it retains anything — §2.4).

The canonical statement of these responsibilities is [`AGENTS.md`](../AGENTS.md) → *Provider-specific
responsibilities*; the design expectations per provider are architecture §21.1–§21.3, the interaction
architecture §12, authentication/session §13 and model architecture §14. **Do not assume API model IDs
or API transport semantics describe the consumer-Web product** ([`AGENTS.md`](../AGENTS.md)).

Note the two things that are explicitly *not* the driver's: provider selection/public routing (the
service's configured catalogue is authoritative, architecture §8.4/§17) and the retry policy (the
exchange owns it). `createWebChatDriverResolver` exists in
[`src/web-chat/core/resolver.ts`](../src/web-chat/core/resolver.ts) as the resolution-only seam; the
current host composes its driver/runtime directly rather than routing every turn through it, so do not
assume a generic multi-provider turn router is already wired.

## 4. Per-provider credentials and the catalogue

### 4.1 Credential layout

A provider session is a browser session, not an API key. The layout inside the data volume
(`DSH_CHATGPT_WEB_HOME`) is:

```text
providers/<providerId>/storage-state.json
providers/<providerId>/storage-state.json.verified.json   # the verification marker
browser/storage-state.json (+ marker)                     # legacy alias, read-only compatibility
```

- **Owner of the layout:** [`src/config.ts`](../src/config.ts) — `providerCredentialsDir`,
  `providerStorageStatePath`, `storageStateMarkerPath`, and the read resolver
  `resolveProviderStorageStatePath`. The resolver prefers the provider-scoped path (a file **or just
  its marker** selects it) and falls back to the configured/legacy path, so an existing installation
  keeps working with no migration and no rewritten `config.json`.
- **The marker is what makes a session real:** `browserLoginStateExists()` requires both files, and
  the marker must carry `version: 1`, `authenticated: true` and a `verifiedAt` string.
- **A new provider gets its own directory by passing its own `providerId`;** one provider's directory
  can never satisfy another provider's check ([`tests/issue-249-provider-credentials.test.ts`](../tests/issue-249-provider-credentials.test.ts)).
- Writes are atomic and private (mode `0600`); cookies are never printed. `auth import` is
  fail-closed: it verifies the capture **first** and writes nothing on failure.
- Operations facts and the exact `auth import`/`login` flow: [`doc/container.md`](./container.md)
  §4.1 and §5.5.

### 4.2 The catalogue entry shape and public route identity

- **Provider-local descriptor:** `WebChatModelDescriptor` ([`src/web-chat/core/model.ts`](../src/web-chat/core/model.ts)) — `id`,
  `label`, `text: true`, optional `reasoningModes`/`contextWindow`/`providerDetail`.
- **Host-facing informational entry:** `WebChatModelCatalogueEntry` in
  [`src/web-chat/host/provider-host.ts`](../src/web-chat/host/provider-host.ts) —
  `{ id: "<providerId>/<modelId>", providerId, modelId, label, text: true }`, produced by
  `webChatModelCatalogueEntries(providerId, models)`. A model id is not globally unique, so it is
  provider-qualified **exactly once** here.
- **Public route identity:** `webChatPublicRoute(providerId, modelId)` = `"<providerId>/<modelId>"`
  ([`src/web-chat/host/text-turn.ts`](../src/web-chat/host/text-turn.ts)); `webChatRouteProviderId`
  and `webChatRouteModelId` take it apart without owning policy.
- **Do not conflate the two.** Today `GET /v1/models` is built provider-specifically by
  [`src/model-catalog.ts`](../src/model-catalog.ts) (`buildChatGptWebModelCatalog`) with route
  authority from [`src/chatgpt-web-authority.ts`](../src/chatgpt-web-authority.ts); the
  host-facing `WebChatModelCatalogueEntry` shape is consumed by the diagnostics path
  (`inspectWebChatProvider`). Adding a second provider to `/v1/models` therefore requires its own
  catalogue rows/route authority, or an intentional extraction of a provider-neutral owner — that
  extraction is **not** already done, and this document does not prescribe its shape (architecture
  §14/§17 leave it open).

### 4.3 Account binding: a recorded identity is the only one that binds

The binding identity is `webChatAccountBindingId({ providerId, accountFingerprint, browserProfile?,
browserContext? })` in [`src/web-chat/core/account-binding.ts`](../src/web-chat/core/account-binding.ts)
— a SHA-256 over identity fields, never a credential. One provider/account pair is one binding, so one
host session can hold one conversation per provider **and** per account without reusing another's
handle.

**The known trap, and this is exactly the failure this repository already fixed twice:** an account
identity must be **recorded** at sign-in (persisted into the deployment configuration). A *derived
fallback* — the storage-state-derived fingerprint, or the literal `"unknown"` placeholder — is **not**
an account identity and can **never** match the account the signed-in browser exposes, because the
browser reports what it actually signed in as while the fallback is computed from a file.

How it was diagnosed, and the evidence the next person should expect:

- The mismatch message names **both fingerprinted sides**:
  `Browser lease physical account does not match its logical account identity: expected <12-hex>,
  actual <12-hex>` — see `CHATGPT_WEB_ACCOUNT_IDENTITY_MISMATCH_MESSAGE` and
  `BrowserAccountLease.bindPhysicalResource` in
  [`src/adapters/chatgpt-web/provider-core.ts`](../src/adapters/chatgpt-web/provider-core.ts).
  Printing only the expected side is what made the original diagnosis take a blind round.
- A **never-recorded** identity says so instead of pretending to be a mismatch:
  `CHATGPT_WEB_ACCOUNT_IDENTITY_MISSING_MESSAGE` ("…no recorded account identity for this
  deployment… sign in again at the operator sign-in surface (/v1/control/auth/) to record it").
  Both cases still refuse; a guess never binds.
- The provenance is decided at the **one place the fallback is substituted**: `providerConfig` sets
  `accountIdentityRecorded: config.accountIdentityFingerprint !== undefined`
  ([`src/config.ts`](../src/config.ts)), and the lease descriptor carries it.
- `inspectAccount` must not report a derived identity as authenticated: the driver requires a
  recorded identity and a non-`unknown` fingerprint
  (`chatGptWebAccountAuthenticated` in [`src/adapters/chatgpt-web/chatgpt-driver.ts`](../src/adapters/chatgpt-web/chatgpt-driver.ts)).
- The interactive sign-in persists the fingerprint **after** the session is safely stored, through
  `persistAccountIdentityFingerprint` (`storeCapture` in
  [`src/adapters/chatgpt-web/auth-controller.ts`](../src/adapters/chatgpt-web/auth-controller.ts)); a
  host hook then re-derives the live provider facts so the next turn works with no restart.
- The `AuthCapture` contract is **not** widened for this: the fingerprint is provider-side binding, not
  captured material.

A new provider must do the equivalent: record its account identity at sign-in, mark provenance, and
keep the check fail-closed.

### 4.4 Host wiring points for a new provider

Adding a provider is not only a new directory; these host seams compose the drivers this deployment
serves. Each is a deliberate, small owner:

| Wiring | Where | What to add |
| --- | --- | --- |
| Provider-scoped config block | `webChat.providers.<id>` resolved by `resolveWebChatProviderConfig` ([`src/web-chat/host/provider-host.ts`](../src/web-chat/host/provider-host.ts)) | The provider's own resolved configuration. The ChatGPT flat block remains a compatibility fallback; do not make the new provider depend on it. |
| Durable continuity | `createWebChatConversationStore` (same file), path `webChat.conversationStorePath` | Nothing provider-specific: the store is shared. Do not build a second transcript store. |
| Advisor runtime composition | `advisorRuntimes()` in [`src/server.ts`](../src/server.ts) | One `WebChatProviderRuntime` per provider. |
| Interactive sign-in registration | `createWebChatAuthSurface({ providers: [...] })` in [`src/server.ts`](../src/server.ts) | The provider's `ProviderAuthController`, labelled. |
| Doctor | `webChatDoctorDrivers(config)` in [`src/doctor.ts`](../src/doctor.ts) | The provider's driver, or its check is silently absent. |
| Catalogue / public routes | [`src/model-catalog.ts`](../src/model-catalog.ts) + route authority | See §4.2 — currently provider-specific. |

## 5. Diagnostics to wire from day one

### 5.1 Browser-turn checkpoint captures

A failing browser turn must leave evidence. The ChatGPT worker captures a bounded, sanitized
per-turn trace:

- **Location:** `resolveBrowserConfig` defaults `browserDiagnosticsPath` to
  `<data home>/diagnostics/browser-turns`, and `ChatGptBrowserDiagnostics` writes
  `<traceId>-<8 hex>/NN-<checkpoint>.json` plus an optional `.png`
  ([`src/adapters/chatgpt-web/browser-worker.ts`](../src/adapters/chatgpt-web/browser-worker.ts)).
- **Checkpoints** are named moments (`browser-page-acquired`, `composer-ready`,
  `submission-page-rebound`, `assistant-page-rebound`, `response-visible`, `response-stalled-30s`,
  `turn-completed`, `turn-failed`, connector/personalization steps, `multipart-<n>-…`, …). The
  checkpoint name is slugged by `browserDiagnosticCheckpoint`.
- **Screenshots are opt-in per checkpoint:** only `response-stalled-30s` and `turn-failed` by default,
  or everything when `DSH_CHATGPT_FREE_BROWSER_DIAGNOSTICS=1`
  (`browserDiagnosticIncludesScreenshot`). The JSON state capture is bounded (text truncated), and the
  root is pruned to the 10 most recent traces.
- **This is provider-local.** A new provider brings its own equivalent (its own checkpoints, its own
  state shape) under its own provider directory semantics — do not import ChatGPT's selectors, and do
  not put any of it in `src/web-chat/core/**`.

### 5.2 `doctor`'s provider checks

`doctor` resolves the **same** effective provider configuration the runtime uses, so what it reports
is what a turn would see:

- `webChatDoctorDrivers(config)` composes the drivers ([`src/doctor.ts`](../src/doctor.ts)) and
  `webChatProviderChecks` emits `id: "webchat-<providerId>"`.
- Status mapping from `webChatDoctorCheck`/`webChatProviderCheck`
  ([`src/web-chat/host/provider-host.ts`](../src/web-chat/host/provider-host.ts)): unhealthy driver →
  `error`; reachable but not authenticated → `warning` whose message names the missing sign-in and
  `/v1/control/auth/`; authenticated and healthy → `ok`.
- A driver that **throws** is reported unhealthy, never hidden and never fatal
  (`inspectWebChatProvider` catches it).
- The detail is credential-free and identifier-safe: the account fingerprint is shortened by
  `redactWebChatFingerprint` (`01234567…`).

A new provider that is not added to `webChatDoctorDrivers` is invisible in `doctor`.

### 5.3 Sanitisation rules

Never let any of these reach a log line, a session view, a diagnostic file or a public report:

- cookies, storage state, tokens, API keys, control tokens — [`AGENTS.md`](../AGENTS.md) → *Security and privacy*;
  architecture §23 lists the same set.
- raw account identities: print fingerprints, and shorten them for human-facing output
  (`redactWebChatFingerprint`); the ChatGPT eviction log prints only a 12-hex digest of the
  conversation key (`retainedSurfaceDigest`), and the lease provenance carries only sha256-first-12
  fingerprints.
- private filesystem paths in public diagnostics ([`AGENTS.md`](../AGENTS.md) → *Security and privacy*).
- prompt/session content: `redactChatGptUiDiagnostic` strips embedded `<codex_context_json>` bodies
  and turn/binding/call identifiers before they are written; `nonSecretAuthDetail` redacts URLs and
  truncates to 300 chars; `safeErrorDescriptor` emits only `name=… code=… type=… status=…`.

The interactive sign-in surface follows the same rule: no cookie or browser storage state may ever
appear in a session view or a log, and the capture is relayed to the provider's own `storeCapture`
without the host reading it.

## 6. Failure modes we have already hit

Each is real, already fixed, and still worth recognising in minutes. Symptom first, then the tell that
identifies it, then the owner.

1. **A physical account that does not match the recorded one.**
   *Symptom:* every turn is refused with `Browser lease physical account does not match its logical
   account identity: expected <fp>, actual <fp>`.
   *Tell:* the deployment signed in and stored a session but never persisted an account fingerprint, so
   the lease started from the `"unknown"` fallback; if nothing was ever recorded the message instead
   says "no recorded account identity … sign in again at the operator sign-in surface".
   *Owner:* `storeCapture`/`persistAccountIdentityFingerprint`
   ([`auth-controller.ts`](../src/adapters/chatgpt-web/auth-controller.ts),
   [`config.ts`](../src/config.ts)) — see §4.3; operator copy in
   [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) §10.

2. **A caller with no identity colliding with another.**
   *Symptom:* two unrelated API clients continue the *same* provider conversation; the second inherits
   the first's `retained_surface_lost` once that surface dies.
   *Tell:* the conversation key for a metadata-less caller is the constant `dsh-session` instead of a
   content-derived `dsh-chat-<hash>`; a caller's `user`/`session_id` appears to have no effect.
   *Owner:* `contentConversationIdentity`/`projectApiConversation`
   ([`api-projection.ts`](../src/web-chat/host/api-projection.ts)), reached on the Responses side by
   `extractChatGptTurnIdentity` ([`environment.ts`](../src/adapters/chatgpt-web/environment.ts)); the
   fix's limits are stated in [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) §11.0b.

3. **A retained surface evicted to bound memory.**
   *Symptom:* a conversation that worked earlier now fails with `retained_surface_lost` /
   `RetainedSurfaceLostError` (and, on the API, `TRANSPORT_UNAVAILABLE`/`CONVERSATION_LOST`).
   *Tell:* the eviction log line
   `[chatgpt-web] retained surface evicted key=<12-hex> reason=<idle-timeout|over-capacity> settlement=<proven|unproven>`
   — 30 minutes idle or the 16-surface cap.
   *Owner:* [`retained-surface.ts`](../src/adapters/chatgpt-web/retained-surface.ts): eviction is
   retirement and a tombstone, never reuse; recovery is an explicit replay, not an automatic one.

4. **The first-run bootstrap fails when the runtime differs.**
   *Symptom:* on an empty data volume the container never becomes healthy; the entrypoint's bootstrap
   step dies with `ERR_MODULE_NOT_FOUND …/chatgpt-web-models`.
   *Tell:* the bootstrap ran on a runtime whose ESM loader does not add extensions, while the module
   graph relied on the bundler's extensionless resolution. The entrypoint must bootstrap with the same
   runtime as the service (`node`, not `bun`) and the shipped file's relative specifiers must be fully
   specified.
   *Owner:* [`docker/entrypoint.sh`](../docker/entrypoint.sh) (step runs
   `node /app/docker/bootstrap-config.ts`) and [`docker/bootstrap-config.ts`](../docker/bootstrap-config.ts);
   pinned by [`tests/issue-267-container-bootstrap-node.test.ts`](../tests/issue-267-container-bootstrap-node.test.ts)
   and [`docker/verify-container.sh`](../docker/verify-container.sh) step 4b.

5. **A browser failure during sign-in reported as a server error.**
   *Symptom:* the operator page shows a generic server failure while relaying a sign-in input, even
   though the browser had simply died; the response body is `code: "auth_unavailable"` with 500.
   *Tell:* an unexpected Playwright failure escaped as a non-`WebChatError` and fell through the
   generic control handler. The current contract: an already-published category passes through
   untouched (a refused out-of-viewport click is a **400**), an unexpected page/browser failure fails
   the session and reports `UPSTREAM_ERROR` → **502**, with a closed page distinguishable
   (`AUTH_PAGE_CLOSED`) and the message sanitized.
   *Owner:* `#inputFailure` ([`auth-controller.ts`](../src/adapters/chatgpt-web/auth-controller.ts))
   and `authFailureStatus`/`authFailureResponse` ([`server.ts`](../src/server.ts)); pinned in
   [`tests/issue-276-chatgpt-auth-controller.test.ts`](../tests/issue-276-chatgpt-auth-controller.test.ts).

## 7. Cross-references

- Invariants: [`AGENTS.md`](../AGENTS.md) — *WebChat architecture invariants*, *Provider migration
  discipline*, *Security and privacy*, *Verification*.
- Architecture: [`doc/architecture.md`](./architecture.md) §4, §6–§9, §12–§18, §21, §24.
- Core map: [`doc/web-chat-core.md`](./web-chat-core.md).
- Container/credentials/sign-in: [`doc/container.md`](./container.md) §4.1, §5.5.
- Diagnosis: [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) §1, §10, §11, §12, §13.
