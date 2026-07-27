# ADR-042: Provider-Neutral Booking Orchestration

- **Status:** Accepted (P5.1 local-authoritative orchestrator + shadow shipped; provider-authoritative/allocated/compensation in progress)
- **Date:** 2026-07-27
- **Deciders:** Principal Architect
- **Builds on:** ADR-037 (sourcing), ADR-038 (events), ADR-039 (locking), ADR-040 (sync), ADR-041 (outbox)
- **Scope:** P5 — one provider-neutral booking orchestration engine

## Context (existing booking audit)

Today `BookingsService.create` places an oversell-proof PostgreSQL hold (seat via
`ShowSeat`, GA via `TicketInventory`) inside one `$transaction`, HOLD_MINUTES=10;
`PaymentsService.confirm` flips PENDING_PAYMENT→CONFIRMED (idempotent `alreadyConfirmed`
guard), issues tickets, and (P2.1) records `BookingConfirmed` in-tx; `releaseExpiredHolds`
expires holds on a worker interval; refunds/cancellations live in their own services.
Customer-visible status is `BookingStatus` (PENDING_PAYMENT/CONFIRMED/…). The P1–P4 + P2.1
seams (resolver, lock service, providers, outbox) exist but are **not yet composed** into
one workflow — booking decisions are spread across controllers + services.

## Decision

Introduce ONE provider-neutral `BookingOrchestrator` that owns every booking workflow
decision across local-authoritative, provider-authoritative, and allocated inventory,
reserved seats and GA quantity, authenticated + anonymous owners, and all payment
providers. Controllers and payment webhooks invoke the orchestrator; domain services keep
their own mutations (no duplicated inventory/payment logic). A durable `BookingWorkflow`
record + an explicit state machine make every transition guarded, idempotent, auditable,
and optimistic-concurrency protected. **`BookingStatus` is unchanged** — the orchestrator
maps its internal workflow onto it at milestones. Legacy behaviour stays behind
`BOOKING_ORCHESTRATOR_ENABLED=false`.

### State machine (shipped)

Internal states `DRAFT → INVENTORY_RESOLVED → LOCK_PENDING → LOCKED → PAYMENT_PENDING →
PAYMENT_AUTHORIZED → (PROVIDER_CONFIRM_PENDING → PROVIDER_CONFIRMED)? → CONFIRMING →
CONFIRMED → TICKET_PENDING → TICKET_ISSUED`, with branch states `CANCELLATION_PENDING/
CANCELLED`, `REFUND_PENDING/REFUNDED`, `EXPIRING/EXPIRED`, `COMPENSATION_PENDING/
COMPENSATED`, `MANUAL_REVIEW`, `FAILED`. The transition matrix
(`booking-workflow.transitions.ts` + BOOKING-STATE-TRANSITION-MATRIX.md) is the single
source of legal moves; `assertTransition` rejects illegal moves visibly; terminal states
have no outgoing transitions; re-asserting the current state is an idempotent no-op. A paid
booking can never go straight to CANCELLED — it routes through REFUND_PENDING.

### Durable workflow (shipped)

`BookingWorkflow` (unique `bookingId`, `state`, `version` for optimistic concurrency,
`selectedProviderCode`, `inventoryOwnershipMode`, `lockId` + `fencingToken` for
bidirectional lock↔booking reconciliation, `paymentProvider`, provider references,
`attemptCount`, `nextActionAt`, `lastErrorCode`, `manualReviewReason`, `correlationId`,
`idempotencyKey`). Optimistic concurrency (guarded version bump) prevents two workers or
callbacks advancing the same workflow inconsistently. No secrets / raw provider payloads.

### Contract (shipped)

`BookingOrchestrator` = `initiate / beginPayment / confirmPayment / cancel / expire /
retry / reconcile`. Errors are typed + client-safe (invalid-transition, workflow-conflict,
provider-confirm-failed, compensation-required, idempotency-conflict).

### Planned flows (in progress)

- **Local-authoritative:** resolve local provider → (active) Redis lock → PostgreSQL hold
  - persist lock identity → payment intent → payment confirm → InventoryStrategy confirm →
    record outbox events in-tx → commit → release/confirm Redis lock → downstream handlers.
    Payment failure leaves the booking unconfirmed; hold/lock expire per policy; no
    BookingConfirmed emitted.
- **Provider-authoritative:** capability-driven (reserve-before-payment vs authorize-then-
  confirm vs confirm-then-capture). Never blindly forced; the safest supported strategy is
  selected and documented per provider capability.
- **Allocated:** ETicketsGo owns inventory within the allocation (local strategy
  authoritative); provider not called per booking unless the contract requires it;
  reconciliation validates allocation drift.

### Compensation (planned, matrix defined)

Formal matrix for: lock ok/DB fail; DB hold ok/payment-create fail; payment ok/provider
fail; provider ok/DB-confirm fail; DB confirm ok/Redis-finalize fail; provider ok/capture
fail; ticket-issue fail post-confirm; duplicate callback. Every compensation action is
idempotent + auditable; **never auto-refund/cancel a confirmed booking on one uncertain
external response** — bounded attempts then MANUAL_REVIEW.

