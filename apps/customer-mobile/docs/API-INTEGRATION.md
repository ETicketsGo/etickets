# API integration

The app talks only to the existing NestJS API. It adds no backend and holds no business
logic that the server does not already own.

## Every endpoint the app calls

Verified against QA (`api-qa-f580.up.railway.app`) on 2026-08-04.

| Method | Path                             | Auth   | Used by                               |
| ------ | -------------------------------- | ------ | ------------------------------------- |
| GET    | `/public/discovery`              | public | Home shelves, movie detail            |
| GET    | `/public/categories`             | public | Search filter chips                   |
| GET    | `/public/events`                 | public | Search (paged)                        |
| GET    | `/public/events/:slug`           | public | Event detail, checkout, seats         |
| GET    | `/public/shows/:sessionId/seats` | public | Seat map                              |
| POST   | `/auth/register`                 | public | Register                              |
| POST   | `/auth/login`                    | public | Login                                 |
| POST   | `/auth/refresh`                  | public | Token rotation (interceptor)          |
| POST   | `/auth/logout`                   | public | Logout                                |
| GET    | `/auth/me`                       | bearer | Session hydration                     |
| POST   | `/bookings`                      | bearer | Create booking + hold                 |
| GET    | `/bookings`                      | bearer | Bookings list                         |
| POST   | `/bookings/:id/pay`              | bearer | Start payment                         |
| GET    | `/tickets`                       | bearer | Wallet + QR                           |
| POST   | `/support`                       | public | Contact support                       |
| POST   | `/payments/:bookingId/mock-pay`  | public | QA mock settle, via `clientActionUrl` |

## Contracts

Responses are parsed with Zod at the boundary (`src/services/http.ts`). Request shapes
come from `@eticketsgo/validation` — `registerSchema`, `loginSchema`,
`createBookingSchema` — the exact schemas the API validates against, so the client
cannot drift into rejecting something the server accepts.

Parsing rather than casting is deliberate: the mobile app is the one client that cannot
be redeployed in step with the API. A drifted field becomes one handled error on one
section instead of a crash.

`ApiContractError` is distinct from a network error, because the remedy differs —
retrying cannot fix a schema mismatch, so the user is told to update the app.

## Verified API gaps

### 1. No public route from a movie to its screenings — BLOCKING for cinema

`/public/discovery.nowShowing` returns movie catalogue entries (slug
`skyfront-protocol`). The bookable Event's slug is `skyfront-protocol-show-598484`.
Nothing public maps between them:

- `GET /movies/:movieId/shows` → 401 unauthenticated, **403 TENANT_FORBIDDEN** for a
  customer. Organizer-scoped.
- `GET /public/events` → excludes `experienceType=MOVIE` (returns 3 EVENT rows; the
  parameter is not in the endpoint's schema).
- `GET /public/events/skyfront-protocol` → **404 EVENT_NOT_PUBLISHED**.

Smallest additive fixes, both backwards compatible:

**Option A** — one field on each `nowShowing` item and each `new-releases` section item:

```jsonc
"bookableEventSlug": "skyfront-protocol-show-598484" // or null
```

**Option B** — a public showtimes route (needed anyway once a film plays at several
cinemas):

```
GET /public/movies/:movieSlug/shows?city=&date=
200 {
  movie: { id, title, slug, posterUrl, certificate, language, genres, runtimeMinutes },
  cinemas: [{ id, name, city, shows: [{ eventSlug, sessionId, startsAt, screenName,
                                        format, seatsAvailable, seatsTotal }] }]
}
```

Tracked in code as `CINEMA_CAPABILITIES.publicShowtimesByMovie`. Closing it is a
one-line flip and a deleted UI branch.

### 2. No per-show availability counts

Nothing public exposes seats-remaining for a session. A "filling fast" badge is
therefore **not rendered** rather than guessed. Flag:
`CINEMA_CAPABILITIES.publicShowAvailabilityCounts`.

### 3. No accessible / companion seat metadata

The `Seat` model carries `kind` (`SEAT | GAP`) only, and even that is not projected into
the public response. Wheelchair spaces cannot be identified, so the app does not imply
it knows where they are. Flag: `CINEMA_CAPABILITIES.accessibleSeatMetadata`.

### 4. No password reset endpoint

`/auth` exposes register, login, refresh, logout, me. There is no forgot-password route,
so the app does not offer one.

### 5. No account deletion endpoint

`/users/me` supports GET and PATCH only. A delete-account request cannot be made from
the app. Both stores require a path to account deletion, so this is a submission blocker
— see [APP-STORE-READINESS.md](APP-STORE-READINESS.md). Minimal contract:
`DELETE /users/me` (soft-delete + anonymise), or `POST /users/me/deletion-request`.

### 6. No guest-booking claim endpoint

Guest checkout exists (`POST /bookings/guest`), but nothing lets a user later attach a
guest booking to a new account. The app therefore does not offer a claim flow.
