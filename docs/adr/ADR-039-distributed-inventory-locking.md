# ADR-039: Distributed Inventory Locking with Redis and PostgreSQL

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Principal Architect
- **Relates to:** ADR-010 (Inventory Strategy), ADR-013 (Seat Reservation), ADR-037 (Inventory Sourcing), ADR-038 (Domain Event Bus)
- **Scope:** P3 — the distributed Redis seat-lock engine only

## Context (existing hold architecture)

- **Seat inventory** = `ShowSeat` rows (`status` AVAILABLE/HELD/SOLD, `holdBookingId`,
  `holdExpiresAt`, `version`), `@@unique([eventSessionId, seatId])`. The authoritative
  double-book guard is a conditional `UPDATE … WHERE status='AVAILABLE'` with an
  affected-row-count check (ADR-013).
- **Quantity inventory** = `TicketInventory` counters guarded by
  `WHERE (total-sold-held) >= qty`.
- **Hold** = one Prisma `$transaction`, `HOLD_MINUTES=10`, `holdExpiresAt`. **Durable
  expiration** = `BookingsService.releaseExpiredHolds` (PENDING→EXPIRED + payment
  FAILED), run on a worker interval.
- **Redis** = one shared ioredis client (`RedisService`); cache used raw keys; **no
  Lua, no distributed lock, no Redlock, no fencing** existed.
- **BullMQ** = a single `holds` queue + interval sweeps; no keyspace notifications.

Under high contention on a single hot show, every node races the same Postgres rows.
Postgres keeps this correct, but there is no _fast, cross-node_ rejection layer to shed
contention before the transaction, and no short-lived ownership visible across nodes.

## Decision

Add a **distributed Redis seat-lock engine** as a FAST coordination + expiration layer
**in front of** PostgreSQL — never replacing it. Layered correctness:

```
Redis       fast temporary coordination · TTL · cross-node visibility · contention rejection · short-lived ownership
PostgreSQL  authoritative inventory + booking state · final oversell protection · audit · recovery
```

A Redis success never proves a booking; **a PostgreSQL commit is the only authoritative
confirmation.** New code lives in `apps/api/src/inventory/locking/`; domain modules
depend on `InventoryLockService`, never on Redis commands.

### Seat vs quantity locking

- **Seat** — one Redis key per unit (`seat:{inventoryKey}:{seatId}` = owning lockId).
  Acquisition is **all-or-nothing** across all requested seats.
- **Quantity** — a ZSET (`qty:{inventoryKey}`, member=lockId, score=expiryMs) + HASH
  (`qtyh:{inventoryKey}`, lockId→qty). Held = sum of non-expired members; capacity is
  an **advisory snapshot** — PostgreSQL still performs the authoritative capacity check.

### Atomicity mechanism

Every acquire/renew/release runs as a single **Redis Lua script** (server-side, atomic)
— never GET-then-check-then-SET. Seat acquire verifies all seats free, INCRs the fence,
writes all seat keys + lock JSON + idempotency record, and applies TTL in one step.
Quantity acquire lazily purges expired ZSET members, sums held, compares to capacity,
and adds its slot — atomically, so two requests can never jointly exceed capacity.

### Fencing tokens

Each acquisition INCRs a per-scope counter (`fence:{inventoryKey}`) and returns a
**monotonically increasing** token embedded in the lock. Renew/release/validate/confirm
reject a request whose token ≠ the current lock's token, so a stale owner (post-expiry
or superseded) cannot act. The token is exposed through the contract; a future external
provider validates it on any inventory mutation.

### Idempotency

`acquire` takes an idempotency key. Same key **+ same normalized request fingerprint** →
the same lock (`REPLAY`). Same key + **different** inventory/quantity/owner/session →
`IDEMPOTENCY_CONFLICT` (typed). Release and renew are idempotent; confirmation never
creates a second lock/hold.

### TTL, renewal, max lifetime

TTL (`INVENTORY_LOCK_TTL_SECONDS`, default 300) expires temporary ownership fast.
Renewal is allowed only inside the renewal window (`…RENEWAL_WINDOW_SECONDS`, 120) and
never past the hard `…MAX_LIFETIME_SECONDS` (900) from first acquisition — locks are
never renewable forever. Renewal validates ownership + fencing token + active status and
extends TTL atomically across all keys.

### PostgreSQL confirmation sequence

