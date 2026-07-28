# ADR-041: Transactional Outbox and Durable Domain-Event Delivery

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Principal Architect
- **Relates to / extends:** ADR-038 (Domain Event Bus). Relates to ADR-039, ADR-040.
- **Scope:** P2.1 — the durable outbox foundation + a single proof slice only

## Context (audit findings)

The P2 `DomainEventBus` + `TransactionalEventPublisher` (`runWithEvents`,
`publishAfterCommit`) deliver events IN-PROCESS after commit, best-effort. That leaves a
crash window: PostgreSQL commits → process crashes → the domain event (and any deferred
work) is lost. P4 cache invalidation and the payments proof both publish post-commit and
are lossy on a crash. Reusable: the P2 `DomainEvent` envelope + factory + validation +
idempotency seam; the P4 durable-event pattern (atomic claim, failure classification,
health, ops, retention, metrics); `MetricsService`; `AuditService`; BullMQ worker
bootstrap; Prisma interactive transactions.

Flows that should stay synchronous (in the request tx) and NOT move to the outbox in
P2.1: ticket issuance, inventory settlement, payment state — they are the business
mutation itself. Future outbox-migration candidates (deferred): notifications,
settlement triggers, analytics, provider acknowledgements, cache invalidation as a
durable consumer. P2.1 migrates ONLY BookingConfirmed as the proof.

## Decision

Add a PostgreSQL transactional outbox that records domain events in the SAME transaction
as the business mutation, and a worker dispatcher that delivers them at-least-once via
the existing bus. We EXTEND the P2 seam — no second event abstraction.

### The durability boundary

The outbox row and the business mutation commit atomically. We never
"commit-then-insert" (that keeps the crash window) and never treat Redis or a BullMQ job
as the authoritative record. `TransactionalEventPublisher.recordInTransaction(tx, events)`
inserts rows using the caller's tx client; a serialization/size failure throws and rolls
the whole transaction back (required-event semantics).

### Feature modes (`DOMAIN_EVENT_DELIVERY_MODE`, default `in_process`)

- **in_process** — unchanged P2: no outbox row; direct post-commit publish.
- **outbox** — record durably in the business tx; the dispatcher delivers. No direct
  post-commit publish → exactly one production delivery path.
- **dual_write_shadow** — record `shadow=true` rows for comparison AND keep direct
  delivery. The dispatcher NEVER claims shadow rows, so there is no duplicate side
  effect. Shadow rows are purged by retention.

Dispatch is separately gated by `DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED` (default off).

### Schema

`OutboxEvent` (unique `eventId`; the full P2 envelope as columns; `status`, `priority`,
`shadow`, `availableAt`, `attemptCount/maxAttempts`, `lockedBy/lockedAt/lockExpiresAt`,
error fields, `payloadHash`; indexes on `(status, availableAt, priority, createdAt)`,
`(aggregateType, aggregateId)`, `correlationId`, `(status, lockExpiresAt)`).
`ProcessedDomainEvent` (unique `(eventId, handlerName)`, status PROCESSING/COMPLETED/
FAILED) for durable per-handler idempotency.

### Dispatcher — claim, lease, order

