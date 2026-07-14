# Competitive Analysis

Covers **Phase 6 (competitors)**. Companion to the
[Go-To-Market Strategy](./GO-TO-MARKET-STRATEGY.md).

## Landscape by market

| Market        | Movies                             | Events (mid-market)                                      | Enterprise/large                   |
| ------------- | ---------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| **India**     | BookMyShow, District (Zomato)      | BookMyShow, Townscript, Insider, Explara, Zoho Backstage | BookMyShow, Ticketmaster (limited) |
| **USA**       | Fandango, Atom (cinema-owned apps) | Eventbrite, DICE, Ticketleap, Universe, Luma             | Ticketmaster, AXS, SeatGeek, Cvent |
| **Canada**    | Cineplex (own)                     | Eventbrite, Showpass, DICE, Luma                         | Ticketmaster, Cvent                |
| **Australia** | Cinema chains (own)                | Eventbrite, Humanitix, TryBooking, Try Booking, Moshtix  | Ticketek, Ticketmaster             |
| **UK**        | Cinema chains (own)                | Eventbrite, DICE, Skiddle, Ticket Tailor, Fatsoma        | Ticketmaster, AXS, See Tickets     |

## Head-to-head (what actually matters to buyers)

| Dimension                          | BookMyShow / Ticketmaster              | Eventbrite                | DICE                       | Humanitix / TryBooking / Ticket Tailor | **ETicketsGo**                                            |
| ---------------------------------- | -------------------------------------- | ------------------------- | -------------------------- | -------------------------------------- | --------------------------------------------------------- |
| Movies **and** events in one       | Movies-first (BMS) / events-first (TM) | Events only               | Music events               | Events only                            | **Both, first-class**                                     |
| Multi-country payments + routing   | Region-locked                          | US/UK/etc, Stripe-centric | Limited                    | Region-specific                        | **Stripe/Razorpay/PayPal/Square, auto-routed + failover** |
| Organizer payouts + reconciliation | Slow, opaque                           | OK, fee-heavy             | OK                         | OK                                     | **Fast, reconciled, transparent**                         |
| Fees to organizer/attendee         | High convenience fees                  | ~3.7%+$1.79/tkt (US)      | Fan-friendly, curated only | Low (Humanitix donates)                | **Low, transparent, configurable**                        |
| White-label / own-brand            | No (aggregator owns fan)               | Limited                   | No                         | Limited                                | **Yes (per-organizer branding)**                          |
| Time-to-first-event                | N/A (managed)                          | ~30–60 min                | Curated onboarding         | ~20–40 min                             | **<15 min (target)**                                      |
| Data ownership                     | Aggregator owns it                     | Shared                    | Curated                    | Organizer                              | **Organizer owns it**                                     |
| Seat maps / GA / check-in          | Strong (movies)                        | Basic                     | GA-focused                 | Basic seat                             | **Seat maps + GA + QR check-in**                          |

## Where each competitor is weak (our wedge)

- **BookMyShow / District (India):** own the customer + charge high convenience
  fees; regional cinemas and mid-market organizers are a cost center, not a
  customer. → We give them **their brand, their data, faster payouts, lower fees.**
- **Ticketmaster / AXS / Ticketek:** enterprise-only, slow, expensive, poor
  self-serve. → We win **mid-market** on speed and economics.
- **Eventbrite:** ubiquitous but **fee-heavy**, events-only, generic. → We win on
  **fees + movies + multi-country payouts + white-label.**
- **DICE:** great fan UX but **curated/invite-only** and music-only. → We serve the
  **long tail** DICE won't onboard.
- **Humanitix / TryBooking / Ticket Tailor:** low-fee and loved, but **single-
  market, events-only, thin payments/ops**. → We match low fees and add
  **multi-country payments, reconciliation, movies.**
- **Zoho Backstage / Cvent / Hopin:** conference-heavy, complex, pricey. → We win
  **simplicity + payments** for the mid-market conference.

## Differentiators (defensible)

1. **Movies + events in one platform** — nobody credible does both for mid-market.
2. **Payments as a feature, not a footnote** — country/currency routing, failover,
   reconciliation, discrepancy queue, fast payouts. This is our moat and our
   [security/ops story](../guides/PAYMENT-PLATFORM.md).
3. **Time-to-value** — <15-minute first experience; first payout within promise.
4. **Organizer owns the brand + data** — the anti-aggregator pitch.
5. **Transparent, configurable fees** — no surprise convenience fees.

## Competitive risks & counters

- **Price war (Humanitix/Ticket Tailor low fees):** compete on payouts + movies +
  multi-country, not just price; offer nonprofit tier.
- **Incumbent bundling (BMS/TM):** target segments they neglect; move fast on
  references.
- **Eventbrite brand:** lead with fee calculator + case studies + migration help.
- **Do-it-yourself (Forms/Luma):** win on payments, check-in, refunds, reporting —
  the things Forms can't do.
