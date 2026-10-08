import { Injectable, Logger } from '@nestjs/common';
import { BookingStatus, SessionStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RefundsService } from './refunds.service';

/**
 * Every paid booking on a cancelled show gets a refund opened for it. Without exception.
 *
 * ── THE BEHAVIOUR THIS REPLACES ────────────────────────────────────────────────────
 * `cancelShow` returned a `bookingsRequiringRefund` list and did nothing with it. The list
 * was correct and nothing consumed it, so whether a paying customer got their money back
 * depended on a human reading an API response and remembering to act. Nothing recorded that
 * the obligation existed, nothing chased it, and nothing would ever have noticed it being
 * missed. A buyer whose show was cancelled could wait indefinitely and no screen anywhere
 * would have shown them as owed.
 *
 * ── WHY A BATCH AND A SWEEP, RATHER THAN A LOOP IN THE CANCELLATION ────────────────
 * Same shape as the cancellation notification fan-out next door, and for the same reasons.
 * A cancelled multiplex screen is hundreds of bookings and a festival headliner thousands.
 * Doing them inside the cancelling request would make the organizer wait on it, and one
 * failure would roll back - or worse, appear to roll back - a cancellation that has already
 * been announced.
 *
 * So the handler opens a bounded batch quickly, and **the sweep is the guarantee**. The sweep
 * asks the data the only question that matters - which paid bookings on a cancelled show have
 * no refund yet - so it is correct however the batch failed, whether the event handler threw,
 * the outbox was off, or the process died between the commit and the dispatch.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────
 * It does not move money. Each booking gets a REQUESTED refund in the same queue a buyer's
 * own request lands in, for an authorised human to approve. `BOOKING_REFUND_POLICY_MODE` is
 * MANUAL_ONLY and the money automation is production-forbidden, so paying people from a
 * background sweep would route around a control that exists on purpose. What this guarantees
 * is that the obligation is RECORDED, visible to the buyer, the organizer and the operator,
 * and impossible to lose.
 */
@Injectable()
export class CancellationRefundsService {
  private readonly logger = new Logger('Refunds');

  /** Bookings whose money is still ours to give back. */
  static readonly OWED_STATUSES = [
    BookingStatus.CONFIRMED,
    BookingStatus.PARTIALLY_REFUNDED,
  ] as const;

  /**
   * How many bookings one pass opens refunds for.
   *
   * Bounded because a handler runs under a timeout and a sweep should leave the database
   * usable for everybody else. Whatever is left is picked up by the next pass; the sweep's
   * correctness does not depend on finishing in one.
   */
  static readonly BATCH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsService,
  ) {}

  /**
   * Open refunds for one cancelled show.
   *
   * Returns what it did and what is left, so a caller can log progress without holding the
   * whole audience in memory.
   */
  async openFor(
    sessionId: string,
    opts: { batchSize?: number; reason?: string } = {},
  ): Promise<{ opened: number; skipped: number; failed: number; remaining: number }> {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true },
    });
    /*
      A session that is not cancelled must never have refunds opened against it. The event
      could be redelivered after somebody reinstated the show, and this is the check that
      makes that harmless rather than expensive.
    */
    if (!session || session.status !== SessionStatus.CANCELLED) {
      return { opened: 0, skipped: 0, failed: 0, remaining: 0 };
    }

    const owed = await this.owedBookings(
      sessionId,
      opts.batchSize ?? CancellationRefundsService.BATCH,
    );
    const reason = opts.reason ?? 'The organiser cancelled this show.';

    let opened = 0;
    let skipped = 0;
    let failed = 0;
    for (const booking of owed) {
      try {
        await this.refunds.openForCancelledSession(booking.id, reason);
        opened += 1;
      } catch (err) {
        /*
          One booking's refusal must not stop the rest.

          Several refusals are CORRECT and expected here: a cash booking cannot be refunded
          online, and a booking that already has an open refund is left alone. Those are
          skips, not failures - counting them as failures would make a healthy sweep look
          broken forever, because they never stop being true.
        */
        const message = err instanceof Error ? err.message : String(err);
        if (this.isExpectedRefusal(message)) {
          skipped += 1;
        } else {
          failed += 1;
          this.logger.error(
            `cancellation refund for booking ${booking.id} (show ${sessionId}) failed: ${message}`,
          );
        }
      }
    }

    const remaining = await this.remaining(sessionId);
    return { opened, skipped, failed, remaining };
  }

  /**
   * The guarantee. Finds cancelled shows that still owe somebody a refund, and opens a
   * bounded number of them.
   *
   * Asks the data rather than a queue, so it is right regardless of what failed earlier.
   */
  async sweep(
    opts: { batchSize?: number; maxSessions?: number; lookbackDays?: number } = {},
  ): Promise<{ sessions: number; opened: number; skipped: number; failed: number }> {
    const lookbackDays = opts.lookbackDays ?? 90;
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    /*
      Cancelled recently, and with somebody still owed.

      Bounded by a lookback for the reason every sweep is: an unbounded scan over every
      cancelled show this platform has ever had grows until it times out, and a sweep that
      times out is an outage that looks like silence. Ninety days is far longer than a refund
      should take and short enough to stay cheap.
    */
    const sessions = await this.prisma.eventSession.findMany({
      where: {
        status: SessionStatus.CANCELLED,
        updatedAt: { gte: since },
        bookings: {
          some: {
            status: { in: [...CancellationRefundsService.OWED_STATUSES] },
            refunds: { none: {} },
          },
        },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: opts.maxSessions ?? 10,
    });

    let opened = 0;
    let skipped = 0;
    let failed = 0;
    for (const session of sessions) {
      const r = await this.openFor(session.id, { batchSize: opts.batchSize });
      opened += r.opened;
      skipped += r.skipped;
      failed += r.failed;
    }

    if (opened > 0 || failed > 0) {
      this.logger.warn(
        `cancellation refunds: opened ${opened}, skipped ${skipped}, failed ${failed} ` +
          `across ${sessions.length} cancelled show(s)`,
      );
    }
    return { sessions: sessions.length, opened, skipped, failed };
  }

  /** Paid bookings on this show with no refund of any kind against them yet. */
  private async owedBookings(sessionId: string, take: number) {
    return this.prisma.booking.findMany({
      where: {
        eventSessionId: sessionId,
        status: { in: [...CancellationRefundsService.OWED_STATUSES] },
        /*
          `none` rather than "no OPEN refund".

          A booking whose refund was rejected has been looked at by a human who said no; the
          sweep must not argue with them by opening another one every minute. Re-opening after
          a rejection is a person's decision, through the console.
        */
        refunds: { none: {} },
      },
      select: { id: true },
      take,
      orderBy: { createdAt: 'asc' },
    });
  }

  private async remaining(sessionId: string): Promise<number> {
    return this.prisma.booking.count({
      where: {
        eventSessionId: sessionId,
        status: { in: [...CancellationRefundsService.OWED_STATUSES] },
        refunds: { none: {} },
      },
    });
  }

  /**
   * Refusals that mean "correctly not refunded here", rather than "something went wrong".
   *
   * Matched on the message because that is what the refund path raises, and because the
   * alternative - adding error codes to a certified money path for a sweep's benefit - is a
   * larger change than this is worth.
   */
  private isExpectedRefusal(message: string): boolean {
    return (
      /paid in cash/i.test(message) ||
      /already has an open refund|already requested|in progress/i.test(message) ||
      /not eligible/i.test(message)
    );
  }
}
