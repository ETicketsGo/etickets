# ETicketsGo — Go-Live Monitoring Checklist

> A go/no-go checklist for **observability** before opening the doors. Each row is a
> check item with an owner and status. It **operationalises** the
> [Monitoring Guide](../guides/MONITORING.md) (metrics catalog, Sentry, tracing,
> the Prometheus/Grafana stack) and the [Operations Runbook](./OPERATIONS.md) — see
> those for the how; this is the what-must-be-true. Alert rules referenced live in
> `observability/prometheus/alerts.yml`; the stack is
> `docker-compose.observability.yml`.
>
> Status legend: ☐ not done · ◐ partial / config-gated · ✅ done. Owners are roles
> — fill in names from the [Escalation Matrix](../pilot/ESCALATION-MATRIX.md).

---

## 1. Probes & health

| #   | Check                                                                                             | Owner  | Status |
| --- | ------------------------------------------------------------------------------------------------- | ------ | ------ |
| 1   | `GET /api/health` returns `{status:"ok"}` (liveness; never touches DB/Redis)                      | DevOps | ☐      |
| 2   | `GET /api/ready` returns 200 when Postgres+Redis up, 503 otherwise — **LB gates rollout on this** | DevOps | ☐      |
| 3   | `GET :4100/health` and `GET :4100/ready` green for the worker                                     | DevOps | ☐      |
| 4   | Container `HEALTHCHECK`s active on every image (baked in)                                         | DevOps | ✅     |
| 5   | LB rotation gated on `/api/ready` so a DB/Redis-less instance is pulled out                       | DevOps | ☐      |

## 2. Metrics — endpoints & scraping

| #   | Check                                                                                                         | Owner    | Status |
| --- | ------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 6   | `GET /api/metrics` exposes `etg_*` series (+ default process metrics)                                         | DevOps   | ☐      |
| 7   | `GET :4100/metrics` exposes `etg_worker_up`, `etg_queue_jobs{queue,state}`                                    | DevOps   | ☐      |
| 8   | `/metrics` (API **and** worker) is **network-restricted to the scraper** — never public (`@Public` by design) | Security | ☐      |
| 9   | Prometheus scrapes both targets (`observability/prometheus/prometheus.yml`, 15s)                              | DevOps   | ☐      |

### Key `etg_*` metrics to confirm are incrementing

Money/booking: `etg_bookings_created_total`, `etg_bookings_confirmed_total`,
`etg_payments_succeeded_total`, `etg_payments_failed_total`, `etg_gmv_minor_total`,
`etg_refunds_completed_total`. Gate: `etg_checkins_total`,
`etg_qr_checkin_success_total`, `etg_qr_checkin_failure_total`. Traffic/DB:
`etg_http_requests_total{method,status_class}`,
`etg_http_request_duration_seconds`, `etg_db_query_duration_seconds`,
`etg_slow_queries_total`. Full catalog + semantics:
[Monitoring Guide §1](../guides/MONITORING.md).

## 3. Alert rules to enable (`observability/prometheus/alerts.yml`)

Wire these to Alertmanager → Slack/PagerDuty/email. Each is a check item.

| #   | Alert                         | Fires when                                                     | Owner           | Status |
| --- | ----------------------------- | -------------------------------------------------------------- | --------------- | ------ |
| 10  | `HighHttp5xxRate`             | >5% of HTTP requests 5xx over 5m                               | On-call         | ☐      |
| 11  | `ApiLatencyP95High`           | HTTP p95 > 1s over 10m                                         | On-call         | ☐      |
| 12  | `PaymentsFailureRateHigh`     | payment failures >20% of bookings created over 10m             | On-call+Finance | ☐      |
| 13  | `BookingConfirmErrorRateHigh` | large share of created bookings neither confirm nor fail (15m) | On-call         | ☐      |
| 14  | `QueueFailedGrowing`          | BullMQ failed jobs increased over 10m                          | On-call         | ☐      |
| 15  | `QueueBacklogHigh`            | >100 jobs waiting for 10m                                      | On-call         | ☐      |
| 16  | `WorkerDown` / `ApiDown`      | Prometheus can't scrape worker/API for 2m                      | On-call         | ☐      |

## 4. Sentry (error tracking)

| #   | Check                                                                                                           | Owner  | Status |
| --- | --------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| 17  | `SENTRY_DSN` set for API + worker (unset ⇒ complete no-op)                                                      | DevOps | ◐      |
| 18  | `SENTRY_ENVIRONMENT` + `SENTRY_RELEASE` set (regression tracking; tie to the deploy tag)                        | DevOps | ☐      |
| 19  | Confirm only unexpected **5xx / non-HttpException** captured; expected 4xx not reported; `sendDefaultPii:false` | Eng    | ✅     |
| 20  | Correlation-id/method/path tags link a Sentry event back to the JSON log line                                   | Eng    | ✅     |

## 5. Dashboards

| #   | Check                                                                                                                                                                       | Owner    | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 21  | Grafana up; Prometheus datasource + **ETicketsGo — Overview** dashboard auto-provisioned                                                                                    | DevOps   | ☐      |
| 22  | Overview panels present: GMV, payment success rate, confirm ratio, bookings/refunds/QR, HTTP rate by status class, p50/p95/p99, 5xx ratio, queue depth, DB p95 + slow-query | DevOps   | ☐      |
| 23  | Grafana admin creds overridden (`GRAFANA_ADMIN_USER`/`_PASSWORD`, not admin/admin)                                                                                          | Security | ☐      |

## 6. Logs, tracing & on-call

| #   | Check                                                                                                                    | Owner        | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------ | ------ |
| 24  | Structured JSON logs shipping to an aggregator; searchable by `correlationId`                                            | DevOps       | ☐      |
| 25  | Slow-query reporting confirmed (`SLOW_QUERY_MS`, default 500ms → warn + `etg_slow_queries_total`; **no SQL/PII logged**) | Eng          | ✅     |
| 26  | (Optional) OpenTelemetry tracing — no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` set + OTel packages installed              | DevOps       | ◐      |
| 27  | On-call rotation + Alertmanager routes populated; live-event coverage assigned                                           | On-call lead | ☐      |
| 28  | Alertmanager receiver (Slack/PagerDuty/email) tested with a synthetic alert                                              | On-call      | ☐      |

## 7. Go-live smoke (ties monitoring to the deploy gate)

Run the [Deployment §8 smoke](../guides/DEPLOYMENT.md) and confirm the signals move:

| #   | Check                                                                                                      | Owner   | Status |
| --- | ---------------------------------------------------------------------------------------------------------- | ------- | ------ |
| 29  | Synthetic booking → payment webhook → confirm bumps `etg_bookings_confirmed_total` + `etg_gmv_minor_total` | On-call | ☐      |
| 30  | Prometheus `/targets` shows api + worker **UP**; a test alert reaches the on-call channel                  | On-call | ☐      |

---

_Related: [Monitoring Guide](../guides/MONITORING.md) ·
[Operations](./OPERATIONS.md) · [Capacity Report §5 (signals to watch)](./CAPACITY-REPORT.md) ·
[Rollback Plan](./ROLLBACK-PLAN.md) · [Disaster Recovery](./DISASTER-RECOVERY.md)._
