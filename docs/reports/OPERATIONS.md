# ETicketsGo — Operations Runbook & Plan

> Operational reference for running ETicketsGo. **Honest about built vs planned:**
> anything not yet implemented is marked **planned** so its absence is a decision,
> not a surprise. Companions:
> [Runbooks](../handbooks/RUNBOOKS.md),
> [Architecture Handbook](../handbooks/ARCHITECTURE-HANDBOOK.md),
> [Tech-Debt Register](../handbooks/TECH-DEBT-REGISTER.md).

This document was produced by the Operations Excellence sprint, which added
structured JSON request logging, a Prometheus `/metrics` endpoint, and the
domain/HTTP metrics catalog described below.

> **Production observability** (full metrics catalog incl. GMV/QR/DB metrics,
> the Prometheus+Grafana stack, alert rules, Sentry, slow-query and tracing
> setup, and the queue-monitoring approach) now lives in
> **[docs/guides/MONITORING.md](../guides/MONITORING.md)**.

---

## 1. Monitoring & Health

### Built — health & readiness probes

| Endpoint           | Auth     | Meaning                                                                          |
| ------------------ | -------- | -------------------------------------------------------------------------------- |
| `GET /api/health`  | public   | API liveness — `{ status: "ok", uptime }`. Never touches DB/Redis.               |
| `GET /api/ready`   | public   | API readiness — pings Postgres + Redis; `degraded` + HTTP 503 if either is down. |
| `GET /api/metrics` | public\* | Prometheus exposition (default process metrics + ETicketsGo metrics).            |
| `GET :4100/health` | public   | Worker liveness.                                                                 |
| `GET :4100/ready`  | public   | Worker readiness — Postgres + Redis.                                             |

\* `/api/metrics` is marked `@Public()` so a scraper can reach it without a JWT.
**In production it MUST be network-restricted to the Prometheus scraper** (private
network / security group / ingress allow-list), never exposed to the public
internet. It sends `Cache-Control: no-store`.

- Liveness (`/health`) is for "is the process up?" — use it for container restart
  probes. It must stay cheap and dependency-free.
- Readiness (`/ready`) is for "should this instance receive traffic?" — use it for
  load-balancer / k8s readiness gating so an instance that lost its DB/Redis is
  pulled out of rotation instead of serving errors.

### Planned — Prometheus scrape + Grafana

- **Prometheus** scraping `/api/metrics` (and the worker, once it exposes metrics)
  every 15s. Recommended `scrape_config`:

  ```yaml
  scrape_configs:
    - job_name: eticketsgo-api
      metrics_path: /api/metrics
      static_configs:
        - targets: ['api:4000']
  ```

- **Grafana** dashboards over the Prometheus data source (panels in §9).
- **Alertmanager** wired to the alert rules in §2.

### Built — internal operations console (admin)

An admin-only console (`admin-web` → **Operations**) backed by the `ops` API
module (`apps/api/src/ops`). Additive and read/manage-only — it changes no
business logic. Every endpoint requires `ADMIN`/`SUPER_ADMIN` (`@Roles`).

| Endpoint                               | Method | Purpose                                                                                    |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `/api/admin/ops/health`                | GET    | System health: `database`, `redis`, `queue` (up/down + latency ms), `storage`, uptime, env |
| `/api/admin/ops/queues`                | GET    | `holds` queue job counts + repeatable schedules                                            |
| `/api/admin/ops/queues/failed?limit=`  | GET    | Recent failed jobs (id, name, failedReason, attemptsMade, timestamp); `limit` 1–100        |
| `/api/admin/ops/queues/retry-failed`   | POST   | Retry all failed jobs (bounded to 100) → `{ retried, total }`                              |
| `/api/admin/ops/queues/jobs/:id/retry` | POST   | Retry a single failed job                                                                  |
| `/api/admin/ops/maintenance`           | GET    | Current maintenance flag `{ enabled, message? }`                                           |
| `/api/admin/ops/maintenance`           | POST   | Set the flag `{ enabled, message? }`                                                       |
| `/api/admin/ops/flags`                 | GET    | Resolved feature flags (read-only; toggling stays env-based — see §8)                      |

