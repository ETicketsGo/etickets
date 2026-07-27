# ADR-038: Domain Event Bus and Transaction-Aware Event Publication

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Principal Architect
- **Relates to:** ADR-009 (Experience Platform), ADR-010 (Inventory Strategy), ADR-037 (Inventory Sourcing Providers)
- **Scope:** P2 of the Enterprise Inventory Platform evolution — the domain event bus foundation only
- **Extended by:** [ADR-041](ADR-041-transactional-outbox.md) adds the durable transactional outbox (`DOMAIN_EVENT_DELIVERY_MODE=outbox`) that closes the post-commit crash window described below as a P2.1 limitation. The in-process path here remains the default.

## Context (repository findings)

Audited the modular monolith (~45 modules) before designing:

- **No event abstraction existed** — no `@nestjs/event-emitter`, no `EventBus`, no
  `DomainEvent`. Cross-context communication is direct method calls: `PaymentsService`
  calls `NotificationService`, `SettlementService`, `AuditService`, `MetricsService`
  inline. That coupling is what a bus will eventually relax (not in P2).
- **BullMQ** is present but narrow: a single `holds` queue (hold expiry) produced via
  `ops/holds-queue.provider.ts` and processed by `apps/worker`. The API registers no
  `BullModule`/EventEmitter.
- **Transactions**: Prisma interactive `$transaction(async (tx) => …)` in ~21
  services. **Prisma has no native after-commit hook.** The de-facto pattern (payments
  `confirm`) is: do all writes in the transaction, then run side effects after it
  resolves.
- **No outbox / no generic event retry infrastructure.**
- **Correlation**: `x-correlation-id` on `req.correlationId`
  (`CorrelationIdMiddleware`); no AsyncLocalStorage/CLS ambient context.
- **Observability**: a global `MetricsService` (prom-client) + Nest `Logger` +
  optional Sentry/OTel.

**Genuinely missing:** the entire domain event layer — contracts, an in-process bus,
transaction-aware publication, a typed catalogue, correlation/causation, versioning,
typed errors, and observability hooks.

## Decision

Introduce a provider-neutral domain event layer under
`apps/api/src/common/domain-events/`.

- **`DomainEvent<TPayload>`** — an immutable envelope describing a business FACT
  (`eventId`, `eventType`, `eventVersion`, `aggregateType/Id`, `occurredAt`,
  `correlationId?`, `causationId?`, `actorId?`, `tenantId?`, `payload`, `metadata?`).
- **`DomainEventBus`** (`publish`/`publishMany`/`subscribe`) behind a DI token
  `DOMAIN_EVENT_BUS`. Domain modules depend ONLY on this interface.
- **`InProcessDomainEventBus`** — the initial synchronous, in-process implementation.
- **`TransactionalEventPublisher`** — the transaction-aware publication mechanism.
- **`DomainEventFactory`** — stamps `eventId`/`occurredAt`, defaults version, and
  validates the envelope; `createCausedBy` propagates correlation/causation.
- **Typed catalogue** — `booking.confirmed/cancelled/expired`,
  `inventory.locked/released`, `refund.processed`, `ticket.checked_in`, plus a
  reserved name+version registry for the full lifecycle.

### Why not expose BullMQ directly to domain modules

BullMQ is a transport. Coupling `BookingConfirmed` to a BullMQ queue would (a) leak
Redis/queue types into domain code, (b) make handlers un-unit-testable without Redis,
and (c) lock us to one transport. Domains publish transport-neutral facts; a future
durable transport (BullMQ-backed, then Kafka/SNS/EventBridge) implements the SAME
`DomainEventBus` behind the SAME token, so producers/consumers never change. We did
**not** add a second queue framework.

### Why synchronous in-process delivery first

It is correct, debuggable, and adds no infrastructure. It is sufficient for the P2
goal (a clean seam + a proof slice). A durable/async transport is a drop-in adapter
later. This is a foundation, not the final transport.

### Transaction boundary behaviour

```
begin tx → mutate + collect events → COMMIT → publish
```

Because Prisma has no after-commit hook, ordering is explicit:

- `TransactionalEventPublisher.runWithEvents(work)` runs `work` inside
  `$transaction`, collecting events into a `DomainEventCollector`, and publishes them
  **only after the transaction commits**. If `work` throws, the transaction rolls
  back and the collected events are **discarded** — a fact describing an uncommitted
  change is never published.
- `publishAfterCommit(events)` serves the existing manual pattern (write in a tx,
  then publish once resolved) — used by the proof slice.

### Failure semantics

