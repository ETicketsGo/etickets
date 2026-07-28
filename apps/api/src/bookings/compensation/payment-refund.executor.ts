import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BookingCompensation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { TransactionalEventPublisher, type DomainEvent } from '../../common/domain-events';
import {
  bookingPaymentRefundRequestedEvent,
  bookingPaymentRefundedEvent,
  bookingPaymentRefundPendingEvent,
  bookingPaymentRefundAmbiguousEvent,
  bookingPaymentRefundRejectedEvent,
  bookingRefundStatusRecoveryRequestedEvent,
  bookingRefundStatusRecoveredEvent,
} from '../../common/domain-events/catalogue/provider-compensation-events';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../../payments/provider/payment-provider.interface';
import { DefaultBookingRefundPolicy } from './booking-refund-policy';
import { CompensationType } from './compensation-types';

export type RefundExecutionOutcome =
  'REFUNDED' | 'PENDING' | 'RETRYABLE' | 'MANUAL_REVIEW' | 'NOT_ELIGIBLE';

/**
 * Controlled FULL-refund executor (ADR-043 §Phase 6, P5.3B). Refunds a captured payment ONLY
 * when a versioned server-side policy approves a FULL refund and every eligibility gate holds
 * (captured, not already refunded, amount == policy amount == captured, currency unchanged,
 * provider supports IDEMPOTENT full refund, no check-in, settlement not blocking, provider
 * cancellation done/not-required). Missing policy ⇒ MANUAL_ONLY ⇒ manual review. Intent
 * (BookingPaymentRefundRequested + a PENDING Refund row) is persisted BEFORE the external call;
 * the refund reuses the record's stable server key; a definitive success finalizes payment +
 * booking + Refund + compensation exactly once in ONE transaction. Ambiguous/timeout recovers
 * via refund-status query — never assumed. Refund amount never exceeds captured; currency never
 * changes; inventory is never auto-restored. Entirely gated by AUTO_REFUND (off; prod-forbidden).
 */
@Injectable()
export class PaymentRefundExecutor {
  private readonly logger = new Logger('PaymentRefundExecutor');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly publisher: TransactionalEventPublisher,
    private readonly policy: DefaultBookingRefundPolicy,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  private get statusRecoveryEnabled(): boolean {
    return this.config.get<boolean>('BOOKING_REFUND_STATUS_RECOVERY_ENABLED') === true;
  }

