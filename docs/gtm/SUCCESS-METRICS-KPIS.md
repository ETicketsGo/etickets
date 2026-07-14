# Success Metrics & KPIs

Covers **Phase 10**. Many of these are directly observable from the platform
(bookings, GMV, payment success, refunds, payouts, analytics, support/feedback).

## North-star & guardrails

- **North Star:** **GMV processed** (organizer value created) — because it captures
  both adoption (organizers × experiences) and depth (bookings × price).
- **Guardrails (never trade off):** payment success rate, refund rate, Sev-1 count,
  organizer CSAT. Growth that breaks these is not growth.

## Core KPI tree

```
GMV ─┬─ Active organizers ─── Published experiences ── Bookings ── Avg order value
     ├─ Payment success rate (× conversion)
     ├─ Repeat organizers (retention) + Repeat attendees
     └─ Platform revenue (fees) ── Take rate ── Gross margin
Health: refund rate · payout success/on-time · support tickets/100 orgs · CSAT/NPS
```

## Cadence dashboards

### Weekly (operating rhythm — pilot & launch)

| Metric                                        | Target (pilot)              |
| --------------------------------------------- | --------------------------- |
| New signups → **published** (activation %)    | ≥ 60% publish within 7 days |
| Time-to-first-publish (median)                | < 15 min                    |
| Active organizers (published/sold in last 7d) | ↑ WoW                       |
| Bookings + GMV                                | ↑ WoW                       |
| Payment success rate                          | ≥ 97%                       |
| Failed-payment retries recovered              | track                       |
| Refund rate                                   | ≤ 5% (segment-dependent)    |
| Sev-1 incidents / MTTR                        | 0 / —                       |
| Support: first response, tickets/100 orgs     | < 1h / ↓                    |
| Pilot weekly-review actions closed            | 100%                        |

### Monthly

| Metric                                    | Target                       |
| ----------------------------------------- | ---------------------------- |
| Active organizers (MAO)                   | ↑ MoM                        |
| New vs repeat organizers                  | repeat ≥ 40% by M3           |
| Experiences published                     | ↑                            |
| GMV + platform revenue + take rate        | ↑; take rate stable          |
| Attendees; repeat attendee rate           | ↑                            |
| Activation (signup→publish→first sale)    | ≥ 50% signup→first sale      |
| Payment success / refund / payout on-time | ≥97% / ≤ median / 100%       |
| CSAT / NPS                                | CSAT ≥ 4.3 / NPS ≥ 30        |
| CAC by channel / CAC payback              | payback < 12 mo (target < 6) |
| Support deflection (KB)                   | ≥ 50%                        |

### Quarterly (board / strategy)

| Metric                                    | Target                             |
| ----------------------------------------- | ---------------------------------- |
| GMV run-rate + platform revenue           | on plan                            |
| Net revenue retention (organizers)        | ≥ 100% (expansion > churn)         |
| Logo retention                            | ≥ 85% annualized                   |
| Repeat organizers                         | ≥ 50%                              |
| Market mix (India/UK/AU/US/CA)            | beachhead ≥ 60%, expansion growing |
| Partner-sourced GMV                       | ≥ 15% by end of year               |
| NPS trend + top feature themes shipped    | ↑                                  |
| Gross margin (after processing + support) | ↑ toward SaaS norms                |

## The metrics the prompt named — where each lives

| Requested             | Source             | Cadence |
| --------------------- | ------------------ | ------- |
| Active organizers     | analytics / admin  | W/M/Q   |
| Published experiences | events/movies      | W/M/Q   |
| Bookings              | bookings           | W/M/Q   |
| GMV                   | payments/analytics | W/M/Q   |
| Platform revenue      | fee snapshots      | M/Q     |
| Repeat organizers     | cohort analysis    | M/Q     |
| Repeat attendees      | attendee cohorts   | M/Q     |
| Refund rate           | refunds            | W/M     |
| Payment success       | payment attempts   | W/M     |
| Support tickets       | support/feedback   | W/M     |
| Customer satisfaction | CSAT/NPS           | M/Q     |

## Instrumentation notes

- Reuse existing analytics (organizer/venue/platform), payment metrics
  (`etg_payment_*`, GMV counter), reconciliation queue, and CSAT/feedback capture.
- Define **activation** once and hold it constant: _signup → published → first
  sale_.
- Cohort everything by **signup month × segment × market**.
- Alert on guardrail breaches (payment success < 95%, refund spike, Sev-1).

## Targets ladder (illustrative launch year)

| Horizon           | Active organizers | Experiences | GMV                        | Notes                |
| ----------------- | ----------------- | ----------- | -------------------------- | -------------------- |
| Pilot (M0–M2)     | 10                | 100         | first $$ / 5,000 attendees | proof + case studies |
| M3 (GA beachhead) | 50–100            | 500+        | early run-rate             | self-serve on        |
| M6                | 250–500           | 2,500+      | growing                    | partnerships kick in |
| M12               | 1,000+            | 10,000+     | scale run-rate             | US/CA expansion      |

(Numbers are planning anchors; recalibrate after the pilot's real conversion data.)