- **Health never throws.** A failing dependency is reported as `down` with its
  error message; the endpoint still returns 200 with `status: "degraded"`.
  `storage` is honestly `{ status: "not_configured" }` until S3/blob is wired.
- **Queue client.** The module owns a BullMQ `Queue('holds')` **client** built
  from the same `REDIS_URL`/connection settings the worker uses (host/port,
  `maxRetriesPerRequest: null`). It only reads/manages jobs — it registers no
  processor and never competes with the worker. It is a singleton, closed on
  module destroy.
- **Queue retry usage.** Use per-row **Retry** for a single job, or **Retry all
  failed** (confirm dialog) to re-queue the failed set. Retries that are no
  longer applicable (job already moved on) are skipped and counted honestly.

### Built — maintenance mode (Redis-backed, OFF by default)

A single Redis key (`etg:maintenance`, JSON `{ enabled, message? }`, no
migration) drives a global `MaintenanceGuard`. When **ON**, non-exempt requests
receive **HTTP 503** with the standard error envelope
(`code: "MAINTENANCE_MODE"`, `message`).

- **OFF by default.** With the key unset the guard is a pass-through — existing
  flows and e2e behave exactly as before.
- **Fail-open.** The flag is read via a short-lived (~3s) in-memory cache that
  **never throws**; if Redis is unreachable the guard treats maintenance as OFF,
  so an outage can never start blocking traffic.
- **Always exempt** (so probes/scrapers keep working and admins can turn it off):
  `/api/health`, `/api/ready`, `/api/metrics`, everything under `/api/auth/*`,
  and everything under `/api/admin/*` (which includes the ops + maintenance
  endpoints themselves).

Toggle it from **Operations → Maintenance mode** (confirm dialog + optional
message) or `POST /api/admin/ops/maintenance`.

---

## 2. Metrics catalog

The API owns a private `prom-client` registry (default Node process metrics via
`collectDefaultMetrics` plus the custom series below). All custom metrics are
prefixed `etg_`. Increments are **best-effort and never throw** — a metrics
failure can never break a request or a business flow.

### Custom metrics

| Metric                              | Type      | Labels                  | Incremented at                                                       |
| ----------------------------------- | --------- | ----------------------- | -------------------------------------------------------------------- |
| `etg_bookings_created_total`        | counter   | —                       | `BookingsService.create` success (PENDING_PAYMENT hold placed).      |
| `etg_bookings_confirmed_total`      | counter   | —                       | `PaymentsService.confirm` success (payment settled, tickets issued). |
| `etg_refunds_completed_total`       | counter   | —                       | `RefundsService.process` APPROVE success (money + tickets settled).  |
| `etg_checkins_total`                | counter   | —                       | `CheckinsService.scan` SUCCESS (ticket ACTIVE → CHECKED_IN).         |
| `etg_payments_failed_total`         | counter   | —                       | `PaymentsService.fail` (provider webhook reported `payment.failed`). |
| `etg_http_requests_total`           | counter   | `method`,`status_class` | every finished HTTP request (from the logging interceptor).          |
| `etg_http_request_duration_seconds` | histogram | `method`,`status_class` | every finished HTTP request, same timing as the log line.            |

- `status_class` is bucketed (`2xx`, `4xx`, `5xx`) to keep label cardinality low —
  the raw status code and path are **not** metric labels (would explode series).
- The duration histogram buckets are `5ms … 10s`, suitable for API latency SLOs.
- Default process metrics (event-loop lag, heap, CPU, GC, open FDs, etc.) come
  from `collectDefaultMetrics` and are exposed on the same endpoint.

### Recommended alert rules (planned — wire into Alertmanager)

These are **recommendations**, not yet deployed:

