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

| §     | Capability                                   | State                                                                                                                                                                                                                                                                                                | Action                                                                                                                     |
| ----- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 3     | Movie catalogue model                        | **Existing** — `Movie` has title, slug, synopsis, runtime, certificate, language, genres[], releaseDate, poster, trailer, cast[], director, status                                                                                                                                                   | Extend: no `originalTitle`, `backdropUrl`, `crew`, `country`, `formats`, external ids, SEO fields                          |
| 4     | Theater org → venue → screen → layout → show | **Existing** — `Organization → Cinema → Screen → SeatMap → EventSession`                                                                                                                                                                                                                             | Extend: `Cinema` lacks state, PIN, timezone, amenities, parking, accessibility; no GST/settlement identity on the org side |
| 5     | India cinema formats                         | **Partial** — `Screen.screenType` is a free-text string defaulting `"2D"`                                                                                                                                                                                                                            | Normalise to domain data; today it is an unvalidated string                                                                |
| 6     | Show scheduling model                        | **Existing** — `EventSession` with `screenId`, `startsAt`, `endsAt`, status                                                                                                                                                                                                                          | Extend: no timezone, language, format, booking-open/close, cancellation policy, publication status _at show level_         |
| 7     | Bulk / recurring / copy scheduling           | **MISSING** — `shows.service.ts` exposes only `scheduleShow` (single)                                                                                                                                                                                                                                | Build                                                                                                                      |
| 8     | Seat layout designer                         | **Existing** — `SeatMap → SeatCategory / SeatSection → SeatRow → Seat`, plus an organizer UI at `/organizer/cinemas/[id]/screens/[screenId]/seatmap` (298 lines)                                                                                                                                     | Extend: `Seat.kind` is only `SEAT`/`GAP`; no wheelchair, companion, couple, house                                          |
| 9     | Layout templates + versioning                | **MISSING** — `SeatMap.screenId` is `@unique`, so one layout per screen with no version history                                                                                                                                                                                                      | Build; needed so a re-layout does not rewrite historical bookings                                                          |
| 10    | Show-level seat overrides                    | **Partial** — `ShowSeat.status` carries `AVAILABLE/HELD/SOLD/BLOCKED` in code; no `HOUSE`/`UNAVAILABLE`, no override API, no audit                                                                                                                                                                   | Extend                                                                                                                     |
| 11    | Seat inventory authority                     | **Existing** — `ShowSeat` is unique on `(eventSessionId, seatId)` with a `version` column; Redis lock engine in `inventory/locking`; PostgreSQL authoritative                                                                                                                                        | Reuse. Do **not** add a second lock engine                                                                                 |
| 12    | Seat holds                                   | **Existing, TTL now fixed** — `ShowSeat.holdBookingId` + `holdExpiresAt`; `Booking.holdExpiresAt` drives the client countdown (verified live on Android: 4:56 → expiry → seats released). The window was a hard-coded `const HOLD_MINUTES = 10`, which §12 forbids; it is now `BOOKING_HOLD_MINUTES` | Done in this branch                                                                                                        |
| 13    | Contiguity / orphan-seat rules               | **MISSING**                                                                                                                                                                                                                                                                                          | Build, server-enforced                                                                                                     |
| 14    | Pricing sophistication                       | **Partial** — `pricing-strategies.ts` has Flat, Tier and Seat strategies; `TicketType.priceMinor` is flat per seat category                                                                                                                                                                          | Extend for weekend / holiday / premiere / time-of-day                                                                      |
| 15    | India tax & fee breakdown                    | **Existing** — booking response separates `subtotalMinor`, `bookingFeeMinor`, `paymentFeeMinor`, `discountMinor`, `customerFeeMinor`, `totalMinor`, all integer minor units (verified live: ₹400 + ₹18 = ₹418)                                                                                       | Extend: GST components are not itemised separately                                                                         |
| 16    | Tiered convenience fee                       | **Existing** — `FeeRule { minMinor, maxMinor, feeMinor, currency, active }` is exactly the tiered model, DB-driven so it changes without a deploy                                                                                                                                                    | Extend: not scoped by market/org/venue/campaign                                                                            |
| 17–18 | Booking flow + state machine                 | **Existing** — `BookingStatus` plus `BookingWorkflowState`, `BookingCompensation`, transactional outbox                                                                                                                                                                                              | Reuse. Do not add a movie-specific state machine                                                                           |
| 19    | Razorpay INR                                 | **Existing** — `razorpay-order.service`, `razorpay-webhook.controller`, `razorpay-connect`, plus `PaymentRoute` routing by country/currency **server-side**                                                                                                                                          | Reuse. Provider selection is already server-side                                                                           |
| 20    | Confirmation exactly-once                    | **Existing** — outbox + `ProcessedDomainEvent` + compensation framework                                                                                                                                                                                                                              | Verify for the cinema path                                                                                                 |
| 21    | Cinema ticket                                | **Existing** — `Ticket` carries seat, screen, cinema, venue, server-rendered `qrDataUrl` (verified on device)                                                                                                                                                                                        | Reuse; never generate QR client-side                                                                                       |
| 22–23 | Cancellation / theater-cancelled show        | **Partial** — `Refund`, `RefundStatus`, `Event.refundPolicy` exist; no per-show policy, no bulk show-cancellation job                                                                                                                                                                                | Build                                                                                                                      |
| 24    | Public movie API                             | **Existing** — all three endpoints                                                                                                                                                                                                                                                                   | Extend filters only                                                                                                        |
| 25    | Showtime API                                 | **Existing** — `/public/movies/:slug/shows` returns `{movie, shows[], filters{dates,cities,formats,languages}, meta}` with city/from/to/limit query support                                                                                                                                          | Sufficient                                                                                                                 |
| 26    | Availability API                             | **Existing** — `/public/shows/:sessionId/seats` returns live `AVAILABLE/HELD/SOLD` (verified: another account's holds rendered as "on hold by another customer")                                                                                                                                     | Sufficient                                                                                                                 |
| 27    | City discovery                               | **Partial** — `Cinema.city` is indexed and shows expose a city filter                                                                                                                                                                                                                                | No dedicated public cities endpoint                                                                                        |
| 28    | Customer web                                 | **Partial** — `/movies` (108 lines), `/movies/[slug]` (185), `/shows/[sessionId]` seat selection                                                                                                                                                                                                     | Verify depth against §28's required screens                                                                                |
| 29    | Customer mobile                              | **Existing and device-validated** — full journey verified on Android 14; five defects fixed in PR #39                                                                                                                                                                                                | Preserve; do not regress                                                                                                   |
| 30    | Organizer web                                | **Partial** — `/organizer/movies` (102), `/organizer/movies/[id]` (507), `/organizer/cinemas` (88), `/organizer/cinemas/[id]` (375), seatmap designer (298)                                                                                                                                          | No schedule calendar, no bulk create, no live show dashboard                                                               |
| 31    | Admin                                        | **Partial** — `GET /admin/movies` exists                                                                                                                                                                                                                                                             | No catalogue governance, dedupe, venue approval, show audit                                                                |
| 32    | Search                                       | **Partial** — discovery module exists                                                                                                                                                                                                                                                                | Assess before adding infrastructure                                                                                        |
| 35–37 | Partner / theater integration                | **Partial** — `InventoryProvider` seam, `ProviderMapping`, `RawProviderEvent`, `ProviderSyncCheckpoint`, `ProviderInventoryState` all exist (ADR-037/040)                                                                                                                                            | Extend the existing seam with cinema semantics; do **not** build a parallel one                                            |
| 44    | Testing                                      | **Existing (API)** — 169 API spec files. **customer-web: 0 tests. organizer-web: 0 tests.**                                                                                                                                                                                                          | Web test coverage is the largest quality gap                                                                               |
| 47    | Feature flags                                | **MISSING** — only `MOVIE_NOT_PUBLISHED` (an error code, not a flag)                                                                                                                                                                                                                                 | Build if rollout control is wanted                                                                                         |
| 49    | `docs/movie-ticketing/`                      | **MISSING**                                                                                                                                                                                                                                                                                          | This file is the first entry                                                                                               |

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
