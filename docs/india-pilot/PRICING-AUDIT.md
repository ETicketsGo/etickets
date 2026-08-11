# Pricing audit

Where a ticket price lives, who is allowed to change it, and when it stops being changeable.

Traced from the implementation and then **run against the product** on a real PostgreSQL 16
with the API, both web apps and a disposable cinema. Nothing below is inferred from a name.

---

## The question this was written to answer

A static read of the code suggested that changing a ticket price might require cloning and
republishing a seat layout version — because published layouts are immutable and
`SeatCategory.basePriceMinor` is where the number first appears. That would couple **physical
inventory structure** to **commercial pricing**, and make a routine price change a dangerous
operation.

**It is false.** Proven live, twice over:

| Experiment                                                              | Result                              |
| ----------------------------------------------------------------------- | ----------------------------------- |
| `PATCH` a future show's PREMIUM price ₹300 → ₹350                       | 200, customer seat map shows ₹350   |
| Seat layout versions before and after                                   | `[v1:PUBLISHED]` → `[v1:PUBLISHED]` |
| `SeatCategory.basePriceMinor` after                                     | still 30000                         |
| Two shows on the SAME layout, priced ₹350/₹400 and ₹250/₹400 separately | both honoured, still one layout     |

GAP-06 is **FALSIFIED as an architecture problem** and downgraded to a
**SELF_SERVICE_GAP** — which this change closes.

---

## Where the price actually lives

```
SeatMap (layout version)          ← immutable once published; PHYSICAL
  └── SeatCategory
        basePriceMinor            ← a TEMPLATE. Never charged to anyone.
                                     Read only when a show is created.
EventSession (one show)
  └── TicketType                  ← COMMERCIAL. per session × per seat category
        priceMinor  currency      ← what a customer is actually charged
        │
        ▼  read server-side at hold time, never sent by the client
BookingItem
  unitPriceMinor  lineTotalMinor  ← the SNAPSHOT. Frozen here.
Booking
  subtotalMinor … totalMinor
Payment
  amountMinor                     ← raised from the booking, not recomputed
```

The domain boundary the mission asked for **already existed**. `TicketType` is keyed by
`(eventSessionId, seatCategoryId)`, which is exactly "session + category + price". No new
model was introduced, and introducing a `ShowPrice` would have been a second place for the
same fact to live.

### Answers, precisely

| Question                                   | Answer                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Base ticket price                          | `TicketType.priceMinor`, per show                                                              |
| Seat-category price                        | `SeatCategory.basePriceMinor` — a default for scheduling only                                  |
| `GET /public/movies/:slug/shows`           | `fromPriceMinor` = cheapest ACTIVE `TicketType.priceMinor` for that session                    |
| `GET /public/shows/:id/seats`              | per category, `ticketType?.priceMinor ?? category.basePriceMinor`                              |
| Price used at hold                         | re-read from `TicketType` inside `BookingsService.create`, through the pricing strategy        |
| Price persisted on booking                 | `BookingItem.unitPriceMinor` / `lineTotalMinor`, plus the `Booking` money split                |
| Price at payment initiation                | `Payment.amountMinor`, created from `fees.totalMinor` in the same transaction as the booking   |
| Can the client submit a price?             | **No.** `createBookingSchema` has no price field of any kind; the server reads the ticket type |
| Price changes after a seat is held         | the hold keeps its snapshot; the next buyer gets the new price                                 |
| Price changes after a booking is confirmed | refused — `Price cannot be changed after tickets have sold.`                                   |
| Layout version changes                     | irrelevant to price. Shows are pinned to a layout version; their ticket types are their own    |

---

## The snapshot boundary

**At hold.** `BookingItem.unitPriceMinor` is written when the booking row is created, in the
same transaction as the seat hold.

Everything downstream reads that row. Nothing recomputes a booking from current pricing —
there is no code path that does, and `Payment.amountMinor` is set once from the booking's own
total.

Observed on a real database:

```
A holds a ₹300 seat                    → BookingItem.unitPriceMinor = 30000
organizer moves PREMIUM to ₹350        → 200 OK (a HELD seat does not lock a price)
A's booking re-read                    → still 30000, total still 31620
public seat map                        → 35000
B books                                → BookingItem.unitPriceMinor = 35000
A pays                                 → CONFIRMED at 31620
organizer tries ₹400                   → 409 "Price cannot be changed after tickets have sold."
A's booking re-read                    → still 30000
```

A held seat deliberately does **not** freeze the price. The buyer's line was snapshotted the
moment they held it, so the two cannot disagree; freezing on hold would let anyone stop a
theater repricing by parking a seat in a basket.

---

## What the client cannot do

Attempted against the running API, reading the persisted rows rather than the response:

| Attack                                                                             | Result                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `unitPriceMinor: 500`, `subtotalMinor: 500`, `totalMinor: 500` in the booking body | ignored — persisted line 30000, payment raised for 31620     |
| Buy a PREMIUM seat against the STANDARD ticket type                                | 400 `A selected seat does not match its price category.`     |
| Use another show's ₹1 ticket type on this show                                     | 400 `One or more ticket types are invalid for this session.` |

Zod strips unknown keys, so injected fields never reach the service; the service then reads
`TicketType` from the database regardless. Two independent reasons, which is the right number
for money.

---

## Concurrency

24 concurrent guest bookings against one show while the organizer repriced ₹300 → ₹450:

