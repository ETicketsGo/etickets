import { Injectable } from '@nestjs/common';
import { DisputeStatus, NotificationType } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotificationService } from '../../notifications/notification.service';
import { SettlementService } from '../settlement/settlement.service';

/** Minimal shape of a Stripe dispute object (from charge.dispute.* webhooks). */
export interface StripeDisputeLike {
  id: string;
  payment_intent?: string | null;
  charge?: string | null;
  amount: number;
  currency: string;
  reason?: string | null;
  status: string;
  evidence_details?: { due_by?: number | null } | null;
}

/** Map a provider dispute status (Stripe or Razorpay) → our lifecycle. */
export function mapDisputeStatus(providerStatus: string): DisputeStatus {
  switch (providerStatus) {
    case 'warning_needs_response':
    case 'needs_response':
    case 'open': // Razorpay
      return 'NEEDS_RESPONSE';
    case 'warning_under_review':
    case 'under_review':
      return 'UNDER_REVIEW';
    case 'won':
      return 'WON';
    case 'lost':
      return 'LOST';
    case 'warning_closed':
      return 'WARNING_CLOSED';
    default:
      return 'CLOSED';
  }
}

const OPEN_STATUSES: DisputeStatus[] = ['NEEDS_RESPONSE', 'UNDER_REVIEW'];

/**
 * Synchronises Stripe disputes (the platform is merchant of record under Separate
 * Charges & Transfers, so disputes settle against the platform account). Mirrors the
 * dispute locally, flags booking/organizer/event/settlement, blocks unsettled proceeds
 * while open, records losses (with reversal via the settlement service), and notifies ops.
 */
@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly settlements: SettlementService,
  ) {}

  async syncFromWebhook(dispute: StripeDisputeLike, provider = 'stripe'): Promise<void> {
    const status = mapDisputeStatus(dispute.status);
    const open = OPEN_STATUSES.includes(status);
    const lost = status === 'LOST';

    const payment = dispute.payment_intent
      ? await this.prisma.payment.findFirst({
          where: { providerPaymentIntentId: dispute.payment_intent },
          select: {
            id: true,
            booking: { select: { id: true, organizationId: true, eventId: true } },
          },
        })
      : null;
    const booking = payment?.booking ?? null;
    const currency = dispute.currency.toLowerCase();

    await this.prisma.dispute.upsert({
      where: { provider_providerDisputeId: { provider, providerDisputeId: dispute.id } },
      create: {
        provider,
        providerDisputeId: dispute.id,
        paymentId: payment?.id ?? null,
        bookingId: booking?.id ?? null,
        organizationId: booking?.organizationId ?? null,
        eventId: booking?.eventId ?? null,
        amountMinor: dispute.amount,
        currency,
        reason: dispute.reason ?? null,
        status,
        stripeStatus: dispute.status,
        evidenceDueBy: dispute.evidence_details?.due_by
          ? new Date(dispute.evidence_details.due_by * 1000)
          : null,
        resolvedAt: open ? null : new Date(),
      },
      update: {
        status,
        stripeStatus: dispute.status,
        resolvedAt: open ? null : new Date(),
      },
    });

    // Flag the booking so ops can see it (existing DISPUTED booking status).
    if (booking?.id && open) {
      await this.prisma.booking
        .update({ where: { id: booking.id }, data: { status: 'DISPUTED' } })
        .catch(() => undefined);
    }

    // Block unsettled proceeds while open; record + reverse on a lost dispute.
    if (booking?.eventId) {
      await this.settlements.applyDispute(booking.eventId, currency, {
        amountMinor: dispute.amount,
        open,
        lost,
      });
    }

    await this.audit.record({
      organizationId: booking?.organizationId ?? undefined,
      action: open ? 'PAYMENT_DISPUTE_OPENED' : 'PAYMENT_DISPUTE_UPDATED',
      entityType: 'Dispute',
      entityId: dispute.id,
      metadata: { status, stripeStatus: dispute.status, amountMinor: dispute.amount },
    });

    if (open) await this.notifyAdmins(dispute.id, booking?.organizationId ?? null);
  }

  private async notifyAdmins(disputeId: string, organizationId: string | null) {
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'ADMIN' } },
      select: { id: true },
      take: 50,
    });
    for (const a of admins) {
      await this.notifications
        .send({
          type: NotificationType.PAYMENT_DISPUTE_OPENED,
          userId: a.id,
          payload: { disputeId, organizationId },
          channels: ['in_app', 'email'],
        })
        .catch(() => undefined);
    }
  }
}
