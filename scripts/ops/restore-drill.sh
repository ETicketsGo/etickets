#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# ETicketsGo - isolated RESTORE DRILL with integrity checks and a measured RTO.
#
# Restores a pg_dump custom-format file into a brand-new SCRATCH database, checks that
# what came back is a coherent copy of the platform, prints a report, then drops the
# scratch database. It NEVER touches the database the dump came from.
#
# Usage:
#   DRILL_ADMIN_URL="postgresql://user:pass@host:5432/postgres" \
#     sh scripts/ops/restore-drill.sh <dump-file-or-directory> [migrations-dir]
#
#   DRILL_ADMIN_URL  a server you may create databases on. REQUIRED, and deliberately NOT
#                    DATABASE_URL, so a shell with production's DATABASE_URL exported cannot
#                    run this against production by accident.
#   <dump>           a .dump file, or a directory (the newest etg-*.dump is used)
#   [migrations-dir] apps/api/prisma/migrations (default) - compared with _prisma_migrations
#   DRILL_KEEP=1     keep the scratch database for inspection (default: drop it)
#   DRILL_RTO_TARGET_SECONDS  fail if restore+checks take longer (default 1800 = 30 min)
#
# Needs psql + pg_restore (Postgres 16 client). Exit 0 = every check passed.
# Never prints a connection string or a row of business data - only names and counts.
# See docs/pilot/INFRASTRUCTURE.md section 3.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

die() { echo "RESTORE DRILL REFUSED: $*" >&2; exit 2; }

[ -n "${DRILL_ADMIN_URL:-}" ] || die "DRILL_ADMIN_URL is not set (a server to create a scratch database on)."
SRC="${1:-}"
[ -n "$SRC" ] || die "no dump file or directory given."
MIGRATIONS_DIR="${2:-apps/api/prisma/migrations}"
command -v psql >/dev/null 2>&1 || die "psql not found on PATH."
command -v pg_restore >/dev/null 2>&1 || die "pg_restore not found on PATH."

if [ -d "$SRC" ]; then
  DUMP="$(ls -1t "$SRC"/etg-*.dump 2>/dev/null | head -n 1 || true)"
  [ -n "$DUMP" ] || die "no etg-*.dump in $SRC."
else
  DUMP="$SRC"
fi
[ -f "$DUMP" ] || die "dump not found: $DUMP"

# The scratch database name is generated here and nowhere else, so the DROP below can only
# ever name a database this run created.
SCRATCH="etg_drill_$(date +%s)_$$"
# Swap the database name in the URL (everything after the last '/', query string kept).
BASE="${DRILL_ADMIN_URL%%\?*}"
QUERY=""
case "$DRILL_ADMIN_URL" in *\?*) QUERY="?${DRILL_ADMIN_URL#*\?}";; esac
SCRATCH_URL="${BASE%/*}/$SCRATCH$QUERY"

run_admin() { psql "$DRILL_ADMIN_URL" -v ON_ERROR_STOP=1 -qtAc "$1"; }
q() { psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -qtAc "$1"; }

FAILS=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

cleanup() {
  if [ "${DRILL_KEEP:-0}" = "1" ]; then
    echo "  scratch database kept: $SCRATCH (DRILL_KEEP=1) - drop it when finished."
  else
    run_admin "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 || true
    echo "  scratch database dropped: $SCRATCH"
  fi
}

START="$(date +%s)"
echo "restore-drill"
echo "  dump             $(basename "$DUMP") ($(wc -c < "$DUMP" | tr -d ' ') bytes)"
echo "  scratch database $SCRATCH"

run_admin "CREATE DATABASE \"$SCRATCH\"" >/dev/null
trap cleanup EXIT

# Ownership/extension errors are expected in small numbers on a different server; the verdict
# comes from the checks below, not from pg_restore's exit status.
RESTORE_START="$(date +%s)"
pg_restore --no-owner --no-acl --dbname "$SCRATCH_URL" "$DUMP" >/dev/null 2>"${TMPDIR:-/tmp}/etg-drill-$$.err" || \
  echo "  note: pg_restore reported errors (first line: $(head -n 1 "${TMPDIR:-/tmp}/etg-drill-$$.err" | cut -c1-160))"
