import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { DomainEvent } from './domain-event';
import { DOMAIN_EVENT_BUS, type DomainEventBus } from './domain-event-bus';
import { TransactionDispatchError } from './domain-event.errors';
import { OutboxRecorder } from './outbox/outbox-recorder';

export type DomainEventDeliveryMode = 'in_process' | 'outbox' | 'dual_write_shadow';

/**
 * A transaction-scoped buffer of domain events. Mutations collect facts into it during
 * a transaction; the publisher flushes them only AFTER the transaction commits. If the
 * transaction rolls back the collector is discarded, so no event describing a
 * non-committed change is ever published. See ADR-038.
 */
export class DomainEventCollector {
  private readonly events: DomainEvent[] = [];

  collect(event: DomainEvent): void {
    this.events.push(event);
  }

  collectMany(events: DomainEvent[]): void {
    this.events.push(...events);
  }

  /** Drain the buffer (returns the collected events and clears it). */
  take(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  get size(): number {
    return this.events.length;
  }
}

/**
 * Transaction-aware publication (ADR-038). Because Prisma has no native after-commit
 * hook, this makes the ordering explicit:
 *
 *   begin tx → mutate + collect events → COMMIT → publish
 *
 * `runWithEvents` runs the work inside a Prisma transaction and publishes the
 * collected events only once it commits; a thrown work function rolls the transaction
 * back and the events are discarded. `publishAfterCommit` is for the existing manual
 * pattern (write in a tx, then publish once it has resolved).
 *
 * Post-commit publication failure NEVER rolls the commit back: the data stays
 * committed and the failure is logged + observable and eligible for a future durable
 * outbox retry (P2.1) — we never pretend the transaction failed.
 */
@Injectable()
export class TransactionalEventPublisher {
  private readonly logger = new Logger('DomainEventPublisher');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOMAIN_EVENT_BUS) private readonly bus: DomainEventBus,
    private readonly config: ConfigService,
    private readonly recorder: OutboxRecorder,
  ) {}

  /** Active delivery mode (ADR-041). Defaults to in_process (P2 behaviour). */
  get mode(): DomainEventDeliveryMode {
    return this.config.get<DomainEventDeliveryMode>('DOMAIN_EVENT_DELIVERY_MODE', 'in_process');
  }

  async runWithEvents<T>(
    work: (tx: Prisma.TransactionClient, collector: DomainEventCollector) => Promise<T>,
  ): Promise<T> {
    const collector = new DomainEventCollector();
    let events: DomainEvent[] = [];
    // If `work` (or the outbox insert) throws, $transaction rolls back — neither the
    // business mutation nor the outbox rows survive.
    const result = await this.prisma.$transaction(async (tx) => {
      const r = await work(tx, collector);
      events = collector.take();
      if (this.mode !== 'in_process') {
        await this.recorder.recordMany(tx, events, this.mode === 'dual_write_shadow');
      }
      return r;
    });
    await this.deliverAfterCommit(events);
    return result;
  }

  /**
   * Record durable outbox rows inside the CALLER's transaction (ADR-041). Atomic with
   * the business mutation; a serialization failure rolls the whole thing back. No-op in
   * `in_process` mode. Use this + {@link deliverAfterCommit} for hand-rolled tx paths.
   */
  async recordInTransaction(tx: Prisma.TransactionClient, events: DomainEvent[]): Promise<number> {
    if (this.mode === 'in_process') return 0;
    return this.recorder.recordMany(tx, events, this.mode === 'dual_write_shadow');
  }

  /**
   * Deliver events after commit according to mode: `in_process`/`dual_write_shadow`
   * publish directly (best-effort, as P2 did); `outbox` is a no-op (the dispatcher
   * delivers the durable rows) so there is exactly one production delivery path.
   */
  async deliverAfterCommit(events: DomainEvent[]): Promise<void> {
    if (this.mode === 'outbox') return;
    await this.dispatch(events);
  }

  /** Publish events for an ALREADY-committed change. Never throws (commit stands). */
  async publishAfterCommit(events: DomainEvent[]): Promise<void> {
    await this.dispatch(events);
  }

  private async dispatch(events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.bus.publishMany(events);
    } catch (err) {
      // The commit has already happened. Log + surface; do not rethrow. A durable
      // outbox (P2.1) will make these events recoverable.
      const wrapped = new TransactionDispatchError(
        `post-commit publication failed for ${events.length} event(s)`,
        { eventIds: events.map((e) => e.eventId), cause: (err as Error)?.message },
      );
      this.logger.error(wrapped.message);
    }
  }
}
