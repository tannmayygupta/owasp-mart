#!/bin/sh
# The alert of a failed host job (L-10, L-24). Called as `vulnmart-alert.sh fail <unit>` by vulnmart-alert@<unit>.service (OnFailure=) and as
# `vulnmart-alert.sh clear <unit>` by a job that ended well. A failure leaves the file $MARK_DIR/ALERT-<unit> (the time of the failure) and one critical journal
# line; scripts/live-ops-check.mjs reads the files, so a failed renewal or backup is seen on the next check and never stays silent. A success removes the file.
# Exit: 0 done, 2 bad usage.
set -eu
MARK_DIR="${MARK_DIR:-/var/lib/vulnmart}"
MODE="${1:-}"
UNIT="${2:-}"
case "$MODE" in fail|clear) ;; *) echo "usage: vulnmart-alert.sh fail|clear <unit>" >&2; exit 2 ;; esac
case "$UNIT" in ''|*[!A-Za-z0-9_.@:-]*) echo "vulnmart-alert: the unit name is not a plain unit name" >&2; exit 2 ;; esac
FILE="$MARK_DIR/ALERT-$UNIT"
if [ "$MODE" = fail ]; then
  mkdir -p "$MARK_DIR"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$FILE"
  logger -p user.crit -t vulnmart-alert "unit $UNIT failed; see: journalctl -u $UNIT" || true
  echo "vulnmart-alert: recorded the failure of $UNIT"
else
  rm -f "$FILE"
fi