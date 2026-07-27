import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { MetricsService } from '../../../metrics/metrics.service';
import type { DomainEvent } from '../domain-event';
import { serializeEvent } from './outbox-serialization';

/**
 * Inserts durable outbox rows using the CALLER's transaction client (ADR-041), so the
 * rows commit atomically with the business mutation. A serialization/size failure throws
 * out of the transaction and rolls the whole thing back (required-event semantics). A
 * duplicate eventId is skipped (idempotent) — a re-run of the same business request
 * records no second event. Domain services never see Prisma model details; they call
 * the publisher, which calls this recorder.
 */
@Injectable()
export class OutboxRecorder {
  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async recordMany(
    tx: Prisma.TransactionClient,
    events: DomainEvent[],
    shadow: boolean,
  ): Promise<number> {
    if (events.length === 0) return 0;
    const maxBytes = this.config.get<number>('DOMAIN_EVENT_OUTBOX_MAX_PAYLOAD_BYTES', 262144);
    const maxAttempts = this.config.get<number>('DOMAIN_EVENT_OUTBOX_MAX_ATTEMPTS', 12);

    const rows = events.map((event) => {
      const s = serializeEvent(event, maxBytes); // throws → rolls back the business tx
      return {
        eventId: s.eventId,
        eventType: s.eventType,
        eventVersion: s.eventVersion,
        aggregateType: s.aggregateType,
        aggregateId: s.aggregateId,
        occurredAt: s.occurredAt,
        correlationId: s.correlationId,
        causationId: s.causationId,
        actorId: s.actorId,
        tenantId: s.tenantId,
        payloadJson: s.payloadJson as Prisma.InputJsonValue,
        metadataJson: (s.metadataJson ?? undefined) as Prisma.InputJsonValue | undefined,
        payloadHash: s.payloadHash,
        maxAttempts,
        shadow,
      };
    });

    const res = await tx.outboxEvent.createMany({ data: rows, skipDuplicates: true });
    this.metrics.recordOutboxCreated(res.count);
    if (res.count < rows.length) {
      this.metrics.recordOutboxDuplicateInsert(rows.length - res.count);
    }
    return res.count;
  }
}
