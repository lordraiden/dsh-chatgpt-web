# dsh-chatgpt-web

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)
[![container image](https://img.shields.io/github/actions/workflow/status/lordraiden/dsh-chatgpt-web/container.yml?style=flat&label=container%20image)](https://github.com/lordraiden/dsh-chatgpt-web/actions/workflows/container.yml)
[![tarball smoke](https://img.shields.io/github/actions/workflow/status/lordraiden/dsh-chatgpt-web/tarball-smoke.yml?style=flat&label=tarball%20smoke)](https://github.com/lordraiden/dsh-chatgpt-web/actions/workflows/tarball-smoke.yml)

> **A container-only service that bridges an authenticated ChatGPT Web session to a text-only HTTP API.**

`dsh-chatgpt-web` runs a headless Chromium in a Docker image, operates an authenticated
[chatgpt.com](https://chatgpt.com) session through its normal web UI, and exposes that session as a
text-only HTTP API. It is not the official OpenAI API and is not affiliated with or endorsed by OpenAI.

---

## Table of Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [API surface](#api-surface)
- [Authentication and exposure](#authentication-and-exposure)
- [Sign in to ChatGPT](#sign-in-to-chatgpt)
- [Model catalogue](#model-catalogue)
- [Text-only: what is refused and what is discarded](#text-only-what-is-refused-and-what-is-discarded)
- [The `usage` block is an estimate](#the-usage-block-is-an-estimate)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## What it is

The product is the container: a self-contained image plus Compose stacks, with the CLI and the HTTP
API as its surface.

- **CLI:** `dsh-chatgpt-web serve|doctor|login|auth import`, plus `setup`, `browser check`, `service`
  and `uninstall`. Every subcommand is reachable through the image.
- **HTTP API:** `/v1/responses`, `/v1/chat/completions`, `/v1/models`, `/healthz`, `/admin/*` and
  `/v1/control/*`.
- **Provider:** ChatGPT Web, driven through the authenticated website UI in headless Chromium.
- **Storage:** one data volume holds the configuration, the provider session (credentials) and the
  durable conversation store.

The shared semantics of the exchange live in a provider-neutral WebChat core; ChatGPT Web is the
current provider. Qwen Chat and DeepSeek Chat are roadmap providers and are **not** current routes.
See [`doc/architecture.md`](./doc/architecture.md) for the ownership model.

## Quick start

Requirements: Docker Engine with the Compose plugin (or Podman), ~4 GB free disk for the image, and
roughly 1 GB RAM per active turn.

The first hour is five steps, and `scripts/quickstart.sh` walks them in order: **build** and **start**
the default stack, wait for `/healthz`, **sign in** (the page, or `auth import`), run the container's
own **`doctor`**, then make a **first API call**. The script does the first two and the last two itself —
it makes one real request and ends with the exact command to copy next. When the volume has no
provider session yet it exits non-zero and names the sign-in command, which is the expected first-run
state.

```bash
git clone https://github.com/lordraiden/dsh-chatgpt-web.git
cd dsh-chatgpt-web

# build -> start -> /healthz -> doctor -> first API call; prints the next command at the end
scripts/quickstart.sh
```

Use `sg docker -c 'scripts/quickstart.sh'` if your shell session predates the `docker` group change,
and `scripts/quickstart.sh --build` after pulling new source so the image is rebuilt rather than
reused.

The same path by hand:

```bash
# 1-2. build and start: creates the data volume and becomes healthy by itself
docker compose up -d --wait
curl -fsS http://127.0.0.1:17841/healthz

# 3. sign in: open http://127.0.0.1:17841/v1/control/auth/ in a browser, enter the control
#    token and sign in. The running service picks the session up on the next turn: no restart
#    (see Sign in to ChatGPT)

# 4. doctor: the container's own checks, ending in the next command when something fails
docker compose exec chatgpt-web node lib/cli.js doctor

# 5. first API call
curl -fsS http://127.0.0.1:17841/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}]}'
```

On an empty volume the entrypoint writes a default `config.json` and announces it on stderr, so the
first `compose up` reaches `healthy` with no manual step. Step 3 is the only one that needs a human:
a real turn still needs a provider session — see [Sign in to ChatGPT](#sign-in-to-chatgpt).

The default stack uses host networking and binds the loopback port `17841`, so the service is reachable
only from this machine. `--ipc=host` (the compose default) is recommended by Playwright for Chromium;
`--init` avoids zombie processes.

Common operations (full list in [`doc/container.md`](./doc/container.md)):

```bash
docker compose logs -f                     # logs
docker compose exec chatgpt-web node lib/cli.js doctor --json   # diagnostics
docker compose down                        # stop, keep the data volume
docker compose down -v                     # stop and DROP the credentials volume
```

## API surface

| Route | Purpose |
| --- | --- |
| `POST /v1/responses` | Responses-compatible text endpoint with SSE streaming. |
| `POST /v1/chat/completions` | OpenAI-compatible text chat, streaming and non-streaming. |
| `GET /v1/models` | The provider-qualified catalogue (`models[]`, plus an additive OpenAI `data[]`). |
| `GET /healthz` | Liveness metadata. Deliberately open: Docker's healthcheck and any load balancer need it. |
| `/v1/control/*`, `/admin/*` | Operator routes, authorized with the control token. The sign-in page alone is served anonymously by design — see [Sign in to ChatGPT](#sign-in-to-chatgpt). |

```bash
# OpenAI-compatible chat
curl -fsS http://127.0.0.1:17841/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}]}'

# The same request, streamed
curl -fsSN http://127.0.0.1:17841/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","stream":true,"messages":[{"role":"user","content":"hola"}]}'

# The Responses-compatible endpoint
curl -fsS http://127.0.0.1:17841/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","instructions":"You are a helpful assistant.",\
       "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hola"}]}]}'
```

`/v1/responses` and `/v1/chat/completions` are two wire-compatible ingresses onto the **same** internal
turn — there is no second execution engine.

**Only messages are transmitted.** With a stable session identity (OpenAI's `user` field, or
`session_id`) the API transmits only the **current user message** and the provider conversation holds
the history; without one the request is stateless and every non-conversational role (`system`,
`developer`, `tool`, unknown) is dropped. Harness text written *inside* the current user message cannot
be distinguished structurally and does cross — a documented, test-asserted limit.

**That identity also selects the provider conversation.** A caller that sends `user`/`session_id` gets
exactly that conversation: stable across its turns and distinct from every other caller. A caller that
sends none gets an identity derived from the content of the messages it sent (`dsh-chat-<hash>`), never
a fresh one per request — so a client that resends the same history keeps continuity and a retry does
not fork a second conversation, while different content is isolated. The documented limit: two callers
with **no identity** and **identical message content** are indistinguishable and share one conversation;
a caller that must be distinct has to send `user`/`session_id`, and a stateless caller that wants
continuity has to resend its history (a one-message request is its own conversation).

The rule is the same on **both** ingresses. `/v1/chat/completions` carries it in `client_metadata`; a
`/v1/responses` caller that sends no turn metadata has no surface translation to carry it, so the
adapter's own fallback calls the same identity owner instead of inventing a second derivation. A caller
that provides a native Codex/DSH thread keeps that thread exactly as before — only the metadata-less
fallback changed.

**A DSH caller can send its native identity instead of `user`.** Both ingresses honour
`client_metadata["x-codex-turn-metadata"]`:

```jsonc
{
  "model": "chatgpt-web/luna",
  "messages": [{ "role": "user", "content": "hola" }],
  "client_metadata": {
    "x-codex-turn-metadata": "{\"dsh_session_id\":\"<your session id>\"}"
  }
}
```

A declared `dsh_session_id` wins over a provider-private `thread_id` (a session keeps one conversation
even when its threads change), which wins over `user`/`session_id`. One reader decides that for both
ingresses, so the two surfaces agree.

**A caller that speaks the OpenAI wire need not send `user`.** Two more channels carry the same
declaration, and one reader (`src/web-chat/host/turn-identity.ts`) resolves all of them, so neither can
shadow the identities above:

- `prompt_cache_key` in the body — the session affinity an OpenAI-compatible client declares there. The
  `@earendil-works/pi-ai` adapter writes the harness session id into it verbatim (only ever truncated to
  64 characters, never hashed) when the harness profile sets `cacheRetention: "long"`, so a DSH session
  reaches the service as its ChatGPT-Web conversation with **no installation at all**: the profile alone
  puts it on the wire.
- the session-affinity request headers a client may send instead — `x-session-affinity`, `session_id`,
  or `x-session-id` (pi-ai's own spellings). `x-client-request-id`, which pi-ai emits beside them, is
  deliberately *not* read: it names a request, not a session.

`user`/`session_id`, a native `thread_id` and a native `dsh_session_id` all outrank both, and a blank
value is absence. So does the purpose below. The retirement condition is the same for both channels: a
caller that states a native identity does not need them, and they contribute nothing once it does.

**An auxiliary turn is answered and kept nowhere.** If the request also declares a turn `purpose`
(`"session-title"` or `"compaction"` — the harness's own housekeeping calls), the turn is executed and
answered normally, but the service **retains no provider conversation for it**: it is not the session's
chat, it does not continue it, and it cannot disturb it. This is the documented contract of the
provider-neutral "ephemeral turn" (`src/web-chat/core/turn-delivery.ts`). Plain chat turns never carry a
`purpose`, so this cannot affect a normal caller.

The declaration travels in the native metadata, or — when only an OpenAI wire is available — in the
`x-dsh-turn-purpose: <purpose>` request header, which a dedicated auxiliary route can attach as a static
per-route header. Both are the caller's *word*: the service classifies from the declaration and never
infers a purpose from content, headers, timestamps or project names. A native `purpose` outranks the
header.

If you are sending no identity at all, read the limit above literally: the service keeps **isolation,
not session continuity** — the same content stays in one conversation, but different content becomes a
different one. Forwarding the session identity (the native metadata above, `prompt_cache_key`, or the
affinity headers) is what turns a harness session into **one** web chat.

### Every CLI subcommand through the image

The entrypoint execs `node lib/cli.js "$@"`, so any subcommand is reachable with `docker run`:

```bash
docker run --rm -v dsh-chatgpt-web-data:/data dsh-chatgpt-web:local doctor --json
docker run --rm -v dsh-chatgpt-web-data:/data dsh-chatgpt-web:local serve --port 17899
```

## Authentication and exposure

The default stack is loopback-only and needs no key. To publish the port you must configure an API key,
and the server **fails closed**: a non-loopback bind refuses to start without one, and a key shorter
than 16 characters is refused.

```bash
export DSH_CHATGPT_WEB_API_KEY="$(openssl rand -base64 32)"
docker compose -f docker-compose.exposed.yml up -d --wait

curl -fsS -H "authorization: Bearer $DSH_CHATGPT_WEB_API_KEY" http://127.0.0.1:17841/v1/models
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17841/v1/models   # 401 without the key
```

Rules this deployment enforces:

1. **The key is a secret, not configuration.** It comes from `DSH_CHATGPT_WEB_API_KEY` or
   `<data dir>/api-key`, never from `config.json`, and it is never logged or returned by `/healthz`.
   `x-api-key: <key>` is accepted as well as `Authorization: Bearer <key>`.
2. **Separate authorities.** The API key does not open `/v1/control/*` or `/admin/*`, and the operator
   control token does not open `/v1/*`; both are constant-time comparisons.
3. **The exposed variant is a separate Compose project** (`docker-compose.exposed.yml`, project
   `dsh-chatgpt-api`) because it and the default stack cannot run at once — they use the same host
   port. It shares the data volume by name, so one sign-in serves either variant.
4. **Reach it from elsewhere only through a TLS-terminating reverse proxy**, never by publishing
   `0.0.0.0:17841` raw. See [`doc/container.md`](./doc/container.md) §5.2 for the Caddy sketch and the
   request-size / in-flight bounds (`DSH_CHATGPT_WEB_MAX_REQUEST_BYTES`,
   `DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS`).

The [`SECURITY.md`](./SECURITY.md) policy applies: this is a personal, single-account bridge, not a
public multi-tenant service, and the provider's terms of service are yours to honour.

## Sign in to ChatGPT

The runtime needs a **verified** browser session: `storage-state.json` plus its `.verified.json`
marker, under `providers/<providerId>/` in the data volume. Cookies alone are never enough — the marker
is what distinguishes "a file exists" from "this session was proven against the provider".

### Sign in from the service's page

The running service serves its own sign-in page. Open it in any browser and enter the **control
token** (the `controlToken` in `config.json`); the provider's browser appears in the tab:

```text
http://127.0.0.1:17841/v1/control/auth/
```

Clicks on the provider's screen are relayed as clicks, and a click also routes your **keyboard** to the
remote browser: the indicator under the screen always says where your keys go. Press `Escape`, or click
any field on the page, to get the keyboard back. The *Send text* field is the paste/long-text fallback
and the only way to type from a phone, whose on-screen keyboard cannot drive the remote browser.

It needs no display and no second container, and it uses the same loopback port as the API —
**control token only**, so the API key does not open it (and the control token still does not open
`/v1/*`). **Nothing needs to be restarted once the session is captured:** the running service
re-derives the account identity and the credentials path from the sign-in itself, so the very next
turn uses the new session. (The `auth import` route below is the exception — it runs in its own
process, so restart the service after adopting a capture that way.)

### Adopt a capture (`auth import`)

Scripted or offline-from-desktop provisioning: on a machine where you can sign in, capture a Playwright
`storageState` JSON (or a directory containing `storage-state.json`), then:

```bash
docker compose exec chatgpt-web node lib/cli.js auth import --provider chatgpt-web --from /capture
```

`auth import` is **fail-closed by construction**: the capture is verified against the provider's login
surface *first*, and both files are written atomically *afterwards*. A capture that cannot be verified
exits non-zero and writes **nothing**. Cookie values are never printed.

### Fallback when a flow rejects headless

`authBrowserMode: "display"` in `config.json` launches a real window instead of headless. `headless` is
the default and the supported path on a headless host — it is what the remote sign-in was verified
with. `"display"` needs a display **you** supply (an X server/socket, or your own headed environment);
the container provides none. See [`doc/container.md`](./doc/container.md) §5.5.

### Prove the browser surface (`browser check`)

After either sign-in — and after any provider change — run `browser check`. It is the cheap step
between "signed in" and "first API call": it launches the configured Chrome and exits **without**
spending a provider turn, so a broken browser/Chrome path is not mistaken for a rejected session.

```bash
docker compose exec chatgpt-web node lib/cli.js browser check
# Playwright can launch the configured Chrome executable.
```

In launcher mode the same subcommand checks the embedded launcher browser instead; under a Zero Risk
(manual) profile it only proves the launcher browser is reachable, because DOM inspection is disabled
by design there.

When the session expires, `doctor --json` reports `login: error — ChatGPT login state is missing or
unverified` with the resolved path; repeat the sign-in or the import. Back up and restore the data
volume encrypted, and never commit it.

## Model catalogue

`GET /v1/models` is the authority. Model ids are the catalogue slugs:

```bash
curl -fsS http://127.0.0.1:17841/v1/models
```

| Route | Product surface |
| --- | --- |
| `chatgpt-web/luna` | Luna-only accounts without the Sol model selector. |
| `chatgpt-web/think` | Luna-only accounts using Luna's Think reasoning mode. |
| `chatgpt-web/light` | Sol/Instant. |
| `chatgpt-web/medium` | Sol/Medium. |
| `chatgpt-web/high` | Sol/High. |
| `chatgpt-web/extra-high` | Pro-gated. |
| `chatgpt-web/pro` | Pro-gated. |

The catalogue is resolved from the authenticated account's capability state, so it is not a promise
that every account has every route: unknown or unverifiable capability state fails closed, and an
unknown model id is a typed `400` that names the accepted ones. Do not configure backend model IDs
such as `gpt-5.6-sol` or `gpt-5.6-luna`; users select the public `chatgpt-web/...` route.

## Text-only: what is refused and what is discarded

The common WebChat contract is text-only, and it separates **capability declarations** from **attached
content**:

- **Discarded by design, never executed and never forwarded:** `tools`, `tool_choice`, `mcp` and the
  legacy `functions` / `function_call`. The provider is a consumer web chat reached as text, so it has no
  execution path and no return channel to your harness: a tool-sending agent (DSH, Cline, …) works, but
  gets plain chat and no tool calls. Nothing is silent — an affected response carries
  `x-dsh-chatgpt-web-ignored-features` and the service logs one line per request.
- **Refused with a typed `400`, never silently dropped:** `n > 1`; `logprobs` / `top_logprobs`;
  `response_format` other than plain text; and attached content — `files`, `images`, `audio`, `video`,
  `attachments` and non-text content parts (`image_url`, `input_audio`, files). Attached content is data
  the caller meant the model to see, so it can never be dropped.

The capability/content split belongs to the common layer's own vocabulary
(`WEB_CHAT_CAPABILITY_FEATURES` / `WEB_CHAT_CONTENT_FEATURES`), so the API does not maintain a second
list. Embeddings, audio, images and batch are not offered at all.

## The `usage` block is an estimate

`usage` is produced locally (tiktoken) for clients that read it. It is **not** consumer-web accounting.

A turn that the provider could not account for does not get a fabricated `0`: a batch body
(`/v1/responses`, `/v1/chat/completions`) **omits** the `usage` field, and the streaming
`response.completed` / `response.incomplete` / `response.failed` envelope carries `"usage": null`.
Handle both — absent and `null` both mean "not reported", and neither is a measurement. When the field
is present its numbers are the local estimate; treat them as an estimate, not as billing or quota truth.

## Troubleshooting

- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — login state, browser executable paths, port
  conflicts, an older container still serving the port, rate limits, continuity loss, bug reports.
- [`doc/container.md`](./doc/container.md) — the container operations manual: image and Compose,
  the data volume layout, privileges, exposure and authentication rules, provider login, and the
  verified container evidence.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — development setup and the verification commands.
- [`SECURITY.md`](./SECURITY.md) — what counts as sensitive and how to report a vulnerability.
- [`doc/architecture.md`](./doc/architecture.md) — the architecture and ownership rules.

## License

[MIT](./LICENSE).
