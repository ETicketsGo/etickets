# OPERATIONS-HANDBOOK (P6.12)

Day-2 operations. Feature-specific runbooks in `docs/ops/` (compensation, orchestration, locks,
sync, domain events).

## Daily

- Check the P6.6 dashboards: booking created/confirmed, compensation backlog + dead-letters, refund/
  void outcomes, outbox age, HTTP p95/p99, `up{}` for api/worker.
- Confirm no `severity=page` alerts open; triage `warn`.

## Feature flags (safe defaults — change only via approved ticket)

`BOOKING_ORCHESTRATOR_MODE=shadow`; provider-confirmation / allocated-inventory / compensation-exec
/ auto-provider-cancel / auto-void / auto-refund = `false`; `BOOKING_REFUND_POLICY_MODE=MANUAL_ONLY`.
**Never enable money automation in production** (startup validation forbids it).

## Common operations

- **Refund (manual):** support raises → admin/finance approves in the admin console (audited) →
  executor re-validates policy + eligibility. No auto-refund.
- **Compensation stuck:** inspect `GET /api/health/compensation`; retry/approve/release-lease via the
  RBAC admin endpoints (safe non-financial only, unless the money flag + approved policy are set).
- **Outbox backlog:** scale workers; stale leases auto-recover; check dead-letters.
- **Hot show / lock contention:** watch `etg_inventory_lock_contention_total`; scale API; verify no oversell.
- **Disable a subsystem:** flip its flag (see LAUNCH-CHECKLISTS rollback).

## Scaling

API + worker are stateless/lease-based — scale replicas horizontally. Watch PG connections
(`replicas × pool ≤ max_connections`; add PgBouncer for high fan-out) and Redis memory.

## Escalation

Money/oversell signals → severity=page + finance + engineering. See ONCALL-RUNBOOK.md.
