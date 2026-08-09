# Show-level seat overrides

Taking a seat out of sale for one show, and why the rules are what they are.

---

## Status and kind are separate

`ShowSeat.status` answers **"can this be sold"**. Booking's hold is a single conditional
statement — `UPDATE … WHERE status = 'AVAILABLE'` — so anything that is not `AVAILABLE` is
unbookable atomically, with no cooperation needed from the booking path.

Encoding the _reason_ in the status (`MAINTENANCE`, `HOUSE`, `VIP`…) would force every booking
query to enumerate the unbookable states, and would break the moment somebody adds a seventh
reason. So there is exactly one operator status, `BLOCKED`, and a separate `overrideKind`
carrying why. Reports, the seat-map legend and the audit trail read the kind; the booking
engine never has to.

| Kind           | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `MANUAL_BLOCK` | Generic operator block with a reason                                              |
| `MAINTENANCE`  | Physically unusable — broken recliner, obstructed view, spillage. May auto-expire |
| `HOUSE`        | Withheld by the house — comps, press, sponsors, management                        |
| `VIP`          | Reserved for a named guest                                                        |
| `COMPANION`    | Held beside an accessible seat so a companion can sit together                    |
| `EMERGENCY`    | Safety — gangway keep-clear, evacuation route, incident                           |

House seats carry a `housePurpose` (`COMPLIMENTARY | PRESS | SPONSOR | MANAGEMENT |
TECHNICAL`) rather than six more enum members. A comp for a sponsor and one for a journalist
are the same operational act; finance wants them on one line with a breakdown, not scattered
across the vocabulary every consumer has to learn.

---

## What can never be overridden

### SOLD — always refused

Somebody holds a ticket. Blocking their seat does not un-sell it; it produces a customer at
the door with a valid ticket for a seat the system calls broken. The only honest routes are
cancelling the show or refunding that booking, both of which **tell the customer something**.

This is the single most important rule in the subsystem, and the refusal message names both
alternatives rather than just saying no.

### A LIVE hold — refused, with the wait

The customer may already have been charged by the provider. Stealing the seat risks taking
money for something we then withdrew. The refusal says how many minutes are left, so the
operator waits rather than retrying blindly.

### An EXPIRED hold — treated as free

The checkout is dead and only the sweeper is late. Refusing here would make overrides fail at
random for up to a sweep interval, with an explanation the operator can do nothing about. The
stale `holdBookingId` is cleared as the block is applied.

---

## How concurrency safety is achieved

**Not** by reading state and then writing it.

Every mutation is a single conditional `UPDATE` whose `WHERE` clause names the states it is
willing to act on, exactly mirroring how booking takes a seat. Two conditional updates on one
row are serialised by PostgreSQL: whichever lands second finds its precondition already false
and affects zero rows. There is no window between the check and the act, because there is no
separate check.

```sql
-- block
UPDATE "ShowSeat" SET status = 'BLOCKED', …
 WHERE "eventSessionId" = $1 AND "seatId" IN (…)
   AND (status IN ('AVAILABLE','BLOCKED')
        OR (status = 'HELD' AND ("holdExpiresAt" IS NULL OR "holdExpiresAt" <= $now)))

-- release
UPDATE "ShowSeat" SET status = 'AVAILABLE', …
 WHERE "eventSessionId" = $1 AND "seatId" IN (…) AND status = 'BLOCKED'
```

The pre-read exists **only to produce a good refusal message**. It is never trusted for the
decision — if it disagrees with reality, the UPDATE matches nothing and the seat is reported
as `SEAT_TAKEN_CONCURRENTLY`.

### Proofs

24 tests against real PostgreSQL 16, in `seat-overrides.integration-postgres.spec.ts`:

- Two **independent** `PrismaClient`s, so a race cannot serialise on a shared pooled
  connection and pass for the wrong reason.
