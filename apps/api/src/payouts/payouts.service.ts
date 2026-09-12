import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PayoutStatus, RefundStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** One currency's settlement figures. */
export interface CurrencySettlement {
  currency: string;
  gross: number;
  /** Coupon discounts, which come out of the organizer's ticket revenue. */
  discount: number;
  bookingFee: number;
  paymentFee: number;
  organizerFee: number;
  refund: number;
  net: number;
}

/**
 * Payouts that still stand, and so mark revenue as settled.
 *
 * A FAILED payout paid nothing, so the revenue it covered is still owed and must be picked up
 * by the next one. Counting it here would move the cursor past money nobody received.
 */
const STANDING_PAYOUT_STATUSES = [
  PayoutStatus.PENDING,
  PayoutStatus.SCHEDULED,
  PayoutStatus.PAID,
] as const;

/** Where an event's own payouts stopped, for one currency — revenue an org-wide payout skips. */
interface EventSettled {
  eventId: string;
  currency: string;
  until: Date;
}

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Settlement figures for an org (optionally a single event), per currency, for the period
   * each currency has not yet been paid out for.
   *
   * ── WHY PER CURRENCY ───────────────────────────────────────────────────────────────
   * This summed every booking the organization ever took, whatever it was sold in, and the
   * payout it produced was stored in the schema's default currency. An organizer selling in
   * India and the US was shown — and would have been paid — rupees plus dollars as one number
   * of rupees. Money in different currencies cannot be added; each is settled on its own.
   *
   * ── WHY ONLINE ONLY, AND WHY THE DISCOUNT ─────────────────────────────────────────
   * A cash booking was paid across the venue's counter: the organizer already holds that money,
   * and paying it out again would pay them twice. And `subtotalMinor` is the price BEFORE any
   * coupon — the customer paid subtotal − discount for the tickets, so the discount has to come
   * off, exactly as `computeMarketplaceSplit` takes it off the organizer's net on each payment.
   *
   * ── WHY A PERIOD ──────────────────────────────────────────────────────────────────
   * This used to sum every confirmed booking ever, so once a payout was marked PAID the next
   * one paid the same revenue again. `settledUntil` says, per currency, where the last standing
   * payout stopped: bookings count if they were confirmed after that and up to `until`, and a
   * currency never paid out before counts from the beginning.
   *
   * Refunds count in the period they COMPLETED in, not the period of the booking they return.
   * A refund of revenue already paid out therefore comes off the next payout — which is the only
   * place left to recover it from. The Refund row has no completion timestamp of its own, so
   * `updatedAt` stands in for one: nothing writes to a refund after it becomes COMPLETED except
   * to move it to FAILED, which takes it out of this sum anyway. A later change that edits
   * completed refunds in place would silently move them between periods, and must add a
   * `completedAt` column instead.
   *
   * `eventSettled` is only non-empty for an org-wide payout: each event's revenue up to where
   * that event's own payouts stopped has been paid already, and is left out. See `generate`.
   *
   * Both queries go through Prisma's query API rather than raw SQL so that each currency's
   * window is one plain `where`, and the unit tests can hold the service to it.
   */
  private async settle(
    client: Prisma.TransactionClient,
    organizationId: string,
    eventId: string | undefined,
    settledUntil: Map<string, Date>,
    eventSettled: EventSettled[],
    until: Date,
  ): Promise<CurrencySettlement[]> {
    const settledCurrencies = [...settledUntil.keys()];
    const bookingWindows: Prisma.BookingWhereInput[] = [
      ...[...settledUntil].map(([currency, after]) => ({
        currency,
        confirmedAt: { gt: after, lte: until },
      })),
      {
        ...(settledCurrencies.length > 0 ? { currency: { notIn: settledCurrencies } } : {}),
        confirmedAt: { lte: until },
      },
    ];
    const refundWindows: Prisma.RefundWhereInput[] = [
      ...[...settledUntil].map(([currency, after]) => ({
        booking: { currency },
        updatedAt: { gt: after, lte: until },
      })),
      {
        ...(settledCurrencies.length > 0
          ? { booking: { currency: { notIn: settledCurrencies } } }
          : {}),
        updatedAt: { lte: until },
      },
    ];

    const [paid, refunds] = await Promise.all([
      client.booking.groupBy({
        by: ['currency'],
        where: {
          organizationId,
          paymentMethod: 'ONLINE',
          ...(eventId ? { eventId } : {}),
          OR: bookingWindows,
          ...(eventSettled.length > 0
            ? {
                NOT: eventSettled.map((s) => ({
                  eventId: s.eventId,
                  currency: s.currency,
                  confirmedAt: { lte: s.until },
                })),
              }
            : {}),
        },
        _sum: {
          subtotalMinor: true,
          discountMinor: true,
          bookingFeeMinor: true,
          paymentFeeMinor: true,
          organizerFeeMinor: true,
        },
      }),
      // A refund has no currency of its own; it is in the currency of the booking it returns.
      client.refund.findMany({
        where: {
          organizationId,
          status: RefundStatus.COMPLETED,
          booking: { paymentMethod: 'ONLINE', ...(eventId ? { eventId } : {}) },
          OR: refundWindows,
          ...(eventSettled.length > 0
            ? {
                NOT: eventSettled.map((s) => ({
                  booking: { eventId: s.eventId, currency: s.currency },
                  updatedAt: { lte: s.until },
                })),
              }
            : {}),
        },
        select: { amountMinor: true, booking: { select: { currency: true } } },
      }),
    ]);

    const refundByCurrency = new Map<string, number>();
    for (const row of refunds) {
      const currency = row.booking.currency.toUpperCase();
      refundByCurrency.set(currency, (refundByCurrency.get(currency) ?? 0) + row.amountMinor);
    }
    const currencies = new Set([
      ...paid.map((row) => row.currency.toUpperCase()),
      ...refundByCurrency.keys(),
    ]);
    return [...currencies].sort().map((currency) => {
      const rows = paid.filter((row) => row.currency.toUpperCase() === currency);
      const sum = (key: keyof (typeof rows)[number]['_sum']) =>
        rows.reduce((total, row) => total + (row._sum[key] ?? 0), 0);
      const gross = sum('subtotalMinor');
      const discount = sum('discountMinor');
      const organizerFee = sum('organizerFeeMinor');
      const refund = refundByCurrency.get(currency) ?? 0;
      return {
        currency,
        gross,
        discount,
        bookingFee: sum('bookingFeeMinor'),
        paymentFee: sum('paymentFeeMinor'),
        organizerFee,
        refund,
        net: gross - discount - organizerFee - refund,
      };
    });
  }

  /**
   * One payout per currency the scope has unsettled money in.
   *
   * Returns the payouts created — none when there is nothing to settle, or when every
   * currency in scope already has an open payout. The duplicate guard is per currency: an
   * open rupee payout does not stop the dollar revenue from being settled.
   */
  async generate(user: RequestUser, organizationId: string, eventId?: string) {
    // The same people who may read payouts (see listForOrg). The route's @Roles only checks a
    // global role, so without this any member of the organization — check-in staff included —
    // could raise a payout and read the revenue figures it returns.
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    /*
      ── ONE GENERATE AT A TIME, AND BOTH SCOPES READ TOGETHER ──────────────────────────
      Two requests arriving together each read "no open payout" and each created one: the same
      revenue twice. The advisory lock serialises generates for the organization, whichever
      scope they are for, until the payouts are written.

      An org-wide payout and an event's own payout overlap — the org-wide one covers every event.
      Each scope's cursor used to ignore the other, so an org-wide payout followed by an event
      payout (or the reverse) paid that event's revenue twice. Now an event's cursor starts after
      whichever of the two stopped later; an org-wide payout leaves out each event's revenue up to
      where that event's own payouts stopped; and an open payout in either scope blocks the other,
      so a payout that fails is dealt with before an overlapping one can be raised on top of it.
    */
    const written = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-generate:${organizationId}`}))`;
      // Taken after the lock, so a generate that waited starts where the one before it stopped.
      const now = new Date();
      const standing = await tx.payout.findMany({
        where: {
          organizationId,
          status: { in: [...STANDING_PAYOUT_STATUSES] },
          // An event's revenue is covered by its own payouts and by org-wide ones; org-wide
          // revenue by every payout the organization has.
          ...(eventId ? { OR: [{ eventId }, { eventId: null }] } : {}),
        },
        select: {
          id: true,
          currency: true,
          status: true,
          eventId: true,
          periodEnd: true,
          createdAt: true,
        },
      });

      // Where each currency's settled revenue ends: the latest standing payout's period end.
      // A payout from before periods were recorded summed everything up to the moment it was
      // created, so its creation time is where it stopped.
      const settledUntil = new Map<string, Date>();
      const byEvent = new Map<string, EventSettled>();
      for (const payout of standing) {
        const end = payout.periodEnd ?? payout.createdAt;
        if (!end) continue;
        const currency = payout.currency.toUpperCase();
        if (eventId || payout.eventId === null) {
          const previous = settledUntil.get(currency);
          if (!previous || end > previous) settledUntil.set(currency, end);
        } else {
          const key = `${payout.eventId}|${currency}`;
          const previous = byEvent.get(key);
          if (!previous || end > previous.until) {
            byEvent.set(key, { eventId: payout.eventId, currency, until: end });
          }
        }
      }
      // An event payout that stopped before the last org-wide one is already inside its window.
      const eventSettled = [...byEvent.values()].filter((s) => {
        const orgWide = settledUntil.get(s.currency);
        return !orgWide || s.until > orgWide;
      });

      /*
        A period with neither revenue nor refunds produces no payout — a row of zeros is noise an
        admin has to open to discover it means nothing. A period whose refunds exceed its revenue
        DOES produce one, with a negative net: that is money to claw back from the organizer, and
        dropping it would quietly forgive the deduction rather than recover it.
      */
      const settlements = (
        await this.settle(tx, organizationId, eventId, settledUntil, eventSettled, now)
      ).filter((s) => s.gross !== 0 || s.refund !== 0);
      if (settlements.length === 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'There is no new paid revenue to settle.',
          HttpStatus.CONFLICT,
        );
      }

      // Guard against duplicate payouts: only one open (PENDING/SCHEDULED) payout may cover a
      // currency's revenue at a time, in this scope or an overlapping one. Together with the
      // settled cursor above and the atomic markPaid guard below, the same revenue is never paid
      // out twice.
      const open = standing.filter(
        (payout) =>
          payout.status === PayoutStatus.PENDING || payout.status === PayoutStatus.SCHEDULED,
      );
      const openCurrencies = new Set(open.map((payout) => payout.currency.toUpperCase()));
      const due = settlements.filter((s) => !openCurrencies.has(s.currency));
      if (due.length === 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'An open payout already covers every currency in this scope; finalize it before generating another.',
          HttpStatus.CONFLICT,
          { payoutIds: open.map((payout) => payout.id) },
        );
      }

      const rows = [];
      for (const s of due) {
        const periodStart = settledUntil.get(s.currency) ?? null;
        const payout = await tx.payout.create({
          data: {
            organizationId,
            eventId,
            currency: s.currency,
            periodStart,
            periodEnd: now,
            grossMinor: s.gross,
            bookingFeeMinor: s.bookingFee,
            paymentFeeMinor: s.paymentFee,
            refundMinor: s.refund,
            netMinor: s.net,
            status: PayoutStatus.PENDING,
          },
        });
        rows.push({ payout, settlement: s, periodStart, periodEnd: now });
      }
      return rows;
    });

    // Recorded once the payouts are committed, so the log never names a payout that rolled back.
    for (const { payout, settlement, periodStart, periodEnd } of written) {
      await this.audit.record({
        actorUserId: user.id,
        organizationId,
        action: 'PAYOUT_GENERATED',
        entityType: 'Payout',
        entityId: payout.id,
        metadata: {
          netMinor: settlement.net,
          currency: settlement.currency,
          periodStart: periodStart?.toISOString() ?? null,
          periodEnd: periodEnd.toISOString(),
        },
      });
    }
    return written.map(({ payout }) => payout);
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    // Settlement figures are financial data: restrict to org owners/managers
    // (+ platform admins, who bypass in assertMember). CHECKIN_STAFF and other
    // members must not read revenue/payout amounts.
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    return this.prisma.payout.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList() {
    return this.prisma.payout.findMany({
      orderBy: { createdAt: 'desc' },
      include: { organization: { select: { name: true } } },
    });
  }

  async markPaid(admin: RequestUser, payoutId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Payout not found.', HttpStatus.NOT_FOUND);

    // Atomic finalize: only an un-paid payout can be marked PAID, so the same
    // payout can never be paid twice (idempotent under concurrent admins).
    const claim = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: { in: [PayoutStatus.PENDING, PayoutStatus.SCHEDULED] } },
      data: { status: PayoutStatus.PAID, paidAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Payout is already ${payout.status}.`,
        HttpStatus.CONFLICT,
      );
    }
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: payout.organizationId,
      action: 'PAYOUT_PAID',
      entityType: 'Payout',
      entityId: payoutId,
    });
    return this.prisma.payout.findUnique({ where: { id: payoutId } });
  }
}
