import { HttpStatus, Injectable } from '@nestjs/common';
import { PayoutStatus, RefundStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Settlement figures for an org (optionally a single event) from paid bookings. */
  private async settle(organizationId: string, eventId?: string) {
    const where = {
      organizationId,
      confirmedAt: { not: null },
      ...(eventId ? { eventId } : {}),
    };
    const agg = await this.prisma.booking.aggregate({
      where,
      _sum: {
        subtotalMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
      },
    });
    const refundAgg = await this.prisma.refund.aggregate({
      where: {
        organizationId,
        status: RefundStatus.COMPLETED,
        ...(eventId ? { booking: { eventId } } : {}),
      },
      _sum: { amountMinor: true },
    });
    const gross = agg._sum.subtotalMinor ?? 0;
    const bookingFee = agg._sum.bookingFeeMinor ?? 0;
    const paymentFee = agg._sum.paymentFeeMinor ?? 0;
    const organizerFee = agg._sum.organizerFeeMinor ?? 0;
    const refund = refundAgg._sum.amountMinor ?? 0;
    const net = gross - organizerFee - refund;
    return { gross, bookingFee, paymentFee, organizerFee, refund, net };
  }

  async generate(user: RequestUser, organizationId: string, eventId?: string) {
    await this.access.assertMember(user, organizationId);
    const s = await this.settle(organizationId, eventId);
    const payout = await this.prisma.payout.create({
      data: {
        organizationId,
        eventId,
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
      metadata: { netMinor: s.net },
    });
    return payout;
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);
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
    const updated = await this.prisma.payout.update({
      where: { id: payoutId },
      data: { status: PayoutStatus.PAID, paidAt: new Date() },
    });
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: payout.organizationId,
      action: 'PAYOUT_PAID',
      entityType: 'Payout',
      entityId: payoutId,
    });
    return updated;
  }
}
