#!/bin/sh
# scripts/quickstart.sh — the single startup path from a clean checkout to a real answer.
#
# It is the container's own first run, in order, with no browser and no extra dependencies:
#   1. build and start the supported default stack   (docker compose up -d --wait)
#   2. wait for /healthz on the loopback port
#   3. run the container's own `doctor`
#   4. make one real API call: GET /v1/models, and POST /v1/chat/completions when a session exists
#
# It ends with the exact command a human should run next, and it exits non-zero, loudly and
# actionably, when the stack is healthy but cannot answer yet (normally: no provider session on the
# data volume). It never prints a secret: a key present as DSH_CHATGPT_WEB_API_KEY is only ever
# passed as an Authorization header.
#
# Usage:
#   scripts/quickstart.sh            # start (and build, if the image is missing) then verify
#   scripts/quickstart.sh --build    # force `docker compose build` first, for freshly pulled source
#
# Run it on the Docker host from the repository root; `sg docker -c "scripts/quickstart.sh"` when the
# shell session predates the docker group membership.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE="${DSH_QUICKSTART_COMPOSE:-docker compose}"
SERVICE="chatgpt-web"
PORT=17841
BASE="http://127.0.0.1:${PORT}"
PROMPT="${DSH_QUICKSTART_PROMPT:-Reply with exactly the word: pong}"

say() { printf '\n== %s\n' "$*"; }
hint() { printf '\nNext step:\n'; for command do printf '  %s\n' "$command"; done; }
die() { printf '\nquickstart: %s\n' "$1" >&2; shift; hint "$@"; exit 1; }

usage() {
  printf 'usage: scripts/quickstart.sh [--build]\n'
}

build_first=0
for argument in "$@"; do
  case "$argument" in
    --build) build_first=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $argument" "scripts/quickstart.sh" ;;
  esac
done

command -v docker >/dev/null 2>&1 \
  || die "docker is not on PATH" \
    "install Docker Engine + the Compose plugin: https://docs.docker.com/engine/install/" \
    "or run this script through the docker group: sg docker -c 'scripts/quickstart.sh'"
$COMPOSE version >/dev/null 2>&1 \
  || die "'$COMPOSE version' does not work; the Compose plugin is required" \
    "docker compose version   # confirm the plugin is installed"
command -v curl >/dev/null 2>&1 \
  || die "curl is not on PATH; it is needed for the /healthz and API checks" \
    "install curl and re-run: scripts/quickstart.sh"

# A key is only used as a header; it is never echoed, logged or written. The default stack is
# loopback-only and needs no key, so this is for the exposed variant sharing the same volume.
AUTH=""
if [ -n "${DSH_CHATGPT_WEB_API_KEY:-}" ]; then
  AUTH="Authorization: Bearer ${DSH_CHATGPT_WEB_API_KEY}"
fi
api_get() { if [ -n "$AUTH" ]; then curl -fsS -H "$AUTH" "$@"; else curl -fsS "$@"; fi; }
api_post() { if [ -n "$AUTH" ]; then curl -sS -H "$AUTH" "$@"; else curl -sS "$@"; fi; }

say "1/4 build and start the default stack"
if [ "$build_first" -eq 1 ]; then
  $COMPOSE build "$SERVICE" || die "the image build failed" "$COMPOSE build $SERVICE"
fi
# `up --wait` builds the image when it is missing and returns only once the healthcheck passes, so
# this one command is both the build and the start on a clean host.
if ! $COMPOSE up -d --wait; then
  printf '\n--- last container log lines ---\n' >&2
  $COMPOSE logs --tail 40 "$SERVICE" >&2 2>&1 || true
  die "the stack did not reach a healthy state" "$COMPOSE logs -f $SERVICE" "docker compose down -v   # and retry from a clean volume"
fi

say "2/4 wait for /healthz on 127.0.0.1:${PORT}"
waited=0
while [ "$waited" -lt 30 ]; do
  curl -fsS -m 3 "$BASE/healthz" >/dev/null 2>&1 && break
  waited=$((waited + 1))
  sleep 1
done
health="$(curl -fsS -m 5 "$BASE/healthz" 2>/dev/null || true)"
[ -n "$health" ] || die "nothing answers on $BASE/healthz" "$COMPOSE logs -f $SERVICE"
printf '  %s\n' "$health"

say "3/4 the container's own doctor"
# The human report is what the operator reads; the JSON run is what this script decides from, because
# `doctor --json` is the machine contract (its shape is unchanged by the guidance added to the text).
doctor_text="$($COMPOSE exec -T "$SERVICE" node lib/cli.js doctor 2>&1)" || true
printf '%s\n' "$doctor_text"
doctor_json="$($COMPOSE exec -T "$SERVICE" node lib/cli.js doctor --json 2>/dev/null)" || true
login_status="$(
  printf '%s\n' "$doctor_json" | grep -A1 '"id": "login"' | grep -o '"status": "[a-z]*"' | head -n 1 | sed 's/.*"status": "//;s/"$//'
)" || true

say "4/4 one real API call"
models="$(api_get -m 15 "$BASE/v1/models")" || die "GET /v1/models failed" "$COMPOSE logs -f $SERVICE"
model_count="$(printf '%s\n' "$models" | grep -o '"slug": *"[^"]*"' | wc -l | tr -d ' ')"
model="$(printf '%s\n' "$models" | grep -o '"slug": *"[^"]*"' | head -n 1 | sed 's/.*"slug": *"//;s/"$//')"
printf '  GET  /v1/models            -> %s model(s); first: %s\n' "$model_count" "${model:-none}"

if [ "$login_status" != "ok" ]; then
  printf '  POST /v1/chat/completions  -> skipped: the volume has no verified provider session\n'
  printf '\nquickstart: the stack is up and the API responds, but no real answer can be produced yet.\n' >&2
  printf '  No verified provider session on the data volume (doctor: login=%s).\n' "${login_status:-unknown}" >&2
  hint \
    "open http://127.0.0.1:17841/v1/control/auth/ and sign in (no display needed; the running service picks it up on the next turn, no restart)" \
    "docker compose exec chatgpt-web node lib/cli.js auth import --provider chatgpt-web --from /capture" \
    "# then prove the browser surface (cheap, no provider turn) and continue:" \
    "docker compose exec chatgpt-web node lib/cli.js browser check" \
    "scripts/quickstart.sh"
  exit 1
fi

answer_body="$(
  api_post -m 180 -H 'content-type: application/json' \
    -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"${PROMPT}\"}]}" \
    "$BASE/v1/chat/completions"
)" || true
answer="$(printf '%s\n' "$answer_body" | grep -o '"content": *"[^"]*"' | head -n 1 | sed 's/.*"content": *"//;s/"$//')"
if [ -z "$answer" ]; then
  printf '  POST /v1/chat/completions  -> no assistant content\n'
  printf '\nquickstart: the session exists but the turn did not produce an answer. Response (truncated):\n' >&2
  printf '%s\n' "$answer_body" | head -c 600 >&2
  printf '\n' >&2
  die "the provider turn failed" "$COMPOSE logs -f $SERVICE" "docker compose exec chatgpt-web node lib/cli.js browser check"
fi
printf '  POST /v1/chat/completions  -> "%s"\n' "$answer"
printf '  round trip: stack -> ChatGPT Web session -> HTTP answer\n'

printf '\nNext step:\n'
printf '  curl -fsS %s/v1/chat/completions \\\n    -H %s \\\n    -d %s\n' \
  "$BASE" "'content-type: application/json'" \
  "'{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"hola\"}]}'"
