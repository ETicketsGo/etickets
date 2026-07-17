# ETicketsGo — Post-Launch Review Template

Run after the pilot (and after each significant launch). Blameless, data-driven, decision-oriented.

**Review date:** [date] · **Pilot window:** [dates] · **Facilitator:** [name] · **Attendees:** [list]

## 1. Summary
- Events run: [n] · Tickets sold: [n] · Customers: [n] · Organizers: [n]
- Overall verdict: **[GO wider / iterate / hold]**

## 2. Metrics vs targets
Pull from `/admin/reports` + `/api/metrics` (see [SUCCESS-METRICS](SUCCESS-METRICS.md)).

| Metric | Target | Actual | Met? |
| --- | --- | --- | --- |
| Checkout conversion | ≥ 60% | | |
| Payment success rate | ≥ 95% | | |
| Check-in rate | ≥ 90% | | |
| Refund rate | ≤ 5% | | |
| API availability | ≥ 99.9% | | |
| 5xx rate | < 0.5% | | |
| Unresolved P1 incidents | 0 | | |
| Settlement discrepancies | 0 | | |

## 3. What went well
- [bullet]

## 4. What went wrong / friction
- [issue] — impact — root cause — [link to incident if any]

## 5. Customer feedback
- Themes, quotes, NPS/rating if collected.

## 6. Organizer feedback
- Onboarding, event creation, dashboard, payouts — themes + quotes.

## 7. Incidents
- [id] sev, summary, resolution, action items, regression test added? (Y/N)

## 8. Action items
| Action | Owner | Priority | Due |
| --- | --- | --- | --- |
| | | | |

## 9. Decision
- [ ] **GO** for wider rollout — targets met, no unresolved P1s, clean settlement.
- [ ] **Iterate** — address [items] then re-review.
- [ ] **Hold** — [blocker].

**Sign-off:** Product · Engineering · Support · Finance.
