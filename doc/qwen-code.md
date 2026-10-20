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

## 4. What slice 1 deliberately left out (delivered by slice 2 — see §7)

> **Note on the route spelling.** Slice 1 wrote the catalogue rows as `qwen-coder/<model>`. The shipped
> provider id is **`qwen-code`** (`QWEN_CODE_PROVIDER_ID`), which is also the credential directory the
> operator's verified session lives in (`providers/qwen-code/`) and the id the sign-in surface
> registered. The public route is therefore **`qwen-code/<model>`**; `qwen-coder/` was never an id in
> the code. Renaming it would orphan that session directory, so the id is kept and the spelling above is
> corrected rather than perpetuated (see §7.7).

- **No driver and no turn route.** `WebChatProviderDriver`, `WebChatTextTransport`,
  `WebChatProviderRuntime`, the catalogue rows (`qwen-code/<model>`) and the conformance fixture are
  slice 2 (§7). Slice 1 proves sign-in and one network turn; it does not serve `/v1/responses`.
- **No account binding.** `inspectAccount()`'s fingerprint, `persistAccountIdentityFingerprint` and the
  physical/logical account check are slice 2. §7.5 records what was actually possible: no stable
  provider-side account identifier was measured, so this provider publishes a **recorded** identity and
  never derives one.
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

**An answer that matches no known shape is reported, not thrown away.** When `task/list` answers a body
the predicate does not recognise, the refusal carries the HTTP status, the `content-type` and a bounded
snippet of the **actual body** (an HTML block/challenge page is named as a non-JSON document with its
`<title>` or first line, never as JSON). Long token-shaped runs, bearer values and JWTs are redacted
before the snippet is bounded, and the whole refusal is composed to the pipeline's 300-character inner
diagnostic bound, so the `auth_import_refused` log line carries the same evidence as the API answer.
The accepted shapes are unchanged: a `success:true` body still authenticates, and the `Unauthorized`
refusal still reads exactly as before — only a body this adapter does not understand gains the extra
report, because that is precisely the case that used to be blind.

### 4.2 A transport bound must not decide authentication (issue #299, fourth pass)

The live result that defined this pass, and that settles how the probe must read an answer:

```text
auth_import_refused {"provider":"qwen-code","code":"import_predicate_failed",
 "message":"… the task list answered HTTP 200, content-type: application/json; the provider answered with a
 non-JSON body: {\"success\":true,\"request_id\":\"[redacted]\",\"data\":[{\"id\":\"[redacted]\",
 \"title\":\"Saludo Inicial\",\"created_at\":…},…"}
```

**The session was authenticated.** Qwen answered `{"success":true,"data":[…]}` with
`content-type: application/json`. What went wrong was ours: the page transport
(`src/adapters/page-context-request.ts`) bounded the answer at its 20 000-character default, the body
was the account's **chat list**, it arrived cut mid-array, `JSON.parse` threw, and a successful answer
was classified as a non-JSON body. A cap that exists to keep diagnostics small had become an
authentication decision.

**Three options were considered, and two were taken deliberately:**

| Option | Decision |
| --- | --- |
| Ask the endpoint for a smaller answer (`?page_size=…`) | **Rejected.** The recorded HAR shows `?page=1` and nothing else. Inventing a page-size parameter would be inventing a provider protocol (AGENTS.md → *Agent decision discipline*). |
| Raise the bound for this one call | **Taken.** `QWEN_CODE_TASK_LIST_MAX_ANSWER_CHARS` = 65 536 in `provider.ts`: more than three times the default, so an ordinary page of chats is read whole and the ordinary predicate still applies; still small enough that a probe never ships an account-sized answer into Node, and the transport now *streams* the body and stops at the bound instead of buffering the rest. |
| Read only as far as the question needs | **Taken, as the rule below.** A body bigger than the bound is decided structurally from its leading envelope, so the cut can never again turn a valid answer into a refusal. |

**The truncation-tolerant rule, exactly.** It is used **only** when the transport reported the body as
truncated (such a body cannot be parsed, so the ordinary predicate has nothing to inspect):

