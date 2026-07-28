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

## P5.2B — local-flow closure + provider booking abstraction (Slices 1–2 shipped)

**Slice 1 — local-flow closure (shipped).**

- _Guest payment initiation:_ `POST /bookings/guest/:id/pay` (public) requires a well-formed
  `x-anon-session` token in every mode (missing/malformed → 401), rejects an authenticated
  caller on the guest route (403), and routes through the single router → `beginPayment`
  (durable owner check in active mode). Server routes provider/amount/currency; the client
  supplies none; repeats return the same intent.
- _Worker expiration:_ after the authoritative `releaseExpiredHolds()` (unchanged PostgreSQL
  release), the hold-expiry job calls `orchestrator.sweepExpiredWorkflows()` in an explicit
  INTERNAL context. It is idempotent, advances only workflows whose booking is already
  `EXPIRED`, never a confirmed one, releases a surviving Redis lock, and runs AFTER release
  (not in the release tx) so a workflow-transition failure is reconcilable and never
  re-releases inventory.

**Slice 2 — provider booking abstraction (shipped, flag-off).**

- `ExternalBookingProvider` is a provider-neutral remote-booking-lifecycle seam
  (availability/reserve/confirm/cancel/status/refund), deliberately SEPARATE from the P1
  `InventoryProvider`, the P4 `InventorySyncProvider`, and payment providers. Every call is
  capability-gated and idempotency-keyed; results are summarized and PII/secret-free.
- `ExternalBookingProviderCapabilities` models provider differences explicitly;
  `selectProviderSequence()` picks the safe `RESERVE_PAY_CONFIRM` strategy and fails
  unsupported combinations BEFORE payment.
- `MockExternalBookingProvider` (dev/test only, not named after a real vendor) behaves as an
  external boundary with deterministic sold-out / reject / ambiguous-timeout / expiry /
  price-change / confirmed-response-lost fixtures and idempotent reserve/confirm/cancel. It is
  registered only behind `BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED` (startup forbids it in
  production).
- Durable provider references on `BookingWorkflow` (migration `20260727230000`): idempotency
  key, reservation expiry, version, attempt/error/response-category, confirmed/cancelled
  timestamps, reconciliation flag, provider-scoped unique reservation/booking refs, and
  pending-confirm / expired-reservation / reconciliation indexes.
- Typed failure classifications (§21) with safe customer mapping — ambiguous / post-payment /
  compensation cases surface as `BOOKING_PENDING_REVIEW`, never a false confirm or refund.
- New flags (all off): `BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED`,
  `BOOKING_ALLOCATED_INVENTORY_ENABLED`, `BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED`,
  `BOOKING_PROVIDER_RESERVATION_TTL_SAFETY_SECONDS`, `BOOKING_PROVIDER_MAX_ATTEMPTS`,
  `BOOKING_PROVIDER_CONFIRM_TIMEOUT_MS`. Startup rejects mock-in-prod, confirmation-without-
  mock, confirmation-in-prod (no real adapter yet), and allocated-without-sourcing.

## P5.2B — Slices 3–4: provider-authoritative + allocated flows (shipped, flag-off)

**Strategy dispatch.** The persisted `inventoryOwnershipMode` selects the flow; the client
never chooses it and a workflow never changes strategy mid-flow. `LocalBookingOrchestrator`
dispatches: LOCAL → the P5.1 local path; PROVIDER_AUTHORITATIVE → `ProviderAuthoritativeStrategy`
(only when `BOOKING_PROVIDER_CONFIRMATION_ENABLED`, else the clear unsupported error);
ALLOCATED → local path guarded by `AllocatedInventoryStrategy` boundary validation (only when
`BOOKING_ALLOCATED_INVENTORY_ENABLED`). There is **no mid-flow fallback** between strategies.

**Provider-authoritative flow.** The external provider owns inventory truth; the local
PostgreSQL hold is coordination-only and never counts as provider confirmation. Sequence:
`DRAFT→INVENTORY_RESOLVED→LOCK_PENDING→LOCKED→PROVIDER_RESERVATION_PENDING→PROVIDER_RESERVED`
(initiate: resolve provider via P4 `ProviderMapping` → capability `selectProviderSequence` →
Redis lock → local hold → idempotent `createReservation`, TTL persisted) → `PAYMENT_PENDING`
(beginPayment: TTL-safety window + server-authoritative price/currency check — never charge a
near-expired reservation or a changed price) → `PAYMENT_AUTHORIZED→PROVIDER_CONFIRM_PENDING→
PROVIDER_CONFIRMED→CONFIRMING→CONFIRMED` (on verified payment: provider confirm BEFORE the
atomic local confirm, via the bridge pre-confirm hook). Sold-out/rejected reservation releases
the lock+hold and fails safely; an **ambiguous** reserve/confirm is never read as
success/failure — it flags `providerReconciliationRequired` and stays pending.

