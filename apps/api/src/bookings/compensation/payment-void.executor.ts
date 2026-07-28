import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BookingCompensation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { TransactionalEventPublisher, type DomainEvent } from '../../common/domain-events';
import {
  bookingPaymentVoidRequestedEvent,
  bookingPaymentVoidedEvent,
  bookingPaymentVoidAmbiguousEvent,
  bookingPaymentVoidRejectedEvent,
  bookingPaymentStatusRecoveryRequestedEvent,
  bookingPaymentStatusRecoveredEvent,
  bookingManualReviewRequiredEvent,
} from '../../common/domain-events/catalogue/provider-compensation-events';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type PaymentLifecycleStatus,
} from '../../payments/provider/payment-provider.interface';
import { CompensationRepository } from './compensation.repository';
import { CompensationType } from './compensation-types';

/** Executor result consumed by the compensation worker. */
export type VoidExecutionOutcome =
  'VOIDED' | 'RETRYABLE' | 'MANUAL_REVIEW' | 'SUPERSEDED_BY_REFUND' | 'NOT_ELIGIBLE';

/**
 * Controlled payment VOID executor (ADR-043 §Phase 5, P5.3B). Cancels an authorization ONLY
 * when it is definitively AUTHORIZED-not-captured, the booking is unconfirmed + unticketed, and
 * the active provider genuinely supports idempotent void. A captured payment NEVER reaches the
 * void call — it is handed off to a single PAYMENT_REFUND plan (which is NOT executed here).
 * Intent (BookingPaymentVoidRequested) is emitted before the call; the void reuses the record's
 * stable server-generated idempotency key; a definitive success finalizes the payment→VOIDED
 * exactly once (guarded DB update + BookingPaymentVoided in the same tx). Ambiguous/timeout is
 * NEVER assumed — it recovers via payment status query. Nothing here refunds or moves captured
 * money. Entirely gated by BOOKING_COMPENSATION_AUTO_VOID_ENABLED (off; prod-forbidden).
 */
@Injectable()
export class PaymentVoidExecutor {
  private readonly logger = new Logger('PaymentVoidExecutor');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly publisher: TransactionalEventPublisher,
    private readonly repo: CompensationRepository,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  private get statusRecoveryEnabled(): boolean {
    return this.config.get<boolean>('BOOKING_PAYMENT_STATUS_RECOVERY_ENABLED') === true;
  }

