# ADR-021: Discovery Strategy

- **Status:** Accepted · **Date:** 2026-07-13 · **Scope:** Discovery Platform (Prompt 4)

## Context

Discovery was a single composed `/public/discovery`. The platform needs many
discovery lenses (trending, popular, weekend, new releases, nearby, spotlights,
recommended, plus client-side recently-viewed/continue/collections) with better
ranking and search — additively, reusing UI.

## Decision

- **`DiscoveryStrategy` seam**: each lens is a strategy returning a
  `DiscoverySection`; a `DiscoverySectionsService` composes registered strategies
  and drops empty ones. New `GET /public/discovery/sections?city=`; the original
  `/public/discovery` is unchanged.
- **Server strategies**: Trending, Popular, Weekend, NewReleases, Nearby
  (city-based — lat/long deferred, no geo data), OrganizerSpotlight, VenueSpotlight,
  Recommended (routed through the `RecommendationEngine` port for future re-ranking).
- **Ranking**: a pure, deterministic util blending popularity (confirmed bookings)
  with soonness; unit-tested and reused across trending/popular/recommended.
- **Search**: `q` now matches title OR organizer name OR venue name/city (no
  migration). `GET /public/categories` returns category counts.
- **Client-side lenses** (RecentlyViewed / ContinueExploring / Collections) stay
  client-side from `etg_recent` localStorage — rendered on `/explore` reusing
  existing cards; no UI redesign, no new design-system components.

## Consequences

- New discovery lenses are drop-in strategies; ranking is centralized and testable.
- Recommendation remains a no-op port today (re-ranks nothing) — a model binds later.
- Additive/read-only: no migration, existing endpoints/flows unchanged. Verified:
  typecheck (all), 141 unit tests, build, e2e green.
