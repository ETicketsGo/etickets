# ETicketsGo — Performance Validation

_Live concurrency + throughput validation. Date: 2026-07-14._

This report **complements** `PERFORMANCE-REPORT.md` (which analysed structural bottlenecks and
added the discovery/catalog cache) and `SCALING-GUIDE.md`. Where those reason about the design,
this one **executes** a concurrency harness against the **live local API** and records **real
measured numbers**. It does not re-state their content.

> **Honesty label.** All figures below are **indicative single-node local results** — one API
> process, one Postgres, one Redis, all on one developer machine, driven by an in-process Node
> client over loopback. They are **not** a certified/distributed benchmark. They exist to prove
> **correctness under real concurrency** and to give an **order-of-magnitude** capacity picture.
> Absolute latencies will differ on production hardware and network.

---

## 1. Methodology

- **Harness:** `scripts/loadtest/concurrency.mjs` — plain Node (global `fetch`), no dependencies.
  Additive; it changes **no application code** and **deletes no data**. Successful bookings are
  `PENDING_PAYMENT` inventory **holds only** (never paid), so they auto-release after the 10-minute
  hold window.
- **Target:** live API at `http://127.0.0.1:4000/api`, backed by Postgres + Redis via
  `docker-compose`. Health `200` before the run.
- **Seed data:** movie `skyfront-protocol` (two shows; the harness uses the **second** show —
  session `cmrj3jvfx008cw47e38crg8m3`, starts 2026-07-18, >48h out, refund-safe), and GA event
  `standup-night-with-zomato-comedy`.
- **Throttle-awareness (important):** the API enforces a **global `ThrottlerGuard` of 120 req /
  60 s per IP** (`app.module.ts`). The harness therefore keeps each phase's request count under
  that budget and **cools down a full window between phases**, so the concurrency races are
  arbitrated **purely by the database (409s)** and never masked by 429s, and read latencies reflect
  **genuinely served** responses (2xx only). This is why the numbers below are clean.
- **Run:** `node scripts/loadtest/concurrency.mjs` (this run used `COOLDOWN_MS=70000` for extra
  throttle-window margin). Timings via `process.hrtime`; percentiles computed from the measured
  sample arrays.

### What each test proves

| Test                            | Invariant under test                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent **seat** reservation | Reserved-seating double-book safety: N clients race for the **same** `ShowSeat` row → exactly **one** wins, all others `409 BOOKING_INVENTORY_UNAVAILABLE`, no 5xx, no oversell. |
| Concurrent **GA** oversell      | Quantity-counter oversell safety: N concurrent quantity-1 holds against one ticket type → number that succeed **equals remaining stock**, never more; the rest `409`.            |
| API **read** throughput         | Served throughput + latency distribution of the cached anonymous browse paths.                                                                                                   |

---

## 2. Results — Concurrent SEAT reservation (crown-jewel invariant) — **PASS**

Logged in as `customer1@eticketsgo.test`, fetched the seat layout for the second skyfront show,
then for each of **3 distinct available seats** fired **N = 25 concurrent** `POST /bookings` all
requesting that **same seat** (`Promise.all`).

| Round    | Seat | Concurrency | Wins (201) | 409 `BOOKING_INVENTORY_UNAVAILABLE` | Unexpected / 5xx | Wall     | Per-req p50 / p95 / p99  |
| -------- | ---- | ----------- | ---------- | ----------------------------------- | ---------------- | -------- | ------------------------ |
| 1 (cold) | 4    | 25          | **1**      | **24**                              | 0                | 584.3 ms | 561.9 / 571.6 / 575.5 ms |
| 2 (warm) | 5    | 25          | **1**      | **24**                              | 0                | 245.7 ms | 219.8 / 239.5 / 242.8 ms |
| 3 (warm) | 6    | 25          | **1**      | **24**                              | 0                | 242.5 ms | 225.4 / 238.1 / 241.9 ms |

**Every round: exactly one booking id returned, the other 24 rejected with `409
BOOKING_INVENTORY_UNAVAILABLE`, zero 5xx, zero oversell.** This is the atomic conditional
`UPDATE "ShowSeat" … WHERE status = 'AVAILABLE'` (`inventory/seat-based.strategy.ts`) holding under
real wall-clock concurrency: the winner's UPDATE flips the row `AVAILABLE→HELD`; the 24 losers match
**0 rows** and their whole booking transaction rolls back. The DB, not the app, arbitrates.

## 3. Results — Concurrent GA oversell — **PASS**

Targeted the GA event's smallest-stock ticket type (**VIP**). A single **primer** booking first
triggered the service's lazy `releaseExpiredHolds()` so availability was exact, then **64 concurrent
quantity-1** `POST /bookings` were fired against a read stock of **49**.

