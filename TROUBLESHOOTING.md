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
- configured runtime prerequisites;
- which model catalogue rows the configured account can serve: each row is reported `available`,
  `unavailable` (the account tier cannot serve it) or `unknown` (the capability state does not say), so
  a client is not pointed at a row that would be refused on its first call. An unknown state is a
  warning, never a failure;
- the OpenAI-compatible integration, when the deployment configures an API key: one structured request
  to `/v1/chat/completions`, reported `ok`, `warning` or `error`, and `skipped` — never failed — when
  there is no API key or the service is not listening (§17–§21 cover what the outcomes mean).

The structured-output check is the only doctor check that performs a real browser turn, so a `doctor`
run on a live deployment costs one turn on the account. It declares a stable `user` identity, so every
run continues the same probe conversation instead of creating a new one — and on a persistent endpoint
that conversation is visible in the account's history, which is one more reason to use a `temporary`
profile for machine workloads (§21).

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

Account fan-out is now **bounded**, not exclusive: one authenticated account serves up to `MAX_CHATGPT_BROWSER_TABS` (5) simultaneous browser turns. Since issue #358 a turn that arrives while the bound is full does not fail at once: it waits in a bounded queue (60 s by default) and is refused only when that budget expires or the queue is already full — a typed HTTP 429 carrying `Retry-After` (`turn_queue_timeout` / `turn_queue_full`, §19). The bound itself still refuses a direct over-bound lease with the same shared sentence:

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
- the bounded fan-out sentence means the authenticated account is at its 5-turn ceiling — wait for a browser turn to finish, then retry. A turn that *waited* for a slot and did not get one answers §19's typed 429 instead, which is the same fact with a deferral hint;
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
it or a `webChat.providers["qwen-code"]` block. **DeepSeek Web** (`deepseek-web/default`) needs **no
configuration**: the provider seeds the measured enabled row (`deepseek-web/default`, "DeepSeek Chat",
both toggles on) and `/v1/models` publishes it out of the box. Configuring
`webChat.providers["deepseek-web"].modelTypes` overrides that row or extends it, and an explicit empty
list is the only state that publishes no DeepSeek route. Its turn path is measured (page-owned proof of
work, page bearer and client/device headers, the recorded SSE patch stream), and a live turn needs a
**verified** session: `auth import --provider deepseek-web` runs the measured settings predicate and
writes the verified marker, so a `ready()` refusal on a stored capture means the predicate refused it
(SETTINGS_NOT_FOUND, a token code, a WAF challenge or an unreadable answer — the import's message says
which) or that no capture was imported yet. Details:
[`doc/deepseek-web.md`](./doc/deepseek-web.md) §6–§7.

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

### A structured reply came back as Markdown prose instead of JSON

ChatGPT can run its **own web search** while answering. When it does, the search flow overrides the
`response_format` instruction and the reply arrives as prose with a citation, so a structured caller
loses the turn. Observed live on a Luna-only account: a `json_schema` request returned
`**Status:** 🟢 **Mature** … [github.com](…)` instead of the object.