  async execute(comp: BookingCompensation): Promise<VoidExecutionOutcome> {
    const started = Date.now();
    if (comp.compensationType !== CompensationType.PAYMENT_VOID) return 'NOT_ELIGIBLE';

    const booking = await this.prisma.booking
      .findUnique({
        where: { id: comp.bookingId },
        include: { payment: true, tickets: { select: { id: true }, take: 1 } },
      })
      .catch(() => null);
    if (!booking || !booking.payment) return this.review(comp, 'BOOKING_OR_PAYMENT_MISSING');

    // Never auto-void a confirmed or ticket-issued booking.
    if (booking.status === 'CONFIRMED' || booking.tickets.length > 0) {
      return this.review(comp, 'BOOKING_CONFIRMED_OR_TICKETED');
    }
    // Currency + amount must match the authoritative payment.
    if (comp.currency && comp.currency !== booking.currency)
      return this.review(comp, 'CURRENCY_MISMATCH');
    if (comp.amountMinor != null && comp.amountMinor !== booking.payment.amountMinor) {
      return this.review(comp, 'AMOUNT_MISMATCH');
    }
    // Provider must genuinely support idempotent void.
    const caps = this.provider.capabilities;
    if (
      !caps.supportsAuthorizeCapture ||
      !caps.supportsVoid ||
      !caps.supportsIdempotentVoid ||
      !this.provider.cancel
    ) {
      return this.review(comp, 'PROVIDER_NOT_VOID_CAPABLE');
    }

    const providerRef = booking.payment.providerRef ?? '';
    if (!providerRef) return this.review(comp, 'PAYMENT_REFERENCE_MISSING');

    // Decide from the authoritative local payment state.
    const local = booking.payment.status as string;
    if (local === 'VOIDED') return 'VOIDED'; // already voided → idempotent success
    if (local === 'SUCCEEDED' || local === 'CAPTURED') {
      return this.handoffToRefund(comp, booking.currency, booking.payment.amountMinor);
    }
    if (local !== 'AUTHORIZED') {
      // Not definitively authorized — recover via status query before ever calling void.
      const recovered = await this.recoverStatus(comp, providerRef);
      if (recovered === 'AUTHORIZED') {
        // fallthrough to void below
      } else if (recovered === 'CAPTURED') {
        return this.handoffToRefund(comp, booking.currency, booking.payment.amountMinor);
      } else if (recovered === 'VOIDED' || recovered === 'CANCELLED') {
        await this.finalizeVoided(comp, booking.currency, booking.payment.amountMinor);
        return 'VOIDED';
      } else {
        return this.review(comp, 'PAYMENT_STATE_UNCERTAIN');
      }
    }

    // ── Eligible: AUTHORIZED-not-captured. Persist intent BEFORE the provider call. ──
    await this.emit(
      bookingPaymentVoidRequestedEvent(
        this.base(comp, booking.currency, booking.payment.amountMinor, 'AUTHORIZED'),
      ),
    ).catch(() => undefined);

    let outcome: VoidExecutionOutcome;
    try {
      const res = await this.provider.cancel({ providerRef });
      const s = res.status as PaymentLifecycleStatus;
      if (s === 'CANCELLED') {
        // Provider-level CANCELLED = the authorization was voided (no funds moved).
        await this.finalizeVoided(comp, booking.currency, booking.payment.amountMinor);
        outcome = 'VOIDED';
      } else if (s === 'CAPTURED' || s === 'SUCCEEDED') {
        outcome = await this.handoffToRefund(comp, booking.currency, booking.payment.amountMinor);
      } else {
        outcome = this.reviewSync(
          comp,
          'PROVIDER_NOT_VOIDABLE',
          booking.currency,
          booking.payment.amountMinor,
        );
      }
    } catch {
      // Never assume success/failure — recover via status query.
      await this.emit(
        bookingPaymentVoidAmbiguousEvent(
          this.base(comp, booking.currency, booking.payment.amountMinor, 'AMBIGUOUS'),
        ),
      ).catch(() => undefined);
      const recovered = await this.recoverStatus(comp, providerRef);
      if (recovered === 'VOIDED' || recovered === 'CANCELLED') {
        await this.finalizeVoided(comp, booking.currency, booking.payment.amountMinor);
        outcome = 'VOIDED';
      } else if (recovered === 'AUTHORIZED') {
        outcome = 'RETRYABLE'; // still authorized — safe to retry the idempotent void
      } else if (recovered === 'CAPTURED') {
        outcome = await this.handoffToRefund(comp, booking.currency, booking.payment.amountMinor);
      } else {
        outcome = this.reviewSync(
          comp,
          'PAYMENT_STATUS_UNKNOWN',
          booking.currency,
          booking.payment.amountMinor,
        );
      }
    }
    this.metrics.recordPaymentVoid(this.provider.name, outcome.toLowerCase());
    this.metrics.observePaymentVoid(this.provider.name, (Date.now() - started) / 1000);
    return outcome;
  }

  /** Finalize payment→VOIDED exactly once (guarded) + emit BookingPaymentVoided in the same tx. */
  private async finalizeVoided(
    comp: BookingCompensation,
    currency: string,
    amountMinor: number,
  ): Promise<void> {
    let emitted: DomainEvent | null = null;
    await this.prisma
      .$transaction(async (tx) => {
        const claim = await tx.payment.updateMany({
          where: {
            bookingId: comp.bookingId,
            status: { in: ['AUTHORIZED', 'PROCESSING'] as never },
          },
          data: { status: 'VOIDED' as never },
        });
        if (claim.count === 1) {
          const evt = bookingPaymentVoidedEvent(this.base(comp, currency, amountMinor, 'VOIDED'));
          await this.publisher.recordInTransaction(tx, [evt]);
          emitted = evt;
        }
      })
      .catch((err) =>
        this.logger.error(`finalizeVoided failed for booking=${comp.bookingId}`, err as Error),
      );
    if (emitted) await this.publisher.deliverAfterCommit([emitted]);
  }

