# ETicketsGo — Disaster Recovery Plan

## Objectives (recommended targets)

- **RPO** (max data loss): ≤ 5 minutes (via managed-Postgres PITR / WAL archiving).
- **RTO** (max downtime): ≤ 60 minutes for full restore.

## What must be recoverable

- **PostgreSQL** — the single system of record (bookings, tickets, seats, payments,
  refunds, payouts, audit log). Everything else is derived or rebuildable.
- **Redis** — cache + BullMQ queues. Cache loss is harmless (repopulates). Queue loss
  drops in-flight scheduled sweeps; the lazy hold-expiry path and re-runnable
  notification dispatch make this tolerable.

## Backups

- Enable **automated managed-Postgres backups + PITR** (WAL). Daily full + continuous WAL.
- Retention: ≥ 14 days (adjust to compliance).
- Dev/compose backup: `pg_dump -Fc "$DATABASE_URL" > backup.dump`.

## Restore procedures

- **Point-in-time (corruption/bad deploy):** restore the cluster to a timestamp just
  before the incident; re-point `DATABASE_URL`; run `npm run db:deploy` (no-op if
  schema matches); smoke test (health/ready + a synthetic booking).
- **Dev restore:** `pg_restore -d "$DATABASE_URL" --clean --if-exists backup.dump`.
- **Full region loss:** restore latest backup to a standby region; redeploy the app
  tier from the release tag; update DNS/API base URL.

## Failure scenarios & response

| Scenario                           | Response                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App instance crash                 | Orchestrator restarts; stateless — no data action.                                                    |
| Bad deploy                         | Roll back to previous tag (migrations additive/forward-compatible).                                   |
| DB corruption / bad data migration | PITR restore to pre-incident timestamp.                                                               |
| Redis outage                       | Cache falls back to DB (CacheService is fail-open); restart queues; hold-expiry still runs lazily.    |
| Payment provider outage            | Bookings stay `PENDING_PAYMENT`; holds expire and release seats automatically; reconcile on recovery. |
| Region outage                      | Restore to standby region (above).                                                                    |

## Invariants that limit blast radius

- Money/inventory transitions are atomic + idempotent (no double-issue/refund/pay).
- Seat holds auto-expire and return stock, so a stalled payment path self-heals.
- Migrations are additive → forward-compatible → rollback rarely needs a down-migration.

## Drills

- Quarterly: restore latest backup into a scratch environment and run the smoke suite.
