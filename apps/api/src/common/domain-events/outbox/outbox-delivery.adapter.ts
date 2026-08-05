import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../../metrics/metrics.service';
import { InProcessDomainEventBus } from '../in-process-domain-event-bus';
import type { DomainEvent } from '../domain-event';
import { ProcessedEventStore } from './processed-event.store';
import { OutboxDeliveryRetryableError } from './outbox.errors';

/** A durable delivery target for outbox events (ADR-041 §14). Broker adapters plug in later. */
export interface OutboxDeliveryAdapter {
  readonly name: string;
  deliver(event: DomainEvent): Promise<void>;
}

export const OUTBOX_DELIVERY_ADAPTER = Symbol('OUTBOX_DELIVERY_ADAPTER');

/**
 * The first durable adapter (ADR-041): delivers an outbox event to the in-process P2
 * DomainEventBus handlers, each guarded by durable per-handler idempotency.
 *
 * All required handlers must COMPLETE for the event to be considered delivered. A
 * handler that has already completed is skipped (idempotent replay); a failed / still-
 * in-progress handler makes deliver() throw retryable, so the dispatcher retries and
 * only the not-yet-completed handlers run again — completed side effects never repeat.
 */
@Injectable()
export class DomainEventBusDeliveryAdapter implements OutboxDeliveryAdapter {
  readonly name = 'in_process_bus';
  private readonly logger = new Logger('OutboxDelivery');

  constructor(
    private readonly bus: InProcessDomainEventBus,
    private readonly store: ProcessedEventStore,
    private readonly metrics: MetricsService,
  ) {}

  async deliver(event: DomainEvent): Promise<void> {
    const handlerNames = this.bus.handlersFor(event.eventType);
    if (handlerNames.length === 0) return; // no consumer ⇒ nothing to do (delivered)

    let pending = false;
    for (const name of handlerNames) {
      const claim = await this.store.claim(event.eventId, name);
      if (claim === 'ALREADY_COMPLETED') {
        this.metrics.recordOutboxHandlerReplay(event.eventType, name);
        continue; // side effect already ran once — never repeat it
      }
      if (claim === 'IN_PROGRESS') {
        pending = true; // another worker holds it; re-evaluate on the next attempt
        continue;
      }
      const res = await this.bus.executeHandler(event.eventType, name, event);
      if (res.ok) {
        await this.store.markCompleted(event.eventId, name);
      } else {
        await this.store.markFailed(event.eventId, name, res.errorMessage);
        pending = true;
        this.logger.warn(`handler '${name}' failed for '${event.eventType}' (${event.eventId})`);
      }
    }

    if (pending) {
      // Not all required handlers completed → retry (completed ones are skipped next time).
      throw new OutboxDeliveryRetryableError('one or more handlers not yet complete', {
        eventId: event.eventId,
      });
    }
  }
}
