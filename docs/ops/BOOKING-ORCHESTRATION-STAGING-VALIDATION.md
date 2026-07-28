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

## P5.2B additions

Slice 1 (shipped) adds two staging checks:

- [ ] **Guest payment initiation** — `POST /bookings/guest/:id/pay` with the guest's
      `x-anon-session` returns one intent; a wrong/missing token → 401; an authed caller → 403.
- [ ] **Worker expiration sweep** — after a hold lapses, the worker marks the booking `EXPIRED`
      and the workflow follows (`sweepExpiredWorkflows`); a confirmed booking is never expired;
      re-running the sweep is a no-op.

### Provider-authoritative (Slice 3 — flows shipped; execute against the mock in staging)

Enable `BOOKING_PROVIDER_CONFIRMATION_ENABLED` + `BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED`
(non-prod) and seed a P4 `ProviderMapping` (status ACTIVE) for the event.

- [ ] Reserved-seat reserve→pay→confirm→ticket; workflow `PROVIDER_RESERVED`→…→`CONFIRMED`.
- [ ] GA quantity reserve→pay→confirm.
- [ ] Provider sold-out (`#soldout` ref) → `BOOKING_INVENTORY_UNAVAILABLE`, lock/hold released.
- [ ] Reservation expiry before payment → safe expire; no charge.
- [ ] Near-expired reservation → payment refused (TTL safety).
- [ ] Payment callback replay → one provider confirmation, one ticket set.
- [ ] Confirmation timeout / confirmed-response-lost → pending, then `recoverStatus` → confirmed.
- [ ] Status recovery → rejected → compensation-required (no refund in P5.2B).
- [ ] Local transaction failure after provider confirmation → MANUAL_REVIEW, evidence kept.
- [ ] Cancellation before payment → provider reservation cancelled + lock/hold released.
- [ ] Two API instances / two workers: one reservation per key; two workers cannot resolve one
      ambiguous outcome incompatibly (optimistic version guard).

### Allocated (Slice 4)

Enable `BOOKING_ALLOCATED_INVENTORY_ENABLED`; seed a `ProviderMapping`
(ownershipMode=ALLOCATED) + `ProviderInventoryState`.

- [ ] Seat inside allocation books; seat outside → `BOOKING_ALLOCATION_UNAVAILABLE`.
- [ ] GA within capacity books; exhausted → rejected; concurrent contention cannot exceed
      capacity (PostgreSQL authoritative).
- [ ] Allocation expiry/suspension blocks new bookings; confirmed bookings unaffected.
- [ ] Provider outage with a valid allocation still books.
- [ ] Two reconciliation workers compete → consistent classification, no double action.

These flows are proven at unit + mock-strategy level in the API suite; the checks above are the
**staging-required** DB/Redis/concurrency validation and are NOT yet executed.

### Compensation foundation (P5.3A — ADR-043)

Enable `BOOKING_COMPENSATION_ENABLED` + `_PLANNING_ENABLED` (and `_EXECUTION_ENABLED` for safe
actions; non-prod). No money moves in P5.3A.

- [ ] Plan creation for cases A–H produces the deterministic actions in the compensation matrix.
- [ ] Duplicate planning creates one record (unique constraint).
- [ ] Safe execution: Redis lock release completes; unpaid hold release / status recovery /
      local-confirm retry surface for handling.
- [ ] Stale-lease recovery returns PROCESSING → READY.
- [ ] Retry + dead-letter after exhausted attempts.
- [ ] Manual-review for every financial / confirmed-cancel / ambiguous case.
- [ ] Execution-disabled leaves plans untouched; rollback to compensation-disabled is clean.

Real-infra multi-instance concurrency (Slice A) + transactional allocation-accounting wiring
(Slice C) are **not yet implemented/executed** and remain for a follow-up increment.

## Sign-off

Record, per step: operator, timestamp, result, and the metric/DB evidence. Do not enable
active mode in production until every box above is checked in staging and the shadow-mode
mismatch rate is understood and near-zero.
