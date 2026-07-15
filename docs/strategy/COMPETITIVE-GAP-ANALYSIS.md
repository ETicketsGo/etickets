# ETicketsGo — Competitive Gap Analysis & 12-Month Roadmap

**Question:** If ETicketsGo competed head-to-head with **BookMyShow, Ticketmaster,
Eventbrite, District, and Ticket Tailor** today, what are the top gaps ranked by
impact, effort, and customer value — and how do we close them over 12 months
**without compromising the current architecture** (modular monolith, shared UI
kit, payment platform, booking engine, inventory strategies, QR infra)?

Scoring key — **Impact** (revenue/retention/differentiation), **Effort** (S ≤1wk,
M ≤1mo, L 1-3mo, XL >3mo), **Value** (customer-perceived). Ranked by
Impact × Value ÷ Effort. "Reuse" notes the existing system each gap extends.

---

## Where we already win (protect these)

- **Multi-country payment platform** with routing/failover/reconciliation — deeper
  than Eventbrite/Ticket Tailor; on par with Ticketmaster without the lock-in.
- **Movies + events + seat maps in one platform** — BookMyShow does movies,
  Eventbrite does events; few do both with one wallet.
- **Transparent fees + organizer payouts + white-label** — a wedge against
  aggregators (BookMyShow/District) that own the customer relationship.
- **Booking references, grouped ticket wallet, focused QR viewer** (v1.2 Sprint 1
  - prior) — a premium attendee wallet already ahead of Ticket Tailor.

---

## Tier 1 — Close now (highest impact, ≤ M effort) — Q1

| #   | Gap                                                | Competitor benchmark           | Impact | Effort | Value | Reuse                              |
| --- | -------------------------------------------------- | ------------------------------ | ------ | ------ | ----- | ---------------------------------- |
| 1   | **Secure ticket transfer / attendee assignment**   | Ticketmaster, DICE             | High   | M      | High  | Ticket + QR nonce                  |
| 2   | **Secure single-ticket sharing (revocable links)** | Ticketmaster, District         | High   | M      | High  | QR signing, tokens                 |
| 3   | **Automated event reminders (24h/3h/1h/15m)**      | All                            | High   | S      | High  | NotificationService, BullMQ worker |
| 4   | **Offline ticket access (PWA cache)**              | BookMyShow, DICE               | High   | M      | High  | wallet API, service worker         |
| 5   | **Apple/Google Wallet passes (.pkpass)**           | Ticketmaster, DICE, Eventbrite | High   | M      | High  | QR infra                           |
| 6   | **Fast/batch/group gate check-in**                 | Ticketmaster, BookMyShow       | High   | M      | High  | checkins module, QR                |
| 7   | **Waitlist + sold-out re-release**                 | Eventbrite, DICE               | High   | M      | High  | inventory strategies               |
| 8   | **Dynamic/tiered pricing + early-bird windows**    | Ticketmaster, Eventbrite       | High   | M      | High  | TicketType, FeeRule                |
| 9   | **Discount codes UX + group/bulk pricing**         | Eventbrite, Ticket Tailor      | Med    | S      | High  | Coupon model                       |
| 10  | **Post-event ratings → discovery ranking**         | BookMyShow, District           | Med    | S      | High  | Review + discovery                 |
| 11  | **Organizer live event-day dashboard**             | Ticketmaster, Eventbrite       | High   | M      | High  | analytics, ops metrics             |
| 12  | **SEO/event schema + shareable OG pages**          | Eventbrite (dominant)          | High   | S      | Med   | public events pages                |

## Tier 2 — Build next (strong impact, M–L effort) — Q2

