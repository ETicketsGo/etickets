# ETicketsGo — Monitoring & Observability Guide

Production observability for ETicketsGo. Everything here is **additive and
config-gated**: with no Sentry DSN, no OTLP endpoint, and no observability stack
running, the app behaves exactly as before. See also
[OPERATIONS.md](../reports/OPERATIONS.md) for the broader runbook.

- **Metrics** — `prom-client` on the API (`/api/metrics`) and worker (`:4100/metrics`).
- **Slow-query reporting** — Prisma query listener → structured warn logs + metrics.
- **Error tracking** — Sentry (API + worker), opt-in via `SENTRY_DSN`.
- **Queue monitoring** — the worker exports `etg_queue_jobs{queue,state}`.
- **Dashboards & alerts** — Prometheus + Grafana via `docker-compose.observability.yml`.
- **Tracing** — OpenTelemetry, opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## 1. Metrics catalog

The API owns a private `prom-client` registry (default Node process metrics via
`collectDefaultMetrics` plus the custom series below). All custom metrics are
prefixed `etg_`. Increments are **best-effort and never throw** — a metrics
failure can never break a request or a business flow. Label cardinality is kept
bounded (no per-id/per-path labels).

### API metrics (`GET /api/metrics`)

| Metric                              | Type      | Labels                  | Incremented at                                                                        |
| ----------------------------------- | --------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `etg_bookings_created_total`        | counter   | —                       | `BookingsService.create` success (PENDING_PAYMENT hold placed).                       |
| `etg_bookings_confirmed_total`      | counter   | —                       | `PaymentsService.confirm` success (payment settled, tickets issued).                  |
| `etg_payments_succeeded_total`      | counter   | —                       | `PaymentsService.confirm` success (alongside `bookings_confirmed`).                   |
| `etg_payments_failed_total`         | counter   | —                       | `PaymentsService.fail` (provider webhook reported `payment.failed`).                  |
| `etg_gmv_minor_total`               | counter   | —                       | `PaymentsService.confirm` — incremented by the booking's `totalMinor` (GMV).          |
| `etg_refunds_completed_total`       | counter   | —                       | `RefundsService.process` APPROVE success (money + tickets settled).                   |
| `etg_checkins_total`                | counter   | —                       | `CheckinsService.scan` SUCCESS (ticket ACTIVE → CHECKED_IN).                          |
| `etg_qr_checkin_success_total`      | counter   | —                       | `CheckinsService.scan` result == SUCCESS.                                             |
| `etg_qr_checkin_failure_total`      | counter   | —                       | `CheckinsService.scan` result != SUCCESS (invalid/duplicate/cancelled/wrong-session). |
| `etg_http_requests_total`           | counter   | `method`,`status_class` | every finished HTTP request (from the logging interceptor).                           |
| `etg_http_request_duration_seconds` | histogram | `method`,`status_class` | every finished HTTP request, same timing as the log line.                             |
| `etg_db_query_duration_seconds`     | histogram | —                       | every Prisma query (duration only; observed by the slow-query listener).              |
| `etg_slow_queries_total`            | counter   | —                       | every Prisma query slower than `SLOW_QUERY_MS`.                                       |

Notes:

- **GMV** is derivable in currency major units as `etg_gmv_minor_total / 100`
  (money is stored in minor units, e.g. paise). Only positive amounts are added.
- `status_class` is bucketed (`2xx`/`4xx`/`5xx`) to keep cardinality low; the raw
  status code and path are **not** labels.
- Default process metrics (event-loop lag, heap, CPU, GC, open FDs) are on the
  same endpoint via `collectDefaultMetrics`.

### Worker metrics (`GET :4100/metrics`)

