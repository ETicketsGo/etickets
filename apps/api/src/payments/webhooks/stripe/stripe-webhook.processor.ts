import { Injectable, Logger, Optional } from '@nestjs/common';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { PaymentsService } from '../../payments.service';
import { OrganizerConnectService } from '../../connect/organizer-connect.service';
import { SettlementService } from '../../settlement/settlement.service';
import { DisputeService, type StripeDisputeLike } from '../../dispute/dispute.service';
import { PaymentStatus, RefundStatus } from '@eticketsgo/shared-types';
import { organizerShareOfProviderRefund } from '../../settlement/refund-organizer-share';
import type { PaymentEvent } from '../../provider/payment-provider.interface';
import { OpsAlertService } from '../../../ops/alerts/ops-alert.service';
import { webhookDeadLetteredAlert } from '../../../ops/alerts/ops-alert-messages';
import {
  STRIPE_PURPOSE_CREDIT_PACK,
  STRIPE_PURPOSE_SUBSCRIPTION,
} from '../../../billing/provider/stripe-billing.provider';

/** Max processing attempts before an event is dead-lettered for ops review. */
const MAX_ATTEMPTS = 6;
/** Backoff before a FAILED event is retried by the sweep (ms). */
const RETRY_BACKOFF_MS = 30_000;

// ─── Minimal shapes of the Stripe objects we read (avoids importing SDK types here) ───
interface SessionLike {
  /** 'payment' for tickets; billing also uses 'subscription'. */
  mode?: string | null;
  /** 'paid' | 'unpaid' | 'no_payment_required'. A delayed method completes 'unpaid'. */
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
  payment_intent?: string | { id: string } | null;
}
interface PaymentIntentLike {
  id: string;
  metadata?: Record<string, string> | null;
  amount_received?: number | null;
  amount?: number | null;
}
interface AccountLike {
  id: string;
  details_submitted?: boolean;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  requirements?: { currently_due?: string[] | null; disabled_reason?: string | null } | null;
  default_currency?: string | null;
  country?: string | null;
}
interface ChargeLike {
  id: string;
  payment_intent?: string | null;
  amount_refunded?: number | null;
  currency?: string | null;
}
interface TransferLike {
  id: string;
  /** Cumulative across every reversal on this transfer. See `transfer-evidence.ts`. */
  amount_reversed?: number;
  amount?: number;
  currency?: string;
  reversed?: boolean;
}
interface StoredPayload {
  account?: string | null;
  object: unknown;
}

type DispatchResult = 'processed' | 'ignored';

/**
 * Processes durably-accepted Stripe webhook events (the WebhookEvent store). Idempotent:
 * an atomic RECEIVED/FAILED → PROCESSING claim ensures a single worker handles each event,
 * and every downstream action (ticket issuance, refund/dispute/settlement sync) is itself
 * idempotent. Failures retry with backoff and dead-letter after MAX_ATTEMPTS.
 *
 * The dispatch switch is extended by later milestones (refunds/disputes → M6,
 * transfers/payouts → M5); events without a handler are recorded as IGNORED (received,
 * no action taken), never silently dropped.
 */
@Injectable()
export class StripeWebhookProcessor {
  private readonly logger = new Logger(StripeWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly connect: OrganizerConnectService,
    private readonly settlements: SettlementService,
    private readonly disputes: DisputeService,
    private readonly audit: AuditService,
    // Optional so a hand-built processor in a unit test needs no alert double.
    @Optional() private readonly alerts?: OpsAlertService,
  ) {}

  /** Process one webhook event by id (best-effort fast path + the sweep both call this). */
  async process(webhookEventId: string): Promise<void> {
    // Atomic claim: only the caller that flips RECEIVED/FAILED → PROCESSING proceeds.
    const claim = await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        processingStatus: {
          in: [WebhookProcessingStatus.RECEIVED, WebhookProcessingStatus.FAILED],
        },
      },
      data: { processingStatus: WebhookProcessingStatus.PROCESSING, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return; // already processing / processed / dead-lettered

    const record = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!record) return;

