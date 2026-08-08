# Seat layout versioning

How a theater changes the seats in a room without rewriting what people already bought.

---

## The problem

A screen had exactly one seat map. `SeatMap.screenId` was `@unique` and `generateSeatMap`
refused outright once one existed. Safe, and useless: theaters re-seat rooms, convert a row
to recliners, add a wheelchair bay.

The obvious fix — let operators edit the map — is the dangerous one. `Seat` rows are
referenced by `ShowSeat` (per-show inventory) and by `Ticket` (what a customer holds).
Editing row A in place silently rewrites last week's sale.

## The rule

**Published layouts are immutable.** A change means `clone → edit the draft → publish`.

```
Screen
  └── SeatMap (version 1, PUBLISHED)  ← last month's room
  └── SeatMap (version 2, PUBLISHED)  ← in effect now
  └── SeatMap (version 3, DRAFT)      ← being designed
         └── SeatCategory / SeatSection / SeatRow / Seat   (its OWN rows)

EventSession.seatMapId  →  the version this show is pinned to
ShowSeat.seatId         →  a Seat belonging to that version
```

Because a new version owns **new `Seat` rows**, nothing it later becomes can reach a
`ShowSeat` or `Ticket` belonging to an older one. Immutability is structural, not a rule
somebody has to remember to enforce.

### Lifecycle

| Status      | Editable | Assignable to new shows | Notes                          |
| ----------- | -------- | ----------------------- | ------------------------------ |
| `DRAFT`     | yes      | no                      | Invisible to scheduling        |
| `PUBLISHED` | **no**   | yes                     | One-way; there is no unpublish |
| `ARCHIVED`  | no       | no                      | Existing shows keep working    |

Archiving is a **planning decision, never a deletion**. A show pinned to an archived version
holds its own seats and continues to sell, refund and scan exactly as before.

## Which version does a show use?

`resolveEffectiveLayout(versions, startsAt)` — the latest **published** version whose
`effectiveFrom` is on or before the show's start time.

Ordering is on `effectiveFrom`, **not** on version number. That is what makes _activate a
future version_ work with no scheduled job and no flag to flip at midnight:

```
v2  effectiveFrom 2026-01-01   ← tonight's show resolves here
v3  effectiveFrom 2026-07-01   ← Monday's show resolves here
```

**It refuses rather than falling back.** If no version is in effect for that date, scheduling
fails with a readable message. Quietly reaching for a future layout would sell seats from a
room that does not exist yet.

Fallback chain for the effective instant: `effectiveFrom ?? publishedAt ?? createdAt`. The
last one is not decoration — `status` defaults to `PUBLISHED` while both date columns default
to null, so any seed or fixture writes a published-but-undated row. Without the fallback that
screen becomes unschedulable with an error nobody can act on, which is exactly how three
existing integration suites broke when versioning first landed.

## Where the version is read

| Caller                               | Reads                                      | Why                                             |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------- |
| `scheduleShow` / `bulkScheduleShows` | `resolveEffectiveLayout(screen, startsAt)` | Build the show against the room it will play in |
| `getPublicSeatLayout`                | **`session.seatMap`** (pinned)             | See below                                       |
| `liveSeatMap`                        | `ShowSeat → Seat` (pinned)                 | Same reason                                     |

> ### The one that matters most
>
> `getPublicSeatLayout` reads the version **pinned to the show**, not the screen's current
> one. Reading the screen — which is what it used to do — would render tomorrow's re-seated
> room to a customer looking at a show sold from the old layout: seats that no longer exist,
> prices from a tier the show never had, and a map that disagrees with the ticket in their
> hand. There is a regression test that puts a deliberately different layout on the screen.

## Bulk scheduling across a change

A date range can straddle the day a new version takes effect. The batch is **refused** with
the boundary named (`v2 → v3`) rather than guessed, and the operator schedules the two sides
separately — which is what they meant. Building half a batch against a room that is not there
on the night is the failure this avoids.

## Comparing versions

`compareLayouts` matches seats on **row + label** ("A12"), not on database id. A clone creates
entirely new `Seat` rows, so matching on id would report every seat as removed-and-added and
tell the operator nothing.

Reports added / removed / re-categorised seats and a `capacityDelta` that counts only sellable
seats — turning a seat into an aisle `GAP` loses capacity even though the element count is
unchanged.

## Seat kinds

`SEAT | GAP | WHEELCHAIR | COMPANION`, a property of the **layout**, not of a night's trading.
Putting accessibility on `ShowSeat` would let a wheelchair bay quietly differ between two
showings of the same film.

`GAP` is an aisle spacer and is never sellable. Wheelchair and companion spaces **are**
sellable — restricting who may book them is a booking rule, and hiding them from inventory
would mean a wheelchair user cannot book at all.

## Migration

`20260808120000_seat_layout_versioning_and_overrides`, validated on real PostgreSQL 16 twice:
fresh, and as an upgrade over a database already holding shows.

- Existing maps → `version 1`, `PUBLISHED`, dated from their own `createdAt`.
- Every existing show backfilled to the layout it was **already using**, derived from its own
  `ShowSeat → Seat → seatMapId` rather than guessed. General-admission sessions correctly stay
  `NULL`.
- The only structural change is **relaxing** the one-map-per-screen unique index, which cannot
  invalidate an existing row — an older API instance keeps behaving exactly as before.

Nothing is deleted or rewritten.

## API

| Route                                 | Does                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| `GET /screens/:screenId/seat-layouts` | Every version, with seat count, capacity, and committed shows |
| `POST /seat-layouts/:id/clone`        | Deep-copy into a new DRAFT                                    |
| `POST /seat-layouts/:id/draft`        | Replace a draft's sections/rows/seats                         |
| `POST /seat-layouts/:id/publish`      | Publish, optionally `effectiveFrom` a future date             |
| `POST /seat-layouts/:id/archive`      | Retire a superseded version                                   |
| `DELETE /seat-layouts/:id`            | Discard an unpublished draft                                  |
| `GET /seat-layouts/compare?from=&to=` | Diff two versions of one screen                               |

Refusals carry a policy code in `details.reason` (`LAYOUT_NOT_DRAFT`,
`LAYOUT_HAS_FUTURE_SHOWS`, `LAYOUT_LAST_PUBLISHED`, `LAYOUT_EMPTY`, …) so a client maps to a
sentence rather than matching on prose.

## Guards worth knowing

- **Archive is refused while future shows use the version.** They would not break, but the
  operator almost certainly meant to move them first.
- **Archive is refused for the last published version.** Otherwise the screen silently becomes
  unschedulable.
- **Publish is refused for an empty layout.** A show scheduled against it would sell nothing.
- **Historical shows never block anything.** They hold their own seats; past trading must not
  freeze a screen's layout list forever.
- **Clone takes a `FOR UPDATE` lock on the screen**, so two operators cloning at once cannot
  claim the same version number and hit a raw constraint error.

## Not built

- **No in-place edit of a published layout**, by design.
- **No per-seat geometry editor.** Drafts are expressed through the same compact
  section/rows/seatsPerRow spec as the generator, plus a `seatKinds` map for wheelchair bays
  and gaps.
- **No organizer UI yet** — see the assessment in `AUDIT.md`.
