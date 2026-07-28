# Operational Runbook — Distributed Inventory Locks (ADR-039)

Fast operational reference for the Redis seat-lock engine. **PostgreSQL is always the
source of truth**; Redis is the fast coordination + expiration layer. When in doubt,
trust PostgreSQL.

Key prefix: `etg:{APP_ENV}:invlock:*`. No PII is stored in keys or values.

## Feature flags

| Flag                                    | Default  | Meaning                                                 |
| --------------------------------------- | -------- | ------------------------------------------------------- |
| `INVENTORY_LOCKS_ENABLED`               | `false`  | Master switch. Off ⇒ legacy PostgreSQL path only.       |
| `INVENTORY_LOCKS_MODE`                  | `shadow` | `shadow` observes/measures; `active` gates acquisition. |
| `INVENTORY_LOCK_TTL_SECONDS`            | `300`    | Fresh-lock TTL.                                         |
| `INVENTORY_LOCK_RENEWAL_WINDOW_SECONDS` | `120`    | Renewal only allowed within this remaining-TTL window.  |
| `INVENTORY_LOCK_MAX_LIFETIME_SECONDS`   | `900`    | Hard cap from first acquisition.                        |
| `INVENTORY_LOCK_RECONCILIATION_ENABLED` | `false`  | Enables the reconciliation sweep.                       |

## Inspect a lock safely

Never `KEYS *` on production Redis. Use the lockId (returned to the client as an opaque
credential):

```
redis-cli GET  etg:{env}:invlock:lock:{lockId}          # lock JSON (PII-free)
redis-cli TTL  etg:{env}:invlock:lock:{lockId}          # remaining seconds
redis-cli GET  etg:{env}:invlock:seat:{inventoryKey}:{seatId}   # owning lockId
redis-cli GET  etg:{env}:invlock:fence:{inventoryKey}   # current fence token
```

Or via the app: `InventoryLockService.get(lockId)` (never logs seat-holder PII).

## Identify lock contention

- Metric `etg_inventory_lock_contention_total{inventory_type,scope}` — spikes show hot
  scopes (scope is a safe hash; correlate with the show via app logs `scope=…`).
- `etg_inventory_lock_ops_total{op="acquire",outcome="conflict|capacity"}` rising.
- `etg_inventory_lock_op_duration_seconds{op="acquire"}` p95 climbing ⇒ Redis pressure.

## Identify stuck database holds

Redis TTL only frees fast ownership; the **PostgreSQL** hold is expired by the worker
sweep. Stuck holds look like:

```sql
SELECT id, "eventSessionId", "holdExpiresAt"
FROM "Booking"
WHERE status = 'PENDING_PAYMENT' AND "holdExpiresAt" < now()
ORDER BY "holdExpiresAt" ASC LIMIT 50;
```

If rows persist, the worker `releaseExpiredHolds` sweep is not running — check the
worker health/interval (this is authoritative and independent of Redis).

## Run reconciliation

```ts
inventoryLockService.reconcile({ limit: 500, repair: false }); // detect-only first
inventoryLockService.reconcile({ limit: 500, repair: true }); // apply safe repairs
```

Safe auto-repairs: release a stale ACTIVE Redis lock whose booking is gone/expired; mark
a lock CONFIRMED when its booking already committed. **Manual review** (never auto-fixed):
`REDIS_CONFIRMED_DB_NOT_CONFIRMED` — investigate the booking; PostgreSQL wins.
Watch `etg_inventory_lock_reconcile_total{result}`.

## Disable active mode (roll back fast)

Set `INVENTORY_LOCKS_MODE=shadow` (keep observing) or `INVENTORY_LOCKS_ENABLED=false`
(full legacy path) and redeploy/restart. No data migration needed; PostgreSQL state is
unaffected. Existing Redis locks simply expire by TTL.

## Recover from a Redis outage

1. Confirm the mode: **active** ⇒ lock-requiring endpoints fail closed + readiness is
   unhealthy (expected — no oversell risk). **shadow/disabled** ⇒ bookings proceed on
   PostgreSQL (only shadow metrics are lost).
2. If the outage is prolonged, set `INVENTORY_LOCKS_MODE=shadow` so booking availability
   does not depend on Redis while you restore it.
3. After Redis recovers, run detect-only reconciliation, then `repair: true`.

## Verify no oversell occurred (authoritative check)

Oversell can only exist in PostgreSQL — verify there, not in Redis:

```sql
-- Seat-based: a seat must never be SOLD more than once per session.
SELECT "eventSessionId", "seatId", count(*)
FROM "ShowSeat" WHERE status = 'SOLD'
GROUP BY 1,2 HAVING count(*) > 1;

-- Quantity-based: sold + held must never exceed total.
SELECT "ticketTypeId", "quantityTotal", "quantitySold", "quantityHeld"
FROM "TicketInventory"
WHERE "quantitySold" + "quantityHeld" > "quantityTotal";
```

Both queries returning zero rows confirms no oversell. (The `ShowSeat` unique constraint
and the conditional-update guards make oversell structurally impossible even if Redis
misbehaves.)

## Metrics & logs to inspect

- `etg_inventory_lock_ops_total{op,outcome}` — acquire/renew/release/confirm/reconcile/redis outcomes.
- `etg_inventory_lock_op_duration_seconds{op}` — latency.
- `etg_inventory_lock_contention_total{inventory_type,scope}` — hot scopes.
- `etg_inventory_lock_reconcile_total{result}` — mismatch/repaired/manual_review.
- Logs carry `op / outcome / lockId / holdId / bookingId / scope(hash) / fence / durMs`
  only — safe to share. Never seat-holder PII, secrets, or raw Redis values.
