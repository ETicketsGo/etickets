# World-class product review

Read-only. Nothing was implemented, merged, deployed or configured. Reviewed against release
candidate `9b73984`, with live observation of production `www.eticketsgo.com`.

## TECHNICALLY STRONG, PRODUCT WEAK

---

## Evidence discipline

This review is honest about what it could and could not see, because the failure mode being
guarded against is exactly a code reading dressed up as an observation.

| Level             | What it means here                                              |
| ----------------- | --------------------------------------------------------------- |
| **OBSERVED**      | Fetched from live production over HTTPS and read                |
| **CODE VERIFIED** | Read in source; never experienced in a rendered UI              |
| **TEST VERIFIED** | Proven by the test suite (4,853 unit/integration, 70 e2e specs) |
| **NOT VERIFIED**  | Could not be established in this pass                           |

**The largest limitation, stated first:** I have no browser. I fetched server-rendered HTML and
read source. **No human has done a usability pass on this product**, and this review is not a
substitute for one. Every score below carries that caveat, and the UX scores in particular are
inference from structure, not from watching anyone use it.

---

## Part 1 — The five-minute test

I fetched `https://www.eticketsgo.com/` as a stranger would. **OBSERVED.**

| Question                            | Answer from the page                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| What is ETicketsGo?                 | _"Ticketing platform. Sell tickets. Check in guests. Grow every event."_ A product for running a box office |
| What can I buy?                     | **Nothing is shown.** No event, no film, no city, no showtime appears anywhere on the homepage              |
| Why trust it?                       | _"We store amounts as whole units, never as rounded decimals. Repeating a request does not charge twice."_  |
| Why use it over another platform?   | Not answered. The page argues "we have ticketing features"                                                  |
| Find something interesting quickly? | No. The primary CTA is **"Start selling tickets"**; "Browse live events" is secondary                       |
| Understand pricing?                 | _"The prices below are placeholders while we set the real ones."_ **Live, today**                           |

### The finding that matters most

**The front door sells software, not tickets.** The `<title>` is literally
_"ETicketsGo: Sell tickets, check in guests, see your sales"_. The nav is Features / Solutions /
Pricing / For organizers / For attendees. The hero pitches a box office. There is a mock sales
dashboard with invented figures (₹4.2L, 1,284 tickets, 92% check-in).

A buyer who lands here has no reason to stay, and no reason to arrive: nothing on this page
could rank for "book movie tickets Hyderabad".

There _is_ a consumer shell — `/events` and `/movies` have a different navigation (All cities /
Explore / Browse / Movies) and a consumer footer (_"Buy tickets, keep them on your phone"_). But
it is **behind** the marketing site rather than being the site. BookMyShow's homepage **is** the
inventory. Ours is a SaaS landing page with the shop in a side door.

This is a positioning problem, not a UI problem, and it is the single largest product finding in
this review.

Two further observations:

- Production's API returns 2 Hyderabad events, and **no event title or slug appears in the
  server-rendered `/events` HTML**. Whether a real browser would render them after hydration is
  **NOT VERIFIED** — I will not claim the page is empty without seeing it.
- The trust section reads as written by engineers for engineers. "Whole units", "repeating a
  request does not charge twice", "signed and changes over time" are _our_ correctness
  properties. No buyer has ever chosen a ticketing site for its idempotency.

---

## Part 2 — Buyer journey

Mostly **CODE VERIFIED** and **TEST VERIFIED**. Scores are capped accordingly.

| Stage                 | Score | Note                                                                                                                       |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| Discovery (entry)     | **2** | The front door is a SaaS pitch; the shop is a sub-page                                                                     |
| Search                | 3     | Title/city/category/date filters exist and are plain                                                                       |
| Category browse       | 3     | Commodity, adequate                                                                                                        |
| Event / movie page    | 4     | Organizer, artists, age limit, duration, terms, ratings — genuinely rich                                                   |
| Venue                 | 3     | Present; city/timezone correct per-cinema                                                                                  |
| Showtime / date       | 4     | Showtimes model is strong; timezone handled per cinema                                                                     |
| Ticket type           | 3     | Derived types, quick-pick count                                                                                            |
| Seat selection        | 4     | Zoomable positional map, aisles excluded, wheelchair spaces modelled                                                       |
| Pricing               | **4** | One shared `PriceBreakdown`, every fee itemised with its GST share. Better than most                                       |
| Checkout              | 3     | Guest checkout exists — a real conversion win                                                                              |
| Payment               | 3     | Razorpay live; UPI QR gated on account config                                                                              |
| Confirmation          | 3     | Reference `ETG-IN-2026-…`, receipt in the same transaction                                                                 |
| Ticket + QR           | 4     | Server-signed, single-use, works without signal                                                                            |
| Order history         | 3     | Account + guest "find my booking"                                                                                          |
| Cancellation / refund | 3     | Customer cancel exists; **refund policy page declares itself undecided**                                                   |
| Support               | **1** | No published support address. The contact form posts to `/support`, which is real — but nothing tells a worried buyer that |

