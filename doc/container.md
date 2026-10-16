# Containerised service — spike notes

**Status:** spike. First version, produced by issue #245 (phase 1 of 6 in the containerised-service
track). It records the facts the rest of the track depends on, the findings that change the plan, and
exactly what could not be executed on the authoring host.

**Not the supported deployment.** Issue #246 owns the production image, Compose stack, healthcheck
and CI image build; issue #247 owns API authorization and a safe bind; issue #249 owns the login
flow. Read [architecture.md](./architecture.md) §32 first.

## 1. What this distribution is

The repository has two entry points over one core:

- `lib/plugin.js` — the DSH Cordis plugin;
- `lib/cli.js serve` — the standalone sidecar HTTP service, deliberately independent of the host-only
  DSH LLM peer (asserted by `scripts/smoke-tarball.mjs`).

This track wraps the **sidecar** in a container. The plugin path is untouched.

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
| Runtime dependencies install from the public registry | Holds: `playwright-core`, `tiktoken`, `turndown`, `turndown-plugin-gfm`, `zod`, `ajv`, `ajv-formats`, `fflate`, `chromium-bidi`, `@modelcontextprotocol/sdk`, `@deepseek-ai/schemastery` all return HTTP 200 from the public registry |
| Both **peer** dependencies are public (bun installs peers) | Holds: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm` HTTP 200 |
| `bun install --production --frozen-lockfile` works with only `package.json` + `bun.lock` and **no credentials** | Holds: clean directory plus isolated `HOME` (no `~/.npmrc`) → 112 packages, exit 0 |
| `--omit=peer` drops the DSH host peers | Holds: 104 packages, with no `@deepseek-ai/cordis` and no `@deepseek-ai/dsh-llm` |
| The sidecar runs on the production closure only | Holds: `node lib/cli.js --help` and `--version` exit 0, and `serve` answers `/healthz` + `/v1/models` (`chatgpt-web/luna`, `chatgpt-web/think`) with no peers installed |
| Every reference to those peers is erased at build time | Holds: the only references are `import type` / `import("…").T` in `plugin.ts`, `llm-adapter.ts` and `conversation-projection.ts` |

```bash
mkdir install && cp package.json bun.lock install/ && cd install
HOME=<empty dir> bun install --production --frozen-lockfile --omit=peer    # 104 packages, exit 0
cp -r <repo>/lib ./lib && node lib/cli.js --help && node lib/cli.js --version
DSH_CHATGPT_WEB_HOME=<prepared volume> node lib/cli.js serve --port 17902 &
curl -fsS http://127.0.0.1:17902/healthz
curl -fsS http://127.0.0.1:17902/v1/models
```

That is why the Dockerfile installs with `--omit=peer` and asserts `node lib/cli.js --help` at build
time: the service image must not carry, and must not need, the DSH host peers (PR #230's isolation
rule), and a future runtime dependency on them now fails the build instead of shipping.

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
   answer, and the reason #247 must not be reduced to "add an API key".

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

## 4. Build and run (spike)

```bash
# from the repository root
docker build -f docker/Dockerfile.spike -t dsh-chatgpt-web:spike .

# The spike image needs a prepared data volume (F2) and host networking (F1).
docker run --rm --init --ipc=host --network host \
  -v "$PWD/.data:/data" -e DSH_CHATGPT_WEB_HOME=/data \
  dsh-chatgpt-web:spike

