# ADR-037: Inventory Sourcing Providers

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Principal Architect
- **Relates to:** ADR-009 (Experience Platform), ADR-010 (Inventory Strategy), ADR-021 (payment provider registry pattern)
- **Scope:** P1 of the Enterprise Inventory Platform evolution — the sourcing seam only

## Context

ETicketsGo must become a provider-agnostic ticket inventory platform: inventory may
come from a theatre integrated directly with us, from a third-party aggregator API,
from the ETicketsGo Theatre Portal, or from future providers — and a user must never
be able to tell which. Every source must expose the same interface, unlimited
providers must plug in through DI, and no business logic may depend on a specific
provider. When one provider fails the platform should fail over to another where
business rules allow.

The platform already has two relevant seams:

- **`InventoryStrategy` (ADR-010)** decides _how_ units are counted/held for an
  experience type (seat-based vs general admission). It is oversell-proof and runs
  inside the caller's Prisma transaction.
- **The payment provider layer (ADR-021/025)** — `PaymentProvider` interface →
  registry → resolver → factory → health — is the proven in-repo pattern for
  "many interchangeable providers behind one interface, selected by trusted data."

What was missing is a seam for _where inventory originates_. All stock today is local
(our DB). Branching the booking engine on source (`if (aggregator) … else …`) would
recreate exactly the coupling ADR-010 removed for strategies.

## Decision

Introduce an **`InventoryProvider`** sourcing abstraction, orthogonal to
`InventoryStrategy`, and a small orchestration layer around it that mirrors the
payment provider pattern. New in `apps/api/src/inventory/sourcing/`:

```ts
interface InventoryProvider {
  readonly name: string;
  readonly sourceKind: 'DIRECT' | 'MANUAL' | 'AGGREGATOR';
  readonly capabilities: { search; authority: 'LOCAL' | 'REMOTE'; failover };
  search();
  availability();
  lockInventory();
  confirmBooking();
  cancelBooking();
  refund();
  sync();
  health();
}
```

- **`DirectInventoryProvider` / `ManualInventoryProvider`** — LOCAL and
  authoritative. They share a `LocalInventoryProvider` base that **delegates every
  write to the existing `InventoryStrategy`** (ADR-010) for the experience type, so
  no inventory maths is duplicated and the oversell guarantee is preserved exactly.
  They differ only in `sourceKind` (provenance: direct-integrated vs portal-entered),
  which ops/analytics can see and end users cannot. When the caller passes a Prisma
  transaction the write composes into it (atomic with the booking); otherwise the
  provider opens its own.
- **`AggregatorInventoryProvider`** — a **placeholder** for future external vendors.
  It hard-codes no vendor and **fails closed**: every operation throws a clear
  `INVENTORY_PROVIDER_UNAVAILABLE`, and `health()` reports unhealthy, so it is never
  selected until a concrete adapter is enabled behind `INVENTORY_AGGREGATOR_ENABLED`.
  It never fabricates availability, locks or confirmations.
- **`InventoryProviderRegistry`** — by-name map of constructed adapters.
- **`InventoryProviderFactory`** — constructs/registers adapters at module init;
  LOCAL always, aggregator only when its flag is on.
- **`ProviderHealthMonitor`** — caches `health()` per provider (short TTL circuit
  breaker); a probe that throws counts as unhealthy and never blocks the caller.
- **`ProviderPriorityManager`** — config-driven try-order
  (`INVENTORY_PROVIDER_PRIORITY`) with a safe default that always prefers LOCAL
  authoritative stock before any external source.
- **`InventoryResolver`** — selects the primary healthy provider and provides
  `withFailover`. **Failover rule:** step to the next candidate only when the current
  provider both throws _and_ advertises `capabilities.failover`. An authoritative
  LOCAL provider (`failover=false`) never fails over — a genuine sold-out/conflict is
  the answer and must surface, not be masked by trying another source.

### Backward compatibility (this is a pure seam addition)

`INVENTORY_SOURCING_ENABLED` defaults **off**. Importing `InventorySourcingModule`
only constructs and registers adapters; it changes no existing path. The booking
engine keeps its current direct hold/confirm until a later phase explicitly routes a
show through the resolver. `search()` on LOCAL providers refuses honestly (catalogue
search stays owned by the discovery domain) rather than duplicate it here.

### Why `InventoryProvider` does not take a Prisma transaction in its signature

External providers cannot participate in our DB transaction — they are network calls.
So the interface is transaction-free; LOCAL providers accept an _optional_ `tx` in the
context and compose into it when present. Reconciling transaction ownership when the
booking engine is switched to route through the resolver is a **later phase**,
explicitly out of P1 scope.

## Consequences

**Positive**

- New inventory sources plug in via DI behind one interface; the booking engine,
  resolver and failover never depend on where inventory originates (success criterion
  "unlimited providers, no business logic depends on a specific provider").
- Reuses the proven payment-provider pattern and the existing `InventoryStrategy`, so
  zero inventory maths is duplicated and the pattern is already understood in-repo.
- Movies remain simply `ExperienceType.MOVIE` served by a provider — no movie-specific
  sourcing path; the same seam serves sports/concerts/museums/parking/etc.

**Negative / trade-offs**

- The provider write methods are covered by unit tests and the DI-boot test but are
  **not yet wired into `BookingsService`** — that (and the transaction-ownership
  reconciliation) is a deliberate later phase, gated by `INVENTORY_SOURCING_ENABLED`.
- Cross-provider "same item" mapping for true failover between a remote source and a
  local mirror is not modelled in P1; the failover mechanism and its capability gate
  are complete and tested, the item-identity mapping lands with the first real
  aggregator adapter.

## Compliance / verification

- Unit tests: resolver selection + failover (including the never-fail-over-authoritative
  rule), health-monitor caching/throw-handling, priority ordering, factory flag-gating,
  registry, LOCAL provider delegation (tx and non-tx), and aggregator fail-closed.
- A Nest DI-boot integration test compiles `InventorySourcingModule` and asserts
  `onModuleInit` registers Direct/Manual (and Aggregator only when flagged).
- `tsc --noEmit` clean; existing inventory-strategy and config suites remain green.
- Feature-flagged off by default → no behaviour change to the current booking path.
