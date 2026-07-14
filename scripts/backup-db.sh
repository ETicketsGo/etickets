#!/bin/sh
# ─────────────────────────────────────────────────────────────
# ETicketsGo — PostgreSQL logical backup.
#
# Dumps the database referenced by $DATABASE_URL to a timestamped, compressed
# custom-format file (pg_dump -Fc), which restore-db.sh can replay.
#
# Usage:
#   DATABASE_URL="postgresql://user:pass@host:5432/db" ./scripts/backup-db.sh [OUT_DIR]
#
#   OUT_DIR  directory for the dump file (default: ./backups)
#
# Examples:
#   ./scripts/backup-db.sh
#   DATABASE_URL="$DATABASE_URL" ./scripts/backup-db.sh /var/backups/eticketsgo
#
# Requires the `pg_dump` client (Postgres 16 recommended to match the server).
# See docs/reports/DISASTER-RECOVERY.md and docs/reports/OPERATIONS.md §5.
# ─────────────────────────────────────────────────────────────
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Usage: DATABASE_URL=postgresql://... $0 [OUT_DIR]" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on PATH. Install the PostgreSQL client tools." >&2
  exit 1
fi

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/eticketsgo-$TIMESTAMP.dump"

echo "Backing up database to $OUT_FILE ..."
# -Fc: compressed custom format. --no-owner/--no-privileges keep the dump portable
# across roles (restore assigns ownership to the connecting user).
pg_dump --dbname="$DATABASE_URL" -Fc --no-owner --no-privileges --file="$OUT_FILE"

SIZE="$(wc -c < "$OUT_FILE" 2>/dev/null || echo '?')"
echo "Backup complete: $OUT_FILE (${SIZE} bytes)"
