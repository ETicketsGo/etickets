# Operational Runbook — Booking Orchestration (ADR-042)

Covers the P5.1 local-authoritative orchestrator + shadow mode. **PostgreSQL is
authoritative**; the orchestrator composes existing seams and never duplicates inventory,
payment, or ticket logic. Admin retry/reconcile is RBAC + audited. Legacy behaviour is
unchanged when disabled.

## Modes (default = disabled)

`BOOKING_ORCHESTRATOR_ENABLED=false` (disabled → legacy path only) · `=true` +
`BOOKING_ORCHESTRATOR_MODE=shadow` (legacy path + observation, zero side effects) ·
`=active` (orchestrator drives booking — requires `INVENTORY_SOURCING_ENABLED`; startup
validation enforces this). Provider-confirmation/compensation/reconciliation are
separately gated.

## Inspect a workflow

```
SELECT id, "bookingId", state, version, "selectedProviderCode", "inventoryOwnershipMode",
       "lockId", "fencingToken", "paymentProvider", "attemptCount", "lastErrorCode",
       "manualReviewReason", "correlationId"
FROM "BookingWorkflow" WHERE "bookingId" = $1;
```

State meanings are in `BOOKING-STATE-TRANSITION-MATRIX.md`. Version is optimistic-
concurrency; a jump in version between reads means a concurrent advance occurred.

## Investigate shadow mismatches

Metrics `etg_booking_shadow_total{outcome,provider}` and
`etg_booking_shadow_mismatch_total{category}`. Categories: `PROVIDER_SELECTION_MISMATCH`
(orchestrator would pick a non-LOCAL provider), `INVENTORY_DECISION_MISMATCH` (resolver
failed while the legacy hold succeeded). Shadow never changes the customer response — a
mismatch is a signal to investigate resolver config, not an incident.

## Retry payment creation (temporary provider failure)

Re-call `beginPayment` (idempotent — `createIntent` is retry-safe; the workflow stays
`LOCKED`/`PAYMENT_PENDING`). A repeated call never creates a second payment order.

## Payment success but no confirmation

1. Check the workflow state (`PAYMENT_PENDING`/`PAYMENT_AUTHORIZED` = not confirmed).
2. Confirmation reuses `PaymentsService.processVerifiedEvent` (atomic confirm + inventory
   - outbox `BookingConfirmed`) guarded by `alreadyConfirmed`. Re-deliver the verified
     payment event → `confirmPayment` advances to `CONFIRMED` idempotently (no duplicate
     tickets/outbox/settlement).
3. If the outbox insert failed, the confirmation tx rolled back → the booking is NOT
   confirmed → safe to retry.

## Release a stuck Redis lock

If a workflow is CONFIRMED but its `lockId` survived (Redis finalize failed after
commit), run booking reconciliation (below) — it releases the surviving lock. Manually:
inspect the lock via the ADR-039 runbook and `markInternal` release; the booking stays
confirmed (never rolled back for Redis cleanup).

## Investigate hold expiry

Durable expiration remains the existing worker sweep (`releaseExpiredHolds`); the
orchestrator advances the workflow `…→EXPIRING→EXPIRED` and releases the lock. A CONFIRMED
booking is never expired. Timeout policy: PostgreSQL hold (HOLD_MINUTES=10) is
authoritative for expiry; the Redis lock TTL (300s) is fast cleanup only, never the
durable signal.

## Handle outbox failure / ticket issuance failure

Outbox delivery + ticket issuance are durable (P2.1 outbox + existing issuance). A
ticket-generation failure does NOT roll back a confirmed booking — it retries via the
existing durable systems (see the domain-event delivery runbook).

## Run reconciliation

`orchestrator.reconcile({ bookingId?, limit? })` classifies local drift
(`CONFIRMED_BOOKING_WORKFLOW_NOT_CONFIRMED`, `HOLD_EXPIRED_WORKFLOW_ACTIVE`,
`MANUAL_REVIEW_REQUIRED`, …). It never auto-refunds/cancels a confirmed booking on one
uncertain read; ambiguous cases → manual review.

## Disable active mode / return to legacy

Set `BOOKING_ORCHESTRATOR_ENABLED=false` (or `MODE=shadow`) and redeploy. In-flight
orchestrated workflows are inspectable; new bookings use the legacy path. No data
migration; `BookingWorkflow` rows remain for audit.

## Verify no double booking / no duplicate charge

- Seat oversell is structurally impossible (ADR-039 checks + `ShowSeat` unique + the hold
  guard) regardless of orchestrator mode.
- One idempotency key → one `BookingWorkflow` (unique `(workflowType, idempotencyKey)`) →
  one booking; a changed request under the same key returns a typed conflict.
- Duplicate payment callbacks confirm once (`alreadyConfirmed` + the outbox `eventId`
  unique + durable per-handler idempotency).
- Two workers advancing one workflow: only one wins the guarded version bump; the loser
  replays or gets a conflict.
