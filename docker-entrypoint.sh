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
  # gosu 1.14 looks up the target user in /etc/passwd and sets HOME from
  # that entry, overriding whatever HOME was in the env. The image's
  # existing `node` user is uid 1000; when PUID != 1000 (e.g. 1002 to
  # match host file perms) there's no passwd entry for that uid and gosu
  # falls back to HOME=/, which sends the Claude CLI looking for
  # /.credentials.json and sitting on a 30s internal timeout that
  # produces the "Claude CLI exited with code 0 without response"
  # symptom. Ensure a passwd entry exists for the runtime uid so gosu
  # derives the correct home.
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    echo "node:x:${PUID}:${PGID}::/home/node:/bin/sh" >> /etc/passwd
  fi
  if ! getent group "$PGID" >/dev/null 2>&1; then
    echo "node:x:${PGID}:" >> /etc/group
  fi

  # Named-volume mount points are root-owned until we touch them.
  # Also re-chown every run: an earlier `docker exec --user root`
  # (e.g. `claude setup-token`) can leave files here owned by root,
  # which then locks out uid $PUID on restart.
  chown "$PUID:$PGID" /home/node /home/node/.claude /data 2>/dev/null || true

  # Seed an empty legacy settings file so the Claude CLI stops printing
  # "Claude configuration file not found at: /home/node/.claude.json"
  # three times per invocation. The CLI doesn't need the file's content,
  # only its presence. Re-chown it unconditionally — the Claude CLI may
  # have rewritten it earlier while running as a different uid.
  if [ ! -e /home/node/.claude.json ]; then
    echo '{}' > /home/node/.claude.json
    chmod 600 /home/node/.claude.json
  fi
  chown "$PUID:$PGID" /home/node/.claude.json 2>/dev/null || true

  # gosu derives HOME from the /etc/passwd entry we just ensured above.
  # All other env vars (CLAUDE_CODE_OAUTH_TOKEN, PATH, etc.) pass through
  # untouched.
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
