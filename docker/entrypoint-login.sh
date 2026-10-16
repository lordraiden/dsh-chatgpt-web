#!/bin/sh
# Headless sign-in for the containerised service (issues #249 and #259).
#
# Serves an X display over noVNC so a host with **no** display can still sign in, then runs the
# interactive command on that display. The display stack lives only in this image: the production image
# is deliberately untouched.
set -eu

# A fresh volume has no configuration: bootstrap it here too, so the sign-in works on first start.
if [ ! -f "${DSH_CHATGPT_WEB_HOME:-/data}/config.json" ]; then
  echo "bootstrapping ${DSH_CHATGPT_WEB_HOME:-/data}/config.json" >&2
  bun /app/docker/bootstrap-config.ts
fi

display="${DISPLAY:-:99}"
screen="${SCREEN_GEOMETRY:-1440x900x24}"

mkdir -p /tmp/.X11-unix
Xvfb "$display" -screen 0 "$screen" -nolisten tcp &
# Wait for the socket instead of sleeping a fixed time.
tries=0
while [ ! -e "/tmp/.X11-unix/X${display#:}" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "Xvfb did not come up on $display" >&2
    exit 1
  fi
  sleep 0.1
done

# `-localhost` keeps the VNC port off the network: noVNC on 6080 is what an operator reaches.
x11vnc -display "$display" -forever -shared -nopw -rfbport 5900 -localhost -quiet -bg
websockify --web=/usr/share/novnc 6080 localhost:5900 &
echo "noVNC ready: http://127.0.0.1:6080/vnc.html (display $display)" >&2

# Hand the display to the interactive command: the sign-in opens a headed browser (it must, to be
# usable for passkeys and provider challenges).
exec node lib/cli.js "$@"
