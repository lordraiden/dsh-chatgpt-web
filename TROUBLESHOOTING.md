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

Authentication belongs to the container's own sign-in flow (`login`, the noVNC sign-in image, or `auth import`); do not create a second session store outside the data volume.

Treat the data volume (`DSH_CHATGPT_WEB_HOME`) as credential material.

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

### 11.0 After updating to 1.0.21, a ChatGPT chat starts a new conversation

Expected once. Until 1.0.21 the conversation key was derived from the deployment namespace and the DSH chat identity only; it now includes the provider and the authenticated account binding, so the same DSH chat cannot reuse another account's conversation. The first turn of each chat after the update therefore physically installs a fresh ChatGPT conversation from the canonical DSH context. The DSH history is untouched, and the affinity stays stable from then on.

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

## 13. Qwen Chat or DeepSeek Chat cannot be selected

This is expected on the current production release.

Qwen Chat and DeepSeek Chat are architectural roadmap providers, not currently supported user-facing routes, and the container-only product advertises no route for them.

Do not add ad-hoc Qwen/DeepSeek routes to ChatGPT-specific code. A new provider requires the shared WebChat contracts to be implemented first.

## 16. Reporting a bug

Include:

- operating system and architecture;
- container engine and image tag;
- Node/Bun version;
- browser name/version;
- selected chatgpt-web/... route;
- how the browser session was obtained (`login`, the noVNC sign-in image, or `auth import`);
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
