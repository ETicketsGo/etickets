import { Module } from '@nestjs/common';
import { OutboxRecorder } from './outbox-recorder';
import { ProcessedEventStore } from './processed-event.store';
import { DomainEventBusDeliveryAdapter, OUTBOX_DELIVERY_ADAPTER } from './outbox-delivery.adapter';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { OutboxHealthService } from './outbox-health.service';
import { OutboxRetentionService } from './outbox-retention.service';
import { OutboxOpsService } from './outbox-ops.service';
import { OutboxOpsController } from './outbox-ops.controller';

/**
 * Transactional outbox platform (ADR-041). Depends only on @Global modules (Prisma,
 * Metrics, Audit, and the P2 DomainEventsModule's exported InProcessDomainEventBus) —
 * it does NOT import DomainEventsModule (it uses the global bus token), so DomainEvents
 * can import THIS module for the recorder without a cycle. Importing changes no
 * behaviour: recording is gated by DOMAIN_EVENT_DELIVERY_MODE and dispatch by
 * DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED (both default to the P2 in-process path).
 */
@Module({
  controllers: [OutboxOpsController],
  providers: [
    OutboxRecorder,
    ProcessedEventStore,
    DomainEventBusDeliveryAdapter,
    { provide: OUTBOX_DELIVERY_ADAPTER, useExisting: DomainEventBusDeliveryAdapter },
    OutboxDispatcher,
    OutboxHealthService,
    OutboxRetentionService,
    OutboxOpsService,
  ],
  exports: [
    OutboxRecorder,
    ProcessedEventStore,
    OutboxDispatcher,
    OutboxHealthService,
    OutboxRetentionService,
  ],
})
export class OutboxModule {}
