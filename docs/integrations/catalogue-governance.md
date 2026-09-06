# Catalogue governance

Who is allowed to create, publish and change a show that came from somebody else's system.

---

## The rule

**A provider feed may record what it publishes. It may never publish it.**

ADR-040 ingests an external catalogue, records identity in `ProviderMapping`, applies advisory
state, emits events — and stops, at `status: UNMAPPED`, with no internal entity linked. That
was already the design when this work started, and it is deliberate. A feed that can create
and publish internal entities can rename your storefront overnight; one that can retract them
can unpublish a screening people are holding tickets for. Neither is a thing a vendor's paging
bug should be able to do.

So catalogue import is **two steps, not one**, and the second one has a person in it.

```
Provider feed
     ↓  sync ingestion (ADR-040)          ← automatic
ProviderMapping  status = UNMAPPED
     ↓  operator review                    ← a person
link an existing internal entity
     OR approve creating one
     ↓
ProviderMapping  status = ACTIVE
     ↓
controlled ongoing synchronization         ← automatic, bounded (see below)
```

The `ACTIVE` mapping is not paperwork. It is what the booking path reads to decide a session is
provider-authoritative and which remote reference to reserve against. Nothing sells until it
exists.

---

## The three modes

| Source                          | Catalogue behaviour                                |
| ------------------------------- | -------------------------------------------------- |
| Sandbox (`QUBE_MOCK`)           | Auto-materialization allowed, dev/test only        |
| Real provider, first ingestion  | Ingest + map only; operator approval required      |
| Real provider, approved mapping | Controlled synchronization within the policy below |

### Sandbox

`SandboxCatalogueMaterializer` turns a mapped sandbox catalogue into real cinemas, screens,
films and shows. It exists so the sandbox can be driven end to end — catalogue in, ticket out —
without building a production auto-publisher to do it.

Three independent conditions, all required:

1. `INVENTORY_SANDBOX_MATERIALIZATION_ENABLED` is on (off by default, refused at boot in
   production),
2. `APP_ENV` is not `PRODUCTION` / `PROD` / `STAGING` / `UAT` — asked separately from
   `NODE_ENV`, which is `production` in every deployed environment,
3. the provider is the Qube sandbox. Any other provider code is refused with a message naming
   the operator path.

It also has **no HTTP surface**, on purpose. A catalogue auto-publisher reachable over the
network is the thing this document exists to prevent.

It is not a back door, either: it creates everything through the same `CinemasService`,
`MoviesService` and `ShowsService` calls an organizer makes, as an actor with real organization
membership. Tenancy checks, scheduling conflict rules, seat-layout versioning and audit all
apply. That caught a real problem on its first run — the sandbox's showtimes were unschedulable
in an actual room, because a mock cinema has no notion of turning a screen round between films.

### Real providers

There is no code path that auto-materializes a real provider's catalogue, and this work did not
add one.

The operator surface is the existing ADR-040 admin API:

| Operation                             | Endpoint                                           |
| ------------------------------------- | -------------------------------------------------- |
| See what is waiting for a decision    | `GET /admin/inventory-sync/mappings`               |
| Link one record to an internal entity | `POST /admin/inventory-sync/mappings/:id/resolve`  |
| Inspect ingestion health              | `GET /admin/inventory-sync/providers/:code/health` |

`resolve` was already there. Two things were missing and have been added:

- **the queue itself** — there was no way to list what needed reviewing, which makes a review
  step that exists on paper and nowhere else;
- **verification** — `resolve` wrote whatever it was given. An `ACTIVE` mapping pointing at an
  id that does not exist is worse than no mapping: it looks approved and fails at the moment a
  customer is paying. The internal entity is now checked to exist, and its type checked against
  an allowlist, before the link is written.

There is deliberately no bulk-approve. Approving four hundred showtimes one at a time is
tedious; approving them in one click is how nobody looks at any of them.

---

## What may change automatically once approved

Approval binds an external record to an internal one. It does not hand the vendor a pen.

### Safe — applied automatically

Metadata about the synchronization itself, none of which is visible to a customer or affects a
sale:

- `externalVersion`, `lastProviderUpdatedAt`, `lastSyncedAt`, payload hash
- provider health and circuit state
- advisory availability (`ProviderInventoryState`) — imported for observability and
  reconciliation. It **never** overwrites locally-owned inventory: an availability import
  against a `LOCAL_AUTHORITATIVE` mapping is ignored and recorded as ignored.

### Controlled — applied automatically, within rules

Facts about an approved entity, subject to ownership mode and the platform's own validation:

- **showtime**, where the platform's scheduler accepts it. The sandbox materializer reschedules
  a mapped show in place and a refusal (a conflict with another film in the same room) is
  reported, never forced.
- screen and auditorium metadata
- film metadata — title, runtime, certificate

Two of these deserve their own note. **Prices are not on this list at all**: a provider's prices
are advisory metadata, and ETicketsGo prices its own sales through its own pricing, fee and tax
engine, including ceilings a remote POS knows nothing about. The materializer _requires_ an
explicit price per external seat category and refuses to fall back to the vendor's number. And
**seat identity** is fixed at import: the internal seat is paired with the external one once,
recorded in `ProviderMapping`, and from then on identity is the mapping — never the row and
number, which get renumbered.

### Never silent

These need explicit handling and, where they touch a sold ticket, a person:

- deleting or unpublishing a show that has bookings
- **absence from a feed.** A missing record is far more often a paging bug than a cancellation.
  The importer reports it as `absent_from_feed_not_treated_as_cancellation` and changes
  nothing. A real cancellation arrives as `CANCEL_SESSION`, which says so.
- changing a show in a way that invalidates issued tickets
- remapping a cinema, screen or show to a different internal entity
- changing a provider's inventory authority or ownership mode
- deleting a mapped cinema

ADR-040 already refuses to auto-cancel or auto-refund a confirmed local booking from an
imported provider status; that is recorded advisory-only and escalated. Nothing here weakens it.

---

## Identity

**External ids are the only identity.** Never a title, a start time, a row label or a position
in a list. Titles get re-spelled and shows get rescheduled, and a mapping keyed on either
silently creates a duplicate or attaches a booking to the wrong screening.

This is proved rather than asserted: a show moved from 19:30 to 20:00 at the provider, with its
id unchanged, updates the same internal session and creates no second one — and the whole
catalogue re-read produces byte-identical event ids, so a re-poll of an unchanged feed never
even becomes a raw event.

---

## Where the flags live

| Flag                                        | Default | Production          |
| ------------------------------------------- | ------- | ------------------- |
| `INVENTORY_SYNC_ENABLED`                    | off     | allowed             |
| `INVENTORY_SYNC_PROVIDER_ALLOWLIST`         | empty   | required if sync on |
| `INVENTORY_QUBE_MOCK_ENABLED`               | off     | **refused at boot** |
| `INVENTORY_SANDBOX_MATERIALIZATION_ENABLED` | off     | **refused at boot** |
| `BOOKING_PROVIDER_CONFIRMATION_ENABLED`     | off     | **refused at boot** |

The two sandbox refusals are new. The documents already said "never enable this in production";
until now nothing enforced it, which is the difference between a rule and a hope.