- **Handler isolation**: handlers for an event type run **sequentially in
  registration order** (deterministic, not maximally concurrent). Each handler is
  wrapped with a timeout and try/catch; a throw or timeout is logged + counted and the
  remaining handlers still run. `publish` never rejects on a handler fault.
- **Malformed event** (producer bug): `publish` rejects with `InvalidDomainEventError`
  — not swallowed.
- **Post-commit publication failure**: the commit STANDS. The failure is logged and
  observable and the event is eligible for future retry/reconciliation via a durable
  outbox (P2.1). We never pretend the transaction rolled back.
- **No-handler events** succeed (counted `no_handler`), they are not errors.
- Typed errors: `InvalidDomainEventError`, `UnsupportedEventVersionError`,
  `DuplicateSubscriptionError`, `DomainEventHandlerError`,
  `DomainEventPublicationError`, `TransactionDispatchError`.

### Idempotency expectations

Every event has a stable `eventId`. Delivery is **at-least-once**. A handler with an
external, non-idempotent side effect MUST deduplicate by `eventId + handlerName` (the
`idempotencyKey` helper + `ProcessedEventStore` seam). A durable cross-process store
is deferred to P2.1 (the outbox); an in-memory store ships for single-process
handlers/tests.

### Event versioning rules

Each event carries `eventVersion` (starts at 1). Do not mutate a published version's
schema. Add backward-compatible OPTIONAL fields without bumping; introduce a new
version for breaking changes. Consumers may declare `supportedVersions`; an event
whose version is not supported is **skipped visibly** (warn + `skipped` metric), never
silently dropped.

### Correlation and causation

Events carry `correlationId` (one workflow/trace) and `causationId` (the parent
event's id). `DomainEventFactory.createCausedBy(parent, …)` preserves the parent's
`correlationId` (or seeds it from the parent's `eventId`) and sets
`causationId = parent.eventId`. Ambient propagation from the HTTP request context via
AsyncLocalStorage is a documented future improvement (today correlation is threaded
explicitly).

### Security / PII rules

Payloads carry identifiers and facts only — never buyer name/email, payment card
data, secrets, or raw provider payloads. Amounts are minor-unit strings. Handler
logging records event type/id/aggregate/handler/duration/result only.

### Observability

`MetricsService` gains `etg_domain_events_published_total{event_type,result}` and
`etg_domain_event_handler_duration_seconds{event_type,handler,result}`. The bus logs
subscription, no-handler, version-skip, and handler-failure events (identifiers only).

### Feature flag

`DOMAIN_EVENTS_ENABLED` (default **off**). The bus + handlers are wired via DI, but
`publish()` is a no-op (recorded `disabled`) until enabled — so core booking
correctness is independent of the flag. `DOMAIN_EVENT_HANDLER_TIMEOUT_MS` (default 5000) bounds per-handler execution.

## Proof vertical slice

`PaymentsService.confirm` publishes a `BookingConfirmedEvent` in its existing
post-commit region, guarded by the `alreadyConfirmed` exactly-once check (so it fires
once per real confirmation), fully isolated (a domain-event fault can never affect
confirmation). `BookingEventRecorder` subscribes to `booking.confirmed` and records
the fact (PII-free). No booking behaviour changed.

## Consequences

**Positive** — domain modules can publish typed facts with no transport dependency;
transaction-safe publication with rollback discard; isolated, observable handlers;
enforced versioning; correlation/causation; a clean seam for a durable outbox and an
external broker.

**Negative / limitations** — in-process delivery is not durable: a process crash
between commit and handler completion loses in-flight handler work (the commit stands).
This is the exact gap the P2.1 transactional outbox closes. Correlation is not yet
ambiently propagated. No existing direct service calls were migrated (deliberate).

## Deferred (future slices)

Durable transactional **outbox** (P2.1); BullMQ-backed async delivery adapter; Kafka/
SNS/EventBridge adapter; AsyncLocalStorage correlation propagation; migrating direct
notification/analytics/settlement calls to subscribers; Redis seat locking, external
inventory sync, and resolver wiring into `BookingsService` (P3+, out of scope here).

## Compliance / verification

- Unit tests: factory (id/version/validation, correlation+causation), bus (single/
  multiple/sequential, isolation, no-handler, duplicate subscription, flag-off,
  version gate, timeout, malformed reject, publishMany order).
- Transaction tests: publish only after commit, discard on rollback, deterministic
  ordering, post-commit failure does not roll back.
- Integration: Nest DI boot resolves the bus + publisher and dispatches to the proof
  handler; flag-off suppresses it.
- Regression: full API suite green; the proof slice asserts publish-exactly-once and
  no publish on re-delivery. `tsc` clean; prettier clean.
