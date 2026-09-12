import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentStatus,
  RefundStatus,
  WebhookProcessingStatus,
  razorpayFailureReason,
} from '@eticketsgo/shared-types';
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
  /** Present on a failed payment. `error_description` is merchant prose and is never kept. */
  error_code?: string | null;
  error_reason?: string | null;
  error_source?: string | null;
  error_step?: string | null;
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
        record.id,
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

  private async dispatch(
    webhookEventId: string,
    eventType: string,
    payload: StoredPayload,
  ): Promise<DispatchResult> {
    const p = payload.object;
    switch (eventType) {
      case 'order.paid':
      case 'payment.captured':
        return this.handlePayment(this.toPaymentEvent(p, 'payment.succeeded'));
      case 'payment.failed':
        return this.handlePayment(this.toPaymentEvent(p, 'payment.failed'));
      /*
        Only `refund.processed` moves the ledger.

        `refund.created` and `refund.processed` both carry the same refund entity, and both
        used to add its amount to `refundedMinor` and deduct it from the settlement — every
        Razorpay refund was counted twice. `created` means "accepted, not paid"; nothing about
        the money has happened yet, so it is acknowledged and nothing else.
      */
      case 'refund.processed':
        return this.handleRefund(webhookEventId, p);
      case 'refund.created':
        return 'ignored';
      case 'refund.failed':
        return this.handleRefundFailed(p);
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
        // Acknowledged, no state change (settlement.* are Razorpay's own bank settlements
        // to the platform; authorized precedes captured). Recorded as IGNORED, never dropped.
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
    return {
      type,
      providerRef: payment?.id ?? order?.id ?? bookingId,
      bookingId,
      amountMinor,
      /*
        Why it failed, reduced to our own reason. Razorpay said "this business accepts domestic
        (Indian) card payments only" and the buyer was told to "try again" with the same card.
      */
      ...(type === 'payment.failed'
        ? {
            failure: {
              reason: razorpayFailureReason({
                code: payment?.error_code,
                reason: payment?.error_reason,
                source: payment?.error_source,
                step: payment?.error_step,
              }),
              providerCode: payment?.error_reason ?? payment?.error_code ?? null,
            },
          }
        : {}),
    };
  }

  private async handleRefund(webhookEventId: string, p: RazorpayPayload): Promise<DispatchResult> {
    const refund = p.refund?.entity;
    if (!refund?.payment_id) return 'ignored';
    const payment = await this.prisma.payment.findFirst({
      where: { providerPaymentIntentId: refund.payment_id },
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

    // Our own refund row first: if it is still being written, this throws and the event is
    // retried BEFORE the ledger below is touched, so the retry cannot add the amount twice.
    if (refund.id) {
      await this.settleRefundRow(refund.id, payment.bookingId, RefundStatus.COMPLETED);
    }

    /*
      Once per Razorpay refund, not once per delivery.

      Deliveries are deduplicated on the event id at ingestion, but a refund can still reach
      here twice under two ids. There is no column for the provider refund id on the payment,
      so the durable webhook store is asked instead: has another `refund.processed` for this
      same refund already been handled (or is being handled right now)?
    */
    if (refund.id) {
      const sibling = await this.prisma.webhookEvent.findFirst({
        where: {
          provider: PROVIDER,
          eventType: 'refund.processed',
          id: { not: webhookEventId },
          processingStatus: {
            in: [WebhookProcessingStatus.PROCESSED, WebhookProcessingStatus.PROCESSING],
          },
          payload: { path: ['object', 'refund', 'entity', 'id'], equals: refund.id },
        },
        select: { id: true },
      });
      if (sibling) return 'processed';
    }

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

  /**
   * Razorpay could not pay a refund it had accepted.
   *
   * The refund row was left PROCESSING when Razorpay answered `pending`, and the tickets were
   * already returned, because at that point the refund was committed at the provider. Nothing
   * can be undone automatically — the seats may have been resold — so the row is marked FAILED,
   * which takes it out of the open-refund set, and the failure is audited and logged at error
   * level for somebody to pay the customer by hand.
   */
  private async handleRefundFailed(p: RazorpayPayload): Promise<DispatchResult> {
    const refund = p.refund?.entity;
    if (!refund?.id) return 'ignored';
    const payment = refund.payment_id
      ? await this.prisma.payment.findFirst({
          where: { providerPaymentIntentId: refund.payment_id },
          select: { bookingId: true },
        })
      : null;
    const row = await this.settleRefundRow(refund.id, payment?.bookingId, RefundStatus.FAILED);
    if (!row) return 'ignored';
    this.logger.error(
      `Razorpay refund ${refund.id} FAILED at the provider (refund ${row.id}, booking ${row.bookingId}). ` +
        'Its tickets were already cancelled; the customer must be refunded manually.',
    );
    await this.audit.record({
      organizationId: row.organizationId,
      action: 'REFUND_FAILED_AT_PROVIDER',
      entityType: 'Refund',
      entityId: row.id,
      metadata: {
        provider: PROVIDER,
        providerRefundId: refund.id,
        amountMinor: refund.amount ?? row.amountMinor,
        bookingId: row.bookingId,
      },
    });
    return 'processed';
  }

  /**
   * Move our Refund row for a Razorpay refund to its final state.
   *
   * Returns the row when it was changed, or null when there is no row (a refund issued from
   * the Razorpay dashboard) or it was already final. Throws — so the event is retried — when a
   * refund of ours on this booking is still between the provider call and its commit: the row
   * exists but does not carry the provider id yet, and finalising nothing would leave it
   * PROCESSING for ever.
   */
  private async settleRefundRow(
    providerRefundId: string,
    bookingId: string | undefined,
    to: typeof RefundStatus.COMPLETED | typeof RefundStatus.FAILED,
  ): Promise<{
    id: string;
    bookingId: string;
    organizationId: string;
    amountMinor: number;
  } | null> {
    const row = await this.prisma.refund.findFirst({
      where: { providerRef: providerRefundId },
      select: { id: true, bookingId: true, organizationId: true, amountMinor: true, status: true },
    });
    if (!row) {
      const inFlight = bookingId
        ? await this.prisma.refund.findFirst({
            where: { bookingId, status: RefundStatus.PROCESSING, providerRef: null },
            select: { id: true },
          })
        : null;
      if (inFlight) {
        throw new Error(
          `Refund ${inFlight.id} is still being recorded; retrying Razorpay refund ${providerRefundId}.`,
        );
      }
      return null;
    }
    // COMPLETED only from PROCESSING; FAILED from anything not already FAILED.
    const from =
      to === RefundStatus.COMPLETED
        ? [RefundStatus.PROCESSING]
        : [RefundStatus.PROCESSING, RefundStatus.COMPLETED, RefundStatus.REQUESTED];
    const moved = await this.prisma.refund.updateMany({
      where: { id: row.id, status: { in: from } },
      data: { status: to },
    });
    return moved.count === 1 ? row : null;
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
