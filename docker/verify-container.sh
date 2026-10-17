#!/usr/bin/env bash
# docker/verify-container.sh — end-to-end verification of the containerised service.
#
# Originally the phase-1 (#245) evidence collector; it now builds and drives the PRODUCTION image
# (`Dockerfile`) and re-checks the whole chain: build, the chromium the app will use, a prepared
# volume, /healthz, /v1/models, the no-login turn boundary and the in-container browser launch.
# `docker compose up -d --wait` (docker-compose.yml) is the supported deployment path; this script is
# the deeper, operator-facing check.
#
# NOT EXECUTED on the authoring host (no container runtime there): only `bash -n` was run.
# Run it on the Docker host and paste the full output into issue #245 / PR #252.
#
# Usage:
#   docker/spike-evidence.sh                                  # auto-detect docker, then podman
#   CONTAINER_ENGINE=podman docker/spike-evidence.sh          # force rootless podman
#   DATA=/srv/dsh-data ./docker/verify-container.sh            # bind path (runs as root: see below)
#   IMAGE=dsh-chatgpt-web:local PORT=17841 ./docker/verify-container.sh
#
# Loopback note: the sidecar rejects every non-loopback --host (doc/container.md finding F1), so the
# container runs with --network host and no published port.
set -uo pipefail

# CONTAINER_ENGINE wins (may be "podman" or "sudo docker"); otherwise docker, then podman. Rootless
# podman needs no daemon, no group change and no re-login.
if [ -n "${CONTAINER_ENGINE:-}" ]; then
  read -r -a ENGINE <<< "$CONTAINER_ENGINE"
elif command -v docker >/dev/null 2>&1; then
  ENGINE=(docker)
elif command -v podman >/dev/null 2>&1; then
  ENGINE=(podman)
else
  cat <<'HINT'
No container engine found on this host.

Recommended (rootless: no daemon, no group change, no re-login):
    sudo apt update && sudo apt install -y podman uidmap
    CONTAINER_ENGINE=podman docker/spike-evidence.sh

Alternative (Docker Engine; needs the group change and a re-login):
    sudo apt install -y docker.io && sudo usermod -aG docker "$USER"
    docker/spike-evidence.sh

Installed somewhere else? Point the script at it:
    CONTAINER_ENGINE="/path/to/docker" docker/spike-evidence.sh
HINT
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-dsh-chatgpt-web:local}"
PORT="${PORT:-17841}"
DATA="${DATA:-dsh-verify-$$}"
WORKDIR="$(mktemp -d)"
CONTAINER="dsh-spike-$$"
FAILURES=0

