import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentsService } from '../payments.service';
import { SettlementService } from '../settlement/settlement.service';
import { DisputeService } from '../dispute/dispute.service';
import type { PaymentEvent } from '../provider/payment-provider.interface';

const MAX_ATTEMPTS = 6;
const RETRY_BACKOFF_MS = 30_000;
const PROVIDER = 'razorpay';

// ─── Minimal shapes of the Razorpay entities we read (payload.<entity>.entity) ───
interface RzpPayment {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  notes?: Record<string, string | number> | null;
}
interface RzpOrder {
  id?: string;
  receipt?: string;
  amount?: number;
  notes?: Record<string, string | number> | null;
}
interface RzpRefund {
  id?: string;
  payment_id?: string;
  amount?: number;
  currency?: string;
}
interface RzpDispute {
  id?: string;
  payment_id?: string;
  amount?: number;
  currency?: string;
  reason_code?: string;
  status?: string;
}
interface RzpTransfer {
  id?: string;
}
/** payload = { payment?: {entity}, order?: {entity}, refund?: {entity}, dispute?: {entity}, transfer?: {entity} } */
interface RazorpayPayload {
  payment?: { entity?: RzpPayment };
  order?: { entity?: RzpOrder };
  refund?: { entity?: RzpRefund };
  dispute?: { entity?: RzpDispute };
  transfer?: { entity?: RzpTransfer };
}
interface StoredPayload {
  account?: string | null;
  object: RazorpayPayload;
}

type DispatchResult = 'processed' | 'ignored';

/**
 * Processes durably-accepted Razorpay webhook events. Same idempotency/retry/dead-letter
 * discipline as the Stripe processor (atomic RECEIVED/FAILED→PROCESSING claim), reusing
 * the SAME downstream issuance/refund/dispute/settlement services. Kept separate from the
 * Stripe processor so the Stripe path is never touched.
 */
@Injectable()
export class RazorpayWebhookProcessor {
  private readonly logger = new Logger(RazorpayWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly settlements: SettlementService,
    private readonly disputes: DisputeService,
    private readonly audit: AuditService,
  ) {}

  async process(webhookEventId: string): Promise<void> {
    const claim = await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        provider: PROVIDER,
        processingStatus: {
          in: [WebhookProcessingStatus.RECEIVED, WebhookProcessingStatus.FAILED],
        },
      },
      data: { processingStatus: WebhookProcessingStatus.PROCESSING, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return;

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
      const dead = record.attempts >= MAX_ATTEMPTS;
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
          `Razorpay webhook ${record.providerEventId} (${record.eventType}) dead-lettered: ${message}`,
        );
        await this.audit.record({
          action: 'WEBHOOK_DEAD_LETTER',
          entityType: 'WebhookEvent',
          entityId: webhookEventId,
          metadata: { provider: PROVIDER, eventType: record.eventType },
        });
      }
    }
  }

  async processPending(limit = 50): Promise<{ processed: number }> {
    const backoffCutoff = new Date(Date.now() - RETRY_BACKOFF_MS);
    const due = await this.prisma.webhookEvent.findMany({
      where: {
        provider: PROVIDER,
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

  private async dispatch(eventType: string, payload: StoredPayload): Promise<DispatchResult> {
    const p = payload.object;
    switch (eventType) {
      case 'order.paid':
      case 'payment.captured':
        return this.handlePayment(this.toPaymentEvent(p, 'payment.succeeded'));
      case 'payment.failed':
        return this.handlePayment(this.toPaymentEvent(p, 'payment.failed'));
      case 'refund.created':
      case 'refund.processed':
        return this.handleRefund(p);
      case 'payment.dispute.created':
      case 'payment.dispute.won':
      case 'payment.dispute.lost':
        return this.handleDispute(eventType, p);
      case 'transfer.failed':
        await this.settlements.onTransferFailed(p.transfer?.entity?.id ?? '');
        return 'processed';
      case 'transfer.reversed':
        await this.settlements.onTransferReversed(p.transfer?.entity?.id ?? '');
        return 'processed';
      case 'transfer.processed':
      case 'settlement.processed':
      case 'settlement.failed':
      case 'payment.authorized':
      case 'refund.failed':
        // Acknowledged, no state change (settlement.* are Razorpay's own bank settlements
        // to the platform; authorized precedes captured; refund.failed is surfaced via
        // the refund record). Recorded as IGNORED, never dropped.
        return 'ignored';
      default:
        return 'ignored';
    }
  }

  private async handlePayment(event: PaymentEvent | null): Promise<DispatchResult> {
    if (!event) return 'ignored';
    await this.payments.processVerifiedEvent(event);
    return 'processed';
  }

  private toPaymentEvent(p: RazorpayPayload, type: PaymentEvent['type']): PaymentEvent | null {
    const payment = p.payment?.entity;
    const order = p.order?.entity;
    const bookingId =
      strOrNull(payment?.notes?.bookingId) ??
      strOrNull(order?.notes?.bookingId) ??
      strOrNull(order?.receipt);
    const amountMinor = payment?.amount ?? order?.amount;
    if (!bookingId || typeof amountMinor !== 'number') return null;
    return { type, providerRef: payment?.id ?? order?.id ?? bookingId, bookingId, amountMinor };
  }

  private async handleRefund(p: RazorpayPayload): Promise<DispatchResult> {
    const refund = p.refund?.entity;
    if (!refund?.payment_id) return 'ignored';
    const payment = await this.prisma.payment.findFirst({
      where: { providerPaymentIntentId: refund.payment_id },
      select: {
        id: true,
        amountMinor: true,
        organizerNetMinor: true,
        refundedMinor: true,
        currency: true,
        booking: { select: { eventId: true } },
      },
    });
    if (!payment?.booking?.eventId) return 'ignored';
    const refundAmount = refund.amount ?? 0;
    const newTotal = payment.refundedMinor + refundAmount;
    // Idempotency: refund entity amount is per-refund; accumulate but never exceed capture.
    const cappedTotal = Math.min(newTotal, payment.amountMinor);
    const delta = cappedTotal - payment.refundedMinor;
    if (delta <= 0) return 'processed';
    const organizerShare =
      payment.amountMinor > 0
        ? Math.round((delta * payment.organizerNetMinor) / payment.amountMinor)
        : 0;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundedMinor: cappedTotal,
        status:
          cappedTotal >= payment.amountMinor
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    await this.settlements.applyRefund(
      payment.booking.eventId,
      refund.currency ?? 'inr',
      organizerShare,
    );
    return 'processed';
  }

  private async handleDispute(eventType: string, p: RazorpayPayload): Promise<DispatchResult> {
    const d = p.dispute?.entity;
    if (!d?.id) return 'ignored';
    // Map the Razorpay event to a status the shared dispute service understands.
    const status =
      eventType === 'payment.dispute.won'
        ? 'won'
        : eventType === 'payment.dispute.lost'
          ? 'lost'
          : (d.status ?? 'open');
    await this.disputes.syncFromWebhook(
      {
        id: d.id,
        payment_intent: d.payment_id ?? null,
        amount: d.amount ?? 0,
        currency: d.currency ?? 'inr',
        reason: d.reason_code ?? null,
        status,
      },
      PROVIDER,
    );
    return 'processed';
  }
}

function strOrNull(v: string | number | null | undefined): string | undefined {
  return v == null ? undefined : String(v);
}