**Ambiguous recovery.** `recoverStatus()` (gated by `BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED`)
queries `getBookingStatus` by reservation ref: CONFIRMED → complete the local confirm the
callback would have (confirmed-response-lost recovers without a double confirm); REJECTED/
EXPIRED → compensation-required; UNKNOWN → manual review. Idempotent; bounded.

**Local hold role for provider inventory.** Advisory P4 availability is never authoritative;
local inventory is not marked sold until provider confirmation; the local hold only prevents
duplicate ETicketsGo checkout attempts for the same mapped units.

**Allocated flow.** Locally authoritative within a bounded provider allocation — the normal
local path (Redis lock + PostgreSQL hold + local confirm) plus boundary validation from P4
`ProviderMapping` + `ProviderInventoryState`: active status, effective window, seat membership
(reserved), and `localConsumed + requested ≤ capacity` (GA). No per-booking provider call; a
provider outage does not block a valid allocation. Confirmed bookings are never auto-invalidated.

**Model decision.** No new allocation model — P4 `ProviderMapping` (ownershipMode=ALLOCATED,
`mappingMetadata` for status/window) + `ProviderInventoryState` (`providerCapacity`,
`seatStates`, `pendingLocal`) already represent every required allocation fact.

**Transaction boundaries.** The provider reservation/confirmation calls cannot be atomic with
PostgreSQL: the request idempotency key is persisted before the call so an ambiguous/lost
response is recoverable by key; the reservation result is persisted before continuing. The
final confirmation reuses the existing single atomic tx (local inventory + booking + workflow

- outbox). If it rolls back after provider confirmation, provider-confirmed evidence is kept
  and the workflow goes to MANUAL_REVIEW — the customer is never told confirmed until the local
  commit succeeds.

**Limited cleanup (P5.2B).** Release lock/hold on definitive reserve failure; flag
compensation-required when payment succeeded but the provider rejected; flag manual-review
when the provider confirmed but local confirmation failed; finalize/reconcile Redis after
commit. **No automatic refund/void** — that is P5.3.

**Reconciliation.** `classifyProvider` adds PROVIDER_CONFIRMATION_AMBIGUOUS,
PAYMENT_SUCCEEDED_PROVIDER_REJECTED, PROVIDER_RESERVATION_EXPIRED_PAYMENT_PENDING,
COMPENSATION_REQUIRED, PROVIDER_STATUS_STALE; the allocated classifier adds
ALLOCATION_CAPACITY_MISMATCH / _EXPIRED_WITH_ACTIVE_HOLDS / _SUSPENDED_WITH_ACTIVE_BOOKINGS /
_MAPPING_MISSING. Never auto-cancels a confirmed booking.

**Public status.** New states map via `toPublicBookingStatus` to PENDING (reservation/
confirm steps) — the customer never sees CONFIRMED until the local commit; MANUAL_REVIEW /
COMPENSATION_* → ACTION_REQUIRED.

**Verification.** Full API suite **144 suites / 1016 tests**; tsc + build + worker + prettier
clean; migration `20260728090000` applied. All provider/allocated flows OFF by default. Proof
is unit + strategy-level against the in-process mock provider (network-like idempotency +
ambiguity); DB-integration + concurrency against real Postgres/Redis + the full staging matrix
remain staging-required (see the staging guide) and were NOT executed here.

## Deferred to P5.2B+

Provider-authoritative + allocated flows; a mock provider-authoritative confirmation
adapter; the full automated compensation/refund matrix; cross-provider failover; real
commercial provider integration; end-to-end active-mode integration/concurrency executed
against real DB/Redis in staging. **Remaining within P5.2B:** provider-authoritative +
allocated flow wiring (Slices 3–4) and their transaction/integration/concurrency tests.

## Status / verification

Foundation (9 transition tests) + P5.1 (+31) + P5.2A (+27) + P5.2B Slices 1–2 (guest-pay
security, worker expiry sweep, mock provider / registry / sequence / failure mapping, provider
config matrix — +24). Full API suite **142 suites / 994 tests**; tsc + prettier + api build +
worker typecheck clean; migrations through `20260727230000_booking_workflow_provider_refs`
applied. Active mode + all provider flags remain OFF by default; real-infra active-mode e2e is
staging-only and NOT yet executed; provider-authoritative/allocated flows (Slices 3–4) are NOT
yet wired.
