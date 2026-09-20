#!/bin/sh
# Make the mounted data folder usable, then drop privileges.
#
# On a NAS installed entirely through the Docker UI there is no shell to chown
# a bind mount from, and Docker creates a missing mount target as root. So if
# we start as root we take ownership here and immediately step down to
# PUID:PGID — the bot never runs as root. If someone set `user:` themselves,
# we're already unprivileged and just check the folder is writable.
#
# Getting this wrong is silent: the bot would count happily while every save
# fails, showing up only as a reset count after the next restart.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

is_root() { [ "$(id -u)" = "0" ]; }

# Run a command as the user the bot will actually run as.
run_as() {
  if is_root; then su-exec "$PUID:$PGID" "$@"; else "$@"; fi
}

mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ ! -d "$DATA_DIR" ]; then
  echo "discord-counter: data directory $DATA_DIR is missing and could not be created." >&2
  echo "Check the folder mapped to /app/data in the Docker app." >&2
  exit 1
fi

if is_root; then
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
fi

if ! run_as touch "$DATA_DIR/.write-test" 2>/dev/null; then
  if is_root; then
    echo "discord-counter: cannot write to $DATA_DIR as uid $PUID, gid $PGID." >&2
    echo "The mapped folder may be read-only, or on a filesystem that ignores chown." >&2
    echo "Map /app/data to a normal folder in a NAS share and try again." >&2
  else
    echo "discord-counter: cannot write to $DATA_DIR as uid $(id -u), gid $(id -g)." >&2
    echo "The container is running as a fixed user; either drop that setting so" >&2
    echo "the entrypoint can fix ownership, or set PUID/PGID to match the folder." >&2
  fi
  exit 1
fi
run_as rm -f "$DATA_DIR/.write-test" 2>/dev/null || true

if is_root; then
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
