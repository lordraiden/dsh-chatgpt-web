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

`docker/spike-evidence.sh` runs the whole sequence and prints a transcript to paste into the PR:

```bash
docker/spike-evidence.sh                       # fail-closed path (empty data dir)
DATA=/srv/dsh-data docker/spike-evidence.sh    # full path against a prepared data volume
```

That script has only been syntax-checked (`bash -n`); no container runtime was available to execute
it, so treat its output as the thing to verify, not as verified evidence.

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

## 6. Not verified here (open)

The authoring host has **no container runtime**: `docker`, `podman` and `nerdctl` are absent, there
is no `/var/run/docker.sock`, and `sudo` is blocked by `no-new-privileges`. It also has **no
Playwright browsers installed** (`~/.cache/ms-playwright` does not exist). Therefore:

- [ ] `docker build -f docker/Dockerfile.spike .` — **not executed**.
- [ ] container start + `/healthz` + `/v1/models` from inside the container — **not executed**.
  (Both endpoints and their response shape are verified from `src/server.ts` only.)
- [ ] a real Chromium launch inside the container — **not executed**. The computed path, the browsers
  path and the revision are verified; the launch itself is not.
- [ ] the "no login state" turn failure at runtime — **not executed**. It is verified in code
  (`ensureManagedBrowser` in `src/adapters/chatgpt-web/browser-worker.ts` throws
  `ChatGPT web login state is missing: …`), but reaching it needs a prepared config.

The next person with a Docker-capable host should run section 4 and paste the output into the PR for
issue #245; only then can the issue's acceptance criteria be closed. Issue #246 should not start
until then.
