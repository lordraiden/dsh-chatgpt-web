# Production image for the standalone sidecar (issue #246, containerised-service track).
#
# This is the *service* distribution: the container's single process runs `lib/cli.js serve`.
# Operational documentation, including the verification record behind every number here:
# doc/container.md.
#
# ── base image pinning rule (do not hardcode blindly) ────────────────────────────────────────────
# The image's browser build must match the installed playwright-core exactly, or Playwright cannot
# locate its browser executables. When playwright-core changes, change this ARG in the same commit:
#     node -p "require('playwright-core/package.json').version"    # 1.63.0 (bun.lock)
# `scripts/test-246-container-pin.mjs` fails when this ARG and bun.lock disagree, so the two cannot
# drift apart silently.
#
# Verified for v1.63.0-noble: index digest sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27,
# Node 24 (satisfies engines.node >= 22.19.0), PLAYWRIGHT_BROWSERS_PATH=/ms-playwright,
# chromium revision 1243, pwuser uid/gid 1001.
ARG PLAYWRIGHT_VERSION=1.63.0

# ── build stage: reproducible build of the checked-in bundle ─────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Rebuilds lib/ from src/; the image therefore never ships a stale checked-in bundle.
RUN bun run build && bun lib/cli.js --version

# ── runtime stage ────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# Bun installs dependencies; the sidecar itself runs on Node (its server falls back to node:http).
# BUN_INSTALL must be set BEFORE the installer runs: it defaults to /root/.bun, and pwuser (the
# default user below) cannot traverse /root, which would make `bun` unusable inside a running
# container. /usr/local is world-readable and already on PATH.
ENV BUN_INSTALL=/usr/local
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app
COPY package.json bun.lock ./
# --omit=peer keeps the production closure free of any optional peer the package may declare; the
# service distribution must run from the CLI bundle alone, and the assertion below proves it does.
RUN bun install --production --frozen-lockfile --omit=peer

COPY --from=build /app/lib ./lib
COPY src ./src
COPY assets ./assets
COPY LICENSE ./
# The entrypoint bootstraps an empty data volume so a first `compose up` can become healthy, and it
# stays transparent for every other subcommand (see the ENTRYPOINT note below).
COPY docker/entrypoint.sh /usr/local/bin/dsh-entrypoint
COPY docker/bootstrap-config.ts /app/docker/bootstrap-config.ts
# COPY preserves the source mode, and a file created with 0600 would be unreadable by pwuser.
# Make the runtime tree readable/traversable by the non-root user explicitly.
RUN chmod 0755 /usr/local/bin/dsh-entrypoint \
 && chmod -R a+rX /app/src /app/assets /app/lib /app/docker \
 && chmod a+r /app/package.json /app/bun.lock

# Build assertion: the whole CLI import graph loads on the production closure alone.
RUN node lib/cli.js --help > /dev/null && node lib/cli.js --version

# defaultChromeExecutable() returns /usr/bin/google-chrome on Linux, which this image does not create
# (browsers live under PLAYWRIGHT_BROWSERS_PATH=/ms-playwright). Compute the real path instead of
# hardcoding a revision that changes with every Playwright release.
RUN ln -sf "$(node -p "require('playwright-core').chromium.executablePath()")" /usr/bin/google-chrome \
 && ls -l /usr/bin/google-chrome

# Data directory: config.json, the provider session state and the durable conversation store.
# Pre-created for pwuser so a *named* volume mounted here inherits that ownership (a bind mount keeps
# the host's, which is why the root variant exists — see docker-compose.yml and doc/container.md).
ENV DSH_CHATGPT_WEB_HOME=/data
RUN install -d -o pwuser -g pwuser -m 0750 /data
VOLUME ["/data"]
EXPOSE 17841

# Non-root by default: pwuser (1001) can read the world-readable browsers and write the data volume.
# Chromium's sandbox stays off because the code does not request `chromiumSandbox: true`; enabling it
# is the hardened variant, deliberately deferred with its exact requirement recorded in
# doc/container.md (it needs a config field the application does not have today).
ENV HOME=/home/pwuser
USER pwuser

# 127.0.0.1 only: src/cli.ts rejects any other --host and parseConfig() enforces the same, so a
# published port cannot reach the sidecar without --network host (doc/container.md finding F1).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:17841/healthz > /dev/null || exit 1

# The entrypoint bootstraps the volume and then execs `node lib/cli.js "$@"`, so every subcommand
# stays reachable without an override while `serve` remains the default.
#   docker run --rm image doctor --json      -> bootstrap + node lib/cli.js doctor --json
#   docker run --rm image                   -> bootstrap + node lib/cli.js serve --port 17841
# (An ENTRYPOINT of `... serve` would append the operator's arguments to `serve`.)
ENTRYPOINT ["/usr/local/bin/dsh-entrypoint"]
CMD ["serve", "--port", "17841"]
