# ADR-023: Analytics Platform

- **Status:** Accepted · **Date:** 2026-07-14 · **Scope:** Analytics Platform (Prompt 6)

## Context

Dashboards needed real metrics (organizer/venue/customer/platform) without
duplicating queries, and the organizer dashboard suffered an N+1 (one report
request per event — tech debt D9).

## Decision

- **`AnalyticsService`** with reusable, single-query aggregate building blocks
  (`revenue`, `refundStats`, `attendance`, `conversion`, `repeatCustomers`,
  `couponRedemptions`, occupancy), each parameterized by a Prisma `where` so the
  same block serves organizer, venue, and platform scopes. The platform dashboard
  reuses the existing `reports.adminDashboard()` aggregates rather than
  re-implementing them.
- Endpoints: `GET /analytics/organizer` (financials gated to OWNER/MANAGER+admin),
  `/analytics/venue/:id`, `/analytics/customer`, `/admin/analytics/platform`
  (GMV/revenue/bookings/movies/events/retention + created→confirmed→checked-in
  funnel).
- **N+1 fixed:** the organizer dashboard now calls one `/analytics/organizer`
  aggregate instead of fanning out per-event report requests — same tiles/numbers.
- One additive index (`Event.venueId`) for venue analytics.

## Consequences

- Every metric is one grouped aggregate — no per-entity query loops.
- Dashboard tiles unchanged in appearance; the per-event report endpoint remains
  for drill-down.
- Collections/wishlist/following are client-side and labelled as such (not
  fabricated server metrics). Verified: typecheck (all), 168 unit tests, build, e2e.
