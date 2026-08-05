# ETicketsGo — QA Load-Test Profile (soft launch)

> A practical profile for a **soft launch**: a first cohort of real users on a small number
> of events. It is not a stress test and it is deliberately not sized for a mass on-sale.
>
> **No IPL-scale readiness is claimed.** Nothing in this repository has been load-tested on
> Railway. Every threshold below is a starting expectation to be replaced with measured
> numbers from the first run — not a validated capacity figure. See §9.

Harnesses already in the repository — use these, do not write new ones:

| Harness                                   | Use                                       |
| ----------------------------------------- | ----------------------------------------- |
| `scripts/loadtest/k6-browse.js`           | public browsing, discovery                |
| `scripts/loadtest/k6-booking.js`          | booking path                              |
| `scripts/load/booking-load.artillery.yml` | booking path (Artillery)                  |
| `scripts/loadtest/concurrency.mjs`        | seat-lock contention + oversell invariant |
| `scripts/soak/concurrency-soak.mjs`       | sustained money-invariant soak            |

**Run against QA only**, with `PAYMENT_PROVIDER_NAME=mock` or provider **test** keys. Never
against production, never with live credentials.

---

## Before you start

**Raise the rate limiter, or you will measure it instead of the app.** The API throttles 120
req/min globally per IP and 10/min on auth routes, keyed on the real client IP via
`TRUST_PROXY_HOPS=1`. A load generator is a single IP. Either set `AUTH_THROTTLE_LIMIT`
high for the run, or distribute the load — and say which you did when reporting results.

**Record the baseline** before load: `/api/metrics`, Railway CPU/memory per service,
Postgres connection count, Redis memory.

---

## 1. Public browsing

Homepage, listings, static assets. The cheapest path and the one with the most traffic.

|             |                  |
| ----------- | ---------------- |
| Concurrency | 50 virtual users |
| Rate        | ~100 req/s       |
| Duration    | 10 min           |
| p95 latency | < 500 ms         |
| p99 latency | < 1 s            |
| Error rate  | < 0.5%           |

Cloudflare should absorb most of this at the edge. If origin CPU tracks the request rate
1:1, static caching is not working — check the `/_next/static` cache rule before scaling
anything.

## 2. Event / showtime discovery

Search, filters, event and showtime detail. Read-through cached (`etg:qa:cache:*`).

|                |                     |
| -------------- | ------------------- |
| Concurrency    | 30 VUs              |
| Rate           | ~60 req/s           |
| Duration       | 10 min              |
| p95 latency    | < 600 ms            |
| Error rate     | < 0.5%              |
| Cache hit rate | > 70% after warm-up |

A cache hit rate that stays low means TTLs are too short or the key space is too granular.

## 3. Seat availability reads

The hottest read in the product — every seat-map render and poll.

|             |                                             |
| ----------- | ------------------------------------------- |
| Concurrency | 40 VUs                                      |
| Rate        | ~80 req/s                                   |
| Duration    | 10 min                                      |
| p95 latency | < 400 ms                                    |
| Error rate  | < 0.5%                                      |
| Staleness   | must reflect a confirmed booking within 2 s |

**Must never be cached at the edge.** A stale seat map is how you oversell. Confirm
`cf-cache-status` is `DYNAMIC` or `BYPASS` on these responses, never `HIT`.

## 4. Seat-lock contention

The correctness test, not a throughput test.

|                      |                                        |
| -------------------- | -------------------------------------- |
| Tool                 | `scripts/loadtest/concurrency.mjs`     |
| Concurrency          | 25–50 clients racing the **same** seat |
| Rounds               | ≥ 5 distinct seats                     |
| Winners per seat     | **exactly 1**                          |
| Losers               | `409 BOOKING_INVENTORY_UNAVAILABLE`    |
| 5xx                  | **0**                                  |
| **Oversell**         | **0 — non-negotiable**                 |
| p95 lock acquisition | < 300 ms                               |

Local baseline on the dev stack: 25 concurrent, 2 rounds — 1 winner and 24 clean 409s each
time, 0 5xx, 133–186 ms wall. Reproduce on QA before trusting Railway's numbers.

## 5. Booking creation

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Concurrency | 20 VUs                                                      |
| Rate        | ~10 bookings/s                                              |
| Duration    | 10 min                                                      |
| p95 latency | < 2 s                                                       |
| Error rate  | < 1% (excluding legitimate 409s)                            |
| Consistency | bookings created == tickets issued == inventory decremented |

Reconcile the counts afterwards. A drift of one is a bug, not noise.

## 6. Payment initiation