1. the body must **begin** with a JSON object (a byte-order mark and whitespace are allowed). A body
   that starts with a document (`<!DOCTYPE html>`, `<html>`) is never read this way, so an HTML
   block/challenge page still refuses as the document it is;
2. `success` must be a **top-level member of that object** whose value is the literal `true` or `false`.
   A `"success":true` nested deeper, inside a string, or anywhere else in the text is **not** an
   envelope and never authenticates — this is why the read is a small scanner
   (`readQwenTruncatedEnvelope` in `session-probe.ts`) and not a regex over the snippet;
3. `success:false` refuses, citing the provider's own reason from the prefix when it is legible
   (`data.code`/`data.details`, then a free-text `message`/`detail`/`error`/`msg`);
4. `success:true` authenticates: the provider answered its own authorization question, and the cut only
   removed the `data` payload that the *content* predicate would have needed. If the prefix does show a
   `data` member that does not open an array, this is not the list envelope, so no verdict is taken;
5. anything else (no object, no boolean `success`, a cut inside the key or the literal) stays the honest
   refusal — and it now **names the cut** instead of calling a JSON body "non-JSON".

**Which reading won is always said.** The one verdict (`qwenTaskListVerdict`) reports
`source: "parsed-body"` or `source: "truncated-envelope"`; the sign-in controller's poll step and the
import path use it, so a signed-in session can no longer hang on a large chat list. On success the
import's own line names the cut (`… cut at 65536 characters, so its leading envelope is what decided
it`) and the service log carries the same fact beside the stored session:

```text
auth_import_stored {"provider":"qwen-code","verified":true,
 "reading":"body truncated at 65536 chars; the envelope reports success:true"}
```

A refusal says the envelope's verdict and the cut together:

```text
the task list answered HTTP 200 with Unauthorized 401 Unauthorized; body truncated at 65536 chars;
the envelope reports success:false; the request carried the page's own token and was still refused, …
```

Every prior property is kept: a real non-JSON body (an HTML block page) still refuses as a document, an
empty body still refuses, `success:false` still refuses with the provider's own reason, the refusal
still reports status + content-type + a redacted bounded snippet, and **nothing is stored on refusal**.
The suite asserts the live case end to end by running the real transport against a stubbed `fetch`
(`tests/issue-299-qwen-session-import.test.ts`, *a cut answer must not decide authentication*).


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
| `task/list` answers a body no shape in this adapter recognises | `… the task list answered HTTP 200, content-type: text/html; charset=utf-8; the provider answered with a non-JSON document: title "Access Verification"; sign in again, then re-export and re-import` (status + content-type + a redacted, bounded snippet; ≤ 300 chars) |
| the answer is larger than the transport bound and its leading envelope reports `success:true` | **not refused**: the session is verified and stored, and the line names the reading (`… success:true (HTTP 200); the body was cut at 65536 characters, so its leading envelope is what decided it`) |
| the answer is larger than the transport bound and its leading envelope reports `success:false` | `… the task list answered HTTP 200 with <the provider's own code>; body truncated at N chars; the envelope reports success:false; …` |
| the answer is cut before its envelope is legible (no object, no boolean `success`) | `… the task list answered HTTP 200, content-type: application/json; the provider's answer was cut at N characters before its JSON envelope was complete: <redacted snippet>; sign in again …` |
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

## 7. Slice 2 — the provider driver (issue #299)

> **Scope.** This section is the evidence record for the driver: what was built, how a turn flows, how
> continuity and the ephemeral rule are honoured, the catalogue mechanism, what the conformance suite
> proved and what is still unproven. Where this section and the code disagree, the code and its tests
> win (`tests/issue-299-qwen-code-provider-conformance.test.ts`,
> `tests/issue-299-qwen-code-text-transport.test.ts`, `tests/issue-299-qwen-code-route.test.ts`).

### 7.1 What was delivered

