# BACKUP-RUNBOOK (P6.9)

What is backed up, how, and how to restore. PostgreSQL is the only authoritative store; everything
else is reconstructable. **DR is not "proven" until the restore rehearsal (below) runs against a
real managed-PG** — currently PENDING (no cloud infra in this environment).

## Targets

| Asset                                  | Authoritative?          | Backup method                                          | Frequency                  | Retention    |
| -------------------------------------- | ----------------------- | ------------------------------------------------------ | -------------------------- | ------------ |
| **PostgreSQL**                         | ✅ yes                  | managed automated backup + WAL (PITR)                  | continuous WAL, daily full | 7d / 4w / 3m |
| **Redis**                              | ❌ (locks/queues/cache) | AOF `appendonly yes` for fast restart only             | n/a                        | n/a          |
| **Object storage** (tickets/QR/assets) | partial (regenerable)   | bucket **versioning** + cross-region replication       | continuous                 | 90d versions |
| **Secrets**                            | —                       | secret-manager manifest (names/rotation), never values | on change                  | —            |
| **Config / migrations**                | —                       | git (forward-only migrations)                          | per commit                 | ∞            |
| **Outbox**                             | ✅ (in PostgreSQL)      | covered by PG backup                                   | —                          | —            |
| **Provider checkpoints**               | ✅ (in PostgreSQL)      | covered by PG backup                                   | —                          | —            |

## Backup procedures

- **Managed PG (RDS/Railway/Flexible Server):** enable automated backups + PITR; verify WAL
  archiving; set the retention window above. Take a manual snapshot before every production migration.
- **Self-managed PG (compose):** `pg_dump -Fc` nightly to object storage + continuous WAL archiving
  (`archive_command`). The `db-data` volume alone is **not** a backup.
- **Redis:** AOF is for fast restart, not DR. No PITR needed (reconstructable).
- **Object storage:** enable versioning + lifecycle; QR/tickets are deterministically regenerable
  from booking rows if lost.

## Restore procedures

### PostgreSQL point-in-time recovery

```bash
# 1. Restore to a target timestamp (managed: console/CLI PITR; self-managed: base backup + WAL replay).
# 2. Point a NON-production app stack at the restored DB (APP_ENV=STAGING).
DATABASE_URL=<restored> npx --prefix apps/api prisma migrate status      # expect "up to date"
# 3. Invariant sanity on the restored data:
DATABASE_URL=<restored> node scripts/soak/concurrency-soak.mjs --seconds 30   # 0 double-finalize/oversell
# 4. Workers boot → outbox re-drives pending events (FOR UPDATE SKIP LOCKED, idempotent handlers).
# 5. BullMQ queues recreate automatically; provider checkpoints resume (no replay storm).
```

### Migration rollback

Migrations are **forward-only** (no down-migrations). Roll back by: (a) deploying the previous
**image** (additive migrations keep it compatible), and (b) if a migration must be undone, author a
new forward migration that reverts the change. Never hand-edit an applied migration.

### Secret recovery

Restore from the secret manager; rotate `JWT_*` / `QR_SIGNING_SECRET` / `PAYMENT_WEBHOOK_SECRET` if
compromise is suspected (rotating `QR_SIGNING_SECRET` invalidates issued QR — coordinate with ops).

## Restore rehearsal (run quarterly + before launch) — **PENDING**

Execute the PITR restore steps against a scratch instance, confirm `migrate status` + the soak
invariants, and record the wall-clock as the measured RTO. **Until this runs, DR RTO/RPO are
targets, not proven.**
