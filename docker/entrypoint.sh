#!/bin/sh
# Container entrypoint: make the data volume usable, then exec the CLI with the caller's arguments.
#
#   docker run --rm image doctor --json     -> bootstrap (if needed) + node lib/cli.js doctor --json
#   docker run --rm image                   -> bootstrap + node lib/cli.js serve --port 17841 (the CMD)
#
# `exec` keeps the CLI as PID 1's replacement so signals (SIGTERM from `docker stop`) reach it, and
# the CLI itself owns the loopback bind and the health endpoint.
set -eu

DATA_DIR="${DSH_CHATGPT_WEB_HOME:-/data}"

# A fresh volume has no configuration and `serve` refuses to start without one, which would make a
# first `docker compose up` fail. Announce it: this is a default configuration, not a provider session.
if [ ! -f "${DATA_DIR}/config.json" ]; then
  echo "dsh-chatgpt-web: no config.json in ${DATA_DIR}; writing a default configuration." >&2
  echo "dsh-chatgpt-web: real turns still need a provider session (doc/container.md, issue #249)." >&2
  bun /app/docker/bootstrap-config.ts
fi

exec node lib/cli.js "$@"