| Metric                          | Type  | Labels          | Meaning                                                                       |
| ------------------------------- | ----- | --------------- | ----------------------------------------------------------------------------- |
| `etg_worker_up`                 | gauge | —               | `1` while the worker metrics endpoint is served.                              |
| `etg_queue_jobs`                | gauge | `queue`,`state` | BullMQ job counts per state (waiting/active/completed/failed/delayed/paused). |
| `etg_queue_sample_errors_total` | gauge | —               | Count of failed attempts to sample queue counts (e.g. Redis unreachable).     |
| plus `collectDefaultMetrics`    | —     | —               | Worker process metrics.                                                       |

`/api/metrics` is `@Public()` so a scraper can reach it without a JWT. **In
production it MUST be network-restricted** to the Prometheus scraper — never
exposed to the public internet. The same applies to the worker's `:4100/metrics`.

---

## 2. Queue / worker monitoring — approach

**Decision: the worker exposes its own `/metrics`.** The API serves `/api/metrics`
but the API process does not own the BullMQ queue — the **worker** does. Rather
than push counts cross-process or have the API open a second Redis connection to
introspect a queue it doesn't manage, the worker samples `queue.getJobCounts()`
on an interval (`QUEUE_METRICS_INTERVAL_MS`, default 15s) into the
`etg_queue_jobs{queue,state}` gauge and serves them on its existing HTTP port
(`:4100/metrics`, next to `/health` and `/ready`). Prometheus scrapes **both**
targets. Sampling is best-effort and never throws — a Redis blip bumps
`etg_queue_sample_errors_total` instead of crashing the worker.

---

## 3. Slow-query reporting

`PrismaService` constructs the Prisma client with a `query` **event** emitter
(not stdout logging), so nothing is printed by default and existing queries are
unaffected. For every query it observes `etg_db_query_duration_seconds`; a query
slower than `SLOW_QUERY_MS` (default **500ms**) additionally:

- bumps `etg_slow_queries_total`, and
- emits a single structured JSON **warn** line:

  ```json
  {
    "ts": "…",
    "level": "warn",
    "msg": "slow query",
    "ms": 812,
    "thresholdMs": 500,
    "target": "Booking"
  }
  ```

**No SQL text or query params are ever logged** — only duration + the operation
target (model/action) — preserving the no-PII posture of the request logs. The
listener is fully guarded and never throws. Tune with `SLOW_QUERY_MS`.

---

## 4. Error tracking (Sentry)

Opt-in via `SENTRY_DSN`. **With no DSN, Sentry is never initialised and nothing
changes.** When set:

- The API initialises Sentry in `apps/api/src/observability/instrument.ts` (loaded
  first in `main.ts`). `AllExceptionsFilter` captures **only unexpected 5xx /
  non-`HttpException` errors** — expected 4xx `AppException`s (validation, not
  found, forbidden, conflict, …) are **not** reported. The `correlationId`,
  method and path are attached as tags to link an event back to the JSON log line.
- The worker initialises Sentry in `apps/worker/src/main.ts` and captures from its
  `failed` / `error` handlers and the startup-crash handler (tagged `service=worker`).
- `sendDefaultPii: false` keeps the same no-PII posture as the logs.

Environment:

| Env                         | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `SENTRY_DSN`                | Enables Sentry. Unset ⇒ complete no-op.                      |
| `SENTRY_ENVIRONMENT`        | Environment tag (falls back to `NODE_ENV`).                  |
| `SENTRY_RELEASE`            | Release/version tag for regression tracking.                 |
| `SENTRY_TRACES_SAMPLE_RATE` | Perf tracing sample rate; default `0` (error tracking only). |

---

## 5. Prometheus + Grafana stack

Infra-only compose file — it does **not** run the app. Start the API (`:4000`) and
worker (`:4100`) on the host first, then:

```bash
docker compose -f docker-compose.observability.yml up -d
```

- **Prometheus** → http://localhost:9090 — scrapes `host.docker.internal:4000/api/metrics`
  and `:4100/metrics` every 15s (`observability/prometheus/prometheus.yml`), and
  loads the alert rules (`observability/prometheus/alerts.yml`).
- **Grafana** → http://localhost:3005 (admin/admin; override with
  `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`). Port 3005 avoids the three web
  apps on 3000–3002.

