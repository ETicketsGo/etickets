# Go-To-Market Strategy

Covers **Phase 6** across India, USA, Canada, Australia, UK; pricing;
differentiators; sales strategy. Competitor detail in
[Competitive Analysis](./COMPETITIVE-ANALYSIS.md); partnerships in the
[Acquisition Plan](./CUSTOMER-ACQUISITION-PLAN.md#phase-7--partnership-opportunities).

## Strategy in one page

- **Beachhead:** India + one English market (start **India + UK** or **India +
  Australia** — smaller, winnable, low-fee-friendly, single-timezone-ish support).
- **Wedge segments:** colleges/universities, event companies, conferences, music/
  comedy, sports clubs, regional cinemas.
- **Motion:** hybrid — **product-led self-serve** for the long tail, **founder-led
  - partnerships** for high-value (multiplex, sports, government, corporate).
- **Moat:** payments + payouts + movies-and-events + time-to-value.

## Pricing model

Money is integer minor units; fees are configurable per the platform's fee-rule
engine. Recommended packaging:

| Plan                       | Who                                               | Price                                                                           | Notes                                               |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Free / Community**       | Free events, small meetups, nonprofits            | 0 platform fee; small attendee booking fee on free events optional              | Payment processing pass-through                     |
| **Standard (usage)**       | Most organizers                                   | **2% + small flat per paid ticket** (attendee- or organizer-paid, configurable) | + processing (Stripe/Razorpay/etc pass-through)     |
| **Pro**                    | High-volume events/conferences                    | **1–1.5% per ticket + modest monthly**                                          | Advanced analytics, priority support, custom fields |
| **Business / White-label** | Multiplex, event companies (reseller), enterprise | **Annual SaaS + wholesale per-ticket rate card**                                | Own branding, SLA, SSO, multi-brand                 |
| **Nonprofit / Education**  | Nonprofits, colleges, gov                         | Discounted or fee-waived; attendee booking fee                                  | Compliance + receipts                               |

**Principles:** transparent (no hidden convenience fees), organizer chooses who
pays the fee (`feeMode`), always cheaper-or-comparable to Eventbrite, and payouts
faster than incumbents. Publish an [ROI/fee calculator](./MARKETING-PLAYBOOK.md).

## Per-market plan

### 🇮🇳 India (primary)

- **Why:** Huge event + movie volume; BookMyShow/District dominate cinemas but
  overcharge and own the fan; mid-market events fragmented.
- **Payments:** Razorpay (primary, UPI/cards/netbanking/wallets), Stripe failover.
- **Targets:** College fests, regional multiplexes/single screens, comedy/music
  promoters, religious trusts (slots), conferences.
- **Motion:** Campus ambassadors + founder-led cinema/promoter deals + Razorpay
  co-marketing. WhatsApp-first comms (built-in).
- **Positioning:** "Your brand, your audience, your payouts — not BookMyShow's."

### 🇬🇧 UK

- **Why:** Mature events market; Eventbrite fee fatigue; DICE curated-only.
- **Payments:** Stripe (primary), PayPal.
- **Targets:** Comedy clubs, grassroots music (Skiddle/Fatsoma switchers), universities & SUs, conferences.
- **Motion:** Product-led + content (fee-savings vs Eventbrite) + SU partnerships.
- **Positioning:** "Lower fees than Eventbrite, fan experience like DICE, and you keep the data."

### 🇦🇺 Australia

- **Why:** Humanitix/TryBooking prove low-fee demand; single-market tools.
- **Payments:** Stripe (primary), Square, PayPal.
- **Targets:** Community, sports clubs, schools/universities, festivals.
- **Motion:** Product-led + nonprofit/education angle; Square co-marketing.
- **Positioning:** "Low fees like Humanitix, but multi-country and movies too."

### 🇺🇸 USA (scale after beachhead proof)

- **Why:** Largest TAM but crowded/expensive CAC; enter with references + a wedge.
- **Payments:** Stripe (primary), PayPal, Square.
- **Targets:** Universities, conferences, comedy circuits, community sports, indie cinemas.
- **Motion:** Reference-led + partnerships (Stripe, campus, PCOs); paid content once ROI proven.
- **Positioning:** "Eventbrite is expensive and events-only. Run everything, pay less, get paid faster."

### 🇨🇦 Canada

- **Why:** Similar to US/AU; Showpass/Eventbrite; friendly for early expansion.
- **Payments:** Stripe (primary), PayPal.
- **Targets:** Universities, community events, sports, festivals.
- **Motion:** Ride US content + Canadian references; bilingual (EN/FR) support note.

## Sales strategy (motion by deal size)

| Deal size                      | Motion                                        | Owner             | Cycle        |
| ------------------------------ | --------------------------------------------- | ----------------- | ------------ |
| < $1k GMV/event long tail      | Self-serve PLG (sign up → publish → we nudge) | Growth/CS         | Minutes–days |
| Mid ($1k–$50k GMV)             | Founder/AE-led demo + pilot                   | Sales Eng         | 1–4 weeks    |
| Large (chains, gov, corporate) | Solution + partnership + procurement          | Founder + partner | 1–6 months   |

**Sales assets:** [Sales Playbook](./SALES-PLAYBOOK.md), demo script + pitch deck +
one-pager + ROI calculator (in [Marketing Playbook](./MARKETING-PLAYBOOK.md)).

## Launch sequencing

1. **Pilot** (10 organizers) in India + one English market — see
   [Pilot Guide](./PILOT-PROGRAM-GUIDE.md).
2. **Reference + case studies** → self-serve GA in beachhead markets.
3. **Partnerships** (payments, campus, cinema) → scale.
4. **US/Canada** with proof.

## Regulatory / localization notes (not blocking, plan for)

- Tax/GST/VAT on fees + receipts; nonprofit tax receipts (US/CA/AU/UK).
- Data residency expectations (gov/university); privacy (GDPR UK/EU, DPDP India).
- Local payment methods (UPI India, BECS/Interac AU/CA) — routed via existing providers.
- Accessibility (public/gov events).
