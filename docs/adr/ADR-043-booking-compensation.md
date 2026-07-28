# ADR-043: Booking Compensation and Financial Recovery

- **Status:** Accepted (P5.3A foundation shipped: planning + safe non-financial execution; broad money movement deferred to P5.3B)
- **Date:** 2026-07-28
- **Deciders:** Principal Architect
- **Builds on:** ADR-041 (outbox), ADR-042 (booking orchestration)
- **Scope:** P5.3A — durable, idempotent compensation for booking discrepancies. NO broad automatic refunds/voids.

## Context

The P5.2B provider-authoritative and allocated flows produce discrepancy states
(`COMPENSATION_PENDING`, `MANUAL_REVIEW`, `providerReconciliationRequired`) but there was no
durable model or workflow to plan and safely execute recovery. Money must never move twice, a
provider booking must never be cancelled twice, and an uncertain financial state must never be
auto-resolved.

## Decision

A **focused, durable compensation model** — `BookingCompensation` (NOT a generic task table):
one row = one recovery action for one booking, with a DB-enforced idempotency identity so
duplicate planning/execution can never double-act. A deterministic **planner** converts a
server-derived discrepancy into required actions; a flag-gated **worker** executes ONLY the
safe non-financial actions. Money-moving actions (void/refund) and confirmed-provider-booking
cancellation are PLANNED but never auto-executed in P5.3A — they route to MANUAL_REVIEW.

### Compensation triggers

Planned from the P5.2B discrepancy signals: lock-ok/hold-fail, hold-ok/payment-create-fail,
payment-succeeded/provider-rejected, provider-confirmed/local-failed, local-confirmed/
redis-finalize-fail, provider-confirmed/capture-fail, ticket-issuance-fail, duplicate-callback.
See BOOKING-COMPENSATION-MATRIX.md (cases A–H).

### Model + idempotency

`BookingCompensation` (migration `20260728100000`): `compensationType`, `state`, `version`
(optimistic concurrency), `reasonCode`, `targetReference`, `generation`, payment/provider refs,
`amountMinor`/`currency`, server-generated `idempotencyKey`, `autoExecutable`, `attemptCount`/
`maxAttempts`, lease fields (`lockedBy`/`lockedAt`/`lockExpiresAt`), `availableAt`, audit
timestamps. **Uniqueness:** `(bookingId, compensationType, targetReference, generation)` +
unique `idempotencyKey` — a concurrent planner loses the race and re-reads the existing row.
One refund per payment+reason, one reservation cancel per reservation, one booking cancel per
provider booking, one local-confirm-retry per generation.

### State machine

`PLANNED → READY → PROCESSING → COMPLETED`, with `PROCESSING → RETRYABLE_FAILURE → READY`
(bounded backoff), `PROCESSING → MANUAL_REVIEW`, `PROCESSING → DEAD_LETTERED`. Terminal states
(COMPLETED/DEAD_LETTERED/CANCELLED) never reopen without an audited admin action; same-state
re-assertion is idempotent; a completed compensation is never re-executed.

### Planner vs executor

The `CompensationPlanner` is PURE + deterministic and NEVER executes — it returns a
`CompensationPlan { classification, actions, autoExecutable, requiresManualReview, reasonCode }`.
The `CompensationService` persists the plan (idempotent) and, only when execution is enabled,
runs the safe actions via a lease-based claim. Financial actions reaching a worker are forced
to MANUAL_REVIEW.

### Payment capability decisions

`choosePaymentCompensation` picks VOID vs REFUND from ACTUAL `PaymentProviderCapabilities` +
payment state: authorized-not-captured on an auth/capture provider → VOID; captured → REFUND;
capture state unknown → MANUAL_REVIEW. A captured payment is never labelled voidable.

### Provider cancellation distinction

`ExternalBookingProviderCapabilities.supportsCancel`/`idempotentCancellation` gate provider
cancellation. Cancelling an unconfirmed reservation ≠ cancelling a confirmed booking ≠
refunding the customer — provider cancellation does not imply a customer refund.

### Allocation cleanup

Held allocation is released exactly once on expiration/unpaid-cancellation; confirmed
consumption is NOT auto-released on refund (that policy is P5.3B / session rules).

### Reconciliation

