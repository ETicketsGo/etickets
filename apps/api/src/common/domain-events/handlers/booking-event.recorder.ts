import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventHandler } from '../domain-event-handler';
import type { BookingConfirmedEvent } from '../catalogue/booking-events';

/**
 * The P2 proof-slice handler: a lightweight, side-effect-free observer that records
 * that a `booking.confirmed` fact was received. It proves the end-to-end path
 * (publish after commit → bus → typed handler) without changing any booking
 * behaviour. It logs identifiers/counts only — never buyer PII or payment data.
 *
 * It accepts only version 1 (demonstrating the version gate). Real reactive
 * behaviour (notifications/analytics/settlement migration) is deferred to later
 * slices — this handler intentionally does nothing but observe.
 */
@Injectable()
export class BookingEventRecorder implements DomainEventHandler<BookingConfirmedEvent> {
  readonly handlerName = 'domain-events.booking-recorder';
  readonly supportedVersions = [1] as const;

  private readonly logger = new Logger('DomainEventRecorder');

  async handle(event: BookingConfirmedEvent): Promise<void> {
    this.logger.log(
      `observed ${event.eventType} v${event.eventVersion} ` +
        `event=${event.eventId} booking=${event.aggregateId} ` +
        `tickets=${event.payload.ticketCount} currency=${event.payload.currency}`,
    );
  }
}
