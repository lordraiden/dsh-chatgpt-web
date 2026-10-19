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
surface, and the neutral `AuthInput` vocabulary (`click`, `type`, `key`, `scroll`, `navigate`) is enough
to drive it — which is exactly what the relayed `/v1/control/auth/` page does. No workaround, no user
agent spoof and no stealth flag was added for Qwen; the launch is the repository's existing shape
(`--headless=new` in `args` plus `--disable-blink-features=AutomationControlled`, `--no-first-run`,
`--no-default-browser-check`) and it carries **no** `--user-agent=` override.

What this measurement does **not** prove, and what remains for the operator: that entering real
credentials in that headless flow completes and the resulting session captures successfully. That needs
an account; the exact command is in §5.

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
API answers `success:true`.

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