### Durable workflow events (planned)

Use the P2.1 outbox for required facts (BookingInitiated/InventoryResolved/LockAcquired/
PaymentPending/PaymentAuthorized/ProviderConfirmationRequested/ProviderConfirmed/
Confirmed/…/Compensated/ManualReviewRequired). Events are completed facts, not synchronous
RPC. No excessive chatter.

### Timeout policy (planned)

One documented policy coordinating Redis lock TTL, PostgreSQL hold expiry, payment
timeout, provider reservation expiry, and workflow timeout — no contradictory timers can
independently cancel a confirmed booking. Reuse BullMQ hold expiry; Redis TTL alone is not
a durable expiration event (durable outbox/workflow rows drive follow-up).

### Security

Client cannot select provider / inventory scope / fencing token, cannot confirm another
owner's lock or reuse another's payment reference; anonymous-session ownership protected;
server recomputes authoritative amount + currency (client price never trusted); admin
retry/compensation RBAC + audited; tenant/organizer isolation; no card/secret storage.

## Feature-flag rollout

`BOOKING_ORCHESTRATOR_ENABLED=false` (default) · `BOOKING_ORCHESTRATOR_MODE=shadow`
(records a durable workflow with NO duplicate payment/inventory/provider side effect) ·
`BOOKING_PROVIDER_CONFIRMATION_ENABLED` · `BOOKING_COMPENSATION_ENABLED` ·
`BOOKING_RECONCILIATION_ENABLED` (all off). Immediate fallback to the legacy path at any
time. Startup validation gates unsafe combinations.

## Deferred (not in P5)

Real commercial provider integration; theatre portal / seat-map UI; waiting room; bot
detection; dynamic pricing; recommendation/loyalty; settlement redesign; general saga
engine; Kafka/SNS/SQS/EventBridge; multi-region consensus; microservice extraction; full
notification migration.

## P5.1 — concrete local-authoritative orchestrator + shadow (shipped)

`LocalBookingOrchestrator` implements the contract for **LOCAL_AUTHORITATIVE** inventory by
COMPOSING existing seams (no duplicated logic): `InventoryResolver` (server-side provider
selection; non-LOCAL → clear unsupported error, no fake success), `InventoryLockService`
(active mode: acquire before the hold, release on hold failure, finalize after commit),
`BookingsService.create` (the PostgreSQL hold), `PaymentsService.createIntent`
(idempotent payment), `PaymentsService.processVerifiedEvent` (the existing atomic
confirm + inventory + outbox `BookingConfirmed`, `alreadyConfirmed` preserved). A
`BookingWorkflowRepository` drives every transition with optimistic concurrency (guarded
`UPDATE … WHERE id+version+state`; lost race → idempotent replay or typed conflict) and
idempotency (unique `(workflowType, idempotencyKey)` + request fingerprint → conflict on
reuse-with-different-request). Local path: `DRAFT→INVENTORY_RESOLVED→LOCK_PENDING→LOCKED`
(initiate) → `PAYMENT_PENDING` (beginPayment) → `PAYMENT_AUTHORIZED→CONFIRMING→CONFIRMED`
(confirmPayment). `expire`/`cancel`/`retry`/`reconcile` coordinate the local workflow
safely (unpaid cancel releases; paid cancel → refund-pending; confirmed never expired;
reconciliation classifies local drift, never auto-refunds). **Shadow mode**
(`BookingShadowObserver`, wired into `BookingsService.create`) observes provider
resolution + workflow expectation with ZERO side effects and classifies mismatches; the
P3 seat-lock shadow already covers lock observation. Startup validation: active
orchestration requires `INVENTORY_SOURCING_ENABLED`; active locking requires active
orchestration. Metrics `etg_booking_orchestration_*` + `etg_booking_shadow_*` (bounded
labels, no ids).

**Transaction boundaries:** the Redis lock is acquired/released OUTSIDE the PostgreSQL tx
(compensation releases it if the hold tx fails); confirmation reuses the existing atomic
`confirm` (inventory + booking + outbox in one tx — an outbox insert failure rolls the
confirmation back); Redis finalize is post-commit and a cleanup failure is reconcilable,
never a rollback.

## Deferred to P5.2+

Provider-authoritative + allocated flows; a mock provider-authoritative confirmation
adapter; the full automated compensation matrix; full refund orchestration; the active
booking API controller wiring + durable owner check; end-to-end active-mode integration/
concurrency against real DB/Redis.

## Status / verification

Foundation (9 transition tests) + P5.1 (repository optimistic-concurrency/idempotency,
orchestrator initiate/beginPayment/confirmPayment + unsupported + compensation, shadow
observer, config matrix — +31 tests). Full API suite **138 suites / 943 tests**; tsc +
prettier clean; worker typecheck green; migrations `20260727204643` +
`booking_workflow_fingerprint` applied.
