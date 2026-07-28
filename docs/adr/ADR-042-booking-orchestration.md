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

## P5.2A — active API wiring, durable ownership, local end-to-end (shipped)

The P5.1 orchestrator is now reachable through the existing booking APIs in **active** mode
while disabled/shadow stay byte-for-byte unchanged.

**One routing decision point.** `BookingExecutionRouter` is the ONLY place that reads the
mode flags. Controllers call it and nothing else re-checks the mode. Per operation it picks
exactly one path: `disabled`/`shadow` → legacy `BookingsService`/`PaymentsService` (shadow
observation still happens inside `create()`), `active` → `LocalBookingOrchestrator` for
LOCAL_AUTHORITATIVE inventory. There is **no silent mid-flow fallback** — once an active
workflow begins, a dependency failure surfaces a typed error; the legacy path is only chosen
before any workflow starts and only when the orchestrator is globally disabled. The booking
controllers were moved into `BookingOrchestrationModule` so they can inject the router
without a DI cycle (that module imports Bookings + Payments one-directionally).

**Durable, server-decided ownership.** New `BookingOwnerType` enum + `ownerType`/`ownerId`/
`tenantId`/`organizerId` on `BookingWorkflow` (migration `20260727213500`, all nullable).
`BookingOwnerResolver` derives the owner from the trusted principal (USER), a server-issued
anonymous session (ANONYMOUS_SESSION), or an explicit INTERNAL context — never from the
request body/query. Every customer operation (`beginPayment`/`cancel`, and replayed
`initiate`) validates the request owner against the durable owner in constant time; a valid
booking id alone never authorizes access, and cross-user / cross-session / cross-type access
is rejected. Legacy pre-ownership rows (null owner) fall back to the underlying service check
and are never falsely rejected.

**Anonymous checkout identity.** ETicketsGo had no anonymous-session scheme, so guest
ownership is a dedicated opaque token (`AnonymousSessionService`): 256 bits of entropy,
`anon_`-prefixed, minted server-side, carried in the `x-anon-session` header, compared in
constant time, and persisted ONLY as a SHA-256 hash (the raw token never touches the DB or
logs). It is not derived from email/phone/IP/device/UA and cannot be supplied as an arbitrary
owner id. A brand-new guest checkout is issued one and it is returned once as an additive
`anonymousSessionToken` field (active mode only).

**Confirmation routing without recursion.** The payment webhook stays authoritative and
atomic (`processVerifiedEvent` → `confirm`). After it commits, a one-way
`BookingConfirmationBridge` (global; both sides depend on it, not on each other) advances the
durable workflow to CONFIRMED via `orchestrator.syncWorkflowConfirmed` — no re-confirmation,
no PaymentsService↔Orchestrator cycle, no-op unless a workflow exists (active mode).
`alreadyConfirmed` idempotency and single-issue guarantees are unchanged.

**Public compatibility.** Route paths, methods, auth, request/response schemas, and error
conventions are preserved. Active `initiate` rebuilds the exact legacy create-response shape
from durable data; internal workflow state is never exposed. Public status uses the existing
customer vocabulary via `toPublicBookingStatus` (COMPENSATION_PENDING / PROVIDER_CONFIRM_*/
MANUAL_REVIEW → `ACTION_REQUIRED`, never `CONFIRMED`). A new additive `POST /bookings/:id/
cancel` (+ guest variant) coordinates unpaid cancellation; paid → refund-pending.

**Startup validation (extended).** Active orchestration fails boot unless
`INVENTORY_SOURCING_ENABLED`; in production it additionally requires a real
`PAYMENT_PROVIDER_NAME` (not mock) and, under `outbox` delivery, a running dispatcher.

**Internal workers.** `BookingOwnerResolver.internal(actor)` yields an explicit INTERNAL
context; the confirm bridge + reconciliation use privileged, non-customer paths — no
`skipAuthorization` flag exists.

**Observability.** `etg_booking_api_total{op,mode,owner_type}`,
`etg_booking_owner_rejection_total{op,reason}`, `etg_booking_legacy_fallback_total{op}` (all
bounded, no ids); active operations are audited (`BOOKING_*_ACTIVE`) with safe metadata only.
`GET /health/booking-orchestration` reports mode + drift counts (stuck workflows, manual-
review backlog). Rate limiting reuses the global `ThrottlerGuard`.

## Deferred to P5.2B+

Provider-authoritative + allocated flows; a mock provider-authoritative confirmation
adapter; the full automated compensation matrix; full refund orchestration; a public guest
payment-initiation endpoint; worker/expiration `expire()` wiring into the durable sweep;
end-to-end active-mode integration/concurrency executed against real DB/Redis in staging.

## Status / verification

Foundation (9 transition tests) + P5.1 (+31) + P5.2A (owner/anon-session security, router
mode-routing, public status mapping, active config matrix — +27). Full API suite **141
suites / 970 tests**; tsc + prettier + api build + worker typecheck clean; migrations
`20260727204643`, `booking_workflow_fingerprint`, `20260727213500_booking_workflow_ownership`
applied. Active mode remains OFF by default; real-infra active-mode e2e is staging-only and
NOT yet executed.
