# ADR-022: Recommendation Strategy

- **Status:** Accepted · **Date:** 2026-07-13 · **Scope:** Recommendation Platform (Prompt 5)

## Context

The platform needs recommendations ("more like this", personalized picks) without
building a model yet — interfaces only.

## Decision

- **`RecommendationStrategy` seam** + `RecommendationService` that blends
  content-based + organizer + venue when a seed event is given (else trending),
  dedupes, excludes the seed, and routes the result through the existing
  `RecommendationEngine` AI port for future re-ranking.
- Strategies: Trending, ContentBased, Organizer, Venue, RecentlyViewed
  (client-supplied ids), **Collaborative** (documented placeholder — no interaction
  data, falls back to trending), **AiRecommendation** (thin adapter over the AI
  port; Noop = identity). No model implemented — the AI surface is interface-only.
- `GET /public/recommendations?eventId=&limit=&strategy=`; customer event detail
  gains a "You might also like" section reusing `EventCard`.

## Consequences

- Recommendation lenses are drop-in strategies; a real model binds behind the
  existing port with zero call-site changes.
- Collaborative filtering is explicitly a stub (no data yet), not fake output.
- Additive/read-only: no migration; existing flows unchanged. Verified: typecheck
  (all), 161 unit tests, build, e2e green.
