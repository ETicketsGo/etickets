# Movie ticketing — repository audit

Phase 1 of the India movie-ticketing mission. Every row below was established by reading
the actual schema, the actual controller decorators and the live QA API — not by inferring
from filenames. That distinction matters here: a previous pass created a duplicate
`/public/movies` controller because a route was assumed missing when it already existed.

**Headline: the movie vertical is largely built.** Movies, cinemas, screens, seat maps,
per-show seat inventory, seat-level booking, tiered convenience fees and server-side
Razorpay routing all exist and are wired end to end. The genuine gaps are in theater
_operations_ (bulk scheduling, layout templates, seat overrides), _pricing sophistication_,
and _partner integration_ — not in the core purchase path.

## How routes were enumerated

`@Controller` prefixes were read per class, because several files declare two controllers
and a naive scan attributes the second class's routes to the first prefix. 286 routes
across the API. The movie-relevant ones:

| Method       | Route                            | Controller               | Auth   |
| ------------ | -------------------------------- | ------------------------ | ------ |
| GET          | `/public/movies`                 | `PublicMoviesController` | public |
| GET          | `/public/movies/:slug`           | `PublicMoviesController` | public |
| GET          | `/public/movies/:slug/shows`     | `PublicMoviesController` | public |
| GET          | `/public/shows/:sessionId/seats` | `PublicShowsController`  | public |
| POST/GET     | `/movies`                        | `MoviesController`       | org    |
| GET/PATCH    | `/movies/:id`                    | `MoviesController`       | org    |
| POST         | `/movies/:id/status`             | `MoviesController`       | org    |
| POST/GET     | `/movies/:movieId/shows`         | `ShowsController`        | org    |
| POST/GET     | `/screens/:screenId/seatmap`     | `ShowsController`        | org    |
| POST/GET     | `/cinemas`                       | `CinemasController`      | org    |
| GET/PATCH    | `/cinemas/:id`                   | `CinemasController`      | org    |
| GET/POST     | `/cinemas/:cinemaId/screens`     | `CinemasController`      | org    |
| PATCH/DELETE | `/screens/:id`                   | `ScreensController`      | org    |
| GET          | `/admin/movies`                  | `AdminController`        | admin  |

**§24 asked for three public endpoints. All three already exist.** Any new discovery work
must extend `PublicMoviesController`, never add a competing controller.

## Capability matrix

