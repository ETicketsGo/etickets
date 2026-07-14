# ETicketsGo — Capacity Report

_Derived from the live single-node measurements in `PERFORMANCE-VALIDATION.md`. Date: 2026-07-14._

> **Read this first.** Every figure here is an **indicative local single-node estimate**,
> extrapolated from a loopback harness on one developer machine (one API process, one Postgres, one
> Redis). It is **not a certified benchmark** and **not a production SLO**. Use it for
> **order-of-magnitude** sizing and to identify the **binding resource**, then confirm with a
> distributed k6 run against production-class hardware.

---

## 1. Measured basis (from `PERFORMANCE-VALIDATION.md`)

| Path                             | Observation                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat hold, 25-way same-seat race | Warm rounds: **~245 ms** wall to resolve 25 concurrent attempts (1 win + 24 fast 409). Per-req p50 ~220 ms.                                        |
| GA hold, 64-way single-row race  | **766 ms** wall to resolve 64 concurrent quantity-1 holds → **49 successful holds** + 15 × 409, on **one** hot inventory row. Per-req p50 ~710 ms. |
| Cached read `/public/discovery`  | Hit p50 **~4 ms**; 40 concurrent drained in **91.6 ms** (~437 served req/s).                                                                       |
| Cached read `/public/movies`     | Hit p50 **~3.5 ms**; 40 concurrent drained in **73.2 ms** (~547 served req/s).                                                                     |

---

## 2. Binding resource: Postgres row-level contention on the hot inventory rows

Both hold paths are single atomic conditional `UPDATE`s. Postgres serialises writers on a **row**,
so the throughput ceiling of a **single on-sale ticket type / seat** is set by how fast Postgres can
apply serialized row updates — **not** by API CPU, and **not** by Redis.

The two tests expose the two contention shapes:

- **GA (worst case — one shared counter).** All 64 racers contend on the **same** `TicketInventory`
  row; the 49 winners each **mutate** it, so their updates apply **in sequence**. 49 successful
  serialized holds in 766 ms ⇒ **~64 successful holds/second on a single hot row**, and ~83
  attempts/second including the fast-failing overshoot. This is the true worst-case serialization
  point for a single hot ticket type.
- **Seat-based (lighter — contention spread across rows).** In a same-seat race only the **winner**
  mutates the row; the 24 losers match `status='AVAILABLE'` → **0 rows** and roll back **without
  mutating**, so they don't queue behind a write. Across a real seat map, different buyers touch
  **different** `ShowSeat` rows, so genuine write-serialization only occurs for the exact same seat.
  Warm resolution of a 25-way same-seat collision in ~245 ms shows even the pathological
  all-on-one-seat case clears sub-second.

**Implication:** the seat model scales better under broad demand (contention is partitioned per
seat); the GA single-counter model is the throughput-critical section for a hot, high-demand ticket
type and is what to size Postgres around.

---

## 3. Indicative capacity envelope (single local node)

> Rounded to order-of-magnitude. Production hardware with faster disk/CPU and a tuned Postgres will
> exceed these; a shared/throttled environment will do less.

### Write path (bookings / inventory holds)

| Scenario                                     | Indicative sustained rate                                                  | Basis                                         |
| -------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Holds on **one** hot GA counter (worst case) | **~60 holds/s → ~3,600/min**                                               | 49 serialized holds in 766 ms                 |
| Holds spread across **distinct** seats/rows  | **Several × higher** (scales with distinct hot rows until DB CPU/IO binds) | losers don't serialize; per-seat partitioning |
| Same-seat collision resolution               | **< 1 s** for 25-way                                                       | warm rounds ~245 ms                           |

A realistic hot on-sale spreads demand across many seats/ticket types, so the practical booking
ceiling on this single node is **comfortably in the thousands of holds/minute**, with the **single
hottest row** capped near **~3,600 holds/minute**. Payment settlement (`held→sold`) is a second,
similar single-row update per booking and was **not** load-tested here — treat it as a second write
of comparable cost when sizing.

### Read path (anonymous browse)

| Path                         | Indicative served capacity (this node) | Notes                                     |
| ---------------------------- | -------------------------------------- | ----------------------------------------- |
| `/public/discovery` (cached) | **≥ ~440 req/s** measured floor        | 40 concurrent in 91.6 ms; hit p50 ~4 ms   |
| `/public/movies` (cached)    | **≥ ~550 req/s** measured floor        | 40 concurrent in 73.2 ms; hit p50 ~3.5 ms |

These are **floors** — the harness never saturated the server (it stayed inside the 120 req/60 s
per-IP throttle). Because a cache hit is ~3–4 ms of Redis + JSON, per-node read capacity is bound by
Redis round-trips and Node event-loop throughput, both far above the measured floor. Read capacity
scales **horizontally** with stateless API replicas and is **not** the system's constraint.

### The per-IP throttle is a policy cap, not a capacity cap

The global `120 req / 60 s per IP` throttle limits a **single client/IP** to ~2 req/s. That protects
against abuse; it is **not** the server's aggregate ceiling (the server drained 40 simultaneous
requests in <100 ms). Aggregate capacity is set by Postgres/Redis/replica count, per above.

---

## 4. Headroom guidance

- **Seat-hold path is the capacity-critical section.** Size Postgres (CPU, fast WAL/disk, and
  connection pool) for peak concurrent holds on the **hottest** ticket type/seat block, not for
  average load. Budget for payment-confirm writes on top.
- **Keep hot writes off connection starvation.** Put Postgres behind **PgBouncer** so a burst of API
  replicas doesn't exhaust backend connections; the hold `UPDATE` is short, so transaction pooling is
  ideal.
- **Reads are cheap and horizontal.** With the discovery/catalog cache, anonymous browse is Redis-
  bound at ~3–4 ms/hit; add API replicas (and optionally route heavy analytics/discovery to a read
  replica) rather than scaling the primary for reads.
- **Run the worker.** Without a hold-expiry worker, freed inventory is reclaimed only lazily on the
  next booking for a session; a proactive sweep keeps effective available-inventory accurate during
  a hot on-sale.
- **Confirm before committing to SLOs.** Re-measure with `scripts/loadtest/k6-booking.js` from a
  distributed pool against production-class hardware to turn these indicative figures into a
  certified capacity number.

## 5. Top capacity signals to watch (from `/api/metrics`)

- `etg_http_request_duration_seconds` **p95/p99** — especially on `POST /bookings`; a rising p99
  under load is the first sign of Postgres row-contention saturation on a hot ticket type.
- `etg_http_requests_total{status_class="5xx"}` — must stay ~0 (409s are expected and healthy under
  contention; 5xx are not).
- Postgres **active connections / CPU / lock waits** on `TicketInventory` and `ShowSeat`.
- Redis **hit ratio** and latency (cache effectiveness for discovery/catalog).
- BullMQ **queue depth** and `etg_payments_failed_total` rate.