Extends booking reconciliation to detect: compensation-required-but-no-plan, duplicate plans,
refund-completed/booking-not-updated, booking-refunded/payment-refund-missing, provider-
cancelled/payment-captured, payment-refunded/provider-active, hold-active-after-failure, redis-
lock-surviving-terminal, retry-exhausted, stuck-PROCESSING, dead-lettered, manual-review-
unresolved. Ambiguous financial discrepancies are never auto-resolved.

### Security

Clients cannot create compensations, choose type, request an amount, or trigger provider
cancellation; payment/provider references are server-derived; records are tenant-scoped; admin
ops are RBAC + audited; worker identity is internal; idempotency keys are server-generated; no
secrets/PII in events, logs, metrics, or admin responses.

### Feature-flag rollout

`BOOKING_COMPENSATION_ENABLED`, `_PLANNING_ENABLED`, `_EXECUTION_ENABLED`, `_AUTO_REFUND_ENABLED`,
`_AUTO_VOID_ENABLED`, `_AUTO_PROVIDER_CANCEL_ENABLED` (all off) + `_MAX_ATTEMPTS`, `_LEASE_SECONDS`,
`_POLL_INTERVAL_SECONDS`, `_MANUAL_REVIEW_THRESHOLD`. Startup rejects execution-without-planning,
planning-without-master, auto-money-without-execution, and ANY automatic money movement in
production in P5.3A.

## Admin operations + health (P5.3A shipped)

**Admin (`/admin/compensations`, RBAC ADMIN/SUPER_ADMIN, audited, never public):** list,
inspect, booking history + correlation chain, dry-run planner (read-only), approve, retry,
mark-manual-review, release-lease. **Tenant isolation on every query and mutation** — a
non-super-admin is narrowed to its tenant and cross-tenant access returns not-found; a missing
tenant fails closed. **Strictly non-financial in P5.3A:** approve/retry accept ONLY safe
non-financial actions; refund/void/confirmed-provider cancellation raise a typed FORBIDDEN.
No endpoint edits amount, compensation type, payment/provider references, or booking binding.

**Health (`GET /health/compensation`, public, counts-only — no ids/PII):** planning/execution
mode, per-state backlog (planned/ready/processing/retryable/dead-letter/manual-review/
completed), oldest-ready age, stale-lease count, last successful safe compensation,
provider-pending backlog, status-recovery backlog, allocation-drift count. Bounded gauges
`etg_booking_compensation_backlog{state}` + `_oldest_ready_age_seconds`.

## Phase 4 — provider reservation cancellation (P5.3B, shipped, off by default)

The first Phase-4 executor: `ProviderAuthoritativeStrategy.cancelReservation`, invoked by the
compensation worker (via the global bridge) for `PROVIDER_RESERVATION_CANCEL`, gated by
`BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED`.

- **Narrow eligibility:** UNPAID (no captured/succeeded payment) + UNCONFIRMED (workflow not
  provider/locally confirmed, `providerConfirmedAt` null) + provider `supportsCancel` &&
  `idempotentCancellation`. Anything else → NOT_ELIGIBLE / MANUAL_REVIEW; never a cancellation.
- **Idempotent + durable:** stable server key `wf:{id}:cancel`; the intent
  (`BookingProviderCancellationRequested`) is emitted BEFORE the provider call; a definitive
  OK/NOT_FOUND persists the cancellation exactly once (guarded `providerCancelledAt IS NULL`,
  `BookingProviderCancelled` recorded in the same tx). Duplicate workers/retries cancel once
  (lease-claimed record + idempotent provider call) — proven against real PostgreSQL.
- **Ambiguity-safe:** a timeout/ambiguous outcome is NEVER assumed cancelled — it queries
  provider status first, then RETRYABLE (still reserved) or MANUAL_REVIEW (unknown).
- **Never a refund:** provider cancellation performs no payment action.
- **Hold/lock policy:** on definitive cancellation the Redis coordination lock is released
  (idempotent); the local PostgreSQL hold is left to the durable unpaid-expiry sweep (the
  booking is unpaid — no money, and no second authoritative mutation races the sweep). A
  separate `LOCAL_HOLD_RELEASE` compensation may also cover it.
- **Financial reconciliation added:** `RESERVATION_CANCELLED_PAYMENT_PRESENT` (a captured
  payment alongside a cancelled reservation → MANUAL_REVIEW, never an auto refund) and
  `RESERVATION_ACTIVE_LOCAL_RELEASED` (orphaned external reservation to cancel).
- **Startup validation:** auto-provider-cancel requires execution + a registered provider
  (`BOOKING_PROVIDER_CONFIRMATION_ENABLED`); refund/void remain production-forbidden (Phase 5/6).

