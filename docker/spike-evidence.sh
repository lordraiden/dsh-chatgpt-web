#!/usr/bin/env bash
# docker/spike-evidence.sh — collect the container evidence issue #245 needs.
#
# NOT EXECUTED on the authoring host (no container runtime there): only `bash -n` was run.
# Run it on the Docker host and paste the full output into issue #245 / PR #252.
#
# Usage:
#   docker/spike-evidence.sh                                  # auto-detect docker, then podman
#   CONTAINER_ENGINE=podman docker/spike-evidence.sh          # force rootless podman
#   DATA=/srv/dsh-data docker/spike-evidence.sh               # reuse a volume you already prepared
#   IMAGE=dsh-chatgpt-web:spike PORT=17841 docker/spike-evidence.sh
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
IMAGE="${IMAGE:-dsh-chatgpt-web:spike}"
PORT="${PORT:-17841}"
DATA="${DATA:-}"
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
"${ENGINE[@]}" build -f "$REPO_ROOT/docker/Dockerfile.spike" -t "$IMAGE" "$REPO_ROOT" 2>&1 || {
  echo "build failed"; exit 1; }

say "2. image facts: the chromium the app will use, and the symlink that points at it"
"${ENGINE[@]}" run --rm "$IMAGE" sh -lc '
  node -p "require(\"playwright-core\").chromium.executablePath()"
  ls -l /usr/bin/google-chrome
  ls -d /ms-playwright/*chromium* 2>/dev/null' 2>&1

if [ -z "$DATA" ]; then
  DATA="$WORKDIR/data"
  say "3. prepare the data volume at $DATA"
else
  say "3. use the prepared data volume at $DATA"
fi
mkdir -p "$DATA"

# Generate config.json with the application's own primitives (defaultConfig + saveConfig — the same
# path `setup` uses before its login step). It must run from a FILE: defaultConfig() refuses an
# evaluated Bun script ("Cannot install a service from an evaluated Bun script").
cat > "$WORKDIR/make-config.ts" <<'TS'
import { defaultConfig, saveConfig, getConfigPath } from "/app/src/config.ts";
const config = defaultConfig("browser-only");
config.releaseVersion = "spike-volume";
config.port = Number(process.env.SPIKE_PORT ?? 17841);
saveConfig(config);
console.log("wrote " + getConfigPath());
TS

"${ENGINE[@]}" run --rm --init --ipc=host --network host \
  -v "$DATA:/data" -v "$WORKDIR/make-config.ts:/tmp/make-config.ts:ro" \
  -e DSH_CHATGPT_WEB_HOME=/data -e "SPIKE_PORT=$PORT" "$IMAGE" \
  bun /tmp/make-config.ts 2>&1
check "config.json was written" "wrote" "$(head -c 40 "$DATA/config.json" 2>/dev/null)"

say "4. start the sidecar (loopback inside the container, host networking: finding F1)"
"${ENGINE[@]}" run -d --name "$CONTAINER" --init --ipc=host --network host \
  -v "$DATA:/data" -e DSH_CHATGPT_WEB_HOME=/data "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
"${ENGINE[@]}" logs "$CONTAINER" 2>&1 | tail -3

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
TURN="$(curl -sS -m 90 -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/luna","input":"ping"}' \
  "http://127.0.0.1:$PORT/v1/responses" 2>&1)"
printf '%s\n' "$TURN" | head -c 600; echo
# A partial wire body is refused before the browser (documented fail-closed). A complete native
# Codex input would reach the login boundary instead; either way nothing may hang.
if printf '%s' "$TURN" | grep -q '"status":"failed"'; then
  printf 'PASS  the turn failed closed with a typed error\n'
else
  printf 'INFO  unexpected turn response — paste it into the issue\n'
fi

say "8. doctor --json inside the container"
"${ENGINE[@]}" exec "$CONTAINER" node lib/cli.js doctor --json 2>&1 | head -40

say "9. summary"
if [ "$FAILURES" -eq 0 ]; then
  echo "all checks passed — paste this whole transcript into issue #245"
else
  echo "$FAILURES check(s) failed — paste this whole transcript into issue #245"
fi
exit "$FAILURES"
