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

    /*
      Whether THIS delivery is the one that lost the dispute.

      Providers repeat a closed dispute's webhook, and every "lost" used to deduct the amount
      from the settlement again. The flip to LOST is claimed atomically on an existing row; a
      dispute first seen already lost has no row yet, and the unique key on the upsert below
      stops a second one being created alongside it.
    */
    let firstLoss = false;
    if (lost) {
      const prior = await this.prisma.dispute.findUnique({
        where: { provider_providerDisputeId: { provider, providerDisputeId: dispute.id } },
        select: { id: true },
      });
      if (!prior) {
        firstLoss = true;
      } else {
        const claimed = await this.prisma.dispute.updateMany({
          where: { id: prior.id, status: { not: 'LOST' } },
          data: { status: 'LOST' },
        });
        firstLoss = claimed.count === 1;
      }
    }

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
        lost: firstLoss,
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

  /**
   * The dispute queue, oldest deadline first.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * Until this method, `DisputeService` could only WRITE. The webhook mirrored every
   * chargeback, stamped `evidenceDueBy` from the provider, blocked the organizer's proceeds
   * and sent each admin a notification - and then no screen in the platform could list one.
   *
   * A notification is an event: it says a dispute was opened. It cannot answer "which
   * disputes are still waiting on us", and it is read once, by whoever happened to be
   * looking. `evidenceDueBy` is a real deadline with money behind it: miss it and the
   * chargeback is lost by default, with nothing to appeal to. So the one thing an operator
   * must be able to do - see what is due and when - was the one thing missing.
   *
   * ── WHY READ-ONLY ──────────────────────────────────────────────────────────────────
   * Evidence is submitted to the provider, in the provider's dashboard, and the outcome
   * comes back to us through the webhook that already exists. A "respond" button here would
   * have to either reimplement the provider's evidence model or pretend to, and a button
   * that pretends to answer a chargeback is worse than no button. This lists them, names the
   * deadline, and says where the answer is given.
   */
  async listOpen(limit = 50): Promise<{
    disputes: {
      id: string;
      provider: string;
      providerDisputeId: string;
      status: DisputeStatus;
      amountMinor: number;
      currency: string;
      reason: string | null;
      evidenceDueBy: string | null;
      createdAt: string;
      bookingId: string | null;
      organization: { id: string; name: string } | null;
    }[];
    /** How much is being disputed, per currency. Never summed across them. */
    atRisk: { currency: string; totalMinor: number }[];
  }> {
    const rows = await this.prisma.dispute.findMany({
      where: { status: { in: OPEN_STATUSES } },
      /*
        A dispute with no deadline sorts last, not first. Postgres puts NULLs first on an
        ascending sort by default, so the ones with nothing to miss would have pushed the ones
        with a deadline today off the top of the queue.
      */
      orderBy: [{ evidenceDueBy: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: limit,
      include: { organization: { select: { id: true, name: true } } },
    });

    const byCurrency = new Map<string, number>();
    for (const r of rows) {
      // Providers report a currency in lower case; a screen grouping by it would otherwise
      // show "inr" and "INR" as two markets.
      const currency = r.currency.toUpperCase();
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + r.amountMinor);
    }

    return {
      disputes: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        providerDisputeId: r.providerDisputeId,
        status: r.status as DisputeStatus,
        amountMinor: r.amountMinor,
        currency: r.currency.toUpperCase(),
        reason: r.reason,
        evidenceDueBy: r.evidenceDueBy ? r.evidenceDueBy.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        bookingId: r.bookingId,
        organization: r.organization ? { id: r.organization.id, name: r.organization.name } : null,
      })),
      atRisk: [...byCurrency.entries()]
        .map(([currency, totalMinor]) => ({ currency, totalMinor }))
        .sort((a, b) => b.totalMinor - a.totalMinor || a.currency.localeCompare(b.currency)),
    };
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
