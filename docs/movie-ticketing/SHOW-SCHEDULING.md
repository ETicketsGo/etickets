# Show scheduling

How shows get onto a screen, and what stops two films being sold into the same room.

Movies reuse `Event` and `EventSession` — one `Event` per film, one `EventSession` per
performance. There is deliberately no separate "Show" or "Performance" entity; adding one
would mean two models of the same thing and two places for inventory to drift.

## The gap this closed

`scheduleShow` validated the caller's tenant, that the cinema owned the screen, and that
the screen had a seat map. It then created the session **with no overlap check at all**.

Two shows could be scheduled on one screen at the same time. Both would sell. The failure
is not detected by anything downstream — seat inventory is per session, so each show has a
full, internally consistent seat map — and it surfaces at the door, with two audiences.

## Rules

All decisions live in `apps/api/src/shows/show-scheduling.ts` as pure functions on plain
data: no Prisma, no Nest. The service supplies existing sessions and persists the outcome;
whether a slot is legal is decided there and is exhaustively unit-tested.

### Turnaround

`SHOW_TURNAROUND_MINUTES` (0–240, default 15) is the minimum gap between one show ending
and the next starting on the same screen. A cinema cannot run back-to-back: the room has to
empty, be cleaned and refill. `14:00–16:00` followed by `16:00–18:00` reads fine in a
spreadsheet and cannot be run.

The gap is applied **once to the pair**, not added to each window. Adding it to both would
silently demand double the configured turnaround, which is not what an operator setting
"15 minutes" means.

Zero is allowed: some operators build the gap into the advertised runtime and do not want a
second one imposed.

### Rejection reasons

| Reason                   | Meaning                                           |
| ------------------------ | ------------------------------------------------- |
| `ENDS_BEFORE_IT_STARTS`  | Zero-length or inverted window                    |
| `IN_THE_PAST`            | Start time has already passed                     |
| `DUPLICATE_IN_REQUEST`   | Exact repeat of another slot in the same request  |
| `OVERLAPS_EXISTING_SHOW` | Collides with a session already on the screen     |
| `OVERLAPS_PROPOSED_SHOW` | Collides with an earlier slot in the same request |

A duplicate is reported separately from an overlap because it is a different mistake —
usually a double-submitted form — and "you listed 14:00 twice" is more useful than
"conflict".

Cancelled sessions never block a slot. A cancelled show has released its screen time, and
refusing to schedule a replacement into it would defeat the purpose of cancelling.

## Bulk scheduling

`POST /movies/:movieId/shows/bulk` — an extension of the existing scheduling surface, not a
competing route. The single-show `POST /movies/:movieId/shows` remains the simple path.

```jsonc
{
  "screenId": "c...",
  "from": "2026-08-21",
  "to": "2026-08-28",
  "times": ["09:00", "12:45", "16:30", "20:15", "23:45"],
  "padMinutes": 20,
  "timezone": "Asia/Kolkata",
  "dryRun": true,
}
```

Three behaviours worth knowing:

**`dryRun` defaults to `true`.** The safe outcome for a forgotten or malformed flag is
"showed you the plan", never "created forty shows". An operator previews, resolves
conflicts, then re-sends with `dryRun: false`.

**Proposals are checked against each other**, not only against the database. Every slot in
a repeated daily grid is individually legal and the set collides only with itself, so the
obvious implementation — check each against existing sessions — passes them all and
double-books the screen repeatedly. This is the specific way bulk scheduling goes wrong.

**End times are derived**, from `movie.runtimeMinutes + padMinutes`. A show's length is a
property of the film. Asking an operator to retype it per slot is how a 90-minute film ends
up scheduled as a 90-hour one. `padMinutes` covers trailers and titles.

### Response

```jsonc
{
  "dryRun": true,
  "turnaroundMinutes": 15,
  "proposed": 40,
  "created": [],
  "rejected": [
    {
      "startsAt": "...",
      "endsAt": "...",
      "reason": "OVERLAPS_EXISTING_SHOW",
      "detail": "cmsd...",
      "gapMinutes": -45,
    },
  ],
}
```

`gapMinutes` goes negative for a real overlap, which is what makes a conflict readable at a
glance: `-45` means the proposed show starts 45 minutes before the other one ends.