Grafana **auto-provisions** the Prometheus datasource
(`observability/grafana/provisioning/datasources/`) and the **ETicketsGo — Overview**
dashboard (`observability/grafana/dashboards/eticketsgo.json`) via the dashboards
provider — no manual import needed. To import it elsewhere, use
_Dashboards → Import_ and upload that JSON, selecting your Prometheus datasource.

**Dashboard panels:** GMV (24h + rate), payment success rate, confirm ratio,
bookings created/confirmed/payments-failed rate, refunds & QR check-in success/
failure, HTTP request rate by status class, HTTP p50/p95/p99 latency, 5xx error
ratio, queue depth by state, and DB query p95 + slow-query rate.

If you instead run the API/worker as compose services on the same network, change
the Prometheus targets from `host.docker.internal:*` to the service names.

### Alert rules (`observability/prometheus/alerts.yml`)

| Alert                         | Fires when                                                      |
| ----------------------------- | --------------------------------------------------------------- |
| `HighHttp5xxRate`             | >5% of HTTP requests are 5xx over 5m.                           |
| `ApiLatencyP95High`           | HTTP p95 latency > 1s over 10m.                                 |
| `PaymentsFailureRateHigh`     | payment failures > 20% of bookings created over 10m.            |
| `BookingConfirmErrorRateHigh` | large share of created bookings neither confirm nor fail (15m). |
| `QueueFailedGrowing`          | BullMQ failed jobs increased over 10m.                          |
| `QueueBacklogHigh`            | >100 jobs waiting for 10m.                                      |
| `WorkerDown` / `ApiDown`      | Prometheus can't scrape the worker/API for 2m.                  |

Point these at Alertmanager for notifications (Slack/PagerDuty/email).

---

## 6. Tracing (OpenTelemetry)

**Decision: guarded, optional-dependency init.** Tracing is a **complete no-op**
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. To avoid adding heavy OTel packages to
the default build (and the instability that can bring), `apps/api/src/observability/tracing.ts`
lazily `require`s the OTel SDK **only when the endpoint is configured**; if the
packages are not installed it logs one warning and continues. So the default build
carries zero OTel weight, and activation is a two-step opt-in:

1. Install the packages into the API workspace:

   ```bash
   npm i -w @eticketsgo/api \
     @opentelemetry/sdk-node \
     @opentelemetry/auto-instrumentations-node \
     @opentelemetry/exporter-trace-otlp-http
   ```

2. Set the env and restart:

   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"   # OTLP/HTTP collector
   OTEL_SERVICE_NAME="eticketsgo-api"                     # optional
   ```

`tracing.startTracing()` is called first in `main.ts` (via `instrument.ts`) so
auto-instrumentations patch HTTP/Express/Nest, Prisma, IORedis and BullMQ before
those libraries load — giving end-to-end spans across
booking → payment intent → webhook confirm → ticket issue, and the worker jobs.
Export OTLP to Tempo / Jaeger / Honeycomb; seed span context from the existing
`x-correlation-id` to align traces with logs and metrics.

---

## 7. Verifying locally

```bash
# 1. API + worker running (see OPERATIONS.md / eticketsgo-state).
curl -s localhost:4000/api/metrics | grep -E '^etg_' | head
curl -s localhost:4100/metrics     | grep -E 'etg_queue_jobs|etg_worker_up'

# 2. Bring up the stack and open Grafana.
docker compose -f docker-compose.observability.yml up -d
#   Prometheus targets:  http://localhost:9090/targets   (api + worker => UP)
#   Grafana dashboard:   http://localhost:3005           (ETicketsGo — Overview)

# 3. Slow-query test: set a tiny threshold and watch the warn logs + counter.
SLOW_QUERY_MS=1 npm run start -w @eticketsgo/api
```

> Live Prometheus/Grafana/Sentry verification requires the stack running and a
> real Sentry DSN, which is not exercised by the unit/e2e suites.