# probes (from another shell, on the same host network)
curl -fsS http://127.0.0.1:17841/healthz
curl -fsS http://127.0.0.1:17841/v1/models
docker exec <container> dsh-chatgpt-web doctor --json   # or: node lib/cli.js doctor --json
```

`--ipc=host` (or `--shm-size=1g`) is recommended by Playwright for Chromium. `--init` avoids zombie
processes. `--network host` is a spike workaround (F1), not the production answer.

`docker/spike-evidence.sh` does the whole sequence on a container host and prints a transcript to
paste into the PR. It creates the data volume itself and accepts another engine:

```bash
docker/spike-evidence.sh                          # docker, fresh data volume
CONTAINER_ENGINE=podman docker/spike-evidence.sh  # rootless podman
DATA=/srv/dsh-data docker/spike-evidence.sh       # reuse a volume you already prepared
```

Two traps it already avoids: the sidecar needs `--network host` (F1), and the configuration must be
generated from a **file**, never with `bun -e` — `defaultConfig()` refuses an evaluated script
(`Cannot install a service from an evaluated Bun script`).

That script has only been syntax-checked (`bash -n`); no container runtime was available to execute
it, so treat its output as the thing to verify, not as verified evidence.

## 4.1 Prepared data volume — what a container needs

`serve` starts with **only `config.json`** present: `/healthz` and `/v1/models` both answer without a
browser or any login state (captured in §5). A real turn additionally needs the provider session,
which is what phase 5 (#249) delivers.

| Path (under `DSH_CHATGPT_WEB_HOME`) | Needed for | Notes |
| --- | --- | --- |
| `config.json` | everything | validated by `parseConfig()` (`src/config.ts`): `version: 3`, `host: "127.0.0.1"`, `mode`, `browserHost`, `port`, `headed`, `autoApproveToolCalls`, `appName`, `chromeExecutablePath`, `storageStatePath`, `brokerSocketPath`, and a 40+ character `controlToken` |
| `browser/storage-state.json` **and** `browser/storage-state.json.verified.json` | a real turn | `browserLoginStateExists()` requires both; the marker must carry `version: 1`, `authenticated: true` and a `verifiedAt` string |
| `runtime/turn-broker.sock` | `mode: "full"` only | created at runtime; `browser-only` does not use it |

`config.json` can be produced non-interactively with the application's own primitives
(`defaultConfig()` + `saveConfig()` — the same path `setup` uses before its login step), so a
container entrypoint does not have to reimplement the schema. It must be run from a **file**
(`bun /tmp/make-config.ts`), not with `bun -e`: `defaultConfig()` refuses an evaluated script
(`Cannot install a service from an evaluated Bun script`). The generated record also carries a
`runtimeCommand` that points at that fixture; `serve` and `doctor` do not use it in a container (the
managed service is intentionally not used there). Its `controlToken` is a secret: it belongs in the
volume, never in the image or the repository.

`parseConfig()` also hard-forces `host === "127.0.0.1"` (`"The Responses proxy must bind to
127.0.0.1"`), so **F1 cannot be worked around by configuration alone**: a non-loopback bind needs the
code change owned by #247.

## 5. Evidence collected on the authoring host

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
          "type":"server_error","code":"upstream_server_error"},
 "usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}

# server log for that turn — the browser stage is reached and fails there, in 2 ms:
[chatgpt-web] runTurn model=gpt-5.6-luna chatOnly=true
[chatgpt-web] browser turn 20bf0af24f85 stage=browser_page started
[chatgpt-web] browser turn 20bf0af24f85 stage=browser_page failed durationMs=2 name=Error code=unknown
```

So the issue's **"a turn with no login state fails with the documented explicit error, not a hang or a
crash"** is satisfied with a prepared volume, outside a container: a complete native input reaches the
browser stage and fails there with `ChatGPT web login state is missing: …`, reported as a typed
`status: "failed"` response (and the `usage` block is present).

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

Consequences worth carrying into the later phases:

- **`/healthz` and `/v1/models` do not need a session.** A container with a prepared `config.json`
  can be probed (and health-checked) before any login exists — so #246's healthcheck does not depend
  on #249.
- The `chrome` check is exactly the guard the image's `/usr/bin/google-chrome` **symlink** satisfies;
  the `login` check is the boundary phase 5 owns.
- `doctor` reports the provider as *reachable but not authenticated, 2 models, 2 routes*, which is a
  better readiness signal than "the process is up".

## 6. Not verified here (open)

The authoring host has **no container runtime**: `docker`, `podman` and `nerdctl` are absent, there is
no `/var/run/docker.sock`, and `sudo` is blocked by `no-new-privileges`. It also has **no Playwright
browsers installed** (`~/.cache/ms-playwright` does not exist) and no Chrome at
`/usr/bin/google-chrome`. Therefore:

- [ ] `docker build -f docker/Dockerfile.spike .` — **not executed**.
- [ ] container start + `/healthz` + `/v1/models` from **inside** the container — **not executed**
  (both are captured outside a container with a prepared volume, §5).
- [ ] a real Chromium launch — **not executed**. `checkBrowserEngine()` genuinely launches
  (`chromium.launch({ headless: true })` plus a page load); the executable path, the browsers
  directory and the chromium revision are verified, but neither this host nor a container has run it.
- [x] the "no login state" **turn** failure at runtime — **executed outside a container** with a
  prepared volume (§5): a complete native Codex `input` array reaches `stage=browser_page` and fails
  there with `ChatGPT web login state is missing: <home>/browser/storage-state.json`, returned as a
  typed `status: "failed"` response. Still to confirm from **inside** the container.

What a container run must still prove, in one command: `docker/spike-evidence.sh` (§4).

### Requirements to run it

- **A container runtime.** Rootless is enough where unprivileged user namespaces are available (this
  host reports `unprivileged_userns_clone=1` and a large `max_user_namespaces`): `podman` is the
  least invasive (no daemon, no root); Docker Engine with the user in the `docker` group, or rootless
  Docker, also work. The evidence script accepts `CONTAINER_ENGINE=podman|docker`.
- ~2 GB free disk, and egress to `mcr.microsoft.com`, the npm registry and `bun.sh`.
- **No display and no provider login** are needed for this issue's criteria: every probe above runs
  without a session.
