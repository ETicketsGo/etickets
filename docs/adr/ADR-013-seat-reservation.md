# ADR-013: Seat Reservation

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-010 (Inventory Strategy), ADR-011 (Movie Domain)
- **Scope:** PR-3 — seat maps, seat-level inventory, customer movie booking

## Context

Movies require reserved seating: a customer picks specific seats, and the same
seat is independently bookable across different shows. This is a different
inventory model from general admission's per-type counters — exactly the case
the pluggable `InventoryStrategy` (ADR-010) was designed for.

## Decision

**Seat model (additive):** `SeatMap` (1:1 with `Screen`) → `SeatCategory`
(price tier) + `SeatSection` → `SeatRow` → `Seat`. Per-show availability lives in
`ShowSeat` — one row per `(eventSession, seat)` with status `AVAILABLE | HELD |
SOLD`, a `holdBookingId`, and `holdExpiresAt`. A "show" remains an
`EventSession` with a `screenId` (ADR-011); its per-category prices are ordinary
`TicketType` rows carrying a `seatCategoryId`. Tickets gain an optional `seatId`
+ `seatLabel`.

**`SeatBasedInventoryStrategy`** implements the same `InventoryStrategy`
interface as general admission and is registered to `ExperienceType.MOVIE` with a
one-line registry change — the booking and payment engines are untouched, proving
the PR-1 seam.

- **Atomic hold / double-book protection:** a single conditional
  `UPDATE "ShowSeat" SET status='HELD', holdBookingId=…, holdExpiresAt=… WHERE
  eventSessionId=… AND seatId IN (…) AND status='AVAILABLE'`. If the affected row
  count is less than the number of seats requested, some seat was already taken
  and the whole booking transaction rolls back. Concurrency-safe by construction
  — the database, not application code, arbitrates the race.
- **Hold expiry:** the existing lazy `releaseExpiredHolds` sweep flips expired
  `HELD` seats back to `AVAILABLE` (held→available) through the strategy.
- **Confirm:** on payment, `HELD → SOLD` for the booking's seats; the strategy is
  self-sufficient from `ShowSeat` (booking items don't store seats) and returns
  one `TicketIssueSpec` per seat so the payment service issues one seat-bound
  ticket each.
- **Reporting parity:** `TicketInventory` counters (held/sold) are kept in
  lock-step with `ShowSeat` so existing analytics/reports keep working for
  movies unchanged.

**Interface evolution:** `reserve/confirm/release` now take a `ReserveContext`
(`eventSessionId`, `bookingId`, `holdExpiresAt`, `lines`) instead of a bare line
array, and `confirm` returns `TicketIssueSpec[]`. General admission was updated to
the same signatures with identical behaviour (verified by tests + e2e). The
booking transaction now creates the pending booking first, then reserves, so the
strategy can bind held seats to the booking id — a safe reordering (still one
atomic transaction).

**Price-integrity validation:** the booking service verifies every selected
seat belongs to the session and that its category matches the line's ticket
type, preventing a client from booking premium seats at a cheaper tier.

## Consequences

**Positive**
- Seat booking is atomic, oversell- and double-book-proof under concurrency.
- Zero changes to the booking/payment control flow for the new inventory model —
  only a new strategy + a one-line registry mapping.
- General admission is byte-for-byte unchanged (same SQL, now returning specs).

**Negative / trade-offs**
- One `ShowSeat` row per seat per show. For large auditoriums × many shows this
  grows, but rows are tiny, indexed by `(eventSessionId, status)`, and created in
  the show-scheduling transaction. Acceptable for the scale at hand.
- The organizer seat-map tool is a structured **form generator** (sections →
  rows → seats), not a visual drag-and-drop editor. It fully defines real seat
  maps; a graphical builder is future polish.

## Verification
Additive migration (6 tables, nullable FKs — no drops). Unit tests cover the
atomic hold, the double-book conflict (fewer rows affected → throw), empty-
selection rejection, and seat-bound confirm/specs; the general-admission tests
were updated to the new signatures and stay green. Full e2e books a movie seat
end-to-end. typecheck, lint, build all green.
