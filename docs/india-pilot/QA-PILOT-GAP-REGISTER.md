# QA pilot gap register

Observed gaps from walking the Launch Readiness page as an operator would.

> ## Second pass — the live walk COMPLETED
>
> The first pass was static only: fix paths were followed to see whether the destination
> existed. The live walk was blocked by a Docker failure and its rows were marked
> **NOT YET OBSERVED**.
>
> This pass ran on real PostgreSQL 16 and Redis, with the API and all three web apps up. A
> brand-new organization was taken from nothing to **selling and being paid**, following only
> what readiness said. Every row below is now **OBSERVED**, and four defects were found that
> the static pass could not have seen — including one that made READY unreachable for every
> cinema on the platform.

## The walk, in numbers

| Stage                      | Overall | Blockers | Warnings | What cleared                           |
| -------------------------- | ------- | -------- | -------- | -------------------------------------- |
| Cinema record only         | BLOCKED | **5**    | 4        | —                                      |
| Screen + published layout  | BLOCKED | 3        | 4        | NO_ACTIVE_SCREEN, NO_PRICING           |
| Film published, show at ₹0 | BLOCKED | 2        | 3        | NO_FUTURE_SHOWS, CATALOGUE_UNREACHABLE |
| Show priced through the UI | BLOCKED | **1**    | 3        | SHOWS_PRICED_AT_ZERO                   |
| After a real customer paid | BLOCKED | **1**    | 3        | —                                      |

**Every self-service blocker cleared.** The one that remains is `PROVIDER_NOT_CONFIGURED`,
which names ETicketsGo as its owner and offers no route — correctly, because the theater
cannot fix it.

The customer side worked end to end: discovery → showtime at ₹200 → seat map → hold →
payment. Booking totalled ₹214.20 (₹200 + ₹14.20 fees) and was CONFIRMED.

---

## GAP-06 — RESOLVED: **FALSIFIED as architecture, closed as a self-service gap**

The suspicion was that changing a ticket price required cloning and republishing a seat
layout version, coupling physical inventory to commercial pricing.

**It does not.** Run live:

| Experiment                              | Result                              |
| --------------------------------------- | ----------------------------------- |
| PREMIUM ₹300 → ₹350 on a future show    | 200; customer seat map shows ₹350   |
| Layout versions before → after          | `[v1:PUBLISHED]` → `[v1:PUBLISHED]` |
| `SeatCategory.basePriceMinor` after     | unchanged at 30000                  |
| Two shows, one layout, different prices | both honoured; still one layout     |

Price lives on `TicketType`, keyed by `(eventSessionId, seatCategoryId)` — which is exactly
the "session, seat category, price" boundary that was wanted. `SeatCategory.basePriceMinor` is
a template read only when a show is created. **No new model was introduced.**

What was genuinely missing was a **way for an operator to change it after scheduling**. Now
there is: **Pricing** on every future show in the schedule day view. See
[PRICING-AUDIT.md](./PRICING-AUDIT.md).

---

## Found and fixed in this pass

### GAP-10 — Readiness could never say READY · **PRODUCT_DEFECT** · P0 · OBSERVED

The BUSINESS rule was `if (organization.status !== 'ACTIVE')`. `OrganizationStatus` is
`PENDING | APPROVED | REJECTED | SUSPENDED` — **there is no ACTIVE**. Every organization on
the platform was permanently blocked, so **no cinema could ever reach READY**.

It survived every test because the unit fixture also said `'ACTIVE'` — a value the column
cannot hold. The tests agreed with the code, and both disagreed with the database.

> This is the same shape as the timezone lesson: a fixture that mirrors the implementation
> proves only that the two match. It took walking a real organization through onboarding to
> see it.

Fixed: `APPROVED` is the state that means yes; `PENDING`, `REJECTED` and `SUSPENDED` block
with distinct messages. `ReadinessFacts.organization.status` is now the four-value union
rather than `string`, so the same mistake is a compile error — and it immediately failed the
old fixture, which is how it should have been caught the first time.

### GAP-11 — A new organization could not schedule its first show · **PRODUCT_DEFECT** · P0 · OBSERVED

Cinema created, screen created, layout published, film published, and then:

```
POST /movies/:id/shows → 409 "No venue is available for this organization."
```

`Venue` is an internal join between the movie and events domains. **There is no endpoint
anywhere in this API to create one**, no readiness check mentions it, and the onboarding
checklist went green over a cinema that could not sell a ticket.

Where a venue did exist, the code borrowed **any** venue in the organization — the quieter
version of the same bug, filing a Bengaluru cinema's shows under a Mumbai venue and repeating
it in the public listing.

Fixed: a cinema gets a venue made from its own details at creation, and scheduling repairs
cinemas that predate the change. The two copies of the borrow-or-refuse logic were collapsed
into one.

### GAP-12 — Copying a day silently dropped its prices · **PRODUCT_DEFECT** · P1 · OBSERVED

A day trading at ₹350 copied to tomorrow at the layout base of ₹200 — a **43% price cut,
applied silently**, by an operation whose entire purpose is "do tomorrow what we did today".

Fixed: the source day's real prices travel with the copy, keyed by wall-clock slot and
category name, so a cheap matinee and a full-price evening copy as two prices rather than one
of them winning. An explicit `pricing` argument still wins.