The bridge asks the model not to search ("Do not use web search or cite sources: answer from the
conversation only"), but that is a **soft** instruction like the rest of `response_format`, and the
model does not always follow it. There is no supported way to switch the provider's search off from the
bridge today; a caller that needs a guaranteed shape must validate the reply and retry, and the
`x-dsh-chatgpt-web-structured-output: soft` header on the response says the shape was requested, not
enforced.

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

If you would rather receive the visible partial answer than a `504`, opt in with
`chatgptWeb.partialOnTurnTimeout` (or `DSH_CHATGPT_WEB_PARTIAL_ON_TIMEOUT=1`). It is **off by default**;
when enabled, a timed-out turn that already shows assistant text concludes with that text and
`finish_reason: "length"` instead of `turn_timeout`.

## 17. A structured request fails with `400` on `response_format`

### Symptom

An OpenAI-compatible client sends a `response_format` and gets HTTP `400`,
`type: invalid_request_error`, with the message:

~~~text
`response_format` is only supported as plain text
~~~

### Cause

The running build predates issue #354. Until then the chat-completions surface accepted only
`{"type":"text"}` and refused every other shape before any provider work, so a structured caller could
not work at all.

### Resolution

Update the image (`docker compose pull`, or rebuild) and confirm the build accepts the shape:

~~~bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17841/v1/chat/completions \
  -H "authorization: Bearer $DSH_CHATGPT_WEB_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}],"response_format":{"type":"json_object"}}'
~~~

A `200` — or a provider failure, but **not** a 400 about `response_format` — means the build has #354.
`dsh-chatgpt-web doctor` proves the same thing with one structured request, and reports the latency
and the estimated token usage.

A current build still answers `400` for a *malformed* shape, with `error.code: invalid_response_format`.
That is a request bug, not a build age: `json_schema` requires `json_schema.schema` to be a JSON Schema
object, `name` to be a non-empty string when present, and `strict` to be a boolean when present.

## 18. `finish_reason` is never `"length"`

### Symptom

A caller that keys on `finish_reason` sees `"stop"` even when the answer is visibly cut off, so a
truncated reply looks like a complete one.

### Cause

This is the documented limit of issue #354. `"length"` is published only when the provider itself
**proves** its output budget was exhausted: `status: "incomplete"` with
`incomplete_details.reason === "max_output_tokens"`. A consumer web chat never reports that, and no web
adapter enforces a token budget at all — `max_tokens` / `max_completion_tokens` are accepted and
forwarded, never applied, so a truncated web answer is indistinguishable from a complete one here.

### What to do

1. Do not treat `"stop"` as proof of completeness on this bridge. Validate the **content** — a JSON
   parse, a closing brace, a sentinel — instead of the finish reason, so a truncated answer fails as a
   parse error rather than being accepted because the finish reason said `"stop"`.
2. Do not "fix" it by relabelling the other cut-offs (`content_filter`, `cancelled`,
   `upstream_stall_timeout`, `adapter_eof`) as `"length"`. They are cut-offs, but they are not the
   output-budget limit `"length"` names, and a caller would retry a filtered or cancelled turn as if the
   model had merely run out of room.

## 19. A fan-out client gets `429` with `Retry-After` (`turn_queue_timeout` / `turn_queue_full`)

### Symptom

HTTP `429`, `type: rate_limit_error`, `error.code` either `turn_queue_timeout` or `turn_queue_full`, and
a `Retry-After` header. The message says no ChatGPT Web browser slot became free within the wait budget,
or that the queue was already full, and that the turn was **not started**. A well-behaved client logs
the same 429 and retries on its own backoff.

### Cause

Issue #358. One authenticated account serves at most `MAX_CHATGPT_BROWSER_TABS` (5) simultaneous
browser turns. A turn that arrives while all five are in use now *waits* — bounded by the queue's wait
budget (60 s by default) — and is refused with this 429 only when the budget expires or the bounded
queue is already full. It is **backpressure, not a provider failure**: nothing was submitted, ChatGPT
never saw the request, and the conversation's continuity is untouched, so retrying after the advertised
delay is safe.

- `turn_queue_timeout` — the turn waited the whole budget and no slot became free.
- `turn_queue_full` — the bounded queue already held its maximum number of waiters; refused immediately
  with the same backpressure instead of growing without bound.
- Housekeeping turns (a declared `purpose`, e.g. a session title or a compaction) are served before
  conversational ones, and one caller cannot hold every slot while another caller waits.
- `GET /v1/control/status` publishes `turnQueue` (depth, grants, wait times, refusals, per caller) and
  `turnAccounting` (browser turns per request and per operation, and the wait for a slot).

### What to do

1. Honour `Retry-After` in your own client; do not retry immediately and do not raise the client's
   concurrency. Against a single account, keep the client's own concurrency low (1 is the safe value):
   a large fan-out only moves the same queue inside the bridge. Let the client's retry budget absorb
   the deferral.
2. If the refusal is chronic, read `turnQueue` on `/v1/control/status`: a depth that never falls with no
   grants usually means a stuck turn (§15), not a burst.
3. Do not try to raise `MAX_CHATGPT_BROWSER_TABS`. It is an account-safety bound — each turn owns a real
   browser document in the signed-in account — not a tuning knob.

## 20. The ChatGPT session expires mid-run

### Symptom

A turn fails with HTTP `401`, `type: authentication_error`, `code: chatgpt_session_expired`, and a
message saying the ChatGPT web login is expired or the Temporary Chat surface is unavailable. A client
logs the same 401 and retries.

### Cause

The authenticated browser session stopped being accepted while the service was running: the provider
signed it out, expired it, or replaced it with a verification challenge. The provider detects it from the
page's own expired-session alert, and that check runs both at surface readiness (before the prompt is
submitted) and while it waits for the answer (after submission).

