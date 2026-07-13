# ADR-009: Experience Platform

- **Status:** Accepted
- **Date:** 2026-07-13
- **Deciders:** Principal Architect
- **Supersedes / relates to:** ADR-010 (Inventory Strategy)
- **Scope:** PR-1 of the Experience Platform evolution (staged: PR-1 → PR-4)

## Context

ETicketsGo began as an event-ticketing product with a fixed domain shape:

```
Event → EventSession → TicketType → Booking → Ticket
```

The product is evolving into "the operating system for experiences" — supporting
Movies, Museums, Theme Parks, Attractions and Tours alongside Events. Each type
has different inventory (seat maps for movies, timed capacity for museums) and
different metadata, but they share ~80% of the platform: organizations, venues,
bookings, payments, QR tickets, refunds, reporting, check-in.

The existing platform is stable and in use. The evolution must be **additive and
backward compatible**: no existing Event, booking, payment, QR, refund, reporting
or check-in flow may change behaviour.

## Decision

Introduce **Experience** as the root domain concept, with existing Events becoming
`ExperienceType.EVENT`. Crucially, we do **not** create a new physical parent
table. Instead:

1. Add an `experienceType` **discriminator** column to the existing `Event` table,
   defaulting to `EVENT`. The `Event` table _is_ the physical root of an Experience.
   (Migration `20260713093339_experience_type` — additive: new enum + `NOT NULL
DEFAULT 'EVENT'` column. Every existing row becomes `EVENT` automatically; no
   backfill, no data movement, no risk.)
2. Model the Experience domain as a **layer over Event rows**, not a duplicate of
   them. The first load-bearing piece of this layer is the `ExperienceTypeRegistry`,
   which maps each experience type to the platform capabilities it uses (starting
   with its inventory model — see ADR-010).

### Why a discriminator, not a new `Experience` table

The alternative — a new `Experience` parent table with a 1:1 child `Event` — was
rejected. It would require backfilling an `Experience` row for every existing
`Event`, touch every existing query/relation, and add regression risk to a live
system, in direct tension with the "don't duplicate data / don't break migrations
/ 100% backward compatible" constraints. A discriminator delivers the same domain
capability (polymorphic experience types) with an additive, zero-backfill change.

### Staging (avoiding dead code)

PR-1 establishes only the **seam**: the discriminator, the type→capability registry,
and the inventory-strategy abstraction (ADR-010). Experience-specific tables
(`ExperienceImage`, `ExperienceTag`, `ExperienceCategory`, `ExperienceRecommendation`)
and the Movie/Cinema/Screen/Seat domains are **deliberately deferred** to the PR
that consumes them (PR-2/PR-3), honouring the standing "never create dead code"
rule. `ExperienceReview` reuses the existing `Review` model. Discovery re-skinning
lands in PR-4.

## Consequences

**Positive**

- Existing Event behaviour is byte-for-byte unchanged; all prior tests pass.
- New experience types are added by (a) an enum value, (b) a registry mapping, and
  (c) their own inventory strategy — with **zero** changes to the booking engine.
- No duplicated data and no risky migration on the live database.

**Negative / trade-offs**

- Experience-type-specific data lives in satellite tables keyed by `eventId` rather
  than under a dedicated `Experience` PK. Accepted: it avoids a disruptive rename
  and keeps the change additive. A future consolidation remains possible but is not
  needed.
- The word "Event" persists at the storage layer as the physical experience root.
  This is an intentional, documented naming compromise for backward compatibility.

## Compliance / verification

`experienceType` defaults to `EVENT`; the public event API additively exposes it.
Lint, typecheck, unit tests, build, and the existing Playwright e2e suite must all
remain green after this change (they do).
