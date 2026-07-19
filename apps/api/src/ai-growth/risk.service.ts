import { Injectable } from '@nestjs/common';
import { deriveRiskSignals, type RiskSignalInput } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/decorators';

/** Mask an email for evidence display: keep first char + domain. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

const WINDOW_DAYS = 7;

/**
 * Deterministic, advisory fraud/risk signals for admins (v2.0 WS8). Aggregates
 * platform data over a window, masks identifiers, and runs the pure risk engine.
 * Advisory only — takes NO action. Access is audited.
 */
@Injectable()
export class RiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async signals(admin: RequestUser) {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
    const windowLabel = `last ${WINDOW_DAYS}d`;

    const [byBuyer, attempts, refundAgg, grossAgg, refundCount, coupons, transfers] =
      await Promise.all([
        this.prisma.booking.groupBy({
          by: ['buyerEmail'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
          orderBy: { _count: { buyerEmail: 'desc' } },
          take: 1,
        }),
        this.prisma.paymentAttempt.groupBy({
          by: ['status'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.prisma.refund.aggregate({
          where: { createdAt: { gte: since }, status: 'COMPLETED' },
          _sum: { amountMinor: true },
        }),
        this.prisma.booking.aggregate({
          where: { confirmedAt: { gte: since } },
          _sum: { totalMinor: true },
        }),
        this.prisma.refund.count({ where: { createdAt: { gte: since }, status: 'COMPLETED' } }),
        this.prisma.coupon.findMany({
          where: { redemptions: { gte: 100 } },
          select: { code: true, redemptions: true, maxRedemptions: true },
          take: 20,
        }),
        this.prisma.ticketInvite.groupBy({
          by: ['createdByUserId'],
          where: { createdAt: { gte: since }, kind: 'TRANSFER' },
          _count: { _all: true },
          orderBy: { _count: { createdByUserId: 'desc' } },
          take: 1,
        }),
      ]);

    const failed = attempts.find((a) => a.status === 'FAILED')?._count._all ?? 0;
    const totalAttempts = attempts.reduce((s, a) => s + a._count._all, 0);

    const input: RiskSignalInput = {
      windowLabel,
      topBuyerBookings: byBuyer[0]
        ? { label: maskEmail(byBuyer[0].buyerEmail), count: byBuyer[0]._count._all }
        : undefined,
      paymentFailures: { failed, total: totalAttempts },
      refunds: {
        refundedMinor: refundAgg._sum.amountMinor ?? 0,
        grossMinor: grossAgg._sum.totalMinor ?? 0,
        count: refundCount,
      },
      coupons: coupons.map((c) => ({
        code: c.code,
        redemptions: c.redemptions,
        maxRedemptions: c.maxRedemptions,
      })),
      topTransferrer: transfers[0]?.createdByUserId
        ? {
            label: `user ${transfers[0].createdByUserId.slice(0, 6)}…`,
            transfers: transfers[0]._count._all,
          }
        : undefined,
    };

    const signals = deriveRiskSignals(input);

    await this.audit.record({
      actorUserId: admin.id,
      action: 'AI_RISK_SIGNALS_VIEWED',
      entityType: 'RiskSignals',
      metadata: { windowDays: WINDOW_DAYS, signalCount: signals.length },
    });

    return { windowLabel, windowDays: WINDOW_DAYS, signals };
  }
}
