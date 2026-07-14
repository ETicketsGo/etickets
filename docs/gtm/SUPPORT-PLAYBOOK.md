# Support Playbook

Covers **Phase 5 (customer success assets)** and the support parts of **Phase 2**.
Health score + feedback live in the
[Organizer Success Playbook](./ORGANIZER-SUCCESS-PLAYBOOK.md).

## Support model

- **Channels:** in-app (built-in feedback/support), email, WhatsApp (India-first),
  help center, community. Live chat for Pro+.
- **Hours:** business hours per beachhead timezone during pilot; extend as we scale;
  event-day "on-call" for scheduled large events.
- **Tiers:** Self-serve (KB/community) → L1 (support agent) → L2 (support eng) →
  L3 (engineering) → Incident (ops on-call).

## Knowledge Base structure

```
Getting Started        Payments                 Events & Movies
  - Create account       - Connect a provider     - Create an event
  - Publish in 15 min    - Test vs live keys      - Movie shows + seat maps
  - Onboarding checklist - Fees & who pays        - Ticket types & tiers
Selling & Promotion    Payouts & Finance        Check-in
  - Share links/QR/embed - Payout schedule        - Scanner setup (PWA)
  - Discounts & coupons  - Settlement summary     - Offline scanning
  - Reminders            - Reconciliation queue   - Edge cases
Refunds                Account & Team           Troubleshooting
  - Refund policy        - Roles & permissions    - Payment failed
  - Issue a refund       - Invite check-in staff  - Webhook/confirmation delay
Trust & Security       Integrations             API & White-label
```

Each article: problem statement → steps (with screenshots) → "still stuck?" →
related. Target: **top 20 articles deflect 60%+ of tickets** by GA.

## FAQ (seed — top questions)

1. How fast can I publish? → <15 min; see quick start.
2. What fees do you charge? → transparent per-ticket; you choose who pays.
3. When do I get paid? → payout schedule + status in portal.
4. Which countries/currencies? → India, US, CA, AU, UK (INR/USD/CAD/GBP/AUD).
5. Movies _and_ events? → yes, both first-class.
6. Test before going live? → sandbox instantly; connect real provider when ready.
7. Refunds? → self-serve within your policy; status tracked.
8. Can I use my own branding? → yes (white-label on Business).
9. Do I own my customer data? → yes.
10. Check-in without internet? → offline-tolerant scanner.

## Video plan (production order)

| #   | Video                                   | Length  | Audience        |
| --- | --------------------------------------- | ------- | --------------- |
| 1   | Publish your first event in 15 minutes  | 3–4 min | New organizer   |
| 2   | Set up a movie with seat maps           | 4 min   | Cinemas         |
| 3   | Connect payments (test → live)          | 3 min   | All             |
| 4   | Fees, who pays, and payouts explained   | 3 min   | Finance         |
| 5   | Promote: share links, QR posters, embed | 2 min   | All             |
| 6   | Check-in day: scanner + edge cases      | 3 min   | Staff           |
| 7   | Refunds & reconciliation                | 3 min   | Finance/Support |
| 8   | Conferences: tiers, tracks, discounts   | 4 min   | Conferences     |
| 9   | White-label & team roles                | 3 min   | Business        |
| 10  | Reading your analytics                  | 3 min   | All             |

## Quick Start guides (1-pagers, per persona)

College Fest · Concert/Festival · Comedy Night (recurring) · Conference (multi-tier)
· Movie Show · Sports Match/Season · Nonprofit Fundraiser · Corporate Event. Each:
5 steps → publish → promote → check-in → get paid.

## Email templates (lifecycle)

- **Welcome / activation:** "Let's publish your first event (15 min)."
- **Stuck (no publish 48h):** offer template + call.
- **First sale 🎉:** celebrate + "here's how payouts work."
- **Pre-event (T-3d):** checklist + scanner reminder.
- **Post-event:** stats + "duplicate this event" + NPS.
- **At-risk (health 🔴):** CSM outreach.
- **Payout sent:** statement + next steps.
- **Win-back (dormant 60d):** what's new + seasonal template.

## WhatsApp templates (India-first, opt-in)

- Booking confirmation (attendee) — built-in.
- Event reminder (attendee) — built-in.
- Organizer: "Your event is live 🎉 share link: {url}".
- Organizer: "You've sold {n} tickets, {gmv} so far."
- Organizer: "Payout of {amount} is on the way."
- Support: "We've resolved your issue — anything else?"

Keep templates transactional + opt-in; respect BSP policy and quiet hours.

## Support macros / canned replies

Payment failed · Confirmation not received · Refund how-to · Change event details ·
Invite staff · Payout timing · Duplicate/GA vs seat · Coupon setup · Webhook delay.

## Issue escalation & SLAs

| Severity  | Definition                                                         | First response                | Resolution target     | Path                                                              |
| --------- | ------------------------------------------------------------------ | ----------------------------- | --------------------- | ----------------------------------------------------------------- |
| **Sev-1** | Payments down / can't sell / mass check-in failure / data exposure | 15 min (event-day: immediate) | ASAP; incident bridge | L1→Ops on-call→Eng; status page                                   |
| **Sev-2** | Payout delay, provider degraded, major feature broken for one org  | 1 hour                        | Same day              | L1→L2→Eng; [outage runbook](../guides/PROVIDER-OUTAGE-RUNBOOK.md) |
| **Sev-3** | Non-blocking bug, how-to, config                                   | 1 business day                | 2–3 days              | L1→L2                                                             |
| **Sev-4** | Feature request, cosmetic                                          | 2 business days               | Roadmap               | L1→Product                                                        |

**Event-day protocol:** for scheduled large events, pre-assign an on-call owner,
confirm readiness ([launch gate](../guides/PRODUCTION-ACTIVATION.md)), watch payment
success + check-in metrics live, keep a rollback path (maintenance/failover).

## Support KPIs

First response time, resolution time, CSAT, ticket deflection (KB), tickets per 100
organizers, reopen rate, Sev-1 count + MTTR. Targets in
[Success Metrics](./SUCCESS-METRICS-KPIS.md).
