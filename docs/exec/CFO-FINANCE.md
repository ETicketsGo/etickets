# CFO — Finance Review & Projections

Financial model, unit economics, cost structure, dashboards, and a 12-month
projection. We are **pre-revenue**; figures are **planning models with explicit
assumptions** to be recalibrated after the pilot produces real take-rate and
conversion data. Pairs with the [CRO revenue strategy](./CRO-REVENUE-STRATEGY.md).

## Revenue mechanics

- **GMV** = tickets × price processed on the platform.
- **Platform revenue (net)** = take-rate × GMV **+** subscriptions (Pro/Business) **+**
  expansion (add-ons/white-label). Take-rate is configurable; who-pays-the-fee
  (attendee vs organizer) is set per organizer/market.
- **Processing (gateway) fees** are **pass-through** (Stripe/Razorpay/PayPal/Square)
  — not our revenue, but must be transparently accounted at settlement.

## Cost structure

| Cost                     | Driver                                     | Notes                                                      |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| **Cloud/infra**          | usage (compute, DB, Redis, bandwidth, CDN) | monolith + worker + Postgres/Redis; scale with GMV/traffic |
| **Payment processing**   | GMV                                        | pass-through; margin only if we ever mark up (we don't)    |
| **Support/CS**           | organizers × tickets                       | reduce via KB deflection + self-serve                      |
| **Sales & marketing**    | growth                                     | gate paid until payback proven                             |
| **People**               | headcount                                  | lean; first hires CS + sales-eng                           |
| **Software/tools**       | ops                                        | helpdesk, monitoring, analytics                            |
| **Compliance/legal/tax** | markets                                    | per-country registration + receipts                        |

## Unit economics (targets)

| Metric            | Target                                                | Lever                        |
| ----------------- | ----------------------------------------------------- | ---------------------------- |
| Blended take-rate | stable 1–2% (+ subs/expansion)                        | pricing discipline           |
| Gross margin      | trend to SaaS norms (70%+) after processing + support | deflection, infra efficiency |
| CAC               | low via PLG + partnerships + referrals                | gate paid                    |
| CAC payback       | < 12 mo (stretch < 6)                                 | activation + retention       |
| LTV:CAC           | ≥ 3:1 at scale                                        | retention + expansion        |
| NRR               | ≥ 100% (Q2) → ≥ 110% (Q4)                             | cross-sell/upsell/add-ons    |

## Settlements & money integrity

- **Settlement:** provider settles to platform/merchant per configured merchant
  accounts; **organizer payouts** run on a schedule with status + statements.
- **Controls:** immutable fee snapshots, reconciliation discrepancy queue (10 types),
  audit log, idempotent money transitions — financial records never auto-corrected.
- **Reporting:** settlement summary per provider/currency; payout on-time %; open
  discrepancy aging. These are the CFO's daily truth source.

## Tax readiness

- **On fees:** GST (India), VAT (UK/AU/EU), sales tax (US nexus), GST/HST (CA) —
  charge + invoice correctly per market.
- **Receipts:** attendee receipts + nonprofit tax receipts (roadmap: per-region).
- **Reporting:** 1099-K/settlement reporting (US), organizer statements, audit trail.
- **Approach:** local accounting partner per market; tax-config as a product roadmap
  item; don't let tax block the pilot (beachhead-first).

## Enterprise pricing (finance view)

- **Structure:** annual platform fee + wholesale per-ticket rate card + SLA/SSO/
  white-label premiums. Higher ACV, longer cycle, procurement.
- **Margin:** protect via annual commitment + wholesale (not per-deal erosion);
  price reliability/compliance at a premium for chains/gov/corporate.

## Financial dashboards (build)

| Dashboard                                                                          | Metrics                                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Revenue**                                                                        | GMV, platform revenue (net), take-rate, ARR (subs), expansion, by segment/market |
| **Money movement**                                                                 | processing fees, payouts, settlement, reconciliation open/aging                  |
| **Margins**                                                                        | gross margin, contribution margin by segment/market                              |
| **Efficiency**                                                                     | CAC by channel, CAC payback, LTV, LTV:CAC, NRR                                   |
| **Cash**                                                                           | burn, runway, AR/AP, cash conversion                                             |
| **Cost**                                                                           | cloud spend/GMV, support cost/org, S&M efficiency                                |
| Source from payment metrics (`etg_*` GMV), fee snapshots, payouts, reconciliation, |
| and the analytics layer.                                                           |

## 12-month projection (illustrative scenario — recalibrate post-pilot)

Assumptions (planning anchors, **not commitments**): blended take-rate ~1.5% (+
nascent subs/add-ons), avg order value and repeat rates validated in pilot, lean
team, paid spend gated until payback proven.

| Horizon      | Active orgs | Experiences | GMV run-rate | Platform rev (net)     | Notes                         |
| ------------ | ----------- | ----------- | ------------ | ---------------------- | ----------------------------- |
| Pilot (M0–2) | 10          | 100         | seed         | validate take-rate     | 5,000 attendees; case studies |
| M3 (GA)      | 50–100      | 500+        | early        | early                  | self-serve on; first subs     |
| M6           | 250–500     | 2,500+      | growing      | growing + ARR          | white-label + referral live   |
| M9           | 400–700     | 5,000+      | scaling      | scaling                | US/CA revenue begins          |
| M12          | 1,000+      | 10,000+     | scale        | scale + meaningful ARR | partner GMV ≥ 15%; NRR ≥ 110% |

**Scenarios:** run Base / Bull / Bear off pilot conversion (activation %, repeat
rate, take-rate, CAC). The single biggest sensitivity is **repeat-organizer rate**
(LTV) — prioritize retention over new-logo spend.

## Burn & runway posture

- **Bootstrap-to-proof:** minimize burn through the pilot; lean team; gated S&M.
- **Runway discipline:** model 12–18 months at current burn; **fundraise on pilot
  traction** (case studies + activation + reliability) rather than pre-proof.
- **Trigger to invest:** unit economics (CAC payback + LTV:CAC) validated → scale
  S&M + hiring deliberately.

## Finance KPIs (weekly/monthly/quarterly)

GMV, platform revenue (net), take-rate, ARR, gross/contribution margin, CAC + payback,
LTV, NRR, burn, runway, payout on-time %, reconciliation aging, cloud spend/GMV,
support cost/org. Feed the CEO exec dashboard.

## Founder decisions (finance)

1. Final pricing/packaging + take-rate.
2. S&M spend gate (payback threshold to unlock paid).
3. Fundraise timing/posture (bootstrap-to-proof vs raise-on-traction).
4. Enterprise rate card + discount floor.
5. Per-market tax/compliance investment sequencing.
