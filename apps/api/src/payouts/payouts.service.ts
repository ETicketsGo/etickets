import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PayoutStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** One currency's settlement figures. */
export interface CurrencySettlement {
  currency: string;
  gross: number;
  bookingFee: number;
  paymentFee: number;
  organizerFee: number;
  refund: number;
  net: number;
}

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Settlement figures for an org (optionally a single event) from paid bookings, per currency.
   *
   * ── WHY PER CURRENCY ───────────────────────────────────────────────────────────────
   * This summed every booking the organization ever took, whatever it was sold in, and the
   * payout it produced was stored in the schema's default currency. An organizer selling in
   * India and the US was shown — and would have been paid — rupees plus dollars as one number
   * of rupees. Money in different currencies cannot be added; each is settled on its own.
   */
  private async settle(organizationId: string, eventId?: string): Promise<CurrencySettlement[]> {
    const [paid, refunds] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['currency'],
        where: { organizationId, confirmedAt: { not: null }, ...(eventId ? { eventId } : {}) },
        _sum: {
          subtotalMinor: true,
          bookingFeeMinor: true,
          paymentFeeMinor: true,
          organizerFeeMinor: true,
        },
      }),
      // A refund has no currency of its own; it is in the currency of the booking it returns.
      this.prisma.$queryRaw<{ currency: string; amountMinor: bigint | number | null }[]>`
        SELECT b."currency" AS currency, COALESCE(SUM(r."amountMinor"), 0) AS "amountMinor"
        FROM "Refund" r
        JOIN "Booking" b ON b."id" = r."bookingId"
        WHERE r."organizationId" = ${organizationId}
          AND r."status" = 'COMPLETED'
          ${eventId ? Prisma.sql`AND b."eventId" = ${eventId}` : Prisma.empty}
        GROUP BY b."currency"`,
    ]);

    const refundByCurrency = new Map(
      refunds.map((row) => [row.currency.toUpperCase(), Number(row.amountMinor ?? 0)]),
    );
    const currencies = new Set([
      ...paid.map((row) => row.currency.toUpperCase()),
      ...refundByCurrency.keys(),
    ]);
    return [...currencies].sort().map((currency) => {
      const rows = paid.filter((row) => row.currency.toUpperCase() === currency);
      const sum = (key: keyof (typeof rows)[number]['_sum']) =>
        rows.reduce((total, row) => total + (row._sum[key] ?? 0), 0);
      const gross = sum('subtotalMinor');
      const organizerFee = sum('organizerFeeMinor');
      const refund = refundByCurrency.get(currency) ?? 0;
      return {
        currency,
        gross,
        bookingFee: sum('bookingFeeMinor'),
        paymentFee: sum('paymentFeeMinor'),
        organizerFee,
        refund,
        net: gross - organizerFee - refund,
      };
    });
  }

  /**
   * One payout per currency the scope has money in.
   *
   * Returns the payouts created — none when there is nothing to settle, or when every
   * currency in scope already has an open payout. The duplicate guard is per currency: an
   * open rupee payout does not stop the dollar revenue from being settled.
   */
  async generate(user: RequestUser, organizationId: string, eventId?: string) {
    await this.access.assertMember(user, organizationId);

    const settlements = await this.settle(organizationId, eventId);
    if (settlements.length === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'There is no paid revenue to settle yet.',
        HttpStatus.CONFLICT,
      );
    }

    // Guard against duplicate payouts: only one open (PENDING/SCHEDULED) payout may exist per
    // settlement scope AND currency at a time. Combined with the atomic markPaid guard below,
    // this prevents the same revenue being paid out twice. (A settled-cursor that also
    // excludes already-PAID revenue across cycles is tracked in the debt register — it changes
    // payout semantics and needs a schema change.)
    const open = await this.prisma.payout.findMany({
      where: {
        organizationId,
        eventId: eventId ?? null,
        status: { in: [PayoutStatus.PENDING, PayoutStatus.SCHEDULED] },
      },
      select: { id: true, currency: true },
    });
    const openCurrencies = new Set(open.map((payout) => payout.currency.toUpperCase()));
    const due = settlements.filter((s) => !openCurrencies.has(s.currency));
    if (due.length === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'An open payout already exists for every currency in this scope; finalize it before generating another.',
        HttpStatus.CONFLICT,
        { payoutIds: open.map((payout) => payout.id) },
      );
    }

    const created = [];
    for (const s of due) {
      const payout = await this.prisma.payout.create({
        data: {
          organizationId,
          eventId,
          currency: s.currency,
          grossMinor: s.gross,
          bookingFeeMinor: s.bookingFee,
          paymentFeeMinor: s.paymentFee,
          refundMinor: s.refund,
          netMinor: s.net,
          status: PayoutStatus.PENDING,
        },
      });
      await this.audit.record({
        actorUserId: user.id,
        organizationId,
        action: 'PAYOUT_GENERATED',
        entityType: 'Payout',
        entityId: payout.id,
        metadata: { netMinor: s.net, currency: s.currency },
      });
      created.push(payout);
    }
    return created;
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