| #   | Gap                                                                                            | Competitor benchmark      | Impact | Effort | Value | Reuse                      |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------- | ------ | ------ | ----- | -------------------------- |
| 13  | **Experience Wallet abstraction (WalletItem)** — memberships, passes, parking, F&B, gift cards | DICE, District super-app  | High   | L      | High  | ticket model → generalize  |
| 14  | **Season passes / multi-event bundles**                                                        | Sports/Ticketmaster       | High   | L      | High  | booking engine             |
| 15  | **Memberships & subscriptions**                                                                | DICE+, cinemas            | High   | L      | Med   | payments, CRM              |
| 16  | **Food & beverage / add-on commerce at checkout**                                              | BookMyShow, District      | High   | L      | High  | booking items              |
| 17  | **Reserved-seating for events (not just movies)**                                              | Ticketmaster              | High   | M      | High  | seat maps (already built!) |
| 18  | **Native mobile app / installable PWA shell**                                                  | All aggregators           | High   | XL     | High  | web apps → PWA first       |
| 19  | **Recommendations 2.0 (behavioural + cross-sell)**                                             | BookMyShow, District      | High   | M      | High  | recommendations engine     |
| 20  | **Semantic search + filters (date/price/city/genre)**                                          | All                       | Med    | M      | High  | discovery                  |
| 21  | **Organizer self-serve payout + statements UX**                                                | Stripe-grade              | Med    | M      | High  | payouts, reconciliation    |
| 22  | **Refund self-service + partial/again UX polish**                                              | Eventbrite                | Med    | S      | High  | refunds module             |
| 23  | **Multi-language / localization (i18n)**                                                       | BookMyShow (regional)     | High   | L      | High  | web-kit, notifications     |
| 24  | **Fraud/velocity controls at checkout**                                                        | Ticketmaster              | High   | M      | Med   | payments, reconciliation   |
| 25  | **Chargeback/dispute workflow**                                                                | Ticketmaster              | Med    | M      | Med   | reconciliation queue       |
| 26  | **Abandoned-cart + win-back automation**                                                       | Eventbrite                | Med    | S      | Med   | notifications, CRM         |
| 27  | **Embeddable checkout widget / API**                                                           | Ticket Tailor, Eventbrite | Med    | M      | Med   | bookings API               |
| 28  | **Promoter/affiliate tracking + attribution**                                                  | DICE, Eventbrite          | Med    | M      | Med   | analytics                  |

## Tier 3 — Differentiate (strategic, L–XL) — Q3–Q4