**Buyer average: 3.1.** Competitive minimum, with two excellent stretches (price transparency,
the ticket itself) and two unacceptable ends (the front door, support).

The journey's _middle_ is good. Its _edges_ — how you arrive, and what you do when something
goes wrong — are the weakest parts of the product.

---

## Part 3 — Organizer journey

**CODE VERIFIED.**

The console has **18 top-level navigation items**: Dashboard, Get started, Events, Venues &
rooms, Find a booking, Counter, Promotions, Movies, Finance, Payouts, Receipts, Refunds,
Notifications, Team, Premium, Help, Settings.

| Workflow              | Score | Note                                                                                                   |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| Signup / organization | 3     | 2-pending-org cap, identity verification                                                               |
| Onboarding            | 3     | A real "Get started" exists — good instinct                                                            |
| Venue / rooms         | 3     | Merged into one section after earlier feedback                                                         |
| Event creation        | **2** | Six mandatory steps: Basic details → Venue → Sessions → Ticket types → **Fee handling** → Review       |
| Schedules             | 4     | Day/week scheduling, overlap protection, turnaround                                                    |
| Ticket types          | 3     | Adequate                                                                                               |
| Pricing               | 3     | Clear, with regulated ceilings for India                                                               |
| Seating               | 4     | Sectioned arena/theatre/stadium maps; strong                                                           |
| Fees                  | **2** | Fee incidence is a required decision before a first sale                                               |
| Publish               | 3     | Draft → submit → review; admin auto-publish for trusted orgs                                           |
| Sales monitoring      | 3     | Live dashboard, by-market table                                                                        |
| Attendee management   | 3     | Door list, CSV                                                                                         |
| Check-in              | 3     | Works, but see Part 5                                                                                  |
| Cancellation / refund | 3     | Organizer refund console exists                                                                        |
| Settlement / payout   | **2** | Two payout systems held apart by guards; "Finance" + "Payouts" + "Receipts" as three separate sections |
| Reconciliation        | **2** | Operator-grade concepts surfaced to organizers                                                         |
| Reporting             | 3     | CSV everywhere                                                                                         |

**Organizer average: 2.8.**

### Would an organizer understand this without an engineer?

For a cinema chain: probably yes — the scheduling and seating work is genuinely strong and
shaped for them.

For an independent organizer running one comedy night: **no.** They meet 18 sections and a
six-step wizard in which step five asks them to form a policy on fee incidence. Eventbrite gets
someone from signup to a published event in roughly three decisions. We ask for considerably
more before the first ticket is sellable.

Terminology leaking from our model into their screens: "Fee handling", "Receipts" separate from
"Finance" separate from "Payouts", "Counter", "Premium", "Venues & rooms". Each is defensible
internally; collectively they are an admin surface, not a product.

---

## Part 4 — Cinema experience

**CODE VERIFIED.** This is the strongest part of the platform.

Operator side: movies, auditoriums, seat layouts, day/week scheduling with overlap protection
and turnaround, pause/reschedule/cancel, regulated price ceilings encoded per jurisdiction
(Andhra Pradesh done, Telangana deliberately empty), per-cinema timezones.

That is real cinema-operator work, and it is better than a generic events tool would be.

**But compare conceptual load to BookMyShow.** A buyer there does: city → film → cinema → time →
seats → pay. Six steps, no vocabulary. Our model exposes _screens_, _rooms_, _sessions_,
_shows_, _experience types_ — a correct model, and more of it reaches the surface than BookMyShow
ever shows anyone.

**Do we expose complexity BookMyShow hides?** Yes, on the operator side — appropriately. On the
buyer side the risk is the same discovery problem as Part 1: BookMyShow opens on films near you;
we open on a pitch.

**Do we offer anything meaningfully better for cinemas?** Offline gate check-in, and regulated
price-ceiling enforcement. Both are real. Neither is advertised as the reason to choose us.

