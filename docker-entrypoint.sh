#!/bin/sh
# Fail fast, and legibly, on the one thing that reliably goes wrong when this
# lands on a NAS: the bind-mounted data folder isn't writable by the container
# user. Without this the bot starts, counts happily, and silently loses every
# save — which only shows up as a reset count after the next restart.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ ! -d "$DATA_DIR" ]; then
  echo "discord-counter: data directory $DATA_DIR does not exist." >&2
  echo "Check the volume mount in docker-compose.yml." >&2
  exit 1
fi

if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "discord-counter: cannot write to $DATA_DIR (running as uid $(id -u), gid $(id -g))." >&2
  echo "Give the mounted host folder to that uid, e.g. over SSH on the NAS:" >&2
  echo "  sudo chown -R $(id -u):$(id -g) /volume1/docker/discord-counter/data" >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

exec "$@"
