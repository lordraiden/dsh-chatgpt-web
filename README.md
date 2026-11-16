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
- [Configuration](#configuration)
  - [Configure ChatGPT (the default provider)](#configure-chatgpt-the-default-provider)
  - [Chat visibility: temporary (hidden) vs persistent (visible)](#chat-visibility-temporary-hidden-vs-persistent-visible)
- [API surface](#api-surface)
- [Using it as a memory backend (Hindsight)](#using-it-as-a-memory-backend-hindsight)
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

The shared semantics of the exchange live in a provider-neutral WebChat core. ChatGPT Web, Qwen Code
and Qwen Chat are served routes; DeepSeek Web is implemented — its turn transport, page-owned proof of
work, page identity and authenticated import predicate are measured against a signed-in capture — and
publishes no rows until the operator configures its measured `model_type` values
([`doc/deepseek-web.md`](./doc/deepseek-web.md)). See [`doc/architecture.md`](./doc/architecture.md) for
the ownership model.

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

## Configuration

Everything the service needs lives in one JSON file inside the data volume:

```text
<data dir>/config.json      # default: the `dsh-chatgpt-web-data` volume, mounted at /data
```

The entrypoint writes a working default on an empty volume, so the first `compose up` is enough to
start. The fields an operator normally touches:

| Field | What it does |
| --- | --- |
| `port`, `host` | Bind address. Loopback is the default; a non-loopback bind is refused unless an API key is configured. |
| `chatVisibility` | `persistent` (default) or `temporary` — see [Chat visibility](#chat-visibility-temporary-hidden-vs-persistent-visible). |
| `chatgptWeb.tuning` | Browser transport budgets (timeouts, stall budget). Live-editable through the control API. |
| `endpointProfiles` | Named public endpoints with their own visibility, model allow-list and turn budget. |
| `storageStatePath` | Where the signed-in provider session is stored. Written by sign-in; never commit or share it. |
| `controlToken` | The operator credential for `/v1/control/*`. Never the API key. |

Two credentials, deliberately separate:

- **API key** (`DSH_CHATGPT_WEB_API_KEY`, or `<data dir>/api-key`) guards the public API (`/v1/*`,
  `/p/*`). Required for any non-loopback bind; optional on loopback.
- **Control token** (`controlToken`) guards the operator surface (`/v1/control/*`): sign-in,
  configuration, endpoint profiles and diagnostics.

There are three ways to change configuration: edit `config.json` and restart; `PUT /v1/control/config`
for the live-editable fields (it persists and applies on the next turn); or the operator pages. Run
`node lib/cli.js doctor` afterwards — it validates the result and names the next command when something
is wrong.

### Configure ChatGPT (the default provider)

1. **Sign in once.** Open `http://127.0.0.1:17841/v1/control/auth/`, enter the control token, and
   complete ChatGPT's own sign-in in the page. The running service picks the session up on the next
   turn — no restart. `node lib/cli.js login` does the same from a terminal, and `auth import` adopts a
   capture from another machine (see [Sign in to ChatGPT](#sign-in-to-chatgpt)).
2. **Pick the model.** `GET /v1/models` lists the catalogue, and which rows an account is served depends
   on its tier: `chatgpt-web/luna`/`think` are the **Luna-only** rows (an account without the Sol model
   selector), `chatgpt-web/light`/`medium`/`high` are the **Sol** rows, and
   `chatgpt-web/extra-high`/`pro` need **Sol + Pro**. A route the account cannot serve is a typed `400`
   that names the accepted ones, never
   a silent downgrade.
3. **Choose the chat visibility.** Default is `persistent`. Use `temporary` when the caller keeps its
   own transcript and its turns must not appear in the account's history or touch ChatGPT memory.
4. **Prove it.** `docker compose exec chatgpt-web node lib/cli.js doctor` checks the session, the
   browser, the API and the authenticated structured request; then make one call (Quick start step 5).

### Chat visibility: temporary (hidden) vs persistent (visible)

Every turn lands in a ChatGPT conversation, and you choose which kind:

| | `persistent` (default) | `temporary` |
| --- | --- | --- |
| Appears in the account's ChatGPT history | yes | **no** |
| ChatGPT memory can read/write it | yes | **no** |
| Continuity across turns | the provider conversation is kept and continued | none — every turn is a fresh Temporary Chat |
| What the bridge sends | only the new turn, after the first | the caller's full canonical history, every turn |
| Survives a service restart | yes (durable continuity) | no |

Choose it in one of three places, in increasing scope:

1. **Globally, in `config.json`** — `"chatVisibility": "temporary"`. Absent means
   `persistent`, so nothing changes until you ask for it.
2. **At runtime, through the control API** — `PUT /v1/control/config` with
   `{"chatVisibility":"temporary"}`. It persists and applies on the next turn, no restart.
3. **Per endpoint, with an endpoint profile** — a profile states its own mode, which wins for that
   endpoint only (see [Endpoint profiles](#endpoint-profiles-one-service-several-endpoints)). This is
   how one service serves both a hidden endpoint and a normal one at the same time.

A provider-scoped block (`webChat.providers["chatgpt-web"].chatVisibility`) overrides the flat field
for that provider. `GET /v1/control/config` reports both `chatVisibility` (configured) and
`effectiveChatVisibility` (what a turn actually resolves), so a scoped pin can never be a mystery.

What `temporary` really means for a caller: a Temporary Chat has no conversation id, so the bridge
**cannot** continue it. Every turn replays the caller's full history — correct, but more expensive —
and the features that need a retained provider conversation fail closed (compaction and
context-exhaustion replay have no source conversation to work from). If your client keeps its own
transcript and sends it on every call — the normal OpenAI-compatible pattern — `temporary` is the right
mode. If it relies on the bridge to remember the conversation, use `persistent`.

## API surface

| Route | Purpose |
| --- | --- |
| `POST /v1/responses` | Responses-compatible text endpoint with SSE streaming. |
| `POST /v1/chat/completions` | OpenAI-compatible text chat, streaming and non-streaming. |
| `GET /v1/models` | The provider-qualified catalogue (`models[]`, plus an additive OpenAI `data[]`). |
| `/p/<name>/v1/*` | Optional operator-defined endpoint profiles: the same public contract with that profile's chat visibility, model allow-list and concurrency budget — see [Endpoint profiles](#endpoint-profiles-one-service-several-endpoints). |
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
`session_id`) the API transmits only the **current turn** — the newest user message that still carries
human content, so a harness that appends its own runtime snapshot after the human message is answered
from the human message rather than from an empty turn — and the provider conversation holds the history;
without one the request is stateless and every non-conversational role (`system`, `developer`, `tool`,
unknown) is dropped. Harness text written *inside* the current user message cannot be distinguished
structurally and does cross — a documented, test-asserted limit.

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

### Endpoint profiles: one service, several endpoints

The operator can expose **more than one API endpoint** from the same service, each with its own
ChatGPT conversation-visibility mode. A profile is a named public base path:

```text
http://127.0.0.1:17841/p/<name>/v1
```

Point an OpenAI-compatible client at that base URL and its own `/chat/completions` and `/models` calls
land on that profile. The motivating case is two endpoints from one account: a `temporary` profile for
a caller that must not write the account's chat history, and a `persistent` profile for normal,
visible chats. The default `/v1/*` endpoint keeps the configured global behaviour
(`chatVisibility`, `PUT /v1/control/config`).

Manage profiles from the service's own page — enter the **control token**:

```text
http://127.0.0.1:17841/v1/control/endpoints/
```

or from the control API (control token, never the API key):

```bash
# create: hidden Temporary Chats, only the Luna route, at most one turn at a time
curl -fsS -X POST http://127.0.0.1:17841/v1/control/endpoint-profiles \
  -H "Authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"hidden","chatVisibility":"temporary","models":["chatgpt-web/luna"],"maxConcurrentTurns":1}'

# use it exactly like /v1
curl -fsS http://127.0.0.1:17841/p/hidden/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}]}'

# list, replace, delete
curl -fsS http://127.0.0.1:17841/v1/control/endpoint-profiles -H "Authorization: Bearer $CONTROL_TOKEN"
curl -fsS -X PUT http://127.0.0.1:17841/v1/control/endpoint-profiles/hidden \
  -H "Authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"chatVisibility":"persistent"}'
curl -fsS -X DELETE http://127.0.0.1:17841/v1/control/endpoint-profiles/hidden \
  -H "Authorization: Bearer $CONTROL_TOKEN"
```

Rules:

1. **A profile is a view, not a second registry.** It selects among the catalogue models the service
   already serves (`GET /v1/models`); it adds no provider, route or execution engine, and the turn runs
   through the same ingress, provider core and retry authority as `/v1/*`. A profile request never
   reaches the native Codex passthrough.
2. **The API key stays global.** Profiles mint no credential of their own: `/p/*` is guarded by the
   same API key as `/v1/*` (and needs none on a loopback-only service). The management routes stay
   control-token only.
3. **`/v1/models` is per profile.** `GET /p/<name>/v1/models` advertises exactly the models that
   profile serves (its allow-list, or the whole Web catalogue when it states none).
4. **Fail closed.** An unknown model in a profile, a `temporary` profile on a deployment that cannot
   honour it (the launcher browser host, or a non-ChatGPT route), and a deleted profile's path all
   answer typed refusals (`endpoint_profile_*` codes) — never a silent fallback to the default
   endpoint's behaviour.
5. **Live reload.** Profiles live in `config.json` (`endpointProfiles`) and a create/edit/delete takes
   effect on the next request without a restart; `PUT /v1/control/config` accepts the whole set too.

### Operator console

One entry point for every operator surface, and the map that explains each setting:

```text
http://127.0.0.1:17841/v1/control/
```

Enter the **control token** (kept in that tab's session storage, never in a URL). The console has
seven sections:

1. **Overview** — version, mode, whether the service is accepting turns, the live turn counters and
   the effective chat visibility.
2. **Chat** — what visibility and each transport tuning field does, and a link to the settings page
   that owns the controls.
3. **Endpoints** — what an endpoint profile is, and a link to its editor.
4. **Memory** — what the routing generator writes, and a link to it.
5. **Sign-in** — why the sign-in surface stays a separate page (a live session stream), and a link.
6. **Doctor** — what the probe checks and what it costs (one real browser turn).
7. **Reference** — **every** setting with what it does, when to change it, what it affects, its
   default, and which value wins when two overlap (global vs profile visibility, profile concurrency
   vs the process-wide limit, the bridge's turn clock vs the memory backend's timeout).

The console is a client like the pages it links to: it owns no validator, no routing decision and no
probe. The explanations come from one catalogue (`src/web-chat/host/console-content.ts`), so a
setting cannot be described one way in a section and another way in the reference.

### Operator settings page

One page shows the service's live state and edits the two facts that are safe to change at runtime:

```text
http://127.0.0.1:17841/v1/control/settings/
```

Enter the **control token** (kept in that tab's session storage, never in a URL). The page has five
sections:

1. **Status** (read-only) — version, mode, the account capability the configuration reports
   (`solAvailable`/`proAvailable` → Sol, Pro or Free), session health from
   `GET /v1/control/auth/health`, the catalogue rows, and the `turnQueue`/`turnAccounting` counters.
2. **Chat** — `chatVisibility` and the live tuning fields (`turnTimeoutMs` and the
   `CHATGPT_WEB_TUNING_DEFAULTS` keys). Saving posts to the existing `PUT /v1/control/config`, so the
   configuration owner's validation is the only validation: an invalid value is refused with its
   reason, never clamped. An empty field keeps the service default shown as its placeholder.
3. **Endpoints** — a link to [Endpoint profiles](#endpoint-profiles-one-service-several-endpoints);
   the page does not reimplement it.
4. **Memory backend routing** — per operation (`retain`, `consolidation`, `reflect`) choose a bridge
   profile, an external base URL or `disabled`, and copy the generated
   `HINDSIGHT_API_<OP>_LLM_*` environment block. The block carries placeholders only: the page never
   sees the API key and never calls the memory backend.
5. **Doctor** — runs the same probe as `dsh-chatgpt-web doctor`, with a visible warning that it
   performs one real browser turn.

The page is served anonymously **by design** (a browser navigation cannot carry an `Authorization`
header, and the token must never be in a URL); every data-carrying endpoint it calls stays
control-token only. It is one static document — no external asset, no absolute URL — so it works on an
offline container.

### Structured output (`response_format`)

`POST /v1/chat/completions` accepts the OpenAI structured-output shapes:

| `response_format` | Behaviour |
| --- | --- |
| absent, or `{"type":"text"}` | unchanged |
| `{"type":"json_object"}` | accepted; the model is asked for one JSON object |
| `{"type":"json_schema","json_schema":{"name","strict","schema"}}` | accepted; the schema is carried into the turn as text |

A consumer web chat has **no native schema enforcement**, so this is soft by design: the schema reaches
the model as an instruction, the reply is returned **verbatim** (nothing is parsed, repaired or
re-serialized), and the response declares the mode with
`x-dsh-chatgpt-web-structured-output: soft`. A malformed or unknown `response_format` is a typed `400`
(`error.code: invalid_response_format`) before any provider work. `max_completion_tokens` is accepted
as an alias of `max_tokens`; sending both with different values is a typed `400`
(`conflicting_max_tokens`).

**Documented limit:** this bridge cannot enforce a token budget. `max_tokens`/`max_completion_tokens`
are forwarded, not enforced, and no web adapter consumes them, so `finish_reason` is `"length"` only
when the provider itself reports an exhausted output budget — which a web turn never does. A cut-off
answer therefore reads as `"stop"` (TROUBLESHOOTING.md §18).

### One conversation per operation

A client that runs several calls for one logical operation (a multi-step loop, a chunked job) can keep
them on one provider conversation by sending the same `prompt_cache_key` — or `user`/`session_id` — on
every call. This service already reads those fields as a declared conversation identity, so the
operation continues one provider conversation (the surface is not re-hydrated per step, and ChatGPT's
own prefix caching applies) while a different operation gets a different conversation. Reuse is scoped
to that identity and never shared across operations.

This applies to a `persistent` endpoint only. A `temporary` one cannot continue a conversation, so
every turn replays the caller's history; do not declare an operation identity there, because the
projection would then send only the newest user message to a surface that has no history to continue.

### Every CLI subcommand through the image

The entrypoint execs `node lib/cli.js "$@"`, so any subcommand is reachable with `docker run`:

```bash
docker run --rm -v dsh-chatgpt-web-data:/data dsh-chatgpt-web:local doctor --json
docker run --rm -v dsh-chatgpt-web-data:/data dsh-chatgpt-web:local serve --port 17899
```

## Using it as a memory backend (Hindsight)

[Hindsight](https://hindsight.vectorize.io) is an open-source memory layer that drives its own LLM. It
speaks the OpenAI Chat Completions API, so it can use this service as that LLM: the bridge answers each
of Hindsight's calls with a real ChatGPT Web turn.

### What Hindsight expects from the LLM

- `POST {base}/chat/completions`, non-streaming, carrying a **`response_format` JSON schema on every
  structured call** (`retain`, consolidation, `reflect`, pages). This service accepts it and carries the
  schema into the turn as text — see [Structured output](#structured-output-response_format). Hindsight
  validates the reply against its own schema, strips code fences and retries on a parse error, so the
  bridge returns the model's text verbatim.
- **No native tool calling.** `reflect`'s tool calls are replies to a response schema, which is why the
  bridge's capability-discard rule costs nothing here.
- **A large output budget** for `retain` (`HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS`, default `64000`,
  must stay above `HINDSIGHT_API_RETAIN_CHUNK_SIZE`, default `3000`). This bridge forwards that value but
  cannot enforce it, and a web turn never reports an exhausted budget, so `finish_reason` stays `"stop"`
  even for a cut-off answer (TROUBLESHOOTING.md §18).
- **Patience.** A browser turn is minutes, not seconds.

### Optimal bridge configuration: a hidden endpoint

Hindsight's turns are machine work, not conversations: they must not appear in the account's history,
and ChatGPT's memory must not read or write them. That is exactly what a `temporary` endpoint profile is
for ([Chat visibility](#chat-visibility-temporary-hidden-vs-persistent-visible)):

```bash
# once, with the control token (never the API key)
curl -fsS -X POST http://127.0.0.1:17841/v1/control/endpoint-profiles \
  -H "Authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"hidden","chatVisibility":"temporary","models":["chatgpt-web/luna"],"maxConcurrentTurns":1}'
```

- `chatVisibility: "temporary"` — every turn is a ChatGPT Temporary Chat: no history entry, no ChatGPT
  memory read or write, no training use.
- `models` — pin the catalogue route Hindsight may use, so a wrong model id fails at the profile instead
  of silently costing quality. Pick the row your account tier is served: `chatgpt-web/luna`/`think` on a
  Luna-only account, `chatgpt-web/light`/`medium`/`high` on a Sol account (`doctor` reports which).
- `maxConcurrentTurns: 1` — one account serves at most five browser turns; keeping Hindsight at one keeps
  it inside the queue instead of racing the account's other work.

Because a Temporary Chat has no conversation id, the bridge cannot continue it: **every call replays the
full messages Hindsight sends**, which is what an OpenAI-compatible client does anyway. The trade-off is
explicit — no provider continuity, but no history pollution and no memory contamination.

If you would rather have provider-side continuity (a multi-step `reflect` loop continuing one
conversation, with ChatGPT's own prefix caching applying), use a `persistent` profile and send a stable
`prompt_cache_key` per operation — see [One conversation per operation](#one-conversation-per-operation).
The cost is that those turns are ordinary visible chats.

### Optimal Hindsight configuration

```dotenv
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=http://chatgpt-web:17841/p/hidden/v1   # the /v1 suffix is required
HINDSIGHT_API_LLM_API_KEY=<the bridge API key>
HINDSIGHT_API_LLM_MODEL=chatgpt-web/luna
# a browser turn is slow: outlive it instead of abandoning and resubmitting it
HINDSIGHT_API_LLM_TIMEOUT=600
# one account, five browser turns: do not fan out
HINDSIGHT_API_LLM_MAX_CONCURRENT=1
# retain asks for long structured output; must stay above RETAIN_CHUNK_SIZE (3000)
HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=16000
```

`openai` is Hindsight's name for "any API that speaks Chat Completions"; the `/v1` suffix is part of the
base URL because Hindsight appends `/chat/completions` to it (a base URL without it answers `404`).

Per-operation models are supported, so the cheap work and the expensive work can use different routes:

```dotenv
HINDSIGHT_API_RETAIN_LLM_MODEL=chatgpt-web/light
HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=chatgpt-web/light
HINDSIGHT_API_REFLECT_LLM_MODEL=chatgpt-web/high
```

`chatgpt-web/light`/`medium`/`high` need a **Sol** account; on a Luna-only account use
`chatgpt-web/luna` and `chatgpt-web/think`. On startup Hindsight sends one verification call per
configured model, and a model that is down only logs a warning — so check this side too.

The per-operation block above can be generated from the service's own
[settings page](#operator-settings-page): pick a bridge profile (or an external base URL, or
`disabled`) per operation and copy the result. It contains placeholders, never a secret.

### Verify the wiring

```bash
docker compose exec chatgpt-web node lib/cli.js doctor   # proves one authenticated structured request
curl -fsS http://127.0.0.1:17841/v1/control/status | jq .turnAccounting
```

`doctor`'s structured-output probe performs one real turn and reports `ok`, `warning`, `error` or
`skipped` (no API key, or the service is not listening). `turnAccounting` then shows how many browser
turns each request and operation actually cost, how long it waited for an account slot, and how much
context it replayed — the numbers to compare a `temporary` profile against a `persistent` one.

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
5. **Long turns have one explicit bridge ceiling.** `DSH_CHATGPT_WEB_TURN_TIMEOUT_MS` (default
   `900000`, i.e. 15 minutes; positive integer, at most 6 hours) is the only absolute-duration clock that
   declares a turn lost, and its failures carry their own `turn_timeout` code so they are never mistaken for a ChatGPT
   failure. `/v1/chat/completions` streams standard SSE `: keep-alive` comments while the provider is
   working, so a healthy turn of 10–15 minutes does not trip a client's idle timer; **no client timeout
   needs to be raised**. An explicit `chatgptWeb.turnTimeoutMs` (or `tuning.turnTimeoutMs`) in
   `config.json` wins over the environment variable. `chatgptWeb.partialOnTurnTimeout` (or
   `DSH_CHATGPT_WEB_PARTIAL_ON_TIMEOUT=1`) is **off by default**: when enabled, a timed-out turn that
   already shows assistant text returns that partial answer with `finish_reason: "length"` instead of
   failing with `turn_timeout`.

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
any field on the page, to get the keyboard back. If the provider asks for a slider or a puzzle, press
and **drag** on the screen: the path you draw is relayed as the points you actually moved through (the
indicator says so while it happens), not as a straight line between its ends, and the gesture ends at
the point where you released. The *Send text* field is
the paste/long-text fallback and the only way to type from a phone, whose on-screen keyboard cannot
drive the remote browser.

It needs no display and no second container, and it uses the same loopback port as the API —
**control token only**, so the API key does not open it (and the control token still does not open
`/v1/*`). **Nothing needs to be restarted once the session is captured:** the running service
re-derives the account identity and the credentials path from the sign-in itself, so the very next
turn uses the new session. (The two *capture handoff* routes below are the exception — they write the
provider layout without driving the sign-in controller, so restart the service after adopting a
capture that way.)

### Adopt a capture (`auth import`)

Scripted or offline-from-desktop provisioning: on a machine where you can sign in, capture a Playwright
`storageState` JSON (or a directory containing `storage-state.json`), then:

```bash
docker compose exec chatgpt-web node lib/cli.js auth import --provider chatgpt-web --from /capture
# Qwen Code: capture on your own PC first — scripts/qwen-storage-state.mjs (doc/qwen-code.md §6)
docker compose exec chatgpt-web node lib/cli.js auth import --provider qwen-code --from /capture
# Qwen Chat: capture at chat.qwen.ai (cookies are per-domain — a Qwen Code capture is not one)
docker compose exec chatgpt-web node lib/cli.js auth import --provider qwen-chat --from /capture
```

`auth import` is **fail-closed by construction**: the capture is verified against the provider's login
surface *first*, and both files are written atomically *afterwards*. A capture that cannot be verified
exits non-zero and writes **nothing**. Cookie values are never printed.

Qwen Code (`--provider qwen-code`) uses the same command, and is the route for a provider whose risk
engine refuses relayed (synthesised) input: sign in on your own PC with a real browser, capture the
cookies with the dependency-free `scripts/qwen-storage-state.mjs` (it attaches to your own Chrome on
`--remote-debugging-port=9222`), then import the file. Both commands, the checks and the expiry
symptoms are in [`doc/qwen-code.md` §6](./doc/qwen-code.md#6-signing-in-on-the-operators-own-machine-then-importing-the-session-issue-299).

Qwen Chat (`--provider qwen-chat`) shares the Qwen **account family** and auth host (`auth.qwen.ai`)
with Qwen Code, but **cookies and localStorage are per-domain**: a capture made at `coder.qwen.ai` is
refused as a Qwen Chat session. Sign in at `chat.qwen.ai` (the operator surface's **Qwen Chat** entry,
or a capture made there) and import that. Signing in needs no restart; adding a provider block or
refreshing the model list does. Details: [`doc/qwen-chat.md`](./doc/qwen-chat.md) §5.

### Hand a capture to a running service (`POST /v1/control/auth/import`)

The same pipeline is available over the operator control surface, for a tool (a Harness plugin, a
script) that already holds a Playwright `storageState` object. **Control token only**, exactly like
the rest of `/v1/control/*`; the API key is refused. The request body is
`{ "provider": "chatgpt-web" | "qwen-code" | "qwen-chat" | "deepseek-web", "storageState": { ... } }` and is capped
at 512 KiB (an oversized body is refused before it is buffered):

```bash
curl -sS -X POST http://127.0.0.1:17841/v1/control/auth/import \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"provider":"qwen-code","storageState":{"cookies":[...],"origins":[...]}}'
```

A verified session answers exactly:

```json
{"ok":true,"provider":"qwen-code","verified":true,"verifiedAt":"2026-10-19T21:00:00.000Z","storedAt":"/data/providers/qwen-code/storage-state.json"}
```

`deepseek-web` is verified by its own measured predicate: the capture must carry the
`chat.deepseek.com` cookies **and** the page's `localStorage` (`userToken` and `deepseek-device-id:chat`;
`hif_leim_cached` is optional), and the import then asks
`GET /api/v0/client/settings?did=…&scope=model` from the capture's own page. Only an answer whose
**nested** `data.biz_code` is `0` authenticates — a success-shaped top level is not enough — so a `200`
that carries `SETTINGS_NOT_FOUND`, a token refusal, a WAF challenge or an unreadable body is a refusal
that writes nothing ([`doc/deepseek-web.md`](./doc/deepseek-web.md) §7). A capture missing the required
storage is refused before any browser starts. Every capture refusal is a 4xx with the existing
control error shape and a stable code:

| code | status | meaning |
| --- | --- | --- |
| `import_empty` | 400 | the capture has no cookies or `localStorage` at all |
| `import_malformed` | 400 | the body is not valid JSON (its text is never quoted) |
| `import_shape_invalid` | 400 | JSON, but not a Playwright storage state |
| `import_foreign_domain` | 400 | the provider's own cookies are absent |
| `import_expired` | 400 | the provider's cookies are all expired |
| `import_predicate_failed` | 400 | the provider's authenticated predicate refused it |
| `import_provider_unknown` | 404 | that provider is not registered for import |
| `import_invalid_request` | 400 | missing `provider`/`storageState` |
| `request_too_large` | 413 | the body exceeds 512 KiB |

A failure to write an already-accepted capture is an operator-side 500 (`import_store_failed`), not a
capture refusal.

Nothing in a response or a log is captured material: no cookie value, name or count. The import
writes the same layout as `auth import` (and, for a verified provider, the same `.verified.json`
marker), and — like the CLI route — it does not refresh the running process's startup-resolved
account facts, so restart the service when the next turn must pick the capture up immediately.

### Is the stored session still working? (`GET /v1/control/auth/health`)

A capture that verified an hour ago can stop working without anything in the service changing: the
provider's own token expires and the page cannot renew it. Until now the only way to find out was to
send a message and wait for an `AUTH_REQUIRED` refusal. This endpoint answers the question **before**
the send. **Control token only**, like the rest of `/v1/control/*`.

```bash
curl -sS http://127.0.0.1:17841/v1/control/auth/health \
  -H "Authorization: Bearer $CONTROL_TOKEN"
```

```json
{
  "ok": true,
  "checkedAt": "2026-10-23T16:40:00.000Z",
  "cache": { "ttlMs": 60000 },
  "providers": [
    {
      "providerId": "qwen-chat",
      "label": "Qwen Chat",
      "state": "expired",
      "capturePresent": true,
      "verifiedAt": "2026-10-22T13:51:35.003Z",
      "checkedAt": "2026-10-23T16:40:00.000Z",
      "code": "import_predicate_failed",
      "reason": "Qwen Chat is not signed in: the live page's token has expired. Sign in at /v1/control/auth/ (choose \"Qwen Chat\")."
    }
  ]
}
```

| `state` | meaning |
| --- | --- |
| `verified` | a capture is stored and the provider's **own** authenticated predicate accepts it now |
| `expired` | a capture is stored and the predicate refused it (or its own validator rejected it); `code`/`reason` say why, and `verifiedAt` is the last time it did verify |
| `absent` | no capture is stored for this provider |
| `unverifiable` | the provider declares no authenticated predicate, so no capture can be proved — never reported as `expired`. Every provider this deployment serves declares one, so no row is in this state today |
| `unknown` | the check could not be completed inside its bound; the session was **not** judged |

Every provider the deployment serves is listed, so a row never disappears. The check runs the import
pipeline's own acceptance rule and predicate — no second probe, and the same `import_*` refusal codes.
It is bounded (90 s per provider, checked one at a time) and its verdict is cached for 60 s, so opening
the sign-in page twice does not launch a browser twice; a successful `POST /v1/control/auth/import`
seeds the cache with the verification it just performed. A provider whose page renews the session
while being checked (Qwen Chat) has that renewal stored through the same single writer, so the check
cannot shorten the capture's life. The answer carries no cookie, token, storage entry or path.

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
| `qwen-code/qwen3-coder-plus` | Qwen Code (second provider), shown once configured or signed in. |
| `qwen-chat/qwen3.7-plus` | Qwen Chat (third provider), shown once configured or signed in. |
| `qwen-chat/qwen3.8-max` | Qwen Chat. |
| `qwen-chat/qwen3.8-omni-flash` | Qwen Chat. |

The second provider's rows are the same shape and provider-qualified once, but they are **not** derived
from ChatGPT's capability state: `qwen-code/<modelId>` appears when `webChat.providers["qwen-code"]`
exists in the configuration or a verified Qwen Code session is on disk, and the model ids are the
deployment's own list (`webChat.providers["qwen-code"].models`, defaulting to the one id the capture
measured, `qwen3-coder-plus`). No endpoint that lists Qwen Code's selectable models was recorded, so
the list is configuration rather than discovery. The route is text-only and reasoning-free; a turn is
served by the Qwen Code provider's own driver, not by the ChatGPT browser adapter
([`doc/qwen-code.md` §7](./doc/qwen-code.md#7-slice-2--the-provider-driver-issue-299)).

Qwen Chat rows are advertised the same way but carry the model's **three modes as reasoning levels**:
`Auto`, `Thinking` and `Fast` in `supported_reasoning_levels`, with the default from the model's
measured abilities. Select one with `reasoning_effort` (or `reasoning: {"effort": …}` on
`/v1/responses`); an unsupported label is a typed `400`, and a model whose abilities hide the
selection offers none. The model list is configuration with a measured seed and a public hint; refresh
the cache with `dsh-chatgpt-web models refresh --provider qwen-chat` and restart to serve it. Full
protocol, assumptions and the per-domain sign-in rule: [`doc/qwen-chat.md`](./doc/qwen-chat.md).

**DeepSeek Web** (`deepseek-web/<model_type>`) is implemented as a fourth provider. Its turn path is
measured against a real signed-in capture: the completion body, the named/unnamed SSE patch stream, the
`THINK`/`RESPONSE` fragments, the `close` terminator, the page-owned SHA3 proof of work (a fresh proof
per completion) and the page's bearer plus `x-client-*` / `x-device-*` headers. **No configuration is
needed to select it:** the model list is a session-only remote setting (no public endpoint, no refresh
command), so the provider seeds the **measured** row — `deepseek-web/default`, labelled "DeepSeek Chat",
with the site's two toggles on — and `/v1/models` publishes it out of the box. The measured account had
`expert` and `vision` disabled server-side, so those are never seeded. A
`webChat.providers["deepseek-web"]` block is optional: it overrides the seeded row or extends the list
for an account that enabled more, and an explicit empty list is the only state that publishes no
DeepSeek route (that deployment answers `deepseek-web/...` with a typed `400` that says exactly that). A
capture is verified by the provider's own predicate (the measured settings call, decided by its
**nested** `data.biz_code`), so a good import writes the verified marker and unblocks a turn; a capture
without the required `localStorage` is refused before any browser starts. An interactive sign-in
controller is still not implemented, so DeepSeek's operator path is a capture plus `auth import`.
Details: [`doc/deepseek-web.md`](./doc/deepseek-web.md) §6–§7.

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
- **Refused with a typed `400`, never silently dropped:** `n > 1`; `logprobs` / `top_logprobs`; a
  malformed or unknown `response_format`; and attached content — `files`, `images`, `audio`, `video`,
  `attachments` and non-text content parts (`image_url`, `input_audio`, files). Attached content is data
  the caller meant the model to see, so it can never be dropped.

`response_format` is a wire format, not content: `{"type":"json_object"}` and
`{"type":"json_schema","json_schema":{"name","strict","schema"}}` are accepted and carried into the
turn as text (a consumer web chat has no native schema enforcement), the reply is returned verbatim,
and the response declares the soft mode with `x-dsh-chatgpt-web-structured-output: soft`.
`{"type":"text"}` and a request without `response_format` are unchanged, and `max_completion_tokens`
is accepted as an alias of `max_tokens`. `finish_reason` is `"length"` only when the provider proves
the output budget was exhausted (`max_output_tokens`); no current web provider enforces one, so a
truncated web answer otherwise still reports `"stop"`.

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