| Ticket type | Remaining stock | Concurrent racers      | Wins (201) | 409 rejected | Unexpected / 5xx | Wall     | Per-req p50 / p95 / p99  |
| ----------- | --------------- | ---------------------- | ---------- | ------------ | ---------------- | -------- | ------------------------ |
| VIP         | 49              | 64 (49 + 15 overshoot) | **49**     | **15**       | 0                | 766.0 ms | 710.8 / 742.7 / 747.8 ms |

**Confirmed holds equalled remaining stock exactly (49 == 49) — never more — and the 15 overshoot
requests were each rejected `409 BOOKING_INVENTORY_UNAVAILABLE`, zero 5xx.** This is the atomic
`UPDATE "TicketInventory" … WHERE (quantityTotal − quantitySold − quantityHeld) >= qty`
(`inventory/general-admission.strategy.ts`) serialising 49 successful increments on **one hot row**
while refusing the 16th-beyond-capacity attempts.

## 4. Results — API read throughput (cached) — **PASS**

Warmup + measurement of the two cached anonymous read paths, within the throttle budget, counting
**only genuinely served 2xx** responses.

| Path                | Sequential p50 / p95 / p99 | Concurrent (40) p50 / p95 / p99 | Concurrent wall | Served req/s | 429s |
| ------------------- | -------------------------- | ------------------------------- | --------------- | ------------ | ---- |
| `/public/discovery` | 4.23 / 13.04 / 69.83 ms    | 71.06 / 84.99 / 85.16 ms        | 91.6 ms         | **~437**     | 0    |
| `/public/movies`    | 3.51 / 4.63 / 18.32 ms     | 57.52 / 65.83 / 66.04 ms        | 73.2 ms         | **~547**     | 0    |

Steady-state single-client latency for a **cache hit** is **~3–4 ms p50** on both paths — consistent
with `PERFORMANCE-REPORT.md §4`'s claim that a hit collapses to "one Redis `GET` + a JSON parse"
rather than recomputing several Postgres aggregate/join queries. A 40-way concurrent burst drained in
**73–92 ms** (≈437–547 served req/s) with **no throttled responses and no errors**. The single p99
outlier on `/public/discovery` (69.8 ms) is one cold/TTL-refresh sample in a 60-request sequence.

> These req/s figures are a **floor**, not a ceiling: the harness deliberately stays inside the
> 120 req/60 s **per-IP** throttle, so it never saturates the server. The server drained 40
> in-flight requests in <100 ms — real aggregate read capacity per node is materially higher (see
> `CAPACITY-REPORT.md`).

---

## 5. Verbatim harness output

```
ETicketsGo concurrency harness — 2026-07-14T06:18:13.342Z
API_BASE=http://127.0.0.1:4000/api

  …cooling down 70s to reset the throttle window before the seat-reservation race…
==============================================================================
SECTION 1 — Concurrent SEAT reservation (oversell / double-book safety)
==============================================================================
  movie=skyfront-protocol  session=cmrj3jvfx008cw47e38crg8m3  startsAt=2026-07-18T10:45:56.528Z
  available seats: 77

  Round 1  seat=4  concurrency=25  wall=584.3ms
  status codes: {"201":1,"409":24}
  PASS  exactly ONE booking id returned  — wins=1
  PASS  other 24 are 409 BOOKING_INVENTORY_UNAVAILABLE  — conflicts=24
  PASS  no 5xx / no oversell  — unexpected=0

  Round 2  seat=5  concurrency=25  wall=245.7ms
  status codes: {"201":1,"409":24}
  PASS  exactly ONE booking id returned  — wins=1
  PASS  other 24 are 409 BOOKING_INVENTORY_UNAVAILABLE  — conflicts=24
  PASS  no 5xx / no oversell  — unexpected=0

  Round 3  seat=6  concurrency=25  wall=242.5ms
  status codes: {"201":1,"409":24}
  PASS  exactly ONE booking id returned  — wins=1
  PASS  other 24 are 409 BOOKING_INVENTORY_UNAVAILABLE  — conflicts=24
  PASS  no 5xx / no oversell  — unexpected=0

==============================================================================
SECTION 2 — Concurrent GA oversell (quantity-counter arbitration)
==============================================================================
  primer booking (flush expired holds): status=201
  event=standup-night-with-zomato-comedy  session=cmrj3jv1q001gw47e676xz728
  target ticketType=VIP  remaining stock=49
  firing 64 concurrent quantity-1 bookings (stock 49 + 15 overshoot)
  wall=766.0ms  status codes: {"201":49,"409":15}
  PASS  confirmed holds == remaining stock (never more)  — wins=49 stock=49
  PASS  overshoot bookings rejected 409 BOOKING_INVENTORY_UNAVAILABLE  — conflicts=15 expected=15
  PASS  no 5xx / no oversell  — unexpected=0

==============================================================================
SECTION 3 — API read throughput (cached discovery + movie catalog)
==============================================================================
  discovery (cached)  (/public/discovery)
  sequential x60 (2xx=60): {"n":60,"min":3.26,"mean":6.54,"p50":4.23,"p95":13.04,"p99":69.83,"max":69.83}
  concurrent x40 (2xx=40): {"n":40,"min":35.86,"mean":72.08,"p50":71.06,"p95":84.99,"p99":85.16,"max":85.16}  wall=91.6ms  ~437 served req/s
  PASS  discovery (cached): all responses served 2xx (no throttling)  — 429s=0

  movies catalog (cached)  (/public/movies)
  sequential x60 (2xx=60): {"n":60,"min":3.07,"mean":3.87,"p50":3.51,"p95":4.63,"p99":18.32,"max":18.32}
  concurrent x40 (2xx=40): {"n":40,"min":21.59,"mean":50.35,"p50":57.52,"p95":65.83,"p99":66.04,"max":66.04}  wall=73.2ms  ~547 served req/s
  PASS  movies catalog (cached): all responses served 2xx (no throttling)  — 429s=0

==============================================================================
OVERALL: PASS ✅
==============================================================================
```

