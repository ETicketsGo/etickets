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
two-worker claims). Full API suite **153 suites / 1079 tests**; tsc + build + worker + prettier
clean; migrations through `20260728110000` applied. **All compensation behaviour OFF by
default; no money movement executes.** P5.3A is closed; P5.3B (controlled payment void/refund +
provider-cancellation execution) is the next increment.
