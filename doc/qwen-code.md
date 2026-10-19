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
| Structural authenticated check (`task/list`, `success === true`) | same module (`qwenTaskListAuthenticated`) |
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
- **One open question for slice 2.** The captured web app also sends an `authorization` header alongside
  cookies. The slice's probe and turn both go through the browser context (cookies from the session, no
  literal credential), so if a real signed-in session answers `Unauthorized` to the cookie-only call,
  the fix is to issue the request the way the page does — from the page, with whatever the page itself
  attaches — not to hard-code a token. The live turn in §5 is what settles it.

## 5. The manual live probe (operator step)

The script is `scripts/probe-qwen-headless.mjs`. It starts nothing but a disposable browser profile and
prints no cookie, token or storage state.

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
| `task/list` answers anything but `success:true` (including HTTP 200 + `success:false`, which is what an anonymous caller gets) | `The capture could not be verified against the Qwen Code login surface, so nothing was written: the task list answered HTTP 200 with Unauthorized 401 Unauthorized; sign in to Qwen Code again …` |

A file that passes every step is stored through `storeProviderSession`, the deployment's single
session writer, exactly like a sign-in through the page: `providers/qwen-code/storage-state.json`
(inside the container, `/data/providers/qwen-code/storage-state.json`) plus
`storage-state.json.verified.json`, both written atomically with mode 0600. The sanitizer keeps only
`qwen.ai` / `aliyun.com` cookies and the `coder.qwen.ai` / `auth.qwen.ai` storage origins.

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
script, re-run `auth import`. There is no refresh token to renew and nothing else to reset.

### What still needs a human (nothing is "fully automatic" here)

- A human signs in and completes the slider if the provider shows one: that is the whole point of this
  path.
- Chrome must be **quit and restarted** with the debugging port; a profile already in use cannot be
  attached to.
- The import needs a browser in the container for the `task/list` check, exactly like the sign-in
  page does; it uses the configured `chromeExecutablePath` and the repository's headless launch shape.
