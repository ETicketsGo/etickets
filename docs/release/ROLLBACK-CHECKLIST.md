# ETicketsGo RC1 — Rollback Checklist

How to safely revert a bad production deploy. The guiding rule: **application code rolls
back freely; database migrations are additive-only, so prefer rolling code forward/back
over reverting schema.** See [DEPLOYMENT.md §10](../guides/DEPLOYMENT.md) and
[DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md).

## Decide: is a rollback warranted?

- ☐ Is the issue a config/flag problem? → prefer a **config fix or flag flip** (below), not a rollback.
- ☐ Is it a code regression? → **roll back the app image** to the previous SHA.
- ☐ Is it data corruption? → **restore from backup / PITR** (last resort; see DR guide).

## Fast mitigations (try before a full rollback)

- ☐ **Maintenance mode**: `POST /api/admin/ops/maintenance {enabled:true}` — global 503 for
  non-admin routes while you fix forward (admins + probes stay exempt; the toggle is audited).
- ☐ **Feature flag off**: disable the offending capability (`OFFLINE_CHECKIN_ENABLED`, wallet,
  a `FEATURE_*` flag) and restart — no redeploy needed.
- ☐ **Payments**: set `PAYMENT_LIVE_ENABLED=false` to stop accepting live payments, or use the
  provider outage controls (`/admin/payments/outage`, [PROVIDER-OUTAGE-RUNBOOK.md](../guides/PROVIDER-OUTAGE-RUNBOOK.md))
  to fail over / suspend a route.

## Code rollback (previous image)

- ☐ Identify the last-known-good image SHA (CI/CD history).
- ☐ Redeploy API, worker, and web apps at that SHA.
- ☐ **Migrations:** because every migration is additive with safe defaults, the previous app
  version runs against the newer schema — **do NOT roll the schema back** unless the DR guide
  says so for a specific migration. Reverting a migration risks data loss.
- ☐ Verify readiness (`/api/health/ready`), a smoke test, and that the regression is gone.
- ☐ Turn maintenance mode off (`{enabled:false}` — audited).

## Database restore (last resort — data loss window applies)

- ☐ Declare an incident; stop API + worker to prevent writes.
- ☐ Follow [DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md): PITR to just before the
  bad event, or restore the latest `pg_dump` (RPO ≤ 5 min target).
- ☐ Reconcile payments/webhooks that arrived during the window (idempotent handlers help).
- ☐ Bring services back; verify readiness + smoke test.

## Offline-pilot rollback (if a pilot was live)

- ☐ Revoke the activation (`POST /api/checkin/activation/:id/revoke`) → NO_GO.
- ☐ Drain device queues (Sync) and resolve reconciliation reviews.
- ☐ Set `OFFLINE_CHECKIN_ENABLED` off and restart → endpoints 404. (See [PILOT-RUNBOOK.md](../guides/PILOT-RUNBOOK.md) §7.)

## After any rollback

- ☐ Record what happened, the from/to SHAs, and whether data was restored.
- ☐ File the root cause; add a regression test before re-attempting the deploy.
- ☐ Confirm audit trail + metrics show the system healthy.