```yaml
groups:
  - name: eticketsgo
    rules:
      # Payment failure rate high (business + provider-health signal).
      - alert: PaymentsFailureRateHigh
        expr: |
          sum(rate(etg_payments_failed_total[10m]))
          / clamp_min(sum(rate(etg_bookings_created_total[10m])), 1) > 0.2
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: '>20% of created bookings are hitting payment failure.'

      # Booking-confirm path error rate (5xx on POST) — checkout is degrading.
      - alert: CheckoutErrorRateHigh
        expr: |
          sum(rate(etg_http_requests_total{method="POST",status_class="5xx"}[5m]))
          / clamp_min(sum(rate(etg_http_requests_total{method="POST"}[5m])), 1) > 0.05
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: '>5% of POSTs returning 5xx.'

      # API latency SLO breach (p95 > 1s over 10m).
      - alert: ApiLatencyP95High
        expr: |
          histogram_quantile(0.95,
            sum(rate(etg_http_request_duration_seconds_bucket[10m])) by (le)) > 1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: 'API p95 latency > 1s.'

      # Readiness flapping / DB or Redis down.
      - alert: ApiNotReady
        expr: probe_success{job="eticketsgo-api-ready"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: 'API /ready failing — Postgres or Redis unreachable.'
```

> **Oversell should be impossible by construction**, not by alerting: inventory
> holds are placed with an atomic, conditional SQL reservation and confirmation
> settles held→sold in a single transaction (see ADR-010/013 and the inventory
> strategy tests). There is deliberately no "oversell counter"; if you ever need
> to detect it, alert on the DB invariant `sold + held > capacity`, which the
> schema/logic should never allow.

---

## 3. Structured logs

### Built — JSON request logs

`LoggingInterceptor` (tech-debt **D11**, now resolved) emits **one single-line
JSON object per request** to stdout, matching the worker's JSON log shape. Schema:

```json
{
  "ts": "2026-07-13T18:00:00.000Z",
  "level": "info",
  "method": "POST",
  "path": "/api/bookings",
  "status": 201,
  "ms": 42,
  "correlationId": "b3f1c2…",
  "msg": "request"
}
```

- **Fields are a fixed whitelist.** Request bodies, `Authorization`/auth headers,
  tokens, payment payloads, and PII (emails) are **never** logged. `path` is the
  **pathname only** — the query string is stripped so tokens/emails passed as
  query params cannot leak.
- `correlationId` comes from `CorrelationIdMiddleware` (honours an inbound
  `x-correlation-id`, otherwise a UUID; echoed on the response header) — use it to
  stitch a request across logs.
- Health/readiness probes are intentionally **not** logged (kept quiet) but are
  still counted in metrics.
- The worker (`apps/worker/src/main.ts`) already emits JSON logs
  (`service:"worker"`); the API's shape is aligned with it.

### Planned — log shipping

- Ship stdout to a **log aggregator** (Loki / Elasticsearch / CloudWatch Logs /
  Datadog). Since logs are already JSON, no parsing rules are needed — index on
  `correlationId`, `status`, `path`, `ms`.
- Add `service:"api"` and a release/version field at the shipping layer for
  cross-service correlation with the worker.

---

## 4. Tracing (planned)

Not implemented today. Recommended path: **OpenTelemetry**.

- Add `@opentelemetry/sdk-node` with auto-instrumentations for HTTP, Express/Nest,
  Prisma, IORedis, and BullMQ; export OTLP to a collector (Tempo / Jaeger /
  Honeycomb).
- Seed the trace/span context from the existing `x-correlation-id` so traces,
  logs, and metrics share one id (exemplars can then link Grafana panels to
  traces).
- Priority spans: booking create → payment intent → webhook confirm → ticket
  issue; and the worker's hold-expiry / notification-dispatch jobs.

---

## 5. Backups & Restore

### Built/procedure — dev / docker-compose (Postgres)

