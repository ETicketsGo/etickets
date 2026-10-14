# MONITORING-GUIDE (P6.12)

How ETicketsGo is observed. Artifacts: `observability/` (Prometheus rules, Alertmanager, Grafana),
spec in `docs/p6/P6.7-OBSERVABILITY-DASHBOARDS-ALERTS.md`.

## Metrics

- **Scrape:** API `GET /api/metrics`, worker `GET :4100/metrics` (Prometheus, 15s).
- **Namespace:** all app metrics are `etg_*` (prom-client). Key series: `etg_bookings_created/confirmed_total`,
  `etg_booking_orchestration_total`, `etg_booking_compensation_backlog{state}` +
  `_oldest_ready_age_seconds`, `etg_booking_payment_refund_total{provider,outcome}` +
  `_payment_void_total`, `etg_inventory_lock_contention_total`, `etg_http_request_duration_seconds`,
  `etg_db_query_duration_seconds`, `etg_outbox_created_total`.
- **Exporters to add:** redis_exporter + postgres_exporter (for `RedisDown`/`PostgresDown` +
  connection/memory panels) + node_exporter (CPU/mem).

## Dashboards (Grafana, auto-provisioned)

- `eticketsgo.json` — infra/HTTP overview (existing).
- `booking-platform.json` — bookings, orchestration, compensation backlog/age/dead-letters,
  refund/void outcomes, lock contention, HTTP p95/p99 (P6.6).

## Alerts (Prometheus → Alertmanager)

- `alerts.yml` — infra (5xx, latency, payments, queue, api/worker down).
- `booking-platform-alerts.yml` — money (refund/void rejections, status-recovery stuck), compensation
  (dead-letters, backlog age, manual-review), booking (confirm-stalled, shadow-mismatch, lock
  contention), infra (redis/pg down, db p95).
- Routing: `severity=page` → pager, `warn` → ops; infra→money inhibit. Set receiver secrets at deploy.

## Thresholds

The committed thresholds are **starting points**. Recalibrate from the P6.4 soak + P6.5 load
baselines (e.g. lock-contention and DB-p95 thresholds depend on the production tier). Verify page vs
warn routing with a synthetic alert before launch.

## Logs & tracing

Central log sink (platform); no PII (verified P6.5/6.8). Sentry wired (API + worker) via `SENTRY_DSN`

- `SENTRY_ENVIRONMENT`. Correlation ids flow through domain events for cross-service tracing.

## Ops alert emails (money-critical failures)

The API and the worker email operators when a money path meets something it cannot handle. This
needs no Prometheus or Alertmanager: it goes through the email transport the platform already
uses (`EMAIL_PROVIDER`, SES in QA/PROD). Code: `apps/api/src/ops/alerts/`.

| Variable           | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `OPS_ALERT_EMAILS` | Comma-separated operator addresses. Set on BOTH the api and the worker service. |
| `SENTRY_DSN`       | Error tracking (API + worker). Unset means Sentry is never initialised.         |

- Unset `OPS_ALERT_EMAILS` (or `EMAIL_PROVIDER=log`): alerts are written to the log at ERROR only,
  and Admin console > Operations > System health shows "Ops alerts: Not configured" with the reason.
  It never blocks a request and never stops the API from booting.
- What alerts: a payment webhook rejected for its signature (Razorpay, Stripe); money captured for a
  booking that cannot take it; the expiry sweep finding a capture on a booking it was about to
  release; a new finance discrepancy; a booking that could not be confirmed after a successful
  payment; a payment webhook dead-lettered; a customer notification that has stopped retrying.
- Throttle: the first occurrence alerts at once, then at most one email per 15 minutes per kind and
  key (provider, discrepancy type, notification channel + cause), or per 6 hours for one booking or
  capture. The next email says how many happened since the last one. The gate is in Redis, so all
  API replicas and the worker share it; if Redis is down each process throttles on its own.
- Content: what happened, `APP_ENV`, UTC time, ids (booking, payment, provider reference, webhook
  event), amounts, and where to look. Never secrets, signatures, card or UPI data, customer email
  or phone, or payloads. Values are redacted again before sending.
- Last alert time is shown on the same System health card (`GET /api/admin/ops/health`,
  field `opsAlerts`).
