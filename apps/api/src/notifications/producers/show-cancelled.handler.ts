import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from '../../common/domain-events/domain-event';
import type { DomainEventHandler } from '../../common/domain-events/domain-event-handler';
import { isOurShowCancellation } from '../../common/domain-events/catalogue/show-events';
import { ShowCancellationFanoutService } from './show-cancellation-fanout.service';

/**
 * Reacts to a show being cancelled by starting the fan-out.
 *
 * ── WHY THE HANDLER DOES SO LITTLE ─────────────────────────────────────────────────
 * It kicks off one bounded batch and returns. The audience for a cancelled multiplex screen
 * is hundreds of people and for a festival headliner thousands, and a handler runs under a
 * timeout — five seconds by default. Doing the whole fan-out here would mean either raising
 * that timeout for everybody or having the handler abandoned halfway through, counted as a
 * failure, and retried from the top.
 *
 * It does not need to finish, because finishing is not its job. The sweep asks the data who
 * still needs telling, so this handler is an optimisation — it makes the first customers hear
 * within seconds instead of within a minute — and the sweep is the guarantee.
 *
 * ── WHY IT DISCRIMINATES ON THE AGGREGATE ──────────────────────────────────────────
 * `session.cancelled` carries two different facts: a vendor's feed saying one of THEIR
 * sessions is off (`ProviderSession`), and one of our own shows being cancelled in our own
 * console (`EventSession`). Only the second has customers who paid us.
 */
@Injectable()
export class ShowCancelledNotificationHandler implements DomainEventHandler {
  readonly handlerName = 'notifications.show-cancelled';
  readonly supportedVersions = [1] as const;

  private readonly logger = new Logger('Notification');

  constructor(private readonly fanout: ShowCancellationFanoutService) {}

  async handle(event: DomainEvent): Promise<void> {
    if (!isOurShowCancellation(event)) {
      // A vendor feed cancellation. Real, and not ours to notify anybody about.
      return;
    }

    const result = await this.fanout.fanOut(event.aggregateId);
    this.logger.warn(
      `show ${event.aggregateId} cancelled: told ${result.notified} ticket holder(s), ` +
        `${result.remaining} to follow on the sweep`,
    );
  }
}