The compose stack runs `postgres:16-alpine` as service `db` (container
`eticketsgo-db`, user/db `eticketsgo`, volume `db-data`). Redis is a cache/queue
and is **not** a source of truth — it does not need backup (holds re-derive; the
DB is authoritative).

**Back up** (logical dump, compressed custom format):

```bash
# from the host, against the running compose db
docker exec -t eticketsgo-db pg_dump -U eticketsgo -d eticketsgo -Fc \
  > backups/eticketsgo-$(date +%Y%m%d-%H%M%S).dump
```

**Restore** into a fresh/empty database:

```bash
# stop the API + worker first (avoid writes during restore)
docker exec -i eticketsgo-db pg_restore -U eticketsgo -d eticketsgo --clean --if-exists \
  < backups/eticketsgo-YYYYMMDD-HHMMSS.dump
```

- `--clean --if-exists` drops objects before recreating them (idempotent restore).
- To restore into a brand-new DB instead: create it, then `pg_restore -d newdb`.
- **Nuke-and-reseed for local dev** (destructive, not a restore) is
  `npm run db:reset` — see the Runbooks. Use `pg_dump`/`pg_restore` when you must
  preserve real data.
- Verify after restore: `npm run db:deploy` (migrations already applied → no-op),
  then `curl :4000/api/ready` and a read (`GET /api/events`).

### Recommended — production

- Use **managed Postgres** (RDS / Cloud SQL / Neon) with **PITR** (point-in-time
  recovery) enabled — continuous WAL archiving, not just nightly dumps.
- Cadence: automated snapshot **daily**, WAL retention **≥ 7 days** (tune to RPO).
  Target **RPO ≤ 5 min** (PITR) and **RTO ≤ 1 h**.
- Keep an independent **weekly `pg_dump`** off-provider as a logical, portable
  backup (guards against provider-side corruption / accidental account issues).
- **Test restores quarterly** — an untested backup is not a backup. Restore into a
  scratch instance and run the post-deploy smoke (§6).
- Store dumps encrypted; never commit them (add `backups/` to `.gitignore`).

---

## 6. Deployment validation (go-live gate)

A release is allowed to go live only when **all** of the following pass, in order:

1. **CI gate** (`.github/workflows/ci.yml`) — the same sequence gates every PR:
   `format:check` → `lint` → `typecheck` → **madge circular-dep check**
   (`deps:check`) → `db:deploy` + `db:seed` → **unit tests** → **build all apps** →
   **Playwright e2e**.
2. **`prisma migrate deploy`** against the target database (additive migrations
   only — the backward-compatibility rule; see Runbooks / ADRs).
3. **Post-deploy smoke** against the freshly deployed instance:
   - `GET /api/health` → 200 `{status:"ok"}`.
   - `GET /api/ready` → 200 (Postgres + Redis up).
   - `GET /api/metrics` → 200 with `etg_` series present.
   - **Synthetic booking**: create a booking on a seeded event, drive the mock
     payment webhook to `succeeded`, assert the booking confirms and a ticket is
     issued. Watch `etg_bookings_created_total` / `etg_bookings_confirmed_total`
     increment. (In prod, run against a canary org/event or immediately refund.)

If any step fails, **do not promote** — roll back (§7).

---

## 7. CI/CD

### Built — CI (`.github/workflows/ci.yml`)

Triggered on push/PR to `main`. Spins up Postgres 16 + Redis 7 service
containers, then: install (`npm ci`) → build shared packages → generate Prisma
client → `format:check` → `lint` → `typecheck` → `deps:check` (madge circular) →
`db:deploy` + `db:seed` → unit tests → build all apps → install Playwright →
start API + all three web apps → run e2e → upload the Playwright report.

**It does not deploy** — CI is a verification gate only.

### Planned — production pipeline (CD)

A prod pipeline extends CI with, after the gate is green:

1. **Build & push container images** (API, worker, three web apps) tagged by
   commit SHA.
