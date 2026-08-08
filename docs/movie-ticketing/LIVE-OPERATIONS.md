# Live operations

Occupancy, the live seat map, and operational reports for a running cinema.

---

## Occupancy

`GET /shows/:sessionId/occupancy` — one show.
`GET /cinemas/:cinemaId/occupancy?from=&to=` — every show in a window, for the operations
board. Deliberately one call rather than N: a busy multiplex has fifty shows a day, and a
dashboard issuing fifty round trips per refresh would be the slowest page in the product.

| Field                                     | Meaning                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `seatsTotal`                              | Every `ShowSeat` row                                              |
| `capacity`                                | Sellable seats — aisle `GAP`s excluded                            |
| `sold` / `held` / `available` / `blocked` | Live counts                                                       |
| `blockedByKind`                           | Blocked seats broken down by why, with operator-facing labels     |
| `house`                                   | The `HOUSE` slice, called out because finance asks for it by name |
| `occupancyPercent`                        | See below                                                         |
| `revenueMinor` / `pendingPaymentMinor`    | Confirmed and in-flight money, integer minor units                |
| `salesPacePerHour`                        | Seats sold per hour since the first confirmed sale                |
| `observedAt`                              | When the snapshot was taken, so a stale dashboard can say so      |

### Two measurements that are easy to get wrong

**Occupancy excludes blocked seats from the denominator.**

```
occupancyPercent = sold / (capacity − blocked)
```

Measuring against raw capacity reports a sold-out show as 94% because six seats were comped.
Every occupancy number finance looks at would be quietly wrong, and always in the same
flattering direction.

**`held` is counted live, not read from the column.** An expired hold whose sweeper has not
run still reads `HELD`. Reporting those as "customers currently checking out" shows a manager
phantom demand on a show that is actually quiet — precisely when they are deciding whether to
open another screen.

**`salesPacePerHour` is `null` below fifteen minutes of trading.** Two sales in the first
ninety seconds extrapolates to eighty an hour, and a manager who opens a second screen on that
number will regret it.

---

## Live seat map

`GET /shows/:sessionId/live-seat-map` — every seat with its live state, grouped into sections
and rows so the client renders geometry rather than inventing it.

Per seat: `status`, `overrideKind`, `overrideReason`, **`overrideBy` as a person's name** (not
a user id — an operator reading a seat map should see who blocked it), `overrideAt`,
`overrideExpiresAt`, `kind` (including `WHEELCHAIR`), and `heldNow`, which is true only while
a checkout is genuinely live.

Reads the layout version **pinned to the show** via `ShowSeat`, so a screen that has since been
re-seated still renders the room this show is actually playing in. See
[LAYOUT-VERSIONING.md](./LAYOUT-VERSIONING.md).

### Refresh strategy

**There is no realtime infrastructure in this repository.** No WebSocket gateway, no SSE
endpoint — that was verified before designing this, not assumed.

The existing precedent is the events command centre
(`/organizer/events/[id]/command-center`), which polls at `POLL_MS = 15_000` and is labelled
"production-safe polling". Live operations should follow it rather than introduce a second
realtime architecture for one screen.

A per-second poll is explicitly wrong here: a fifty-show board would issue three thousand
requests a minute to watch numbers that move on the timescale of a booking.

> Adding SSE or WebSockets later is a reasonable upgrade, but it is a platform decision with
> its own auth, scaling and reconnect story — not something to smuggle in behind one dashboard.

---

## Operational reports

`GET /cinemas/:cinemaId/reports/seat-overrides?from=&to=`

Every manual seat action, newest first, with rollups by kind, by reason and by operator.

**Read from `AuditLog`, not reconstructed from current seat state.** A seat blocked and then
released leaves no trace in `ShowSeat` at all, so a report built from live rows would be blind
to exactly the question it exists to answer: _what did people do, and why_.

Returns:

- `totalActions`, `seatsBlocked`, `seatsReleased`
- `byKind` — with labels, sorted by volume
- `byReason` — free text as entered, so recurring faults surface ("row F recliners" appearing
  eleven times is a maintenance signal, not a data-entry problem)
- `byOperator`
- `timeline` — each action with actor, show, screen, seat labels, reason and expiry
- **`truncated`** — the window is capped at 500 entries, and a silent cap reads as "that is
  all that happened", which for an audit report is the one impression it must never give

The org-wide audit log is narrowed to one cinema by `metadata.screenId`. Tenancy is asserted
separately through the cinema's organization; the filter is about scope, not security.

---

## Security

Every route asserts membership of the owning cinema's or show's organization, with organizer
roles, resolved from the **database record** rather than from anything the caller supplies.
Cross-tenant reads and writes are refused before any work is done.

---

## What is proven, and how

| Claim                                                 | Evidence                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Occupancy excludes blocked seats from the denominator | Integration test: 6 seats, 2 comped, 2 sold → **50%**, not 33% |
| Expired holds are not counted as demand               | Integration test with a lapsed `holdExpiresAt`                 |
| The seat map shows kind, reason and actor             | Integration test asserting `overrideBy === 'Ops Person'`       |
| Wheelchair kinds survive from the layout              | Same test asserts `kind === 'WHEELCHAIR'`                      |

All against real PostgreSQL 16.

---

## Not built

- **No organizer UI.** The APIs above are complete and tested; the Live Operations screens,
  the clickable seat map and the override dialog are **not implemented**. See the assessment
  in `AUDIT.md`.
- **No realtime push.** Polling only, at the existing 15-second cadence.
- **No scheduled sweep** for lapsed maintenance blocks — the function exists and is tested but
  nothing calls it on a timer.
- **No CSV/PDF export** of the override report.
- **No cross-cinema (chain-level) rollup.**