### What to do

1. Sign in again at the operator surface `http://127.0.0.1:17841/v1/control/auth/` (no display needed).
   The running service picks the new session up on the next turn — no restart. `auth import` is the
   route that still needs `docker compose restart chatgpt-web`.
2. Confirm with `GET /v1/control/auth/health`, or run `doctor`: the `login` check and the per-provider
   WebChat check both report the missing verified session.
3. Retry only when the failure came from the readiness check: nothing reached ChatGPT then, so a retry is
   safe. A turn that failed this way **after** its prompt was submitted is the ambiguous case of §11 —
   the account may still be running it, so do not resend it blindly.

## 21. A `temporary` profile's first real turn is the verification

### Symptom

A `temporary` endpoint profile (or `chatVisibility: "temporary"`) fails on a real account with
a typed refusal naming the Temporary Chat surface, for example:

~~~text
ChatGPT Temporary Chat did not expose a structural personalization control before the readiness deadline
~~~

or the readiness error that says `ChatGPT web login is expired or the Temporary Chat surface is
unavailable`, which is what the temporary surface reports when its composer never appears.

### Cause

This is the known risk of issue #355. The temporary surface is a *different* ChatGPT page
(`?temporary-chat=true`) with its own readiness assertions: before submitting a turn the provider
requires exactly one structural personalization control, a verifiable personalization state, and a
confirmed connector-personalization state, and it refuses rather than guessing. Those assertions are
pinned by a suite that simulates browser I/O, and the surface measured against a real account is the
**persistent** one — there is no recorded live Temporary Chat turn in this repository. The first real
temporary turn is therefore the verification, and a rejection there is a finding to report, not
something to work around by disabling the assertions.

### What to do

1. Prove the surface before pointing a workload at it. Create the profile, then run `doctor` (its
   structured-output probe performs one real turn) or send a single request:

   ~~~bash
   curl -fsS http://127.0.0.1:17841/p/hidden/v1/chat/completions \
     -H 'content-type: application/json' \
     -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}]}'
   ~~~

2. If the refusal names the personalization control or the connector state, the account's Temporary Chat
   page differs from what the provider asserts. Capture the page's state — never cookies or storage
   state — and report it. Do not silently switch the deployment to `persistent` to get past it: that
   writes the workload's turns into the account's history, which is the thing the profile exists to
   prevent.
3. `temporary` is refused outright on a launcher browser host and on a non-ChatGPT route: those
   deployments cannot honour it, and the refusal is typed rather than a silent fallback to the default
   endpoint's behaviour.

## 22. Reporting a bug

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

## 23. Development versus user troubleshooting

If you are changing the implementation rather than operating an installed release, start with:

~~~bash
bun run typecheck
bun run build
bun run test
~~~

Then run the focused test associated with the behavior being changed.

For browser/session changes, use deterministic transport fixtures where possible and use live authenticated browser sessions only where they are required to prove provider-specific behavior.

For architecture work, read doc/architecture.md before modifying ownership boundaries.

## 24. The DSH plugin

The plugin is a thin DSH provider over the service HTTP API; its design and contracts are in
[`doc/plugin.md`](./doc/plugin.md). Its failures are almost always one of the seven below, and each
one is visible from the plugin's settings page (Settings → ChatGPT Web) or from the service's own
endpoints.

