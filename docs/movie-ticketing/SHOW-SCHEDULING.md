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

> **Superseded.** Everything this section originally listed as missing — pause/reopen,
> cancel, edit-time, copy-to-date, copy-to-screen, screen operational status and the
> organizer UI — has since shipped and is documented in the sections below and in
> [THEATER-OPERATIONS.md](./THEATER-OPERATIONS.md). The list is kept, corrected, rather than
> deleted, because a stale "not built" list is worse than none: it makes somebody rebuild
> something that exists.

Still genuinely missing:

- **Screen-change editing.** `show-operations.ts` defines an `EDIT_SCREEN` policy rule, but
  **no endpoint implements it** and no UI offers it. `POST /shows/:sessionId/reschedule`
  accepts a start time and padding only. The supported workflow is cancel-and-reschedule.
- **Per-session booking-window fields.** The window is derived from the session's ticket
  types (`salesStartAt` / `salesEndAt`); there is no `bookingOpensAt` / `bookingClosesAt` on
  `EventSession` itself, so a show cannot have a window independent of what it sells.
- **Per-cinema timezone.** `Cinema` has no timezone column. The organizer workspace defaults
  to `Asia/Kolkata` in a single place, which is what changes when the column exists.

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

> **Superseded.** Copy-to-date/screen, screen operational status and the real-PostgreSQL
> race proofs have all shipped — see [Copy semantics](#copy-semantics),
> [Screen operational status](#screen-operational-status) and
> [Concurrency guarantees](#concurrency-guarantees) below.

The one operation in the policy module with no endpoint behind it is **`EDIT_SCREEN`**.
`FIELD_MUTABILITY` and `evaluateOperation` both know the rule, which makes it easy to
mistake for a shipped feature; it is not. Nothing calls it, and the organizer UI offers no
screen picker precisely because the endpoint it would post to does not exist.

---

# Concurrency guarantees

Proved against real PostgreSQL 16, not argued. `show-scheduling.integration-postgres.spec.ts`.

## Lock target and ordering

Every write path takes `SELECT id FROM "Screen" WHERE id = $1 FOR UPDATE` as the **first
statement** in its transaction:

| Path                | Locks                                      |
| ------------------- | ------------------------------------------ |
| `scheduleShow`      | the target screen                          |
| `bulkScheduleShows` | the target screen                          |
| `rescheduleShow`    | the session's current screen               |
| `copySchedule`      | the target screen, via `bulkScheduleShows` |

**Exactly one row, always.** That is what removes the deadlock question rather than
answering it: a transaction holding one lock and waiting for none cannot participate in a
cycle. There is no lock ordering to get wrong because there is never a second lock.

The screen is the right granularity because conflicts are always between sessions on the
same screen. Nothing broader needs to serialise, and scheduling is far too infrequent for
the contention to matter.

`copySchedule` reads the source screen without locking it. That race is benign: the worst
outcome is copying a snapshot that was edited a moment later, which affects what gets
copied, never the integrity of the target screen.

## Transaction scope and re-check location

The overlap check happens **inside** the transaction, **after** the lock. Checking before
the lock is the check-then-act bug this exists to prevent.

Bulk computes its decision set from a read taken before the lock, then **re-checks each
slot inside the lock** before inserting it, because another manager may have committed in
between.

## Isolation assumption

**READ COMMITTED** — PostgreSQL's default and what this codebase runs. It is load-bearing.

After the loser acquires the lock, its next `SELECT` must see the winner's committed
insert. Under REPEATABLE READ the loser's snapshot would predate that commit, its overlap
check would find nothing, and both would insert.

This is asserted, not trusted. One test uses a deliberate barrier: T1 takes the lock and
holds the transaction open, T2 is shown to _block_, T1 commits, and T2's subsequent read is
required to see T1's row.

## Bulk atomicity

One transaction. Either the whole accepted set lands or none of it does.

A half-created schedule is the worst outcome available: the operator cannot tell what
exists without re-reading, and re-submitting would duplicate whatever succeeded.

## Race outcomes

Which request wins is arbitrary and never asserted. That **exactly one** wins, and that the
final database contains no overlap, always is.

| Race                     | Outcome                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| create vs create         | one session; loser gets a conflict, leaves no session, ticket types or seats |
| create vs reschedule     | one wins, both lock orderings tested                                         |
| reschedule vs reschedule | one moves, both shows survive, no overlap                                    |
| bulk vs single           | no overlap; every bulk proposal accounted for as created or rejected         |
| bulk vs bulk             | four identical proposals from two callers produce four shows, not eight      |

## Validated by falsification

A passing concurrency test proves nothing unless it fails without the mechanism. With the
`FOR UPDATE` removed, **5 of the 8 proofs fail**, including both headline races.

Two (`reschedule vs reschedule`, `bulk vs single`) still passed unlocked, so they are
weaker race detectors and are not claimed otherwise.

Five consecutive runs with the lock in place: 8/8 every time.

---

# Copy semantics

`POST /movies/:movieId/shows/copy`. One endpoint for both date and screen copies, because
they are the same operation — the target screen defaults to the source.

A convenience over the bulk engine, not a second scheduler: it reads the source day,
recovers each show's local start time, and hands those to `bulkScheduleShows`. Overlap,
turnaround, proposal-vs-proposal checking, the screen lock, transactional creation and the
dry-run default all come from one place.

- **DST-safe by construction.** Times are recovered as wall-clock and re-resolved against
  the target date in the venue's zone. Adding 24 hours to the UTC instant shifts every show
  by an hour across a clock change. Both directions are proved end to end: New York
  2027-03-13→14 is 23 real hours, 2027-11-06→07 is 25, and a 10:00 show stays 10:00.
- **Cancelled source shows are not copied.** Copying one forward would resurrect something
  the operator deliberately stopped.
- **Padding is not re-applied.** The source sessions already include whatever was used when
  they were created; re-adding it would stretch each show further every time a day is copied.
- **Bookings are never moved.** These are new future sessions.
- **Repeating a copy creates nothing.** Not an idempotency key — the overlap rules simply
  refuse to duplicate a day that is already there, which is what a double-click needs.

---

# Screen operational status

`ScreenStatus` is `ACTIVE | MAINTENANCE | INACTIVE`, set through `PATCH /screens/:id`.
Both non-active states stop new scheduling; the difference is intent.

**Taking a screen out of service does not touch shows already on it.** Cancelling a show
somebody has paid for is an explicit, audited, per-show act, never a side effect of a status
change. The operator is instead given a count of future shows needing a decision.

Enforced on new commitments only: `scheduleShow`, `bulkScheduleShows`, copy, and reopening
sales — reopening because selling seats in a room that cannot open is worse than leaving the
show paused.

**Nothing is exposed publicly.** Customer-facing state stays based on the show's actual
bookability (`AVAILABLE`, `SALES_PAUSED`, `SOLD_OUT`, `CANCELLED`). "Screen maintenance" is
an internal operational fact, and a show on a maintenance screen that has not been paused is
still, correctly, bookable — the operator has not yet decided what to do about it.

---

# Organizer workspace

The UI over all of the above lives at `/organizer/cinemas/[id]/schedule`. Its operator-facing
runbook is [THEATER-OPERATIONS.md](./THEATER-OPERATIONS.md); this section records the
engineering decisions.

## The frontend is a view, never an authority

The workspace does not compute overlap, turnaround, bookability or eligibility. It submits,
reads what the server decided, and translates rejection codes into sentences. A stale page
therefore cannot perform an action the server would refuse — the server refuses it.

This is why `authorizeOperation` returns the policy code in `details.reason` rather than only
a message: the client needs something stable to map to an explanation, and matching on
human-readable prose would break the first time someone improves the wording.

## One badge, not two

`effectiveShowBadge` in `show-status.ts` is the single source for what a row displays. It
folds the booking window into the lifecycle status, because rendering them as two badges put
rows on screen reading **"On sale Booking closed"** — two chips contradicting each other.

An unrecognised status falls through to rendering itself rather than defaulting to "On sale".
When a newer API adds a state, an out-of-date screen must say something honest and unfamiliar
rather than something confident and wrong.

Both the day and week views call this one function. That is the guard against a second set of
presentation rules quietly appearing in one of them.

## The inclusive close, again

`bookingWindowState` uses `now > salesEndAt` — strictly greater — so a show is still on sale
**at** its closing instant, matching `bookings.service.ts`'s `salesEndAt < now` rejection.

This exact inconsistency was introduced once already, on the public side, and fixed. The unit
tests pin both edges at millisecond resolution, which is the reason they exist: no browser
test can place the clock precisely on the boundary.

## Bounded range queries

`GET /cinemas/:id/schedule` accepts either `date` or `from`/`to`, capped at
`MAX_SCHEDULE_RANGE_DAYS = 14`. The week view issues **one** range request rather than seven
day requests — a week is a single question, and seven round trips render the view in seven
jerks. The cap exists so the same endpoint cannot be used to pull an entire season.

Both ends are inclusive, because "Monday to Sunday" means what an operator means by it.

## Timezone handling

Every local date is computed with `Intl.DateTimeFormat().formatToParts` against the cinema's
IANA zone — never a fixed offset, never the browser's zone. Week bucketing uses `localDateOf`,
row times use `formatLocalTime`, and both take the zone as an argument.

The browser-zone defect has now appeared **twice** on this page (once in the day query, once
in row rendering). It is guarded by a Playwright spec pinned to `Europe/London` while
operating an `Asia/Kolkata` cinema, and that guard was itself falsified — reverting the
bucketing to UTC files a 00:30 show under the wrong day and fails the test.

## Testing

- `show-status.test.ts` (vitest, 24 tests) — pure rules. This is organizer-web's first unit
  test harness; the app had none.
- `organizer-scheduling.spec.ts` (Playwright, 33 tests) — the workspace end to end.
- `organizer-scheduling-a11y.spec.ts` (Playwright + axe-core, 5 tests) — WCAG 2.1 AA on both
  views, with rows and badges rendered. The first run found real, serious contrast failures in
  shared design tokens.

## Known gaps

- **Screen-change editing is not implemented** and is not a UI oversight — there is no
  endpoint. See "Still not built" above.
- `Cinema` has no timezone column; the workspace defaults to `Asia/Kolkata` in one place.
- No manual screen-reader pass. The axe scan is a floor, not a certificate.