  async execute(comp: BookingCompensation): Promise<RefundExecutionOutcome> {
    const started = Date.now();
    if (comp.compensationType !== CompensationType.PAYMENT_REFUND) return 'NOT_ELIGIBLE';

    const booking = await this.prisma.booking
      .findUnique({
        where: { id: comp.bookingId },
        include: {
          payment: true,
          tickets: { select: { status: true } },
          eventSession: { select: { startsAt: true, status: true } },
          event: { select: { status: true } },
        },
      })
      .catch(() => null);
    if (!booking || !booking.payment) return this.review('BOOKING_OR_PAYMENT_MISSING');

    const workflow = await this.prisma.bookingWorkflow
      .findUnique({ where: { bookingId: comp.bookingId } })
      .catch(() => null);
    const providerCancellationRequired =
      workflow?.inventoryOwnershipMode === 'PROVIDER_AUTHORITATIVE' &&
      !workflow.providerCancelledAt;

    // ── Versioned policy decision (deterministic; server-authoritative) ──
    const decision = this.policy.evaluate({
      bookingId: booking.id,
      bookingStatus: booking.status,
      workflowState: workflow?.state,
      paymentStatus: booking.payment.status as string,
      paymentProvider: booking.payment.provider,
      amountPaidMinor: booking.payment.amountMinor,
      currency: booking.currency,
      ticketIssued: booking.tickets.length > 0,
      ticketCheckedIn: booking.tickets.some((t) => t.status === 'CHECKED_IN'),
      sessionStarted: !!booking.eventSession && booking.eventSession.startsAt < new Date(),
      eventCancelled: booking.event?.status === 'CANCELLED',
      customerCancellation: booking.status === 'CANCELLED',
      providerBookingStatus: workflow?.providerStatus ?? undefined,
      providerCancellationRequired,
      providerCancellationSupported: false, // confirmed-provider cancellation stays manual (Phase 6 defers)
      settlementStatus: undefined, // no per-booking settlement lookup wired → treated as uncertain
      requestedAt: new Date().toISOString(),
    });
    this.metrics.recordRefundPolicyDecision(
      this.policy.mode,
      decision.reasonCode.toLowerCase().slice(0, 40),
    );

    if (!decision.eligible || decision.refundType !== 'FULL' || decision.requiresManualReview) {
      return this.review(decision.reasonCode);
    }

    // ── Hard eligibility revalidation (defence in depth over the policy) ──
    const pay = booking.payment;
    if ((pay.status as string) === 'REFUNDED') return 'REFUNDED'; // already refunded → idempotent success
    if (pay.status !== 'SUCCEEDED') return this.review('PAYMENT_NOT_CAPTURED'); // SUCCEEDED = captured
    const caps = this.provider.capabilities;
    if (!caps.supportsFullRefund || !caps.supportsIdempotentRefund)
      return this.review('PROVIDER_NOT_REFUND_CAPABLE');
    const amount = decision.refundableAmountMinor ?? 0;
    // INVARIANTS: 0 < refund <= captured; currency unchanged.
    if (amount <= 0 || amount > pay.amountMinor) return this.review('REFUND_AMOUNT_INVARIANT');
    if (decision.refundableCurrency && decision.refundableCurrency !== booking.currency) {
      return this.review('CURRENCY_MISMATCH');
    }
    const providerRef = pay.providerRef ?? '';
    if (!providerRef) return this.review('PAYMENT_REFERENCE_MISSING');

    // ── Intent BEFORE the external call: durable Refund row (PROCESSING) + requested event ──
    await this.persistIntent(
      comp,
      booking.organizationId,
      amount,
      booking.currency,
      decision.policyVersion,
    ).catch(() => undefined);

    let outcome: RefundExecutionOutcome;
    try {
      const res = await this.provider.refund({
        providerRef,
        amountMinor: amount,
        reason: comp.reasonCode,
        currency: booking.currency,
      });
      if (res.status === 'COMPLETED') {
        if (caps.refundMayBeAsynchronous) {
          // Async provider: the initial 'COMPLETED' ack is only PENDING until confirmed.
          await this.emit(
            bookingPaymentRefundPendingEvent(this.base(comp, amount, booking.currency, 'PENDING')),
          );
          outcome = await this.recoverRefund(comp, providerRef, res.providerRef, booking, amount);
        } else {
          await this.finalizeRefunded(
            comp,
            booking,
            amount,
            res.providerRef,
            decision.policyVersion,
          );
          outcome = 'REFUNDED';
        }
      } else {
        outcome = this.rejected(comp, amount, booking.currency);
      }
    } catch {
      await this.emit(
        bookingPaymentRefundAmbiguousEvent(this.base(comp, amount, booking.currency, 'AMBIGUOUS')),
      );
      outcome = await this.recoverRefund(comp, providerRef, undefined, booking, amount);
    }
    this.metrics.recordPaymentRefund(this.provider.name, outcome.toLowerCase());
    this.metrics.observePaymentRefund(this.provider.name, (Date.now() - started) / 1000);
    return outcome;
  }

  /** Refund status recovery — never assumes success from a timeout. */
  private async recoverRefund(
    comp: BookingCompensation,
    providerRef: string,
    refundRef: string | undefined,
    booking: {
      id: string;
      currency: string;
      organizationId: string;
      payment: { amountMinor: number } | null;
    },
    amount: number,
  ): Promise<RefundExecutionOutcome> {
    if (
      !this.provider.capabilities.supportsRefundStatusQuery ||
      !this.provider.getRefund ||
      !this.statusRecoveryEnabled
    ) {
      return this.review('REFUND_STATUS_UNKNOWN');
    }
    await this.emit(
      bookingRefundStatusRecoveryRequestedEvent(
        this.base(comp, amount, booking.currency, 'STATUS_RECOVERY'),
      ),
    );
    const res = await this.provider.getRefund(refundRef ?? providerRef).catch(() => null);
    this.metrics.recordRefundStatusRecovery(
      this.provider.name,
      (res?.status ?? 'unknown').toLowerCase(),
    );
    if (res) {
      await this.emit(
        bookingRefundStatusRecoveredEvent(this.base(comp, amount, booking.currency, res.status)),
      );
    }
    if (res?.status === 'COMPLETED') {
      await this.finalizeRefunded(
        comp,
        booking,
        amount,
        res.providerRef ?? refundRef ?? 'recovered',
        this.policy.version,
      );
      return 'REFUNDED';
    }
    if (res?.status === 'FAILED') return this.rejected(comp, amount, booking.currency);
    return 'MANUAL_REVIEW'; // NOT_FOUND / unknown → manual review (bounded)
  }