### 24.1 The plugin reports the service as unreachable

**Symptom.** A turn fails with a `TRANSPORT` error whose message says the service cannot be reached,
and the settings page's status panel shows the service as `unreachable` with a sanitized reason
(`unreachable` or `timeout`).

**Cause.** The plugin host cannot open an HTTP connection to the configured `baseUrl`: the instance
is not running, the port is wrong, or the URL points at the wrong instance. The two-instance layout
makes this easy to get wrong — `:17841` is Hindsight's instance, `:17842` is the plugin's.

**What to do.**

1. Prove the service from the same host the plugin runs on:

   ```bash
   curl -fsS http://127.0.0.1:17842/healthz
   docker compose -f docker-compose.plugin.yml ps
   ```

2. Check `baseUrl` in the plugin settings. It is the service root, not the API base: the plugin
   appends `/v1/...` itself. An endpoint profile belongs in the URL as `/p/<profile>`.
3. If the service is up but the plugin still times out, check `requestTimeoutMs`: `0` disables the
   client deadline, which is the normal setting because a browser turn takes minutes. A small
   non-zero value aborts a healthy turn.

### 24.2 A turn fails with `401` / authentication

**Symptom.** The turn fails with `AUTH`. The service's own error code is either `invalid_api_key`
(the service has an API key configured and the plugin did not send it) or `chatgpt_session_expired`
(the service is reachable but its ChatGPT account is signed out).

**Cause.** Two different credentials, easily confused: the **API key** authenticates the plugin to
the service, and the **control token** guards only `/v1/control/*` (status and sign-in). The account's
provider session is a third thing, stored in the instance's data volume.

**What to do.**

1. If the service was started with `DSH_CHATGPT_WEB_API_KEY`, set the same value as `apiKey` in the
   plugin settings. A loopback instance without an API key needs no `apiKey`.
2. If the code is `chatgpt_session_expired`, sign the instance's account in again at
   `http://127.0.0.1:17842/v1/control/auth/` (the plugin's status panel links to it). The running
   service picks the new session up on the next turn; no restart is needed.
3. Do not put the control token in `apiKey`, or the API key in `controlToken`: the first is rejected
   by the service, and the second makes the status panel report a rejected control token.

### 24.3 The catalogue is empty, or the model is not available

**Symptom.** The model selector is empty, or a turn fails with `UNKNOWN_MODEL` saying the service
catalogue is unavailable / does not list the model / does not declare a `context_window`.

**Cause.** The service's catalogue is derived from the authenticated account's capability state and
from the configured providers. A service that is up but not signed in publishes no ChatGPT Web rows;
a model id that is not an exact catalogue slug is refused; a row without `context_window` cannot be
resolved, because DSH compaction depends on a declared window.

**What to do.**

1. Read the catalogue directly: `curl -fsS http://127.0.0.1:17842/v1/models | jq '.models[].slug'`.
   The plugin serves `chatgpt-web/*` and `qwen-chat/*` only; other rows are never offered.
2. If the list is empty or missing `chatgpt-web/*`, the instance's account is not signed in or its
   capability state is unverifiable — fix the sign-in first (§24.2), then refresh the page.
3. Use an exact slug from the catalogue. A backend id such as `gpt-5.6-luna` is not a route.
4. The plugin caches a successful catalogue read for 30 s and never falls back to a stale one, so a
   model that just disappeared fails resolution until the catalogue recovers. Wait a moment and
   retry; a persistent failure is a service-side catalogue problem, not a plugin one.

### 24.4 The settings page asks for a control token / the account state is unknown

**Symptom.** The status panel shows "control token required" (or the account row stays `not checked`)
even though the service is reachable.

**Cause.** The guarded control surface cannot be read without the control token, so the plugin
deliberately reports `auth: null` instead of guessing an account state. The sign-in page itself is
anonymous by design (a browser navigation cannot carry a header), but every endpoint that carries
data is guarded.

**What to do.**

1. Copy the instance's `controlToken` (from that volume's `config.json`) into the plugin's
   `controlToken` field and save. The page applies it without a restart.
