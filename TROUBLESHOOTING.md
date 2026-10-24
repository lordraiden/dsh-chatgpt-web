# Troubleshooting dsh-chatgpt-web

This guide covers operational problems in the current production implementation of dsh-chatgpt-web.

Today the production WebChat providers are **ChatGPT Web**, **Qwen Code** and **Qwen Chat**. **DeepSeek
Web** is implemented but not usable for live turns yet: the per-completion proof of work and the page
token's provenance are unproven, and no route is advertised until the operator configures the measured
`model_type` values. Its refusals are typed and say so; the exact inventory is
[`doc/deepseek-web.md`](./doc/deepseek-web.md) §6.

For the ownership model and future provider architecture, see doc/architecture.md.

## 1. Start with the doctor

Before changing configuration, run:

~~~bash
dsh-chatgpt-web doctor
~~~

The doctor should validate at least:

- configuration;
- Chrome/Chromium availability;
- authenticated ChatGPT browser evidence;
- local sidecar health;
- configured runtime prerequisites.

If the doctor reports a failure, fix that failure before changing provider or browser logic.

For machine-readable diagnostics:

~~~bash
dsh-chatgpt-web doctor --json
~~~

Do not paste unredacted diagnostic output into a public issue. Browser/session state, control tokens, local paths and authentication material are sensitive.

## 2. ChatGPT login state is missing or unverified

### Cause

The configured browser storage does not contain usable authenticated ChatGPT Web state, or the current browser/session evidence is no longer valid.

### Resolution

Run:

~~~bash
dsh-chatgpt-web login
~~~

Complete the login or verification flow in the browser.

Then run:

~~~bash
dsh-chatgpt-web doctor
~~~

Authentication belongs to the container's own sign-in flow (`login`, the service's own sign-in page at `/v1/control/auth/`, `auth import`, or the `display` fallback, which needs a display you supply); do not create a second session store outside the data volume.

Treat the data volume (`DSH_CHATGPT_WEB_HOME`) as credential material.

### The sign-in page shows a provider but the session fails

The page at `/v1/control/auth/` relays the provider's own sign-in, and the state it prints is the authoritative one. Read it before changing anything:

| State | Meaning |
| --- | --- |
| `starting` | the provider is bringing its sign-in mechanism up |
| `awaiting_input` | the browser is interactive and waiting for you |
| `verifying` | the provider is checking what you just submitted |
| `captured` | the sign-in succeeded and the session was stored |
| `failed` | the provider or its browser failed; the reported message names the cause |
| `expired` | the session outlived its TTL (10 minutes by default) and was cancelled |

The failures seen so far, and what each one means:

- **Chrome is missing.** Opening a session fails closed with `The interactive sign-in browser could not start: Chrome was not found at <path>` (the provider's own `CHROME_EXECUTABLE_MISSING` diagnostic). Fix the configured `chromeExecutablePath` (see §4) before retrying.
- **The provider rejects the automated surface (anti-bot / verification wall).** The page's browser never reaches the authenticated surface, so the session stays `awaiting_input`/`verifying` and eventually reports `failed`. Set `authBrowserMode: "display"` in `config.json` and supply a display the service can reach — the container provides none, and the former noVNC sign-in image is retired (doc/container.md §5.5). `headless` is the default and the supported path on a headless host, so this is opt-in.
- **A session for that provider is already active.** A second sign-in is refused (409, `A sign-in session for provider chatgpt-web is already active`) until the first reaches a terminal state; cancel it from the page and reopen.
- **Turns fail with `ChatGPT Web has no recorded account identity for this deployment`.** The browser session was stored but no account identity was ever recorded with it, so the lease's account-binding check cannot verify the signed-in account and refuses rather than binding on a guess. This is the actionable form of a failure that used to surface only as `Browser lease physical account does not match its logical account identity` — a genuine *mismatch* between two recorded identities keeps that original sentence. Sign in again at the operator sign-in surface (`/v1/control/auth/`, or the CLI `login`), which records the fingerprint of the account it signs in; then re-run `doctor`.
- **The session was captured but turns still fail.** The page reports the session stored and the running service picks it up on the next turn, so a restart is no longer the answer for the interactive sign-in. If the reported capture carries a `detail`, that detail is the cause (usually an account identity the sign-in could not read, which makes every turn fail closed); otherwise check `doctor` for the resolved path and re-run the sign-in. `auth import` is the route that still needs `docker compose restart chatgpt-web`, because it writes from its own short-lived process.

A click outside the viewport the relay reports is refused rather than clamped, and currently is refused with HTTP 400 `UNSUPPORTED_OPTION`; that is the intended answer, not a credential problem.

Keystrokes reach the provider only while the page's indicator says `Keyboard → remote sign-in screen`: clicking the provider's screen routes the keyboard there, and `Escape` (or clicking any field on the page) hands it back. If the indicator says `Keyboard → this page`, the keys belong to the page's own controls and never reach the provider — that is the design, not a failure. On a phone, type into *Send text*: an on-screen keyboard cannot drive the remote browser, so the field is the only way to type.

## 3. Snap/Chromium cannot create its browser profile

### Symptom

A snap-confined Chromium fails with an error similar to:

~~~text
Failed to create .../SingletonLock: Permission denied (13)
~~~

### Cause

The snap browser may not be allowed to write the hidden default data directory under ~/.dsh/.

### Resolution

Use a non-hidden data directory:

~~~bash
DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web" \
  dsh-chatgpt-web setup --chrome /snap/bin/chromium
~~~

Persist the same DSH_CHATGPT_WEB_HOME in the environment that starts the service. In the container the data directory is the mounted volume and its path is fixed by the Compose stack.

The same effective data directory must be visible to:

- setup;
- login;
- doctor;
- the process that starts the sidecar.

A one-off VAR=value command does not change the environment of a later process.

## 4. Chrome executable is missing

### Cause

Chrome/Chromium was not found automatically.

### Resolution

Specify it explicitly:

~~~bash
dsh-chatgpt-web setup --chrome "/path/to/chrome"
~~~

Then verify:

~~~bash
dsh-chatgpt-web doctor
~~~

## 5. Port 17841 is already in use

### Cause

Another process or an existing sidecar is already listening on the loopback port.

### Resolution

First determine whether the existing sidecar is healthy:

~~~bash
dsh-chatgpt-web doctor
~~~

If a manually launched sidecar is required, use another port:

~~~bash
dsh-chatgpt-web serve --port 17842
~~~

For the normal deployment path, prefer changing the configured sidecar port rather than maintaining a second competing sidecar.

Do not expose the sidecar beyond its intended loopback boundary.

### An older container is still serving the port

#### Symptom

`doctor` reports `Daemon version is X; config requires Y` and `Doctor result: not ready`, and the container log says the sidecar is outdated, even though you just rebuilt the image and started it again.

#### Cause

Rebuilding the image replaces the files on disk; it does not stop a `serve` process that is already running in an older container. That process keeps the port, so the new one finds a **healthy sidecar whose version differs from its own**. The service will not reuse or terminate a sidecar it does not own, and since `1.0.27` it also fails turns closed with that message instead of quietly serving the old daemon.

#### Resolution

Stop the old container, then start the matching image:

~~~bash
lsof -i :17841            # or: ss -ltnp | grep 17841
docker compose down       # keep the data volume
docker compose build --pull && docker compose up -d
curl -s http://127.0.0.1:17841/healthz   # expect "version":"<image version>"
~~~

Never edit `releaseVersion` in the config to silence the mismatch: it is runtime metadata that the service rewrites to the installed version, and hiding the disagreement would leave the old daemon serving turns.

## 6. The service starts but the model API is unavailable

Check that the container is healthy and that the requested model is in the catalogue:

1. `curl -fsS http://127.0.0.1:17841/healthz` answers `"status":"ok"`;
2. `curl -fsS http://127.0.0.1:17841/v1/models` lists the requested `chatgpt-web/...` route;
3. `doctor` is healthy;
4. the API key is supplied when the service is not reached over the container's own loopback (see doc/container.md §5.2).

Do not configure backend model IDs directly. Use the public chatgpt-web/... routes documented in the README.

`/v1/responses` and `/v1/chat/completions` are two wire-compatible ingresses onto the **same** internal turn; neither is a second execution path.

## 7. The selected model route is unavailable

### Cause

ChatGPT Web model availability is account- and product-state dependent.

The provider deliberately fails closed when a route cannot be established from the authenticated Web surface.

### Resolution

Check the authenticated account's currently exposed model routes and use the corresponding chatgpt-web/... model.

Do not infer availability from:

- a backend model ID;
- a model name shown by another API;
- Free/paid status alone;
- a previously available route.

A route that belongs to a Codex/Work allocation is not part of the ChatGPT Web provider.

## 8. Stream disconnected or browser response was interrupted

### Possible causes

- browser/page closed;
- Web network connection dropped;
- ChatGPT refreshed or replaced the conversation surface;
- sidecar stopped;
- authentication expired;
- transport timeout/termination.

### Resolution

1. Check connectivity to chatgpt.com.
2. Check that the authenticated browser/session is still valid.
3. Run dsh-chatgpt-web doctor.
4. Inspect sidecar/service status.
5. Restart the sidecar only if it is actually unhealthy.

A logical cancellation/failure does not necessarily prove that the browser operation has physically stopped. Avoid immediately reusing a transport resource when late browser output may still arrive.

## 9. ChatGPT Web rate limits / 429 / verification

### Cause

The authenticated account or selected product route has reached a product-specific limit, or the web service is asking for additional verification.

### Resolution

- Wait for the provider to make the route available again.
- Complete any required verification in the authenticated browser flow.
- Re-run doctor after authentication/session changes.
- Avoid aggressive repeated retries.

Do not treat a provider rate limit as proof that changing WebChat retry logic is correct. The retry boundary must remain conservative around submitted turns.

## 10. A second DSH chat is refused while a conversation or the account is busy

### Current status

Resolved. `main` no longer has an account-level *exclusive* ChatGPT browser lease, so a second DSH chat on the same authenticated account leases normally instead of being rejected out of hand. The limitation was real and was tracked by issue #201 and its fix PR #202.

Account fan-out is now **bounded**, not exclusive: one authenticated account serves up to `MAX_CHATGPT_BROWSER_TABS` (5) simultaneous browser turns. Past that bound every enforcement site (provider core, turn-session registry, browser worker) refuses with the same shared sentence:

```text
ChatGPT Web supports at most 5 simultaneous browser turns; close or finish a browser tab before starting another
```

Exclusivity is per logical conversation and per physical transport resource:

- one active turn per logical provider conversation — the transport lease and the retained ChatGPT surface for its `conversationKey`;
- one lease per physical browser resource id, so two turns never drive the same page;
- one active turn per native DSH thread.

Read the refusal to tell the two apart:

- `retained_surface_busy` / `TRANSPORT_UNAVAILABLE` means the *same* provider conversation already has an active turn (the per-conversation guards above). Admission waits for that turn first, bounded by `DEFAULT_TRANSPORT_ADMISSION_WAIT_MS` (60 s, the harness's own session-title deadline) at one shared owner (`src/web-chat/transport/conversation-admission.ts`) used by **both** the ChatGPT native route (`ChatGptWebProviderCore`) and the text providers' transport lease (Qwen Code, Qwen Chat, DeepSeek Web): a turn takes the conversation's admission before reading continuity and waits for the current holder to release it, then fails closed with the same sentence. A refused turn never ran, so it leaves the conversation's continuity untouched and a retry proceeds normally. This matters most on a **first message**, when the harness's session-title call races the user's turn: because `@earendil-works/pi-ai` drops the harness's `purpose` field, that call arrives *undeclared*, so it is treated as a conversational turn and shares the session's conversation. It is waited out instead of failing the user's first message, and the two never run concurrently;
  A slow title call is exactly why this bound is the housekeeping deadline and not a shorter one: the former ChatGPT-specific 30 s wait let a 1 m 5 s title call outlive the bound and refuse the operator's real `chatgpt-web/think` turn. The shared 60 s wait never pre-empts the title call's own deadline; the title stops at its own cancellation, not because a user turn refused it;
- `retained_surface_lost` / `CONVERSATION_LOST` means the retained conversation was retired (its page died, or it was idle past the retention window / past the retention cap) and is deliberately **not** auto-replayed: re-send the canonical history as an explicit replay to re-establish it (`doc/architecture.md` §19.1);
- `The last attempt on this conversation was never confirmed; the provider must reconcile it before it can be resumed` (`CONVERSATION_STATE_MISMATCH`) means a previous turn failed after its submission was accepted, so that attempt's remote outcome is not established yet. The next turn asks the provider to **reconcile** it structurally: when the retained page still holds that attempt's finalized reply the turn simply continues (nothing is resent), and when coherence cannot be proven the conversation is retired — a new conversation, or an explicit replay of the canonical history, is the way forward (`doc/architecture.md` §19.1);
- a turn that failed **before** its prompt was submitted is not that case: nothing reached ChatGPT, so it marks nothing, needs no reconciliation and spends no reconciliation budget — retrying it is safe and is governed by the ordinary retry layer (`doc/architecture.md` §19.1, issue #317);
- the bounded fan-out sentence means the authenticated account is at its 5-turn ceiling — wait for a browser turn to finish, then retry;
- `ChatGPT Web has no recorded account identity for this deployment, ... sign in again at the operator sign-in surface (/v1/control/auth/)` means nothing recorded *which* account this deployment signed in as, so no physical account could be verified against it. Sign in again (or run `login`) to record it;
- `Browser lease physical account does not match its logical account identity: expected <fingerprint>, actual <fingerprint>` means two *recorded* identities genuinely disagree — the browser session belongs to a different account than the one this deployment recorded. Re-authenticate that account, or point the deployment at the browser session it recorded.

Do not work around either refusal by disabling the per-conversation safety guards or sharing one physical page between unrelated DSH conversations.

## 11. A request was submitted but no response was observed

Do **not** immediately resend the same prompt.

This may be an ambiguous submission: the provider may have accepted the turn even though the client did not observe the response.

The retry invariant is:

~~~text
before submission
    -> retry may be safe

after confirmed submission
    -> no automatic duplicate submission

submission ambiguous
    -> no automatic duplicate submission
~~~

First determine whether the provider conversation can be safely resumed or whether an explicit recovery/replay path is required.

### 11.0 After updating to 1.0.21, a ChatGPT chat starts a new conversation

Expected once. Until 1.0.21 the conversation key was derived from the deployment namespace and the DSH chat identity only; it now includes the provider and the authenticated account binding, so the same DSH chat cannot reuse another account's conversation. The first turn of each chat after the update therefore physically installs a fresh ChatGPT conversation from the canonical DSH context. The DSH history is untouched, and the affinity stays stable from then on.

### 11.0b A `/v1/responses` client that sends no turn metadata starts a new conversation

Expected once. Every metadata-less `/v1/responses` caller used to resolve to the same constant conversation key, so unrelated clients shared one ChatGPT conversation. Each such client now gets its own content-derived key (the same rule `/v1/chat/completions` already used), and its first turn after the update physically installs a fresh conversation. Two callers with no metadata and byte-identical content are still deliberately indistinguishable and share one conversation — to be addressed as a distinct caller, send `client_metadata["x-codex-turn-metadata"]` with a `thread_id` on `/v1/responses` (or `user`/`session_id` on the chat surface). A caller that already sends native Codex/DSH turn metadata is unaffected: its thread is used verbatim.

### 11.1 `ChatGPT stopped responding after the task started` while ChatGPT is still working

Observed as a failed **Review with Advisor** (or any long ChatGPT Web turn) whose tab keeps working and produces the answer anyway.

The generic sentence is the adapter's copy for *any* post-submission failure; the precise cause is in the sidecar log and in the per-turn diagnostic (`diagnostics/browser-turns/<traceId>/12-turn-failed.json`). Two causes have been seen:

- `ChatGPT response DOM disappeared while the browser turn was active` — ChatGPT's work/commentary phase replaces the assistant turn element with its activity view. The worker now treats a visible **Stop button** as proof that the model is still working, so that re-render no longer fails the turn (issue #214). A generator that keeps running without ever exposing material is still bounded by `tuning.generationRunningStallMs`.
- the generation-running stall budget itself (`tuning.generationRunningStallMs`, 15 minutes by default) — a genuinely stuck generator. Raise it in the browser transport tuning when a legitimate review takes longer.

If a review still fails while the provider finishes the answer, do **not** resend the review: open the Advisor panel (the composer's **Review with Advisor** control, then **Advisor activity**) and use **Recover retained answer** on the failed review. The recovery is read-only — it never submits or navigates — reads the finalized answer from the retained Advisor conversation, shows it in a selectable field with a **Copy** action, and records it for the turn, so it also appears in the turn card and can be opened in the result editor. A recovery that finds nothing yet can simply be retried once the provider finishes.

## 12. Conversation continuity was lost

A provider conversation is not the DSH session.

The system must not silently create a new remote conversation and report normal continuation.

The intended recovery choices are explicit:

- exact resume;
- explicit replay/rebuild from canonical DSH text history;
- deterministic failure.

Do not reconstruct authoritative DSH state from browser-visible conversation text.

## 13. Qwen Code or DeepSeek Web cannot be selected

**Qwen Code is a supported route** (`qwen-code/<model>`) once this deployment has a verified session for
it or a `webChat.providers["qwen-code"]` block. **DeepSeek Web** (`deepseek-web/<model_type>`) is
implemented and publishes no rows until the operator configures the measured `model_type` values in
`webChat.providers["deepseek-web"].modelTypes`. Its turn path is measured (page-owned proof of work,
page bearer and client/device headers, the recorded SSE patch stream), but a live turn still needs a
**verified** session: a stored DeepSeek capture is unverified by design because no authenticated import
predicate has been accepted yet, so `ready()` answers with a typed `401` naming the missing step.
Details: [`doc/deepseek-web.md`](./doc/deepseek-web.md) §6–§7.

Do not add ad-hoc DeepSeek routes to ChatGPT-specific code. A new provider requires the shared WebChat
contracts to be implemented first, and it must pass the conformance suite.

### `qwen-code/...` is missing from `/v1/models`

The rows appear when the provider is **configured or signed in**: add
`webChat.providers["qwen-code"] = { "models": ["qwen3-coder-plus"] }` to the configuration, or complete a
Qwen Code sign-in at `/v1/control/auth/` (or `auth import --provider qwen-code`). A ChatGPT-only
deployment keeps exactly the catalogue it had.

### A Qwen Code turn fails with 401 / `QWEN_SESSION_MISSING`

The deployment has no **verified** Qwen Code session: the storage state is missing, or its
`.verified.json` marker says it was never verified. The message names the operator surface; sign in again
at `/v1/control/auth/` (choose "Qwen Code") on a machine whose own browser can complete the provider's
Access Verification, or adopt a capture as in [§5.5 of `doc/container.md`](./doc/container.md). A session
the provider has revoked reports `QWEN_SESSION_UNAUTHORIZED` on the same route.

### A Qwen Code turn fails with 409 / `QWEN_CHAT_LOST`

The provider no longer accepts the chat this conversation was continuing. That is recorded as a **lost**
chat, never silently replaced: the next turn rebuilds the conversation from canonical history as an
explicit replay (a new chat, a generation that advances by one). If replaying is not what you want, start
a new conversation on the caller side.

### A session title or compaction turn does not appear in the Qwen Code account

That is correct. A turn that declares a housekeeping `purpose` (`session-title`, `compaction`, or any
declared value) is answered and kept nowhere: it creates no chat, records no conversation and consumes
none. If one of them fails, it fails with a typed category — it never falls back to the account's chat.

## 14. A tool-sending harness works, but never receives tool calls

### Symptom

An agent harness (DSH, Cline, and the like) sends `tools` on every `/v1/chat/completions` turn. The turn
returns `200` with a normal chat answer, and the harness reports no tool calls.

### Cause

This is the intended behavior, not a fault. The provider is a **consumer web chat reached as text**: it
has no execution path for your tools and no return channel to your harness, so a tool declaration cannot
mean anything here. Capability declarations (`tools`, `tool_choice`, `mcp`, and the legacy
`functions`/`function_call`) are discarded by design — accepted, never executed, never forwarded.

### How to see what was dropped

Any response that dropped a capability declaration says so:

~~~bash
curl -sS -D - http://127.0.0.1:17841/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}],"tools":[{"type":"function","function":{"name":"read_file"}}]}' | head -20
~~~

The response carries `x-dsh-chatgpt-web-ignored-features: tools`, on JSON and SSE alike, and the service
logs one line per request naming them. The model answers as plain chat; the harness gets no tool calls.

### What is still refused

Attached **content** is data the caller meant the model to see, so it is always refused with a typed
`400` and never dropped: files, images, audio, video, attachments, and non-text content parts. If a
request fails, read the error before assuming the capability policy caused it — an image or file part is
a content refusal, and it is not configurable.

A turn whose only content is the **host's own context** is refused too, with `code:
host_context_only_turn` and a message naming the rule: the service strips the host-injected blocks it
recognizes before deciding which message is the turn, and when no `user` message still carries human
content there is nothing to send. Send the user's actual instruction as its own `user` message; the
harness's own context (runtime snapshots, environment or memory blocks, transport text) does not need to
be sent. The refusal happens before the turn exists — nothing reaches the browser and no conversation
state is written, so the next real turn still continues the same conversation. A request that carries no
`user` message at all keeps its own code, `no_user_message`.

## 15. A turn waits for a stuck previous turn (`settlement_wait_timeout`)

### Symptom

A turn fails with HTTP `503`, `type: server_error`, `code: settlement_wait_timeout`, and a message saying
a previous ChatGPT Web turn did not publish its physical settlement within the settlement-wait grace. The
log carries the same sentence. Calls made while the condition lasts return the same outcome instead of
hanging.

### Cause

The conversation's previous turn never proved what happened to the physical browser resource — a page
that stopped answering, a killed renderer, a launcher that never acknowledged its teardown. A later turn
for that conversation waits for that settlement so it is not handed a page that may still produce output
(architecture §9.3). That wait is new-bounded (issue #301, 60 s by default): the service no longer waits
forever with no error. Nothing of the failed turn was submitted to ChatGPT, so this is a local resource
condition, never an upstream failure.

### What the service does

- the wedged session is retired, and its runtime cancelled — which is how the physical owner is told to
  abort and publish a `rejected` settlement (the retained page is closed and its key tombstoned, never
  reused);
- later turns for the same conversation fail closed with the same typed outcome while the settlement
  stays unproven, instead of hanging or silently opening a replacement conversation;
- once the settlement finally lands, normal service resumes with no operator action.

### What to do

1. Check `active_browser_turns` on `/healthz` (or `/v1/control/status`). It counts the turns this service
   believes are live, so a wedged turn shows up there as a count that does not fall. There is also an
   `admin/cancel-turn` control-token endpoint that cancels a turn by `traceId` if the diagnostics name one.
2. Retry once the stuck turn has cleared. If the count never falls, restart the service — the retained
   conversation keeps its tombstone and requires an explicit replay from canonical history, exactly like
   any other `retained_surface_lost` (§12).

### Why `accepting_turns` can still be true

`accepting_turns` is the host's admission flag (`/admin/drain` and `/admin/resume` own it): it says
whether the *service* is accepting work, not whether one conversation is stuck. The ChatGPT adapter has no
admission authority and correctly does not fabricate one. The signal for stuck work is
`active_browser_turns` on the same `/healthz` response, which is derived from the live turn registry —
and, since issue #301, a stuck turn also ends itself within the grace with a logged, typed outcome instead
of staying invisible. That is what an operator gets: a bounded failure they can see and act on, not a
green healthcheck over an infinite hang.

## 16. A long turn ends with `turn_timeout`

### Symptom

A turn fails with HTTP `504`, `type: server_error`, `code: turn_timeout`, and a message saying the bridge's
own turn clock expired after N ms. The log carries one line:

~~~text
[chatgpt-web] turn_timeout limitMs=900000 detail="ChatGPT web turn timed out"
~~~

The stream from `/v1/chat/completions` has been receiving `: keep-alive` comments until then, so this is
not a client that gave up: the **bridge** decided the turn had run long enough.

### Cause

This is the bridge's absolute ceiling for one provider turn, not a ChatGPT failure and not a client
timeout. It exists because a provider turn can genuinely hang forever, and something must own that bound.
The default is 15 minutes (`900000` ms); the failed session that motivated it showed legitimate turns of
4 m 21 s and "sometimes more than 10 minutes".

The client's own 300 s idle timer is no longer a factor: while the provider is working, the
chat-completions stream emits standard SSE comment lines (`: keep-alive`), which every OpenAI-compatible
client ignores. No client timeout was raised or needs to be raised.

### What to do

1. If the turn was still making visible progress, raise the ceiling for the deployment:
   `DSH_CHATGPT_WEB_TURN_TIMEOUT_MS=1800000` (milliseconds, positive integer up to 6 hours), or set
   `chatgptWeb.turnTimeoutMs` / `chatgptWeb.tuning.turnTimeoutMs` in `config.json`. An explicit
   configuration wins over the environment variable.
2. If the turn was genuinely wedged, leave the default in place: it is what prevents a dead provider turn
   from holding the conversation forever. The turn is retired on expiry and the conversation is released
   through the normal failed-turn path.
3. Do not raise any client-side `streamIdleTimeout`/idle timer as a workaround — the keep-alive is the
   fix for that, and the two clocks are independent.

## 17. Reporting a bug

Include:

- operating system and architecture;
- container engine and image tag;
- Node/Bun version;
- browser name/version;
- selected chatgpt-web/... route;
- how the browser session was obtained (`login`, the service's own sign-in page at `/v1/control/auth/`, `auth import`, or the `display` fallback with a display you supply);
- relevant doctor --json output after redaction;
- clear reproduction steps;
- the exact failure state or error.

Also state whether the failure occurred:

- before submission;
- after confirmed submission;
- during streaming;
- during cancellation;
- during conversation recovery.

Before sharing logs or screenshots, remove:

- cookies;
- authentication/session tokens;
- the API key (`DSH_CHATGPT_WEB_API_KEY`);
- the control token;
- private prompts;
- local filesystem secrets.

## 18. Development versus user troubleshooting

If you are changing the implementation rather than operating an installed release, start with:

~~~bash
bun run typecheck
bun run build
bun run test
~~~

Then run the focused test associated with the behavior being changed.

For browser/session changes, use deterministic transport fixtures where possible and use live authenticated browser sessions only where they are required to prove provider-specific behavior.

For architecture work, read doc/architecture.md before modifying ownership boundaries.