Claims a batch with a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
RETURNING …` — atomic, never a read-then-update race. Each claim leases the row
(`lockedBy` + `lockExpiresAt`) and increments `attemptCount`. Concurrent workers claim
disjoint rows (SKIP LOCKED). A crashed worker's lease expires and its rows are re-claimed
(the claim also picks up expired PROCESSING rows; a maintenance sweep resets them too).

**Ordering:** not global. Same-aggregate events deliver in creation order via a
`NOT EXISTS` guard (a row is ineligible while an earlier undelivered sibling of the same
`aggregateType+aggregateId` exists). Different aggregates process concurrently; a failing
aggregate blocks only itself (until it delivers or dead-letters), never unrelated ones.
Tradeoff: a stuck same-aggregate event delays its siblings until it dead-letters.

### Delivery + idempotency

The first adapter delivers to the in-process bus handlers, each under durable
idempotency: `claim(eventId, handlerName)` wins the right to run once (unique constraint);
an ALREADY_COMPLETED handler is skipped (replay), a FAILED one is re-claimed, IN_PROGRESS
defers. The event is DELIVERED only when ALL handlers complete; otherwise deliver throws
retryable and the dispatcher retries — completed handlers are never re-run. A crash after
a handler completes but before the row is marked DELIVERED causes redelivery, which the
COMPLETED idempotency row absorbs (at-least-once; consumers dedupe).

### Retry / dead-letter

Failures are classified: permanent (serialization/size/permanent) → DEAD_LETTERED;
unsupported-version / manual → MANUAL_REVIEW; everything else retryable with exponential
backoff + full jitter, bounded by `MAX_RETRY_SECONDS`, up to `MAX_ATTEMPTS` then
DEAD_LETTERED. Poison events never loop.

### BullMQ relationship

The PostgreSQL outbox is the source of truth. The worker's repeatable `outbox-dispatch`
job is a wake-up/poll; a lost signal loses nothing because polling recovers PENDING rows.
An event is never "delivered" because a job was enqueued.

## Failure scenarios (tested)

A rollback leaves no row; a crash after commit leaves PENDING work delivered later; a
dispatcher crash after claim → lease expiry → re-claim; handler success + crash before
DELIVERED → idempotent redelivery; one handler ok + one fails → completed not repeated,
failed retries; unsupported version → MANUAL_REVIEW; **outbox insert failure rolls the
business mutation back** (required-event, differs from P2 post-commit-failure behaviour);
duplicate confirmation → unique `eventId` records no second row; poison → bounded →
dead-letter.

## Health, metrics, operations, retention

Health (DISABLED/HEALTHY/DEGRADED/UNHEALTHY) from backlog / oldest-pending / dead-letter /
stale-lease + dispatcher heartbeat; read-only APIs are never gated by dispatcher lag.
Metrics: created/duplicate, claimed, delivery outcomes, handler replays, delivery + poll
latency, ops (low-cardinality labels only — never ids). Admin ops (RBAC + audit):
list/inspect/retry/retry-batch/cancel/manual-review/stale-recovery/aggregate-history/
correlation-chain — safe metadata only, no payload editing, no identity/type changes.
Retention (OFF by default): purge DELIVERED past the delivered window + DEAD_LETTERED past
a longer window; MANUAL_REVIEW is never auto-purged.

## Security model

Payload-size limit; catalogue version validation; safe JSON (no prototype-pollution
merges, no class instantiation from payload); RBAC + audit on replay/cancel; no secrets/
PII in payloads (BookingConfirmed carries ids/counts/amount strings only); tenant/actor
metadata preserved (no cross-tenant replay via the API); worker identity is server-side
(never client-controlled); the SQL claim is parameterized; no public event-creation API.

## Rollout

Phase 0 disabled (default) → 1 shadow record → 2 non-side-effecting consumer
(BookingEventRecorder) → 3 one idempotent reversible consumer → 4 notifications/settlement
→ 5 P5 booking orchestration. Irreversible handlers are not enabled early.

## Consequences

**Positive** — atomic event durability; safe multi-worker delivery; bounded retry +
dead-letter; durable idempotency; same-aggregate ordering; zero change when disabled.
**Negative** — required-event recording can now roll a business tx back on an outbox
failure (documented, intentional); same-aggregate head-of-line blocking; only
BookingConfirmed migrated; broker adapters deferred.

## Deferred

P5 booking orchestration; real provider booking confirmation; saga orchestration; full
migration of notifications/settlement/analytics; Kafka/SNS/SQS/EventBridge; multi-region
replication; CDC/Debezium; a general workflow/task engine; active Redis lock rollout.

## Verification

133 suites / 903 API tests green (+34); worker typecheck green; tsc + prettier clean;
migration applied. Tests cover serialization/validation/size/version, retry
classification + jittered backoff, durable idempotency claim, delivery all-complete /
retry / replay-skip / in-progress, dispatcher DELIVERED/retry/dead-letter/manual/stale,
publisher modes + rollback + outbox-insert-failure rollback, health states, recorder,
and the updated BookingConfirmed proof slice.
