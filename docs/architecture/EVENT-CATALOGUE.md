# ETicketsGo Domain Event Catalogue

Companion to [ADR-038](../adr/ADR-038-domain-event-bus.md). Every event is an
immutable business FACT on the provider-neutral `DomainEventBus`. Payloads carry
**identifiers and facts only** — never buyer name/email, payment card data, secrets,
or raw provider payloads. Amounts are minor-unit strings.

**Delivery today:** synchronous, in-process, at-least-once, sequential per event type.
Gated by `DOMAIN_EVENTS_ENABLED` (off ⇒ `publish()` is a no-op). Durable async delivery
is a future adapter (ADR-038, deferred).

**Versioning:** version starts at 1; additive optional fields do not bump it; breaking
changes introduce a new version. Consumers may declare `supportedVersions`; unknown
versions are skipped visibly.

## Typed events (implemented in P2)

| Event             | Type name            | Ver | Producer                      | Expected consumers                                     | Payload (fact) fields                                                                | PII                    | Delivery      |
| ----------------- | -------------------- | --- | ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------- | ------------- |
| BookingConfirmed  | `booking.confirmed`  | 1   | PaymentsService (post-commit) | Notifications, Analytics, Settlement, Recorder (proof) | bookingId, userId, experienceId, showId?, amount, currency, ticketCount, confirmedAt | None (ids/counts only) | at-least-once |
| BookingCancelled  | `booking.cancelled`  | 1   | Bookings/Refunds (future)     | Notifications, Analytics, Inventory                    | bookingId, userId, experienceId, reason?, cancelledAt                                | None                   | at-least-once |
| BookingExpired    | `booking.expired`    | 1   | Holds worker (future)         | Inventory, Analytics                                   | bookingId, experienceId, expiredAt                                                   | None                   | at-least-once |
| InventoryLocked   | `inventory.locked`   | 1   | Inventory sourcing (future)   | Analytics, Sync                                        | bookingId, eventSessionId, provider, lines[], holdExpiresAt                          | None                   | at-least-once |
| InventoryReleased | `inventory.released` | 1   | Inventory sourcing (future)   | Analytics, Sync                                        | bookingId, eventSessionId, provider, lines[], reason, releasedAt                     | None                   | at-least-once |
| RefundProcessed   | `refund.processed`   | 1   | RefundsService (future)       | Notifications, Settlement, Analytics                   | refundId, bookingId, amount, currency, full, processedAt                             | None                   | at-least-once |
| TicketCheckedIn   | `ticket.checked_in`  | 1   | CheckinsService (future)      | Analytics, Occupancy                                   | ticketId, bookingId, eventSessionId, gateId?, deviceId?, checkedInAt                 | None                   | at-least-once |

> "Future" producers/consumers are the intended wiring; P2 wires only the
> BookingConfirmed → Recorder proof slice. The rest publish/subscribe in later slices
> without changing the bus.

## Reserved names (payloads land in later slices)

`booking.payment_pending`, `refund.requested`, `ticket.generated`,
`settlement.completed`, `notification.requested`, `provider.health_changed`,
`inventory.sync_requested`, `inventory.sync_completed`, `inventory.sync_failed` — all
version 1 in the registry (`catalogue/event-types.ts`), reserved so producers and
consumers share one vocabulary.

## Correlation & causation

A workflow shares one `correlationId`; each event records its parent via
`causationId`. Example chain:

```
HTTP request correlationId
  → booking.payment_pending (causationId = —)
  → booking.confirmed       (causationId = payment_pending.eventId, same correlationId)
```

Use `DomainEventFactory.createCausedBy(parent, …)` to derive a child that preserves
correlation and sets causation.

## Idempotency

At-least-once ⇒ handlers with external side effects must dedupe by
`eventId + handlerName` (`idempotencyKey()` + `ProcessedEventStore`). A durable store
arrives with the P2.1 outbox.