- The booking side drives the **real `SeatBasedInventoryStrategy`** — the same code checkout
  runs — not a hand-copied UPDATE. A test that reimplements the mechanism it tests proves only
  that the copy agrees with itself.
- `booking vs block` runs ten rounds asserting _exactly one_ winner, never both, never neither.

**Both guards are falsified.** Removing the block guard fails `booking vs block`.

Removing the **release** guard originally failed _nothing_ — every test refused a taken seat
during the pre-read, so the SQL backstop was never reached. A guard whose absence no test
notices is a comment, not a guard. The three-actor race that exercises it proved far too
narrow to hit reliably, so it is reproduced **deterministically**: a Prisma client extension
books the seat between the service's pre-read and its write, which is exactly the state a lost
race leaves. That test fails with the guard removed and passes with it restored.

---

## Partial success is deliberate

Blocking a whole row where one seat has just sold blocks the other eleven and names the one
refused. Failing the batch would make an operator retry seat by seat to find it.

Response shape:

```jsonc
{
  "applied": 11,
  "refused": 1,
  "seats": [
    { "seatId": "…", "seatLabel": "A7", "applied": false, "code": "SEAT_SOLD", "reason": "…" },
  ],
  "warnings": ["This maintenance block has no expiry, …"],
}
```

---

## Emergency blocks

Releasable, but **only on purpose**. A plain release is refused with
`EMERGENCY_REQUIRES_FORCE`; clearing one needs `force: true` and is audited under its own
action, `SHOW_SEATS_RELEASED_FORCED`. A gangway keep-clear must not vanish because somebody
was clicking through a seat map clearing what looked like clutter.

## Maintenance expiry

`expiresAt` is optional but **suggested** for maintenance, because an open-ended maintenance
block is the one most likely to be forgotten, and a forgotten block is a seat that silently
stops earning.

`expireLapsedOverrides()` sweeps only rows that are still `BLOCKED` with an elapsed deadline,
so a seat re-blocked for a different reason in the meantime is left alone. Idempotent.

**Scheduled on the worker's existing hold-expiry tick, every 60 seconds**
(`HOLD_EXPIRY_INTERVAL_MS`). It is the same operational question at the same cadence, so it
shares that repeatable job rather than adding a second queue key and retry policy. The job id
is fixed, so several worker instances register one repeat between them. Isolated in its own
try/catch: a failing sweep can never undo the hold release that runs before it, and the
remaining rows are simply picked up next tick. **Exactly one sweep per scheduled execution** —
it is deliberately not a `while (backlog) sweep()` loop, because bounding the work per tick is
the entire point.

### The bound is structural, not plan-dependent

Each worker releases **at most `batchSize` overrides per sweep** (default 500). Victims are
chosen in a CTE:

```sql
WITH victims AS (
  SELECT "id" FROM "ShowSeat"
   WHERE "status" = 'BLOCKED'
     AND "overrideExpiresAt" IS NOT NULL AND "overrideExpiresAt" <= $now
   ORDER BY "overrideExpiresAt" ASC, "id" ASC
   FOR UPDATE SKIP LOCKED
   LIMIT $batchSize
)
UPDATE "ShowSeat" AS s SET … FROM victims v
 WHERE s."id" = v."id" AND s."status" = 'BLOCKED' AND s."overrideExpiresAt" <= $now
RETURNING s."id", s."eventSessionId"
```

> **Why not `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`.** That was the original
> shape and it is **not reliably bounded**. Whether the sub-SELECT is evaluated once or
> re-executed is the planner's choice: locally it materialised behind a HashAggregate and
> every run released exactly `n`, while CI chose a different plan and a single call with
> `n = 2` released **4**. A bound that depends on the query plan is not a bound. A CTE
> containing `FOR UPDATE` is never inlined, so `victims` is evaluated exactly once.