|             |                                          |
| ----------- | ---------------------------------------- |
| Concurrency | 10 VUs                                   |
| Rate        | ~5 initiations/s                         |
| Duration    | 5 min                                    |
| p95 latency | < 3 s (includes the provider round-trip) |
| Error rate  | < 1%                                     |

Test mode only. Provider sandboxes have their own rate limits — a failure here may be the
sandbox, not you. Check the provider dashboard before concluding anything.

## 7. Webhook ingestion

|                |                                          |
| -------------- | ---------------------------------------- |
| Rate           | ~20 webhooks/s                           |
| Duration       | 5 min                                    |
| Accept latency | p95 < 500 ms                             |
| Processing lag | < 30 s from receipt to booking confirmed |
| Duplicates     | **0 double-processed**                   |
| Lost events    | **0**                                    |

Ingestion is durable-then-async: the endpoint records the event and returns 2xx, and the
worker's `process-webhooks` sweep does the work. Measure both the accept latency and the
end-to-end lag — a fast 2xx with a growing backlog is a failure, not a success.

## 8. QR validation

Check-in scanning: bursty, latency-sensitive, and the one path a queue of real people is
standing in.

|                 |                         |
| --------------- | ----------------------- |
| Concurrency     | 20 VUs                  |
| Rate            | ~30 validations/s       |
| Duration        | 5 min                   |
| p95 latency     | < 300 ms                |
| Error rate      | < 0.5%                  |
| Duplicate scans | correctly refused, 100% |

---

## Metrics to watch

**PostgreSQL** — it is the first thing to saturate, because it arbitrates every booking.

| Metric                   | Watch for                                                              |
| ------------------------ | ---------------------------------------------------------------------- |
| CPU                      | > 70% sustained                                                        |
| Active connections       | > 80% of the limit — cap `?connection_limit=N` before scaling hardware |
| Lock waits / deadlocks   | any rise during seat contention                                        |
| `etg_slow_queries_total` | climbing — investigate the query, don't add hardware                   |
| Replication/WAL          | growth outpacing checkpoints                                           |

**Redis**

| Metric            | Watch for                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Memory            | > 70%; **eviction policy must be `noeviction`** — an evicted seat lock looks like a phantom oversell |
| Evicted keys      | must stay **0**                                                                                      |
| Command latency   | p99 > 10 ms                                                                                          |
| Connected clients | growth without bound (leak)                                                                          |

**Queues** (`/api/metrics`, `:PORT/metrics`)

| Metric                   | Watch for                      |
| ------------------------ | ------------------------------ |
| `etg_queue_jobs` waiting | rising for > 15 min            |
| Failed jobs              | any sustained rate             |
| Hold-expiry lag          | holds outliving TTL by > 2 min |

**Railway per service**

| Metric         | Watch for                                                            |
| -------------- | -------------------------------------------------------------------- |
| CPU            | > 70% sustained → add a replica                                      |
| Memory         | > 80% → raise the limit (Node OOM is abrupt and total)               |
| Restarts       | any unexplained restart                                              |
| Network egress | unexpected volume (private networking should carry DB/Redis traffic) |

---

## Booking consistency requirements

After every run, before drawing any conclusion:

```
bookings created   == tickets issued
tickets issued     == inventory decremented
payments captured  == bookings confirmed
oversell count     == 0
orphaned holds     == 0 after the expiry window
```

Verify with `/admin/payments/reconciliation` and a direct row count. **Zero oversell is the
pass criterion.** Throughput is negotiable; correctness is not — a run that hits every
latency target and oversells one seat is a failed run.

---

## 9. What this profile does not tell you

- **Nothing here has been run on Railway.** The only measured numbers in this document come
  from a local dev stack, which has different CPU, different disk, and no network hop.
- QA is sized minimally on purpose (1 replica per service — see
  [RAILWAY_COST_SIZING.md](./RAILWAY_COST_SIZING.md)). QA results are a **lower bound**, not
  a production projection.
- These figures do not support a mass on-sale. Before any high-demand event: load-test
  **production-sized** infrastructure, find the real bottleneck (expect PostgreSQL write
  contention on the seat path), pre-scale rather than relying on reactive autoscaling, and
  consider a Cloudflare Waiting Room. Shaping demand is cheaper and safer than provisioning
  for it — and if the numbers do not hold, the AWS topology in
  [P6.1](../p6/P6.1-CLOUD-DEPLOYMENT.md) takes the same images.

## Results log

| Date | Scenario | Concurrency | p95 | Errors | Oversell | Bottleneck | By  |
| ---- | -------- | ----------- | --- | ------ | -------- | ---------- | --- |
|      |          |             |     |        |          |            |     |
