#!/bin/sh
# Drop-privileges entrypoint.
#
# Docker named volumes are created root-owned regardless of the image's
# USER directive. The Claude CLI writes to ~/.claude/.credentials.json on
# startup (even for `auth status`), so a mismatched uid locks the CLI up
# silently. To avoid forcing operators to chown the volume by hand after
# every `docker volume rm`, this entrypoint:
#
#   1. When launched as root, chowns /home/node and /home/node/.claude to
#      the operator-supplied PUID/PGID (default 1000, matching the image's
#      node user) so the Claude CLI can create its state files.
#   2. Uses gosu to exec the main process as that uid/gid — the Claude CLI
#      itself refuses to run as root when --dangerously-skip-permissions is
#      in play, which the proxy always passes.
#
# When the container is already running as non-root (e.g. legacy compose
# files that still set `user:`), this script skips the chown and just
# execs the command directly — so the behavior is backwards-compatible.
set -eu

: "${PUID:=1000}"
: "${PGID:=1000}"

if [ "$(id -u)" = "0" ]; then
  # Named-volume mount points are root-owned until we touch them.
  chown "$PUID:$PGID" /home/node /home/node/.claude /data 2>/dev/null || true

  # Preserve env (HOME / PATH etc.) across the privilege drop. gosu does not
  # reset these the way `su` does, which is exactly what we want: the Node
  # server was written assuming HOME=/home/node.
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