**Ordering** is `overrideExpiresAt ASC, id ASC` — oldest first, so a backlog drains in the
order it accumulated and nothing starves behind a trickle of newer blocks; `id` breaks ties so
successive ticks and concurrent workers behave predictably.

**Counting** comes from `RETURNING` ids, not a driver-reported row count. Those same ids are
what the audit entry is derived from, so it cannot credit this tick with a row another worker
released.

**Concurrent workers** take disjoint slices via `SKIP LOCKED`; each is independently bounded,
so two workers at `batchSize = 2` release at most four between them and nothing is released
twice. Whatever they do not take remains for a later tick.

**When a victim becomes unsafe** between selection and write — sold, re-blocked with a new
deadline, already released — the join's repeated predicate simply skips it. The tick returns
**fewer** than `batchSize` rather than reaching for a replacement. Safety beats filling the
batch.

**Audit**: one `SHOW_SEATS_EXPIRED` entry per affected show per sweep, with no actor (the
clock did this, not a person). A tick that releases nothing writes nothing.

**Batch size is validated** — a non-integer or non-positive value is rejected rather than
silently sweeping everything.

> **What the falsification tests do and do not prove.** Removing the `LIMIT`, or reverting to
> the unbounded `IN (SELECT …)` predicate, each fails five tests — the bound is genuinely
> proven. Removing the outer safety re-check, or `SKIP LOCKED`, fails **nothing**: the former
> is unreachable in a single statement because `FOR UPDATE` already re-evaluates the predicate
> under PostgreSQL's EvalPlanQual, and the latter is a liveness property (workers do not block
> on each other) rather than a correctness one. Both are kept as defence in depth, and neither
> is claimed as tested.

## Accessibility

`companionCandidates` suggests the immediate neighbours of a `WHEELCHAIR` space in the same
row, excluding gaps and anything already taken. It **suggests; it does not act** — whether to
hold a neighbouring seat on a sold-out premiere is an operational judgement, and doing it
automatically would quietly remove sellable inventory on every accessible booking.

Neighbours already sold or held are excluded, because suggesting them would produce a refusal
the operator can do nothing about.

---

## Audit

Every applied action writes an `AuditLog` row anchored on the **show**, not the seat —
"what happened to tonight's 9pm" is the question an operator or auditor actually asks, and
per-seat rows would bury it.

| Field                                                     | Carries                                                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `actorUserId`                                             | who                                                                                                   |
| `createdAt`                                               | when                                                                                                  |
| `organizationId`                                          | tenant                                                                                                |
| `entityId`                                                | the show                                                                                              |
| `metadata.screenId`                                       | the screen                                                                                            |
| `metadata.seats`                                          | seat **labels** (`["A1","A2"]`), not ids — an audit entry a human cannot read is not much of an audit |
| `metadata.kind` / `housePurpose` / `reason` / `expiresAt` | what and why                                                                                          |
| `metadata.refusedSeats`                                   | what did _not_ happen                                                                                 |
| `metadata.previousKinds`                                  | on release, what was undone                                                                           |

## Tenancy

Every route loads the show or screen and asserts membership of the **owning cinema's
organization**, never anything the caller supplies. Seats that do not belong to the show are
rejected with `SEAT_NOT_ON_SHOW` rather than silently ignored — silently ignoring them would
let a caller probe which ids exist by watching the applied counts.

## API

| Route                                            | Does                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| `POST /shows/:sessionId/seats/block`             | Block seats with a kind and a mandatory reason         |
| `POST /shows/:sessionId/seats/release`           | Put blocked seats back on sale (`force` for emergency) |
| `GET /shows/:sessionId/seats/:seatId/companions` | Companion suggestions beside a wheelchair space        |

## Not built

- **No cron for `expireLapsedOverrides`** — see above.
- **No undo stack.** Release is the inverse of block; there is no multi-step history to walk
  back.
- **No bulk row/section selection in the UI.** The API accepts up to 500 seats per call; the
  seat map currently overrides one seat at a time.
