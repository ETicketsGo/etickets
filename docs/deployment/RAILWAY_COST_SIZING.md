# ETicketsGo — Railway Cost & Sizing

> Starting points, not measurements. These recommendations are derived from the
> application's structure (what each process does, what it holds in memory, how it scales)
> — **not** from load tests on Railway. Nothing here has been benchmarked on the platform.
> Right-size from real metrics once QA is running.
>
> Companion: [Railway Deployment Runbook](./RAILWAY_DEPLOYMENT_RUNBOOK.md)

---

## 1. What drives cost here

Railway bills on **actual resource usage** (vCPU-hours and GB-hours), not on provisioned
size. Two consequences that shape every recommendation below:

1. An idle service costs very little even with generous limits, so setting limits _higher_
   than expected usage is cheap insurance against a Node process being OOM-killed
   mid-booking.
2. **The datastores are the floor.** PostgreSQL and Redis run 24/7 in all three
   environments and cannot scale to zero. In a low-traffic setup they dominate the bill.

---

## 2. QA — minimal

QA runs automated tests and manual verification. It is idle most of the day.

| Service         | vCPU   | Memory | Replicas | Notes                                      |
| --------------- | ------ | ------ | -------- | ------------------------------------------ |
| `api`           | 1      | 1 GB   | 1        | Nest + Prisma; 512 MB is tight during boot |
| `worker`        | 0.5    | 512 MB | 1        | Sweeps only                                |
| `customer-web`  | 0.5    | 512 MB | 1        | Next standalone, mostly static             |
| `organizer-web` | 0.5    | 512 MB | 1        |                                            |
| `admin-web`     | 0.5    | 512 MB | 1        | Lowest traffic of the three                |
| PostgreSQL      | shared | 1 GB   | 1        | Test data volume                           |
| Redis           | shared | 256 MB | 1        | Locks + queues only                        |

Single replicas throughout. A QA outage is an inconvenience, and redundancy costs more than
it is worth here.

## 3. UAT — minimal, production-shaped

UAT must behave like production for acceptance testing, but carries no real load.

| Service         | vCPU   | Memory | Replicas | Notes                        |
| --------------- | ------ | ------ | -------- | ---------------------------- |
| `api`           | 1      | 1 GB   | 1        |                              |
| `worker`        | 0.5    | 512 MB | 1        |                              |
| `customer-web`  | 0.5    | 512 MB | 1        |                              |
| `organizer-web` | 0.5    | 512 MB | 1        |                              |
| `admin-web`     | 0.5    | 512 MB | 1        |                              |
| PostgreSQL      | shared | 2 GB   | 1        | Realistic acceptance dataset |
| Redis           | shared | 256 MB | 1        |                              |

Keep single replicas. Raise `api` to 2 only when rehearsing a rolling deploy.

## 4. Production — starting point

| Service         | vCPU | Memory | Replicas        | Rationale                                                     |
| --------------- | ---- | ------ | --------------- | ------------------------------------------------------------- |
| `api`           | 2    | 2 GB   | **2 (minimum)** | Two is a correctness requirement, not a capacity one — see §5 |
| `worker`        | 1    | 1 GB   | **1**           | See §6 before raising                                         |
| `customer-web`  | 1    | 1 GB   | 2               | Customer-facing; survives one replica restarting              |
| `organizer-web` | 1    | 1 GB   | 1               | Lower traffic; 2 once organizers depend on it in-event        |
| `admin-web`     | 0.5  | 512 MB | 1               | Internal                                                      |
| PostgreSQL      | 2    | 4 GB   | 1               | The bottleneck under booking load; scale here first           |
| Redis           | 1    | 1 GB   | 1               | See §8                                                        |

---

## 5. Minimum API replicas: 2

Not for throughput — for **availability during deploys**. With one replica, every
deployment and every restart is a hard outage: Railway stops the old container before the
new one is healthy. With two, the health check gates the rollout and one replica keeps
serving throughout.

The API is stateless (JWT auth, no server-side session, locks in Redis, truth in
PostgreSQL), so replicas need no affinity and can be added freely.

