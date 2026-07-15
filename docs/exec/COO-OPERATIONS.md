# COO — Operations Review & Excellence Plan

Operational readiness across support, incidents, SLAs, infrastructure, deployments,
monitoring, DR/BCP, and scaling. Goal: **increase reliability, reduce support
effort, run predictably.** Builds on the shipped ops tooling (readiness/launch gate,
[outage runbook](../guides/PROVIDER-OUTAGE-RUNBOOK.md), reconciliation, admin ops
console) and the [Support Playbook](../gtm/SUPPORT-PLAYBOOK.md).

## Current operational assets (what already exists)

- **Infra:** Turborepo modular monolith — NestJS API, Next.js apps (customer/
  organizer/admin), standalone BullMQ **worker** (hold-expiry, notification sweep,
  daily reconciliation), PostgreSQL 16, Redis 7. Docker Compose (dev + prod).
- **CI:** GitHub Actions (format, typecheck, lint, tests, build); 72 test suites.
- **Payments ops:** provider health, circuit breaker + failover controls, payment-
  live **readiness gate**, **launch gate**, reconciliation discrepancy queue,
  environment promotion with approvals, fail-closed config validation.
- **Monitoring hooks:** Prometheus metrics (`etg_*`: bookings, GMV, payment success/
  failure, webhooks, reconciliation, queue depth, HTTP + DB duration, slow queries),
  optional Sentry, optional OpenTelemetry, slow-query logging.
- **Ops console:** admin health, queue depth + failed-job retry, **maintenance
  mode**, feature flags, audit log.

## Gaps to close (before/at GA)

| Gap                     | Action                                     | Owner   | When  |
| ----------------------- | ------------------------------------------ | ------- | ----- |
| Public **status page**  | Stand up status page + incident comms      | COO     | Q1    |
| Formal **on-call rota** | PagerDuty/Opsgenie-style rota + escalation | COO     | Q1    |
| **SLAs/SLOs** published | Define + publish (below)                   | COO     | Q1    |
| **DR/BCP** drills       | Backups verified + restore drill + runbook | COO/Eng | Q1→Q2 |
| **Dashboards** live     | Grafana/hosted on the `etg_*` metrics      | COO     | Q1    |
| **Alerting** wired      | Alerts on guardrail breaches               | COO     | Q1    |
| Support **tooling**     | Helpdesk + KB + in-product help            | Support | Q1    |

## SLAs / SLOs

| Service                     | SLO target                                     | Notes                                                                 |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| API availability            | 99.9% monthly                                  | health checks + redundancy                                            |
| Checkout/payment success    | ≥ 97%                                          | guardrail; alert < 95%                                                |
| Payout on-time              | 100%                                           | per payout schedule                                                   |
| Webhook processing latency  | p95 < 30s                                      | idempotent; retry-safe                                                |
| Event-day incidents (Sev-1) | 0 unresolved                                   | on-call + failover                                                    |
| Support first response      | Sev-1 15 min (event-day immediate); Sev-3 1 bd | per [Support SLAs](../gtm/SUPPORT-PLAYBOOK.md#issue-escalation--slas) |

## Incident response

- **Severity + escalation** per the [Support Playbook](../gtm/SUPPORT-PLAYBOOK.md#issue-escalation--slas)
  and [Provider Outage Runbook](../guides/PROVIDER-OUTAGE-RUNBOOK.md).
- **Process:** detect (alert/monitor) → declare + severity → incident owner + bridge
  → mitigate (failover / maintenance mode / route suspension) → comms (status page +
  affected organizers) → resolve → **post-incident review < 24h** → action items.
- **Money-first rule:** after any payment incident, review the reconciliation queue;
  never auto-correct financial records.
- **Event-day protocol:** pre-assign owner, confirm readiness/launch gate, watch
  payment success + check-in live, keep a rollback path.

## Infrastructure & scaling

- **Today:** single-region monolith + worker + Postgres + Redis; horizontally
  scalable API/web behind a load balancer; worker separate for background jobs.
- **Scale levers (no redesign):** API replicas, read replicas for Postgres, Redis
  for cache/queues, CDN for web + assets, connection pooling, queue concurrency
  tuning, seat-map/inventory already concurrency-safe (atomic holds).
- **Capacity events:** on-sale spikes handled via idempotent flows + circuit
  breaker; pre-scale for known large events; queue-based buffering.
- **Cost/perf:** slow-query monitoring (`SLOW_QUERY_MS`) + indexes; right-size infra;
  autoscale policies. (See [CFO cloud spend](./CFO-FINANCE.md).)

## Deployments

- **Pipeline:** CI gates (format/typecheck/lint/test/build) → build images →
  migrate (`prisma migrate deploy`) → deploy. Additive, backward-compatible migrations.
- **Payments config:** promoted per environment with approvals + fail-closed
  validation; secrets from the secret manager (never in images).
- **Release hygiene:** changelog + release notes to organizers; feature flags for
  safe rollout; rollback = redeploy previous image / disable flag / maintenance mode.

## Monitoring & operational dashboards

| Dashboard                                                                      | Signals                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Reliability**                                                                | API availability, error rate, p95 latency, DB duration, slow queries          |
| **Payments**                                                                   | payment success/failure, webhook results, failover events, circuit state      |
| **Money**                                                                      | GMV, payouts, reconciliation open/aging                                       |
| **Queues/worker**                                                              | queue depth, failed jobs, job latency (hold-expiry, notifications, reconcile) |
| **Business**                                                                   | active organizers, bookings, activation, refunds                              |
| **Support**                                                                    | ticket volume, first response, CSAT, deflection                               |
| Alert on guardrail breaches (payment success < 95%, Sev-1, payout delay, queue |
| backlog, error-rate spike, reconciliation aging).                              |

## Disaster recovery & business continuity

- **Backups:** automated Postgres backups (PITR) + Redis persistence; verify + test
  **restore** regularly.
- **RPO/RTO targets:** RPO ≤ 15 min (PITR), RTO ≤ a few hours; document + drill.
- **BCP:** provider failover (built-in), maintenance mode for controlled degradation,
  runbooks for outage/rotation/activation, multi-AZ (and multi-region as we scale).
- **Data integrity:** immutable fee snapshots, audit log, idempotent money
  transitions, reconciliation as the safety net.

## Reduce support effort (operational excellence)

1. **KB-first deflection** (top-20 articles) + in-product help → ≥ 50% deflection.
2. **Self-serve** onboarding, refunds, and payout visibility → fewer "how do I…"/
   "where's my money" tickets.
3. **Proactive comms** (status page, event-day readiness) → fewer inbound during incidents.
4. **Root-cause loop:** every recurring ticket → KB article or product fix (CPO backlog).
5. **Automation:** lifecycle emails, reminders, health-triggered CS plays.

- **Target:** tickets/100 organizers ↓ each month; reopen rate < 5%.

## Operations KPIs

Availability/uptime, error rate, p95 latency, payment success, payout on-time,
Sev-1 count + MTTR, queue backlog, reconciliation aging, deploy frequency + rollback
rate, tickets/100 orgs, deflection, CSAT. Feed the exec dashboard.
