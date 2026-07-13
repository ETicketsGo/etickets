# ADR-010: Inventory Strategy

- **Status:** Accepted
- **Date:** 2026-07-13
- **Deciders:** Principal Architect
- **Relates to:** ADR-009 (Experience Platform)
- **Scope:** PR-1 of the Experience Platform evolution

## Context

Different experience types manage stock in fundamentally different ways:

| Experience | Inventory model |
| --- | --- |
| Event (today) | General admission — a per-ticket-type counter (total / sold / held) |
| Movie | Seat-based — specific seats reserved from a seat map |
| Museum / Theme park | Timed capacity — N slots per time window |
| Tour / Attraction | Capacity per departure |

The existing, oversell-proof general-admission logic was **inlined** in three
places:

- `BookingsService.create` — the atomic conditional hold (`quantityHeld += qty`
  guarded by `WHERE (total - sold - held) >= qty`).
- `PaymentsService` webhook confirm — held → sold.
- `BookingsService.releaseExpiredHolds` — held → available.

If movies (seat-based) were added by branching inside these services, the booking
engine would accrete `if (movie) … else …` logic and become the bottleneck for
every new experience type — the opposite of open/closed.

## Decision

Introduce an `InventoryStrategy` interface and depend on it from the booking and
payment engines. Concrete strategies are resolved **by experience type** via the
`ExperienceTypeRegistry` (ADR-009); the engines never reference a concrete strategy.

```ts
interface InventoryStrategy {
  reserve(tx, lines): Promise<void>;   // atomic, oversell-proof hold
  confirm(tx, lines): Promise<void>;   // held → sold
  release(tx, lines): Promise<void>;   // held → available
  availability(client, ticketTypeIds): Promise<Map<string, number>>;
}
```

- `reserve` / `confirm` / `release` receive the caller's Prisma **transaction
  client**, so they compose atomically with the surrounding booking/payment writes
  exactly as the original inline code did.
- `GeneralAdmissionInventoryStrategy` contains the **existing SQL moved verbatim**.
  Behaviour is identical — this PR is a pure refactor of the seam, not a rewrite.
- `InventoryService.forExperienceType(type)` resolves the strategy: registry maps
  type → `InventoryStrategyKind`, service maps kind → strategy instance.

Future strategies (`SeatBasedInventoryStrategy`, `CapacityInventoryStrategy`,
`TimeSlotInventoryStrategy`) implement the same interface and register themselves;
the booking engine is untouched when they land.

### Why the transaction client is passed in

Inventory operations must be atomic with the booking they belong to (hold + create
booking; confirm + issue tickets). Passing `tx` keeps a single transaction boundary
owned by the caller, preserving the original atomicity and the oversell guarantee
under concurrency. The strategy owns *what* the inventory mutation is; the caller
owns *the transaction* it participates in.

### Ticket issuance stays in the booking domain

`confirm` handles only the inventory transition (held → sold). Issuing `Ticket`
rows remains in `PaymentsService`, because a ticket is a booking artefact, not an
inventory primitive. Seat-based confirmation (PR-3) will additionally persist the
seat assignment, but ticket creation stays where it is.

## Consequences

**Positive**
- The booking/payment engines are open for extension, closed for modification:
  success criterion "new Experience types can be added without modifying the Booking
  Engine" is satisfied structurally.
- The general-admission guarantee (atomic, concurrency-safe, no oversell) is
  preserved exactly — same SQL, now unit-tested at the strategy level.
- The availability formula (`max(0, total - sold - held)`) has a single source of
  truth (`availableUnits`) used by both the strategy and the public read path,
  removing prior duplication.

**Negative / trade-offs**
- One extra indirection (service → registry → strategy) on the booking hot path.
  Negligible cost; the DB round-trips are unchanged.
- `availability(ids)` is part of the contract but currently has a thin caller
  surface (unit tests + the shared formula helper). It is intentionally contract-
  complete so seat-based/capacity strategies implement it uniformly in later PRs.

## Compliance / verification

- Unit tests assert general-admission `reserve` (success + oversell throw),
  `confirm`, `release`, and `availability`, plus the registry mapping.
- The existing `BookingsService.releaseExpiredHolds` tests were updated to inject
  the real `InventoryService` + strategy, so they now exercise the seam end-to-end.
- Lint, typecheck, unit tests, build, and the existing Playwright e2e suite remain
  green.
