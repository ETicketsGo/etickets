import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async bookings(params: { page: number; pageSize: number; status?: string; q?: string }) {
    const where = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { buyerEmail: { contains: params.q, mode: 'insensitive' as const } },
              { reference: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { event: { select: { title: true } }, payment: { select: { status: true } } },
      }),
    ]);
    return {
      data: rows.map((b) => ({
        id: b.id,
        reference: b.reference,
        status: b.status,
        buyerEmail: b.buyerEmail,
        totalMinor: b.totalMinor,
        createdAt: b.createdAt,
        event: { title: b.event.title },
        paymentStatus: b.payment?.status ?? null,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  async payments(params: { page: number; pageSize: number; status?: string }) {
    const where = params.status ? { status: params.status as never } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { booking: { select: { buyerEmail: true } } },
      }),
    ]);
    return {
      data: rows.map((p) => ({
        id: p.id,
        status: p.status,
        amountMinor: p.amountMinor,
        provider: p.provider,
        providerRef: p.providerRef,
        createdAt: p.createdAt,
        bookingId: p.bookingId,
        buyerEmail: p.booking.buyerEmail,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  feeRules() {
    return this.prisma.feeRule.findMany({ orderBy: [{ currency: 'asc' }, { minMinor: 'asc' }] });
  }

  /**
   * Update one platform fee rule.
   *
   * Booking fees are money, so this validates the resulting band rather than trusting the
   * caller. Two checks matter beyond "is it a number":
   *
   *  - `maxMinor` must exceed `minMinor`. An inverted band matches nothing, and because the
   *    resolver falls through to the last tier on no match, an inverted band silently
   *    reprices every booking in that range to whatever the top tier charges.
   *  - Bands must not overlap another ACTIVE rule in the same currency. `resolveBookingFee`
   *    returns the first match, so an overlap makes the fee depend on row order — the same
   *    subtotal could be charged differently after an unrelated edit.
   *
   * Currency is deliberately immutable: moving a rule between currencies would silently
   * reinterpret its minor-unit amounts (₹5 becoming $5). Create a new rule instead.
   */
  async updateFeeRule(
    actorUserId: string,
    id: string,
    patch: {
      label?: string;
      minMinor?: number;
      maxMinor?: number | null;
      feeMinor?: number;
      active?: boolean;
    },
  ) {
    const existing = await this.prisma.feeRule.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCodes.NOT_FOUND, 'Fee rule not found.');

    const next = {
      label: patch.label ?? existing.label,
      minMinor: patch.minMinor ?? existing.minMinor,
      maxMinor: patch.maxMinor === undefined ? existing.maxMinor : patch.maxMinor,
      feeMinor: patch.feeMinor ?? existing.feeMinor,
      active: patch.active ?? existing.active,
    };

    if (next.maxMinor !== null && next.maxMinor <= next.minMinor) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The upper bound must be greater than the lower bound (use no upper bound for the top band).',
      );
    }

    if (next.active) {
      const siblings = await this.prisma.feeRule.findMany({
        where: { currency: existing.currency, active: true, id: { not: id } },
      });
      const hi = (m: number | null) => (m === null ? Number.MAX_SAFE_INTEGER : m);
      const clash = siblings.find(
        (s) => next.minMinor <= hi(s.maxMinor) && s.minMinor <= hi(next.maxMinor),
      );
      if (clash) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          `This band overlaps the active rule "${clash.label}" in ${existing.currency}. Fees are resolved by first match, so overlapping bands make the charge depend on row order.`,
        );
      }
    }

    const updated = await this.prisma.feeRule.update({ where: { id }, data: next });

    await this.audit.record({
      actorUserId,
      action: 'FEE_RULE_UPDATED',
      entityType: 'FeeRule',
      entityId: id,
      // Before/after on money configuration — the point of the audit trail.
      metadata: {
        currency: existing.currency,
        before: {
          label: existing.label,
          minMinor: existing.minMinor,
          maxMinor: existing.maxMinor,
          feeMinor: existing.feeMinor,
          active: existing.active,
        },
        after: next,
      },
    });

    return updated;
  }
}
