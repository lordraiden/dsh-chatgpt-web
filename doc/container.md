# Containerised service — operations

**Status:** the supported distribution. The container **is** the product: the image, the Compose
stacks, the healthcheck, the authenticated API, the OpenAI-compatible surface and the guided provider
login are implemented, verified and kept green by the container workflow (§7 records the in-container
verification). Issues #245–#250 are merged and closed.

Read [architecture.md](./architecture.md) §32 first.

## 1. What this distribution is

The service is one entry point over one core:

- `lib/cli.js` (`src/cli.ts`) — the CLI (`serve`, `doctor`, `login`, `auth import`) and the HTTP
  service it hosts, deliberately independent of any DeepSeek Harness package (asserted by
  `scripts/smoke-tarball.mjs`).

The container wraps that service, and running the image is the supported way to deploy it.

## 2. Frozen facts (verified 2026-10-16)

| Fact | Value | How it was verified |
| --- | --- | --- |
| Playwright version to match | `playwright-core` **1.63.0** | `node -p "require('playwright-core/package.json').version"`; `bun.lock` |
| Base image tag | `mcr.microsoft.com/playwright:v1.63.0-noble` | registry v2 API: manifest HTTP 200 |
| Image index digest | `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` | `docker-content-digest` response header |
| linux/amd64 manifest | `sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7` | image index |
| Image size | 7 layers, ~911 MB | amd64 manifest layer sizes |
| Browsers location in the image | `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` | image config blob `Env` |
| Image user | unset ⇒ **root** | image config blob `User` |
| Chromium revision expected by playwright-core 1.63.0 | `1243` | `node_modules/playwright-core/browsers.json` |
| Chromium path inside the image | `/ms-playwright/chromium-1243/chrome-linux64/chrome` | computed: revision 1243 under the image's browsers path |
| Chrome path the app assumes by default | `/usr/bin/google-chrome` | `defaultChromeExecutable()`, `src/config.ts` — the image does **not** create it, hence the symlink |
| Chromium sandbox | Playwright pushes `--no-sandbox` unless `chromiumSandbox: true` is requested; the app never requests it | `playwright-core/lib/coreBundle.js` |

Consequence for the image: install production dependencies, and create
`/usr/bin/google-chrome` as a symlink to the **computed** Playwright path (never a hardcoded
revision, which changes with every Playwright release).

### 2.1 Build assumptions verified locally (no container needed)

The image's risky assumptions were exercised on the authoring host in the exact shapes the Dockerfile
uses:

| Assumption | Result |
| --- | --- |
| The base image's Node satisfies `engines.node >= 22.19.0` | Holds: Playwright **v1.63.0**'s own `Dockerfile.noble` sets `NODE_VERSION=24` (ubuntu:noble + NodeSource) |
| Runtime dependencies install from the public registry | Holds: `playwright-core`, `tiktoken`, `turndown`, `turndown-plugin-gfm`, `zod`, `ajv`, `ajv-formats`, `fflate`, `chromium-bidi` and `@modelcontextprotocol/sdk` all return HTTP 200 from the public registry |
| `bun install --production --frozen-lockfile` works with only `package.json` + `bun.lock` and **no credentials** | Holds: clean directory plus isolated `HOME` (no `~/.npmrc`) → exit 0 |
| `--omit=peer` keeps any declared optional peer out of the production install | Holds: the flag remains a guard; the package declares no peer dependencies |
| The sidecar runs on the production closure only | Holds: `node lib/cli.js --help` and `--version` exit 0, and `serve` answers `/healthz` + `/v1/models` (`chatgpt-web/luna`, `chatgpt-web/think`) |

```bash
mkdir install && cp package.json bun.lock install/ && cd install
HOME=<empty dir> bun install --production --frozen-lockfile --omit=peer    # exit 0
cp -r <repo>/lib ./lib && node lib/cli.js --help && node lib/cli.js --version
DSH_CHATGPT_WEB_HOME=<prepared volume> node lib/cli.js serve --port 17902 &
curl -fsS http://127.0.0.1:17902/healthz
curl -fsS http://127.0.0.1:17902/v1/models
```

That is why the Dockerfile installs with `--omit=peer` and asserts `node lib/cli.js --help` at build
time: the service image runs from the CLI bundle alone, a declared optional peer can never enter the
production closure, and a future runtime dependency outside that closure fails the build instead of
shipping.

What this does **not** prove: that the same install survives the image's own base (its glibc, Node and
Bun versions), and that Chromium plus `--ipc=host` work there. Those need the container run (§4).

## 3. Findings that change the plan

### F1 — the sidecar is loopback-only by construction (blocking for exposure)

`src/cli.ts` rejects every host except loopback:

```text
$ dsh-chatgpt-web serve --host 0.0.0.0 --port 17841
dsh-chatgpt-web: --host must be 127.0.0.1; the sidecar is loopback-only      [exit 1]
```

Therefore **`docker run -p 17841:17841 …` does not expose the service**: the port is published to the
container's network interface, while the process listens only on the container's loopback. The
options are:

1. **`--network host`** (used by this spike) — the container shares the host network namespace, so
   `127.0.0.1:17841` is the host's loopback. Simple, but gives up network isolation and risks a port
   clash with a host-side sidecar.