Migrations are safe across replicas because they run **once** in `preDeployCommand`, before
any replica takes traffic — that is why the migration is not in `startCommand`
([Runbook §18](./RAILWAY_DEPLOYMENT_RUNBOOK.md#18-handling-a-failed-database-migration)).

---

## 6. Worker replicas and concurrency — read before scaling

**Start with one worker replica.** Scaling the worker is not the same operation as scaling
the API, and the difference matters.

The worker registers **repeatable** BullMQ jobs (`expire-holds`, `dispatch-notifications`,
`process-webhooks`, `outbox-dispatch`, …). BullMQ deduplicates repeatable jobs by `jobId`,
so N replicas do not produce N times the schedule — but each replica also runs a `Worker`
consumer, so the jobs are processed concurrently across replicas. The handlers are written
to be idempotent (releasing an already-released hold is a no-op; the outbox dispatcher
claims rows with `FOR UPDATE SKIP LOCKED`; webhook processing claims events atomically), so
this is safe by design.

That said: one replica is sufficient for a very long time. These are periodic sweeps, not a
request path. Scale only when queue-depth metrics say so (§9), and verify idempotency under
the new concurrency in UAT first.

**Concurrency settings** live in code, not in Railway:

| Queue                   | Concurrency        | Where                     |
| ----------------------- | ------------------ | ------------------------- |
| `holds` (main sweeps)   | BullMQ default (1) | `apps/worker/src/main.ts` |
| `inventory-sync-events` | 8                  | `apps/worker/src/main.ts` |

Sweep intervals are tunable per environment without a code change:
`HOLD_EXPIRY_INTERVAL_MS`, `NOTIFICATION_SWEEP_INTERVAL_MS`, `WEBHOOK_SWEEP_INTERVAL_MS`,
`QUEUE_METRICS_INTERVAL_MS`.

---

## 7. Scale to zero — what can and cannot

Railway can put a service to sleep when idle (**Settings → Serverless / App Sleeping**).

### Safe to sleep — QA and UAT only

| Service                                      | Sleep in QA/UAT? | Why                                                                                                                                                              |
| -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer-web`, `organizer-web`, `admin-web` | ✅ Yes           | Stateless; a cold start costs a few seconds on the first request                                                                                                 |
| `api`                                        | ⚠️ Only in QA    | Cold start is slow (Nest boot + Prisma connect) and it will fail the first health check after waking. Acceptable for manual QA, painful for scheduled test runs. |
| `worker`                                     | ❌ **No**        | A sleeping worker does not expire seat holds. Inventory stays locked until it wakes — the exact failure that looks like an oversell bug.                         |
| PostgreSQL, Redis                            | ❌ **No**        | Railway plugins do not scale to zero                                                                                                                             |

**Out-of-hours shutdown** is a better lever than sleeping for QA/UAT: if the environments
are genuinely unused overnight, pause the whole project rather than sleeping individual
services. Remember to un-pause before the morning's CI run.

### Never in production

| Service           | Why                                                |
| ----------------- | -------------------------------------------------- |
| `api`             | Ticket sales do not have business hours            |
| `worker`          | Holds must expire continuously, or inventory leaks |
| `*-web`           | Customer-facing                                    |
| PostgreSQL, Redis | Always on                                          |

**Do not sleep anything in production.** An "off-peak" window is exactly when an
international customer buys a ticket, and a slept worker silently holds inventory.

---

## 8. PostgreSQL considerations

PostgreSQL is the first thing to become the bottleneck, because it is authoritative for
every booking, payment, lock reconciliation, and outbox row.

- **Connection limits matter more than CPU.** Each API replica opens a Prisma pool. Two
  replicas at the default pool size can consume a meaningful share of a small plan's
  connections; the worker adds more. If you see connection-exhaustion errors, cap the pool
  with `?connection_limit=N` on `DATABASE_URL` before scaling the database.
- **Storage growth** comes from `AuditLog`, the outbox tables, and `RefreshToken`. Retention
  exists for outbox (`DOMAIN_EVENT_OUTBOX_RETENTION_*`, off by default) and the daily
  `prune-tokens` job handles refresh tokens. Enable outbox retention before it matters.
- **Indexes are already tuned** (`perf/db-indexes-and-quality`). Investigate slow queries
  via `etg_slow_queries_total` and `SLOW_QUERY_MS` before adding hardware.
- **Scale vertically first.** This is a single-primary design; a read replica requires
  application changes that do not exist yet.

---

## 9. Redis memory considerations

Redis holds seat locks, BullMQ job data, and cached read-through responses — all bounded
and all short-lived.

Rough working-set estimate:

| Content                                 | Per unit | 10,000 concurrent holds |
| --------------------------------------- | -------- | ----------------------- |
| Seat lock (`lock:` + `seat:`)           | ~200 B   | ~2 MB                   |
| Quantity ZSET/HASH per inventory key    | ~100 B   | ~1 MB                   |
| BullMQ job (repeatable, small payloads) | ~1 KB    | negligible              |
| Read-through cache (discovery/catalog)  | varies   | tens of MB              |

1 GB in production is generous. The real risk is not size but **eviction policy**: if Redis
is configured with an LRU eviction policy and fills up, it can evict a _seat lock_ — which
looks like a phantom oversell. Prefer `noeviction` so a full Redis fails loudly instead of
silently dropping locks, and alert on memory usage instead.

Locks all carry TTLs, so the keyspace self-bounds. Cache keys carry short TTLs.

---

## 10. Scaling triggers

Act on signals, not on intuition. All of these are already exposed at `/api/metrics` and
`:PORT/metrics` (see [P6.7 Observability](../p6/P6.7-OBSERVABILITY-DASHBOARDS-ALERTS.md)).

| Signal                                  | Threshold                      | Action                                                                 |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| API p95 latency                         | > 500 ms for 5 min             | Add an `api` replica                                                   |
| API CPU                                 | > 70% sustained                | Add an `api` replica                                                   |
| API memory                              | > 80%                          | Raise the memory limit (Node OOM is abrupt)                            |
| Queue depth (`etg_queue_jobs`)          | Rising for 15 min              | Shorten the sweep interval, then consider a second worker (§6)         |
| Hold-expiry lag                         | Holds outliving TTL by > 2 min | Worker is starved — check it is not sleeping, then scale               |
| PostgreSQL CPU                          | > 70% sustained                | Scale the database                                                     |
| PostgreSQL connections                  | > 80% of limit                 | Cap `connection_limit` before scaling                                  |
| Slow queries (`etg_slow_queries_total`) | Climbing                       | Investigate the query; do not add hardware first                       |
| Redis memory                            | > 70%                          | Raise memory; check cache TTLs                                         |
| Web p95 latency                         | > 1 s                          | Add a web replica; check Cloudflare static caching is actually hitting |
| 5xx rate                                | > 1% for 5 min                 | Incident, not a scaling event                                          |

---

## 11. On high-demand on-sales

**No claim is made that this setup handles IPL-scale traffic.** It has not been load-tested
on Railway, and any number in this document is an inference from the code, not a
measurement.

Before any high-demand on-sale:

1. **Load-test the real environment.** The repository ships the harnesses:
   `scripts/loadtest/k6-booking.js`, `scripts/loadtest/k6-browse.js`,
   `scripts/load/booking-load.artillery.yml`, `scripts/soak/concurrency-soak.mjs`. Run them
   against UAT on Railway-sized infrastructure — not against a laptop.
2. **Find the actual bottleneck.** It will almost certainly be PostgreSQL write contention
   on the seat/inventory path, not the Node tier.
3. **Verify the oversell invariant under peak concurrency**, not just under load. Zero
   oversell is the property that matters; throughput is negotiable.
4. **Pre-scale before the on-sale.** Reactive autoscaling is too slow for a spike that
   arrives in the first ten seconds.
5. **Consider a queue-based waiting room** (Cloudflare Waiting Room) if the expected peak is
   more than a few multiples of tested throughput. Shaping demand is cheaper and safer than
   provisioning for it.
6. **Be willing to conclude Railway is the wrong platform for that specific event.** The
   AWS topology in [P6.1](../p6/P6.1-CLOUD-DEPLOYMENT.md) exists for exactly that case, and
   the same images deploy to it.

---

## 12. Cost control

- **Set spend limits** per project (Railway → Settings → Usage) so a runaway loop cannot
  produce an unbounded bill.
- **Watch egress.** Use Railway _private_ networking (`*_PRIVATE_URL` references) between
  the app services and the datastores; private traffic is not billed as egress.
- **Let Cloudflare serve static assets** — `/_next/static/*` cached for a year at the edge
  removes that traffic from Railway entirely ([Cloudflare & DNS](./CLOUDFLARE_DNS.md) §7).
- **Turbo cache in CI** already avoids rebuilding unchanged packages; watch paths (Runbook
  §4) avoid rebuilding unchanged services.
- **QA and UAT are the easy savings.** They are the same shape as production but need none
  of its resilience. Pause them out of hours if usage genuinely allows.
