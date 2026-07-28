/**
 * A domain event: an immutable record of a business FACT that has already happened
 * (e.g. a booking was confirmed), not a command to make something happen. Producers
 * publish facts; consumers react. See ADR-038.
 *
 * The envelope is transport-neutral — it carries no BullMQ/Kafka/EventEmitter types —
 * so domain modules depend only on this shape and the {@link DomainEventBus}, never on
 * a specific transport. A future durable transport serializes/deserializes THIS shape.
 */
export interface DomainEvent<TPayload = unknown> {
  /** Globally-unique, stable id for exactly this occurrence. Idempotency key root. */
  readonly eventId: string;
  /** Dotted, versionable fact name, e.g. `booking.confirmed`. */
  readonly eventType: string;
  /** Schema version of `payload` for this `eventType` (starts at 1). See ADR-038. */
  readonly eventVersion: number;
  /** The aggregate the fact is about, e.g. `Booking`. */
  readonly aggregateType: string;
  /** The aggregate instance id, e.g. the booking id. */
  readonly aggregateId: string;
  /** When the fact occurred (set once, at creation). */
  readonly occurredAt: Date;
  /** Correlates every event in one end-to-end workflow/trace. */
  readonly correlationId?: string;
  /** The eventId of the event that directly caused this one (parent → child). */
  readonly causationId?: string;
  /** Who/what triggered the originating action (user id or system actor). */
  readonly actorId?: string;
  /** Tenant/organization scope, when applicable. */
  readonly tenantId?: string;
  /** The fact's data — identifiers and facts only, never entities/secrets/PII. */
  readonly payload: TPayload;
  /** Non-sensitive envelope extras (never customer/payment/credential data). */
  readonly metadata?: Record<string, unknown>;
}

/** Fields a producer supplies; the factory stamps eventId/occurredAt and defaults. */
export type NewDomainEvent<TPayload> = Omit<
  DomainEvent<TPayload>,
  'eventId' | 'occurredAt' | 'eventVersion'
> & {
  /** Optional override; the catalogue helper supplies the correct version per type. */
  eventVersion?: number;
  /** Optional override for tests; production always uses the generated id. */
  eventId?: string;
  occurredAt?: Date;
};
