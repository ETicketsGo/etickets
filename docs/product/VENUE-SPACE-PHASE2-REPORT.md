# Venue + seating reset, phase 2 - what was built and what was not

Date: 2026-10-07
Branch: `feat/venue-space-model-phase2` - PR #240, open, not merged
Phase 1: [VENUE-SPACE-MODEL.md](./VENUE-SPACE-MODEL.md) (PR #239, merged - UI only)
Design: [VENUE-SPACE-DEPENDENCY-MAP.md](./VENUE-SPACE-DEPENDENCY-MAP.md)

Verdicts use five words and nothing softer: **PASS** (built and proven), **PARTIAL** (built,
with a named limit), **NOT IMPLEMENTED**, **NOT VERIFIED** (built, no evidence), **BLOCKED**.

---

## 1. Scorecard

| Area                 | Verdict                                           |
| -------------------- | ------------------------------------------------- |
| Domain model         | **PASS at the API layer**                         |
| Location unification | **PARTIAL**                                       |
| GA + VIP             | **PARTIAL**                                       |
| India auditorium     | **PARTIAL**                                       |
| Theater              | **PARTIAL**                                       |
| Cinema regression    | **PASS** (tests), **NOT VERIFIED** (browser)      |
| Seat locking         | **PARTIAL** - GA proven, per-seat not re-verified |
| Scale                | 500 / 2,500 / 10,000 **PASS**; 25,000 **PARTIAL** |
| US arena             | **NOT IMPLEMENTED**                               |
| Same-arena concert   | **NOT IMPLEMENTED**                               |
| Buyer selection      | **NOT IMPLEMENTED**                               |
| Multi-country        | **NOT IMPLEMENTED**                               |
| Mobile               | **NOT IMPLEMENTED**                               |

**PARTNER-DEMO VERDICT: NO.**

Blockers, in the order they block:

1. GA zones are not wired into checkout. No ticket type derives from a zone and the booking
   path does not know they exist.
2. No organizer UI for creating a space or a zone. Both are API-only.
3. No buyer UI for zone selection or for an arena seat map.
4. No end-to-end walkthrough for anything but cinema.

---

## 2. What was built

### PASS - the domain model

`Screen.cinemaId` was `NOT NULL`. That single constraint is why an arena, an auditorium, a
concert hall and a conference room all had to be created as a _cinema_ before they could sell
a numbered seat. A space now has its own `venueId`; `cinemaId` is optional.

Proven, not asserted: `venue-space-no-cinema.integration-postgres.spec.ts` walks
VENUE -> SPACE -> LAYOUT -> SESSION -> per-seat inventory against a real database with **no
cinema row anywhere in it**, and checks what was written - `cinemaId` null, the organization
holding zero cinemas, 18 sellable seats from a layout with a gangway, and 18 `ShowSeat` rows.

**Still open:** `Screen` is not renamed `Space` (a mechanical rename of 137 references, which
should not ride along with a semantic migration), and `Cinema`'s location columns are not
dropped.

### PARTIAL - location unification

30 call sites across 6 files now resolve owner, timezone and place through one module
(`spaces/space-owner.ts`). The work was found by applying the change and letting the compiler
enumerate it, not by reading.

- Authorization asks the **venue**. `requireSpaceOrganizationId` **throws** rather than
  returning a fallback: there is no safe default for "which tenant is this".
- `spaceTimezone` returns `null` rather than inventing a zone.
- `spaceVenueName` - `listSeatingRooms` used to return `venueName: s.cinema.name`, so the
  event wizard labelled a space's venue with its cinema's name.

**The limit:** `Cinema` still carries duplicate location columns and they are still read as a
fallback. Dropping them is the next migration.

### PASS - GA inventory, with the oversell falsified

`SeatZone` (a standing area in a layout, beside `SeatSection`) and `ShowZone` (per-session
capacity / sold / held / version - the GA counterpart of `ShowSeat`). A layout may hold both,
which is what makes an arena concert expressible.

A floor is not 4,000 fake seats. That would put 4,000 meaningless rows in every session, hand
buyers a seat number that means nothing at the door, and make "how many are left" a COUNT
instead of a number.

The capacity check and the write are one statement:

```sql
UPDATE "ShowZone" SET held = held + n
 WHERE id = $1 AND capacity - sold - held >= n
```

**Falsified.** Replacing it with the obvious read-then-write and running two buyers
concurrently for the last 2 of 3 places returns `[true, true]` - both win, the floor
oversells. The atomic version refuses one. The holds are issued concurrently on purpose:
sequential calls cannot oversell, so a sequential test would have passed against the broken
implementation.

Also proven: a sale cannot be confirmed from a hold that is not there; releasing twice cannot
drive `held` negative (a negative hold invents capacity); zones are independent; materialising
a session twice does not double its capacity.

### PARTIAL - scale, measured

See section 6 of the dependency map for the table. The short version: **the sectioned read is
what makes 25,000 seats possible, and it works** - 3 ms / 4 KB for the overview, ~90 ms / 87 KB
for one block, flat whatever the venue holds. **The whole-map read is the cliff** - 3.67 MB at
25,000 seats.

That failure mode is now closed: a `GRID` layout above 2,000 seats is refused at publish, with
a message saying what to do instead. `SECTIONED` is never limited.

**Not measured:** buyer rendering, because no arena buyer UI exists. These are database-level
timings of representative queries, not calls to the deployed endpoint, and carry no network
time.

---

## 3. Defects found and fixed along the way

| Defect                                                       | Why it mattered                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `listSeatingRooms` returned the cinema's name as `venueName` | the wizard mislabelled every space's venue                                |
| it scoped by `cinema: { organizationId }` alone              | after this migration that hides every non-cinema space                    |
| `addScreen` did not set `venueId`                            | the invariant would hold for migrated rows and fail silently for new ones |
| the seed did not set `venueId` on nested screens             | same, for every seeded environment                                        |
| `capacity` was capped at **2,000**                           | a cinema's ceiling; it refused every arena outright                       |
| Prisma dated the zones migration **before** the venue one    | on a fresh database they would run out of order                           |

---

## 4. Mistakes worth recording

**A whole-database invariant was written as a test.** It passed alone and failed in the full
suite, reporting 17 offending rows - all created moments earlier by ten other integration
fixtures calling `prisma.screen.create` directly. A global data invariant cannot be checked
from inside the suite that writes the data. It moved to the audit script.

**A test leaked rows on failure.** Cleanup after the assertion meant a red run left a
venue-less space behind and poisoned every later run with an unrelated failure. Cleanup is now
in a `finally`.

**I put a Sydney cinema in India.** Making `spaceTimezone` prefer the venue - as ownership and
naming correctly do - is wrong, because `Venue.timezone` is `NOT NULL` with a default of
`Asia/Kolkata`. A venue nobody has ever asked for a zone still RETURNS one, and nothing tells
that guess apart from a venue genuinely in India. So the venue shadowed the cinema's real
answer and a Sydney 00:30 show was stored and reported as **06:00** - the IST offset applied
to a city 5.5 hours away.

4,970 green API tests missed it, because every one of them asserts behaviour for a space whose
venue and cinema AGREE. The defect needs them to disagree, and only the Sydney e2e fixture
does that. It was caught twelve minutes into CI.

`space-owner.spec.ts` now asserts the precedence directly and was falsified by restoring the
exact inversion, so it fails in milliseconds instead.

**A guard restated its fix instead of testing it.** The first version of the `addScreen` guard
wrote `prisma.screen.create({ venueId: cinema.venueId })` itself, so it passed against the
defective service. It now calls the real service, and was falsified by restoring the defect.

---

## 5. Before this ships

**Run `apps/api/scripts/audit-space-location.mjs` against QA and production.** It is read-only
and exits non-zero when an environment needs decisions. The local seed is not evidence about
real data.

Locally it finds one conflict: a space whose address is more precise than its venue's
("Phoenix Marketcity, Whitefield" vs "Whitefield"). Both are true. That is the general shape
of this conflict and it argues for keeping a space-level **address refinement** while city,
country, region and timezone become venue-only. A space may say where IN the venue it is; it
may not claim a different city.

**The defaults that lie, and why location unification cannot finish without fixing them.**
`Venue.timezone` defaults to `Asia/Kolkata` and `Venue.country` defaults to `India`. Neither
column can be authoritative while "set" is indistinguishable from "defaulted" - that is what
produced the Sydney defect above, and it is why `spaceTimezone` still reads the CINEMA first.

Making both nullable and backfilling them from the cinema is therefore a **prerequisite** for
dropping `Cinema`'s location columns. It should be the first task of the next phase, before
any UI work, because every later step assumes the venue can be trusted.

**An owner decision: `VenueArea`.** It has zero code references, but the seed writes rows into
it - "General" (4000) and "VIP" (1000). It is a vestigial GA model: the right idea with none of
the accounting. `SeatZone` now does the job properly, so `VenueArea` should be dropped and the
seed updated. Not done here, because dropping a table the seed populates is a decision rather
than a cleanup.

---

## 6. Recommended order from here

1. **Wire GA into checkout.** The honest version is not "a ticket type per zone with its own
   quantity" - that would put GA capacity in two places and re-create the duplication this
   whole reset removed. A ticket type should REFERENCE its zone and the quantity should remain
   `ShowZone`'s. That is money-path work and deserves its own pass.
2. Organizer UI: create a space under a venue, draw zones, see VENUE -> SPACE -> LAYOUT.
3. Buyer UI: zone selection, then the arena seat map on the sectioned read.
4. Only then the walkthroughs, the fixtures and the mobile pass.
5. Separately, and not mixed with any of the above: drop `Cinema`'s location columns, make
   `Screen.venueId` required, and rename `Screen` to `Space`.
