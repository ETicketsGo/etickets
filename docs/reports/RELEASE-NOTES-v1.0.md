# ETicketsGo v1.0 — Release Notes

**Date:** 2026-07-14 · **Line:** `feat/eticketsgo-platform` (mainline)

ETicketsGo v1.0 is a global **Experience Commerce Platform** — events _and_ movies —
built as a Turborepo modular monolith (NestJS + Prisma/PostgreSQL + Redis + BullMQ)
with three Next.js portals (customer, organizer, admin).

## Highlights

### Experiences & booking

- **Experience domain** with a pluggable `InventoryStrategy` seam — events use
  general-admission (quantity) inventory; **movies use seat-based** inventory with
  atomic, oversell-/double-book-proof seat holds. New experience types plug in with
  **zero booking-engine changes**.
- Movie domain: films, cinemas, screens, seat maps, shows; customer **seat-selection
  booking** end-to-end (hold → mock-pay → webhook confirm → seat-bound QR tickets).
- Money paths are atomic & idempotent: confirm (no double-issue), refund (frees
  seats, no double-refund), payout (no double-pay).

### Platform capabilities (added this program)

- **Pricing Strategy** — Flat/Tier/Seat + Weekend/Holiday/Member/EarlyBird/Coupon/
  Dynamic(flagged) rules; events=Tier, movies=Seat; prices unchanged by default.
- **Notification Platform** — Email/SMS/WhatsApp/Push/In-App channels, templates,
  localization, preferences, scheduled/retry/cancel delivery (providers are log-only
  stubs pending real integrations).
- **Discovery** — Trending/Popular/Weekend/NewReleases/Nearby/Spotlights/Recommended
  strategies; improved search & categories; short-TTL Redis cache.
- **Recommendations** — content/organizer/venue/trending strategies behind a service,
  with an AI extension port (no model — interface only).
- **Analytics** — organizer/venue/customer/platform dashboards from reusable
  single-query aggregates.
- **Community** — reviews, ratings, saved, follow-organizer, profiles, following.
- **Operations** — structured JSON logs, Prometheus `/metrics`, health/readiness.
- **Feature-flag framework** — enterprise capabilities (CRM/Sponsors/Templates/
  Memberships/White-label) are flag-gated foundations, not fake UI.

### Quality

- 194 unit tests (33 suites), 4 Playwright e2e journeys, 0 circular deps, strict TS,
  additive-only migrations, 24 ADRs + handbooks/diagrams/reports.

## Known limitations (v1.0)

- Payment/notification providers are mock/log-only (real SendGrid/Twilio/Stripe bind
  behind existing seams).
- Enterprise modules (CRM, Sponsors, Templates) are flag-gated foundations.
- AI recommendation/ranking is a no-op port (no model).
- See `TECH-DEBT-REGISTER.md` for the prioritized backlog (token→cookie, API
  versioning, DB-backed concurrency tests, collaborative filtering data, etc.).