  /** Durable refund intent (PROCESSING Refund row) + requested event, committed before the call. */
  private async persistIntent(
    comp: BookingCompensation,
    organizationId: string,
    amount: number,
    currency: string,
    policyVersion: string,
  ): Promise<void> {
    const evt = bookingPaymentRefundRequestedEvent(
      this.base(comp, amount, currency, 'REQUESTED', policyVersion),
    );
    await this.prisma.$transaction(async (tx) => {
      // Idempotent: one PROCESSING refund row per compensation (guarded on absence).
      const existing = await tx.refund.findFirst({
        where: { bookingId: comp.bookingId, reason: comp.idempotencyKey },
      });
      if (!existing) {
        await tx.refund.create({
          data: {
            bookingId: comp.bookingId,
            organizationId,
            amountMinor: amount,
            status: 'PROCESSING' as never,
            reason: comp.idempotencyKey, // stable key doubles as the dedupe marker
          },
        });
      }
      await this.publisher.recordInTransaction(tx, [evt]);
    });
    await this.publisher.deliverAfterCommit([evt]);
  }

  /**
   * Finalize a definitive refund EXACTLY ONCE in one transaction: payment→REFUNDED, booking→
   * REFUNDED, the Refund row→COMPLETED, and the durable events. Guarded on the payment not
   * already being REFUNDED so duplicate callbacks/recoveries finalize once; an outbox insert
   * failure rolls the whole finalization back (provider refund stays recoverable).
   */
  private async finalizeRefunded(
    comp: BookingCompensation,
    booking: { id: string; currency: string; payment: { amountMinor: number } | null },
    amount: number,
    providerRefundRef: string,
    policyVersion: string,
  ): Promise<void> {
    let emitted: DomainEvent[] = [];
    await this.prisma
      .$transaction(async (tx) => {
        const claim = await tx.payment.updateMany({
          where: { bookingId: comp.bookingId, status: 'SUCCEEDED' as never },
          // FULL refund: cumulative refundedMinor == captured (never exceeds it — invariant).
          data: { status: 'REFUNDED' as never, refundedMinor: amount },
        });
        if (claim.count !== 1) return; // already finalized → idempotent no-op
        await tx.booking.updateMany({
          where: { id: comp.bookingId },
          data: { status: 'REFUNDED' as never },
        });
        await tx.refund.updateMany({
          where: { bookingId: comp.bookingId, reason: comp.idempotencyKey },
          data: { status: 'COMPLETED' as never, providerRef: providerRefundRef },
        });
        emitted = [
          bookingPaymentRefundedEvent(
            this.base(comp, amount, booking.currency, 'REFUNDED', policyVersion),
          ),
        ];
        await this.publisher.recordInTransaction(tx, emitted);
      })
      .catch((err) => {
        emitted = [];
        this.logger.error(
          `refund finalization failed for booking=${comp.bookingId}; recoverable`,
          err as Error,
        );
        throw err;
      });
    if (emitted.length) await this.publisher.deliverAfterCommit(emitted);
  }

  private async emit(event: DomainEvent): Promise<void> {
    await this.prisma
      .$transaction((tx) => this.publisher.recordInTransaction(tx, [event]))
      .catch(() => undefined);
    await this.publisher.deliverAfterCommit([event]).catch(() => undefined);
  }

  private base(
    comp: BookingCompensation,
    amount: number,
    currency: string,
    category: string,
    policyVersion?: string,
  ) {
    return {
      bookingId: comp.bookingId,
      workflowId: comp.workflowId ?? undefined,
      compensationId: comp.id,
      compensationType: CompensationType.PAYMENT_REFUND,
      paymentProvider: comp.paymentProvider ?? this.provider.name,
      paymentStateCategory: category,
      amount: String(amount),
      currency,
      attempt: comp.attemptCount,
      reasonCode: policyVersion ?? comp.reasonCode,
      occurredAt: new Date().toISOString(),
    };
  }

  private rejected(
    comp: BookingCompensation,
    amount: number,
    currency: string,
  ): RefundExecutionOutcome {
    void this.emit(
      bookingPaymentRefundRejectedEvent(this.base(comp, amount, currency, 'REJECTED')),
    );
    return 'MANUAL_REVIEW';
  }

  private review(reason: string): RefundExecutionOutcome {
    this.metrics.recordPaymentRefund(
      this.provider.name,
      `review_${reason.toLowerCase()}`.slice(0, 40),
    );
    return 'MANUAL_REVIEW';
  }
}
