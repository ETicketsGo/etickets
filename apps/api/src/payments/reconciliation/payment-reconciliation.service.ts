import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import type { PaymentStatusResult } from '../provider/payment-provider.interface';

export type ReconcileVerdict = 'matched' | 'mismatched' | 'unverifiable';

/**
 * Why a payment was reported as mismatched. One code per finding, the first that applies, so an
 * operator reads the most serious disagreement first rather than a list of consequences of it.
 */
export type ReconcileReason =
  | 'AMOUNT_DIFFERS' // the provider holds a different captured amount from ours
  | 'NEGATIVE_REFUND' // Payment.refundedMinor < 0 - must never happen
  | 'OVER_REFUND' // more refunded (recorded or by refund rows) than was captured
  | 'DUPLICATE_REFUND' // two completed refunds carry the same provider refund reference
  | 'REFUND_ROWS_DISAGREE' // completed refund rows do not add up to Payment.refundedMinor
  | 'STATUS_DISAGREES_WITH_REFUNDS' // our status does not describe the amount refunded
  | 'PROVIDER_STATUS_DIFFERS'; // the provider's status does not describe our position

/** A refund row as reconciliation reads it. Only COMPLETED ones count as money returned. */
export interface ReconcileRefundRow {
  status: string;
  amountMinor: number;
  providerRef: string | null;
}

/** Our side of a payment: the Payment row plus every Refund row on its booking. */
export interface ReconcileOurPayment {
  status: string;
  amountMinor: number;
  refundedMinor: number;
  refunds: ReconcileRefundRow[];
}

export interface ReconcileOutcome {
  verdict: ReconcileVerdict;
  reason?: ReconcileReason;
}

const PROVIDER_HOLDS_FUNDS = new Set(['CAPTURED', 'SUCCEEDED']);

/**
 * Compare our recorded payment against the provider's truth. Pure and unit-testable.
 *
 * A null provider result (adapter can't be queried) is "unverifiable". Everything else is judged
 * on the money position, not on our status name alone.
 *
 * ── WHY A PARTIAL REFUND IS NOT A MISMATCH ─────────────────────────────────
 * This used to count only SUCCEEDED as "settled" on our side. A partly refunded payment is
 * PARTIALLY_REFUNDED here while Razorpay keeps it `captured` (its status changes to `refunded`
 * only once the whole amount has gone back), so every healthy partial refund - including the
 * common case of a buyer refund that returns the tickets but keeps the fees - was reported as
 * mismatched. On QA that was 5 of 27 payments, and noise like that hides the real ones.
 *
 * A partial refund is valid when the captured amounts agree, the completed refund rows add up to
 * Payment.refundedMinor, that total is above zero and below the capture, our status says
 * PARTIALLY_REFUNDED, and the provider still holds the payment as captured. Anything else that
 * involves refunds is still reported, with a reason.
 *
 * Read-only: this decides what a report says. It changes no row and moves no money.
 */
export function reconcilePaymentDetailed(
  our: ReconcileOurPayment,
  provider: PaymentStatusResult | null,
): ReconcileOutcome {
  if (!provider) return { verdict: 'unverifiable' };
  const mismatch = (reason: ReconcileReason): ReconcileOutcome => ({
    verdict: 'mismatched',
    reason,
  });

  // The provider reports the ORIGINAL captured amount whether or not part of it was refunded.
  if (our.amountMinor !== provider.amountMinor) return mismatch('AMOUNT_DIFFERS');

  const refunded = our.refundedMinor;
  if (refunded < 0) return mismatch('NEGATIVE_REFUND');

  // A refund that is requested, processing or failed has returned nothing, so only COMPLETED
  // rows are money back. A failed refund that was counted anyway shows up as a disagreement
  // between these rows and refundedMinor below.
  const completed = our.refunds.filter((r) => r.status === 'COMPLETED');
  const completedSum = completed.reduce((sum, r) => sum + r.amountMinor, 0);
  if (refunded > our.amountMinor || completedSum > our.amountMinor) return mismatch('OVER_REFUND');

  const refs = completed.map((r) => r.providerRef).filter((ref): ref is string => !!ref);
  if (new Set(refs).size !== refs.length) return mismatch('DUPLICATE_REFUND');

  if (completedSum !== refunded) return mismatch('REFUND_ROWS_DISAGREE');

  const providerHoldsFunds = PROVIDER_HOLDS_FUNDS.has(provider.status);

  if (refunded === 0) {
    if (our.status === 'REFUNDED' || our.status === 'PARTIALLY_REFUNDED') {
      return mismatch('STATUS_DISAGREES_WITH_REFUNDS');
    }
    // No refund in play: the original rule - both settled or both not, at the same amount.
    const settledOur = our.status === 'SUCCEEDED';
    return settledOur === providerHoldsFunds
      ? { verdict: 'matched' }
      : mismatch('PROVIDER_STATUS_DIFFERS');
  }

  if (refunded < our.amountMinor) {
    if (our.status !== 'PARTIALLY_REFUNDED') return mismatch('STATUS_DISAGREES_WITH_REFUNDS');
    return providerHoldsFunds ? { verdict: 'matched' } : mismatch('PROVIDER_STATUS_DIFFERS');
  }

  // Fully refunded: both sides must say so.
  if (our.status !== 'REFUNDED') return mismatch('STATUS_DISAGREES_WITH_REFUNDS');
  return provider.status === 'REFUNDED'
    ? { verdict: 'matched' }
    : mismatch('PROVIDER_STATUS_DIFFERS');
}

