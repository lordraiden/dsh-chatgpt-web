# Qwen Code provider — slice 1 (issue #299)

> **Scope.** This is the slice-1 evidence record for the second WebChat provider: the sign-in verdict,
> the observed network surface, the code delivered for it and the manual live probe. It is not a
> second architecture document ([`architecture.md`](./architecture.md)), not a user README
> ([`README.md`](../README.md)) and not the onboarding procedure
> ([`provider-onboarding.md`](./provider-onboarding.md)). Where this document and the code disagree,
> the code and its tests win.

## 1. The decisive question, answered with evidence

**Does a fresh headless browser profile get an authenticated Qwen session at all?**

The part that can be answered without an operator's credentials was measured on **2026-10-19** against
live `coder.qwen.ai`, with Playwright's Chromium 155 in `--headless=new` mode and a fresh profile:

| Observation | Result |
| --- | --- |
| Page load | **HTTP 200**, `domcontentloaded`, SPA boots |
| User agent presented | `Mozilla/5.0 (X11; Ubuntu; Linux x86_64) … HeadlessChrome/155.0.0.0 Safari/537.36` |
| App title / shell | `Qwen Coder`; the signed-out landing page renders ("Qwen Coder — Help you write code and seamlessly export it directly to GitHub.") |
| Sign-in entry | Clicking **Log in** navigates to `https://coder.qwen.ai/auth?action=signin&from=coder` |
| Sign-in form | Rendered **inside the page** (no iframe): visible `email` text field, **Continue** (verification code), **Log in with a password**, **Continue with Google/GitHub/Apple** |
| Captcha / bot wall | **None presented**: no `nc_1_wrapper`/`.nc-container`/nocaptcha widget. Alibaba AWSC/Baxia telemetry scripts load (5), but no challenge fired |
| Authenticated API, anonymous caller | `GET /coder/api/v2/task/list?page=1` → **HTTP 200** with `{"success":false,"data":{"code":"Unauthorized","details":"401 Unauthorized"}}` |

**Verdict: headless is not rejected.** A fresh headless profile reaches the complete, operable sign-in
surface, and the neutral `AuthInput` vocabulary drives it — which is exactly what the relayed
`/v1/control/auth/` page does. No workaround, no user agent spoof and no stealth flag was added for
Qwen; the launch is the repository's existing shape (`--headless=new` in `args` plus
`--disable-blink-features=AutomationControlled`, `--no-first-run`, `--no-default-browser-check`) and it
carries **no** `--user-agent=` override.