2. **Run `prisma migrate deploy`** against the environment DB (additive only).
3. **Deploy** the new images (rolling / blue-green); gate rollout on `/api/ready`.
4. **Post-deploy smoke** (§6) against the new revision.
5. **Rollback** automatically if smoke fails: redeploy the previous image tag.
   Because migrations are additive/backward-compatible, the previous image keeps
   working against the new schema (no destructive down-migration needed).

---

## 8. Feature-flag "dashboard"

### Built — `GET /api/capabilities` is the source of truth

Flags resolve from `packages/shared-types/src/features.ts` (`FEATURE_DEFAULTS` +
`isFeatureEnabled`) with env overrides. The read model is a public endpoint:

```bash
curl http://localhost:4000/api/capabilities   # → { "aiRecommendations": false, ... }
```

**Toggle** via env (no code change, no deploy of new logic):

- API: `FEATURE_<UPPER_SNAKE>=1|true` (e.g. `FEATURE_AI_RECOMMENDATIONS=1`).
- Web: `NEXT_PUBLIC_FEATURE_<UPPER_SNAKE>=1|true`.
- Truthy = `1` or `true`; anything else = off. Shipped features default **on**,
  enterprise capabilities (`memberships`, `sponsors`, `organizerCrm`, …) default
  **off**.

After changing an env value, restart the affected process and re-check
`/api/capabilities`. See the Runbooks "Feature-flag toggles" recipe and the
Developer Handbook §3 for the full key list.

### Planned — flag UI

A **UI dashboard** (admin-web) to view/toggle flags per environment without env
edits — a thin write layer over the same resolution logic. Not built; env is the
control plane today.

---

## 9. Error reporting

### Built — structured logs

Today, errors surface through the JSON logs (§3) and `AllExceptionsFilter`, which
maps thrown `AppException`s to typed error codes/HTTP statuses. Failed HTTP
requests are counted in `etg_http_requests_total{status_class="5xx"}`.

### Planned — Sentry

Recommended: **Sentry** (or equivalent) for aggregated error tracking with stack
traces, release/version tagging, and alerting.

- **Where it hooks in:** initialise the SDK in `apps/api/src/main.ts` (bootstrap),
  and capture from `AllExceptionsFilter` (`apps/api/src/common/all-exceptions.filter.ts`)
  for anything not a handled `AppException` (unexpected 5xx). Do the same in the
  worker's `failed`/`error`/crash handlers (`apps/worker/src/main.ts`).
- Attach the `correlationId` as a Sentry tag so an event links back to the JSON
  log line (and, once §4 lands, the trace).
- Scrub PII in `beforeSend` (emails, buyer names, payment refs) to preserve the
  same no-PII posture as the logs.

---

## 10. Operational dashboard (Grafana panels)

A Grafana board over the §2 metrics would show:

- **Business funnel (rate):** bookings created vs confirmed vs payments failed —
  `rate(etg_bookings_created_total[5m])`, `..._confirmed_total`,
  `etg_payments_failed_total`. A confirmed/created ratio dropping is checkout
  trouble.
- **Refunds & check-ins:** `rate(etg_refunds_completed_total[5m])` and
  `rate(etg_checkins_total[5m])` (check-ins spike at event doors — a live-ops
  signal).
- **Request rate by status class:** `sum by (status_class)
(rate(etg_http_requests_total[1m]))` — a stacked graph; watch `5xx`/`4xx`.
- **Latency percentiles:** p50/p95/p99 from
  `histogram_quantile(…, rate(etg_http_request_duration_seconds_bucket[5m]))`.
- **Error ratio (SLO):** 5xx / total, with a burn-rate view against an SLO target.
- **Runtime health:** event-loop lag, heap used, CPU, GC pause, open FDs from the
  default process metrics.
- **Readiness/uptime:** `/api/ready` probe success and process `uptime`.

---

## Change log

- **Ops Excellence sprint:** structured JSON request logging (D11), Prometheus
  `/metrics` + domain/HTTP metrics catalog, and this document. Additive and
  backward-compatible — no business-flow or schema changes.
