# DISASTER-RECOVERY (P6.10)

Companion to BACKUP-RUNBOOK.md. Failover sequence, objectives, and per-disaster runbook. **DR is
claimed proven only after the restore rehearsal runs** (currently PENDING — no managed infra here).

## Objectives (owner to ratify)

|                         | Target   | Basis                               |
| ----------------------- | -------- | ----------------------------------- |
| **RPO** (max data loss) | ≤ 5 min  | PG continuous WAL / PITR            |
| **RTO** (max downtime)  | ≤ 60 min | managed-PG restore + image redeploy |

## DR architecture

- **Primary:** one region — ALB → API (≥2) + worker (≥2), RDS/managed-PG **Multi-AZ**, ElastiCache/
  managed-Redis, S3 + CloudFront.
- **Standby:** cross-region PG read-replica (promotable) + image availability in the standby
  region's registry; DNS/LB cutover on region loss. Redis is rebuilt (reconstructable).
- **Authoritative recovery point** is always PostgreSQL; app instances are stateless and
  redeployed from immutable image tags.

## Failover sequence (region or primary-DB loss)

1. **Declare** the incident; page on-call (severity=page).
2. **Freeze** writes if the primary is degraded but reachable (scale API to 0 or enable maintenance).
3. **Promote** the PG replica (or PITR-restore) to become the new primary.
4. **Repoint** `DATABASE_URL` (secret) → redeploy API + worker (same image tag) in the target region.
5. **Verify** `prisma migrate status` up-to-date + soak invariants + `/api/ready` green on all replicas.
6. **Redis:** deploy fresh — locks expire safely; workers recreate queues; outbox re-drives events.
7. **Cutover** DNS/LB; confirm read + booking paths; watch the P6.6 dashboards/alerts.
8. **Unfreeze** writes; monitor for backlog drain.

## Per-disaster runbook

| Disaster                   | Action                                                                                                      | Invariant preserved                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Database loss**          | PITR restore ≤ RPO → repoint → verify (steps 3–7)                                                           | no double financial action; money state authoritative |
| **Redis loss**             | redeploy Redis (no restore); read APIs stay up; **active booking fails closed** until back                  | locks expire safely; no oversell                      |
| **Region failure**         | promote replica + redeploy images in standby; DNS cutover                                                   | RTO ≤ 60m                                             |
| **Worker outage**          | scale workers up; stale leases auto-recover; drain backlog                                                  | durable outbox → no lost events                       |
| **Queue loss**             | recreate on worker boot; outbox is source of truth                                                          | idempotent handlers → no duplication                  |
| **Payment webhook outage** | provider retries; on recovery, signature-verified + idempotent pipeline dedupes; reconciliation closes gaps | no double charge/refund                               |
| **Provider outage**        | circuit breaker; booking fails closed where provider-dependent; read paths unaffected                       | no false confirmation                                 |

## Incident communication

- **Roles:** Incident Commander (coordinates), Comms (status page + stakeholders), Ops (executes).
- **Channels:** internal incident channel + external status page. Templates in
  `docs/launch/INCIDENT-RESPONSE.md`.
- **Cadence:** initial notice ≤ 15 min; updates every 30 min until resolved; post-incident review
  within 3 business days (`docs/launch/POST-LAUNCH-REVIEW-TEMPLATE.md`).
- **Money incidents** (possible double charge/refund, oversell) are **always** severity=page and
  require finance + engineering on the call.