| Concern | Owner |
| --- | --- |
| Provider facts: session path, account binding, models, namespace, catalogue rows | `src/adapters/qwen-code/provider-config.ts` |
| Durable conversation ↔ chat state (chat id + parent cursor + generation) | `src/adapters/qwen-code/chat-state.ts` |
| The session page (the one transport resource) and its readiness | `src/adapters/qwen-code/browser-session.ts` |
| The text transport: `task/new` → `completions`, the three termination signals, settlement | `src/adapters/qwen-code/text-transport.ts` |
| `WebChatProviderDriver` | `src/adapters/qwen-code/driver.ts` |
| The composition: continuity decision, exchange, durable confirmation, `WebChatProviderRuntime` | `src/adapters/qwen-code/provider-runtime.ts` |
| The Responses ingress for `qwen-code/<model>` | `src/adapters/qwen-code/responses.ts` |
| Wire-up: dispatch, catalogue rows, `doctor` | `src/server.ts`, `src/model-catalog.ts`, `src/doctor.ts` |

Nothing Qwen-specific enters `src/web-chat/core/**`. The reusable seams this provider *consumes*
rather than reimplements are: the host's one turn-identity reader
(`src/web-chat/host/turn-identity.ts`), the core's ephemeral classification
(`src/web-chat/core/turn-delivery.ts`), the continuation decision and record
(`src/web-chat/core/continuation.ts`), the exchange lifecycle and lease registry
(`src/web-chat/transport/**`), and the Responses framing plus its keep-alive clock
(`src/bridge.ts`).

### 7.2 How one turn flows, end to end

```text
POST /v1/chat/completions  or  POST /v1/responses   model = qwen-code/<modelId>
        ↓  translateChatCompletionsRequest (chat route only; it adds no engine)
        ↓  responseRequest: the route's provider id matches a composed provider
src/adapters/qwen-code/responses.ts
        ↓  resolve the turn: model, current user text, canonical history, declared purpose
        ↓  (ephemeral? — answered through the transport with no store read and no chat)
src/adapters/qwen-code/provider-runtime.ts
        ↓  provider facts → intent → resolveWebChatContinuation (the core decides)
        ↓  beginWebChatConversationAttempt (the record becomes unconfirmed)
        ↓  createWebChatExchange (shared lifecycle: prepare → submit → stream → settle)
src/adapters/qwen-code/text-transport.ts
        ↓  GET the chat: recorded chat (reuse) or POST /coder/api/v2/task/new
        ↓  POST /coder/api/v2/task/completions?chat_id=<id>   (text/event-stream)
        ↓  choices[].delta.content in order, role:"function" chatter excluded
        ↓  stop on: non-function delta leaving "typing" | response.info != keep_alive | stream end
        ↓  completion → record { chatId, parentId } → confirmWebChatConversation
        ↓  events → the adapter vocabulary → response.* SSE (or the non-stream payload)
```

The request shapes are the measured ones: `task/new` sends `{chatId:"", models:[model], chat_type,
title, chat_mode, timestamp, sub_chat_type}` and `completions` carries `chat_id` in the query **and** in
the body, with client-generated message/assistant ids and the parent cursor of the previous turn (the
captured first-turn shape is `parentId: ""` / `parent_id: null`).

**The inherited text-only policy is not re-implemented.** A capability declaration (`tools`,
`tool_choice`/`function_call`, `mcp`) is discarded and **declared** on both routes
(`x-dsh-chatgpt-web-ignored-features` plus one log line), through the Core's own list
(`rejectUnsupportedWebChatFeatures`); nothing reads those fields when the turn is built, so they cannot
be forwarded even by accident. Attached *content* keeps failing with the Core's existing
`UNSUPPORTED_OPTION` refusal. No policy, refusal category or feature list was added for this provider.

### 7.3 Continuity: one conversation key, one chat

- The chat id and the cursor the turn ended on are persisted by **this provider**, keyed by the core's
  affinity key, in `providers/qwen-code/conversations.json` (atomic write, mode 0600). It is continuity
  state only: no transcript, no credential, and it never becomes the caller's conversation identity.
- A conversational turn **reuses** the recorded chat, and creates one only when the conversation has
  none. A different conversation key gets a different chat (pinned in the route suite).
