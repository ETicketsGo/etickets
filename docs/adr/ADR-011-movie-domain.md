# ADR-011: Movie Domain

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-009 (Experience Platform), ADR-010 (Inventory Strategy), ADR-013 (Seat Reservation)
- **Scope:** PR-2 of the Experience Platform evolution — catalog & cinema setup only

## Context

With `ExperienceType.MOVIE` established (ADR-009), the platform needs a film
catalog and a cinema/screen topology before movies can be booked. Movies differ
from events: a film is a reusable catalogue entity that screens as many _shows_
across _screens_ in _cinemas_, and (PR-3) is booked by selecting specific seats.

## Decision

Add an **additive** movie domain that maximises reuse of the existing
Event/Session/Booking/Ticket machinery rather than duplicating it.

**New models (all additive; migration `20260713095926_movie_cinema_domain`):**

- `Movie` — org-scoped film catalogue (title, runtime, certificate, language,
  genres[], releaseDate, poster, trailer, cast[], director, status).
- `Cinema` — an org's cinema; optionally linked to a `Venue` for city/discovery
  reuse. (We fold the spec's "Multiplex" into `Cinema` — a cinema _is_ the
  multiplex venue; a separate table would be an empty intermediary. See
  ADR-012.)
- `Screen` — an auditorium in a cinema (screenType 2D/3D/IMAX, capacity). Its
  seat map arrives in PR-3.

**Reuse via nullable discriminating FKs (additive, backward compatible):**

- `Event.movieId?` → the film a MOVIE experience screens.
- `EventSession.screenId?` → the screen a _show_ plays on.

A movie becomes bookable (PR-3) as an `Event` with `experienceType = MOVIE` and
`movieId` set, whose sessions are shows on screens. This means the entire
booking, payment, QR, refund, reporting and check-in stack is inherited for free
— only the _inventory model_ differs, and that is already pluggable (ADR-010).

**Scope boundary (staging / no dead code):** PR-2 ships catalog + cinema
management (organizer + admin) only. Movies are **not customer-bookable yet**:
`ExperienceType.MOVIE` is deliberately not registered in the inventory registry,
so any movie booking correctly returns "not yet available". Seat maps, the
`SeatBasedInventoryStrategy`, and the customer movie booking flow land in PR-3.
The generic `/public/events` browse is filtered to `experienceType = EVENT` so
movie experiences never leak into it before their dedicated discovery (PR-4).

## Consequences

**Positive**

- Movies reuse ~80% of the platform; the movie-specific surface is small.
- Fully additive: no existing table, API, or flow changed behaviour.
- Clear seam for PR-3 to attach seat-level inventory without new booking code.

**Negative / trade-offs**

- `Movie`/`Cinema` are org-scoped rather than a single global catalogue. This
  fits the existing multi-tenant RBAC and avoids a separate admin-catalogue
  system; cross-org discovery still works by querying published movies.
- "Show" is not its own table — it is an `EventSession` with a `screenId`. This
  is intentional reuse; a dedicated `Show` entity would duplicate session
  lifecycle. Seat-level pricing per show is modelled in PR-3.

## Verification

Additive migration (3 tables, 1 enum, nullable FKs — no drops). Org endpoints
reuse the exact `OrgAccessService` authorization as venues/events; public
endpoints are `@Public()`; admin oversight is `ADMIN`-gated. typecheck, lint,
API unit tests (incl. new movie service spec), build, and existing e2e remain
green.