| §     | Capability                                   | State                                                                                                                                                                                                                                                                                                                                                           | Action                                                                                                                     |
| ----- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 3     | Movie catalogue model                        | **Existing** — `Movie` has title, slug, synopsis, runtime, certificate, language, genres[], releaseDate, poster, trailer, cast[], director, status                                                                                                                                                                                                              | Extend: no `originalTitle`, `backdropUrl`, `crew`, `country`, `formats`, external ids, SEO fields                          |
| 4     | Theater org → venue → screen → layout → show | **Existing** — `Organization → Cinema → Screen → SeatMap → EventSession`                                                                                                                                                                                                                                                                                        | Extend: `Cinema` lacks state, PIN, timezone, amenities, parking, accessibility; no GST/settlement identity on the org side |
| 5     | India cinema formats                         | **Partial** — `Screen.screenType` is a free-text string defaulting `"2D"`                                                                                                                                                                                                                                                                                       | Normalise to domain data; today it is an unvalidated string                                                                |
| 6     | Show scheduling model                        | **Existing** — `EventSession` with `screenId`, `startsAt`, `endsAt`, status                                                                                                                                                                                                                                                                                     | Extend: no timezone, language, format, booking-open/close, cancellation policy, publication status _at show level_         |
| 7     | Show scheduling operations                   | **COMPLETE** — create, bulk, recurring, overlap prevention, configurable turnaround, timezone-safe scheduling, pause, reopen, cancel, edit-time, booking-aware guards, copy-to-date, copy-to-screen, screen operational status, booking-window enforcement, audit logging, public state consistency, and race proofs on real PostgreSQL. See SHOW-SCHEDULING.md | Done                                                                                                                       |
| 8     | Seat layout designer                         | **Existing** — `SeatMap → SeatCategory / SeatSection → SeatRow → Seat`, plus an organizer UI at `/organizer/cinemas/[id]/screens/[screenId]/seatmap` (298 lines)                                                                                                                                                                                                | Extend: `Seat.kind` is only `SEAT`/`GAP`; no wheelchair, companion, couple, house                                          |
| 9     | Layout templates + versioning                | **MISSING** — `SeatMap.screenId` is `@unique`, so one layout per screen with no version history                                                                                                                                                                                                                                                                 | Build; needed so a re-layout does not rewrite historical bookings                                                          |
| 10    | Show-level seat overrides                    | **Partial** — `ShowSeat.status` carries `AVAILABLE/HELD/SOLD/BLOCKED` in code; no `HOUSE`/`UNAVAILABLE`, no override API, no audit                                                                                                                                                                                                                              | Extend                                                                                                                     |
| 11    | Seat inventory authority                     | **Existing** — `ShowSeat` is unique on `(eventSessionId, seatId)` with a `version` column; Redis lock engine in `inventory/locking`; PostgreSQL authoritative                                                                                                                                                                                                   | Reuse. Do **not** add a second lock engine                                                                                 |
| 12    | Seat holds                                   | **Existing, TTL now fixed** — `ShowSeat.holdBookingId` + `holdExpiresAt`; `Booking.holdExpiresAt` drives the client countdown (verified live on Android: 4:56 → expiry → seats released). The window was a hard-coded `const HOLD_MINUTES = 10`, which §12 forbids; it is now `BOOKING_HOLD_MINUTES`                                                            | Done in this branch                                                                                                        |
| 13    | Contiguity / orphan-seat rules               | **MISSING**                                                                                                                                                                                                                                                                                                                                                     | Build, server-enforced                                                                                                     |
| 14    | Pricing sophistication                       | **Partial** — `pricing-strategies.ts` has Flat, Tier and Seat strategies; `TicketType.priceMinor` is flat per seat category                                                                                                                                                                                                                                     | Extend for weekend / holiday / premiere / time-of-day                                                                      |
| 15    | India tax & fee breakdown                    | **Existing** — booking response separates `subtotalMinor`, `bookingFeeMinor`, `paymentFeeMinor`, `discountMinor`, `customerFeeMinor`, `totalMinor`, all integer minor units (verified live: ₹400 + ₹18 = ₹418)                                                                                                                                                  | Extend: GST components are not itemised separately                                                                         |
| 16    | Tiered convenience fee                       | **Existing** — `FeeRule { minMinor, maxMinor, feeMinor, currency, active }` is exactly the tiered model, DB-driven so it changes without a deploy                                                                                                                                                                                                               | Extend: not scoped by market/org/venue/campaign                                                                            |
| 17–18 | Booking flow + state machine                 | **Existing** — `BookingStatus` plus `BookingWorkflowState`, `BookingCompensation`, transactional outbox                                                                                                                                                                                                                                                         | Reuse. Do not add a movie-specific state machine                                                                           |
| 19    | Razorpay INR                                 | **Existing** — `razorpay-order.service`, `razorpay-webhook.controller`, `razorpay-connect`, plus `PaymentRoute` routing by country/currency **server-side**                                                                                                                                                                                                     | Reuse. Provider selection is already server-side                                                                           |
| 20    | Confirmation exactly-once                    | **Existing** — outbox + `ProcessedDomainEvent` + compensation framework                                                                                                                                                                                                                                                                                         | Verify for the cinema path                                                                                                 |
| 21    | Cinema ticket                                | **Existing** — `Ticket` carries seat, screen, cinema, venue, server-rendered `qrDataUrl` (verified on device)                                                                                                                                                                                                                                                   | Reuse; never generate QR client-side                                                                                       |
| 22–23 | Cancellation / theater-cancelled show        | **Partial** — `Refund`, `RefundStatus`, `Event.refundPolicy` exist; no per-show policy, no bulk show-cancellation job                                                                                                                                                                                                                                           | Build                                                                                                                      |
| 24    | Public movie API                             | **Existing** — all three endpoints                                                                                                                                                                                                                                                                                                                              | Extend filters only                                                                                                        |
| 25    | Showtime API                                 | **Existing** — `/public/movies/:slug/shows` returns `{movie, shows[], filters{dates,cities,formats,languages}, meta}` with city/from/to/limit query support                                                                                                                                                                                                     | Sufficient                                                                                                                 |
| 26    | Availability API                             | **Existing** — `/public/shows/:sessionId/seats` returns live `AVAILABLE/HELD/SOLD` (verified: another account's holds rendered as "on hold by another customer")                                                                                                                                                                                                | Sufficient                                                                                                                 |
| 27    | City discovery                               | **Partial** — `Cinema.city` is indexed and shows expose a city filter                                                                                                                                                                                                                                                                                           | No dedicated public cities endpoint                                                                                        |
| 28    | Customer web                                 | **Partial** — `/movies` (108 lines), `/movies/[slug]` (185), `/shows/[sessionId]` seat selection                                                                                                                                                                                                                                                                | Verify depth against §28's required screens                                                                                |
| 29    | Customer mobile                              | **Existing and device-validated** — full journey verified on Android 14; five defects fixed in PR #39                                                                                                                                                                                                                                                           | Preserve; do not regress                                                                                                   |
| 30    | Organizer web                                | **Partial, scheduling COMPLETE** — `/organizer/cinemas/[id]/schedule` is a full day+week workspace: bulk create with mandatory dry-run preview, copy-to-date/screen, pause/reopen/cancel/move, booking-window state, screen status, cinema-local timezone throughout. See THEATER-OPERATIONS.md                                                                 | Remaining: no live show dashboard (running/next-up/occupancy), no catalogue governance                                     |
| 31    | Admin                                        | **Partial** — `GET /admin/movies` exists                                                                                                                                                                                                                                                                                                                        | No catalogue governance, dedupe, venue approval, show audit                                                                |
| 32    | Search                                       | **Partial** — discovery module exists                                                                                                                                                                                                                                                                                                                           | Assess before adding infrastructure                                                                                        |
| 35–37 | Partner / theater integration                | **Partial** — `InventoryProvider` seam, `ProviderMapping`, `RawProviderEvent`, `ProviderSyncCheckpoint`, `ProviderInventoryState` all exist (ADR-037/040)                                                                                                                                                                                                       | Extend the existing seam with cinema semantics; do **not** build a parallel one                                            |
| 44    | Testing                                      | **API existing; organizer-web now covered for scheduling** — 24 vitest unit tests (`show-status.test.ts`, the app's first) + 33 Playwright workspace tests + 5 axe WCAG 2.1 AA tests. **customer-web still 0 tests.**                                                                                                                                           | customer-web coverage is now the largest remaining test gap                                                                |
| 47    | Feature flags                                | **MISSING** — only `MOVIE_NOT_PUBLISHED` (an error code, not a flag)                                                                                                                                                                                                                                                                                            | Build if rollout control is wanted                                                                                         |
| 49    | `docs/movie-ticketing/`                      | **MISSING**                                                                                                                                                                                                                                                                                                                                                     | This file is the first entry                                                                                               |

## What this changes about the mission

Roughly 70% of §3–§31 is already implemented. The mission brief reads as a greenfield
build; the repository is not greenfield. Executing it literally would produce exactly the
duplication §52 forbids.

The real remaining work, in value order:

1. **Theater operations** (§7, §9, §10) — bulk/recurring scheduling, layout templates with
   versioning, audited seat overrides. This is what a theater actually needs daily and it
   is the largest genuine hole.
2. **Web test coverage** (§44) — two customer-facing apps with zero tests, against a
   payment flow. This is the biggest risk-per-effort item in the repo.
3. **Pricing and policy depth** (§14, §22, §23) — weekend/holiday pricing, per-show
   cancellation policy, theater-cancelled-show fan-out.
4. **Domain field gaps** (§3, §4, §5) — cheap, additive, backward-compatible columns.
5. **Partner integration seam** (§35–§37) — extend `InventoryProvider`, and per §53 do not
   claim chain inventory without a commercial agreement.

## Scope reality

This is multi-week work across four applications, a schema migration, payments and a
partner API. It cannot be completed in one session, and claiming otherwise would be the
same failure mode as the duplicate controller: confident output not grounded in what is
actually there.

The audit above is the durable deliverable that makes the rest safe to execute
incrementally, by whoever picks it up, without rebuilding what exists.

---

## Addendum — scheduling track assessment (2026-08-08)

An honest read of where the §7 theater-operations track actually stands, replacing the
matrix's one-word verdict with something a reviewer can act on.

### Shipped and verified

| Capability                                    | Evidence                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Scheduling rules, turnaround, bulk, recurring | 34 unit tests; pure module, no Prisma                                                      |
| Operation policy (pause/reopen/cancel/edit)   | 42 unit tests                                                                              |
| Concurrency under real PostgreSQL             | 8 race proofs, two independent clients; **falsified** — removing `FOR UPDATE` fails 5 of 8 |
| Copy semantics incl. DST                      | 9 integration tests (spring-forward 23h, fall-back 25h)                                    |
| Screen status, day schedule, bounded ranges   | 27 integration tests                                                                       |
| Organizer workspace end to end                | 33 Playwright tests                                                                        |
| Pure presentation rules                       | 24 vitest tests                                                                            |
| WCAG 2.1 AA                                   | 5 axe tests, no suppressed rules                                                           |

Two of those deserve their weight noted. The concurrency proofs were **falsified** — the
lock was removed and the tests were confirmed to fail — so they detect the defect rather
than merely coexisting with the fix. C and D still passed unlocked and are therefore
reported as weaker detectors, not as proof. The timezone regression test was falsified the
same way.

### Defects this work found

Not a summary of features; a list of things that were wrong and are no longer:

1. The workspace derived the cinema's day from the **browser's** timezone.
2. Row times rendered with no zone while the day was queried in the cinema's zone.
3. Show status was rendered twice (badge + `sr-only`), so screen readers announced it twice.
4. `publicShowState` treated `salesEndAt` as exclusive while booking creation treats it as
   inclusive — introduced during this track, found by auditing it.
5. A SCHEDULED show past its sales close rendered **two contradicting badges**.
6. Shared design tokens failed WCAG AA: muted text at 3.19:1, status-success 3.64:1,
   status-warning 3.21:1, primary-on-tint 4.49:1, dark status-error 4.30:1.
7. An existing test had **codified** defect 4 (`bookingTone('PENDING_PAYMENT')`); the
   expectation was wrong, not the code.

Defect 6 is the widest: those tokens are shared by all three web apps and mirrored by the
mobile app, so "muted" quietly meant "hard to read" product-wide, not just here.

### Not built, and not to be assumed

- **`EDIT_SCREEN`.** The policy module defines the rule and `FIELD_MUTABILITY` classifies
  the field, which makes it read like a shipped feature in code review. **No endpoint
  implements it.** Cancel-and-reschedule is the supported workflow.
- **Per-cinema timezone.** One hard-coded `Asia/Kolkata` default.
- **Per-session booking windows.** Derived from ticket types, not settable per show.
- **Refunds on show cancellation.** Not initiated and not reported by this UI.
- **Manual accessibility testing.** No screen-reader pass, no user testing. The axe scan
  covers roughly a third of WCAG by construction.
- **Live show dashboard** (§30) — running now / next up / occupancy at a glance.

### Verdict

The scheduling backend and the organizer workspace are **ready for theater QA**: the rules
are server-authoritative, the races are proved against real PostgreSQL rather than mocks,
and the UI is covered end to end including a foreign-timezone browser.

They are **not** a complete theater-operations product. The gaps above are known and
deliberate, and none of them is a silent one — each is stated in the UI, the docs, or both.

---

## Addendum — theater operations platform (2026-08-08)

### Shipped

| §   | Capability                | State                                                                                                                                                                                               |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Seat layout versioning    | **DONE** — clone/edit/publish/activate-future/compare/archive; published versions immutable; migration validated on real PG 16 fresh **and** as an upgrade over live data. See LAYOUT-VERSIONING.md |
| 2   | Show-level seat overrides | **DONE** — six kinds, mandatory reason, partial success, sold/held guards                                                                                                                           |
| 3   | Live occupancy            | **DONE (API)** — counts, blocked-by-kind, revenue, pending, sales pace                                                                                                                              |
| 4   | Live seat map             | **DONE (API)** — pinned layout, override kind/reason/actor, live hold state                                                                                                                         |
| 6   | House seats               | **DONE** — `HOUSE` kind + `housePurpose` (comp/press/sponsor/management/technical)                                                                                                                  |
| 7   | Maintenance seats         | **DONE, sweep not scheduled** — optional auto-expiry, idempotent sweeper, nothing calls it on a timer                                                                                               |
| 8   | Accessibility seats       | **DONE** — `WHEELCHAIR`/`COMPANION` seat kinds on the layout; companion suggestions                                                                                                                 |
| 9   | Operational reports       | **DONE (API)** — from AuditLog, rollups by kind/reason/operator, explicit `truncated` flag                                                                                                          |
| 10  | Audit                     | **DONE** — who/when/screen/show/seat labels/old-new/reason/tenant                                                                                                                                   |
| 11  | Security                  | **DONE** — tenancy from the owning org, `SEAT_NOT_ON_SHOW`, race guards                                                                                                                             |
| 12  | Concurrency               | **DONE** — 24 real-PG proofs, real booking strategy, two clients, both guards falsified                                                                                                             |

**API totals: 1518 tests / 179 suites green.**

### NOT shipped

| §   | Capability                                                       | State           |
| --- | ---------------------------------------------------------------- | --------------- |
| 5   | Seat override UX                                                 | **NOT STARTED** |
| 13  | Organizer UI (Live Ops, seat map, overrides, occupancy, reports) | **NOT STARTED** |
| 14  | Playwright operational scenarios                                 | **NOT STARTED** |

The entire backend is complete, tested and documented. **No organizer-facing UI was built**,
so against the mission's Definition of Done a theater manager can do none of this without a
developer or an API client. That is the honest position: the platform is ready for a UI, and
the UI is the remaining work.

Also outstanding: no cron wiring for the maintenance sweep, no report export, no realtime push
(polling only, following the existing 15s command-centre precedent — there is no WebSocket or
SSE infrastructure in this repository, which was verified rather than assumed).

### What falsification found

Removing the seat-override **release** guard failed no test, because every existing case was
refused during the pre-read and never reached the SQL backstop. The guard was load-bearing and
unproven. It now has a deterministic test that injects the racing booking between the service's
read and its write, and that test fails when the guard is removed.

This is the second time on this track that falsifying a "green" suite found a hole rather than
confirming one. It is worth keeping as the default habit.