  /**
   * Captured-payment handoff: create ONE PAYMENT_REFUND plan (idempotent via the unique
   * constraint) and supersede this void. NEVER executes the refund (Phase 6).
   */
  private async handoffToRefund(
    comp: BookingCompensation,
    currency: string,
    amountMinor: number,
  ): Promise<VoidExecutionOutcome> {
    await this.repo
      .createOrGet(
        {
          compensationType: CompensationType.PAYMENT_REFUND,
          reasonCode: 'PAYMENT_CAPTURED_VOID_SUPERSEDED',
          targetReference: comp.paymentReference ?? comp.bookingId,
          autoExecutable: false,
          amountMinor,
          currency,
        },
        {
          bookingId: comp.bookingId,
          workflowId: comp.workflowId ?? undefined,
          tenantId: comp.tenantId ?? undefined,
          correlationId: comp.correlationId ?? undefined,
          paymentProvider: comp.paymentProvider ?? this.provider.name,
          paymentReference: comp.paymentReference ?? undefined,
        },
      )
      .catch(() => undefined);
    await this.emit(
      bookingManualReviewRequiredEvent({
        bookingId: comp.bookingId,
        compensationId: comp.id,
        reasonCode: 'PAYMENT_CAPTURED_VOID_SUPERSEDED',
        occurredAt: new Date().toISOString(),
      }),
    ).catch(() => undefined);
    this.metrics.recordPaymentVoid(this.provider.name, 'superseded_by_refund');
    return 'SUPERSEDED_BY_REFUND';
  }

  /** Query provider payment status; returns a normalized lifecycle status or 'UNKNOWN'. */
  private async recoverStatus(comp: BookingCompensation, providerRef: string): Promise<string> {
    if (
      !this.provider.capabilities.supportsPaymentStatusQuery ||
      !this.provider.getPayment ||
      !this.statusRecoveryEnabled
    ) {
      return 'UNKNOWN';
    }
    await this.emit(
      bookingPaymentStatusRecoveryRequestedEvent({
        bookingId: comp.bookingId,
        compensationId: comp.id,
        reasonCode: 'STATUS_RECOVERY',
        occurredAt: new Date().toISOString(),
      }),
    ).catch(() => undefined);
    const res = await this.provider.getPayment(providerRef).catch(() => null);
    this.metrics.recordPaymentStatusRecovery(
      this.provider.name,
      (res?.status ?? 'unknown').toLowerCase(),
    );
    if (res) {
      await this.emit(
        bookingPaymentStatusRecoveredEvent(
          this.base(comp, res.currency, res.amountMinor, res.status),
        ),
      ).catch(() => undefined);
    }
    return res?.status ?? 'UNKNOWN';
  }

  private async emit(event: DomainEvent): Promise<void> {
    await this.prisma.$transaction((tx) => this.publisher.recordInTransaction(tx, [event]));
    await this.publisher.deliverAfterCommit([event]);
  }

  private base(comp: BookingCompensation, currency: string, amountMinor: number, category: string) {
    return {
      bookingId: comp.bookingId,
      workflowId: comp.workflowId ?? undefined,
      compensationId: comp.id,
      compensationType: CompensationType.PAYMENT_VOID,
      paymentProvider: comp.paymentProvider ?? this.provider.name,
      paymentStateCategory: category,
      amount: String(amountMinor),
      currency,
      attempt: comp.attemptCount,
      reasonCode: comp.reasonCode,
      occurredAt: new Date().toISOString(),
    };
  }

  private async review(comp: BookingCompensation, reason: string): Promise<VoidExecutionOutcome> {
    this.metrics.recordPaymentVoid(
      this.provider.name,
      `review_${reason.toLowerCase()}`.slice(0, 40),
    );
    void comp;
    void reason;
    return 'MANUAL_REVIEW';
  }

  private reviewSync(
    comp: BookingCompensation,
    reason: string,
    currency: string,
    amountMinor: number,
  ): VoidExecutionOutcome {
    void this.emit(
      bookingPaymentVoidRejectedEvent(this.base(comp, currency, amountMinor, reason)),
    ).catch(() => undefined);
    return 'MANUAL_REVIEW';
  }
}
