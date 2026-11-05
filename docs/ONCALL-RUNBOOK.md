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

## Ops alert emails

Sent to `OPS_ALERT_EMAILS` (see MONITORING-GUIDE.md; `SENTRY_DSN` enables Sentry). Subject starts
`[ETicketsGo <APP_ENV>]`. Each one is a money incident until shown otherwise.

| Alert type                          | First action                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `WEBHOOK_SIGNATURE_REJECTED`        | The provider webhook secret on the api does not match the dashboard. Fix the secret; check for captured payments since. |
| `CAPTURE_NOT_APPLIED`               | Money taken, no ticket. Finance reconciliation queue: refund or honour the booking. Nothing is refunded automatically.  |
| `EXPIRY_FOUND_CAPTURE`              | Webhooks are not arriving. Recovered = check the booking; failed = stock is held, resolve by hand.                      |
| `FINANCE_DISCREPANCY_OPENED`        | Admin console > Finance reconciliation; assign and resolve.                                                             |
| `CONFIRMATION_FAILED_AFTER_PAYMENT` | Paid but not confirmed; it retries then dead-letters. Check the booking and the error code in the alert.                |
| `WEBHOOK_DEAD_LETTERED`             | A provider event will not be retried. Read the WebhookEvent row's error; replay only after fixing the cause.            |
| `NOTIFICATION_FAILED`               | A customer message stopped retrying. A CONFIGURATION/credential cause means the whole channel is down.                  |
| `AUTH_REFRESH_TOKEN_REUSE`          | A used session token came back; that account was signed out everywhere. Many at once = tokens leaking: check the IPs.   |
| `ADMIN_MFA_LOCKOUT`                 | Somebody has a staff password and is guessing the code. Ask the holder; if not them, revoke sessions and reset it.      |
| `ADMIN_ACCESS_CHANGED`              | Staff role, duties or suspension changed. If nobody planned it, ask `changedBy` and revoke it in Admin > Staff.         |
| `LOGIN_BACKOFF_BURST`               | Many accounts made to wait after wrong passwords: password guessing. Read AUTH_LOGIN_FAILED audit rows for the IPs.     |

## Kill switches (fastest mitigation)

Booking: `BOOKING_ORCHESTRATOR_ENABLED=false`/`_MODE=shadow`. Provider confirm:
`BOOKING_PROVIDER_CONFIRMATION_ENABLED=false`. Allocated: `BOOKING_ALLOCATED_INVENTORY_ENABLED=false`.
Compensation: `BOOKING_COMPENSATION_EXECUTION_ENABLED=false`. Money: auto-void/refund flags false +
`MANUAL_ONLY`. Payment freeze: `PAYMENT_PROVIDER_NAME=mock` (staging) / provider maintenance flag (prod).

## Money-incident protocol

Suspected double charge/refund or oversell → severity=page, freeze the relevant flag, pull finance +
engineering, reconcile from PostgreSQL (authoritative), document, post-incident review.