    try {
      const result = await this.dispatch(
        record.eventType,
        record.payload as unknown as StoredPayload,
      );
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processingStatus:
            result === 'processed'
              ? WebhookProcessingStatus.PROCESSED
              : WebhookProcessingStatus.IGNORED,
          processedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = record.attempts;
      const dead = attempts >= MAX_ATTEMPTS;
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processingStatus: dead
            ? WebhookProcessingStatus.DEAD_LETTER
            : WebhookProcessingStatus.FAILED,
          errorMessage: message.slice(0, 500),
        },
      });
      if (dead) {
        this.logger.error(
          `Stripe webhook ${record.providerEventId} (${record.eventType}) dead-lettered after ${attempts} attempts: ${message}`,
        );
        await this.audit.record({
          action: 'WEBHOOK_DEAD_LETTER',
          entityType: 'WebhookEvent',
          entityId: webhookEventId,
          metadata: { eventType: record.eventType, providerEventId: record.providerEventId },
        });
        void this.alerts?.notify(
          webhookDeadLetteredAlert({
            provider: 'stripe',
            webhookEventId,
            providerEventId: record.providerEventId,
            eventType: record.eventType,
            attempts,
          }),
        );
      } else {
        this.logger.warn(
          `Stripe webhook ${record.providerEventId} (${record.eventType}) failed (attempt ${attempts}): ${message}`,
        );
      }
    }
  }

  /** Sweep due events (RECEIVED, or FAILED past the backoff and under the attempt cap). */
  async processPending(limit = 50): Promise<{ processed: number }> {
    const backoffCutoff = new Date(Date.now() - RETRY_BACKOFF_MS);
    const due = await this.prisma.webhookEvent.findMany({
      where: {
        provider: 'stripe',
        OR: [
          { processingStatus: WebhookProcessingStatus.RECEIVED },
          {
            processingStatus: WebhookProcessingStatus.FAILED,
            attempts: { lt: MAX_ATTEMPTS },
            updatedAt: { lt: backoffCutoff },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const e of due) await this.process(e.id);
    return { processed: due.length };
  }

  // ─── Dispatch ───

  private async dispatch(eventType: string, payload: StoredPayload): Promise<DispatchResult> {
    switch (eventType) {
      /*
        A completed Checkout Session is not necessarily a paid one.

        With a delayed method (a bank debit, a voucher) the session completes with
        `payment_status: 'unpaid'` and the money arrives — or does not — days later, reported by
        `async_payment_succeeded` or `async_payment_failed`. Confirming on `completed` alone
        issued tickets for money that had not moved and might never.
      */
      case 'checkout.session.completed': {
        const session = payload.object as SessionLike;
        if (session.payment_status !== 'paid') return 'ignored';
        return this.handlePayment(this.fromSession(session, 'payment.succeeded'));
      }
      case 'checkout.session.async_payment_succeeded':
        return this.handlePayment(
          this.fromSession(payload.object as SessionLike, 'payment.succeeded'),
        );
      case 'checkout.session.async_payment_failed':
        return this.handlePayment(
          this.fromSession(payload.object as SessionLike, 'payment.failed'),
        );
      case 'payment_intent.succeeded':
        return this.handlePayment(
          this.fromPaymentIntent(payload.object as PaymentIntentLike, 'payment.succeeded'),
        );
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        return this.handlePayment(
          this.fromPaymentIntent(payload.object as PaymentIntentLike, 'payment.failed'),
        );
      case 'account.updated':
        return this.handleAccountUpdated(payload.object as AccountLike);
      case 'charge.refunded':
        return this.handleChargeRefunded(payload.object as ChargeLike);
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
        await this.disputes.syncFromWebhook(payload.object as StripeDisputeLike);
        return 'processed';
      case 'transfer.failed':
        await this.settlements.onTransferFailed((payload.object as TransferLike).id);
        return 'processed';
      case 'transfer.reversed': {
        // Same engine as the synchronous path and the provider query. See the Razorpay note.
        const t = payload.object as TransferLike;
        if (!t?.id) return 'ignored';
        await this.settlements.applyTransferEvidence({
          provider: 'stripe',
          providerTransferId: t.id,
          currency: t.currency ?? 'usd',
          originalTransferredMinor: typeof t.amount === 'number' ? t.amount : null,
          cumulativeReversedMinor: typeof t.amount_reversed === 'number' ? t.amount_reversed : 0,
          providerStatusRaw: t.reversed ? 'reversed' : null,
          observedAt: new Date(),
          source: 'WEBHOOK',
        });
        return 'processed';
      }
      case 'transfer.created':
      case 'transfer.updated':
      case 'payout.paid':
      case 'payout.failed':
        // Informational (our transfers are recorded synchronously on release; payouts
        // are the connected account's own bank payouts). Acknowledge without action.
        return 'processed';
      default:
        // Received but not acted upon. Recorded as IGNORED so ops can see exactly which
        // event types are inert (nothing is silently dropped).
        return 'ignored';
    }
  }

  /**
   * A charge.refunded reflects a Stripe-side refund (issued by our RefundsService or via
   * the dashboard). Deduct the organizer's proportional share from their settlement — and
   * reverse the transfer if funds already moved. Idempotent via Payment.refundedMinor.
   */
  private async handleChargeRefunded(charge: ChargeLike): Promise<DispatchResult> {
    if (!charge.payment_intent) return 'ignored';
    const payment = await this.prisma.payment.findFirst({
      where: { providerPaymentIntentId: charge.payment_intent },
      select: {
        id: true,
        bookingId: true,
        amountMinor: true,
        organizerNetMinor: true,
        refundedMinor: true,
        currency: true,
        booking: { select: { eventId: true } },
      },
    });
    if (!payment?.booking?.eventId) return 'ignored';

    const totalRefunded = charge.amount_refunded ?? 0;
    const delta = totalRefunded - payment.refundedMinor;
    if (delta <= 0) return 'processed'; // already accounted for (idempotent)

    // Organizer's share of this incremental refund. `charge.refunded` carries no refund id, so
    // our newest COMPLETED Refund rows on the booking are matched to the delta; when they explain
    // it exactly the documented rule applies, otherwise (a dashboard refund) pro-rata is kept.
    const completed = await this.prisma.refund.findMany({
      where: { bookingId: payment.bookingId, status: RefundStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      select: { amountMinor: true, taxAddedMinor: true, platformFeeRefundedMinor: true },
    });
    const ownRows: typeof completed = [];
    let explained = 0;
    for (const row of completed) {
      if (explained >= delta) break;
      ownRows.push(row);
      explained += row.amountMinor;
    }
    const organizerShare = organizerShareOfProviderRefund(delta, ownRows, payment);

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundedMinor: totalRefunded,
        status:
          totalRefunded >= payment.amountMinor
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    await this.settlements.applyRefund(
      payment.booking.eventId,
      charge.currency ?? 'usd',
      organizerShare,
    );
    return 'processed';
  }

  private async handlePayment(event: PaymentEvent | null): Promise<DispatchResult> {
    if (!event) return 'ignored';
    await this.payments.processVerifiedEvent(event);
    return 'processed';
  }

  private async handleAccountUpdated(account: AccountLike): Promise<DispatchResult> {
    const synced = await this.connect.syncByProviderAccountId(account.id, {
      accountId: account.id,
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
      disabledReason: account.requirements?.disabled_reason ?? null,
      defaultCurrency: account.default_currency ?? null,
      country: account.country ?? null,
    });
    return synced ? 'processed' : 'ignored';
  }

  private fromSession(session: SessionLike, type: PaymentEvent['type']): PaymentEvent | null {
    /*
      Organizer billing shares this Stripe account, so its Checkout Sessions are delivered here
      too. They carry the ORGANIZATION id in client_reference_id, which must never be read as a
      booking id (it 404'd, retried and dead-lettered as an unconfirmed paid booking). Billing
      applies them on its own endpoint (billing/webhooks/stripe). Tickets never use subscription
      mode.
    */
    if (session.mode === 'subscription') return null;
    const purpose = session.metadata?.etg_purpose;
    if (purpose === STRIPE_PURPOSE_SUBSCRIPTION || purpose === STRIPE_PURPOSE_CREDIT_PACK) {
      return null;
    }
    const bookingId = session.metadata?.bookingId ?? session.client_reference_id ?? undefined;
    const amountMinor = session.amount_total;
    if (!bookingId || typeof amountMinor !== 'number') return null;
    const providerRef =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? '');
    return { type, providerRef, bookingId, amountMinor };
  }

  private fromPaymentIntent(
    pi: PaymentIntentLike,
    type: PaymentEvent['type'],
  ): PaymentEvent | null {
    const bookingId = pi.metadata?.bookingId;
    const amountMinor = pi.amount_received || pi.amount;
    if (!bookingId || typeof amountMinor !== 'number') return null;
    return { type, providerRef: pi.id, bookingId, amountMinor };
  }
}
