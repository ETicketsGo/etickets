import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BookingStatus, Role, SessionStatus, TicketStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** Who may hand cash back: the same people who may take it at the counter. */
const COUNTER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

/** Bookings whose tickets are still live, and so still open a door. */
const LIVE_BOOKING = [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED];
const LIVE_TICKET = [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN];

/** One cash booking whose money is owed back, or was handed back. */
export interface CashReturnRow {
  bookingId: string;
  reference: string | null;
  buyerName: string;
  buyerEmail: string;
  amountMinor: number;
  currency: string;
  eventId: string;
  eventTitle: string;
  startsAt: Date;
  collectedBy: string | null;
  returnedAt: Date | null;
  returnedBy: string | null;
}

/**
 * Cash taken at the counter for a show that was then cancelled.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * Cancelling a show opened a refund for every paid booking, and the refund path refuses cash
 * (correctly: the money never passed through a provider). So a cash booking was skipped and
 * left exactly as it was: CONFIRMED, its tickets live and printable, its seats counted as
 * sold, for a show that was not happening. The organizer was told only "give it back at the
 * counter", with no list of whom to give what.
 *
 * ── WHAT HAPPENS NOW ───────────────────────────────────────────────────────────────
 * Everything a refund does to the tickets and nothing it does to money, the same split the
 * free-booking cancellation makes: the tickets become CANCELLED (check-in and the counter's
 * print refuse them), their stock goes back through the booking's own inventory strategy, and
 * the booking becomes CANCELLED. The money owed is the booking's total, which is what
 * `collectCash` recorded as taken.
 *
 * Handing the cash back is then recorded by a person, offline (`cashReturnedAt`). No `Refund`
 * row, no provider call, no credit note, no settlement line: none of them can describe money
 * that only ever crossed a counter, and inventing one would put an unreconcilable figure into
 * the frozen finance reports. The receipt issued at collection is left as it is; see the PR
 * for the open question of a credit note against it.
 */
