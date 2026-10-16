import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, isReservedEmail } from '@eticketsgo/shared-types';
import type { CounterSaleInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { BookingsService } from '../bookings/bookings.service';
import { PaymentsService } from '../payments/payments.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** Who may sell at the counter: the same three roles that may collect cash there. */
export const COUNTER_ROLES = [
  Role.ORGANIZER_OWNER,
  Role.ORGANIZER_MANAGER,
  Role.CHECKIN_STAFF,
] as const;

export interface CounterSaleResult {
  bookingId: string;
  reference: string | null;
  status: string;
  totalMinor: number;
  currency: string;
  ticketCount: number;
  /** Where the confirmation was sent: the buyer's address, or the organization's own. */
  emailedTo: string;
}

/**
 * A walk-up sale at the box office: the organizer's staff sell tickets to the person in front
 * of them, take the money, and the tickets are issued there and then.
 *
 * ── WHY IT IS TWO EXISTING STEPS, NOT A NEW ONE ──────────────────────────────────────
 * The counter could already confirm a cash booking (`collectCash`), but only one a buyer had
 * reserved online first, and only while the organizer offered "pay at the venue" to every
 * online buyer. There was no way to sell to somebody standing at the counter. This is the
 * booking path every sale takes (prices, fees, sales windows, the regulated-price rules, the
 * pilot's limits, the oversell-proof hold) followed straight away by the cash collection the
 * counter already had (tickets, receipt, inventory sold, who took the money). Nothing about
 * money or stock is decided here.
 *
 * The cash never reaches ETicketsGo, so, as with every cash booking, there is no Payment row
 * and nothing of it is in a payout.
 */
@Injectable()
export class CounterSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * What can be sold at the counter right now: this organization's published events' dates
   * still to come, each with its ticket types, price and what is left.
   *
   * Its own read rather than the events list, because the person at the counter may be door
   * staff (CHECKIN_STAFF), who cannot open the event console and should not need to.
   */
  async shows(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId, [...COUNTER_ROLES]);
    const sessions = await this.prisma.eventSession.findMany({
      where: {
        event: { organizationId, status: 'PUBLISHED' },
        status: 'SCHEDULED',
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: 'asc' },
      take: 100,
      select: {
        id: true,
        startsAt: true,
        seatMapId: true,
        screen: { select: { name: true } },
        event: {
          select: {
            id: true,
            title: true,
            isFree: true,
            venue: { select: { name: true, timezone: true, country: true } },
          },
        },
        ticketTypes: {
          where: { status: 'ACTIVE' },
          orderBy: { priceMinor: 'asc' },
          select: {
            id: true,
            name: true,
            priceMinor: true,
            currency: true,
            maxPerOrder: true,
            seatCategoryId: true,
            inventory: {
              select: { quantityTotal: true, quantitySold: true, quantityHeld: true },
            },
          },
        },
      },
    });
    return sessions.map((s) => ({
      sessionId: s.id,
      startsAt: s.startsAt.toISOString(),
      eventId: s.event.id,
      eventTitle: s.event.title,
      isFree: s.event.isFree,
      venueName: s.event.venue?.name ?? null,
      timezone: s.event.venue?.timezone ?? null,
      country: s.event.venue?.country ?? null,
      spaceName: s.screen?.name ?? null,
      /** Seats are named on these tickets: the counter picks them from the seat map. */
      seated: Boolean(s.seatMapId),
      ticketTypes: s.ticketTypes.map((t) => ({
        id: t.id,
        name: t.name,
        priceMinor: t.priceMinor,
        currency: t.currency,
        maxPerOrder: t.maxPerOrder,
        seatCategoryId: t.seatCategoryId,
        // A seat category is counted on the seat map, not here.
        left:
          t.seatCategoryId || !t.inventory
            ? null
            : Math.max(
                0,
                t.inventory.quantityTotal - t.inventory.quantitySold - t.inventory.quantityHeld,
              ),
      })),
    }));
  }

  async sell(
    user: RequestUser,
    organizationId: string,
    input: CounterSaleInput,
    idempotencyKey?: string,
  ): Promise<CounterSaleResult> {
    await this.access.assertMember(user, organizationId, [...COUNTER_ROLES]);

    const session = await this.prisma.eventSession.findUnique({
      where: { id: input.eventSessionId },
      select: {
        id: true,
        event: {
          select: {
            organizationId: true,
            isFree: true,
            organization: { select: { contactEmail: true } },
          },
        },
      },
    });
    // Another organization's session reads as missing: its existence is not ours to confirm.
    if (!session || session.event.organizationId !== organizationId) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    }

    /*
      No address from the buyer: the confirmation goes to the organization's own contact
      address, then to the seller's, so it reaches somebody who can forward it. Never an
      invented address: mail sent to one goes nowhere and harms delivery for everybody.
    */
    const emailedTo = [input.buyerEmail, session.event.organization.contactEmail, user.email].find(
      (e): e is string => Boolean(e?.trim()) && !isReservedEmail(e),
    );
    if (!emailedTo) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        "Add the buyer's email. Your organization has no contact email to send the tickets to instead.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const isFree = session.event.isFree;
    const created = (await this.bookings.create(
      null,
      {
        eventSessionId: input.eventSessionId,
        items: input.items,
        buyerName: input.buyerName,
        buyerEmail: emailedTo,
        // A free event confirms itself on the free path; there is nothing to collect.
        ...(isFree ? {} : { paymentMethod: 'CASH' as const }),
      },
      idempotencyKey ? `counter:${organizationId}:${idempotencyKey}` : undefined,
      undefined,
      { counterSale: true },
    )) as { id: string };

    if (!isFree) {
      try {
        await this.payments.collectCash(created.id, user.id);
      } catch (e) {
        /*
          The sale did not happen, so the seats go back now rather than sitting held until the
          hold lapses. If the release itself cannot claim the booking (it was confirmed after
          all), the original error still stands and the counter list shows the truth.
        */
        await this.bookings.releaseCounterSale(created.id, user.id).catch(() => undefined);
        throw e;
      }
    }

    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: created.id },
      select: {
        id: true,
        reference: true,
        status: true,
        totalMinor: true,
        currency: true,
        _count: { select: { tickets: true } },
      },
    });

    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'COUNTER_SALE',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: {
        totalMinor: booking.totalMinor,
        currency: booking.currency,
        tickets: booking._count.tickets,
        paidWith: isFree ? 'FREE' : 'CASH',
        buyerGaveEmail: Boolean(input.buyerEmail),
      },
    });

    return {
      bookingId: booking.id,
      reference: booking.reference,
      status: booking.status,
      totalMinor: booking.totalMinor,
      currency: booking.currency,
      ticketCount: booking._count.tickets,
      emailedTo,
    };
  }
}
