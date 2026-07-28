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

## Enable shadow mode, then active mode (P5.2A)

1. **Shadow:** `BOOKING_ORCHESTRATOR_ENABLED=true`, `BOOKING_ORCHESTRATOR_MODE=shadow`. The
   legacy path stays authoritative; the router returns the legacy response and observation
   runs with zero side effects. Watch `etg_booking_shadow_mismatch_total{category}` for a
   soak period.
2. **Active prerequisites (enforced at startup):** `INVENTORY_SOURCING_ENABLED=true`; in
   production a real `PAYMENT_PROVIDER_NAME` (not `mock`); under
   `DOMAIN_EVENT_DELIVERY_MODE=outbox`, `DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED=true`. Boot
   fails fast otherwise — that is intended, not a bug.
3. **Active:** `BOOKING_ORCHESTRATOR_MODE=active`. New bookings route through the
   orchestrator; `GET /health/booking-orchestration` shows `mode:"active"`,
   `ready:true`. Roll back instantly with `MODE=shadow` or `ENABLED=false`.

## Test ownership (active mode)

- **Authenticated:** a booking created by user A returns 403 (`FORBIDDEN`) on
  `POST /bookings/:id/pay` or `/cancel` for user B — the durable `ownerType=USER,ownerId`
  is checked, not just the id.
- **Anonymous:** a guest `POST /bookings/guest` returns a one-time `anonymousSessionToken`.
  Subsequent `x-anon-session` must present that exact token; a different/absent token is
  rejected. Only the SHA-256 hash is stored (`SELECT "ownerType","ownerId"` shows a hex
  hash, never the raw token).

## Test payment callbacks (active mode)

Deliver a verified sandbox `payment.succeeded` webhook. The atomic confirm commits, then the
confirmation bridge advances the workflow to `CONFIRMED` (`SELECT state`). Re-deliver the
same callback: `alreadyConfirmed` short-circuits and the workflow replays to `CONFIRMED` with
no duplicate tickets/outbox/settlement. `etg_booking_orchestration_total{op="confirm_sync"}`
tracks bridge activity.

## Investigate idempotency conflicts

`etg_booking_owner_rejection_total{reason}` + `BOOKING_IDEMPOTENCY_CONFLICT` errors mean the
same scoped key was reused with a different normalized request. Scope is
`tenant:owner:operation:key`. Inspect the workflow's `requestFingerprint`; a legitimate retry
must send the identical request.

## Public status mapping reference

Internal → public (`toPublicBookingStatus`):

- `CONFIRMED` / `TICKET_PENDING` / `TICKET_ISSUED` → `CONFIRMED`
- `DRAFT` … `CONFIRMING` (incl. `PROVIDER_CONFIRM_PENDING` / `PROVIDER_CONFIRMED`) → `PENDING`
- `CANCELLATION_PENDING` / `CANCELLED` → `CANCELLED`
- `EXPIRING` / `EXPIRED` → `EXPIRED`
- `REFUND_PENDING` → `REFUND_PENDING`; `REFUNDED` → `REFUNDED`
- `MANUAL_REVIEW` / `COMPENSATION_PENDING` / `COMPENSATED` / `FAILED` → `ACTION_REQUIRED`
  (never `CONFIRMED`)

The authoritative customer status remains `Booking.status`; active mode does not change its
meaning. Internal states are never leaked to the public API.

## Guest payment (P5.2B)

`POST /bookings/guest/:id/pay` requires the `x-anon-session` token in every mode. Missing/
malformed → 401; an authenticated caller on this route → 403. `etg_booking_owner_rejection_total
{op="begin_payment",reason}` tracks rejections (`missing_anonymous_token`,
`user_on_guest_route`). The server routes provider/amount/currency; none is client-supplied.

## Worker expiration sweep (P5.2B)

The hold-expiry job runs `releaseExpiredHolds()` (authoritative) then
`orchestrator.sweepExpiredWorkflows()` (INTERNAL context). The sweep only advances workflows
whose booking is already `EXPIRED`, never confirmed ones, and releases a surviving Redis lock.
It runs AFTER release, so a transition failure (`etg_booking_orchestration_total
{op="expire_sweep",outcome="transition_failed"}`) is reconcilable and never re-releases
inventory. Repeated sweeps + worker restarts are idempotent.

## External booking providers (P5.2B — Slice 2 foundation)

The `ExternalBookingProvider` seam + `MockExternalBookingProvider` are wired but the
provider-authoritative and allocated FLOWS are not yet routed through the orchestrator
(Slices 3–4). Flags `BOOKING_PROVIDER_CONFIRMATION_*`, `BOOKING_ALLOCATED_INVENTORY_ENABLED`,
`BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED` are OFF by default; the mock is dev/test-only and
rejected in production. When Slices 3–4 land: investigate reservations via the
`providerReservationId`/`providerStatus`/`providerReservationExpiresAt` columns; ambiguous
provider outcomes enter status-recovery (never a false confirm); a failed external provider
must not block unrelated local or allocated bookings.

## Verify no double booking / no duplicate charge

- Seat oversell is structurally impossible (ADR-039 checks + `ShowSeat` unique + the hold
  guard) regardless of orchestrator mode.
- One idempotency key → one `BookingWorkflow` (unique `(workflowType, idempotencyKey)`) →
  one booking; a changed request under the same key returns a typed conflict.
- Duplicate payment callbacks confirm once (`alreadyConfirmed` + the outbox `eventId`
  unique + durable per-handler idempotency).
- Two workers advancing one workflow: only one wins the guarded version bump; the loser
  replays or gets a conflict.
