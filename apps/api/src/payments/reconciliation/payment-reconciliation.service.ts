import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import type { PaymentStatusResult } from '../provider/payment-provider.interface';

export type ReconcileVerdict = 'matched' | 'mismatched' | 'unverifiable';

/**
 * Compare our recorded payment against the provider's truth. Pure and
 * unit-testable. A null provider result (adapter can't be queried) is
 * "unverifiable"; a settled/amount disagreement is "mismatched".
 */
export function reconcilePayment(
  our: { status: string; amountMinor: number },
  provider: PaymentStatusResult | null,
): ReconcileVerdict {
  if (!provider) return 'unverifiable';
  const settledOur = our.status === 'SUCCEEDED';
  const settledProvider = provider.status === 'CAPTURED' || provider.status === 'SUCCEEDED';
  if (settledOur === settledProvider && our.amountMinor === provider.amountMinor) {
    return 'matched';
  }
  return 'mismatched';
}

export interface ReconcileMismatch {
  bookingId: string;
  provider: string;
  providerRef: string;
  ourStatus: string;
  providerStatus: string;
  ourAmountMinor: number;
  providerAmountMinor: number;
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
      const verdict = reconcilePayment(p, providerResult);
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