| #   | Gap                                                    | Competitor benchmark          | Impact | Effort | Value | Reuse                    |
| --- | ------------------------------------------------------ | ----------------------------- | ------ | ------ | ----- | ------------------------ |
| 29  | **Resale / secondary marketplace (price-capped)**      | Ticketmaster, DICE            | High   | XL     | High  | ticket transfer (#1)     |
| 30  | **Anti-scalping: identity-bound tickets, rotating QR** | DICE (rotating), Ticketmaster | High   | L      | Med   | QR versioning (exists)   |
| 31  | **Live streaming / hybrid events**                     | Eventbrite, DICE              | Med    | XL     | Med   | new module               |
| 32  | **Sponsorship / ad inventory for organizers**          | BMS/District monetize         | Med    | L      | Med   | new                      |
| 33  | **Loyalty / points / rewards**                         | District, cinemas             | Med    | L      | Med   | CRM foundation           |
| 34  | **Gifting / send-a-ticket flow**                       | Ticketmaster                  | Med    | M      | Med   | sharing (#2)             |
| 35  | **Group booking coordination (split pay, RSVP)**       | Meetup/DICE                   | Med    | L      | High  | bookings                 |
| 36  | **Calendar & venue seat-map builder self-serve**       | Ticketmaster Presence         | Med    | L      | Med   | seat maps                |
| 37  | **Organizer CRM: attendee segments + campaigns**       | Eventbrite                    | High   | L      | High  | CRM foundation           |
| 38  | **Advanced analytics: cohort, LTV, funnels**           | Ticketmaster                  | Med    | M      | Med   | analytics                |
| 39  | **On-site POS / box-office / cash + card**             | Ticketmaster, BMS             | High   | XL     | Med   | payments                 |
| 40  | **Access control hardware / turnstile integrations**   | Ticketmaster                  | Med    | XL     | Low   | checkins                 |
| 41  | **Tax/invoice compliance per region (GST/VAT)**        | All at scale                  | High   | L      | Med   | finance layer            |
| 42  | **Multi-currency display + FX transparency**           | Global players                | Med    | M      | Med   | payments                 |
| 43  | **AI organizer copilot (draft event, price, promo)**   | emerging                      | Med    | L      | Med   | AI strategy doc          |
| 44  | **AI support assist / deflection**                     | emerging                      | Med    | M      | Med   | KB + support             |
| 45  | **Accessibility certification (WCAG 2.2 AA audit)**    | trust/legal                   | Med    | M      | High  | web-kit (already strong) |
| 46  | **Status page + public uptime + incident comms**       | Stripe-grade trust            | Med    | S      | Med   | ops metrics              |
| 47  | **Data export / GDPR self-serve (DSAR)**               | compliance                    | Med    | M      | Med   | admin                    |
| 48  | **Organizer marketplace / templates gallery**          | Eventbrite                    | Low    | M      | Med   | events                   |
| 49  | **Attendee networking / community per event**          | Meetup, DICE                  | Low    | L      | Med   | new                      |
| 50  | **Sustainability / carbon + paperless reporting**      | ESG differentiator            | Low    | M      | Low   | analytics                |

---

## Phased 12-month roadmap (architecture-preserving)

All phases **extend** existing modules — no re-architecture, no breaking changes,
every increment behind the standard gate (format/lint/typecheck/test/build/
Playwright/a11y/backcompat).

### Q1 — "Attendee trust & event-day" (Tier 1)

Transfer (#1), sharing (#2), reminders (#3), offline PWA (#4), wallet passes (#5),
fast/batch check-in (#6), waitlist (#7), event reminders live, organizer event-day
dashboard (#11), SEO/OG (#12). **Theme:** every attendee and gate interaction feels
premium and reliable. Directly maps to v1.2 Sprints 2-4, 8, 9, 10.

### Q2 — "Commerce depth & reach" (Tier 2)

WalletItem abstraction (#13) unlocking memberships/passes/F&B (#15,16), event
reserved seating (#17 — seat maps already exist), recommendations 2.0 (#19),
search (#20), i18n (#23), fraud controls (#24), embeddable checkout (#27).
**Theme:** monetize more per attendee; expand addressable market.

### Q3 — "Differentiate vs aggregators" (Tier 3a)

Resale marketplace (#29) built on transfer, anti-scalping (#30), organizer CRM
campaigns (#37), loyalty (#33), gifting (#34), group/split-pay (#35), advanced
analytics (#38). **Theme:** features aggregators use to lock organizers in — but
on ETicketsGo's transparent, organizer-owned terms.

### Q4 — "Scale, trust & intelligence" (Tier 3b)

Tax/compliance per region (#41), POS/box-office (#39), AI copilot + support assist
(#43,44), WCAG 2.2 audit (#45), status page (#46), GDPR self-serve (#47).
**Theme:** enterprise-grade trust + operational scale for large organizers/chains.

---

## The strategic bet

ETicketsGo's edge is **not** out-featuring Ticketmaster on hardware or DICE on
curation — it is being the **transparent, organizer-owned, movies-and-events
Experience Commerce Platform** with a **premium attendee wallet** and a **global
payment backbone**. The roadmap therefore prioritizes:

1. **Attendee experience** (wallet, transfer, sharing, offline, passes, reminders)
   — the visible premium layer, cheap to build on what exists, hard for
   aggregators to match without cannibalizing their walled gardens.
2. **Commerce depth** (WalletItem: memberships, passes, F&B, bundles) — higher
   revenue per attendee, the DICE/District super-app playbook, on our rails.
3. **Organizer ownership** (CRM, payouts, embeddable checkout, resale on their
   terms) — the anti-aggregator wedge that wins supply.

Sequenced this way, each quarter ships standalone value while compounding toward a
platform that is **premium like Apple, transparent like Stripe, and organizer-first
like Shopify** — without touching the architecture that already works.