rm -f "${TMPDIR:-/tmp}/etg-drill-$$.err"
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_START ))
echo "  restore took     ${RESTORE_SECONDS}s"
echo "checks"

# 1. Tables exist.
TABLES="$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[ "$TABLES" -gt 0 ] && pass "tables restored: $TABLES" || fail "no tables restored"

# 2. Migrations table complete and clean.
if [ "$(q "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")" = "t" ]; then
  APPLIED="$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
  UNFINISHED="$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")"
  [ "$UNFINISHED" = "0" ] && pass "no half-applied migrations" || fail "$UNFINISHED migration(s) started but never finished"
  if [ -d "$MIGRATIONS_DIR" ]; then
    IN_REPO="$(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    # The dump may be OLDER than the repo (fewer migrations: fine, deploy applies the rest) but
    # must never be NEWER (a dump from a build this checkout does not know).
    if [ "$APPLIED" -le "$IN_REPO" ]; then
      pass "migrations applied $APPLIED of $IN_REPO in repo ($((IN_REPO - APPLIED)) still to deploy)"
    else
      fail "dump has $APPLIED migrations, repo only $IN_REPO - wrong checkout"
    fi
  fi
else
  fail "_prisma_migrations table missing"
fi

# 3. Row counts for the tables that matter. Empty is only acceptable if the source was empty,
#    which a human reads from the report.
echo "  row counts"
for T in User Organization Event EventSession Booking Ticket Payment Refund Payout Settlement AuditLog; do
  if [ "$(q "SELECT to_regclass('public.\"$T\"') IS NOT NULL")" = "t" ]; then
    printf '    %-14s %s\n' "$T" "$(q "SELECT count(*) FROM \"$T\"")"
  else
    printf '    %-14s MISSING\n' "$T"
    fail "table $T missing from the restore"
  fi
done

# 4. Invariants. Each is a query that must return 0.
inv() { # inv "description" "SQL returning a count"
  N="$(q "$2" 2>/dev/null || echo ERR)"
  if [ "$N" = "0" ]; then pass "$1"; else fail "$1 (found: $N)"; fi
}
inv "no money captured on a booking that is not confirmed" \
  "SELECT count(*) FROM \"Payment\" p JOIN \"Booking\" b ON b.id=p.\"bookingId\" WHERE p.status='SUCCEEDED' AND b.status IN ('PENDING_PAYMENT','EXPIRED','CANCELLED')"
inv "no ticket without a booking" \
  "SELECT count(*) FROM \"Ticket\" t LEFT JOIN \"Booking\" b ON b.id=t.\"bookingId\" WHERE b.id IS NULL"
inv "no payment without a booking" \
  "SELECT count(*) FROM \"Payment\" p LEFT JOIN \"Booking\" b ON b.id=p.\"bookingId\" WHERE b.id IS NULL"
inv "booking references are unique" \
  "SELECT count(*) FROM (SELECT reference FROM \"Booking\" WHERE reference IS NOT NULL GROUP BY reference HAVING count(*)>1) d"
inv "no negative payment amounts" \
  "SELECT count(*) FROM \"Payment\" WHERE \"amountMinor\" < 0"

ELAPSED=$(( $(date +%s) - START ))
TARGET="${DRILL_RTO_TARGET_SECONDS:-1800}"
echo "result"
echo "  RTO (restore + checks) ${ELAPSED}s, target ${TARGET}s"
[ "$ELAPSED" -le "$TARGET" ] || fail "RTO ${ELAPSED}s exceeds target ${TARGET}s"
echo "RESTORE_DRILL_JSON {\"dump\":\"$(basename "$DUMP")\",\"tables\":$TABLES,\"restoreSeconds\":$RESTORE_SECONDS,\"totalSeconds\":$ELAPSED,\"failures\":$FAILS}"
if [ "$FAILS" -gt 0 ]; then echo "  VERDICT: FAILED ($FAILS check(s))"; exit 1; fi
echo "  VERDICT: PASSED"
