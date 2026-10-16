# syntax=docker/dockerfile:1
#
# Headless sign-in image (issues #249 and #259).
#
# Why it exists: the interactive sign-in opens a **headed** browser, so a host with no display cannot
# sign in at all. This image adds an X server, a VNC server and noVNC — and nothing else — so the
# operator completes the sign-in through a browser on their own machine.
#
# It is built **on top of the production image**, so the display stack never reaches the production
# artifact:
#
#   docker build -t dsh-chatgpt-web:local .            # the production image first
#   docker build -f Dockerfile.login -t dsh-chatgpt-web-login:local .
#
# The session it writes lands in the provider credential layout of the mounted data volume, exactly as
# the runtime reads it (see doc/container.md §5.5).
ARG PRODUCTION_IMAGE=dsh-chatgpt-web:local
FROM ${PRODUCTION_IMAGE}

USER root
# xvfb is already in the Playwright base image; it is listed so the intent is explicit and the package
# is guaranteed, not inherited by accident.
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
 && rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint-login.sh /usr/local/bin/dsh-login-entrypoint
RUN chmod 0755 /usr/local/bin/dsh-login-entrypoint \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Back to the unprivileged runtime user: the sign-in must write the session into the data volume as the
# same identity the runtime uses, or the files would end up root-owned.
USER pwuser
ENV DISPLAY=:99
EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/dsh-login-entrypoint"]
CMD ["login"]
