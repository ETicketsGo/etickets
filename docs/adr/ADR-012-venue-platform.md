# ADR-012: Venue Platform

- **Status:** Accepted (incremental)
- **Date:** 2026-07-13
- **Relates to:** ADR-011 (Movie Domain)
- **Scope:** PR-2 — the venue/cinema/screen layer needed for movies

## Context

The target vision (spec Phase 5) is a rich venue hierarchy:
`Venue → Building → Hall → Room → Screen → Equipment → Availability → Bookings`,
serving event venues, movie theatres, museums, sports venues and theme parks.

Building that entire hierarchy up front would create many tables with no
consumer — violating the "never create dead code" rule — and most of it is not
needed until museum/theme-park experiences exist.

## Decision

Grow the venue platform **incrementally, per experience type**, reusing the
existing `Venue` model as the shared root rather than replacing it.

For **movies (PR-2)** the concrete need is a cinema topology:

- `Cinema` (optionally linked to a `Venue` for city/geo/discovery reuse) →
- `Screen` (auditorium: type + capacity; seat map in PR-3).

We deliberately do **not** introduce `Building`/`Hall`/`Room`/`Equipment` yet:

- The spec's `Cinema → Multiplex → Screen` is simplified to `Cinema → Screen`.
  A `Cinema` already represents the physical multiplex; a `Multiplex` table
  between them would be an empty pass-through. Documented here so the omission is
  a decision, not an oversight.
- `Building/Hall/Room/Equipment` arrive only when an experience type (e.g.
  museums, PR-4+) actually books rooms/equipment.

The existing `Venue` + `VenueArea` continue to serve events unchanged; `Cinema`
links to `Venue` so a cinema participates in city-based discovery without
duplicating address data.

## Consequences

**Positive**

- No unused venue tables; every model has a consumer today.
- `Venue` stays the single shared location root; cinemas extend it rather than
  fork it.

**Negative / trade-offs**

- The full spec hierarchy is not realised in one step. Accepted: it is added
  per experience type as needed, keeping the schema honest.
- Equipment/availability scheduling (for museums/theme parks) is future work,
  tracked for the PR that introduces those experiences.

## Verification

`Cinema`/`Screen` are additive; `Cinema.venueId` is a nullable FK to the
existing `Venue`. No existing venue behaviour changed.
