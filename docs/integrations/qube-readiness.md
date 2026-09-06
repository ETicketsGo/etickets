# Qube integration readiness

What we need from Qube Cinema before a real integration can be built, and what exists today.

---

## Where we actually are

**We have no Qube API documentation, no credentials, no sandbox, and no confirmation of what
ticketing APIs Qube exposes.** Nothing in this repository is derived from Qube's real systems.
Nothing was scraped, reverse-engineered, or inferred from a Justickets endpoint.

What exists:

- `QubeMockInventoryProvider` — a sandbox cinema **invented in full**, to exercise our
  architecture. Its identifiers, seat states, hold semantics and errors are made up. Expect
  essentially all of it to be wrong in detail once real documentation arrives.
- `QubeInventoryProvider` — an empty placeholder. Every operation refuses with
  `QUBE_PROVIDER_NOT_CONFIGURED`; `health()` reports unhealthy so it stays out of every
  candidate set rather than taking the registry down.

- `QubeMockInventorySyncProvider` — the same invented cinema as a CATALOGUE FEED, so the
  ADR-040 sync platform has something to ingest.
- `QubeMockExternalBookingProvider` — the same invented cinema as a BOOKING LIFECYCLE, so the
  ADR-042 orchestrator has something to reserve and confirm against.

Three adapters, one sandbox, one switch (`INVENTORY_QUBE_MOCK_ENABLED`). They delegate to a
single in-memory cinema rather than each holding a copy: two stores describing one venue agree
only by luck, and the first divergence is a double sale no test can reproduce.

The architecture has been proven against the sandbox, end to end — catalogue sync, operator
approval, seat map, reservation, payment, confirmation, QR — through the running application
against a real PostgreSQL and Redis. The integration has not been started, because starting it
would mean inventing an API.

---

## Questions for Qube

Grouped by what each answer would let us build. The starred ones are **blocking** — we cannot
design the integration correctly without them.

### Connectivity

- Sandbox base URL, and production base URL
- Authentication scheme — API key, OAuth client credentials, mTLS, something else
- Is IP allowlisting required? From which egress addresses?
- Client certificates, if any
- Rate limits: per second, per minute, per endpoint, and what a breach returns
- API versioning, and how breaking changes are announced

### Cinema catalogue

- Stable identifiers for cinema, screen, movie and show — and a guarantee they are stable
  (★ if showtime ids are regenerated daily, every sync creates duplicates)
- Are showtimes returned in the cinema's local time, in UTC, or with an explicit offset? (★)
- What happens when a show is rescheduled or cancelled — new id, or same id with new fields?
- How are deleted shows communicated? Absence from a list, or an explicit tombstone?
- Is there a "last modified" or version field we can order by?

### Seating

- Seat layout endpoint, and whether the layout is per-show or per-screen (★ — the sandbox
  models seats as belonging to the ROOM, with availability per showing. If Qube issues seat ids
  per SHOW instead, seat mapping grows by one row per show per seat and the import strategy
  changes; the seam absorbs it either way, but the answer decides the shape.)
- Stable per-seat identifiers (★ — we must never key on row/number, which get renumbered)
- How are seat categories/areas expressed, and do they carry price?
- How are unavailable, blocked and house seats distinguished from sold ones?
- Are accessible/wheelchair positions represented? How?
- Are aisles and gaps represented as positions, or simply absent from the layout?

### Inventory and holds

- **Do seat holds exist at all?** (★ — if not, the entire checkout flow needs redesigning
  around at-risk booking)
- Hold TTL, and whether it is fixed or requested by us
- Can a hold be extended? Released early?
- Is `hold` idempotent, and on what key? (★)
- What is returned when a seat is taken between our read and our hold?
- Is availability a full seat map, a count, or both?

### Booking

