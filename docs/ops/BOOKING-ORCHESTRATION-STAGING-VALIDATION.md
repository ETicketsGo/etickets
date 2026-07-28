# Booking Orchestration — Staging Validation (ADR-042 P5.2A)

A bounded, staging-only verification harness for taking the local-authoritative booking
orchestrator from **shadow** to **active**. It needs a real staging PostgreSQL + Redis and a
**sandbox** payment provider — **no production credentials**. Nothing here is marked complete
unless it was actually executed against staging; a checkbox left unchecked means "not yet
run", not "passed".

> These steps have NOT been executed as part of the P5.2A code increment. They are the gate
> for enabling active mode in a staging environment.

## Preconditions

- Migrations applied through `20260727213500_booking_workflow_ownership`.
- `INVENTORY_SOURCING_ENABLED=true`; a sandbox `PAYMENT_PROVIDER_NAME` (e.g. `stripe` test
  keys or `razorpay` test keys); if `DOMAIN_EVENT_DELIVERY_MODE=outbox`, the dispatcher on.
- Two API instances + at least one worker instance for contention/idempotency checks.

## Environment matrix

| Step | Flags                                | Expectation                                                                       |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------- |
| 1    | `BOOKING_ORCHESTRATOR_ENABLED=false` | Legacy booking works unchanged.                                                   |
| 2    | `ENABLED=true`, `MODE=shadow`        | Legacy response unchanged; shadow metrics increment; zero duplicate side effects. |
| 3    | `MODE=active` (+ prereqs)            | Boot succeeds; `GET /health/booking-orchestration` → `mode:active, ready:true`.   |

If step 3 prerequisites are missing, boot must **fail fast** — verify that too.

## Functional checklist (run in active mode)

- [ ] **1. Disabled legacy booking** — reserved-seat + GA create/pay/confirm on the legacy path.
- [ ] **2. Shadow booking** — same, response identical to legacy; `etg_booking_shadow_total` moves.
- [ ] **3. Active local reserved-seat initiation** — `POST /bookings` → existing response shape; a `BookingWorkflow` row exists at `LOCKED` with the durable owner set.
- [ ] **4. Active local GA initiation** — quantity-based, no seats; workflow reaches `LOCKED`.
- [ ] **5. Payment initiation** — `POST /bookings/:id/pay` → one intent/order; repeat → same intent (no second Stripe intent / Razorpay order).
- [ ] **6. Verified sandbox payment confirmation** — deliver signed `payment.succeeded`; booking `CONFIRMED`, tickets issued, workflow `CONFIRMED`, outbox `BookingConfirmed` recorded.
- [ ] **7. Duplicate payment callback** — re-deliver; `alreadyConfirmed`; no duplicate tickets/events/settlement; workflow stays `CONFIRMED`.
- [ ] **8. Unpaid cancellation** — `POST /bookings/:id/cancel` on a held booking releases the hold + Redis lock; workflow → `CANCELLED`; repeat is a no-op.
- [ ] **9. Hold expiration** — let a hold lapse; the durable sweep expires it; a confirmed booking is never expired.
- [ ] **10. Redis cleanup** — after confirm, the lock is finalized; after cancel/expire it is released; reconcile surfaces any survivor.
- [ ] **11. Outbox delivery** — `BookingConfirmed` delivers (dispatcher on) exactly once.
- [ ] **12. Ticket issuance** — tickets minted once; a post-confirm issuance retry never rolls back the booking.
- [ ] **13. Two-API-instance seat contention** — concurrent initiate on the same seat: exactly one hold; the other gets a clean conflict.
- [ ] **14. Two-worker expiration/outbox** — no duplicate expiration events; outbox `FOR UPDATE SKIP LOCKED` yields single delivery.
- [ ] **15. Owner-access rejection** — user B / foreign anonymous session gets 403 on pay/cancel/status of another owner's booking; cross-tenant access fails.
- [ ] **16. Rollback to disabled** — set `MODE=shadow` then `ENABLED=false`; in-flight workflows remain inspectable; new bookings use the legacy path; no data migration needed.

## Concurrency proofs (real infra)

- [ ] Concurrent initiation under one idempotency key → one booking (one `BookingWorkflow`).
- [ ] Concurrent payment initiation → one intent/order.
- [ ] Concurrent cancellation → one release.
- [ ] Payment confirmation vs expiration → confirmation wins; booking never both expired and confirmed.
- [ ] Payment confirmation vs cancellation → single terminal outcome.
- [ ] Two owners cannot claim one workflow (durable owner check + optimistic version bump).

## Sign-off

Record, per step: operator, timestamp, result, and the metric/DB evidence. Do not enable
active mode in production until every box above is checked in staging and the shadow-mode
mismatch rate is understood and near-zero.
