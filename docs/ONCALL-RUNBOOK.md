# ONCALL-RUNBOOK (P6.12)

First response by alert. Mitigate with kill switches **before** deep debugging. Money/oversell
signals are always severity=page.

| Alert                                                | First action                                                                                             | Verify                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **RedisDown**                                        | Active booking fails closed by design; redeploy Redis; do NOT force-enable anything                      | read APIs up; locks re-establish; soak invariants 0        |
| **PostgresDown**                                     | Page DBA; writes fail closed; PITR/failover if primary lost (DISASTER-RECOVERY.md)                       | `/api/ready` red until back; no false confirmation         |
| **RefundRejectionsHigh / RefundStatusRecoveryStuck** | Inspect `/api/health/compensation` refund block; a refund is ambiguous/failed — **never assume success** | reconciliation classifier; manual review, no double refund |
| **CompensationDeadLetters**                          | Inspect the dead-lettered record (admin); decide retry vs manual                                         | audited; no money moved without approval                   |
| **CompensationBacklogAgeHigh**                       | Scale workers; check stale leases                                                                        | oldest-ready age drops                                     |
| **BookingConfirmStalled**                            | Check provider health + payment webhooks + orchestrator mode                                             | confirms resume                                            |
| **ShadowMismatchHigh**                               | Do NOT promote from shadow; capture mismatch samples                                                     | investigate orchestrator vs legacy diff                    |
| **QueueBacklogHigh / WorkerDown**                    | Restart/scale worker; stale leases recover                                                               | backlog drains; no lost events                             |
| **ApiDown / Http5xx**                                | LB routes to healthy replica; roll back image if release-correlated                                      | 5xx clears; `/api/ready` green                             |
| **DbQueryLatencyP95High**                            | Check slow queries + connections; add PgBouncer/scale                                                    | p95 < 250ms                                                |

## Kill switches (fastest mitigation)

Booking: `BOOKING_ORCHESTRATOR_ENABLED=false`/`_MODE=shadow`. Provider confirm:
`BOOKING_PROVIDER_CONFIRMATION_ENABLED=false`. Allocated: `BOOKING_ALLOCATED_INVENTORY_ENABLED=false`.
Compensation: `BOOKING_COMPENSATION_EXECUTION_ENABLED=false`. Money: auto-void/refund flags false +
`MANUAL_ONLY`. Payment freeze: `PAYMENT_PROVIDER_NAME=mock` (staging) / provider maintenance flag (prod).

## Money-incident protocol

Suspected double charge/refund or oversell → severity=page, freeze the relevant flag, pull finance +
engineering, reconcile from PostgreSQL (authoritative), document, post-incident review.