- The declared restart recovery is **`exact_resume`**, and it is honest: the chat id is durable, so a
  turn after a restart continues the same chat, same generation, same opaque handle.
- **If a chat is lost or rejected** the failure is typed, never a silent new chat:
  `CONVERSATION_LOST` (`QWEN_CHAT_LOST`, HTTP 409) is reported, the chat is recorded as `lost`, and the
  next turn rebuilds the conversation as an **explicit replay** from canonical history — a new chat and
  a generation that advances by one, both visible in the record.
- There is **no `retained_surface_lost` family** for this provider: nothing of a conversation is
  retained locally, so nothing of it can be evicted. The one physical resource is the session page,
  which is not keyed by conversation.
- **A never-confirmed attempt is rebuilt, not resumed.** This provider cannot prove from provider
  state which message a half-observed (crashed or cancelled) turn actually applied, so it deliberately
  omits `reconcileConversation`; the next turn therefore takes the same honest recovery the ChatGPT
  adapter takes when it cannot prove its installation state — an **explicit replay** from canonical
  history, which advances the generation and is recorded as such. Leaving the caller with a permanent
  refusal would have been the alternative, and it is not a better one.

### 7.4 Ephemeral turns: answered, kept nowhere

A turn that declares a purpose (`session-title`, `compaction`, or any non-blank value — the
classification is the core's, not this adapter's) is answered with:

- **no `task/new`**: zero chat-creation calls (**asserted** in
  `tests/issue-299-qwen-code-text-transport.test.ts` and through the real listener with the
  `x-dsh-turn-purpose` header);
- **no store read and no store write**: the conversation record is neither created nor continued;
- **no recorded chat or cursor**: the next conversational turn behaves as if the housekeeping call had
  never run.

The one honest caveat: this protocol can only *answer* without creating a chat by streaming into a chat
id this process generated, so that is what an ephemeral turn does. Whether the provider accepts a chat
id it did not create is **not yet measured** (§7.6). If it refuses, the turn fails with the provider's
own typed category — it never falls back to creating a chat, which is exactly the bug this rule exists
to prevent.

### 7.5 Authentication and account identity

- Every request is issued **from inside the session page** with the app's own cookies *and* the
  `authorization: Bearer <page token>` header read from the live page at call time (`session-probe.ts`
  → `createQwenRequestFacility`), exactly as slice 1 established.
- Readiness runs **before** the submission boundary: no verified session (or a page that never restored
  its own token) fails as `AUTH_REQUIRED` with zero send attempts and a message naming
  `/v1/control/auth/`; a session the provider stops accepting is `AUTH_REQUIRED` /
  `QWEN_SESSION_UNAUTHORIZED`. There is no automatic retry of any kind.
- **Account identity is recorded, never derived.** No stable provider-side account identifier was
  measured (the captured HAR has chat endpoints, not a "who am I"), so this provider publishes a
  fingerprint only when the deployment recorded one
  (`webChat.providers["qwen-code"].accountIdentityFingerprint`) and otherwise reports the session as
  authenticated with **no** fingerprint. Conversations bind to a documented stable placeholder in that
  case, published with `accountIdentityRecorded: false`. This is the §4.3 trap of
  [`provider-onboarding.md`](./provider-onboarding.md) avoided rather than repeated: nothing here mints
  an identity from a file.

### 7.6 The catalogue, and what such a row claims

- `qwen-code/<modelId>` rows are the provider's own rows (`qwenCodeCatalogueRows`), composed into
  `/v1/models` beside the ChatGPT rows. The model id maps to a row by provider-qualification, once:
  `providerId` + `/` + the provider-local model id (`webChatPublicRoute`).
- The model list is **configuration**, not discovery: `webChat.providers["qwen-code"].models` (string or
  `{id,label}` entries), defaulting to the one id the capture measured, `qwen3-coder-plus`. No endpoint
  that lists the account's selectable models was recorded, and inventing one would be inventing a
  provider protocol. An empty list is a configuration error, never "serve everything".
- The rows appear when the provider is configured **or** a verified session exists; a ChatGPT-only
  deployment's catalogue is unchanged.