- Confirmation endpoint, and the identifier it returns
- **Is confirmation idempotent, and on what key?** (★)
- **Does a reservation reference identify the booking for every later call** — confirm, cancel,
  status — or does each call need its own correlation id? (★ — our orchestrator gives every call
  a DIFFERENT idempotency key, so a provider that identifies a booking by "the key you sent"
  rather than by the reservation reference cannot be driven safely. Getting this backwards in
  the sandbox made confirmation return NOT_FOUND for a reservation that had succeeded.)
- **Can a booking be looked up after an ambiguous timeout?** (★★ — this is the single
  capability that decides whether our reconciliation can be _correct_ rather than merely
  careful. Without it, a timed-out confirmation can only be resolved by guessing, and
  guessing produces either a double booking or a refund for a booking that exists.)
- **Who owns the barcode?** Does Qube issue the scannable ticket, or do we? (★ — if theirs,
  our QR must not be presented at their gate; we already handle vendor barcodes this way)
- Are partial bookings possible, or is it all-or-nothing?

### Cancellation and refund

- Cancellation endpoint and its window — how late can a booking be cancelled?
- Are partial cancellations supported? Partial refunds?
- Does Qube charge a cancellation fee, and who bears it?
- Does cancelling at Qube return the seats to their inventory immediately?

### Events

- Are there webhooks? For show changes, seat changes, booking changes, cancellations?
- If not, what polling frequency is acceptable given the rate limits?
- Is there a signature scheme for webhook authenticity?

### Commercial

- Does ETicketsGo contract with **Qube**, or with **each exhibitor**? (★ — determines whose
  authorisation we need per cinema)
- Per-cinema authorisation: how is it granted and revoked?
- API access fees, transaction fees
- Who settles with the exhibitor — Qube, or us?
- Is there a certification process before production access?

---

## What we would keep

If Qube's answers differ wildly from the sandbox — and they will — this is what survives:

- The `InventoryProvider` contract and everything built on it: registry, resolver, health
  monitor, priority manager, failover rules
- `ProviderMapping` for identity
- The sync subsystem: ingestion, checkpoints, failure classification, polling, circuit breaker
- The compensation and reconciliation flows
- Our pricing, fee and tax engine — including the Indian regulatory ceilings, which no vendor
  knows about
- The contract test suite: a real `QubeProvider` is pointed at it and either passes or is not
  finished

## What we would replace

- `qube-mock.fixture.ts` — entirely
- The transport in `qube-mock.provider.ts` — HTTP calls in place of in-memory state
- The mapping between Qube's vocabulary and ours

That is the test of whether this exercise was worth doing: if the work is transport and
mapping, the seam held.

---

## Known risks to raise early

**No hold API.** If Qube has no concept of a seat hold, the checkout model changes
fundamentally — payment before reservation, with a real chance of taking money for a seat that
is gone. Worth asking first.

**No booking lookup.** Without it, an ambiguous timeout is unresolvable. We would have to
choose a default (refund, or confirm) and accept being wrong some of the time. That is a
commercial decision, not an engineering one, and it should be made deliberately rather than
discovered.

**Barcode ownership.** If Qube issues the ticket, our check-in flow presents their barcode and
our scanner does not admit — already handled, but it changes what the customer sees and who
resolves a dispute at the door.

**Clock and timezone.** If showtimes arrive without an explicit zone, every schedule we display
is a guess. India has one zone, which hides the bug until the day it does not.

**A timetable we cannot run.** An exhibitor's schedule is not automatically valid in our model:
our scheduler enforces a turnaround between films in the same room, and the sandbox's first
timetable violated it — a 2h32 film at 16:30 ending thirteen minutes before the 19:30 show. On
a real feed this will happen for reasons we do not control. The importer reports each refusal
rather than forcing it, and somebody has to decide what a rejected showtime means commercially.

**Who is the operator.** Every imported entity is created by an actor with organization
membership, and every real-provider mapping needs a person to approve it. Which organization an
imported cinema belongs to, and who approves its catalogue, is a commercial question we have
not answered — see `catalogue-governance.md`.