### GAP-13 — Readiness judged the wrong row for pricing · **PRODUCT_DEFECT** · P1 · OBSERVED

`PRICING` read `SeatCategory.basePriceMinor`. A cinema whose layout said ₹200 reported the
pricing section satisfied while **tomorrow's show sold for ₹0** — observed directly during
the walk.

Fixed: a future show priced at zero **BLOCKS**, with a fix path into the schedule. An
unpriced layout **warns**, because it only misprices shows that do not exist yet.

### GAP-14 — The organization blocker pointed at a page that cannot fix it · **PRODUCT_DEFECT** · P2 · OBSERVED

`ORG_NOT_ACTIVE` offered `/organizer/settings`. That page edits the **public profile**;
approval is an admin review and no organizer endpoint can change status. The same class as
GAP-01/GAP-02, and it slipped past the guard test, which only forbade paths starting
`/admin`.

Fixed: it names ETicketsGo and offers no route. **The guard is still not complete** — a path
inside `/organizer/` that leads to a screen lacking the capability cannot be detected
structurally. Recorded rather than papered over.

---

## Fixed in the first pass

| ID     | Gap                                                      | Sev | Status                  |
| ------ | -------------------------------------------------------- | --- | ----------------------- |
| GAP-01 | FEES fix path `/admin/fees` was a 404                    | P1  | Fixed — names its owner |
| GAP-02 | PAYMENTS fix paths led into an app operators cannot open | P1  | Fixed — names its owner |

A test prevents the class: no `fixPath` may leave `/organizer/`, and any non-READY check
without a path must name its owner.

---

## Open, and owned elsewhere

### GAP-05 — No INR payment route or resolvable credentials · EXTERNAL_OWNER_ACTION · **P0** · OBSERVED

The only blocker still standing at the end of the walk, and the correct one to be standing:
it names ETicketsGo and offers no route.

Worth noting for staging: the check is **stricter than the runtime**. It requires
`RAZORPAY_KEY_ID` or `PAYMENTS_MOCK_MODE=true`, while `PAYMENT_PROVIDER=mock` alone will
happily take a mock payment — as it did in this walk. Conservative in the safe direction, but
the two should be reconciled before staging, or a pilot environment will report a blocker it
does not have.

### GAP-07 — No GSTIN, registered address or finance contact · BUSINESS_DECISION · P1 · OBSERVED

`Organization` carries name, slug, status, contact email/phone and public profile fields.
Whether an Indian theater pilot can operate without these recorded is a finance question.

### GAP-08 — `Booking` has no tax representation · LEGAL_FINANCE_DECISION + SCHEMA_GAP · P1 · OBSERVED

Confirmed against the live schema: `subtotalMinor`, `bookingFeeMinor`, `paymentFeeMinor`,
`discountMinor`, `customerFeeMinor`, `organizerFeeMinor`, `totalMinor` — **and no tax
column**. No GST percentage exists anywhere in the repository. Needs a finance/legal decision
on what must be displayed and remitted.

### GAP-03 / GAP-04 — No fees or cancellation-policy UI · SELF_SERVICE_GAP · P2 · OBSERVED

Both remain warnings an operator can launch past.

### GAP-09 — Activation is redundant · BUSINESS_DECISION · P3 · OBSERVED

Unchanged, and the live walk supports it: `Cinema.status = ACTIVE` plus a published layout
plus a future show on a published film is exactly what made the cinema sellable. A second
lifecycle would only be able to disagree with that.

### GAP-15 — Readiness is advisory, not enforcing · BUSINESS_DECISION · P2 · OBSERVED

A customer bought and paid for a ticket while readiness reported **BLOCKED**. Nothing in the
booking path consults organization status or the readiness verdict.

Arguably correct — readiness is a checklist for an operator, not a gate — but it was stated
as a gate: the old message read _"nothing it owns can sell tickets"_, which the walk
disproved by selling one. The message is now accurate. **Whether readiness should also
enforce is an owner's decision, not engineering's**, and nothing here was changed to assume
an answer.

---

## Priority summary

| Priority | Count | Items                                                                       |
| -------- | ----- | --------------------------------------------------------------------------- |
| **P0**   | 3     | GAP-05 payment routing (open, external) · GAP-10 ✅ fixed · GAP-11 ✅ fixed |
| **P1**   | 5     | GAP-01 ✅ · GAP-02 ✅ · GAP-12 ✅ · GAP-13 ✅ · GAP-07 open · GAP-08 open   |
| **P2**   | 4     | GAP-03 · GAP-04 · GAP-14 ✅ fixed · GAP-15 open (decision)                  |
| **P3**   | 1     | GAP-09 activation                                                           |

**GAP-06 is resolved and removed from the open list.**

### What this pass changes about the plan

The first pass concluded that pricing might be the thing that stopped a pilot. It was not —
the architecture was already right, and the gap was a missing screen, now built.

What actually stopped a pilot was **two P0 defects that only a live walk could surface**: a
readiness engine that could never say READY, and a new theater that could not schedule its
first show. Both were invisible to a static read and to a green test suite, because the tests
and the code shared the same wrong assumption.

The remaining blocker is payment credentials in a real environment, which is
**infrastructure, not engineering**.