```
validate lock (active + fencing token + ownership)
  → run the authoritative PostgreSQL transaction (InventoryStrategy confirm + commit)
  → mark the Redis lock CONFIRMED
  → publish domain events AFTER commit (when DOMAIN_EVENTS_ENABLED)
```

Redis is **never** marked sold before the DB commits. If the DB fails: the lock stays
ACTIVE (TTL / explicit release), a typed failure is returned, retry-safe. If the DB
commits but Redis cleanup fails: the booking **stands**, and an observable
reconciliation requirement is recorded — never a fake rollback.

### Redis outage behaviour

- **Disabled** → the legacy PostgreSQL path, no Redis dependency.
- **Shadow** → continue through PostgreSQL; record the Redis failure as a metric.
- **Active** → **fail closed** for reserved-seat acquisition (typed
  `INVENTORY_LOCK_REDIS_UNAVAILABLE`) rather than risk split-brain; readiness reports
  unhealthy so lock traffic isn't routed to that node. No silent Redis bypass in active
  mode.

### BullMQ relationship

Redis TTL removes _temporary ownership_ fast; it is **not** a durable business event.
The existing BullMQ/worker sweep (`releaseExpiredHolds`) remains the authoritative
expirer of the **PostgreSQL** hold (→ EXPIRED + payment FAILED + notifications). The two
are complementary; expiration handlers stay idempotent, and we did not add keyspace
notifications or a second queue framework.

### Reconciliation

A focused, bounded reconciler scans Redis locks and compares each to its authoritative
booking, classifying: `REDIS_LOCK_WITHOUT_DB_HOLD`, `DB_HOLD_EXPIRED_REDIS_SURVIVING`,
`DB_CONFIRMED_REDIS_STILL_ACTIVE` (all safe auto-repairs), and
`REDIS_CONFIRMED_DB_NOT_CONFIRMED` (**manual review** — never auto-resolved against the
source of truth). It is flag-gated and detect-only unless `repair` is requested.

### Security controls

Max seats/quantity per request, per-owner active-lock cap, ownership validation
(constant-time compare), server-validated inventory scope only (no client-supplied Redis
keys or fencing tokens beyond the opaque credential returned), and safe error mapping
(no Redis internals/keys/topology leaked). No PII in keys, values, logs, or metrics.

### Metrics & health

`etg_inventory_lock_ops_total{op,outcome}`, `…_op_duration_seconds{op}`,
`…_contention_total{inventory_type,scope}`, `…_reconcile_total{result}`. A health
reporter distinguishes disabled/shadow/active + Redis reachability and drives readiness
for lock-requiring endpoints in active mode (without marking read-only APIs unhealthy).

### Feature-flag rollout (proof = Shadow, Option A)

`INVENTORY_LOCKS_ENABLED` defaults **off**. The chosen proof integration is **shadow
mode**: after the authoritative PostgreSQL hold succeeds, `InventoryLockShadowService`
attempts a Redis lock purely to measure what the distributed layer would decide, then
releases it — changing no booking behaviour and publishing no events. Active mode
(gating acquisition before the DB tx) is implemented in the engine but deliberately not
wired into the booking hot path in P3.

## Consequences

**Positive** — cross-node contention rejection, atomic multi-seat + capacity locks,
fencing against stale owners, idempotent acquisition, safe confirmation sequencing, and
a reconciliation seam, all with PostgreSQL still the final authority and zero change when
disabled.

**Negative / limitations** — in-process Redis coordination is single-instance (no
multi-region consensus — deferred); the DB→Redis "missing lock" reconciliation direction
needs a persisted `lockId` on the booking (a future migration); shadow mode proves the
engine but does not yet gate production bookings.

## Deferred (future work)

Active-mode wiring into `BookingsService`; persisting `lockId` on the booking for full
bidirectional reconciliation; P2.1 transactional outbox; external aggregator sync;
InventoryResolver integration; Kafka/SNS/SQS/EventBridge; client seat-map redesign;
dynamic pricing; waiting room; bot detection; multi-region Redis consensus.

## Compliance / verification

Unit tests (validation, idempotency, ownership, fencing, renewal window/max-lifetime,
release, capacity, error mapping, feature-disabled, shadow, reconciliation classes,
health, confirmation sequencing/failure/cleanup-failure) + **real-Redis concurrency**
proofs (exactly one owner wins a contested seat; quantity fills to exactly capacity;
all-or-nothing multi-seat; idempotent replay; monotonic fencing). Full API suite green
(115 suites / 813 tests); worker typecheck green; prettier clean.
