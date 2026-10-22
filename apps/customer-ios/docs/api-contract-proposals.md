# API contract proposals (not applied)

These are proposals only. This document doesn't change any backend, web or Expo code. Each
item needs owner approval and its own PR. Paths are relative to the repository root.

## 1. Venue time zone

**What the API already sends**

The venue zone comes from `Venue.timezone` (`apps/api/prisma/schema.prisma:1007`), with
`venueZone()` as the fallback for single-zone countries (`packages/shared-types/src/markets.ts:481`).

| Response | Field | Source |
|---|---|---|
| Event cards on `/public/events` and discovery | `venue.timezone` | `events/public-events.service.ts:121` |
| `/public/events/:slug` | `timeZone` on the event and on each session | `public-events.service.ts:453, :480` |
| `/tickets` | `timezone` | `tickets/tickets.service.ts:347` |
| `/public/movies/:slug/shows` | `cinema.timezone` and `localDate` | `movies/movies.service.ts:690-692` |

**What's wrong today**

- **Movie shows without a cinema** (general-admission screenings) send no zone. `venue` has none (`movies.service.ts:681-686`).
- **Inconsistent spelling.** The field is `timeZone` on event detail and `timezone` everywhere else.
- **The Expo app ignores all of these.** `formatDateTime(value, timeZone?)` exists (`apps/customer-mobile/src/services/locale.ts:57`), but no caller passes a zone, so every time shows in the device's zone. customer-web already formats in the venue's zone (`apps/customer-web/lib/event-when.ts:95-104`).
- **A comment is out of date.** `apps/customer-mobile/src/features/cinema/movie-schema.ts:85` says the API sends no zone.

**Proposed changes (additive, backward compatible)**

1. **API.** Add `timezone` to each show's `venue` in `movies.service.ts:681-686`, using the `zone` already computed at `:651`. Optionally, add `venue.timezone` on event detail as well, keeping the existing `timeZone` so current clients are unaffected.
2. **Expo.**
   - Add an optional, nullable `timezone` to `venueSchema`, to the show `venue` and to `ticketSchema`, and an optional `timeZone` to event detail and sessions.
   - Pass these to `formatDateTime`.
3. **Expo, also needed:** change `venueSchema.country` to `.nullable()`. `cardVenue` can return `country: null` (`public-events.service.ts:118`), which today fails the whole discovery or list parse.

**Risk:** low. Zod drops unknown keys and all the new fields are optional. The native app already handles all of the above.

## 2. Ticket QR contract

**Current behaviour** (`tickets.service.ts`, `decorate`)

- **When a ticket may be presented:** `mayPresent` is true unless the ticket was transferred and this viewer is neither the holder nor the attendee (`:277`).
- **`qrToken`:** a signed string when `mayPresent`, otherwise `null` (`:279-286, :316`).
- **`qrDataUrl`:** `null` when `!mayPresent`, and also when the vendor barcode format isn't QR (`:300-304`).
- **`vendorBarcode` and `vendorBarcodeFormat`:** `vendorBarcode` is a third-party gate code. Both are sent but undocumented (`:319-321`).
- **No typed DTO.** The controller returns the service output as-is.
- **Transferred tickets stay in the wallet.** `/tickets` includes tickets the buyer has transferred away (`:77-79`), so a buyer can receive `qrToken: null`.

**Impact: a production defect in the Expo app**

- `ticketSchema.qrToken` is `z.string()` (`apps/customer-mobile/src/features/bookings/schema.ts:61`).
- The wallet is parsed with `z.array(ticketSchema)`, and `getParsed` throws on any failure (`src/services/http.ts:18-27`).
- So **one transferred ticket empties the customer's whole Tickets screen**. Vendor tickets that use a format other than QR show no code.
- customer-web is not affected: `qrToken?: string | null` (`packages/web-kit/src/api.ts:3198-3226`).

**Proposed changes**

1. **Expo.**
   - Change `qrToken` to `z.string().nullable()`.
   - Add these, all optional and nullable: `vendorBarcode`, `vendorBarcodeFormat`, `vendorName`, `transferred` and `timezone`.
   - Show "transferred" instead of a code when `qrToken` is null.
   - This ships as an app release. No server-side mitigation keeps the contract intact.
2. **Shared types.** Add a `PublicTicket` interface in `packages/shared-types` and make it the return type of `decorate`, so all clients use one definition.
3. **Web-kit.** Add the vendor fields to `WalletTicket`.

**Risk:** the Expo fix is small. Until it ships, affected customers see an error in Tickets.

## 3. Movie list (`GET /public/movies`)

**What it returns** (`movies/movies.controller.ts:157`, `movies.service.ts:292-367`)

- **Shape:** a plain array, not paginated. At most 60 items, newest release first.
- **Query parameters:** `city`, `country`, `genre`, `q`.
- **What's included:** only published films with a future session that is open for sale. Results are cached per filter set.
- **Fields per movie:**
  - `id`, `contentLabel`, `title`, `slug`
  - `posterUrl` (nullable), `certificate` (nullable)
  - `language`, `genres`, `runtimeMinutes`
  - `rating`, as `{average, count}` or null
- This is the same shape as discovery's `nowShowing`.

**Assessment.** No API change is needed.

- Clients shouldn't parse this list with the full movie schema (`publicMovieSchema`), because list items lack `synopsis`, `cast` and `director`.
- The native app will add a `MovieCard` model (the summary plus `rating` and `contentLabel`) when the Movies tab moves to this endpoint, which is planned for Phase 2.
- The Expo app can do the same with `movieSummarySchema.extend({ rating, contentLabel })`.
