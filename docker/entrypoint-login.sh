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

# Loopback only, and EXPLICITLY IPv4: with `-localhost` x11vnc may bind ::1 while websockify resolves
# `localhost` to 127.0.0.1 (or the reverse), which leaves the noVNC client stuck at "connecting" with
# nothing in the log. `-noxdamage` avoids the frozen/black screen Xvfb can produce, and the log file is
# what makes a failure diagnosable at all (`docker exec <ctr> cat /tmp/x11vnc.log`).
x11vnc -display "$display" -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 \
  -noxdamage -o /tmp/x11vnc.log &
# Verbose, and the target spelled out as 127.0.0.1 for the same reason as above.
websockify -v --web=/usr/share/novnc 6080 127.0.0.1:5900 &
echo "noVNC ready: http://127.0.0.1:6080/vnc.html (display $display)" >&2

# Hand the display to the interactive command: the sign-in opens a headed browser (it must, to be
# usable for passkeys and provider challenges).
exec node lib/cli.js "$@"
