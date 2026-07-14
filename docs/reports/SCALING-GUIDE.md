# ETicketsGo — Scaling Guide

## Shape of the system

Modular monolith API (stateless) + background worker + 3 Next.js apps, over
PostgreSQL + Redis. Scale each tier independently.

## Where load concentrates & how to scale

| Tier           | Bottleneck                                              | Scaling lever                                                                                                                                    |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API**        | CPU/connections                                         | Horizontal replicas behind a load balancer (stateless; JWT auth, no sticky sessions). Set `trust proxy`.                                         |
| **PostgreSQL** | write contention on hot inventory rows; read aggregates | Connection pooling (PgBouncer); read replicas for analytics/discovery reads; vertical size for write throughput. Hot-path indexes already added. |
| **Redis**      | discovery cache + queues                                | Managed Redis; separate cache vs queue instances at scale.                                                                                       |
| **Worker**     | sweep throughput                                        | Run ≥1 replica; BullMQ scales with concurrency; sweeps are bounded/batched.                                                                      |
| **Web apps**   | SSR/render                                              | Horizontal replicas / CDN for static assets.                                                                                                     |

## Contention hot spots (designed for)

- **Seat/GA holds** are single **atomic conditional `UPDATE`s** — the DB serializes
  contention on a row; no app-level locks. This is the throughput-critical path for a
  hot on-sale; load-test it at target concurrency and size Postgres accordingly.
- **Discovery/catalog** reads are cached (short TTL, fail-open) — anonymous spikes hit
  Redis, not the DB.
- **Organizer/platform analytics** are single grouped aggregates (no N+1); heavy
  dashboards can move to read replicas.

## Scale-up playbook

1. Add API replicas; put Postgres behind PgBouncer.
2. Add Postgres read replicas; route analytics/discovery reads to them.
3. Raise the discovery/catalog cache TTL during peaks; add per-endpoint caches as needed.
4. Scale worker replicas; shard queues if sweep volume grows.
5. Partition/archive cold data (old bookings/audit) if the tables grow large.

## Capacity signals to watch (from `/metrics`)

- `etg_http_request_duration_seconds` p95/p99, `etg_http_requests_total{status_class="5xx"}`,
  Postgres connections/CPU, Redis hit ratio, queue depth, `etg_payments_failed_total` rate.