- every persisted snapshot was **either 30000 or 45000** — never a blend, never zero
- every booking satisfied `lineTotal = unit × quantity`, `subtotal = Σ lines`,
  `total = subtotal − discount + customer fee`
- the ticket type settled on exactly one final price

No database lock is held across a payment provider call: the reprice is its own short
transaction and the booking transaction ends before any provider work begins.

---

## Money invariants

Integer minor units throughout; no floating point anywhere in the path.

```
lineTotalMinor  = unitPriceMinor × quantity
subtotalMinor   = Σ lineTotalMinor
customerFee + organizerFee = bookingFee + paymentFee     (a split, not an addition)
totalMinor      = subtotalMinor − discountMinor + customerFeeMinor
Payment.amountMinor = Booking.totalMinor
```

`bookingFeeMinor` and `paymentFeeMinor` are the **gross** fees; `customerFeeMinor` and
`organizerFeeMinor` are how that total is divided by `feeMode`. Adding all four counts the
same money twice.

> **Tax is absent, and deliberately so.** `Booking` has columns `subtotalMinor`,
> `bookingFeeMinor`, `paymentFeeMinor`, `discountMinor`, `customerFeeMinor`,
> `organizerFeeMinor`, `totalMinor` — and **no tax column**. No GST percentage exists anywhere
> in this repository. Representing ticket tax and fee tax needs a finance decision about what
> must be displayed and remitted; it was not invented here.

---

## What changed in this pass

### 1. A new organization could not schedule its first show — P0, observed live

Cinema created, screen created, layout published, film published, and then:

```
POST /movies/:id/shows → 409 "No venue is available for this organization."
```

`Venue` is an internal join between the movie domain and the events domain. There is **no
endpoint anywhere in this API to create one**, no readiness check mentions it, and the
onboarding checklist went green over a cinema that could not sell a ticket.

Where a venue did exist, the code borrowed **any** venue in the organization — the quieter
version of the same bug, filing a Bengaluru cinema's shows under a Mumbai venue record and
repeating it in the public listing.

Now: `CinemasService.create` gives a cinema its own venue made from its own details, and
`ensureMovieEvent` does the same for cinemas that predate the change. Two copies of the
borrow-or-refuse logic were collapsed into one.

### 2. Copying a day silently dropped its prices — P1, observed live

A day trading at ₹350 copied to tomorrow at the layout base of ₹200. A 43% price cut, applied
silently, by an operation whose whole purpose is "do tomorrow what we did today".

Now: `copySchedule` carries the source day's real prices, keyed by **wall-clock slot and
category name** — so a cheap matinee and a full-price evening copy as two prices rather than
one of them winning, and a copy to a different screen matches by the name an operator set
rather than an id that means nothing across layouts. An explicit `pricing` argument still
wins, because asking for a price is a stronger statement than inheriting one.

### 3. Readiness was checking the wrong row — P1

`PRICING` read `SeatCategory.basePriceMinor` — the template — so a cinema whose layout said
₹200 reported **READY** while tomorrow's show sold for ₹0.

Now a show priced at zero **BLOCKS**, with a fix path into the schedule; an unpriced layout
**warns**, because it only misprices shows that do not exist yet.

### 4. There was no way for an operator to change a price after scheduling

The API could do it (`PATCH /events/ticket-types/:id`); no organizer screen reached it for
movie shows, whose `Event` is created implicitly and is not navigable from the cinema
workspace.

Now: **Pricing** on every future show in the schedule day view, backed by
`GET`/`PATCH /shows/:sessionId/pricing`. Whole show in one transaction — repricing a house is
one commercial decision, and three requests is how a screen ends up half at the old price.

---

## Rules the pricing endpoint enforces

| Rule                                       | Why                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| A category that has **sold** is fixed      | A price somebody has paid is history, not a setting                          |
| A **held** seat locks nothing              | The buyer's line is already snapshotted; the two cannot disagree             |
| A **started** show cannot be repriced      | It cannot sell another ticket; a change there rewrites the past              |
| A **cancelled** show cannot be repriced    | Same                                                                         |
| Ticket types from another show are refused | Cross-show ids are a tenancy question, answered without confirming existence |
| All categories in one transaction          | A partial write leaves a screen half repriced                                |
| Minor units, integers only, server-side    | The client formats; it never decides                                         |

The organizer UI mirrors these so an operator is told before they type — and the server
enforces them regardless, because a stale page must never be able to do something by virtue
of having rendered a button.

---

## Where pricing is set

| Moment              | Source                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| Scheduling one show | `pricing[]` on the request, else the layout's `basePriceMinor`         |
| Bulk scheduling     | same                                                                   |
| Copying a day       | explicit `pricing[]`, else **the source day's real prices**, else base |
| After scheduling    | `PATCH /shows/:id/pricing` from the schedule day view                  |

No rule engine, no dynamic pricing, no price bands. For a pilot those would be capability
nobody asked for, and each is a place for a price to come from that an operator cannot see.

---

## Still not represented

- **Tax** (above) — a schema gap needing a finance decision.
- **Fee configuration** has no organizer UI; `FeeRule` is platform-level.
- **Cross-screen copy with mismatched categories.** Matching is by category name; a target
  category the source never priced falls back to that layout's own base rather than being
  refused. Worth revisiting if multi-screen copying becomes common — it is currently
  unobserved in practice, and refusing on a name mismatch would break the ordinary
  same-screen case for a theory.
