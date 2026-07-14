# Sales Playbook

Covers the **buying-decision** parts of **Phase 1** and the **sales strategy** of
**Phase 6**. Personas: [Acquisition Plan](./CUSTOMER-ACQUISITION-PLAN.md).

## Ideal Customer Profile (ICP) — who to chase first

Organizers who run **≥ 6 paid experiences/year**, handle **money + check-in**, want
**their own brand/data**, and feel **fee or payout pain**. Sweet spot: colleges,
event companies, conferences, music/comedy promoters, sports clubs, regional cinemas.

**Disqualify (for now):** one-off free events with <50 people (send to self-serve),
enterprises needing heavy custom dev before value.

## Qualification — MEDDPICC-lite

- **Metrics:** current fees, payout lag, no-show rate, hours lost to setup/recon.
- **Economic buyer:** owner/COO/finance (see persona decision makers).
- **Decision criteria:** payouts, fees, movies+events, white-label, reliability.
- **Decision process:** self-serve pilot vs procurement.
- **Pain:** quantified (fee $, payout days, cash leakage, gate chaos).
- **Champion:** the operator who feels the pain daily.
- **Competition:** BMS/Eventbrite/DICE/Ticketmaster/Forms (see [analysis](./COMPETITIVE-ANALYSIS.md)).

## Sales motion by segment (recap)

| Segment                            | Motion                          | Cycle  | Proof needed                           |
| ---------------------------------- | ------------------------------- | ------ | -------------------------------------- |
| Comedy, meetups, small nonprofit   | Self-serve PLG                  | days   | Fee calc, quick start                  |
| Colleges, sports clubs, mid events | AE demo + pilot                 | 1–4 wk | Reference, 15-min publish              |
| Conferences, music promoters       | Sales-eng + pilot               | 2–6 wk | On-sale reliability, tiers demo        |
| Multiplex, gov, corporate          | Founder + partner + procurement | 1–6 mo | Security, SLA, white-label, references |

## Discovery questions (by pain)

- "Walk me through your last event from setup to getting paid — where did time go?"
- "What % of ticket price goes to fees today, and who eats it?"
- "How many days until money hits your account? How do you reconcile?"
- "How do you handle the gate — duplicates, no-shows, refunds?"
- "Whose brand is on the ticket, and who owns the buyer's data?"
- (Cinema) "How dependent are you on the aggregator? What would owning your app change?"

## Demo script (15–20 min)

1. **Frame (1m):** "I'll publish a live, payable event in under 5 minutes, then show
   payments, check-in, and payouts." Tie to their pain from discovery.
2. **Publish (4m):** pick their use-case template → set price/capacity/fee mode →
   inline fee preview → **Publish**. Grab the share link + QR poster.
3. **Buy (3m):** attendee flow on mobile → seat map / GA → localized checkout →
   instant QR + WhatsApp/email confirmation.
4. **Money (4m):** provider config + **Test connection** green; settlement summary;
   reconciliation queue; **payout schedule/status**. "This is the part nobody else
   solves."
5. **Check-in (2m):** scanner PWA → SUCCESS vs DUPLICATE; live checked-in count.
6. **Their world (3m):** movies+events toggle, white-label branding, analytics.
7. **Close (2m):** "Want to run your next event on this? We'll set you up in the
   pilot and you'll publish today." → next step + owner + date.

**Demo rules:** always live (never slides for the product); use their logo/currency;
end with a concrete next step.

## Objection handling

| Objection                        | Response                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "We already use Eventbrite/BMS." | "Keep it if you love the fees. Here's your fee-savings + what you gain: your brand, your data, faster payouts, and movies too. Run one event side-by-side." |
| "Switching is risky."            | "Pilot one event. We migrate your first setup and staff you on event day. Zero downside."                                                                   |
| "Fees?"                          | Transparent calculator; you choose who pays; almost always ≤ incumbent.                                                                                     |
| "Reliability at on-sale?"        | Circuit-breaker + failover + readiness gate; reference a music pilot.                                                                                       |
| "Security/compliance?"           | [Security sign-off](../reports/PAYMENT-SECURITY-SIGNOFF.md), no raw card/bank data, audit log, RBAC, fail-closed.                                           |
| "We need our own app."           | White-label branding + embed; roadmap for deeper white-label.                                                                                               |
| "Payments in my country?"        | India/US/CA/AU/UK via Stripe/Razorpay/PayPal/Square, auto-routed.                                                                                           |

## Pricing conversation

Lead with **value + who-pays-the-fee flexibility**, not rate. Anchor on
fee-savings + payout speed + hours saved. Offer: **pilot at standard rate, Pro/
white-label for volume, nonprofit/education discount.** Hold margin on white-label
via annual + wholesale rate card. Don't discount the long tail — improve
self-serve instead.

## Deal desk & handoffs

- **PLG → Sales:** when a self-serve org crosses GMV/volume threshold or requests
  white-label/SLA, route to AE.
- **Sales → CS:** on close, warm handoff with the [onboarding checklist](./ORGANIZER-SUCCESS-PLAYBOOK.md#onboarding-checklist-give-to-every-new-organizer).
- **CS → Sales:** health 🟢 + high GMV → expansion/referral play.

## Assets

Pitch deck, one-pager, ROI calculator, case study template — in the
[Marketing Playbook](./MARKETING-PLAYBOOK.md). Reference stories from the
[Pilot](./PILOT-PROGRAM-GUIDE.md).

## Sales KPIs

Pipeline created, demo→pilot rate, pilot→paid rate, time-to-first-publish, win rate
by segment, ACV, CAC payback, partner-sourced pipeline.