Cinema operator score: **4**. Cinema buyer score: **3**.

---

## Part 5 — Gate experience

**CODE VERIFIED**, and the weakest persona relative to its importance.

500 people in 20 minutes, poor network, a temporary worker with five minutes of training.

**What is genuinely excellent:** the offline model. Each approved device holds a signed ticket
list, queues its scans, and the server reconciles on reconnect. _"A scan the device rejected can
never become an admission."_ The device holds no signing key. Devices must be approved
individually. There are **five dedicated e2e specs** for offline gate behaviour (activation,
device lifecycle, device loss, command centre, sync). This is hard engineering done well, and
**TEST VERIFIED**.

**What is wrong is the human surface around it.** The scanner is a page inside the organizer
console: `/organizer/events/[id]/checkin`. There is no gate app and no gate-shaped view.

So the door worker:

1. signs in to the organizer console,
2. meets the **same 18-item navigation** — `CHECKIN_STAFF` is a real role and the invite default,
   but the nav array is **not filtered by role**, so Finance, Payouts, Receipts and Settings are
   all listed,
3. navigates Events → the right event → Check-in.

Whether the API refuses the data behind those links is **NOT VERIFIED** in this pass; server-side
RBAC very likely does. But the UX hands a first-shift teenager a finance-bearing admin console
and asks them to find the scanner in it.

| Aspect                                      | Score |
| ------------------------------------------- | ----- |
| Offline correctness                         | **5** |
| Scanner startup / reaching the scanner      | **2** |
| Role-appropriate view                       | **1** |
| Duplicate / wrong-event / refunded handling | 4     |
| Manual lookup                               | 3     |
| Supervisor escalation                       | **2** |

**Gate average: 2.8** — a 5/5 engine behind a 1/5 door.

**What could create a queue:** a worker who cannot find the scanner, or who lands on the wrong
event's check-in page. Both are navigation problems, not scanning problems.

---

## Part 6 — ETicketsGo operator experience

**CODE VERIFIED.** The admin console has **23 sections**: ai, audit, bookings, cinema-pricing,
events, finance-reconciliation, merchant-onboarding, movies, ops, organizers, payment-config,
payment-promotion, payments, payouts, refunds, reports, settings, settlements, staff, support,
tax-rules, users.

Against the scenarios asked:

| Scenario                                   | Can we diagnose it? | Evidence                                                                           |
| ------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------- |
| Payment succeeds, booking does not confirm | **Yes, now**        | `WebhookEvent.processingStatus`, and two new log lines merged in #215              |
| Webhook stops arriving                     | Partly              | No alert exists; you would notice by absence                                       |
| SMS stops working                          | **No**              | SMS cannot deliver at all today                                                    |
| Refund fails                               | Yes                 | `refund.failed` → FAILED + audit row for follow-up                                 |
| Razorpay and our ledger disagree           | Yes                 | `SettlementReconciliationFinding`, with authorized disposition that moves no money |
| Payout fails                               | Yes                 | Payout console, allocation ledger                                                  |
| Organizer complains                        | Yes                 | Support inbox, complaints attributed to a seller                                   |
| Duplicate QR scans                         | Yes                 | Scan log once devices sync                                                         |

**The data and the consoles exist, and an operator would not need SQL.** That is better than most
products at this stage, and it is the second-strongest area after the gate engine.

**What is missing is the top of it.** There is no single "what needs a human right now" view
across payments, webhooks, refunds, payouts and reconciliation. There are grouped admin
summaries and a `needs-attention` component on the organizer side, but no operator action centre,
and **no alerting**: every scenario above is discovered by someone deciding to look.

Operator score: **3**, held back by absence of alerting rather than absence of visibility.

---

## Part 7 — Mobile

**CODE VERIFIED.** An Expo app with 21 screens and four tabs (home, search, tickets, profile),
plus seat selection, checkout, booking detail, movie/event pages and support. Version `0.1.0`.
There is also an installable PWA, with real-device defects previously found and fixed.

**Would I install it?** Only if I already had a reason to be on the platform. The app does not
offer anything the web does not.

**After installing, is there a reason to keep it?** For a ticketing app there are exactly two
durable reasons: your tickets live there, and it tells you things. The first is satisfied. **The
second does not work** — production holds no FCM or VAPID credentials, so push cannot deliver.
The app therefore cannot remind you about tonight's show, which is the one thing that would make
someone keep it.

