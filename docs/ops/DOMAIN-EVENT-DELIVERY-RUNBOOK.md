# Operational Runbook — Domain-Event Delivery / Transactional Outbox (ADR-041)

**PostgreSQL is the source of truth.** The outbox row commits with the business mutation;
the worker dispatcher delivers at-least-once. All admin ops are RBAC-guarded (ADMIN) +
audited and expose safe metadata only (never payloads/secrets/PII).

## Feature flags (defaults preserve P2 in-process behaviour)

`DOMAIN_EVENT_DELIVERY_MODE` = in_process (default) | outbox | dual_write_shadow ·
`DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED` (default false) · batch/poll/lease/attempts/backoff
tunables · `DOMAIN_EVENT_OUTBOX_RETENTION_ENABLED` (default false).

## Check dispatcher health

`GET /admin/outbox/health` → mode, dispatchEnabled, state (DISABLED/HEALTHY/DEGRADED/
UNHEALTHY), pending/processing/retryable/deadLettered/manualReview/staleLease counts,
oldestPendingAgeSeconds, lastDispatchAt, workerId. UNHEALTHY in outbox mode usually means
the dispatcher is off or dead-lettering.

## Find stuck / inspect events

```
GET /admin/outbox/events?status=RETRYABLE_FAILURE   (or PENDING|DEAD_LETTERED|MANUAL_REVIEW)
GET /admin/outbox/events/:id
GET /admin/outbox/aggregates/:type/:id/history
GET /admin/outbox/correlations/:correlationId
```

Or SQL: `SELECT id,"eventType",status,"attemptCount","availableAt","lastErrorCode"
FROM "OutboxEvent" WHERE status='RETRYABLE_FAILURE' ORDER BY "createdAt" LIMIT 50;`

## Inspect the backlog

`SELECT status, count(*) FROM "OutboxEvent" GROUP BY status;` — watch PENDING age and
DEAD_LETTERED growth. Metrics: `etg_outbox_delivery_total{outcome}`,
`etg_outbox_delivery_latency_seconds`, `etg_outbox_poll_duration_seconds`.

## Recover stale leases

Automatic (lease expiry + maintenance sweep). Manual:
`POST /admin/outbox/recover-stale-leases`. A worker crash never strands rows — an expired
lease is re-claimable by any worker.

## Retry a failed / dead-lettered event

`POST /admin/outbox/events/:id/retry` (RETRYABLE_FAILURE|DEAD_LETTERED|MANUAL_REVIEW →
PENDING, available now) or `POST /admin/outbox/retry-batch?status=DEAD_LETTERED&limit=N`.
Idempotent — the dispatcher re-claims atomically and completed handlers are skipped.

## Handle a poison event

It retries with backoff up to max attempts, then DEAD_LETTERED. Inspect
`lastErrorCode`/`lastErrorMessage`, fix the handler or the data, then retry — or cancel
(`POST /admin/outbox/events/:id/cancel`) if it should never deliver. Cancelling is audited.

## Handle an unsupported version

The event goes to MANUAL_REVIEW (deserialize rejects a version newer than the catalogue).
Ship the handler that supports the new version, then retry. Never edit the stored event's
type/version.

## Duplicate side-effect concerns

Delivery is at-least-once; consumers dedupe via `ProcessedDomainEvent (eventId,
handlerName)`. A COMPLETED handler is skipped on redelivery — the side effect runs once.
If you suspect a duplicate, check that the handler is registered with a STABLE
`handlerName` (renaming a handler is a migration concern).

## Pause the dispatcher

Set `DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED=false` (rows keep accumulating durably) or stop
the worker. Health will report UNHEALTHY in outbox mode while paused (expected).

## Roll back to in-process mode

Set `DOMAIN_EVENT_DELIVERY_MODE=in_process` and redeploy. New confirmations publish
directly again (P2 behaviour). Drain any remaining PENDING rows first by briefly keeping
the dispatcher enabled, or leave them (retention/ops). No data migration needed.

## Verify no events were lost

Every committed business change that requires an event has a row (required-event
recording rolls back if it can't). Reconcile by `correlationId`/aggregate:
`GET /admin/outbox/aggregates/Booking/:bookingId/history` should show a
`booking.confirmed` row DELIVERED. A confirmed booking with no such row (outbox mode)
indicates a bug — investigate; PostgreSQL booking state is authoritative.

## Retention / cleanup

OFF by default. When enabled, the `outbox-maintenance` job purges DELIVERED past
`RETENTION_DAYS` and DEAD_LETTERED past `DEAD_LETTER_RETENTION_DAYS`; MANUAL_REVIEW is
never auto-purged. Purges are bounded + audited.

## Production activation checklist

1. Deploy with `in_process` (no change). 2. `dual_write_shadow` + dispatch off → compare
   record counts vs expected, watch transaction latency + duplicate rate. 3. `outbox` +
   dispatch on, delivering only to BookingEventRecorder (safe observer). 4. Verify health,
   retry, stale-recovery, dead-letter paths in staging. 5. Enable retention. 6. Only then
   migrate an idempotent reversible consumer. Never enable irreversible handlers first.
