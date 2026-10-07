# Venue / Space / Layout - dependency map and migration design

Date: 2026-10-07
Status: design. No schema change has been made yet.
Precedes: the location-unification migration.
Follows: [VENUE-SPACE-MODEL.md](./VENUE-SPACE-MODEL.md) (PR #239, UI only).

This document exists because the migration must not be a blind rename. It maps who reads what
before anything is moved.

---

## 1. The model as it is

```
Venue                     location, but not enforced anywhere
 +- VenueArea             name + capacity. Written by the seed, read by NOTHING.
 +- Cinema                THE SPACE. Duplicates Venue location. venueId is OPTIONAL.
     +- Screen            the actually bookable room. cinemaId is REQUIRED.
         +- SeatMap       THE LAYOUT. versioned, lineage, effectiveFrom, GRID|SECTIONED,
             |            focal point + focal shape.
             +- SeatCategory / SeatSection / SeatRow / Seat

EventSession   screenId? and seatMapId?  - BOTH OPTIONAL
 +- ShowSeat   per-session seat inventory: status, hold + expiry, operator override, version
```

### 1.1 Two facts that change the plan

**`EventSession.screenId` and `seatMapId` are already nullable.** General admission already
exists as "a session with no screen". The platform does not conceptually require a seat map
for a session.

**But `Screen.cinemaId` is REQUIRED.** That single `NOT NULL` is the actual architectural
defect. It is why a concert hall, an arena, an auditorium and a conference room must all be
created as a "Cinema" before they can have reserved seating. The problem is not that `Cinema`
exists; it is that `Cinema` sits on the only path to a bookable room.

### 1.2 `ShowSeat` is already the event-configuration layer

Section 9 of the brief asks for a layer between reusable layout and event sales, so that one
event blocking inventory does not destructively edit a shared layout. **For seats, this
exists.** `ShowSeat` is per-`EventSession` and carries `status`, `holdBookingId` +
`holdExpiresAt`, a full operator override (`overrideKind`, reason, actor, expiry) and a
`version` for optimistic concurrency. `SeatMap` is never mutated to block a seat.

What does not exist is the same thing for **GA**.

### 1.3 `VenueArea` is a vestigial GA model, not merely dead

The earlier audit said `VenueArea` has zero code references. That is true, and incomplete:
**the seed writes rows into it.** On the local database it holds exactly:

| name    | capacity |
| ------- | -------- |
| General | 4000     |
| VIP     | 1000     |

That is GA + VIP - the very fixture section 8 of the brief asks for. `VenueArea` is the right
idea (a named, capacity-bearing zone that is not a grid of numbered seats) with none of the
accounting (no held, no sold, no remaining, no per-session scope).

So it should not simply be deleted as dead weight. Either the GA work adopts it deliberately,
or it is replaced deliberately and the seed stops writing it. Both are decisions; silently
dropping a table the seed populates is not.

---

## 2. Who reads the duplicated location

This is the migration surface. Grouped by what they actually need.

### 2.1 The dominant pattern: timezone, with venue as fallback

Ten read paths already resolve a zone as `screen.cinema.timezone ?? event.venue.timezone`:

| Module        | File                                                              |
| ------------- | ----------------------------------------------------------------- |
| bookings      | `bookings.service.ts`, `guest-booking.service.ts`                 |
| check-in      | `checkins.service.ts`                                             |
| payments      | `payments.service.ts` (x2)                                        |
| notifications | `show-cancellation-fanout.service.ts`, `show-reminder.service.ts` |
| shows         | `shows.service.ts` (x3), `live-operations.service.ts` (x2)        |
| tickets       | `tickets.service.ts`                                              |
| sharing       | `ticket-shareable.resource.ts`                                    |
| movies        | `movies.service.ts`                                               |
| web-kit       | `showtimes.ts`                                                    |

**The codebase has already decided the venue is the fallback, not the source.** Unifying
location inverts that: these become a single read from the venue. Every one of them renders a
time a customer sees - a ticket face, a reminder, a receipt - so this is the highest-risk
group and the one that needs tests before and after.

### 2.2 India regulatory pricing - read in the OPPOSITE direction

`pricing/cinema-policy/cinema-pricing-policy.service.ts` and
`cinemas/cinema-compliance.service.ts` both resolve:

```
country : cinema.country ?? cinema.venue?.country
region  : cinema.region  ?? cinema.venue?.region
city    : cinema.city    ?? cinema.venue?.city
district: cinema.district                          <- space-level only
localBodyType: cinema.localBodyType                 <- space-level only
```

`district` and `localBodyType` have **no venue equivalent and must not get one**. Two cinemas
in one district can fall under different local bodies, and Andhra Pradesh prices by exactly
that. So the migration moves `country` / `region` / `city` to the venue and **leaves
`district`, `localBodyType`, `cinemaFormat` and `climateType` on the space**, where they
belong. An unclassified cinema already fails closed; that behaviour must be unchanged.

### 2.3 Operational reads

`cinemas/pilot-readiness.ts` asserts `cinema.timezone` and `cinema.address` are set, and
`shows.service.ts:1156` copies `screen.cinema.city` / `.address` when duplicating a show.
These follow the venue after the migration.

### 2.4 Volume

Non-spec references in `apps/api/src`: `screenId` 137, `cinemaId` 64, `seatMapId` 47,
`venueId` 47. Sixteen API modules touch at least one. Most are identity joins and are
unaffected by moving location; the 38 location reads above are the ones that change meaning.

---

## 3. Proposed target model

```
Venue                     AUTHORITATIVE for city, address, country, region, timezone
 +- Space (Screen)        the bookable room. venueId REQUIRED.
     |                    cinemaId OPTIONAL - set only when it is a cinema screen.
     +- SeatMap           unchanged. Already the layout foundation.
 +- Cinema                cinema-only specialisation: brand, format, climate, district,
                          localBodyType. NO location columns.
```

The move is: **give `Screen` a required `venueId`, and make `cinemaId` optional.**

Why this and not a `Cinema` -> `Venue` field copy: copying the columns leaves `Cinema` on the
critical path, so a concert hall still has to be created as a cinema. This removes the forced
`Venue -> Cinema -> Screen` chain for non-cinema events, which is the stated objective, and it
preserves every cinema behaviour because a cinema screen simply keeps its `cinemaId`.

### 3.1 Migration steps

1. Add `Screen.venueId` nullable; add `Cinema.venueId` required later, not now.
2. Backfill `Screen.venueId` from `screen.cinema.venueId`.
3. For every `Cinema` with no venue, create one from the location it already carries
   (the audit script reports these; locally there are none).
4. Resolve the conflicting rows (section 4) by an explicit, recorded rule.
5. Make `Screen.venueId` required.
6. Change the 38 location reads to the venue.
7. Only then drop `Cinema.city`, `address`, `country`, `region`, `timezone`, `latitude`,
   `longitude`.

Steps 1-2 are additive and reversible. Nothing is dropped until the reads have moved and
shipped.

### 3.2 The blast radius, measured rather than estimated

The change was applied to the schema as an experiment, the client regenerated, and the API
type-checked, so the compiler enumerated the work instead of a guess doing it.

**30 errors in exactly 6 files:**

| File                               | What breaks                                       |
| ---------------------------------- | ------------------------------------------------- |
| `bookings/bookings.service.ts`     | `screen.cinema.timezone` on a now-optional cinema |
| `cinemas/cinemas.service.ts`       | screen reads that assume a cinema                 |
| `events/events.service.ts`         | `listSeatingRooms` org scoping + `venueName`      |
| `shows/shows.service.ts`           | timezone + show duplication reads                 |
| `shows/live-operations.service.ts` | timezone reads                                    |
| `shows/seat-layouts.service.ts`    | layout ownership checks                           |

That is the whole surface. It is tractable, and it is the reason this design was chosen over
copying columns: the compiler can find every caller, because the change is a TYPE change.

The experiment was reverted; `apps/api/prisma/schema.prisma` is untouched by it. The captured
output is kept beside this document as `blast-radius.log`.

### 3.3 A defect this uncovered

`EventsService.listSeatingRooms` returns `venueName: s.cinema.name`. The event wizard labels a
space's VENUE with the CINEMA's name - so picking a space in "Phoenix Arena" reports its venue
as "PVR Phoenix Whitefield". Org scoping in the same query runs through
`cinema.organizationId`, which is also why a screen cannot currently exist without a cinema:
authorization depends on it. Both must be re-pointed at the venue by this migration.

---

## 4. Conflicting data, found rather than assumed

`apps/api/scripts/audit-space-location.mjs` is read-only and reports, per environment:
spaces that disagree with their venue, spaces with no venue, and `venueArea` row counts.

Local database today:

```
spaces=18  venues=20  venueAreas=2
  agree with their venue : 17
  DISAGREE               :  1
  no venue at all        :  0
```

The one disagreement:

| Space                  | Field   | Space says                                    | Venue says                |
| ---------------------- | ------- | --------------------------------------------- | ------------------------- |
| PVR Phoenix Whitefield | address | Phoenix Marketcity, Whitefield, Bengaluru, KA | Whitefield, Bengaluru, KA |

Both are true; the space's is more precise. That is the general shape of this conflict - a
space knows its own door - and it argues for keeping a **space-level `address` refinement**
while city / country / region / timezone become venue-only. A space may say WHERE IN the
venue it is. It may not claim a different city.

**This must be re-run against QA and production before the migration.** The local seed is not
evidence about real data, and the counts above are only a demonstration that the tool works.

---

## 5. What this design does NOT yet answer

- **GA inventory.** No zone model with held / sold / remaining exists. `VenueArea` is the
  vestige, `TicketType` quantities are the current mechanism, and mixed reserved + GA in one
  session has no representation. Designed separately before any code.
- **Whether `Screen` should be renamed `Space`.** Renaming a table with 137 references is a
  separate, mechanical change and should not ride along with a semantic migration.
- **Scale.** Measured - see below.

---

## 6. Scale, measured

`apps/api/scripts/measure-seating-scale.mjs` builds a real arena bowl at each size in a real
database (blocks of 500, 20 rows of 25) and times what a person waits for. Everything it
creates it deletes again.

|  seats | blocks | build layout | per-session seats | overview read |     ONE block |             WHOLE map |
| -----: | -----: | -----------: | ----------------: | ------------: | ------------: | --------------------: |
|    500 |      1 |        91 ms |            115 ms |   4 ms / 0 KB | 23 ms / 87 KB |         17 ms / 73 KB |
|  2,500 |      5 |       623 ms |            176 ms |   2 ms / 0 KB | 45 ms / 87 KB |       125 ms / 367 KB |
| 10,000 |     20 |       2.56 s |            645 ms |   2 ms / 1 KB | 38 ms / 87 KB |     382 ms / 1,467 KB |
| 25,000 |     50 |       5.06 s |            1.50 s |   3 ms / 4 KB | 94 ms / 87 KB | 854 ms / **3,667 KB** |

**The sectioned read is what makes 25,000 seats possible, and it works.** The overview stays
at 3 ms and 4 KB, and opening one block stays at roughly 90 ms and 87 KB _whatever the size of
the venue_ - because a block is 500 seats in a 500-seat hall and in a 25,000-seat arena alike.
That is flat, and flat is the whole answer.

**The whole-map read is the cliff.** 3.67 MB and 854 ms at 25,000 seats. Any path that fetches
every seat at once is unusable on a phone. `layoutKind` already discriminates this -
`SECTIONED` venues return the overview, `GRID` returns everything - and `GRID` is the CINEMA
default, which is safe only because a cinema is 400 seats. **Nothing currently stops a 25,000
seat room being created as `GRID`**, and that is the failure mode to guard before an arena is
onboarded.

**Two costs an operator will notice**, neither fatal, both worth saying out loud: building a
25,000-seat layout takes 5 seconds, and giving each SHOW its seat inventory takes 1.5 seconds

- so an arena with fifty shows spends about 75 seconds materialising them.

**What this does NOT measure:** these are database-level timings of queries shaped like the
real ones, not calls to the deployed `getPublicSeatLayout` endpoint, and they contain no
network time. Buyer RENDERING at 25,000 seats is **not measured at all**, because no arena
buyer UI exists yet.