## Timezones

Times are **wall-clock**, because that is how a theater publishes: a 10:30 show is 10:30
every day and does not move because the server is in another zone.

`zonedWallClockToInstant` resolves each `(date, time)` through the venue's IANA zone using
`Intl`, deriving the offset for that specific instant rather than assuming a fixed one. The
naive `new Date(\`${date}T${time}\`)` resolves against the **server's** zone — every
deployment here runs UTC — which would schedule every Indian show 5h30m late.

Deriving the offset per instant also keeps a market that observes DST correct across the
transition; India does not, but the code should not have to be revisited when another market
is added.

Date ranges are walked on a UTC calendar. These are date _labels_ paired with a wall-clock
time later, so stepping them through a local calendar would drop or repeat a day across a
DST boundary.

## Concurrency

Both the single and bulk paths take `SELECT … FOR UPDATE` on the **screen row** inside the
transaction before checking for conflicts.

Without it, two managers filling the same screen at the same moment both read "no conflict"
and both insert — check-then-act, and the outcome is exactly the double-booking these rules
exist to prevent. Locking the screen row is sufficient because conflicts are always between
sessions on the same screen, and scheduling is far too infrequent for the contention to
matter.

Bulk writes in a **single transaction** and re-checks every slot inside the lock, because
the decision set was computed from a read taken before the lock was held. Either the whole
accepted set lands or none of it does: a half-created schedule is the worst available
outcome, since the operator cannot tell what exists without re-reading and re-submitting
would duplicate whatever succeeded.

## What is not built yet

Honest list, so nobody assumes otherwise:

- **Pause / reopen sales, cancel show, edit an eligible future show.** `SessionStatus`
  supports the states; the operations and their booking-aware guards are not written.
- **Copy a schedule** to another day or another compatible screen. The bulk endpoint makes
  this mostly a matter of reading one day and re-submitting it, but there is no endpoint.
- **Screen-level active/maintenance status.** `Cinema.status` is checked; `Screen` has no
  status column, so a single screen cannot be taken out of service.
- **Booking-window fields** (`bookingOpensAt` / `bookingClosesAt`) on a session.
- **Organizer UI.** This is API-only so far.

---

# Sales control, cancellation and mutation

## States

`SessionStatus` is `SCHEDULED | PAUSED | CANCELLED | COMPLETED`. `PAUSED` was added for
sales control; the other three already existed.

A status rather than a `salesPaused` boolean, deliberately. Booking creation already
refuses anything that is not `SCHEDULED`, and the public showtime query already filters on
status, so the new state is enforced by code that already exists. A parallel flag would
have to be taught to both call sites, and the failure mode of forgetting one is selling
tickets to a show the operator believes is closed.

```
SCHEDULED ⇄ PAUSED        pause / reopen
SCHEDULED → CANCELLED     cancel
PAUSED    → CANCELLED     cancel
COMPLETED                 terminal
CANCELLED                 terminal
```

## Operation policy

Decided in `show-operations.ts` and asserted cell-by-cell in its spec, so this table cannot
drift from the code.

| Operation   | Nothing booked | Active hold | Pending payment | Confirmed | Started | Cancelled  | Completed |
| ----------- | -------------- | ----------- | --------------- | --------- | ------- | ---------- | --------- |
| Pause       | yes            | yes         | yes             | yes       | no      | no         | no        |
| Reopen      | yes            | yes         | yes             | yes       | no      | no         | no        |
| Cancel      | yes            | yes         | yes             | yes       | **yes** | idempotent | no        |
| Edit time   | yes            | no          | no              | **no**    | no      | no         | no        |
| Edit screen | yes            | **no**      | no              | no        | no      | no         | no        |

Repeating an operation already in effect returns `changed: false` rather than an error. An
operator double-clicking, or retrying after a timed-out response, should land on the
intended state rather than an error inviting them to try something else.

Three of these are worth the reasoning:

**Cancel is allowed on a show that has already started.** A projector failing ten minutes
in is precisely when an operator needs to cancel and refund. Refusing would leave them with
no way to record it.

**Edit time refuses once anyone has paid.** Someone bought a seat to be somewhere at a
stated time. Moving it silently is the worst thing this API could do. The operator must
cancel, so the customer is actually told.

