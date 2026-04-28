#!/bin/sh
# docker-entrypoint.sh — PUID/PGID privilege drop for mStream Velvet
#
# Set PUID and PGID environment variables to run mStream as a specific
# user/group. This ensures tag edits, recordings, and downloads are
# written with the correct ownership on NAS volumes.
#
# If PUID/PGID are 0 or unset, the container runs as root (legacy behaviour).

set -e

PUID=${PUID:-0}
PGID=${PGID:-0}

if [ "$PUID" != "0" ] || [ "$PGID" != "0" ]; then
  echo "[entrypoint] Running as PUID=${PUID} PGID=${PGID}"

  # Create group with the requested GID if it does not already exist
  if ! getent group "$PGID" > /dev/null 2>&1; then
    addgroup --gid "$PGID" mstream 2>/dev/null || \
    groupadd -g "$PGID" mstream 2>/dev/null || true
  fi

  # Create user with the requested UID/GID if it does not already exist
  if ! getent passwd "$PUID" > /dev/null 2>&1; then
    adduser --uid "$PUID" --gid "$PGID" \
            --no-create-home --disabled-password \
            --gecos "" mstream 2>/dev/null || \
    useradd -u "$PUID" -g "$PGID" -M -s /sbin/nologin mstream 2>/dev/null || true
  fi

  # Fix ownership of directories that mStream writes to at runtime.
  # Music volumes are intentionally excluded — the user owns those already.
  chown -R "$PUID:$PGID" \
    /app/save \
    /app/image-cache \
    /app/waveform-cache \
    /app/bin 2>/dev/null || true

  exec gosu "$PUID:$PGID" "$@"
else
  echo "[entrypoint] Running as root (set PUID/PGID to run as a different user)"
  exec "$@"
fi