- The row claims only what is true: text-only input, no tools, no image input, no reasoning levels (the
  recorded request pins `thinking_enabled: false`). A selected reasoning level is refused, not dropped.
- `doctor` reports the provider (`webchat-qwen-code`) once those same conditions hold, and never starts a
  browser to inspect it.

### 7.7 Diagnostics

One structured, credential-free line per turn stage (`[qwen-code] qwen_turn {...}`): `ready`,
`chat-created` / `chat-reused` / `ephemeral`, `streaming`, `submitted`, `completed` (with the
**termination signal that fired**, the frame count, the answer length and the elapsed time) or
`failed`/`cancelled` (with the typed category and the provider's own code). The chat is named only as a
12-hex digest. No cookie, token, prompt or chat id is ever printed. A settlement that had to tear the
page down is reported as `qwen_turn_settle_timeout` with its bound.

### 7.8 Conformance, and one finding about the shared suite

`tests/issue-299-qwen-code-provider-conformance.test.ts` runs the **shared** suite
(`tests/web-chat-provider-conformance.ts`) against the real driver, runtime, exchange, durable record
and chat state; only the session page's request facility is controlled. **All ten suite scenarios pass**,
including the failure matrix (cancel 1/1, auth loss 0/0, provider error 1/1, partial 1/1, ambiguous 1/0,
none retryable), the three-turn lineage, the isolation of account/session identities and the idempotent
shutdown.

The second fixture did what [`provider-onboarding.md`](./provider-onboarding.md) §1.7 said it would: it
found a **neutrality gap in the shared suite**. Test 6 ("lost process-local continuity fails closed")
asserted, unconditionally, that an implicit continuation fails after `restart()` — true for a provider
whose continuity is a retained surface (ChatGPT), false for one whose continuation state is durable
(this provider, whose chat id survives the restart). The assertion now follows the declaration the
harness already supplies (`restartRecovery`): for `exact_resume` it requires the continuation to
**succeed as the same conversation** (same key, generation and handle), which is strictly stronger than
before; for every other declaration it keeps the original refusal. ChatGPT's own assertions are
unchanged, because it declares `explicit_replay`. This is one suite with a corrected assumption, not a
fork.

### 7.9 What only a live session can prove

Everything above is deterministic and covered by fixtures. These are **not** measured yet, and each one
is a single operator command away:

| Unproven | Why | How to prove it |
| --- | --- | --- |
| A real streamed turn through the driver (the transport was proven in slice 1, the *driver path* was not) | No Qwen account is available in this environment | `curl -sS -X POST http://127.0.0.1:17841/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"qwen-code/qwen3-coder-plus","stream":true,"messages":[{"role":"user","content":"Reply with exactly: ready"}]}'` |
| Continuation by chat id against the real provider (including whether the recorded `parentId` cursor is accepted) | needs a second live turn | run the same command twice with the same `x-session-affinity` header, or a `user` field |
| An ephemeral turn being accepted with a client-generated chat id | the capture only shows `task/new` → `completions` | send one call with `-H 'x-dsh-turn-purpose: session-title'`; a refusal is a finding to report, not something to disguise |
| Headless session reuse for turns | the import probe launches headless on the capture, but no turn has run that way | the first live turn above |

### 7.10 What the operator must do to use it

1. Sign in (or import) so `providers/qwen-code/storage-state.json` exists **with its verified marker** —
   `GET /v1/control/auth/providers` reports `Qwen Code`, and the import answers `verified: true`.
2. Declare the provider, if the deployment does not already: add
   `"webChat": { "providers": { "qwen-code": { "models": ["qwen3-coder-plus"] } } }` to the configuration.
   (A verified session alone is enough for the row to appear; the block is what pins the model list.)
3. Restart the service after an `auth import` (the sign-in surface needs no restart); a running
   listener resolves the new session at the next turn.
4. Pick the model id **`qwen-code/qwen3-coder-plus`** in the harness (that is the catalogue slug; the
   provider-local id `qwen3-coder-plus` is never the public route). In a DSH harness this is the model
   id it sends as `model`; the conversation continues on the same `x-session-affinity` / `user` value.