say() { printf '\n===== %s =====\n' "$*"; }
check() { # check <label> <expected-substring> <actual>
  if printf '%s' "$3" | grep -q -- "$2"; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected to contain: %s\n' "$1" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}
cleanup() {
  "${ENGINE[@]}" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ "${CREATED_VOLUME:-0}" = "1" ]; then
    "${ENGINE[@]}" volume rm -f "$DATA" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

say "0. engine"
echo "using: ${ENGINE[*]}"
"${ENGINE[@]}" version --format '{{.Server.Version}}' 2>&1 || {
  if command -v "${ENGINE[0]}" >/dev/null 2>&1; then
    echo "engine '${ENGINE[*]}' is present but not usable (is its daemon running?)"
  else
    echo "engine '${ENGINE[*]}' was not found on PATH"
  fi
  exit 1
}

say "1. build"
"${ENGINE[@]}" build -f "$REPO_ROOT/Dockerfile" -t "$IMAGE" "$REPO_ROOT" 2>&1 || {
  echo "build failed"; exit 1; }

say "2. image facts: the chromium the app will use, and the symlink that points at it"
"${ENGINE[@]}" run --rm --entrypoint sh "$IMAGE" -lc '
  node -p "require(\"playwright-core\").chromium.executablePath()"
  ls -l /usr/bin/google-chrome
  ls -d /ms-playwright/*chromium* 2>/dev/null' 2>&1

if [ -z "$DATA" ]; then
  say "3. data volume: $DATA"
else
  say "3. data volume: $DATA"
fi
# A named volume is seeded from the image's /data, so the default non-root user (pwuser, uid 1001) can
# write it. A bind path keeps the invoking user's ownership (uid 1000 here), which pwuser cannot write,
# so that case runs the container as root instead (the bind/root variant in docker-compose.yml).
USER_ARG=()
case "$DATA" in
  /*|./*|../*) USER_ARG=(--user 0:0); mkdir -p "$DATA" ;;
  *) "${ENGINE[@]}" volume create "$DATA" >/dev/null; CREATED_VOLUME=1 ;;
esac

# The image's entrypoint bootstraps an empty data volume itself (docker/bootstrap-config.ts),
# so a first `docker compose up` can become healthy. Step 4 asserts that it happened.

say "4. start the sidecar (loopback inside the container, host networking: finding F1)"
# The command is overridden explicitly so $PORT is the port that is actually served (the image's CMD
# pins 17841; overriding also avoids a clash with a host-side sidecar already on that port).
"${ENGINE[@]}" run -d --name "$CONTAINER" --init --ipc=host --network host "${USER_ARG[@]}" \
  -v "$DATA:/data" -e DSH_CHATGPT_WEB_HOME=/data "$IMAGE" \
  serve --port "$PORT" >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
"${ENGINE[@]}" logs "$CONTAINER" 2>&1 | tail -3

# That bootstrap is a production behaviour, not a test fixture: it is what makes a clean-volume
# `docker compose up -d` reach a healthy state without manual steps.
BOOTSTRAP="$("${ENGINE[@]}" logs "$CONTAINER" 2>&1 | head -4)"
check "the entrypoint bootstrapped the configuration" "wrote default configuration" "$BOOTSTRAP"

# Issue #267: that bootstrap must not need bun either. Re-run the entrypoint itself on a second empty
# data home with bun removed from PATH — only `node`, the runtime the service uses, may be required to
# bring a volume up. Before the fix this aborts with `bun: not found` (exit 127).
say "4b. an empty data home bootstraps with bun removed from PATH"
NO_BUN="$("${ENGINE[@]}" run --rm --entrypoint sh "$IMAGE" -c \
  'rm -rf /tmp/dsh-267-first-run; PATH=/usr/bin:/bin DSH_CHATGPT_WEB_HOME=/tmp/dsh-267-first-run sh /usr/local/bin/dsh-entrypoint --version' 2>&1; echo "exit=$?")"
printf '%s\n' "$NO_BUN"
check "the bootstrap runs without bun" "wrote default configuration" "$NO_BUN"
check "the whole entrypoint then exits 0" "exit=0" "$NO_BUN"

# The production image is non-root by default; the bind/root variant is the exception.
RUNNING_USER="$("${ENGINE[@]}" exec "$CONTAINER" id 2>&1)"
if [ "${#USER_ARG[@]}" -eq 0 ]; then
  check "the service runs non-root (pwuser)" "uid=1001(pwuser)" "$RUNNING_USER"
else
  printf 'INFO  bind path: running as root by design — %s\n' "$RUNNING_USER"
fi

say "5. /healthz"
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>&1)"
printf '%s\n' "$HEALTH"
check "healthz reports ok"        '"status":"ok"'           "$HEALTH"
check "healthz names the service" 'dsh-chatgpt-web'         "$HEALTH"
check "healthz reports accepting" '"accepting_turns":true'  "$HEALTH"

say "6. /v1/models (Codex-shaped catalogue)"
MODELS="$(curl -fsS "http://127.0.0.1:$PORT/v1/models" 2>&1)"
printf '%s\n' "$MODELS" | head -c 600; echo
check "models is a list object" '"object":"list"' "$MODELS"
check "models carries models[]" '"models"'        "$MODELS"

say "7. a turn with no login state must fail explicitly (no hang, no crash)"
# A complete native Codex `input` ARRAY is required to reach the browser stage: with a partial body the
# ingress fails closed earlier, on its input shape (also documented in doc/container.md §5).
TURN="$(curl -sS -m 120 -H 'content-type: application/json' -d '{
  "model":"chatgpt-web/luna","instructions":"You are a helpful assistant.",
  "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}]}' \
  "http://127.0.0.1:$PORT/v1/responses" 2>&1)"
printf '%s\n' "$TURN" | head -c 600; echo
check "the turn is a typed failure"            '"status":"failed"'      "$TURN"
check "it fails on the login boundary"         'login state is missing' "$TURN"

say "8. Chromium launch inside the container (no display, no Xvfb)"
BROWSER_CHECK="$("${ENGINE[@]}" exec "$CONTAINER" node lib/cli.js browser check 2>&1)"
printf '%s\n' "$BROWSER_CHECK"
check "Playwright launches the configured Chrome" "can launch" "$BROWSER_CHECK"

say "9. doctor --json inside the container"
"${ENGINE[@]}" exec "$CONTAINER" node lib/cli.js doctor --json 2>&1 | head -40

say "10. summary"
if [ "$FAILURES" -eq 0 ]; then
  echo "all checks passed — paste this whole transcript into issue #245"
else
  echo "$FAILURES check(s) failed — paste this whole transcript into issue #245"
fi
exit "$FAILURES"
