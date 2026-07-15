# Chief Revenue Officer — Revenue Strategy

How ETicketsGo makes money and grows it. Pairs with the
[GTM pricing](../gtm/GO-TO-MARKET-STRATEGY.md#pricing-model), [Sales Playbook](../gtm/SALES-PLAYBOOK.md),
and [CFO projections](./CFO-FINANCE.md).

## Revenue architecture

Three engines, in order of maturity:

1. **Usage (take rate on GMV)** — the core; scales with organizer success.
2. **Subscriptions (SaaS tiers)** — predictable ARR from Pro/Business.
3. **Expansion (add-ons, white-label, CRM/automation, memberships)** — margin +
   stickiness; the "Experience Commerce" upside.

## Streams analyzed

| Stream                          | Model                                                      | Willingness-to-pay           | Notes                           |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------- | ------------------------------- |
| **Platform fee**                | 1–2% + small flat / paid ticket (who-pays configurable)    | High (≤ Eventbrite)          | Core; processing passed through |
| **Subscriptions**               | Pro (monthly + lower %); Business (annual + wholesale)     | Med–High                     | ARR + lower take-rate trade     |
| **Enterprise**                  | Annual platform + SLA + SSO + custom                       | High (chains/gov/corp)       | Long cycle, big ACV             |
| **White-label**                 | Wholesale rate card + setup + annual                       | High (event cos, cinemas)    | Reseller margin; sticky         |
| **Premium CRM**                 | Add-on tier (segments, audiences, exports)                 | Med                          | Leverages CRM foundation        |
| **Marketing automation**        | Add-on (email/SMS/WhatsApp campaigns, reminders, win-back) | Med                          | Leverages notifications engine  |
| **Memberships/seasons**         | Module fee or % on recurring                               | Med (sports/clubs/religious) | Recurring GMV                   |
| **Upsells (F&B/merch/add-ons)** | % on add-on GMV                                            | Med–High (cinemas/festivals) | Grows AOV + our take            |
| **Cross-sells (movies↔events)** | Same account, more GMV                                     | High                         | Wallet-share expansion          |
| **Sponsorship marketplace**     | % / listing fee                                            | Med                          | Later; two-sided                |

## International pricing

- **Anchor to local competition + willingness-to-pay**, not a single global rate.
- India: keep total cost **well under BookMyShow convenience fees**; UPI processing
  is cheap → competitive take-rate.
- UK/AU: **beat Eventbrite**; match Humanitix/Ticket Tailor on low fee, win on
  payments + movies.
- US/CA: price to Eventbrite with a clear fee-savings story; premium for reliability.
- Currency shown natively (INR/USD/CAD/GBP/AUD); fee mode (attendee vs organizer)
  configurable per market norm (India attendee-pays common; US organizer often absorbs).

## Revenue experiments (ranked, measurable)

1. **Fee-mode default test** (attendee-pays vs organizer-pays) → conversion vs take.
2. **Add-on attach** (F&B/merch at checkout) → AOV + incremental take.
3. **Pro upsell trigger** (at GMV/volume threshold) → ARR conversion.
4. **White-label offer** to event companies → wholesale ACV.
5. **Annual vs monthly** discount test → ARR + retention.
6. **Nonprofit/edu tier** → logo velocity + goodwill (measure downstream referrals).
7. **Marketing-automation add-on** (reminders/win-back) → no-show reduction value → attach.
8. **Referral incentive** (fee credit) → CAC reduction.
   Each experiment: single metric, guardrail (payment success/refunds), 2–4 week read.

## Sales targets (illustrative; recalibrate post-pilot)

| Horizon      | Active orgs | GMV run-rate | Platform revenue   | ARR (subs)                   |
| ------------ | ----------- | ------------ | ------------------ | ---------------------------- |
| Pilot (M0–2) | 10          | first $$     | validate take-rate | 0–small                      |
| M3 GA        | 50–100      | early        | early              | first Pro/Business           |
| M6           | 250–500     | growing      | growing            | material ARR                 |
| M12          | 1,000+      | scale        | scale              | meaningful ARR + white-label |

## Partner channels (revenue)

- **Payment providers** (Razorpay/Stripe/Square): merchant referrals → lower CAC.
- **Campus/cinema/PCO**: channel + white-label resale.
- **Reseller/agency**: event companies sell ETicketsGo to their clients (wholesale).
- Track **partner-sourced GMV ≥ 15%** by year-end (see [Partnerships](./PARTNERSHIPS-STRATEGY.md)).

## Unit economics (targets)

- **CAC:** minimize via PLG + partnerships + references; **paid CAC gated** until
  payback proven.
- **CAC payback:** target < 12 mo (stretch < 6) — see [CFO](./CFO-FINANCE.md).
- **LTV:** driven by **repeat organizers** (retention) × **GMV/org** × take-rate +
  subscription ARR + expansion. Grow LTV via retention (duplicate/recurring/seasonal)
  and expansion (add-ons/white-label) more than by raising rates.
- **LTV:CAC:** target ≥ 3:1 at scale; NRR ≥ 100% (Q2) → ≥ 110% (Q4).

## Quarterly revenue goals

- **Q1:** validate take-rate on live GMV (≥ 3 real merchants); ≥ 6 pilots paying;
  first Pro/Business intent.
- **Q2:** material GMV run-rate; white-label + referral live; NRR ≥ 100%.
- **Q3:** expansion revenue (add-ons/white-label) meaningful; US/CA revenue begins.
- **Q4:** ARR + partner-sourced GMV ≥ 15%; NRR ≥ 110%; blended take-rate stable.

## Guardrails

Never buy growth that breaks payment success (≥97%), refund rate, or reliability.
Don't discount the long tail — improve self-serve. Hold white-label margin via
annual + wholesale, not per-deal erosion.
