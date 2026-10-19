#!/bin/sh
# The daily backup of the platform's databases on vm-p (L-24, FR-PRV, runbook docs/runbooks/backup-and-restore.md).
# Usage: vulnmart-backup.sh run | verify <file>
#   run:    pg_dump (custom format, compressed) of the platform database and of the key store database into $BACKUP_DIR, mode 600, root only; then verifies each
#           file can be read back (pg_restore --list), keeps the newest $KEEP_DAYS days, writes $MARK_DIR/backup-ok (time, file names, sizes) and removes older dumps.
#   verify: pg_restore --list of one file (exit 0 when readable).
# The key store dump holds only wrapped keys: without the key encryption key (a secret file that is NOT in the backup) it opens nothing. Keep the two apart.
# Settings (environment): BACKUP_DIR (/var/backups/vulnmart), MARK_DIR (/var/lib/vulnmart), KEEP_DAYS (7), PG_CONTAINER (vulnmart-postgres), PG_USER (vulnmart), DOCKER (docker).
# Exit: 0 ok, 1 a dump or a check failed (the unit fails, vulnmart-alert records it), 2 bad usage.
set -eu
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vulnmart}"
MARK_DIR="${MARK_DIR:-/var/lib/vulnmart}"
KEEP_DAYS="${KEEP_DAYS:-7}"
PG_CONTAINER="${PG_CONTAINER:-vulnmart-postgres}"
PG_USER="${PG_USER:-vulnmart}"
DOCKER="${DOCKER:-docker}"
DATABASES="${DATABASES:-vulnmart vm_keystore}"
case "$KEEP_DAYS" in ''|*[!0-9]*) echo "vulnmart-backup: KEEP_DAYS must be a whole number" >&2; exit 2 ;; esac

verify() {
  "$DOCKER" exec -i "$PG_CONTAINER" pg_restore --list < "$1" > /dev/null
}

MODE="${1:-}"
case "$MODE" in
  verify) [ -n "${2:-}" ] || { echo "usage: vulnmart-backup.sh verify <file>" >&2; exit 2; }; verify "$2"; echo "vulnmart-backup: $2 is readable"; exit 0 ;;
  run) ;;
  *) echo "usage: vulnmart-backup.sh run | verify <file>" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$BACKUP_DIR" "$MARK_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUMMARY=""
for db in $DATABASES; do
  out="$BACKUP_DIR/$db-$STAMP.dump"
  if ! "$DOCKER" exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$db" > "$out.part"; then
    rm -f "$out.part"
    echo "vulnmart-backup: pg_dump of $db failed" >&2
    exit 1
  fi
  [ -s "$out.part" ] || { rm -f "$out.part"; echo "vulnmart-backup: the dump of $db is empty" >&2; exit 1; }
  mv "$out.part" "$out"
  verify "$out" || { echo "vulnmart-backup: $out cannot be read back" >&2; exit 1; }
  SUMMARY="$SUMMARY $(basename "$out"):$(wc -c < "$out")"
done
find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' -mtime "+$KEEP_DAYS" -delete
printf '%s%s\n' "$STAMP" "$SUMMARY" > "$MARK_DIR/backup-ok"
echo "vulnmart-backup: ok$SUMMARY"