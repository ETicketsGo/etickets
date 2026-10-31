import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OpsAlertService } from '../ops/alerts/ops-alert.service';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import type { BillingKeyMode, ProviderPriceRecord } from './provider/billing-provider';

/** One way a catalogue price and its provider price disagree. */
export type PriceMismatchField =
  'missing' | 'amount' | 'currency' | 'interval' | 'active' | 'tax_behavior';

export interface PriceMismatch {
  priceId: string;
  planCode: string;
  country: string;
  providerPriceRef: string;
  fields: PriceMismatchField[];
  local: { amountMinor: number; currency: string; interval: string; active: boolean };
  provider: Omit<ProviderPriceRecord, 'ref' | 'found'> | null;
}

export interface PriceReconcileReport {
  /** Why nothing was checked (billing off, Stripe not configured), else null. */
  skipped: string | null;
  mode: BillingKeyMode | null;
  checked: number;
  /** Provider unreachable for these refs: not a mismatch, checked again next run. */
  unreachable: string[];
  mismatches: PriceMismatch[];
}

/**
 * Compares every plan price in the admin catalogue with its Stripe price.
 *
 * ── THE ADMIN CATALOGUE IS AUTHORITATIVE (owner decision) ─────────────────────────
 * A change made on the Stripe side (a new amount, an archived price, a changed tax behavior)
 * is REPORTED, never applied: this check reads Stripe and writes only an audit record and an
 * ops alert. It never changes a BillingPrice, a subscription or an entitlement. Activation
 * already refuses a payment whose amount differs from the BillingPrice, so drift costs a
 * checkout, not money; this check is how staff hear about it before an organizer does.
 *
 * Only the refs of the key mode in use are read (test refs with a test key, live refs with a
 * live key): a key cannot see the other mode's prices. Razorpay prices are not checked here.
 *
 * Run by the worker (`billing-price-reconcile`, daily) with `record: true`, and on demand by
 * staff (GET admin/billing/prices/provider-check) as a read with nothing recorded.
 */
@Injectable()
export class BillingPriceReconcileService {
  private readonly logger = new Logger('BillingPriceReconcile');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: BillingProviderRegistry,
    private readonly audit: AuditService,
    @Optional() @Inject(OpsAlertService) private readonly alerts: OpsAlertService | null = null,
  ) {}

  async run(options: { record: boolean }): Promise<PriceReconcileReport> {
    const report: PriceReconcileReport = {
      skipped: null,
      mode: null,
      checked: 0,
      unreachable: [],
      mismatches: [],
    };
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') {
      return { ...report, skipped: 'Billing is off (BILLING_ENABLED).' };
    }
    const countries = (
      await this.prisma.billingPrice.findMany({ select: { country: true }, distinct: ['country'] })
    )
      .map((r) => r.country)
      .filter((c) => this.registry.keyForCountry(c) === 'STRIPE_BILLING');
    if (countries.length === 0 || !countries.some((c) => this.registry.configuredFor(c))) {
      return { ...report, skipped: 'Stripe Billing is not configured.' };
    }
    const provider = await this.registry.byKey('STRIPE_BILLING');
    if (!provider.fetchPrice || !provider.mode) {
      return { ...report, skipped: 'Stripe Billing is not configured.' };
    }
    const mode = provider.mode;
    report.mode = mode;
    const prices = await this.prisma.billingPrice.findMany({
      where: {
        country: { in: countries },
        ...(mode === 'live'
          ? { providerPriceRefLive: { not: null } }
          : { providerPriceRefTest: { not: null } }),
      },
      include: { plan: { select: { code: true } } },
      orderBy: [{ country: 'asc' }, { id: 'asc' }],
    });

    for (const price of prices) {
      const ref = (mode === 'live' ? price.providerPriceRefLive : price.providerPriceRefTest)!;
      let rec: ProviderPriceRecord;
      try {
        rec = await provider.fetchPrice(ref);
      } catch {
        report.unreachable.push(ref);
        continue;
      }
      report.checked += 1;
      const fields = mismatchFields(price, rec);
      if (fields.length === 0) continue;
      const seen = {
        amountMinor: rec.amountMinor,
        currency: rec.currency,
        interval: rec.interval,
        intervalCount: rec.intervalCount,
        active: rec.active,
        taxBehavior: rec.taxBehavior,
      };
      report.mismatches.push({
        priceId: price.id,
        planCode: price.plan.code,
        country: price.country,
        providerPriceRef: ref,
        fields,
        local: {
          amountMinor: price.amountMinor,
          currency: price.currency,
          interval: price.interval,
          active: price.active,
        },
        provider: rec.found ? seen : null,
      });
    }

    if (options.record && report.mismatches.length > 0) await this.record(mode, report);
    return report;
  }

  private async record(mode: BillingKeyMode, report: PriceReconcileReport) {
    for (const m of report.mismatches) {
      await this.audit.record({
        actorUserId: null,
        organizationId: null,
        action: 'BILLING_PRICE_PROVIDER_MISMATCH',
        entityType: 'BillingPrice',
        entityId: m.priceId,
        metadata: {
          mode,
          providerPriceRef: m.providerPriceRef,
          fields: m.fields,
          local: m.local,
          provider: m.provider,
          applied: false,
        },
      });
    }
    this.logger.warn(
      `${report.mismatches.length} plan price(s) differ from Stripe (${mode}); nothing was changed.`,
    );
    void this.alerts?.notify({
      kind: 'BILLING_PRICE_MISMATCH',
      key: mode,
      summary: `${report.mismatches.length} plan price(s) differ from their Stripe price (${mode} mode)`,
      facts: {
        mode,
        mismatches: report.mismatches.length,
        prices: report.mismatches
          .map((m) => `${m.planCode}/${m.country}/${m.local.interval}: ${m.fields.join('+')}`)
          .join('; ')
          .slice(0, 500),
        effect:
          'Nothing was changed. The admin catalogue stays authoritative; a checkout for a ' +
          'price whose amount differs is refused when it is paid.',
      },
      where:
        'Admin console, Billing, Plans and prices. Audit log action ' +
        'BILLING_PRICE_PROVIDER_MISMATCH names each price and what differs. Fix the price in ' +
        'Stripe, or point the catalogue price at a new Stripe price.',
    });
  }
}

/** What differs. Prices must be tax-exclusive: our amount is before tax, Stripe adds it. */
export function mismatchFields(
  local: { amountMinor: number; currency: string; interval: string; active: boolean },
  rec: ProviderPriceRecord,
): PriceMismatchField[] {
  if (!rec.found) return ['missing'];
  const out: PriceMismatchField[] = [];
  if (rec.amountMinor !== local.amountMinor) out.push('amount');
  if ((rec.currency ?? '') !== local.currency.toUpperCase()) out.push('currency');
  if (rec.interval !== local.interval || rec.intervalCount !== 1) out.push('interval');
  if (rec.active !== local.active) out.push('active');
  if (rec.taxBehavior !== 'exclusive') out.push('tax_behavior');
  return out;
}