/** The verdict alone, for callers that only count. */
export function reconcilePayment(
  our: ReconcileOurPayment,
  provider: PaymentStatusResult | null,
): ReconcileVerdict {
  return reconcilePaymentDetailed(our, provider).verdict;
}

export interface ReconcileMismatch {
  bookingId: string;
  provider: string;
  providerRef: string;
  ourStatus: string;
  providerStatus: string;
  ourAmountMinor: number;
  providerAmountMinor: number;
  /** Payment.refundedMinor, so a refund-related finding can be read without another lookup. */
  ourRefundedMinor: number;
  reason: ReconcileReason;
}

export interface ReconciliationReport {
  window: { from: string; to: string };
  checked: number;
  matched: number;
  mismatched: number;
  unverifiable: number;
  mismatches: ReconcileMismatch[];
}

export interface SettlementLine {
  provider: string;
  currency: string;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  count: number;
}

/**
 * Reconciliation + settlement for the payment platform (ADR-023). Reconciliation
 * checks our payments against each provider's authoritative status (via the
 * adapter's optional getPayment); settlement summarises money movement per provider
 * and currency. Both are read-only, audited, and surfaced to admins.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentProviderRegistry,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
  ) {}

  async reconcile(from: Date, to: Date): Promise<ReconciliationReport> {
    const payments = await this.prisma.payment.findMany({
      where: { createdAt: { gte: from, lte: to }, providerRef: { not: null } },
      select: {
        bookingId: true,
        provider: true,
        providerRef: true,
        status: true,
        amountMinor: true,
        refundedMinor: true,
        booking: {
          select: { refunds: { select: { status: true, amountMinor: true, providerRef: true } } },
        },
      },
    });

    let matched = 0;
    let mismatched = 0;
    let unverifiable = 0;
    const mismatches: ReconcileMismatch[] = [];

    for (const p of payments) {
      const adapter = this.registry.get(p.provider);
      let providerResult: PaymentStatusResult | null = null;
      if (adapter?.getPayment && p.providerRef) {
        try {
          providerResult = await adapter.getPayment(p.providerRef);
        } catch (err) {
          this.logger.warn(
            `Reconcile ${p.provider}/${p.providerRef}: ${err instanceof Error ? err.message : 'error'}`,
          );
          providerResult = null;
        }
      }
      const outcome = reconcilePaymentDetailed(
        {
          status: p.status,
          amountMinor: p.amountMinor,
          refundedMinor: p.refundedMinor,
          refunds: p.booking?.refunds ?? [],
        },
        providerResult,
      );
      const verdict = outcome.verdict;
      if (verdict === 'matched') matched += 1;
      else if (verdict === 'unverifiable') unverifiable += 1;
      else {
        mismatched += 1;
        mismatches.push({
          bookingId: p.bookingId,
          provider: p.provider,
          providerRef: p.providerRef ?? '',
          ourStatus: p.status,
          providerStatus: providerResult?.status ?? 'unknown',
          ourAmountMinor: p.amountMinor,
          providerAmountMinor: providerResult?.amountMinor ?? 0,
          ourRefundedMinor: p.refundedMinor,
          reason: outcome.reason ?? 'PROVIDER_STATUS_DIFFERS',
        });
      }
    }

    this.metrics.recordReconciliation(matched, mismatched, unverifiable);
    await this.audit.record({
      action: 'PAYMENT_RECONCILIATION_RUN',
      entityType: 'Payment',
      metadata: {
        from: from.toISOString(),
        to: to.toISOString(),
        checked: payments.length,
        matched,
        mismatched,
        unverifiable,
      },
    });

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      checked: payments.length,
      matched,
      mismatched,
      unverifiable,
      mismatches,
    };
  }

  /** Settlement summary per provider + currency for a window. */
  async settlement(from: Date, to: Date): Promise<SettlementLine[]> {
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: { status: 'SUCCEEDED', createdAt: { gte: from, lte: to } },
        select: { provider: true, currency: true, amountMinor: true },
      }),
      this.prisma.refund.findMany({
        where: { status: 'COMPLETED', createdAt: { gte: from, lte: to } },
        select: {
          amountMinor: true,
          booking: { select: { payment: { select: { provider: true, currency: true } } } },
        },
      }),
    ]);

    const lines = new Map<string, SettlementLine>();
    const at = (provider: string, currency: string): SettlementLine => {
      const key = `${provider}|${currency}`;
      let line = lines.get(key);
      if (!line) {
        line = { provider, currency, grossMinor: 0, refundedMinor: 0, netMinor: 0, count: 0 };
        lines.set(key, line);
      }
      return line;
    };

    for (const p of payments) {
      const line = at(p.provider, p.currency);
      line.grossMinor += p.amountMinor;
      line.count += 1;
    }
    for (const r of refunds) {
      const pay = r.booking?.payment;
      if (!pay) continue;
      at(pay.provider, pay.currency).refundedMinor += r.amountMinor;
    }
    for (const line of lines.values()) line.netMinor = line.grossMinor - line.refundedMinor;

    return Array.from(lines.values()).sort((a, b) => b.netMinor - a.netMinor);
  }
}
