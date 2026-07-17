# ETicketsGo — Incident Response Plan

How to detect, triage, mitigate, and learn from production incidents. Pairs with
[ROLLBACK-CHECKLIST](../release/ROLLBACK-CHECKLIST.md), [MONITORING.md](../guides/MONITORING.md),
and [DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md).

## Severity
| Sev | Definition | Examples | Response |
| --- | --- | --- | --- |
| **SEV1** | Platform-wide outage or money/entry integrity at risk | API down, payments failing broadly, gate can't check in at a live event, data-integrity bug | Page on-call immediately; all-hands |
| **SEV2** | Major feature broken, workaround exists | Checkout failing for one provider, dashboard down | On-call within 30 min |
| **SEV3** | Minor/degraded | Slow queries, cosmetic bug | Next business day |

## Roles
Incident Commander (coordinates) · Engineering on-call (mitigates) · Comms (status updates) ·
Support (customer/organizer messaging).

## Flow
1. **Detect** — alert (Sentry/metrics), support report, or organizer call.
2. **Declare** — assign severity + Incident Commander; open an incident channel/log.
3. **Mitigate first, diagnose second:**
   - Site-wide → **maintenance mode** (`POST /api/admin/ops/maintenance`, audited) while fixing.
   - Bad deploy → **roll back** to last-good image ([ROLLBACK-CHECKLIST](../release/ROLLBACK-CHECKLIST.md)).
   - Feature-specific → **flag off** the offending capability.
   - Payment provider → [PROVIDER-OUTAGE-RUNBOOK](../guides/PROVIDER-OUTAGE-RUNBOOK.md) (fail over / suspend).
   - Redis down → cache + maintenance guard fail open; booking/holds are DB-backed and continue.
   - Data incident → [DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md) (PITR/restore).
4. **Communicate** — regular status updates (internal + affected organizers) on a set cadence.
5. **Verify** — readiness green, smoke test, error rate normal; exit maintenance.
6. **Review** — blameless post-incident review within 48h; capture root cause + action items;
   add a regression test.

## Tooling
Logs are correlation-ID traceable; the audit trail records who did what; ops console shows
health, queue depth, and failed jobs. Keep the on-call runbook + contacts current.

## Communication templates
- *Investigating:* "We're investigating an issue affecting [scope]. Next update in [X] min."
- *Identified/mitigating:* "We've identified the cause and are applying a fix."
- *Resolved:* "The issue is resolved as of [time]. A post-incident review will follow."