Mobile score: **3** for the build, **2** for the reason to exist.

---

## Part 8 — Trust

What a new buyer sees before paying. **OBSERVED** on live production.

| Signal                  | State                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Real business identity  | **Absent.** `legalName` unset; `/terms` says the operating entity "is not published here yet" |
| Support contact         | **Absent.** No published address or phone                                                     |
| Clear total             | **Good.** Every fee itemised with its GST share                                               |
| Refund rules            | **"We have not decided whether fees are refundable, or how cancellations work"** — live       |
| Cancellation rules      | Same page, same state                                                                         |
| Terms                   | _"draft for demonstration and is not yet legally binding"_                                    |
| Privacy                 | _"draft for demonstration"_                                                                   |
| Organizer agreement     | _"draft for demonstration"_                                                                   |
| Taxes                   | No GST line on any sale; production charges `tax 0` on INR                                    |
| Venue info              | Good                                                                                          |
| Organizer identity      | Good — approval requires legal name, entity type, country                                     |
| Placeholders            | **Pricing: "placeholders while we set the real ones"**                                        |
| Fabricated social proof | Removed. A mock dashboard with invented figures remains                                       |
| Unfinished UI           | Four legal pages self-declare as drafts                                                       |

### `TRUST: 1.5 / 5`

This is the most serious finding after positioning, and the cheapest to fix.

A buyer in India being asked for ₹500 currently sees: a site that describes itself as a ticketing
_platform_, placeholder prices, a refund policy that says we have not decided, legal pages marked
"draft for demonstration", no company name, and no way to contact anybody. **Any one of those
would stop a cautious buyer. Together they look like a student project** — and that judgement is
not harsh, it is what the page says about itself.

None of this reflects the engineering underneath, which is the problem: the quality is real and
entirely invisible at the point of decision.

---

## Part 9 — Competitive position

### vs BookMyShow (India)

|                      | Them                             | Us                                         |
| -------------------- | -------------------------------- | ------------------------------------------ |
| Discovery            | Homepage **is** films near you   | Homepage is a SaaS pitch                   |
| Movies               | Canonical catalogue, every chain | 2 events in production                     |
| Seat booking         | Fast, familiar                   | Comparable map, arguably better modelled   |
| Checkout             | Known, trusted                   | Clearer fee breakdown than theirs          |
| Pricing presentation | Opaque "convenience fee"         | **Better than theirs** — itemised with GST |
| Mobile               | Habitual daily app               | 0.1.0, push dead                           |
| Trust                | Decade of brand                  | 1.5/5                                      |
| Organizer value      | Take-it-or-leave-it              | Far more self-service                      |

**Materially better than BookMyShow:** fee transparency, offline gate check-in, organizer
self-service, regulated price-ceiling enforcement.

**Materially worse:** discovery, inventory, trust, brand, habit. Inventory and habit are not
engineering problems and cannot be closed by building.

### vs Ticketmaster

Their reserved seating, venue relationships and ticket-ownership model are mature and
defensible. Our seating model is credible and our gate story is better for venues with poor
networks. We are not competing for their accounts, and should not try.

### vs Eventbrite

Their organizer onboarding is the benchmark and we are behind it: they optimise ruthlessly for
time-to-first-published-event; we ask for six wizard steps and present 18 console sections. Our
depth (seating, cinema scheduling, offline gate, settlement) exceeds theirs, which is precisely
the trade we have made — depth over approachability.

---

## Part 10 — Differentiation

Claims, each challenged:

| Candidate                                     | Verdict                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offline gate check-in**                     | **REAL.** Signed per-device ticket lists, queued scans, server reconciliation, no signing key on the device, per-device approval, a rejected scan can never become an admission. Hard to copy, and solves a problem Indian venues genuinely have. Five dedicated e2e specs |
| **Fee transparency**                          | **REAL but shallow.** Genuinely better than BookMyShow, and copyable in a sprint                                                                                                                                                                                           |
| **Regulated price ceilings as configuration** | **REAL and narrow.** Valuable to Indian cinemas, worthless elsewhere                                                                                                                                                                                                       |
| Multi-provider payments                       | Not differentiation. Buyers never see it; organizers do not choose on it                                                                                                                                                                                                   |
| Supports movies and events                    | Scope, not differentiation                                                                                                                                                                                                                                                 |
| Modern architecture                           | Irrelevant to every persona                                                                                                                                                                                                                                                |
| AI                                            | No valuable outcome shipped. Not differentiation                                                                                                                                                                                                                           |
| Lower fees                                    | Not defensible — no structural cost advantage                                                                                                                                                                                                                              |
| Reserved seating                              | Commodity; everyone has it                                                                                                                                                                                                                                                 |

