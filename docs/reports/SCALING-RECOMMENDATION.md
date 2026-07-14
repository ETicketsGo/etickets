# ETicketsGo — Scaling Recommendation

_Concrete production scaling guidance, built on `SCALING-GUIDE.md` and grounded in the measured
results of `PERFORMANCE-VALIDATION.md` / `CAPACITY-REPORT.md`. Date: 2026-07-14._

This **extends** `SCALING-GUIDE.md` (the tier/lever overview) — it does not repeat it. Here we turn
the measured single-node behaviour into a specific initial production sizing and the signals that
should trigger each scaling step.

---

## 1. The one number that drives sizing

The validation showed the **seat-hold path is the throughput-critical section**, and its ceiling is
**Postgres row-level contention on the hottest inventory row** (~60 serialized holds/s on a single
GA counter locally; higher when demand spreads across distinct seats). Everything else — reads,
analytics, static assets — scales cheaply and horizontally. **So: size Postgres for peak concurrent
holds first; scale the rest with stateless replicas.**

```
                    ┌─────────────┐
   CDN ── browse ──▶│  API replicas (stateless, JWT) │──▶ Redis (cache + BullMQ queue)
                    │  N behind an LB, trust proxy    │
                    └───────┬─────────────────────────┘
                            │ short hold UPDATEs (hot path)
                       ┌────▼─────┐   analytics / discovery reads
                       │ PgBouncer│──────────────┐
                       └────┬─────┘               ▼
                    ┌───────▼────────┐    ┌──────────────────┐
                    │ Postgres PRIMARY│──▶│ Read replica(s)  │
                    │ (sized for holds)│   │ (analytics/browse)│
                    └─────────────────┘    └──────────────────┘
        Worker replicas (≥1) ── BullMQ hold-expiry + notification sweeps
```

---

## 2. Per-tier recommendation (with the trigger to scale)

### API — horizontal replicas behind an LB + PgBouncer
- Stateless (JWT auth, no sticky sessions) → scale out freely. Set `trust proxy` so the throttler and
  logs see the real client IP.
- **The 120 req/60 s throttle is per-IP**, so replicas don't change per-client limits; they raise
  **aggregate** capacity. Reads are ~3–4 ms/hit, so a single replica already serves hundreds of
  req/s — add replicas for redundancy and write-path concurrency headroom, not for read CPU.
- **Front all Postgres access with PgBouncer (transaction pooling).** The hold `UPDATE` is a short
  transaction; without pooling, a burst of replicas can exhaust Postgres backend connections before
  the DB itself is the bottleneck.
- **Scale trigger:** `etg_http_request_duration_seconds` p95 climbing on non-DB-bound routes, or CPU
  > ~70% sustained per replica.

### PostgreSQL — size the PRIMARY for hold throughput; offload reads to replicas
- **Primary:** fast CPU + fast WAL/disk; this is where the hot-row hold `UPDATE`s serialize. This is
  the resource to buy first. Keep the hot-path indexes (already present on `ShowSeat[eventSessionId,
  status]`, `TicketInventory`, `Booking`).
- **Read replica(s):** route **analytics** and **anonymous discovery/catalog** reads here so heavy
  dashboards and browse scans never compete with hold writes on the primary.
- **Scale trigger:** rising `POST /bookings` p99, Postgres lock waits on `TicketInventory`/`ShowSeat`,
  or primary CPU/IO saturation during on-sales → scale the primary vertically (holds are single-row,
  so vertical wins) and shard hot events across ticket types/seat blocks where possible.

### Redis — cache + queue, split at scale
- Serves the discovery/catalog read-through cache (hit p50 ~4 ms) **and** the BullMQ hold-expiry
  queue. Use **managed Redis**; at scale run **separate instances** for cache vs queue so a queue
  backlog can't evict hot cache entries.
- **Cache TTLs for spikes:** discovery/sections 45 s, catalog 60 s today. During a marketing spike or
  hot on-sale, **raise these TTLs** to shield Postgres from repeated identical anonymous browse
  recomputation (fail-open cache means correctness is unaffected; only staleness increases briefly).
