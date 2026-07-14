#!/bin/sh
# ─────────────────────────────────────────────────────────────
# ETicketsGo — PostgreSQL logical restore.
#
# Restores a pg_dump custom-format file (produced by backup-db.sh) into the
# database referenced by $DATABASE_URL, dropping existing objects first.
#
# Usage:
#   DATABASE_URL="postgresql://user:pass@host:5432/db" ./scripts/restore-db.sh DUMP_FILE
#
# Example:
#   DATABASE_URL="$DATABASE_URL" ./scripts/restore-db.sh backups/eticketsgo-20260713-120000.dump
#
# WARNING: this is DESTRUCTIVE — `--clean --if-exists` drops objects before
# recreating them. STOP the api + worker first so nothing writes mid-restore.
# Requires the `pg_restore` client. After restore, run `npm run db:deploy`
# (no-op if the schema matches) and smoke-test GET /api/ready.
# See docs/reports/DISASTER-RECOVERY.md and docs/reports/OPERATIONS.md §5.
# ─────────────────────────────────────────────────────────────
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Usage: DATABASE_URL=postgresql://... $0 DUMP_FILE" >&2
  exit 1
fi

DUMP_FILE="${1:-}"
if [ -z "$DUMP_FILE" ]; then
  echo "ERROR: no dump file given." >&2
  echo "Usage: DATABASE_URL=postgresql://... $0 DUMP_FILE" >&2
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "ERROR: pg_restore not found on PATH. Install the PostgreSQL client tools." >&2
  exit 1
fi

echo "About to restore $DUMP_FILE into the target database (DESTRUCTIVE)."
printf 'Type "yes" to continue: '
read -r CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo "Restoring ..."
# --clean --if-exists: drop then recreate (idempotent). --no-owner/--no-privileges
# mirror the backup so the restore works regardless of the original roles.
pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$DUMP_FILE"

echo "Restore complete. Next: run 'npm run db:deploy' and check GET /api/ready."