**Edit screen refuses on any commitment at all, including an unpaid hold.** Seats belong to
a screen's layout. A held seat on the old screen would silently cease to exist.

## Field mutability

`FIELD_MUTABILITY` in `show-operations.ts`, exported so the classification is checkable
rather than a comment.

| Class | Meaning                      | Fields                                     |
| ----- | ---------------------------- | ------------------------------------------ |
| A     | Safe before any booking      | `startsAt`, `endsAt`                       |
| B     | Safe with bookings present   | `salesStartAt`, `salesEndAt`, `priceMinor` |
| C     | Never after publication      | `seatMapId`                                |
| D     | Requires cancel-and-recreate | `screenId`, `movieId`                      |

Class B is safe because none of it can invalidate an existing purchase: bookings snapshot
their own totals, and sales windows gate only new ones.

## Pause semantics

Existing holds are **left alone** and allowed to run out their TTL.

This is a deliberate choice between two defensible options. A customer on the payment page
when a manager pauses the show has already picked seats and may already have been charged
by the provider. Invalidating the hold mid-transaction produces the worst outcome
available: money taken for seats the system has since released. Letting it finish costs at
most a handful of extra tickets on a show that is closing anyway, and those seats were
already spoken for.

Confirmed bookings are untouched. Sold seats are never released.

## Cancel semantics

The session is **never deleted** and no financial record is touched.

Seats that are `AVAILABLE` or `HELD` become `UNAVAILABLE`. `SOLD` stays `SOLD`: the booking
behind it is real until a refund says otherwise, and releasing it would let the same seat
sell twice if the show were reinstated as a new session.

**No refunds are issued here.** Refunds go through a provider, and calling one inside this
transaction would hold database locks open across a network call to Razorpay — the pattern
the platform's own guidance forbids, because a slow provider then blocks the row locks seat
inventory depends on.

Affected bookings are instead **returned** in `bookingsRequiringRefund` so the caller can
route them into the existing refund workflow. An explicit handoff is better than a second
refund path invented here.

## Booking windows

Enforced server-side on `TicketType.salesStartAt` / `salesEndAt` at booking creation, which
is the same path the seat hold runs on. The client is never authoritative.

Boundaries are **inclusive at both ends**, because that is what the server does
(`salesStartAt > now` and `salesEndAt < now` reject). `publicShowState` matches exactly.
An exclusive close reads more naturally and would be wrong: for one instant the listing
would say "closed" on a show the server would still happily sell.

## Public API

Paused shows stay in the listing with `availability: 'SALES_PAUSED'` rather than vanishing
— a show that simply disappeared reads as a bug to a customer who was about to book it.
This extends the existing `AVAILABLE | LIMITED | SOLD_OUT` field rather than adding a
parallel flag, so a client keeps reading one value to decide whether to show a Book button.

`CANCELLED` and `COMPLETED` sessions remain excluded: they are not upcoming screenings a
customer can plan around.

Paused outranks seat counts, so a closed show never advertises seats it will not sell.

## Audit

Every operation records through the existing `AuditService` with one shape:
`actorUserId`, `organizationId`, `entityType: 'EventSession'`, `entityId`, and metadata
carrying `screenId`, `from`, `to` and the reason.

Actions: `SHOW_BULK_SCHEDULED`, `SHOW_SALES_PAUSED`, `SHOW_SALES_REOPENED`,
`SHOW_CANCELLED`, `SHOW_RESCHEDULED`.

A reason is **required** for cancellation and optional for pause/reopen. Cancelling strands
people who have paid, and an audit trail that cannot say why is not much of a trail;
pausing is routine and usually self-evident.

## Still not built

- **Copy schedule to another date or screen.** The bulk endpoint covers most of it —
  copying to another screen is a bulk call with a different `screenId`, and its
  compatibility checks (tenant, cinema active, seat map present) already run. What is
  missing is the convenience of reading a source day's times automatically.
- **Screen-level operational status.** `Cinema.status` is checked; `Screen` has no status
  column, so one screen cannot be taken out of service for maintenance.
- **Concurrency proofs against real PostgreSQL** for the scheduling paths. The row-lock
  design is in place and migrations were validated against a real database, but the racing
  proofs are not written.
