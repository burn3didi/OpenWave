#!/bin/sh
# Mounted volumes usually arrive owned by root. Fix that, then run the app as the "node" user
# (FFmpeg parses uploaded files, so it should not run as root).
set -e
mkdir -p "$DATA_DIR" "$MEDIA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" "$MEDIA_DIR" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
