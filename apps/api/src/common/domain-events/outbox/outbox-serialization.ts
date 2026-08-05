import { createHash } from 'node:crypto';
import type { DomainEvent } from '../domain-event';
import { assertValidDomainEvent } from '../domain-event.factory';
import { DomainEventVersion } from '../catalogue/event-types';
import {
  OutboxPayloadTooLargeError,
  OutboxSerializationError,
  OutboxUnsupportedVersionError,
} from './outbox.errors';

/** The durable columns an outbox row carries (preserves the P2 DomainEvent envelope). */
export interface OutboxRowData {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
  correlationId: string | null;
  causationId: string | null;
  actorId: string | null;
  tenantId: string | null;
  payloadJson: unknown;
  metadataJson: unknown;
  payloadHash: string;
}

/** The shape read back from the DB row (Prisma-parsed JSON). */
export interface OutboxRowRead {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
  correlationId?: string | null;
  causationId?: string | null;
  actorId?: string | null;
  tenantId?: string | null;
  payloadJson: unknown;
  metadataJson?: unknown;
}

/**
 * Deterministic serialization of a P2 DomainEvent into durable columns (ADR-041).
 * Validates the envelope, enforces the payload byte limit, rejects non-serializable
 * values, and computes a tamper-evident payload hash. Minor-unit monetary STRINGS are
 * preserved exactly (JSON round-trips strings verbatim). Throws on any violation so a
 * required event that cannot be recorded rolls back the business transaction.
 */
export function serializeEvent(event: DomainEvent, maxPayloadBytes: number): OutboxRowData {
  assertValidDomainEvent(event);

  let payloadJson: unknown;
  let metadataJson: unknown;
  let serialized: string;
  try {
    // JSON round-trip rejects functions/symbols/BigInt/circular refs deterministically.
    serialized = JSON.stringify(event.payload);
    if (serialized === undefined) throw new Error('payload is not serializable');
    payloadJson = JSON.parse(serialized);
    metadataJson = event.metadata === undefined ? null : JSON.parse(JSON.stringify(event.metadata));
  } catch (err) {
    throw new OutboxSerializationError(`event ${event.eventId} payload is not serializable`, {
      cause: (err as Error)?.message,
    });
  }

  if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
    throw new OutboxPayloadTooLargeError(
      `event ${event.eventId} payload exceeds ${maxPayloadBytes} bytes`,
    );
  }

  return {
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    actorId: event.actorId ?? null,
    tenantId: event.tenantId ?? null,
    payloadJson,
    metadataJson,
    payloadHash: createHash('sha256').update(serialized).digest('hex'),
  };
}

/**
 * Deserialize + VALIDATE a durable row back into a DomainEvent (ADR-041). Rejects a
 * version newer than the registered catalogue version for a known event type
 * (unsupported version → manual review), and re-asserts the envelope invariants.
 */
export function deserializeEvent(row: OutboxRowRead): DomainEvent {
  const known = DomainEventVersion[row.eventType as keyof typeof DomainEventVersion];
  if (known !== undefined && row.eventVersion > known) {
    throw new OutboxUnsupportedVersionError(
      `event type ${row.eventType} v${row.eventVersion} > supported v${known}`,
    );
  }
  const event: DomainEvent = {
    eventId: row.eventId,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt),
    correlationId: row.correlationId ?? undefined,
    causationId: row.causationId ?? undefined,
    actorId: row.actorId ?? undefined,
    tenantId: row.tenantId ?? undefined,
    payload: row.payloadJson,
    metadata: (row.metadataJson as Record<string, unknown> | null) ?? undefined,
  };
  assertValidDomainEvent(event);
  return event;
}
