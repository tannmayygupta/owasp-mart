#!/bin/sh
# Run by vulnmart-certs.service after every certificate run (story L-10 follow-up from the audit of 2026-10-18).
# Caddy reads its certificate files once, when it starts, so a renewed certificate is only served after Caddy restarts. This script restarts the Caddy container
# of THIS host (vm-p: vulnmart-caddy, vm-i: vulnmart-edge-caddy) when, and only when, the files in the folder it serves changed since the last run.
# The first run only records the state. Exit 0 always except when a restart was needed and failed (the journal shows it).
set -eu
CERT_DIR="${CADDY_CERT_DIR:-/opt/vulnmart/certs/live}"
STATE_DIR="${VULNMART_STATE_DIR:-/var/lib/vulnmart}"
STATE="$STATE_DIR/caddy-cert.sha256"
mkdir -p "$STATE_DIR"
[ -d "$CERT_DIR" ] || { echo "vulnmart-reload-caddy: $CERT_DIR does not exist; nothing to do"; exit 0; }
NEW=$(find "$CERT_DIR" -type f | sort | xargs -r sha256sum | sha256sum | cut -d' ' -f1)
OLD=$(cat "$STATE" 2>/dev/null || true)
if [ -z "$OLD" ]; then echo "$NEW" > "$STATE"; echo "vulnmart-reload-caddy: first run, state recorded"; exit 0; fi
if [ "$NEW" = "$OLD" ]; then echo "vulnmart-reload-caddy: certificate files unchanged"; exit 0; fi
done=0
for name in vulnmart-caddy vulnmart-edge-caddy; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = "true" ]; then
    docker restart "$name" >/dev/null
    echo "vulnmart-reload-caddy: restarted $name after a certificate change"
    done=1
  fi
done
[ "$done" = 1 ] || echo "vulnmart-reload-caddy: certificate changed but no Caddy container is running; it will load the new files when it starts"
echo "$NEW" > "$STATE"