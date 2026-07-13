# ADR-014: Experience Discovery

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-009 (Experience Platform), ADR-011 (Movie Domain), ADR-018 (AI Foundations)
- **Scope:** PR-4

> Numbering note: the spec sketched ADR-016 for discovery; this repo uses
> ADR-013 for Seat Reservation, so the PR-4 ADRs are 014–018.

## Context

With events and movies both live as experiences, customers need one discovery
surface rather than siloed browse pages. Discovery must reuse the existing search
and listing services — no parallel query stack.

## Decision

Add a single composed endpoint `GET /public/discovery` returning experience
sections: `nowShowing` (movies), `trendingEvents`, `thisWeekend`, and
`categories`. The `DiscoveryService` **composes existing services**
(`PublicMoviesService.list`, `PublicEventsService.list` with its `dateFrom/dateTo`
filter) — it owns no new query logic. Results pass through the
`RecommendationEngine` AI port (ADR-018), which is a no-op today but makes
personalised ranking a drop-in later.

The customer app gets a dedicated `/explore` hub (the home page is already a rich
events landing) linking movies, events, weekend picks and category chips. Gated
by the `experienceDiscovery` flag (default on).

## Consequences

- One discovery surface, zero duplicated query logic, reused cards/components.
- Personalisation is a future token rebind, not a rewrite.
- Movies stay out of the generic `/events` browse (ADR-011); discovery is where
  the two experience types are intentionally blended.