---

## 6. What these results prove

1. **The atomic, DB-arbitrated inventory holds hold under real concurrency.** Both the seat-based
   conditional `UPDATE … WHERE status='AVAILABLE'` and the GA conditional `UPDATE … WHERE
(total − sold − held) >= qty` were driven with true parallel requests and produced **zero
   oversell, zero double-book, zero 5xx** across every round. Correctness is enforced by Postgres
   row arbitration, exactly as designed in ADR-010 / ADR-013.
2. **Closes the intent of TECH-DEBT D13.** D13 asked for a real-DB concurrency test ("fire N
   concurrent reserves → exactly one wins") because the unit tests mock `tx`. This harness does
   precisely that against live Postgres for **both** inventory strategies. (It is an operational
   validation harness, not yet a wired CI integration suite — see §8 — so D13 can be marked
   **intent-satisfied / validated**, with the CI-integration form as the remaining follow-up.)
3. **The discovery/catalog cache behaves as claimed.** Cache-hit reads are ~3–4 ms p50, and repeated
   identical anonymous reads never fell through to a slow recompute — matching `PERFORMANCE-REPORT.md
§4`. Observed cache-hit behaviour: warm sequential reads are flat and fast; the only slow sample
   is a lone TTL-refresh miss.

## 7. Worker / queue notes

The standalone worker (`apps/worker`) runs a **BullMQ repeatable** hold-expiry sweep
(`HOLD_EXPIRY_INTERVAL_MS`, default 60 s) that reuses `BookingsService.releaseExpiredHolds` — the
same bounded, set-based, index-driven release used on the hot path. **The worker was not running
during this validation** (health `:4100` refused). This did not affect correctness (holds still
release **lazily** on the next `create()` for a session — the harness's GA "primer" booking
demonstrates exactly this: it flushed the prior run's expired holds before the race). It does mean
that, without the worker, freed inventory is reclaimed only when the next booking touches a session;
**run ≥1 worker replica in any real deployment** so stale holds are swept proactively.

## 8. Limitations

- **Single-node, local, loopback.** One API process, one Postgres, one Redis, one machine, in-process
  driver over `127.0.0.1`. Absolute latencies are not production figures.
- **Not a distributed load test.** Concurrency is real (`Promise.all`) but bounded by the per-IP
  throttle (120/60 s), so throughput numbers are **floors**, not saturation ceilings. For a true
  capacity/soak test use the k6 scripts (§below) from a distributed pool against a staging target
  with a relaxed throttle.
- **Validation harness, not yet CI-wired.** `concurrency.mjs` needs a live API + seed data; it is run
  operationally, not in `ci.yml`. The remaining D13 follow-up is to wire an equivalent as an
  integration job against an ephemeral CI Postgres.
- **Payment settlement not load-tested here.** Successful holds were left to expire (never paid), so
  the `held→sold` confirm path and refund path were not exercised under concurrency in this run (they
  are covered by unit tests and the k6 booking script's mock-pay step for staging).

## 9. Companion k6 scripts (for CI / staging — not executed here)

- `scripts/loadtest/k6-browse.js` — ramping VUs over discovery / catalog / movie-detail / seat-layout
  / GA-detail, with p95/p99 latency and error-rate thresholds.
- `scripts/loadtest/k6-booking.js` — VUs doing login → seat-layout → book → (intent + mock-pay), with
  409 seat-conflicts counted as valid (not errors) and thresholds on 5xx rate + hold latency.

Run against staging (needs the `k6` binary and a load target — **not run here**):

```
k6 run -e BASE_URL=https://staging.eticketsgo.example/api scripts/loadtest/k6-browse.js
k6 run -e BASE_URL=https://staging.eticketsgo.example/api \
       -e EMAIL=customer1@eticketsgo.test -e PASSWORD='Password123!' \
       scripts/loadtest/k6-booking.js
```

> k6 was **not executed** in this validation (requires the k6 binary and a distributed, non-rate-
> limited load target). The scripts are provided as CI/staging performance gates. See
> `CAPACITY-REPORT.md` and `SCALING-RECOMMENDATION.md` for what to do with their output.