@Injectable()
export class CashReturnsService {
  private readonly logger = new Logger('CashReturns');

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Void every live cash booking on one cancelled show.
   *
   * Called wherever the cancellation refunds are opened (the ShowCancelled handler, the event
   * cancel and the sweep), so it converges the same way they do. Idempotent: a second run finds
   * nothing live, and each booking is claimed under the same per-booking lock a refund request
   * takes, so a concurrent refund or check-in cannot interleave with it.
   */
  async cancelForCancelledSession(sessionId: string): Promise<{ cancelled: number }> {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    // A show somebody reinstated must keep its audience.
    if (!session || session.status !== SessionStatus.CANCELLED) return { cancelled: 0 };

    const bookings = await this.prisma.booking.findMany({
      where: { eventSessionId: sessionId, paymentMethod: 'CASH', status: { in: LIVE_BOOKING } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    let cancelled = 0;
    for (const { id } of bookings) {
      try {
        if (await this.cancelOne(id)) cancelled += 1;
      } catch (err) {
        // One booking must not stop the rest; the next pass retries it.
        this.logger.error(
          `cash booking ${id} on cancelled show ${sessionId} left for the next pass: ${(err as Error)?.message}`,
        );
      }
    }
    return { cancelled };
  }

  private async cancelOne(bookingId: string): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refund-request:${bookingId}`}))`;
      // Read inside the lock: the status read before it may be stale.
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          organizationId: true,
          eventSessionId: true,
          seatBased: true,
          status: true,
          paymentMethod: true,
          totalMinor: true,
          currency: true,
          reference: true,
          cashCollectedAt: true,
          tickets: { select: { id: true, status: true, ticketTypeId: true, seatId: true } },
        },
      });
      if (
        !booking ||
        booking.paymentMethod !== 'CASH' ||
        !(LIVE_BOOKING as string[]).includes(booking.status)
      ) {
        return null;
      }
      const live = booking.tickets.filter((t) => (LIVE_TICKET as string[]).includes(t.status));
      if (live.length > 0) {
        // Claim first, then move stock, so stock only goes back for tickets this call voided.
        const claimed = await tx.ticket.updateMany({
          where: { id: { in: live.map((t) => t.id) }, status: { in: LIVE_TICKET } },
          data: { status: TicketStatus.CANCELLED },
        });
        if (claimed.count !== live.length) {
          throw new Error('tickets changed while being cancelled');
        }
        await this.inventory.forSeating(booking.seatBased).refund(tx, {
          eventSessionId: booking.eventSessionId,
          tickets: live.map((t) => ({ ticketTypeId: t.ticketTypeId, seatId: t.seatId })),
        });
      }
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() },
      });
      return { booking, voided: live.length };
    });
    if (!outcome) return false;

    const { booking } = outcome;
    await this.audit.record({
      actorUserId: null,
      organizationId: booking.organizationId,
      action: 'CASH_BOOKING_CANCELLED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: {
        reference: booking.reference,
        sessionId: booking.eventSessionId,
        ticketsVoided: outcome.voided,
        // What the counter owes back: nothing if the cash was never taken.
        cashToReturnMinor: booking.cashCollectedAt ? booking.totalMinor : 0,
        currency: booking.currency,
      },
    });
    return true;
  }

  /**
   * The cash this organization owes back (and, with `includeReturned`, has handed back):
   * cancelled cash bookings whose money was taken. Optionally for one event.
   */
  async list(
    user: RequestUser,
    organizationId: string,
    opts: { eventId?: string; includeReturned?: boolean } = {},
  ): Promise<CashReturnRow[]> {
    await this.access.assertMember(user, organizationId, COUNTER_ROLES);
    const rows = await this.prisma.booking.findMany({
      where: {
        organizationId,
        paymentMethod: 'CASH',
        status: BookingStatus.CANCELLED,
        cashCollectedAt: { not: null },
        ...(opts.eventId ? { eventId: opts.eventId } : {}),
        ...(opts.includeReturned ? {} : { cashReturnedAt: null }),
      },
      select: {
        id: true,
        reference: true,
        buyerName: true,
        buyerEmail: true,
        totalMinor: true,
        currency: true,
        eventId: true,
        cashReturnedAt: true,
        event: { select: { title: true } },
        eventSession: { select: { startsAt: true } },
        cashCollectedBy: { select: { fullName: true } },
        cashReturnedBy: { select: { fullName: true } },
      },
      orderBy: [{ eventSession: { startsAt: 'asc' } }, { createdAt: 'asc' }],
      take: 500,
    });
    return rows.map((b) => ({
      bookingId: b.id,
      reference: b.reference,
      buyerName: b.buyerName,
      buyerEmail: b.buyerEmail,
      amountMinor: b.totalMinor,
      currency: b.currency,
      eventId: b.eventId,
      eventTitle: b.event.title,
      startsAt: b.eventSession.startsAt,
      collectedBy: b.cashCollectedBy?.fullName ?? null,
      returnedAt: b.cashReturnedAt,
      returnedBy: b.cashReturnedBy?.fullName ?? null,
    }));
  }

  /**
   * Record that the cash for one cancelled booking was handed back. An offline record only:
   * nothing is sent to any payment provider. Recording it twice changes nothing.
   */
  async markReturned(user: RequestUser, organizationId: string, bookingId: string) {
    await this.access.assertMember(user, organizationId, COUNTER_ROLES);
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        organizationId: true,
        paymentMethod: true,
        status: true,
        cashCollectedAt: true,
        cashReturnedAt: true,
        totalMinor: true,
        currency: true,
        reference: true,
      },
    });
    // Another organization's booking reads as missing: its existence is not ours to confirm.
    if (!booking || booking.organizationId !== organizationId) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    if (booking.paymentMethod !== 'CASH' || !booking.cashCollectedAt) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This booking was not paid in cash at the counter, so there is no cash to give back.',
        HttpStatus.CONFLICT,
      );
    }
    if (booking.status !== BookingStatus.CANCELLED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This booking is not cancelled. Cash is given back only for a cancelled booking.',
        HttpStatus.CONFLICT,
      );
    }
    if (booking.cashReturnedAt) {
      return { bookingId, status: 'already_returned' as const, returnedAt: booking.cashReturnedAt };
    }

    // Conditional, so two people pressing at once record one return, by whoever was first.
    const now = new Date();
    const claimed = await this.prisma.booking.updateMany({
      where: { id: bookingId, cashReturnedAt: null, status: BookingStatus.CANCELLED },
      data: { cashReturnedAt: now, cashReturnedByUserId: user.id },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select: { cashReturnedAt: true },
      });
      return {
        bookingId,
        status: 'already_returned' as const,
        returnedAt: current?.cashReturnedAt ?? now,
      };
    }

    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'CASH_RETURNED',
      entityType: 'Booking',
      entityId: bookingId,
      metadata: {
        reference: booking.reference,
        amountMinor: booking.totalMinor,
        currency: booking.currency,
      },
    });
    return { bookingId, status: 'returned' as const, returnedAt: now };
  }
}
