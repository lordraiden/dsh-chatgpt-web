#!/usr/bin/env bash
# docker/spike-evidence.sh — collect the container evidence issue #245 still needs.
#
# NOT EXECUTED on the authoring host: it has no container runtime. Only `bash -n` was run.
# Run this on a Docker-capable host and paste the full output into PR #252 / issue #245.
#
# Usage:
#   docker/spike-evidence.sh                    # fail-closed path only (empty data dir)
#   DATA=/srv/dsh-data docker/spike-evidence.sh # full path against a prepared data volume
#
# Loopback note: the sidecar rejects every non-loopback --host (doc/container.md finding F1), so the
# container runs with --network host and no published port.
set -uo pipefail

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
    printf 'FAIL  %s (expected to contain: %s)\n' "$1" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORKDIR"; }
trap cleanup EXIT

say "environment"
docker version --format '{{.Server.Version}}' 2>&1 || { echo "docker is unavailable"; exit 1; }
node --version 2>&1

say "1. build"
docker build -f "$REPO_ROOT/docker/Dockerfile.spike" -t "$IMAGE" "$REPO_ROOT" 2>&1
check "docker build succeeds" "" "docker" || true

say "2. image facts (browser path + symlink)"
docker run --rm "$IMAGE" sh -lc \
  'node -p "require(\"playwright-core\").chromium.executablePath()"; ls -l /usr/bin/google-chrome; ls -d /ms-playwright/*chromium* 2>/dev/null' 2>&1

if [ -z "$DATA" ]; then
  say "3. FAIL-CLOSED path: empty data dir (no config.json)"
  printf 'expected: the sidecar refuses to start and says the configuration is missing\n'
  docker run --rm --init --ipc=host --network host \
    -v "$WORKDIR:/data" -e DSH_CHATGPT_WEB_HOME=/data "$IMAGE" 2>&1 | head -5
  docker run --rm --ipc=host --network host -v "$WORKDIR:/data" -e DSH_CHATGPT_WEB_HOME=/data \
    "$IMAGE" node lib/cli.js doctor --json 2>&1 | head -20
  say "done (fail-closed path). Re-run with DATA=<prepared data dir> for the full path."
  exit "$FAILURES"
fi

say "3. start the sidecar against the prepared data dir: $DATA"
mkdir -p "$DATA"
docker run -d --name "$CONTAINER" --init --ipc=host --network host \
  -v "$DATA:/data" -e DSH_CHATGPT_WEB_HOME=/data "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
docker logs "$CONTAINER" 2>&1 | tail -5

say "4. /healthz"
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>&1)"
printf '%s\n' "$HEALTH"
check "healthz reports ok" '"status":"ok"' "$HEALTH"
check "healthz names the service" 'dsh-chatgpt-web' "$HEALTH"

say "5. /v1/models (Codex-shaped catalogue)"
MODELS="$(curl -fsS "http://127.0.0.1:$PORT/v1/models" 2>&1)"
printf '%s\n' "$MODELS" | head -20
check "models returns a list object" '"object":"list"' "$MODELS"
check "models carries a models array" '"models"' "$MODELS"

say "6. a turn with no login state must fail explicitly (not hang, not crash)"
TURN="$(curl -sS -m 90 -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/light","input":"ping"}' \
  "http://127.0.0.1:$PORT/v1/responses" 2>&1)"
printf '%s\n' "$TURN" | head -20
check "turn fails with the missing-login error" 'login state is missing' "$TURN"

say "7. doctor --json inside the container"
DOCTOR="$(docker exec "$CONTAINER" node lib/cli.js doctor --json 2>&1)"
printf '%s\n' "$DOCTOR" | head -30

say "summary"
if [ "$FAILURES" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$FAILURES check(s) failed"
fi
exit "$FAILURES"
