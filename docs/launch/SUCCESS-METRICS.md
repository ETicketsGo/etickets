# ETicketsGo — Launch Success Metrics

What "good" looks like for the pilot and early launch. Most metrics are already available in
the platform's analytics/reports (reuse, don't rebuild) — see the admin **Business reports**
(`/admin/reports`) and `/api/metrics`.

## North-star
Successful, reconciled events where customers get in and organizers get paid.

## Commercial / product KPIs
| Metric | Source | Pilot target |
| --- | --- | --- |
| Checkout conversion (created → confirmed) | `conversion()` / platform funnel | ≥ 60% |
| Payment success rate | **Payment Health** report (new) | ≥ 95% |
| Ticket sell-through | organizer event report | per-event goal |
| Check-in rate at the gate | `attendance().checkInRate` | ≥ 90% of issued |
| Refund rate | Refund report | ≤ 5% |
| Repeat-customer rate | Growth & Retention | trending up |
| New organizers onboarded | Growth (newOrganizers, new) | pilot cohort |

## Reliability / ops KPIs
| Metric | Source | Target |
| --- | --- | --- |
| API availability | uptime monitor / `/health/ready` | ≥ 99.9% |
| API p95 latency | `/api/metrics` (HTTP histogram) | within SLO |
| 5xx error rate | metrics + Sentry | < 0.5% |
| Queue backlog | worker `etg_queue_jobs` | drains each interval |
| Time-to-first-response (support) | support tooling | per [SUPPORT-PLAN](SUPPORT-PLAN.md) SLAs |
| P1 incidents | incident log | 0 unresolved at review |

## Financial integrity
- 100% of confirmed bookings issue exactly one set of tickets (idempotent — no double-issue).
- Settlement reconciles with zero unexplained discrepancies (finance reconciliation console).

## Review cadence
Daily during the pilot (dashboards + Sentry), then the formal
[post-launch review](POST-LAUNCH-REVIEW-TEMPLATE.md). Wider rollout is gated on hitting the
commercial + reliability targets above with no unresolved P1s.