## Phase 5 — controlled payment void (P5.3B, shipped, off + production-forbidden)

`PaymentVoidExecutor` (invoked by the compensation worker for `PAYMENT_VOID`, gated by
`BOOKING_COMPENSATION_AUTO_VOID_ENABLED`) cancels an authorization ONLY when it is safe.

- **Honest capability model.** `PaymentProviderCapabilities` gains `supportsVoid` /
  `supportsIdempotentVoid` / `supportsPaymentStatusQuery`. Audit reality: **only the mock is
  void-capable** — Stripe/PayPal/Square are auth/capture-capable but not void-wired in the
  booking flow, and Razorpay is immediate-capture (refund-only). An immediate-capture provider's
  compensation stays `PAYMENT_REFUND`, never `PAYMENT_VOID`.
- **Authorized vs captured.** `PaymentStatus` gains `AUTHORIZED` + `VOIDED` (migration
  `20260728130000`). Void is eligible ONLY for `AUTHORIZED`-not-captured, unconfirmed +
  unticketed bookings, matching amount + currency, on a void-capable provider. **A captured
  payment is never voided.**
- **Idempotency + intent-before-call.** The record's stable server-generated key is reused on
  every retry/worker/admin-approval. `BookingPaymentVoidRequested` is emitted BEFORE the
  provider call (durable intent). A definitive success finalizes `payment→VOIDED` exactly once
  (guarded `updateMany` + `BookingPaymentVoided` in the same tx) — six concurrent finalizers
  apply once (same guarded pattern proven for reservation-cancel against real PostgreSQL).
- **Ambiguous-result recovery.** A timeout/ambiguous outcome is NEVER assumed — it queries
  payment status: `VOIDED/CANCELLED`→finalize once, `AUTHORIZED`→retry the idempotent void,
  `CAPTURED`→refund handoff, unknown→manual review. Void-response-lost recovers without a second
  financial action.
- **Captured-payment refund handoff.** On discovering capture, the executor creates ONE
  `PAYMENT_REFUND` plan (idempotent via the unique constraint) and supersedes the void
  (→ CANCELLED). **It executes no refund** (Phase 6). Concurrent workers create one refund plan
  (proven against real PostgreSQL).
- **Never money mislabelled.** A void is never marked refunded; a booking is never marked
  refunded or confirmed by the void path. Safe cleanup (hold/lock) stays with its own actions.
- **Rollout controls.** Off by default; startup rejects auto-void without execution, without a
  void-capable provider, and **in production**. Bounded metrics + counts-only void health.

## Rollout plan

Phase 0 disabled → 1 observe (classifications/metrics) → 2 plan (records, no execution) → 3
execute safe non-financial (lock release, unpaid hold release, status recovery, local-confirm
retry) → 4 provider reservation cancellation (unpaid/unconfirmed/idempotent) → 5 payment void
(authorized-not-captured + idempotent) → 6 refund (P5.3B only, after policy + staging + proof).

## Deferred to P5.3B

Broad automatic refunds/voids, confirmed-booking cancellation automation, partial refunds,
refund-fee/tax rules, settlement reversals, chargebacks, cross-provider failover, real
commercial provider, general saga engine.

## Status / verification

Model + migration + state machine + planner (A–H) + payment capability + repository
(idempotency/lease/retry/dead-letter) + safe processor + flags/validation + metrics + **admin
ops + health surfaces (P5.3A)**. Plus the P5.3A.1 follow-through: **transactional allocation
accounting** (oversell-proof held guard, real-Postgres proven), **transactional provider event
emission** (in-tx, exactly-once), and a **provider-authoritative real-Postgres HA harness**
(concurrent confirmation / confirmation-vs-expiration-vs-cancellation / idempotency /
two-worker claims). Plus **P5.3B Phase 4** (provider reservation cancellation) and **Phase 5**
(controlled payment void — authorized-not-captured only, capability-honest, intent-before-call,
finalize-once, ambiguous→status recovery, captured→one refund plan with no refund executed).
Full API suite **156 suites / 1120 tests**; tsc + build + worker + prettier clean; migrations
through `20260728130000` applied. **All compensation behaviour OFF by default; no captured money
moves.** P5.3A + P5.3B Phases 4–5 shipped; **Phase 6 (controlled refunds) remains** — only after
staging + policy approval + idempotency proof + monitoring.