- **Scale trigger:** Redis latency up or hit-ratio down → larger instance / split cache & queue.

### Worker — run ≥1 replica (do not run zero)
- Validation ran with the worker **down**; holds then release only **lazily** on the next booking for
  a session. In production that under-reports available inventory during a hot on-sale. **Always run
  ≥1 worker replica** for the repeatable hold-expiry + notification sweeps (bounded, set-based, index-
  driven).
- **Scale trigger:** BullMQ queue depth growing → add worker replicas / raise concurrency; shard the
  `holds` queue if sweep volume grows.

### Web apps — horizontal + CDN
- The three Next apps are SSR/render bound; scale with replicas and serve static assets from a CDN.

---

## 3. Suggested initial production sizing (starting point, then tune from signals)

> A conservative starting point for a **moderate launch** (a few hot on-sales, thousands of browse
> users). Right-size up/down from the §4 signals — these are **not** derived SLOs.

| Tier | Initial sizing | Rationale |
| --- | --- | --- |
| **API** | **3 replicas** (2 vCPU / 2 GB each) behind an LB, `trust proxy` on | Redundancy + write-path headroom; reads are cheap |
| **PgBouncer** | 1 (HA pair) transaction pooling | Protect Postgres backend connections from replica bursts |
| **Postgres primary** | **4–8 vCPU, fast NVMe/SSD WAL**, tuned `shared_buffers`/`max_connections` | The hot-row hold path is the binding resource — buy here first |
| **Postgres read replica** | **1** | Offload analytics + discovery/catalog reads |
| **Redis** | 1 managed instance (split cache/queue when queue grows) | Cache hits ~4 ms; queue for hold expiry |
| **Worker** | **2 replicas** | Proactive hold-expiry sweep; never run zero |
| **Web apps** | 2 replicas each + CDN for static | SSR/render, cacheable assets |

Indicative capacity at this shape: the **hottest single ticket type** is capped near **~3,600
holds/min** (Postgres single-row serialization); **demand spread across seats/ticket types** scales
several-fold higher; **anonymous browse** is comfortably in the **hundreds+ of req/s per API
replica** and scales linearly with replicas + the read replica. Validate with a distributed k6 run
before committing to public SLOs.

---

## 4. Top signals to watch (from `/api/metrics`) and what each triggers

| Signal | Healthy | If it degrades → action |
| --- | --- | --- |
| `etg_http_request_duration_seconds` **p95/p99** on `POST /bookings` | flat under load | Rising p99 = Postgres hot-row contention → scale primary vertically; spread hot inventory |
| `etg_http_requests_total{status_class="5xx"}` | ~0 | Any sustained 5xx = investigate (409s are expected & healthy under contention) |
| Postgres **lock waits / active connections / CPU** on `TicketInventory`, `ShowSeat` | low, headroom | Add PgBouncer capacity; scale primary; check pool size |
| Redis **hit ratio** + latency | high hit ratio, low latency | Raise cache TTLs for spikes; split cache/queue; larger instance |
| BullMQ **queue depth** | near zero, drains fast | Add worker replicas / concurrency; shard queue |
| `etg_payments_failed_total` rate | low/stable | Spike = provider/settlement issue, not inventory |

---

## 5. Scale-up order (fastest lever first)

1. **Run the worker** (≥1) and put Postgres behind **PgBouncer** — cheap, immediate.
2. **Add API replicas** behind the LB for write-path concurrency and redundancy.
3. **Add a Postgres read replica**; route analytics + discovery/catalog reads to it.
4. **Raise cache TTLs** during known spikes; add per-endpoint caches if new hot reads appear.
5. **Scale the Postgres primary vertically** for peak hold throughput on the hottest ticket type;
   spread demand across ticket types/seat blocks where the product allows.
6. **Scale worker replicas / shard queues** if hold-expiry sweep volume grows.
7. **Partition/archive cold data** (old bookings/audit) once those tables grow large.
