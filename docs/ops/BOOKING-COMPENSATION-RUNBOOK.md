# Operational Runbook — Booking Compensation (ADR-043)

Covers the P5.3A compensation foundation. **No money moves automatically.** Planning and safe
non-financial execution are flag-gated (all off by default). Financial actions and confirmed-
provider-booking cancellation are planned but require manual review in P5.3A.

## Modes (default = disabled)

`BOOKING_COMPENSATION_ENABLED=false` (off) · `+ _PLANNING_ENABLED=true` (create durable plans,
execute nothing) · `+ _EXECUTION_ENABLED=true` (execute SAFE non-financial actions only).
`_AUTO_REFUND/_AUTO_VOID/_AUTO_PROVIDER_CANCEL` are additionally gated and **rejected in
production** in P5.3A (startup validation).

## Find compensation-required bookings

```
SELECT "bookingId", "compensationType", state, "reasonCode", "targetReference", "attemptCount",
       "manualReviewReason", "createdAt"
FROM "BookingCompensation" WHERE state IN ('PLANNED','READY','PROCESSING','MANUAL_REVIEW')
ORDER BY "createdAt";
```

Also reconcile workflows: `orchestrator.reconcile(...)` classifies provider/allocation drift
(PROVIDER_CONFIRMATION_AMBIGUOUS, PAYMENT_SUCCEEDED_PROVIDER_REJECTED, …).

## Dry-run planning

Call the planner with the discrepancy context (no persistence) to see the classification +
actions + `autoExecutable`/`requiresManualReview` before enabling planning. The plan is
deterministic — the same context always yields the same plan.

## Review payment state before any money action

Confirm captured-vs-authorized and refund status through the payment adapter. The planner
chooses VOID (authorized-not-captured on an auth/capture provider) vs REFUND (captured); an
unknown capture state → MANUAL_REVIEW. Never force a refund on an uncertain state.

## Review provider state

Check `providerReservationId`/`providerBookingId`/`providerStatus` on the workflow and query
the provider's status. Provider cancellation of a reservation ≠ cancellation of a confirmed
booking ≠ a customer refund.

## Approve a safe plan / retry safe cleanup

Enable `_EXECUTION_ENABLED` (non-prod) — the worker claims READY safe actions with a lease and
executes them idempotently (Redis lock release wired). `etg_booking_compensation_operations_total
{type,outcome}` tracks executions. Retry is bounded; poison work dead-letters.

## Investigate a duplicate-refund concern

`idempotencyKey` is unique per (booking, type, target, generation): a second refund plan for the
same payment+reason cannot be created. Verify no two COMPLETED refund rows share a payment
reference; the executor uses the server-generated key for provider idempotency.

## Investigate provider-cancelled / payment-captured (or the reverse)

Reconciliation flags `provider-cancelled/payment-captured` and `payment-refunded/provider-active`.
These are **never** auto-resolved — open a MANUAL_REVIEW record and resolve via an audited admin
action.

## Recover stale leases / handle dead letters

`recoverStaleLeases()` returns PROCESSING rows whose lease expired to READY. Dead-lettered rows
(attempts exhausted) require operator inspection; they are never silently retried.

## Move to manual review / disable execution

Advance a record to MANUAL_REVIEW (audited). To halt execution, set `_EXECUTION_ENABLED=false`
(planning continues) or `_PLANNING_ENABLED=false` / `BOOKING_COMPENSATION_ENABLED=false` to stop
everything; existing records remain for audit.

## Enable Phase 4 (provider reservation cancellation)

Set `BOOKING_COMPENSATION_ENABLED` + `_PLANNING_ENABLED` + `_EXECUTION_ENABLED` +
`_AUTO_PROVIDER_CANCEL_ENABLED`, with `BOOKING_PROVIDER_CONFIRMATION_ENABLED` (a registered
capable provider). Startup fails fast otherwise. This cancels ONLY unpaid, unconfirmed external
reservations on providers with idempotent cancellation — it is **not** money movement and
performs **no refund**. Refund/void (Phase 5/6) remain off + production-forbidden.

## Investigate a provider reservation cancellation

Inspect the workflow:

```
SELECT state, "providerReservationId", "providerStatus", "providerCancelledAt"
FROM "BookingWorkflow" WHERE "bookingId" = $1;
```

A cancelled reservation shows `providerStatus = 'CANCELLED'` with `providerCancelledAt` set.
Events: `booking.provider_cancellation_requested` (intent, emitted before the call) then
`booking.provider_cancelled` (definitive, exactly once). An ambiguous cancel emits only the
requested fact, and the compensation record sits RETRYABLE / MANUAL_REVIEW until status
recovery resolves it.

## Reconciliation: reservation vs payment/local drift

- `RESERVATION_CANCELLED_PAYMENT_PRESENT` — a captured payment exists for a cancelled
  reservation → **manual review** (a refund may be owed; never auto-refunded in Phase 4).
- `RESERVATION_ACTIVE_LOCAL_RELEASED` — the external reservation is still active while the local
  booking is expired/cancelled → an orphaned reservation to cancel (plan a `PROVIDER_RESERVATION_CANCEL`).

## Payment void (Phase 5)

Enable with `BOOKING_COMPENSATION_ENABLED` + `_PLANNING_ENABLED` + `_EXECUTION_ENABLED` +
`_AUTO_VOID_ENABLED`, and a **void-capable active provider** (`PAYMENT_PROVIDER_NAME=mock` today;
startup fails otherwise). Auto-void is **production-forbidden**. Void cancels an
authorized-not-captured payment only; it is NOT a refund and never touches captured money.

- **Check void eligibility / capture state:** `SELECT b.status, p.status AS payment_status,
p."amountMinor" FROM "Booking" b JOIN "Payment" p ON p."bookingId"=b.id WHERE b.id=$1;` Void is
  eligible only when `payment_status='AUTHORIZED'`, the booking is not CONFIRMED, and no ticket is
  issued. `SUCCEEDED`/`CAPTURED` → refund territory (Phase 6), never voided.
- **Dry-run:** `POST /admin/compensations/dry-run` with the discrepancy context; a captured
  payment yields a `PAYMENT_REFUND` action (financial=true, not auto).
- **Investigate ambiguous void:** events `booking.payment_void_requested` then
  `booking.payment_void_ambiguous`; the executor queries payment status
  (`booking.payment_status_recovered`) → VOIDED (finalize), AUTHORIZED (retry), CAPTURED (handoff).
- **Captured-payment handoff:** a superseded void (`state=CANCELLED`, reason
  `SUPERSEDED_BY_REFUND`) creates ONE `PAYMENT_REFUND` plan; verify no second refund plan shares
  the payment target (unique constraint). **No refund is executed in Phase 5.**
- **Provider-voided / local-pending:** if the provider shows the authorization cancelled but the
  local `Payment.status` is still AUTHORIZED, re-run the void (idempotent) — the guarded finalize
  moves it to VOIDED exactly once.
- **Disable auto-void:** set `_AUTO_VOID_ENABLED=false` — planning continues; in-flight records
  sit in MANUAL_REVIEW. Health `GET /health/compensation` → `void.*` counts show the backlog.

## Verify no double refund / no duplicate provider cancellation

- One refund plan per (payment, reason) via the unique constraint.
- One reservation/booking cancel per reference.
- Completed compensations never re-execute (terminal state, guarded transitions).
- The executor's provider/payment idempotency key is server-generated and stable.
