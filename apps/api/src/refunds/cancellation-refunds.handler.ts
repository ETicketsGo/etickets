import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from '../common/domain-events/domain-event';
import type { DomainEventHandler } from '../common/domain-events/domain-event-handler';
import { isOurShowCancellation } from '../common/domain-events/catalogue/show-events';
import { CancellationRefundsService } from './cancellation-refunds.service';

/**
 * Starts the refund obligation the moment a show is cancelled.
 *
 * ── WHY THE HANDLER DOES SO LITTLE ─────────────────────────────────────────────────
 * The same reasoning as the cancellation NOTIFICATION handler it sits beside: it opens one
 * bounded batch and returns. A handler runs under a timeout, and a cancelled multiplex screen
 * is hundreds of bookings. Doing the whole set here would mean either raising that timeout for
 * everybody, or being abandoned halfway through, counted as a failure and retried from the top.
 *
 * It does not need to finish, because finishing is not its job. `CancellationRefundsService.
 * sweep()` asks the data which paid bookings on a cancelled show still have no refund, so this
 * handler is an optimisation - it gets the first buyers into the queue within seconds instead
 * of within the sweep interval - and the sweep is the guarantee.
 *
 * ── WHY IT DISCRIMINATES ON THE AGGREGATE ──────────────────────────────────────────
 * `session.cancelled` carries two different facts: a vendor feed saying one of THEIR sessions
 * is off (`ProviderSession`), and one of our own shows cancelled in our own console
 * (`EventSession`). Only the second has customers who paid US, and only they are owed money by
 * us. Opening refunds against a vendor's cancellation would refund bookings we never took.
 */
@Injectable()
export class CancellationRefundsHandler implements DomainEventHandler {
  readonly handlerName = 'refunds.show-cancelled';
  readonly supportedVersions = [1] as const;

  private readonly logger = new Logger('Refunds');

  constructor(private readonly cancellations: CancellationRefundsService) {}

  async handle(event: DomainEvent): Promise<void> {
    if (!isOurShowCancellation(event)) {
      // A vendor feed cancellation. Real, and nobody paid us for it.
      return;
    }

    const result = await this.cancellations.openFor(event.aggregateId);
    this.logger.warn(
      `show ${event.aggregateId} cancelled: opened ${result.opened} refund(s), ` +
        `${result.skipped} skipped, ${result.failed} failed, ${result.remaining} to follow on the sweep`,
    );
  }
}