2. A container-side forwarder bound to `0.0.0.0` that proxies to the sidecar's loopback (adds a
   process; keeps the app invariant).
3. **Relax the bind together with the authorization guard (issue #247)** — the correct production
   answer, and the reason #247 must not be reduced to "add an API key". #247 delivered this: the
   `exposed` Compose stack binds `0.0.0.0` with the API key and fails closed without it (§5.2).

### F2 — a fresh data directory has no configuration, and `serve` refuses to start

```text
$ DSH_CHATGPT_WEB_HOME=<empty dir> dsh-chatgpt-web serve --port 17899
dsh-chatgpt-web: Configuration is missing: <empty dir>/config.json. Run dsh-chatgpt-web setup first.
```

`doctor --json` and `browser check` fail the same way on a fresh directory. So the container needs a
**prepared data volume** (or a first-run `setup`).

That first run is not headless-friendly: for `browserHost: managed-chrome`, `setup` calls
`loginToChatGpt()` whenever no browser login state exists (`src/setup.ts`), i.e. it opens a real
Chrome window and waits for an interactive sign-in. **The container's first run is an interactive
step**, which is why issue #249 exists.

### F3 — `setup` also configures the host's Codex integration

On this host the bootstrap refused:

```text
$ dsh-chatgpt-web setup --browser-only --acknowledge-unofficial --chrome <chrome>
dsh-chatgpt-web: Codex already configures model routing (openai_base_url="http://127.0.0.1:17841/v1").
Rerun with --replace-codex-route to replace it reversibly. …                  [exit 1]
```

It was deliberately **not** retried with `--replace-codex-route`: that rewrites the host's Codex
configuration (`src/codex-integration-route.ts`), which a spike must not do. Consequence for the
track: a containerised first run must not mutate host-global configuration, and the entrypoint has to
choose its own profile/home deliberately.

### F4 — the data directory is overridable two ways

- `DSH_CHATGPT_WEB_HOME` (or the legacy `DSH_CHATGPT_FREE_HOME`) — used by this spike;
- the global `--home PATH` CLI option, which sets the same environment variable (`src/cli.ts`).

Default (no override): `~/.dsh/storages/chatgpt-web`. In a container, always override it to a volume.

### F5 — the base image is intended for development/testing

Microsoft's own documentation states the Playwright image is *"intended to be used for testing and
development purposes only. It is not recommended to use this Docker image to visit untrusted
websites"*. Here the only site visited is the provider's — a third party from the image's point of
view. Running as root with the Chromium sandbox disabled (F2 table above) is acceptable for a
personal, single-account bridge; a hardened deployment would need a non-root user plus Playwright's
seccomp profile, which requires exposing a launch option the code does not have today.

## 4. Build and run

```bash
# Build the production image. The build context is ~6 MB (.dockerignore) and the result is ~3.8 GB,
# dominated by the Playwright base image.
docker build -t dsh-chatgpt-web:local .

# Or run the supported stack: it creates its data volume and becomes healthy by itself.
docker compose up -d --wait
curl -fsS http://127.0.0.1:17841/healthz
docker compose down -v
```

On an empty volume the entrypoint writes a default `config.json` (`docker/bootstrap-config.ts`) and
announces it on stderr: a first `compose up` therefore reaches `healthy` without manual steps. That
step runs on `node`, the runtime the service itself uses, so bringing a fresh volume up needs no bun
(issue #267: the bootstrap's import graph is fully specified for Node's ESM loader, which never adds
an extension). Real turns still need a provider session (§4.1, §5.5).

Every CLI subcommand stays reachable through `docker run`, because the entrypoint execs
`node lib/cli.js "$@"`:

```bash
docker run --rm -v dsh-data:/data dsh-chatgpt-web:local doctor --json
docker run --rm -v dsh-data:/data dsh-chatgpt-web:local serve --port 17899
docker run --rm --entrypoint sh dsh-chatgpt-web:local -lc 'ls -l /usr/bin/google-chrome'
```

`--ipc=host` (or `--shm-size=1g`) is recommended by Playwright for Chromium. `--init` avoids zombie
processes. `--network host` is a spike workaround (F1), not the production answer.

`docker/verify-container.sh` runs the whole chain against the production image and prints a
PASS/FAIL transcript. It creates a fresh named volume per run (exercising the entrypoint bootstrap)
and accepts another engine:

```bash
./docker/verify-container.sh                          # docker, fresh named volume
CONTAINER_ENGINE=podman ./docker/verify-container.sh  # rootless podman
DATA=/srv/dsh-data ./docker/verify-container.sh       # bind path (runs as root: see §5.1)
```

Two traps it already avoids: the sidecar needs `--network host` (F1), and the configuration must be
generated from a **file**, never with `bun -e` — `defaultConfig()` refuses an evaluated script
(`Cannot install a service from an evaluated Bun script`).

Its step 4b re-runs the entrypoint on a second empty data home with `bun` removed from `PATH`, so a
regression that makes the first run need bun fails the transcript instead of the operator (issue
#267).

Its full transcript is recorded in §7.

## 4.1 The data volume — what a container needs

The entrypoint creates `config.json` when it is missing, so `/healthz` and `/v1/models` work on a
fresh volume with no manual step. A **real turn** additionally needs the provider session (§5.5).

| Path (under `DSH_CHATGPT_WEB_HOME`) | Needed for | Notes |
| --- | --- | --- |
| `config.json` | everything | validated by `parseConfig()` (`src/config.ts`): `version: 3`, `host: "127.0.0.1"`, `mode`, `browserHost`, `port`, `headed`, `autoApproveToolCalls`, `appName`, `chromeExecutablePath`, `storageStatePath`, `brokerSocketPath`, and a 40+ character `controlToken` |
| `providers/<providerId>/storage-state.json` **and** `…/storage-state.json.verified.json` | a real turn | the provider-scoped session (issue #249). `browserLoginStateExists()` requires both files; the marker must carry `version: 1`, `authenticated: true` and a `verifiedAt` string |
| `browser/storage-state.json` (+ marker) | a real turn, legacy alias | still read when no provider-scoped session exists, so an existing installation keeps working with no migration and no rewritten `config.json`. New sessions are written **only** to the provider layout |
| `runtime/turn-broker.sock` | `mode: "full"` only | created at runtime; `browser-only` does not use it |

`config.json` can be produced non-interactively with the application's own primitives
(`defaultConfig()` + `saveConfig()` — the same path `setup` uses before its login step), so a
container entrypoint does not have to reimplement the schema. It must be run from a **file**, not with
`bun -e`: `defaultConfig()` refuses an evaluated Bun script (`Cannot install a service from an
evaluated Bun script`). The generated record also carries a `runtimeCommand` derived from the process
that wrote it — `[<bun>, <file>]` under bun and `[<node>]` under node, which is what the entrypoint
uses (issue #267); `serve` and `doctor` do not use it in a container (the managed service is
intentionally not used there). Its `controlToken` is a secret: it belongs in the volume, never in the
image or the repository.

`parseConfig()` also hard-forces `host === "127.0.0.1"` (`"The Responses proxy must bind to
127.0.0.1"`), so **F1 cannot be worked around by configuration alone**: a non-loopback bind needs the
code change owned by #247.

## 5. Operations

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f` |
| Health | `curl -fsS http://127.0.0.1:17841/healthz` · `docker inspect --format '{{.State.Health.Status}}' repo-chatgpt-web-1` |
| Diagnostics | `docker compose exec chatgpt-web node lib/cli.js doctor --json` |
| Stop (keep the volume) | `docker compose down` |
| Remove everything | `docker compose down -v` — this **drops the credentials volume** |
| Backup the volume | `docker run --rm -v dsh-chatgpt-web-data:/data -v "$PWD:/backup" alpine tar czf /backup/dsh-data-$(date +%F).tgz -C /data .` |
| Restore | `docker run --rm -v dsh-chatgpt-web-data:/data -v "$PWD:/backup" alpine tar xzf /backup/dsh-data-<date>.tgz -C /data` |
| Upgrade | `git pull && docker compose build --pull && docker compose up -d` — the volume survives; the base tag is pinned, so `--pull` refreshes that tag only |
| Bind-mount variant (data on the host) | `mkdir -p data && docker compose --profile bind up -d chatgpt-web-bind` |
| Interactive sign-in (no display needed) | open `http://127.0.0.1:17841/v1/control/auth/` in a browser and sign in; the running service uses the session on the next turn, no restart (§5.5) |
| Interactive login (CLI `login`, needs a display you supply) | `dsh-chatgpt-web login`, or `docker compose run --rm -e DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix chatgpt-web login` (§5.5) |

Notes:

- The data volume holds **credentials**. Back it up encrypted, never commit it, and treat `down -v` as
  a credential wipe; a restored volume keeps working only while the provider session is valid.
- Resource requirements: ~3.8 GB on disk for the image, and Chromium needs shared memory — `ipc: host`
  (the compose default) or `--shm-size=1g`. Budget roughly 1 GB RAM per active turn.
- Only one of `chatgpt-web` / `chatgpt-web-bind` can run at a time: both use host networking and
  therefore the same loopback port.
- The healthcheck is the image's own (`curl /healthz`, 30 s interval, 20 s start period, 3 retries);
  compose inherits it.
- The Playwright base image is documented by Microsoft as development/testing only and **not
  recommended for visiting untrusted sites** (§3 F5): here the only site visited is the provider's,
  which is a third party from the container's point of view. This is a personal, single-account
  bridge; do not expose it as a public service.

### 5.1 Privileges: three variants

| Variant | How | Notes |
| --- | --- | --- |
| **default (non-root)** | the image's user is `pwuser` (uid/gid 1001) | requires a *named* volume, whose ownership is seeded from the image's `/data`; this is what `docker compose up -d` uses |
| simple root | `user: "0:0"` (the `bind` profile) | needed for a bind mount, which keeps the invoking user's ownership (uid 1000 here) |
| hardened (sandbox on) | `--user pwuser` **+** Playwright's seccomp profile **+** `chromiumSandbox: true` at launch | **deferred**, see below |

The container runs with Chromium's sandbox **off**, because Playwright adds `--no-sandbox` unless
`chromiumSandbox: true` is requested and the application never requests it. Enabling it is deliberately
not part of this slice: it touches the security-sensitive launch path. The exact requirement is
recorded here so it is not lost:

1. a config field (for example `browserSandbox: boolean`) validated in `parseConfig()`;
2. thread it into every launch site — `ensureManagedBrowser()` in
   `src/adapters/chatgpt-web/browser-worker.ts`, plus `checkBrowserEngine()` and `loginToChatGpt()`;
3. a test asserting the flag reaches `chromium.launch({ chromiumSandbox: true })`;
4. the seccomp profile wired into compose (`security_opt: ["seccomp:./docker/seccomp_profile.json"]`).

### 5.2 Exposing the API (authentication and TLS)

The authenticated surface is `/v1/*` **except** `/v1/control/*` and `/admin/*`, which keep the
operator's control token. `/healthz` is deliberately open: Docker's healthcheck and any load balancer
need it, and it reports liveness metadata only (no key, no session material).

```bash
export DSH_CHATGPT_WEB_API_KEY="$(openssl rand -base64 32)"   # >= 16 characters
docker compose -f docker-compose.exposed.yml up -d --wait      # listens on 0.0.0.0 inside, publishes 127.0.0.1:17841
curl -fsS -H "authorization: Bearer $DSH_CHATGPT_WEB_API_KEY" http://127.0.0.1:17841/v1/models
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17841/v1/models     # 401 without it
```

The exposed variant is a **separate Compose project** (`docker-compose.exposed.yml`, project
`dsh-chatgpt-api`) rather than a profile of the default file: Compose cannot run both at once — they
end up on the same host port — and a separate project makes that a visible port error instead of a
silent race. The data volume is shared by name, so one sign-in serves either variant.

Rules this deployment enforces:

1. **Fail closed.** A non-loopback bind (`--host 0.0.0.0`, or `host` in `config.json`) **refuses to
   start** unless a key is configured, and a key shorter than 16 characters is refused too. The bind is
   therefore never exposed by accident: `parseConfig()` validates the host's shape, and the startup
   check decides whether that host may be served.
2. **The key is a secret, not configuration.** It comes from `DSH_CHATGPT_WEB_API_KEY` or
   `<data dir>/api-key`, never from `config.json`, and it is never logged, returned by `/healthz` or
   written into the conversation store. `x-api-key: <key>` is accepted as well as
   `Authorization: Bearer <key>`.
3. **Separate authorities.** The API key does not open `/v1/control/*`/`/admin/*`, and the control
   token does not open `/v1/*`; both are constant-time comparisons.
4. **Reach it from elsewhere only through a TLS-terminating reverse proxy**, never by publishing
   `0.0.0.0:17841`:

   ```caddyfile
   api.example.internal {
     reverse_proxy 127.0.0.1:17841 {
       header_up Authorization "Bearer {$DSH_CHATGPT_WEB_API_KEY}"
     }
   }
   ```
5. **Bounds.** `DSH_CHATGPT_WEB_MAX_REQUEST_BYTES` caps the request body (default 64 MiB encoded, the
   decoded limit is twice it) and answers a typed `413 request_too_large`;
   `DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS` (default `0` = unlimited, which keeps the DSH/Codex consumer
   unchanged) answers a typed `429 rate_limit_exceeded`. One active turn per provider conversation
   remains a typed `409 retained_surface_busy` (architecture §15.1).
6. The caveats in §5 still apply: this is a personal, single-account bridge — not a public multi-tenant
   service — and the provider's terms of service are yours to honour.

### 5.3 Transmitting only messages (issue #253)

The API transmits the conversation's messages and nothing else. What that means in practice, and what
it cannot mean:

| | |
| --- | --- |
| **Client sends a stable session identity** (OpenAI's `user` field, or `session_id`) | only the **current user message** is transmitted; the provider conversation is the history, so context injected in earlier turns cannot cross |
| **No identity** | the request is treated as **stateless**: the client's `user`/`assistant` messages are transmitted and every non-conversational role (`system`, `developer`, `tool`, unknown) is dropped |
| **Guaranteed** | a harness cannot smuggle its own instructions or environment block into the turn as a separate message, and with an identity it cannot smuggle earlier turns either |
| **Not guaranteed** | text the harness writes *inside* the current user message. Distinguishing that structurally is impossible — provenance is not in the OpenAI protocol — and content heuristics are per-harness and per-version, so they are not the mechanism. This is a documented limit, asserted by a test rather than implied |

The rule lives in exactly one owner (`src/web-chat/host/api-projection.ts`). The text-level sanitizer
(`src/conversation-sanitizer.ts`) is **not** reused or duplicated: it strips host-injected transport
text from a single piece of text but has no notion of message provenance, and a generic client sends no
`source.kind`, so it cannot decide which messages are the conversation here.

### 5.4 OpenAI-compatible chat (`POST /v1/chat/completions`)

Any OpenAI client can point at `http://<host>:17841/v1`:

```bash
curl -fsS http://127.0.0.1:17841/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","messages":[{"role":"user","content":"hola"}]}'

curl -fsSN http://127.0.0.1:17841/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","stream":true,"messages":[{"role":"user","content":"hola"}]}'
```

- `GET /v1/models` answers in **both** shapes: `models[]` (the Codex/DSH catalogue, unchanged) and an
  additive `data[]` (`{id, object:"model", owned_by}`) for OpenAI clients.
- Model ids are the catalogue slugs (`chatgpt-web/luna`, `chatgpt-web/think`); an unknown id is a typed
  400 that names the accepted ones.
- Streaming returns `chat.completion.chunk` frames with `delta.content`, a terminal `finish_reason` and
  then `data: [DONE]`.
- `usage` is an **estimate** produced locally (tiktoken), not consumer-web accounting. A turn the
  provider could not account for does not get a fabricated `0`: the batch body **omits** the field, and
  the streaming `response.completed` / `response.incomplete` / `response.failed` envelope carries
  `"usage": null`. Absent and `null` both mean "not reported"; when the field is present its numbers are
  the estimate. It is present because clients read it, not because it is authoritative.
- Only messages are transmitted — see §5.3. Send a stable `user` (or `session_id`) to get the strict
  rule; without one the request is stateless.
- **Capability declarations are discarded, not refused.** `tools`, `tool_choice`, `mcp` and the legacy
  `functions`/`function_call` are accepted, **never executed and never forwarded**: this bridge is a text
  chat over the provider's web product, so there is no execution path and no return channel to your
  harness. A tool-sending agent gets plain chat and no tool calls. Nothing is silent about it: any
  response that dropped something carries `x-dsh-chatgpt-web-ignored-features` (canonical names, e.g.
  `tools,toolChoice`; JSON and SSE alike) and the service writes one log line per request.
- **Content is still refused with a typed 400, never silently dropped:** `files`, `images`, `audio`,
  `video`, `attachments`, non-text content parts (`image_url`, `input_audio`, `input_file`), `n > 1`,
  `logprobs`/`top_logprobs`, and `response_format` other than plain text. Attached content is data the
  caller meant the model to see, so it can never be dropped — that distinction is what stops "drop
  capability declarations" from sliding into "drop attachments".
- The capability/content split is the **common layer's own** vocabulary
  (`WEB_CHAT_CAPABILITY_FEATURES` / `WEB_CHAT_CONTENT_FEATURES`, `src/web-chat/core/exchange.ts`), so the
  API keeps no second list.
- Not offered: embeddings, audio, images, batch — the surface stays text-only.

### 5.5 Provider login (issue #249)

The runtime needs a **verified** browser session: `storage-state.json` plus its `.verified.json` marker,
in `providers/<providerId>/` inside the data volume. Cookies alone are never enough, and the marker is
what makes the difference between "a file exists" and "this session was proven against the provider".

**Signing in from the service's own page (the primary path)**

The running service serves the sign-in page itself at `GET /v1/control/auth/`: no second container and
no display needed.

```text
http://127.0.0.1:17841/v1/control/auth/
```

Open it in any browser — a phone included, as long as it can reach the service (§5.2 for exposure; the
default stack is loopback-only). It asks for the **control token** (the `controlToken` in the volume's
`config.json`) once, keeps it in that tab's `sessionStorage`, and shows the provider's browser live. The
page is one self-contained document from the image — no CDN, no external asset — so it loads without
reaching anything but the service itself.

Clicking the provider's screen relays the click and routes your **keyboard** to the remote browser; the
indicator under the screen always says where your keys go, and `Escape` (or clicking any field on the
page) hands the keyboard back. The *Send text* field is the paste/long-text fallback and the only way to
type from a phone, whose on-screen keyboard cannot drive the remote browser.

The page is the client of this control surface, and it is **control token only**, exactly like the
rest of `/v1/control/*`: the API key does not open it, and the control token still does not open
`/v1/*`.

| Route | Purpose |
| --- | --- |
| `GET /v1/control/auth/` | the page itself; served anonymously by design (a navigation cannot carry a header) |
| `GET /v1/control/auth/providers` | the providers offering interactive sign-in |
| `POST /v1/control/auth/sessions` | open one: `{"providerId":"chatgpt-web"}` (409 when that provider is already signing in) |
| `GET /v1/control/auth/sessions/<id>` | the session view: state, TTL, viewport — never a cookie, a storage state or a page URL |
| `GET /v1/control/auth/sessions/<id>/stream` | SSE frame/state relay (~2.5 fps, plus an immediate frame after every input) |
| `POST /v1/control/auth/sessions/<id>/input` | one `click` / `type` / `key` / `scroll` / `navigate` intent |
| `DELETE /v1/control/auth/sessions/<id>` | cancel, idempotently; it also acknowledges a capture |

The ChatGPT controller launches a **headless** Chromium (`--headless=new`) on a temporary profile,
detects the authenticated surface with the same checks `login` already uses, and writes the session
through the single session owner, verifying it *first* — into `providers/chatgpt-web/`, the layout
above.

**Qwen Code** (`qwen-code`, issue #299 slice 1) is registered on the same page, and its controller
launches the same headless shape on its own temporary profile. It decides completion **structurally**
with an authenticated API call (`GET /coder/api/v2/task/list` must answer `success:true`; an anonymous
caller gets HTTP 200 with `success:false`, so the status code cannot decide it) and captures into
`providers/qwen-code/` with the same verified marker. Headless was measured against the live service on
2026-10-19 and is **not** rejected — the sign-in form renders and is operable through the relayed page —
so no user-agent override or other workaround is applied; see [`qwen-code.md`](./qwen-code.md). This
provider currently serves **sign-in only**: it has no driver or turn route yet (slice 2).

**Nothing is restarted after a successful capture.** The running service re-derives the account
identity and the resolved credentials path from the sign-in's own completion, so the next turn uses the
new session. Before that fix the process kept serving the picture it resolved at startup, which is why
this section used to say `docker compose restart chatgpt-web`.

`auth import` is the exception: it runs in its own short-lived process, so its write is not the running
service's to observe — restart after adopting a capture that way.

**Adopting a capture from anywhere (`auth import`) — scripted / offline**

Use this route when the page cannot be used: an air-gapped or headless-only host, or provisioning that
must be automated.

```bash
# on a machine where you can sign in (or from a browser profile you already trust):
# the capture is a Playwright storageState JSON, or a directory containing storage-state.json
docker compose exec chatgpt-web node lib/cli.js auth import --provider chatgpt-web --from /capture
# or against a local install
dsh-chatgpt-web auth import --provider chatgpt-web --from ~/Downloads/storage-state.json
```

It is **fail-closed by construction**: the capture is verified against the provider's login surface
*first*, and both files are written atomically *afterwards* by the single session owner. A capture that
cannot be verified — malformed, expired, or unverifiable without a browser — exits non-zero and writes
**nothing**, so an unusable session can never masquerade as a working one. Cookie values are never
printed. Unknown providers are refused (only `chatgpt-web` has a credential layout today; #250 owns the
rest).

**Fallback: `authBrowserMode: "display"` (the operator supplies a display)**

`authBrowserMode` in `config.json` is optional and defaults to `headless`. `headless` is the supported
path on a headless host — it is what the remote sign-in page was verified against a real account with —
and it needs no display. Set it to `"display"` only when a flow rejects headless: it makes the sign-in
page launch a real window instead of `--headless=new`, and it needs a display **you supply** — an X
server/socket the service can reach, or your own headed environment. The container starts no display
server for you and ships no VNC server or noVNC web root, and the setting changes nothing about the
managed turn browser.

> **Retired (issue #276 slice 3b).** The former noVNC sign-in image (`Dockerfile.login`) and its `login`
> Compose profile are gone. They existed only as a fallback until the service's own remote sign-in was
> confirmed end to end against a real account, which it now is (`/v1/control/auth/` → session stored in
> `providers/chatgpt-web/` → `POST /v1/chat/completions` streaming `finish_reason: "stop"`). On a host
> with no display, use the page above; do not build or run a sign-in image.

The CLI `login` path is unchanged and still needs a real display, so run it on a host that has one
(`dsh-chatgpt-web login`), or hand the service container your own display — never one it ships:

```bash
docker compose run --rm -e DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix chatgpt-web login
```

> A display you supply for `authBrowserMode: "display"` (or for the CLI `login`) grants control of an
> authenticated browser session. Keep an X server exposed for it on the host's **loopback only**; never
> expose it on `0.0.0.0`.

**Session lifecycle**

| | |
| --- | --- |
| Expiry | `doctor --json` reports `login: error — ChatGPT login state is missing or unverified`, with the resolved path. Repeat the sign-in or `auth import`; nothing else needs to change |
| Anti-bot / verification challenge | The provider may interrupt an automated session. Complete the challenge in the interactive sign-in path; a challenge does not corrupt the volume. When the page's headless flow is rejected, set `authBrowserMode: "display"` and supply a display yourself — the container provides none (§5.5) |
| Captured, but turns still fail | The running service picks an interactive sign-in up on the next turn, so a restart is not the fix. Read the capture's `detail` (an account identity the sign-in could not read leaves every turn failing closed), then re-run `doctor`; `auth import` is the route that still needs `docker compose restart chatgpt-web` |
| Click outside the frame | A click outside the viewport the relay reports is refused, not clamped. It currently is refused with HTTP 400 `UNSUPPORTED_OPTION` — a known blemish |
| Backup | The volume holds credentials: `docker run --rm -v dsh-chatgpt-web-data:/data -v "$PWD:/backup" alpine tar czf /backup/dsh-data-$(date +%F).tgz -C /data .` — store it encrypted |
| Restore | Untar it back into the volume; a restored session keeps working only while the provider still accepts it |
| Never | commit the volume, paste a capture into an issue, or expect one provider's directory to satisfy another's check (the resolver keys on the provider id) |

The caveats in §5 still apply: this is a personal, single-account bridge and the provider's terms of
service are yours to honour.

## 6. Evidence collected on the authoring host

Local paths are sanitised. The sidecar was exercised with Node 24.21.0 from the checked-in `lib/`.

```text
$ dsh-chatgpt-web serve --host 0.0.0.0 --port 17841
dsh-chatgpt-web: --host must be 127.0.0.1; the sidecar is loopback-only                  [exit 1]

$ DSH_CHATGPT_WEB_HOME=<empty> node lib/cli.js serve --port 17899
dsh-chatgpt-web: Configuration is missing: <empty>/config.json. Run dsh-chatgpt-web setup first.

$ DSH_CHATGPT_WEB_HOME=<empty> node lib/cli.js doctor --json
{ "ok": false, "checks": [ { "id": "config", "status": "error", "message": "Configuration is invalid",
  "detail": "Configuration is missing: <empty>/config.json. Run dsh-chatgpt-web setup first." } ] }

$ node -p "require('playwright-core/package.json').version"
1.63.0
$ node -p "require('playwright-core').chromium.executablePath()"
<home>/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
$ ls ~/.cache/ms-playwright
ls: cannot access '<home>/.cache/ms-playwright': No such file or directory   # no browsers here

$ curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json' \
    https://mcr.microsoft.com/v2/playwright/manifests/v1.63.0-noble
HTTP/2 200
docker-content-digest: sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
# index: linux/amd64 sha256:bc6ab0d6…, linux/arm64 sha256:a0f44989…
# config blob sha256:2c1f4e0f… (6711 bytes): Env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright, no User
```

### With a prepared volume (config.json only — no login, no browser)

```text
$ DSH_CHATGPT_WEB_HOME=<home> SPIKE_PORT=17899 bun run <fixture using defaultConfig/saveConfig>
{ "wrote": "<home>/config.json", "mode": "browser-only", "browserHost": "managed-chrome",
  "port": 17899, "storageStatePath": "<home>/browser/storage-state.json", "controlTokenLength": 43 }

$ DSH_CHATGPT_WEB_HOME=<home> node lib/cli.js serve --port 17899
$ curl -fsS http://127.0.0.1:17899/healthz
{"status":"ok","service":"dsh-chatgpt-web","version":"1.0.28","mode":"browser-only","pid":6,
 "port":17899,"uptime":0.531,"accepting_turns":true,"successful_model_catalog_requests":0,
 "last_successful_model_catalog_request_at":null,"active_http_turns":0,"active_browser_turns":0}

$ curl -fsS http://127.0.0.1:17899/v1/models
{"object":"list","models":[{"slug":"chatgpt-web/luna","display_name":"ChatGPT Web — Luna",…},
 {"slug":"chatgpt-web/think",…}]}          # catalogue ids: chatgpt-web/luna, chatgpt-web/think

$ curl -sS -H 'content-type: application/json' \
    -d '{"model":"chatgpt-web/luna","input":"ping"}' http://127.0.0.1:17899/v1/responses
{"id":"resp_…","object":"response","status":"failed","model":"chatgpt-web/luna","output":[],
 "error":{"message":"ChatGPT web requires the complete native Codex input for round replay",
          "type":"server_error","code":"upstream_server_error"}, …}
# Fail-closed and typed, no hang: a wire ingress with a partial body never reaches the browser
# (`src/adapters/chatgpt-web/turn-execution.ts` requires the complete native Codex `input` array).

$ curl -sS -H 'content-type: application/json' -d '{
    "model":"chatgpt-web/luna","instructions":"You are a helpful assistant.",
    "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}]}' \
    http://127.0.0.1:17899/v1/responses
{"id":"resp_…","object":"response","status":"failed","model":"chatgpt-web/luna","output":[],
 "error":{"message":"ChatGPT web login state is missing: <home>/browser/storage-state.json",
          "type":"server_error","code":"upstream_server_error"}}
# The `"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}` block this capture originally
# showed was a fabrication on a turn the adapter never accounted for. Unknown usage is now omitted
# from the batch body (and `null` on the stream envelope) — see §5.4.

# server log for that turn — the browser stage is reached and fails there, in 2 ms:
[chatgpt-web] runTurn model=gpt-5.6-luna chatOnly=true
[chatgpt-web] browser turn 20bf0af24f85 stage=browser_page started
[chatgpt-web] browser turn 20bf0af24f85 stage=browser_page failed durationMs=2 name=Error code=unknown
```

So the issue's **"a turn with no login state fails with the documented explicit error, not a hang or a
crash"** is satisfied with a prepared volume, outside a container: a complete native input reaches the
browser stage and fails there with `ChatGPT web login state is missing: …`, reported as a typed
`status: "failed"` response. That turn produced no measurable consumption, so the `usage` block is
omitted rather than reported as zeros (§5.4).

$ DSH_CHATGPT_WEB_HOME=<home> node lib/cli.js doctor --json
{ "ok": false, "mode": "browser-only", "checks": [
    { "id": "config", "status": "ok",
      "message": "Configuration is valid (<home>/config.json)" },
    { "id": "chrome", "status": "error",
      "message": "Chrome executable is missing: /usr/bin/google-chrome" },
    { "id": "login", "status": "error",
      "message": "ChatGPT login state is missing or unverified; run `dsh-chatgpt-web login`" },
    { "id": "webchat-chatgpt-web", "status": "warning",
      "message": "WebChat provider \"chatgpt-web\" is reachable but not authenticated",
      "detail": "not authenticated; 2 models; 2 route(s) available" },
    { "id": "proxy", "status": "error", "message": "Responses proxy is not reachable" } ] }
```

Consequences worth carrying forward:

- **`/healthz` and `/v1/models` do not need a session.** A container with a prepared `config.json`
  can be probed (and health-checked) before any login exists — so #246's healthcheck does not depend
  on #249.
- The `chrome` check is exactly the guard the image's `/usr/bin/google-chrome` **symlink** satisfies;
  the `login` check is the credential boundary (§5.5).
- `doctor` reports the provider as *reachable but not authenticated, 2 models, 2 routes*, which is a
  better readiness signal than "the process is up". (The message above is that run's own capture; it now
  also names the cause and the fix — no sign-in has been recorded, record one at the operator sign-in
  surface `/v1/control/auth/`.)

### Chromium launch with no display (the container's situation)

The image supplies the browser this host lacks, so the same `playwright-core` was pointed at a
browser installed **into the workspace** (no root, no system change) to exercise the launch itself.

```text
$ PLAYWRIGHT_BROWSERS_PATH=<ws>/.tmp/ms-playwright npm_config_cache=<ws>/.npm-cache \
    npx --yes playwright@1.63.0 install chromium
# -> chromium-1243 (the revision playwright-core 1.63.0 expects), i.e. the pinning rule, empirically
$ PLAYWRIGHT_BROWSERS_PATH=<ws>/.tmp/ms-playwright \
    node -p "require('playwright-core').chromium.executablePath()"
<ws>/.tmp/ms-playwright/chromium-1243/chrome-linux64/chrome

$ env -u DISPLAY DSH_CHATGPT_WEB_HOME=<volume> node lib/cli.js browser check
Playwright can launch the configured Chrome executable.

$ DSH_CHATGPT_WEB_HOME=<volume> node lib/cli.js doctor --json      # chrome check now
{ "id": "chrome", "status": "ok",
  "message": "Chrome executable found: <ws>/.tmp/ms-playwright/chromium-1243/chrome-linux64/chrome" }

# The worker's *exact* launch mode — headless:false + an explicit --headless=new plus the Windows UA
# (src/adapters/chatgpt-web/browser-worker.ts), run with no display and no Xvfb:
$ env -u DISPLAY CHROME_PATH=<ws>/…/chromium-1243/chrome-linux64/chrome node docker/verify-headless-launch.mjs
DISPLAY: (unset)
version: 153.0.8010.12
readyState: complete
userAgent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36
worker-mode launch: OK
```

Consequences: the app's engine check and the worker's launch mode both work headlessly **without a
display and without Xvfb**, so the image needs neither — and the chromium revision the pinning rule
predicts is confirmed by installing it. What is still unproven is the launch inside the image's own
base (its glibc and Bun/Node), which is what the container run covers.

## 7. Verification status

Every acceptance criterion of issue #245 was executed **inside the container** on Ubuntu 26.04 with
Docker Engine 29.1.3 (`Dockerfile.spike`, base image digest `sha256:eff16c30…`):

| Criterion | Result (in-container) |
| --- | --- |
| `docker build` succeeds | ✅ `Successfully tagged dsh-chatgpt-web:spike` (16 steps; base image pulled and digest matched) |
| the image installs without the DSH host peers | ✅ `bun install --production --frozen-lockfile --omit=peer` → 104 packages, and the build-time assertion `node lib/cli.js --help/--version` → `1.0.28` |
| the symlink points where the pinning rule predicts | ✅ `/usr/bin/google-chrome -> /ms-playwright/chromium-1243/chrome-linux64/chrome` |
| the container starts and `/healthz` answers | ✅ `{"status":"ok","service":"dsh-chatgpt-web","version":"1.0.28","mode":"browser-only","accepting_turns":true,…}` |
| `/v1/models` answers with the Codex-shaped catalogue | ✅ `{"object":"list","models":[…]}` — `chatgpt-web/luna`, `chatgpt-web/think` |
| a turn with no login state fails explicitly, no hang | ✅ `status:"failed"`, `error.message` = `ChatGPT web login state is missing: /data/browser/storage-state.json` |
| Chromium actually launches | ✅ `node lib/cli.js browser check` **inside the container** (no display, no Xvfb): *"Playwright can launch the configured Chrome executable."* |
| `doctor --json` on a prepared volume | ✅ `config: ok`, `chrome: ok` (`/usr/bin/google-chrome`), `login: error`, provider reachable/not authenticated (2 models), `proxy: ok` on 127.0.0.1 |
| no production-code change was needed | ✅ only the symlink; `src/` untouched |

Reproduce it with `docker/verify-container.sh` (§4); it printed `all checks passed` (exit 0). On this
host the engine had to be reached through the `docker` group (`sg docker -c …`) because the harness
process predated `usermod -aG docker`.

Compose was verified separately and is what CI runs: `docker compose up -d --wait` on a fresh volume
returned success with the container `(healthy)`, `/healthz` and `/v1/models` answered, the entrypoint
announced `wrote default configuration: /data/config.json`, and `docker compose down -v` removed both
the container and the volume. Build context: ~6 MB. Image: 3.8 GB.

### Deliberately outside this spike

- **A real authenticated turn.** The spike proves the login boundary fails explicitly; making a turn
  *succeed* needs a provider session, which is phase 5 (#249).
- **The supported image, Compose stack, healthcheck and CI build** — phase 2 (#246). `docker/` here is
  explicitly a throwaway spike.
- **Exposing the service.** The sidecar is loopback-only (§3 F1) and `parseConfig()` enforces that, so
  a published port does not reach it; relaxing the bind belongs with the authorization work in #247.

### Environment notes

The authoring host needed Docker installed (`docker.io` 29.1.3 + `usermod -aG docker`), and a Playwright
chromium was installed **into the workspace** for the pre-container launch probes, so
`~/.cache/ms-playwright` does not exist and `/usr/bin/google-chrome` is still absent on the host.
~2 GB free disk and egress to `mcr.microsoft.com`, the npm registry and `bun.sh` are required.
