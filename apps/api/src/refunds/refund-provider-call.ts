import { HttpStatus } from '@nestjs/common';
import { RefundStatus } from '@eticketsgo/shared-types';
import type { PrismaService } from '../prisma/prisma.service';
import type { PaymentsService } from '../payments/payments.service';
import type { AuditService } from '../audit/audit.service';
import type { RefundResult } from '../payments/provider/payment-provider.interface';
import { AppException, ErrorCodes } from '../common/errors';
import { keyGeneration, reconcileRefund, refundKey, type Reconciliation } from './refund-reconcile';

/** Who asked for the call: recorded on the attempt row so its history reads plainly. */
export type CallTrigger = 'APPROVAL' | 'ADMIN_RETRY';

export interface CallTarget {
  refund: {
    id: string;
    bookingId: string;
    organizationId: string;
    amountMinor: number;
    reason: string;
    createdAt: Date;
  };
  payment: { provider: string; providerRef: string | null } | null;
  currency: string;
  actorUserId: string;
  trigger: CallTrigger;
}

export type CallOutcome =
  /** The provider answered, directly or through a lookup after a lost answer. */
  | { kind: 'ANSWERED'; result: RefundResult; via: 'CALL' | 'LOOKUP' }
  /** Two calls lost their answers and the provider shows no refund after either. No money moved. */
  | { kind: 'NOT_REFUNDED'; message: string }
  /** The answer was lost and the provider could not settle it. Held for a person. */
  | { kind: 'UNRESOLVED'; reason: string };

/** At most the call, and ONE resend under the same key after the provider showed no refund. */
const MAX_CALLS = 2;

/**
 * Sends one refund to its payment provider so that a lost answer can never pay twice.
 *
 *   1. Before the call, an attempt row is written with the key the call will carry, and the
 *      refund's call counter is advanced with a conditional UPDATE. Both happen in one
 *      transaction, guarded by `@@unique([refundId, attemptNo])` and by the refund being
 *      PROCESSING (claimed): two processes cannot both send attempt N.
 *   2. The call is sent ONCE. The orchestrator no longer retries refund calls.
 *   3. If it throws, the provider is asked for the payment's refunds (`refund-reconcile.ts`):
 *        FOUND        it is recorded as the provider's answer; nothing is sent again.
 *        REFUSED      it is the provider's refusal.
 *        NONE         it is sent again once, under the SAME key.
 *        otherwise    the refund is held for manual review with the reason. Nothing is resent.
 *
 * A plain class built by `RefundsService` rather than a Nest provider, so the service's
 * constructor (and every spec that builds it) is unchanged.
 */
export class RefundProviderCalls {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  async send(t: CallTarget): Promise<CallOutcome> {
    const paymentRef = t.payment?.providerRef ?? 'mock';
    const key = await this.keyFor(t.refund.id);
    for (let n = 1; n <= MAX_CALLS; n += 1) {
      const attempt = await this.begin(t.refund.id, key, n === 1 ? t.trigger : 'AUTO_RESEND');
      let result: RefundResult;
      try {
        result = await this.payments.refundPayment(
          paymentRef,
          t.refund.amountMinor,
          t.refund.reason,
          // Keep the refund on the gateway that captured the payment.
          t.payment?.provider,
          // Currency lets PayPal/Square format a partial refund.
          t.currency,
          key,
        );
      } catch (err) {
        await this.finish(attempt.id, 'UNKNOWN', null, messageOf(err));
        const rec = await this.lookup(t, paymentRef, key);
        await this.audit.record({
          actorUserId: t.actorUserId,
          organizationId: t.refund.organizationId,
          action: 'REFUND_PROVIDER_LOOKUP',
          entityType: 'Refund',
          entityId: t.refund.id,
          metadata: {
            attemptNo: attempt.attemptNo,
            idempotencyKey: key,
            result: rec.kind,
            ...('record' in rec ? { providerRef: rec.record.refundRef } : {}),
            ...('reason' in rec ? { reason: rec.reason } : {}),
          },
        });
        if (rec.kind === 'FOUND' || rec.kind === 'REFUSED') {
          return {
            kind: 'ANSWERED',
            result: { providerRef: rec.record.refundRef, status: rec.record.status },
            via: 'LOOKUP',
          };
        }
        if (rec.kind === 'NONE') continue; // clearly no refund: one resend under the same key
        await this.holdForReview(t, rec.reason);
        return { kind: 'UNRESOLVED', reason: rec.reason };
      }
      await this.finish(
        attempt.id,
        result.status === 'FAILED' ? 'REFUSED' : 'ACCEPTED',
        result.providerRef,
        null,
      );
      return { kind: 'ANSWERED', result, via: 'CALL' };
    }
    return {
      kind: 'NOT_REFUNDED',
      message:
        'The payment provider did not answer, and it shows no refund for this payment. No money moved.',
    };
  }

