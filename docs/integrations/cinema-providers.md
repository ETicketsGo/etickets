# External cinema providers

How ETicketsGo sells seats it does not own, and how a new cinema POS is added.

---

## The conclusion first

**ETicketsGo already had the right architecture for this.** The provider seam (ADR-037) was
built for exactly this shape of problem and needed no redesign to accommodate a cinema POS.
Adding Qube is a provider adapter, not a project.

What was added: two optional capability interfaces, one sandbox provider, one placeholder for
the real thing, four error codes, and a reusable contract test. Nothing in the booking domain
changed.

---

## The seam

```
InventoryProvider  (ADR-037 — the inventory AUTHORITY contract)
      |
      +-- DirectInventoryProvider      LOCAL   our DB, theatre integrated directly
      +-- ManualInventoryProvider      LOCAL   our DB, portal-entered
      +-- AggregatorInventoryProvider  REMOTE  placeholder, fails closed
      +-- QubeMockInventoryProvider    REMOTE  sandbox, invented in full
      +-- QubeInventoryProvider        REMOTE  placeholder, not configured
      +-- (future) VistaProvider       REMOTE
```

Every provider answers the same eight questions: `search`, `availability`, `lockInventory`,
`confirmBooking`, `cancelBooking`, `refund`, `sync`, `health`. The booking engine, resolver,
health monitor and priority manager depend only on that, so a new source is a registration —
never a change to how a booking works.

A cinema POS maps onto it directly:

| The remote cinema does      | ETicketsGo calls   |
| --------------------------- | ------------------ |
| report free seats           | `availability()`   |
| hold seats for a customer   | `lockInventory()`  |
| turn the hold into a sale   | `confirmBooking()` |
| release / cancel            | `cancelBooking()`  |
| return seats after a refund | `refund()`         |
| publish catalogue changes   | `sync()`           |

---

## What was genuinely missing

A remote cinema publishes two things no other inventory source has: a **catalogue** (its
cinemas, films, showtimes) and a **seat map**.

These are _not_ on `InventoryProvider`. Most sources have neither — a portal-entered event has
no upstream catalogue, a general-admission provider has no seats — and putting `getShows()` on
the base contract would force every provider to implement a method it can only throw from.
That is how a uniform surface degrades into a list of calls you have to know not to make.

So they are optional interfaces in `cinema-capabilities.interface.ts`:

```ts
interface CinemaCatalogueCapability {
  getCinemas;
  getScreens;
  getMovies;
  getShows;
}
interface SeatMapCapability {
  getSeatMap;
}
```

asked about with type guards — `hasSeatMap(provider)` — rather than a boolean flag. A provider
declaring `supportsSeatMap: true` without the method compiles perfectly and fails in
production; a type guard cannot.

---

## Identity

**External ids are the only identity.** Never a title, a row label, a seat number or a
showtime. Titles get re-spelled, shows get rescheduled, and a mapping keyed on either silently
creates a duplicate or attaches a booking to the wrong screening.

Mappings live in the existing `ProviderMapping` table — no new table:

```
providerCode + externalEntityType + externalEntityId  →  internalEntityType + internalEntityId
```

with `externalVersion` for ordering, `ownershipMode` for who wins a conflict, and
`lastSyncedAt`. `QUBE_MOCK` maps cinema, screen, movie, show and seat identifiers through it.

---

## Booking sequence

```
Customer                ETicketsGo              Cinema provider        Razorpay
   |                        |                          |                  |
   |-- pick show ---------->|                          |                  |
   |                        |-- getSeatMap ----------->|                  |
   |<-- seat map -----------|<-- seats + state --------|                  |
   |-- select seats ------->|                          |                  |
   |                        |-- lockInventory -------->|                  |
   |                        |<-- lockRef + expiry -----|                  |
   |<-- quote --------------|  (OUR pricing, fees, tax — never the vendor's)
   |-- pay ---------------->|------------------------------------------->|
   |                        |<-- payment confirmed ----------------------|
   |                        |-- confirmBooking ------->|                  |
   |                        |<-- externalBookingId ----|                  |
   |<-- QR ticket ----------|                          |                  |
```

Two rules the sequence encodes:

**Pricing is ours.** A provider's prices are advisory metadata. ETicketsGo prices its own sales
through its own pricing, fee and tax engine — including the Andhra Pradesh rate ceilings, which
a remote POS knows nothing about. A number from a vendor is never charged to a customer
unchecked.

**No database transaction is ever held open across a provider call.** A vendor that takes eight
seconds would otherwise hold a Postgres transaction for eight seconds, and a vendor that hangs
would take the database with it.

---

## Failure handling

| Scenario                             | What happens                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Hold succeeds, payment fails         | `cancelBooking()` releases the remote seats. Safe to call if nothing was held. |
| Payment succeeds, confirmation fails | Existing compensation. Never silently lose the payment.                        |
| **Confirmation times out**           | **Outcome is UNKNOWN. Do not assume failure.**                                 |
| Retry with the same booking          | Idempotent: one hold, one booking.                                             |

The timeout row is the one that matters. `PROVIDER_TIMEOUT` is deliberately a _different_ code
from `INVENTORY_PROVIDER_UNAVAILABLE`, because a request that timed out **may have succeeded at
the far end**. Treating it as failure is how a seat is sold twice, or a customer is refunded for
a booking that exists. Reconciliation resolves it by asking the provider what it actually did —
which is why "can a booking be looked up after a timeout?" is on the list of things to ask any
vendor, and a vendor who cannot answer it cannot be integrated safely.

---

## Failover is prohibited for remote authority

`QUBE_MOCK` declares `failover: false`, and the resolver honours it:

```ts
if (!provider.capabilities.failover) throw err;
```

These seats belong to an exhibitor's system. If the resolver stepped past an unreachable
provider to LOCAL inventory, ETicketsGo would sell seats it does not own — and the customer
would find out at a cinema that has never heard of them. **An outage must fail the sale, not
relocate it.**

Three tests assert this, including one proving that a local provider which would happily sell
anything is never called during an outage or a timeout. Flipping `failover` to `true` fails four
tests.

---

## Adding a provider

1. Implement `InventoryProvider`. Add `CinemaCatalogueCapability` / `SeatMapCapability` if the
   vendor publishes them.
2. Declare capabilities honestly. `authority: 'REMOTE'` and `failover: false` for anything
   whose stock you do not own.
3. Point it at the shared contract suite:
   ```ts
   describeCinemaProviderContract('VISTA', () => new VistaHarness());
   ```
   It either passes or the provider is not finished.
4. Register it in `InventoryProviderFactory` behind its own flag.
5. Map its identifiers through `ProviderMapping`.

The contract suite is the important step. Per-provider tests drift — the second provider gets
the tests somebody remembered — and the differences surface as an incident.

---

## Running the sandbox

```
INVENTORY_SOURCING_ENABLED=true
INVENTORY_QUBE_MOCK_ENABLED=true
```

Both off by default, and `INVENTORY_QUBE_MOCK_ENABLED` must never be set in production: a
sandbox provider serving a real customer sells seats in a cinema that does not exist.

The fixture is a Hyderabad multiplex — three screens, two fictional Telugu films, shows at
10:30 / 13:45 / 16:45 / 19:30 / 22:30 across three days, built in `Asia/Kolkata` so the
schedule is the same whichever region the server runs in.

See `qube-readiness.md` for what is still needed before any of this is real.
