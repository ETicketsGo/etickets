# ETicketsGo RC1 — Operations Checklist (Day-2)

Ongoing operational responsibilities once RC1 is live. Detailed procedures live in
[MONITORING.md](../guides/MONITORING.md), [DEPLOYMENT.md](../guides/DEPLOYMENT.md),
[CREDENTIAL-ROTATION-RUNBOOK.md](../guides/CREDENTIAL-ROTATION-RUNBOOK.md), and
[DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md).

## Health & monitoring endpoints

| What                     | Where                                                    |
| ------------------------ | -------------------------------------------------------- |
| API liveness / readiness | `GET /api/health` · `GET /api/health/ready` (DB+Redis)   |
| Worker readiness         | worker `/ready`                                          |
| Web liveness             | `GET /api/health` on each web app                        |
| API metrics (Prometheus) | `GET /api/metrics`                                       |
| Worker metrics           | worker metrics port (see MONITORING.md)                  |
| Ops console (admin)      | `GET /api/admin/ops/health`, `/queues`, `/queues/failed` |

## Daily

- ☐ Check dashboards: error rate, p95 latency, 5xx, payment success rate, queue depth.
- ☐ Review Sentry for new issues; triage.
- ☐ Confirm queue is draining (`etg_queue_jobs{state="failed"}` not growing); retry failed
  jobs via `POST /api/admin/ops/queues/retry-failed` if appropriate.
- ☐ Skim the audit log for anomalies (spikes in `AUTH_LOGIN_FAILED`, `AUTH_TOKEN_REUSE_DETECTED`,
  `MAINTENANCE_TOGGLED`, payment/refund/payout actions).

## Weekly

- ☐ Verify backups are current and a restore drill is on schedule (DR guide: quarterly).
- ☐ Review reconciliation discrepancies (`/admin/finance` — [RECONCILIATION-OPERATIONS.md](../guides/RECONCILIATION-OPERATIONS.md)).
- ☐ Check payout status and settlement metrics.
- ☐ Review dependency advisories; plan patch updates.

## Incident response

- ☐ **Site-wide problem** → maintenance mode on (`/admin/ops/maintenance`, audited), fix, off.
- ☐ **Payment provider outage** → [PROVIDER-OUTAGE-RUNBOOK.md](../guides/PROVIDER-OUTAGE-RUNBOOK.md)
  (fail over / suspend route/provider).
- ☐ **Redis outage** → cache + maintenance guard fail open (bounded by command timeout);
  booking/hold-expiry is DB-backed and continues; worker resumes on reconnect.
- ☐ **Data incident** → [DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md).
- ☐ Every incident: correlate via `correlationId` in logs; capture the audit trail.

## Secret & credential hygiene

- ☐ Rotate signing secrets and provider credentials per [CREDENTIAL-ROTATION-RUNBOOK.md](../guides/CREDENTIAL-ROTATION-RUNBOOK.md)
  (secret manager supports rotation without restart via the short cache TTL).
- ☐ Never place secret material in `.env` committed files or `NEXT_PUBLIC_*` vars.

## Offline pilot operations (only while a pilot is active)

- ☐ Follow [PILOT-RUNBOOK.md](../guides/PILOT-RUNBOOK.md): certification drills, scoped
  activation, command-center + reconciliation console monitoring, stand-down + flag-off.

## Scaling note

- ☐ Rate limiting is currently per-instance (see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)).
  Before scaling the API horizontally, plan the Redis-backed shared throttler, or keep the
  auth-sensitive limits conservative per instance.