  /** Ask the provider for the payment's refunds, and judge them. Reads only. */
  async lookup(
    t: Pick<CallTarget, 'refund' | 'payment'>,
    paymentRef: string,
    currentKey: string | null,
  ): Promise<Reconciliation> {
    let records;
    try {
      records = await this.payments.findProviderRefunds(paymentRef, t.payment?.provider);
    } catch (err) {
      return {
        kind: 'UNAVAILABLE',
        reason: `The payment provider could not be asked whether it made this refund: ${messageOf(err)}`,
      };
    }
    const siblings = await this.prisma.refund.findMany({
      where: { bookingId: t.refund.bookingId, id: { not: t.refund.id } },
      select: { providerRef: true },
    });
    return reconcileRefund(records, {
      refundId: t.refund.id,
      amountMinor: t.refund.amountMinor,
      currentKey,
      knownRefs: siblings.map((s) => s.providerRef).filter((r): r is string => !!r),
      askedAt: t.refund.createdAt,
    });
  }

  /**
   * The key the next call carries. Reused after a lost answer (the last attempt is UNKNOWN or
   * never finished), so Stripe returns the first refund; a new generation after the provider
   * gave a definite answer to the old key, or on the first call ever.
   */
  private async keyFor(refundId: string): Promise<string> {
    const row = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        providerIdempotencyKey: true,
        providerAttempts: {
          orderBy: { attemptNo: 'desc' },
          take: 1,
          select: { outcome: true, idempotencyKey: true },
        },
      },
    });
    const current = row?.providerIdempotencyKey ?? null;
    const last = row?.providerAttempts?.[0];
    const answered = last && (last.outcome === 'REFUSED' || last.outcome === 'ACCEPTED');
    if (current && !answered) return current;
    const generation = current ? (keyGeneration(current, refundId) ?? 1) + 1 : 1;
    const next = refundKey(refundId, generation);
    const moved = await this.prisma.refund.updateMany({
      where: { id: refundId, providerIdempotencyKey: current },
      data: { providerIdempotencyKey: next },
    });
    if (moved.count !== 1) throw alreadySending();
    return next;
  }

  /** Write the attempt row and advance the counter together, or refuse. Before any money call. */
  private begin(refundId: string, key: string, trigger: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.refund.findUnique({
        where: { id: refundId },
        select: { providerCallCount: true },
      });
      const count = row?.providerCallCount ?? 0;
      const moved = await tx.refund.updateMany({
        where: { id: refundId, status: RefundStatus.PROCESSING, providerCallCount: count },
        data: { providerCallCount: count + 1 },
      });
      if (moved.count !== 1) throw alreadySending();
      return tx.refundProviderAttempt.create({
        data: { refundId, attemptNo: count + 1, idempotencyKey: key, trigger },
        select: { id: true, attemptNo: true },
      });
    });
  }

  private async finish(
    attemptId: string,
    outcome: 'ACCEPTED' | 'REFUSED' | 'UNKNOWN',
    providerRefundRef: string | null,
    detail: string | null,
  ) {
    await this.prisma.refundProviderAttempt
      .update({
        where: { id: attemptId },
        data: { outcome, providerRefundRef, detail: detail?.slice(0, 500), finishedAt: new Date() },
      })
      .catch(() => undefined);
  }

  /** The manual-intervention state: a reason a person can act on, and when it was set. */
  private async holdForReview(t: CallTarget, reason: string) {
    await this.prisma.refund.update({
      where: { id: t.refund.id },
      data: { manualReviewReason: reason.slice(0, 500), manualReviewAt: new Date() },
    });
    await this.audit.record({
      actorUserId: t.actorUserId,
      organizationId: t.refund.organizationId,
      action: 'REFUND_NEEDS_MANUAL_REVIEW',
      entityType: 'Refund',
      entityId: t.refund.id,
      metadata: { reason: reason.slice(0, 300) },
    });
  }
}

function alreadySending() {
  return new AppException(
    ErrorCodes.CONFLICT,
    'This refund is already being sent to the payment provider.',
    HttpStatus.CONFLICT,
  );
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