2. Open `{baseUrl}/v1/control/auth/` and enter the control token there to sign the account in. The
   token is never put in a URL, and the plugin never sends it to the browser.
3. If the token is rejected, the panel says so (`control token rejected or control status
   unavailable`). Confirm you are using the token of the instance in `baseUrl` — each volume has its
   own.

### 24.5 A turn is refused with `429` (`turn_queue_timeout` / `turn_queue_full`)

**Symptom.** The turn fails with `RATE_LIMIT`, and the service's `error.code` is
`turn_queue_timeout` or `turn_queue_full`. The service's message says the turn was **not started**
and advertises a `retry-after`.

**Cause.** One authenticated account serves at most five simultaneous browser turns. A turn that
arrives while all five are in use waits for the queue's budget (60 s by default) and is then refused;
if the bounded queue is already full it is refused immediately. This is backpressure, not a provider
failure: nothing was submitted and continuity is untouched.

**What to do.**

1. Wait out the advertised delay and retry the turn yourself. The plugin deliberately disables DSH's
   retry layer, so it will not resend a turn behind your back — and it must not: a turn that reached
   the service may already have been submitted to the provider.
2. Keep DSH's own concurrency low against one account. A large fan-out only moves the same queue
   inside the service.
3. Read `turnQueue` on the service's `/v1/control/status` if the refusal is chronic: a depth that
   never falls with no grants is a stuck turn (§15), not a burst.
4. Do not raise `MAX_CHATGPT_BROWSER_TABS`. It is an account-safety bound, not a tuning knob.

### 24.6 Context pressure and compaction

**Symptom.** DSH starts a compaction, or a long session is refused by the service with
`context_exhausted` / `context_length_exceeded` (mapped to `CONTEXT_WINDOW_EXCEEDED`).

**Cause.** The plugin declares the `contextWindow` the service's catalogue publishes, so DSH
compaction measures pressure against the same window the provider reports. A compaction is an
ordinary auxiliary call (`purpose: "compaction"`) served by the same route; its system instruction is
prepended to the user text because the service has no system slot.

**What to do.**

1. Let DSH compact. A `CONTEXT_WINDOW_EXCEEDED` that survives a compaction means the conversation
   genuinely exceeds the route's window: start a new session or pick a route with a larger
   `context_window`.
2. A compaction that ends with `max-tokens` is reported as an error, not as a summary — the plugin
   never truncates silently. If it repeats, point DSH's summarization route at another provider
   (`dsh-compaction-basic` configuration) or shorten the session.
3. The compaction prompt can carry the service's own `Project: "dsh-chatgpt-web"` install header,
   because an auxiliary call declares no workspace. It is internal context for a summarization call
   and is never shown to the user; do not "fix" it by declaring the workspace on auxiliary calls,
   which would pollute the summary instruction.

### 24.7 "plugin status endpoint unavailable"

**Symptom.** The settings page's status panel reads `plugin status endpoint unavailable` (optionally
with an HTTP status), while the connection fields stay editable.

**Cause.** The page reads the plugin host's same-origin route `GET /plugins/dsh-chatgpt-web/status`,
not the service. That route is missing when the plugin is not loaded in this profile, when the host
has no web server (the route is optional), when an old build without the route is installed, or when
the GUI is served under a path prefix that the route does not match. A `404` is the usual signal; a
transport failure (status `0`) means the page could not reach its own origin.

**What to do.**

1. Confirm the plugin is enabled in the profile and that the build is current: the route exists in
   the same release that ships `lib/plugin.js` and `client.js`.
2. Reload the page. The form does not depend on the probe, so saving and turns still work while the
   panel is unavailable — the panel is diagnostic only.
3. If the GUI is behind a reverse proxy under a subpath, the route must be reachable at
   `/plugins/dsh-chatgpt-web/status` on the same origin the GUI is served from.
4. A `500`-class answer is not expected: the route always answers `200 application/json`, even when
   the service is down. A non-200 therefore points at the host or the proxy, not at the service.