**Correction, same day, from a real operator sign-in.** The claim that the then-five-intent vocabulary
(`click`, `type`, `key`, `scroll`, `navigate`) was *enough* was too strong. Signing in through the
relayed page, the provider presented an **Access Verification slider captcha** ("Drag to complete the
puzzle"), and that is not expressible as a click: it needs a pressed pointer moved along a path. The
gap was in the neutral contract, not in this provider's controller — any provider may present a drag
during sign-in — so `AuthInput` gained a provider-neutral `drag` (`{type:"drag", points:[{x,y,atMs}]}`,
an ordered sampled path in the same coordinates as `click`) and the relayed page now captures the
operator's real `pointerdown`/`pointermove`/`pointerup` path and sends it as one input. Both controllers
replay it with `page.mouse.move/down/up`, one move per sample, preserving the sampled order. The page
samples at a coarser interval than the first cut (and thins a long gesture instead of growing without
bound), each controller schedules the replay against the press's clock so a move's own cost is not paid
again as a sleep, and the release is the mapped `pointerup` — never the last throttled `pointermove`.
No synthetic motion, no stealth and no UA change were added, and **no one has solved the Qwen slider
yet**: whether the provider's risk engine accepts a relayed human drag is exactly what a live attempt
must still establish. See `doc/provider-onboarding.md` §1.3 for the contract shape.

**Correction, later the same day, from the next real operator attempt.** The batched `drag` above was
still wrong in a way the coordinate fix could not reach: the page accumulated the whole path and sent
it at the release, so the remote browser only *started* moving the piece when the operator had already
finished — slower frames could not fix that, and the operator reported "the image does not move with
my mouse; when I let go it moves after a few seconds". The neutral contract gained a **live** gesture
(`pointer-down` / `pointer-move` / `pointer-up` / `pointer-cancel`): the page sends each sample as it
observes it, the controller presses on the first, applies one `mouse.move` per arriving sample and
releases at the exact mapped `pointerup`, and the session owns the held button between requests with a
safety timeout, cancellation and teardown release. The settled frame is forced after the release, the
relay bursts at 12.5 fps (with cheap JPEG frames) while the gesture is live, and the page draws the
operator's own pointer locally and publishes the frame's age. This removes the *application* delay;
whether the provider accepts the relayed gesture is still the live question.

What this measurement does **not** prove, and what remains for the operator: that entering real
credentials — and clearing the slider if it appears — in that headless flow completes and the resulting
session captures successfully. That needs an account; the exact command is in §5.

### Two findings worth keeping

1. **The `405` is a user-agent filter, not headless detection.** A bare `curl` (no browser UA) gets
   HTTP 405 from both `/` and the API; a browser user agent gets 200. Headless *Chrome* is served
   normally — so "the provider blocks automation" would be the wrong conclusion, and the right
   follow-up for any future 405 is "how was this request made", not "disguise the browser".
2. **Anonymous callers get HTTP 200.** The authenticated check must inspect `success`, not the status
   code. `src/adapters/qwen-code/auth-controller.ts` does exactly that
   (`qwenTaskListAuthenticated`).

## 2. The observed network surface (shapes only)

From the recorded HAR of the signed-in web app. No cookie, token or `Authorization` value is
reproduced anywhere in this repository, and none is needed: the browser session supplies them.

| Request | Body keys | Answer |
| --- | --- | --- |
| `POST /coder/api/v2/task/new` | `chatId:""`, `models:[model]`, `chat_type`, `title`, `chat_mode`, `timestamp`, `sub_chat_type` | `{success, request_id, data:{id}}` |
| `POST /coder/api/v2/task/completions?chat_id=<id>` | `stream`, `version`, `incremental_output`, `chatId`, `parentId`, `chat_id`, `chat_mode`, `model`, `parent_id`, `messages[]`, `timestamp` | `text/event-stream` |
| `GET /coder/api/v2/task/list?page=1` | — | `{success, data:[…]}` (or `success:false` + `code`) |
| `GET /api/v2/configs/git` | — | `{success, data:{…}}` (documented alternative probe) |
| `GET /coder/api/v2/task/{id}/status` | — | `{success, data:{status}}` |

Message entries carry `id, fid, parentId, childrenIds, role, content, user_action, files, timestamp,
models, model, chat_type, feature_config, extra, sub_chat_type, parent_id`, with
`feature_config = {thinking_enabled:false, output_schema:"phase"}` and `extra.meta.subChatType` set.
The web app sends a client-generated message id and a client-generated assistant id in `childrenIds`;
this adapter does the same (`qwenCodeCompletionRequest`).

Stream frames:

```text
data: {"response.created":{chat_id,parent_id,response_id}}
data: {"choices":[{"delta":{role,content,phase,status,extra}}], response_id, timestamp}
data: {"response.info":{action,chat_id,response_id,timestamp}}
```

### Termination signals — three, separately observable

The capture shows **every phase** closing with `delta.status:"finished"` (including the agent's
`role:"function"` environment chatter), and `response.info` carrying `keep_alive` frames during the
turn. The adapter therefore treats these as three distinct signals and reports which one fired:

| Signal | Rule implemented | Where tested |
| --- | --- | --- |
| `delta_status` | a **non-`function`** delta whose `status` is present and not `typing` ends the turn | `tests/issue-299-qwen-code-sse.test.ts` |
| `response_info` | a `response.info` whose `action` is not `keep_alive` ends the turn | same |
| `stream_end` | the stream closes without either of the above | same |

`role:"function"` output is **excluded** from the answer text by default (it is the agent environment's
own progress, not the model's text answer) and can never terminate the turn. This is provider-specific
knowledge from the capture, kept inside the Qwen adapter.

## 3. What slice 1 delivered

| Concern | Owner |
| --- | --- |
| Provider identity (`qwen-code`), paths, defaults, headers | `src/adapters/qwen-code/provider.ts` |
| Sign-in controller over the neutral `ProviderAuthController` | `src/adapters/qwen-code/auth-controller.ts` |
| Structural authenticated check (`task/list`, `success === true`) | `src/adapters/qwen-code/session-probe.ts` (`qwenTaskListAuthenticated`, re-exported by the controller) |
| The page's own token (`authorization` header) + the probe request | same module (`session-probe.ts`); evidence in §4.1 |
| Provider-neutral "issue the request from inside the page" | `src/adapters/page-context-request.ts` |
| Capture, scoping and the verified marker | `src/adapters/qwen-code/session-store.ts` (`providers/qwen-code/storage-state.json`) |
| SSE parsing + the three termination signals | `src/adapters/qwen-code/sse.ts` |
| One browser-network turn (`task/new` → `completions`) | `src/adapters/qwen-code/network-turn.ts` |
| Registration in the sign-in surface | `src/server.ts` (`createWebChatAuthSurface({ providers: [...] })`) |
| Shared non-secret diagnostic scrub | `src/lib/safe-diagnostics.ts` (`nonSecretDiagnosticText`); the ChatGPT controller now re-uses it instead of keeping its own copy |

No Qwen knowledge enters `src/web-chat/core/**`; the neutral contract, the sign-in page and the author-
ity boundary are untouched. The only change outside the new adapter directory and its tests is the
second registration entry and the shared sanitizer extraction.

## 4. What the code deliberately does not do yet (slice 2)

- **No driver and no turn route.** `WebChatProviderDriver`, `WebChatTextTransport`,
  `WebChatProviderRuntime`, the catalogue rows (`qwen-coder/<model>`) and the conformance fixture are
  slice 2. This slice proves sign-in and one network turn; it does not serve `/v1/responses`.
- **No account binding.** `inspectAccount()`'s fingerprint, `persistAccountIdentityFingerprint` and the
  physical/logical account check are slice 2; nothing was recorded here.
- **No conversation identity, affinity or retention.** The chat id returned by `task/new` is used for
  one turn and then dropped, as the slice requires; it is never the caller's conversation identity.
- **Resolved after the live import (below): the `authorization` header.** The question this slice left
  open — "the app also sends an `authorization` header; what if a cookie-only call is refused?" — was
  answered by the operator's real sign-in: the import probe *was* refused (`import_predicate_failed`).
  The mechanism and its evidence are in §4.1; the probe and the turn path now issue the request the way
  the page does. A second live import then showed that the capture's own token entry could be a stale
  `loggedOut` state written by the fresh profile, so the token is now read from the **live page after a
  bounded wait for the app to restore itself**, never from the capture.

### 4.1 What the app actually sends, and the fix (issue #299, second pass)

The live result that defined this work: the operator signed in to Qwen Code in a real Firefox window,
the Harness plugin captured **14 cookies and 15 localStorage keys** for `coder.qwen.ai`, POSTed them to
`POST /v1/control/auth/import`, and the service answered **`import_predicate_failed`** — its probe
`GET /coder/api/v2/task/list` was refused, so nothing was stored. The capture was fine. The
authentication of the probe was not.

**Evidence, from the recorded HAR of the signed-in app** (`coder.qwen.ai` archive, 2026-10-19) and the
app's own bundle (`https://assets.alicdn.com/g/qwenweb/qwen-coder-fe/0.0.29/js/main.js`, the exact
version the client sends in its `version` header):

| Fact | Observation |
| --- | --- |
| The API call that matters | `GET /coder/api/v2/task/list?page=1` → HTTP 200, `{"success":true,"data":[…]}` for the signed-in app |
| Headers on **every** API call | `authorization: Bearer <token>` (281-character, JWT-shaped) **plus** `cookie`, `accept: application/json`, `content-type: application/json`, `source: web`, `version: 0.0.29`, `bx-v: 2.5.37`, `x-request-id: <uuid>` |
| Request origin | `sec-fetch-site: same-origin`, `referer` the app page — the call is made *by the page* |
| Where the token comes from | the bundle's axios interceptor does `t.set("Authorization", \`Bearer ${r}\`)` with `r = Zu.getAccessToken()`; the token manager persists it as JSON under `localStorage["qwen_access_token_state"]` (`{token, expiresAt, sessionId, loggedOut, version, stateId, updatedAt, sourceId}`), migrating the legacy `token` + `at_expire_time` pair |
| A cookie-only caller | HTTP 200 with `{"success":false,"data":{"code":"Unauthorized","details":"401 Unauthorized"}}` — the status code cannot decide it |

So the refusal was not a bug in the capture: cookies are necessary but not sufficient, and the request
that failed was one the page never makes.

**Second pass: the token came from the capture. Third pass: the page is the authority.** The second
live import reached the same predicate, but the capture's `qwen_access_token_state` said
**`loggedOut: true`** — a leftover the operator's fresh Firefox profile wrote when it first loaded the
app, while the operator's real session lives in the **cookies**. Sending that state's token (or none)
is refused, and the capture is not the thing to fix. What the app does on boot settles it: from its own
public bundle (`.../qwen-coder-fe/0.0.29/js/main.js`, the version the client header reports) —
`prepareSessionRestore()` resets a stale `loggedOut` state, then
`GET https://auth.qwen.ai/api/v2/auths/refresh` (cookie-authenticated) answers `data.access_token`,
which `setAccessToken()` → `commit()` → `Gu()` writes back under `qwen_access_token_state` (with
`expiresAt` in epoch milliseconds). So the app authenticates *itself* from the cookies, and the probe
must wait for that and then read the live page.

**What was implemented** (`src/adapters/qwen-code/session-probe.ts`):

1. **The page is opened on the captured state, then the probe waits for the app's own session
   restore** — bounded at 20 s, re-reading every 250 ms (`src/adapters/page-hydration.ts`, which is
   provider-neutral). The observable is the app's own token state in `localStorage`: a non-empty
   `token`, `loggedOut !== true`, and a non-past `expiresAt`. A page that is already hydrated costs one
   read; a page that never gets there ends at the deadline instead of hanging. There is no fixed sleep.
2. **The token is read from the live page at call time** — `qwen_access_token_state` (or its legacy
   bare `token` entry) as the app itself just wrote it. Never the capture's entry, never a constant, a
   config value or a fixture, and never logged.
3. **The header shape is the app's** — `authorization: Bearer <token>` plus the same client headers
   (`qwenCodeApiHeaders`) and a per-call `x-request-id`, exactly the recorded set.
4. **The request is issued from inside the provider's page** — `src/adapters/page-context-request.ts`
   runs `fetch` in the page's browsing context on a context seeded with the capture, so the request is
   same-origin and carries the page's `Origin`, `Referer`, cookies and `Sec-Fetch-*`. That module is
   provider-neutral; the token key, its parse and the header shape stay in the Qwen adapter.
5. **One rule for every path.** The import probe, the sign-in controller (`defaultProbeSession`) and
   the turn facility (`createQwenPageRequestFacility`) all read the token through the same helper,
   `readQwenAccessTokenFromPage`. The controller's polling loop is its own bounded wait; the import is
   a single shot, so it calls `probeQwenTaskListFromPageAfterHydration`, which is the same read and the
   same request assembly after the wait. A captured token entry is never sent on its own authority.
6. **The capture script** (`scripts/qwen-storage-state.mjs`) still captures the app page's
   `localStorage` into the capture's `origins`: a fresh token entry is useful to the app on boot, but it
   is no longer what the probe trusts.

**The honest refusal when the page is still signed out.** If the deadline passes and the live page
still has no usable token, the request goes out cookie-only (so the operator gets the provider's own
answer) and the refusal names the page's verdict, not the capture's contents:

```text
The capture could not be verified against the Qwen Code login surface, so nothing was written: the task
list answered HTTP 200 with Unauthorized 401 Unauthorized; the captured session opened the page, but
after 20003ms it still does not consider itself signed in (the live page has no token yet), so no page
token was sent — sign in again, then re-export and re-import
```

If a token *was* sent and the provider still refused it, the refusal says that instead ("the request
carried the page's own token and was still refused, so the session itself is no longer accepted").
Either way the operator and the log see the provider's status and its own code (or a bounded body
snippet), and never a cookie, a storage value or the token.

## 5. The manual live probe (operator step)

The script is `scripts/probe-qwen-headless.mjs`. It starts nothing but a disposable browser profile and
prints no cookie, token or storage state. Its authenticated check is issued **from inside the page with
the page's own `authorization` header**, exactly like the controller. When `--storage-state` is
supplied, it waits — bounded at 20 s, polling every 250 ms — for the app to restore its own token from
the captured cookies before it issues the check, so a stale `loggedOut` entry in the capture does not
decide the result; a fixed pause is never the pass/fail condition. Both the repository's capture script
and the Harness plugin write the app's local storage into the capture, which the app itself may use on
boot.

```bash
# 1. The sign-in surface verdict (fresh profile, no account needed):
node scripts/probe-qwen-headless.mjs --chrome /path/to/chrome

# 2. The one-turn round trip, once an operator has signed in at /v1/control/auth/ and the session is on
#    disk (the marker proves it is a verified capture):
node scripts/probe-qwen-headless.mjs \
  --chrome /path/to/chrome \
  --storage-state "$DSH_CHATGPT_WEB_HOME/providers/qwen-code/storage-state.json" \
  --prompt "Reply with exactly the word: ready"
```

Step 2 prints the frame count, the observed `delta.status` values, the `response.info` actions, which
termination signal fired and the first 200 characters of the answer. It exits non-zero when the
structural probe says the session is not authenticated.

To sign in through the real surface instead of the script: open
`http://<listener>/v1/control/auth/`, paste the control token, choose **Qwen Code**, click **Log in** in
the relayed frame, type the email, continue with the verification code (or "Log in with a password"), and
wait for the session to be captured. The controller polls `task/list` and reports `captured` when the
API answers `success:true`. If an **Access Verification slider** appears, press on its handle in the
relayed frame and drag it the way you would with a mouse: the page relays the path you actually drew
(and says so while you drag), never a synthetic straight line. Whether the provider's risk engine
accepts that relayed human drag is **not yet observed** — if it rejects it, that is a finding to
report, not something to disguise.

### What was and was not executed in this environment

- **Executed** (2026-10-19, live): the fresh-profile headless probe of §1, twice, including the sign-in
  navigation and the structural probe. Output is reproducible with the command above.
- **Observed live, unauthenticated**: `POST /coder/api/v2/task/new`, issued from the page's own browsing
  context, answers HTTP **200** with `{"success":false,"data":{"code":"Unauthorized","details":"401
  Unauthorized"}}`. That is exactly the refusal `runQwenNetworkTurn` classifies as
  `AUTH_REQUIRED`/`QWEN_SESSION_UNAUTHORIZED`, so the transport path is wired to the live service and
  stops at authentication by design — it does not fake a turn.
- **Not executed**: the one-turn live round trip and any completed sign-in. There is no Qwen account or
  captured session available in this environment, and the deployed listener at `http://10.10.28.9:17841`
  runs this project's released image (`1.0.28`, `browser-only` mode) with only `chatgpt-web` registered —
  it predates this slice, so it cannot exercise the Qwen controller until the image is rebuilt and
  redeployed. Docker access from this session was denied (`PERMISSION DENIED` on the daemon socket), so
  the rebuild was not attempted.
- **Proven instead**: the round trip against a recorded-shape fixture with synthetic content
  (`tests/issue-299-qwen-code-sse.test.ts`), including all three termination signals and the typed
  refusal paths.

## 6. Signing in on the operator's own machine, then importing the session (issue #299)

This is the **alternative sign-in path** for this provider, and it exists for one measured reason:
`coder.qwen.ai` presents an Access Verification slider during sign-in, and its risk engine **refuses
relayed input** — the relayed path now reproduces the operator's real gesture sample by sample and
still does not pass the challenge. The remaining obstacle is *synthesised input*, not coordinates, so
the honest fix is to sign in with real input in a real browser and adopt the resulting session. Do
not "simplify" this away by making the relayed flow stealthier: no user-agent trick and no stealth flag
is added here, and the relayed path stays as it is.

The capture script is `scripts/qwen-storage-state.mjs`. It is plain ESM using only Node's built-in
`fetch` and global `WebSocket` (Node ≥ 22.19): **nothing is installed, on either side** — no npm
package, no Playwright, no browser download. It runs on the operator's machine, not in the container.

### Step 1 — on your own PC: sign in with a real browser, capture the session

Quit Chrome completely first: a running Chrome with the default profile will not open a debugging
port. Then start Chrome with the DevTools port and sign in normally:

```bash
# Linux
google-chrome --remote-debugging-port=9222
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# In that Chrome window: open https://coder.qwen.ai and sign in as usual (real typing, real drag),
# then leave the window open and run, from a checkout of this repository:
node scripts/qwen-storage-state.mjs --out ~/qwen-storage-state.json
```

The script is one file with no imports beyond Node's built-ins, so if the checkout lives on another
machine, copy just that file to the machine that runs Chrome. It attaches to `http://127.0.0.1:9222`,
reads the browser's cookies over the DevTools protocol (`Storage.getCookies`, with a page-target fallback), keeps only the `qwen.ai` / `aliyun.com`
domain family, drops cookies Chrome already considers expired and third-party-partitioned ones, and
writes a Playwright-compatible `storageState` with **mode 0600**. It prints the absolute file path, the
cookie count and the (non-secret) domains — **never a cookie name or value**. Re-running it replaces
the file atomically, so a partial write can never be mistaken for a capture.

If Chrome answers `403` to the DevTools handshake, restart it with
`--remote-debugging-port=9222 --remote-allow-origins=*`; the script says so in its error.

### Step 2 — in the container: import, verify, and store

```bash
# copy the capture into the running service container (service name: chatgpt-web)
docker compose cp ~/qwen-storage-state.json chatgpt-web:/tmp/qwen-storage-state.json

# validate + run the SAME authenticated predicate the controller uses:
#   GET /coder/api/v2/task/list  must answer success:true
docker compose exec chatgpt-web node lib/cli.js auth import \
  --provider qwen-code --from /tmp/qwen-storage-state.json

# the capture is a credential: remove it from the container's /tmp
docker compose exec chatgpt-web rm /tmp/qwen-storage-state.json
```

On a local install (no container), the second step is simply
`dsh-chatgpt-web auth import --provider qwen-code --from ~/qwen-storage-state.json`.

What the import validates, and what it refuses **before anything is written**:

| Situation | Refusal (actionable text, no cookie value) |
| --- | --- |
| empty file | `… is empty; export the session again from the browser where the provider is signed in` |
| not JSON | `… is not valid JSON; export the session again …` |
| not a storage state | `… does not look like a Playwright storage state (expected a "cookies" or "origins" array)` |
| no cookies at all | `the capture contains no cookies at all; open https://coder.qwen.ai …` |
| cookies, but none for this provider (renamed/missing domain) | `the capture contains no coder.qwen.ai cookies (every cookie in it belongs to another domain)` |
| the provider's cookies all expired | `every coder.qwen.ai cookie in the capture has expired; sign in again …` |
| `task/list` answers anything but `success:true` when the live page had a usable token | `… the task list answered HTTP 200 with Unauthorized 401 Unauthorized; the request carried the page's own token and was still refused, so the session itself is no longer accepted: sign in again …` |
| the page never restored a usable token within the bound (cookie-only request) | `… the captured session opened the page, but after 20003ms it still does not consider itself signed in (the live page has no token yet), so no page token was sent — sign in again, then re-export and re-import` |

A file that passes every step is stored through `storeProviderSession`, the deployment's single
session writer, exactly like a sign-in through the page: `providers/qwen-code/storage-state.json`
(inside the container, `/data/providers/qwen-code/storage-state.json`) plus
`storage-state.json.verified.json`, both written atomically with mode 0600. The sanitizer keeps only
`qwen.ai` / `aliyun.com` cookies and the `coder.qwen.ai` / `auth.qwen.ai` storage origins — including
the local storage entry that holds the token. That entry is what the app itself may seed from on boot;
the probe still reads the live page after the app has restored its own session.

`auth import` runs in its own short-lived process. Nothing consumes this file yet — the Qwen driver
and turn route are slice 2 (§4) — so there is no process to restart today; once the route exists, the
same rule as every other provider applies (restart the service after importing).

### When the session expires

A session does not "fail loudly" on its own: the provider simply stops accepting it. What you will see:

- `auth import` refuses the file with `every coder.qwen.ai cookie in the capture has expired` (the
  cookie's own expiry), or with the `task list answered … Unauthorized` refusal (the account/session
  was revoked server-side before the cookie expired);
- once slice 2 serves the route, a turn that used to stream starts failing `AUTH_REQUIRED` /
  `QWEN_SESSION_UNAUTHORIZED` — the transport already classifies that refusal
  (`runQwenNetworkTurn`), so it is a diagnosis, not a mystery.

Recovery is the same two steps: sign in again at `https://coder.qwen.ai` in Chrome, re-run the capture
script, re-run `auth import`. The import stores no refresh credential of its own: on boot the app
refreshes its access token from the cookie session (`GET https://auth.qwen.ai/api/v2/auths/refresh`),
which is exactly why the probe waits for that and then reads the live token — the cookies are the
session, and once they stop being accepted there is nothing else to reset.

### What still needs a human (nothing is "fully automatic" here)

- A human signs in and completes the slider if the provider shows one: that is the whole point of this
  path.
- Chrome must be **quit and restarted** with the debugging port; a profile already in use cannot be
  attached to.
- The import needs a browser in the container for the `task/list` check, exactly like the sign-in
  page does; it uses the configured `chromeExecutablePath` and the repository's headless launch shape.
