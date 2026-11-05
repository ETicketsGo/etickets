import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OpsAlertService } from '../ops/alerts/ops-alert.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  BILLING_PROVIDER_BY_COUNTRY,
  BillingProviderRegistry,
} from './provider/billing-provider.registry';
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

/** One catalogue price pointed (or already pointing) at its Stripe price. */
export interface ProviderRefSyncRow {
  priceId: string;
  planCode: string;
  country: string;
  interval: string;
  amountMinor: number;
  lookupKey: string;
  providerPriceRef: string;
}

export interface ProviderRefSyncReport {
  mode: BillingKeyMode;
  dryRun: boolean;
  /** Refs written by this run (or, with dryRun, that would be). */
  written: ProviderRefSyncRow[];
  /** Already pointing at the matching Stripe price: left as they are. */
  unchanged: ProviderRefSyncRow[];
}

/** The Stripe lookup key of a catalogue price: etg_pro_usd_month, etg_premium_usd_year, ... */
export function stripeLookupKey(planCode: string, currency: string, interval: string): string {
  return `etg_${planCode}_${currency}_${interval}`.toLowerCase();
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

  /**
   * Points each Stripe-priced catalogue price at its Stripe price, found by lookup key
   * (`etg_<plan>_<currency>_<month|year>`, e.g. etg_pro_usd_month). Writes ONLY the ref of the
   * key mode in use (providerPriceRefLive with a live key, providerPriceRefTest with a test key)
   * and only where it is empty. Never creates or changes a plan, a price amount, `active`, an
   * entitlement or a Stripe object, and opens no market (selling stays behind
   * BILLING_LIVE_ENABLED / BILLING_LIVE_MARKETS).
   *
   * All or nothing: every price must resolve and match exactly (amount, currency, a 1-month or
   * 1-year interval, active, tax_behavior exclusive) and no price may already point at a
   * DIFFERENT Stripe price; otherwise nothing is written and the refusal lists each problem.
   * Run again it changes nothing (idempotent). `dryRun` reports what it would write.
   */
  async syncProviderRefs(input: {
    mode: BillingKeyMode;
    dryRun: boolean;
    actorUserId: string;
  }): Promise<ProviderRefSyncReport> {
    const provider = await this.registry.byKey('STRIPE_BILLING');
    if (provider.key !== 'STRIPE_BILLING' || !provider.findPriceByLookupKey || !provider.mode) {
      throw new AppException(
        ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
        'Stripe Billing is not configured here (BILLING_PROVIDER=providers and the Stripe ' +
          'billing key are needed). Nothing was changed.',
        HttpStatus.CONFLICT,
      );
    }
    if (provider.mode !== input.mode) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This environment's Stripe billing key is a ${provider.mode} key, so it cannot read ` +
          `${input.mode} prices. Nothing was changed.`,
        HttpStatus.CONFLICT,
      );
    }
    const stripeCountries = Object.entries(BILLING_PROVIDER_BY_COUNTRY)
      .filter(([, key]) => key === 'STRIPE_BILLING')
      .map(([country]) => country);
    const prices = await this.prisma.billingPrice.findMany({
      where: { country: { in: stripeCountries }, active: true, amountMinor: { gt: 0 } },
      include: { plan: { select: { code: true } } },
      orderBy: [{ country: 'asc' }, { id: 'asc' }],
    });
    if (prices.length === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'There are no paid Stripe prices in the catalogue. Load the provisional catalogue ' +
          'first (POST admin/billing/catalog/load-provisional). Nothing was changed.',
        HttpStatus.CONFLICT,
      );
    }
    const field = input.mode === 'live' ? 'providerPriceRefLive' : 'providerPriceRefTest';
    const report: ProviderRefSyncReport = {
      mode: input.mode,
      dryRun: input.dryRun,
      written: [],
      unchanged: [],
    };
    const problems: Array<{ priceId: string; lookupKey: string; problems: string[] }> = [];
    for (const price of prices) {
      const lookupKey = stripeLookupKey(price.plan.code, price.currency, price.interval);
      const rec = await provider.findPriceByLookupKey(lookupKey);
      const wrong: string[] = mismatchFields(price, rec);
      const current = price[field];
      if (rec.found && current && current !== rec.ref) wrong.push('already_points_elsewhere');
      if (wrong.length > 0) {
        problems.push({ priceId: price.id, lookupKey, problems: wrong });
        continue;
      }
      const row = {
        priceId: price.id,
        planCode: price.plan.code,
        country: price.country,
        interval: price.interval,
        amountMinor: price.amountMinor,
        lookupKey,
        providerPriceRef: rec.ref,
      };
      (current === rec.ref ? report.unchanged : report.written).push(row);
    }
    if (problems.length > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `${problems.length} catalogue price(s) do not match their Stripe ${input.mode} price. ` +
          'Nothing was changed.',
        HttpStatus.CONFLICT,
        { problems },
      );
    }
    if (input.dryRun || report.written.length === 0) return report;

    await this.prisma.$transaction(async (tx) => {
      for (const w of report.written) {
        // Only where still empty: a ref set meanwhile by someone else is never overwritten.
        const done = await tx.billingPrice.updateMany({
          where: { id: w.priceId, [field]: null },
          data: { [field]: w.providerPriceRef },
        });
        if (done.count !== 1) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            'A price changed while this ran. Nothing was changed; run it again.',
            HttpStatus.CONFLICT,
          );
        }
      }
      await this.audit.recordInTransaction(tx, {
        actorUserId: input.actorUserId,
        action: 'BILLING_PRICE_PROVIDER_REFS_SYNCED',
        entityType: 'BillingPrice',
        entityId: null,
        metadata: {
          mode: input.mode,
          field,
          written: report.written.map((w) => ({
            priceId: w.priceId,
            lookupKey: w.lookupKey,
            providerPriceRef: w.providerPriceRef,
          })),
          unchanged: report.unchanged.length,
        },
      });
    });
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