**One durable differentiator: offline gate check-in.** It is real, it is hard, it matters, and
**nothing in the product markets it as the reason to choose us.** It is listed as feature six of
six on the homepage.

Not `NO STRONG DIFFERENTIATION YET` — but close to it, and the one we have is buried.

---

## Part 11 — Where the investment went

| Classification    | Areas                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KEEP**          | Booking + seat engine, payments, ticket/QR, check-in, receipts, price transparency, guest checkout                                                            |
| **DIFFERENTIATE** | **Offline gate check-in** (invest more, and say so loudly), fee transparency, cinema scheduling + regulated ceilings                                          |
| **COMMODITY**     | Coupons, reports/CSV, email, account management, admin CRUD                                                                                                   |
| **DEFER**         | Multi-provider payments beyond Razorpay, Stripe/Connect, museum/theme-park/tour/attraction experience types, Qube adapters, inventory sourcing providers, AI  |
| **REMOVE / HIDE** | "Premium" section, the mock dashboard with invented figures, reconciliation concepts on the _organizer_ surface, most of the engineering-flavoured trust copy |

### Over-engineering, specifically

Built before a single real customer transaction existed:

- Transactional outbox + in-process domain event bus (ADR-038, ADR-041)
- Distributed Redis seat-lock engine with Lua, fencing and reconciliation (ADR-039) — **flag off**
- External inventory sync: webhooks, polling, canonical model, circuit breakers (ADR-040) — **all
  flags off**
- Provider-neutral booking orchestration (ADR-042)
- `PayoutAllocation` ledger, transfer-attempt records, reversal reconciliation sweeper, settlement
  reconciliation findings with authorized disposition — **execution disabled**
- Stripe Connect (US) — never run against Stripe
- Six experience types, of which two are in use
- An AI gateway with usage accounting

This is a large amount of correct, well-tested machinery for volumes we have never had, in
markets we have not entered, behind flags that are off. The reconciliation work in particular is
the right answer to a problem we have not yet encountered **once**.

I am not arguing it was wasted — the money-safety discipline is why I trust the payment path.
I am arguing the ratio is wrong: roughly 4,850 tests and 70 browser specs, and **zero** real
customers.

---

## Part 12 — What is missing

Kept deliberately small.

### P0 — blocks adoption outright

1. **A consumer front door.** City → what is on → buy, as the homepage. Without this there is no
   buyer funnel at all.
2. **Trust basics.** Company name, support contact, a decided refund policy, real prices. Cheap,
   and currently disqualifying.
3. **Any way to reach an Indian customer.** No SMS, no WhatsApp, no push. Phone sign-in — the
   primary route in this market — cannot work.

### P1

4. A gate-shaped view for `CHECKIN_STAFF` (one screen: pick event, scan).
5. Inventory. Two events is not a marketplace; this is sales, not engineering.
6. Operator alerting on the eight failure scenarios in Part 6.

### P2

7. Organizer time-to-first-event: fewer steps, better defaults, "Fee handling" moved out of the
   critical path.
8. Push notifications, so the mobile app has a reason to be kept.

### Later

Everything currently behind a flag.

---

## Part 13 — The world-class test

| Dimension                |   /10 |
| ------------------------ | ----: |
| Buyer UX                 |     5 |
| Organizer UX             |     5 |
| Cinema UX                |     6 |
| Gate UX                  |     5 |
| Mobile UX                |     4 |
| Trust                    | **2** |
| Payments                 |     7 |
| Operational control      |     6 |
| Finance / reconciliation |     8 |
| Reliability engineering  |     9 |
| Differentiation          |     3 |
| **Overall product**      | **4** |

### Engineering maturity: 9 / 10

### Product maturity: 4 / 10

**Why they are five points apart.** Every incentive in this project has rewarded correctness and
nothing has rewarded desirability. The evidence is in the artefacts: 4,853 tests, 70 browser
specs, falsification discipline on every guard, money invariants proven against real
PostgreSQL — and a homepage that asks a buyer to start selling tickets, with placeholder prices
and a refund policy that says we have not decided.

