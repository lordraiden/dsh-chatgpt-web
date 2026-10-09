# Troubleshooting dsh-chatgpt-web

This guide covers operational problems in the current production implementation of dsh-chatgpt-web.

Today the production WebChat provider is **ChatGPT Web**. Qwen Chat and DeepSeek Chat are future text-only providers under the multi-provider architecture and are not current user-facing routes.

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

If the browser is managed by the DSH Launcher, authentication belongs to the Launcher-owned browser flow; do not create a second plugin-owned login state unless the selected mode requires it.

Treat the plugin storage tree as credential material.

## 3. Snap/Chromium cannot create its browser profile

### Symptom

A snap-confined Chromium fails with an error similar to:

~~~text
Failed to create .../SingletonLock: Permission denied (13)
~~~

### Cause

The snap browser may not be allowed to write the hidden default plugin directory under ~/.dsh/.

### Resolution

Use a non-hidden home for the plugin:

~~~bash
DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web" \
  dsh-chatgpt-web setup --chrome /snap/bin/chromium
~~~

Persist the same DSH_CHATGPT_WEB_HOME in the environment that starts DSH.

The same effective plugin home must be visible to:

- setup;
- login;
- doctor;
- the DSH process that starts the sidecar.

A one-off VAR=value command does not change the environment of a later DSH process.

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

For the normal DSH-managed path, prefer changing the configured sidecar port rather than maintaining a second competing sidecar.

Do not expose the sidecar beyond its intended loopback boundary.

## 6. DSH starts but the native provider is unavailable

Confirm that the provider is configured through DSH's native ctx.llm route.

The native path does **not** require an OpenAI API key, an openai-responses provider entry, or a separate localhost Responses provider.

Check:

1. the provider is chatgpt-web;
2. the selected model route is one actually exposed by the authenticated ChatGPT Web capability state;
3. doctor is healthy;
4. the sidecar is running in the same effective plugin home/profile.

Do not configure backend model IDs directly. Use the public chatgpt-web/... routes documented in the README.

The local /v1/responses endpoint is a compatibility ingress, not the native DSH provider boundary.

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
5. Restart the DSH-managed sidecar only if it is actually unhealthy.

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

## 10. Second DSH chat cannot start while another chat is generating

### Current status

The current main implementation has an account-level ChatGPT browser lease that can reject a second DSH turn on the same authenticated account while another turn is active.

This is a **known implementation limitation**, not the target multi-provider architecture.

Tracked by:

- issue #201;
- proposed fix PR #202.

The intended ownership model is:

- one active turn per logical provider conversation;
- separate DSH conversations may use separate physical transport resources;
- account-level fan-out remains bounded and provider-specific.

Do not work around this by disabling the per-conversation safety guards or sharing one physical page between unrelated DSH conversations.

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

### 11.1 `ChatGPT stopped responding after the task started` while ChatGPT is still working

Observed as a failed **Review with ChatGPT** (or any long ChatGPT Web turn) whose tab keeps working and produces the answer anyway.

The generic sentence is the adapter's copy for *any* post-submission failure; the precise cause is in the sidecar log and in the per-turn diagnostic (`diagnostics/browser-turns/<traceId>/12-turn-failed.json`). Two causes have been seen:

- `ChatGPT response DOM disappeared while the browser turn was active` — ChatGPT's work/commentary phase replaces the assistant turn element with its activity view. The worker now treats a visible **Stop button** as proof that the model is still working, so that re-render no longer fails the turn (issue #214). A generator that keeps running without ever exposing material is still bounded by `tuning.generationRunningStallMs`.
- the generation-running stall budget itself (`tuning.generationRunningStallMs`, 15 minutes by default) — a genuinely stuck generator. Raise it in the browser transport tuning when a legitimate review takes longer.

If a review still fails while ChatGPT finishes the answer, do **not** resend the review: open the Advisor dialog (the composer's **Review with ChatGPT** control) and use **Recover answer from ChatGPT**. The recovery is read-only — it never submits or navigates — reads the finalized answer from the retained Advisor conversation, shows it in a selectable field with a **Copy** action, and records it for the turn, so it also appears in the turn card and can be sent to DSH. A recovery that finds nothing yet can simply be retried once ChatGPT finishes.

## 12. Conversation continuity was lost

A provider conversation is not the DSH session.

The system must not silently create a new remote conversation and report normal continuation.

The intended recovery choices are explicit:

- exact resume;
- explicit replay/rebuild from canonical DSH text history;
- deterministic failure.

Do not reconstruct authoritative DSH state from browser-visible conversation text.

## 13. Qwen Chat or DeepSeek Chat cannot be selected

This is expected on the current production release.

Qwen Chat and DeepSeek Chat are architectural roadmap providers, not currently supported user-facing routes.

Their implementation work is tracked separately under the WebChat migration:

- #189–#199.

Do not add ad-hoc Qwen/DeepSeek routes to ChatGPT-specific code. The provider migration requires the shared WebChat contracts to be implemented first.

## 14. Updating the published plugin

For the normal private package workflow, use the DSH plugin updater rather than pulling source and rebuilding:

~~~bash
dsh plugin --profile <profile> update @lordraiden/dsh-chatgpt-web
~~~

The @lordraiden scope must resolve through GitHub Packages:

~~~ini
@lordraiden:registry=https://npm.pkg.github.com
~~~

Authentication belongs outside the repository.

For source development, use the repository's normal development commands:

~~~bash
bun install
bun run typecheck
bun run build
bun run test
~~~

A source build is not a substitute for publishing/versioning the private package used by DSH.

## 15. Removing the integration

For package management, prefer the DSH plugin lifecycle rather than editing Cordis files manually unless the installation workflow specifically requires it.

When removing local state manually, the important storage tree is:

~~~text
~/.dsh/storages/chatgpt-web/
~~~

or the path selected by --home / DSH_CHATGPT_WEB_HOME.

Delete browser/session state only when you intend to invalidate the saved authentication.

## 16. Reporting a bug

Include:

- operating system and architecture;
- DSH version;
- plugin/package version;
- Node/Bun version;
- browser name/version;
- selected chatgpt-web/... route;
- whether the browser is plugin-managed or Launcher-owned;
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
- runtime keys;
- control tokens;
- private prompts;
- local filesystem secrets;
- launcher authorization material.

## 17. Development versus user troubleshooting

If you are changing the implementation rather than operating an installed release, start with:

~~~bash
bun run typecheck
bun run build
bun run test
~~~

Then run the focused test associated with the behavior being changed.

For browser/session changes, use deterministic transport fixtures where possible and use live authenticated browser sessions only where they are required to prove provider-specific behavior.

For architecture work, read doc/architecture.md before modifying ownership boundaries.