The team (me) has been answering _"does it behave as engineered?"_ with increasing rigour, and
has never been made to answer _"would anyone pick this?"_ Those are different questions and only
the first has had tests.

---

## Part 14 — The brutal questions

**1. Would buyers in Hyderabad voluntarily prefer ETicketsGo over BookMyShow? — NO.**
They would not find us; if they found us the homepage sells software; if they stayed, placeholder
prices and a draft refund policy would stop a cautious buyer. We have 2 events; BookMyShow has
every screen in the city. Fee transparency is genuinely better and is not enough to overcome any
of the above.

**2. Would a cinema voluntarily replace its workflow with ETicketsGo? — NO, not yet.**
Closer than the buyer answer. Scheduling, seat maps, regulated ceilings and offline check-in are
real and relevant. But a cinema switching ticketing is betting its revenue, and we have taken
zero real transactions, have no reference customer, no support contact and no SLA. The product is
plausibly good enough; the company is not yet credible enough.

**3. Would an independent organizer choose us over Eventbrite? — NO.**
Eventbrite gets them selling in minutes. We ask for six wizard steps, present 18 console
sections, and expose settlement and reconciliation concepts they will never need. We are better
for a venue with seating and a gate; worse for one comedy night.

**4. Is ETicketsGo world-class? — NO.** Parts of it are: the offline gate engine, the money
discipline, the price transparency. The product a person meets is not.

**5. Is ETicketsGo a toy? — NO.** Emphatically. The money path is fail-closed, the seat engine
is correct under concurrency, the gate model is better than most commercial products, and the
reconciliation work is serious. It reads as a toy at the front door while being industrial
underneath, which is the opposite of the usual failure and is why this is worth fixing rather
than restarting.

**6. Is it over-engineered? — YES.** Named in Part 11: outbox, domain event bus, distributed
seat locks, external inventory sync, provider-neutral orchestration, payout allocation ledger,
reversal reconciliation, Stripe Connect, four unused experience types, AI gateway. All behind
flags, all tested, none exercised by a customer.

**7. The three highest-leverage changes.**

1. **Make the front door a ticket shop.** The homepage becomes city → what is on → buy. Move the
   organizer pitch to `/organizers`. This is the difference between having a funnel and not.
2. **Make offline gate check-in the headline, and give it its own screen.** It is the one real
   differentiator, it is buried as feature six, and the people who use it meet an 18-item finance
   console instead of a scanner. Market it; build the gate view; sell to venues with bad wifi.
3. **Finish the trust surface.** Company name, support address, decided refund policy, real
   prices, legal pages out of draft. Days of work, no engineering, and currently the reason a
   careful buyer would leave.

**8. What to stop building.**

Stop building backend capability. Concretely: no more payment providers, no more inventory
provider adapters, no more experience types, no more finance machinery, no AI, no "Premium", and
nothing else behind a flag. The platform's engineering is ahead of its product by a wide margin
and every further capability widens the gap.

Also stop treating a green suite as progress. It measures the thing that is already strong.

---

## Part 15 — Path to world class

### Phase 1 — Must win

1. A buyer landing on `eticketsgo.com` sees what is on near them and can buy in three taps.
2. A buyer can see who they are paying, how to reach us, and what happens if they want a refund.
3. An Indian buyer can receive their ticket and sign in by phone.
4. One real customer completes purchase → ticket → entry → refund, reconciled to zero.
5. A door worker opens one screen and scans, with no access to money.

### Phase 2 — Differentiate

1. A venue with unreliable wifi chooses us _because_ of the gate, and can say so.
2. An organizer publishes their first event in under five minutes.
3. A buyer trusts our price because it is itemised and nobody else's is.
4. A cinema runs a week of real schedules without calling us.
5. An operator is told something is wrong before an organizer tells them.

### Phase 3 — Scale

1. Enough inventory in one city that a buyer has a reason to return.
2. A second city opens without engineering work.
3. A mobile app people keep, because it tells them about tonight.
4. Organizers are paid on a schedule they can predict and check.
5. The platform survives an on-sale spike without a human watching.

---

## The decision this review is for

The question was whether this is a company-worthy product. **The engineering is company-worthy;
the product is not yet, and the gap is unusually cheap to close** — the three highest-leverage
changes are a landing page, a scanner screen and a page of real business facts. None of them is
hard. All of them have been deprioritised for eighteen months of backend depth.

The risk is not that ETicketsGo cannot become good. It is that the thing that has been rewarded
so far will keep being rewarded.
