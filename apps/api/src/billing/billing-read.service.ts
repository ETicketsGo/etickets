import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PROVISIONAL_PLAN_ENTITLEMENTS, type BillingPlanCode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { EntitlementService } from './entitlements/entitlement.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { billingCountryOf } from './billing-account';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import { creditPackOffers } from './credit-packs';

const PAID_LIVE = ['ACTIVE', 'PAST_DUE', 'GRACE'] as const;

/** A price as a monthly amount: a yearly price is spread over twelve months, rounded down. */
export function monthlyEquivalentMinor(amountMinor: number, interval: 'MONTH' | 'YEAR'): number {
  return interval === 'YEAR' ? Math.floor(amountMinor / 12) : amountMinor;
}

/**
 * Billing reads for the organizer console and the admin console. Nothing here writes.
 *
 * Money is reported per currency and never added across currencies: INR and USD are separate
 * rows, always.
 */
@Injectable()
export class BillingReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly invoices: BillingInvoiceService,
    private readonly config: ConfigService,
    private readonly registry: BillingProviderRegistry,
  ) {}

  /**
   * Whether an organizer in this country could start a checkout here: the flag AND a provider
   * for the country with its credentials configured. Without a country: the flag and the
   * deployment's provider mode (disabled, mock).
   */
  billingEnabled(country?: string | null): boolean {
    return (
      this.config.get<string>('BILLING_ENABLED') === 'true' && this.registry.configuredFor(country)
    );
  }

  // ── Organizer console ─────────────────────────────────────────────────────────

  async organizerBilling(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, registeredCountry: true },
    });
    if (!org)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId },
    });
    const country =
      account?.country && account.country !== 'XX'
        ? account.country
        : billingCountryOf(org.registeredCountry);

    const [resolved, usage, catalog] = await Promise.all([
      this.entitlements.resolve(organizationId),
      this.entitlements.remaining(organizationId, 'campaigns.monthly_email_quota'),
      this.prisma.billingPlan.findMany({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          entitlements: { orderBy: { key: 'asc' } },
          prices: {
            where: { active: true, ...(country ? { country } : { id: '__none__' }) },
            orderBy: { interval: 'asc' },
          },
        },
      }),
    ]);
    const sub = account
      ? await this.prisma.organizerSubscription.findUnique({
          where: { currentKey: account.id },
          include: { plan: true, scheduledPlan: true },
        })
      : null;

    const plans =
      catalog.length > 0
        ? catalog.map((p) => ({
            code: p.code as BillingPlanCode,
            name: p.name,
            description: p.description,
            entitlements: p.entitlements.map((e) => ({
              key: e.key,
              boolValue: e.boolValue,
              intValue: e.intValue,
            })),
            prices: p.prices.map((x) => ({
              id: x.id,
              interval: x.interval,
              amountMinor: x.amountMinor,
              currency: x.currency,
              trialDays: x.trialDays,
            })),
          }))
        : (['FREE', 'PRO', 'PREMIUM'] as const).map((code) => ({
            code,
            name: code === 'FREE' ? 'Free' : code === 'PRO' ? 'Pro' : 'Premium',
            description: null,
            entitlements: PROVISIONAL_PLAN_ENTITLEMENTS[code].map((e) => ({
              key: e.key,
              boolValue: e.boolValue ?? null,
              intValue: e.intValue ?? null,
            })),
            prices: [],
          }));

    return {
      organizationId,
      billingEnabled: this.billingEnabled(country),
      /** Who takes this account's payments, once it has paid through one. */
      provider: account?.provider ?? 'NONE',
      /** The provider that serves this country, so the console offers the right controls. */
      providerForCountry: this.registry.keyForCountry(country),
      disputed: Boolean(account?.disputedAt),
      // Only PUBLISHED prices: an unpublished pack is not on sale and is not shown.
      creditPacks: country
        ? creditPackOffers(await this.prisma.creditPackPrice.findMany({ where: { country } }))
        : [],
      catalogLoaded: catalog.length > 0,
      /** The owner confirmed the catalogue prices on 2026-10-27. */
      pricesProvisional: false,
      country,
      currentPlanCode: resolved.planCode,
      subscription: sub
        ? {
            status: sub.status,
            source: sub.source,
            planCode: sub.plan.code,
            currentPeriodEnd: sub.currentPeriodEnd,
            trialEndsAt: sub.trialEndsAt,
            graceEndsAt: sub.graceEndsAt,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            scheduledPlanCode: sub.scheduledPlan?.code ?? null,
          }
        : null,
      entitlements: resolved.entitlements,
      usage,
      plans,
    };
  }

  async organizerInvoices(organizationId: string) {
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId },
    });
    if (!account) return [];
    return this.invoices.listForAccount(account.id);
  }

  // ── Admin console ─────────────────────────────────────────────────────────────

  async searchSubscriptions(q: {
    status?: string;
    planCode?: string;
    country?: string;
    search?: string;
    currentOnly?: boolean;
    page: number;
    pageSize: number;
  }) {
    let orgIds: string[] | undefined;
    if (q.search?.trim()) {
      const term = q.search.trim();
      const orgs = await this.prisma.organization.findMany({
        where: { OR: [{ id: term }, { name: { contains: term, mode: 'insensitive' } }] },
        select: { id: true },
        take: 200,
      });
      orgIds = orgs.map((o) => o.id);
    }
    const where: Prisma.OrganizerSubscriptionWhereInput = {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.planCode ? { plan: { code: q.planCode as never } } : {}),
      ...(q.currentOnly ? { currentKey: { not: null } } : {}),
      account: {
        ...(q.country ? { country: q.country.toUpperCase() } : {}),
        ...(orgIds ? { organizationId: { in: orgIds } } : {}),
      },
    };
    const [total, rows] = await Promise.all([
      this.prisma.organizerSubscription.count({ where }),
      this.prisma.organizerSubscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { plan: true, price: true, account: true },
      }),
    ]);
    const names = await this.prisma.organization.findMany({
      where: { id: { in: rows.map((r) => r.account.organizationId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        id: r.id,
        organizationId: r.account.organizationId,
        organizationName: nameOf.get(r.account.organizationId) ?? null,
        country: r.account.country,
        planCode: r.plan.code,
        status: r.status,
        source: r.source,
        current: r.currentKey !== null,
        currentPeriodEnd: r.currentPeriodEnd,
        trialEndsAt: r.trialEndsAt,
        price: r.price
          ? {
              amountMinor: r.price.amountMinor,
              currency: r.price.currency,
              interval: r.price.interval,
            }
          : null,
        createdAt: r.createdAt,
      })),
    };
  }

  async accountDetail(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, status: true, registeredCountry: true },
    });
    if (!org)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId },
    });
    const [entitlements, usage, overrides, ledger] = await Promise.all([
      this.entitlements.resolve(organizationId, new Date()),
      this.entitlements.remaining(organizationId, 'campaigns.monthly_email_quota'),
      this.prisma.entitlementOverride.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.usageLedger.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    const [subscriptions, invoices, payments, adjustments] = account
      ? await Promise.all([
          this.prisma.organizerSubscription.findMany({
            where: { accountId: account.id },
            orderBy: { createdAt: 'desc' },
            include: { plan: true, price: true, scheduledPlan: true },
          }),
          this.prisma.organizerInvoice.findMany({
            where: { accountId: account.id },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.billingPayment.findMany({
            where: { accountId: account.id },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.billingAdjustment.findMany({
            where: { accountId: account.id },
            orderBy: { createdAt: 'desc' },
          }),
        ])
      : [[], [], [], []];
    return {
      organization: org,
      account,
      currentSubscription: subscriptions.find((s) => s.currentKey !== null) ?? null,
      subscriptions,
      invoices,
      payments,
      adjustments,
      overrides,
      ledger,
      entitlements,
      usage,
    };
  }

  /**
   * Subscription figures, computed only from what is stored. With no paid subscription every
   * money figure is an empty list and every count zero - never an estimate.
   *
   * MRR counts PAID subscriptions only (ACTIVE, PAST_DUE or GRACE, from the provider, with a
   * price): trials and complimentary plans are counted, but are not revenue. ARR = MRR x 12.
   * Churn = paid subscriptions that ended in the window / paid subscriptions live at its start;
   * null when there were none to lose.
   */
  async metrics(days = 30, now: Date = new Date()) {
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const current = await this.prisma.organizerSubscription.findMany({
      where: { currentKey: { not: null } },
      include: { plan: true, price: true },
    });
    const byStatus: Record<string, number> = {};
    for (const s of current) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

    const paid = current.filter(
      (s) =>
        (PAID_LIVE as readonly string[]).includes(s.status) && s.source === 'PROVIDER' && s.price,
    );
    const mrr = new Map<string, { currency: string; mrrMinor: number; subscriptions: number }>();
    const byPlan = new Map<
      string,
      { planCode: string; currency: string; mrrMinor: number; subscriptions: number }
    >();
    for (const s of paid) {
      const m = monthlyEquivalentMinor(s.price!.amountMinor, s.price!.interval);
      const c = mrr.get(s.price!.currency) ?? {
        currency: s.price!.currency,
        mrrMinor: 0,
        subscriptions: 0,
      };
      c.mrrMinor += m;
      c.subscriptions += 1;
      mrr.set(c.currency, c);
      const k = `${s.plan.code}:${s.price!.currency}`;
      const p = byPlan.get(k) ?? {
        planCode: s.plan.code,
        currency: s.price!.currency,
        mrrMinor: 0,
        subscriptions: 0,
      };
      p.mrrMinor += m;
      p.subscriptions += 1;
      byPlan.set(k, p);
    }

    const paidInvoices = await this.prisma.organizerInvoice.findMany({
      where: { status: 'PAID', issuedAt: { gte: since, lte: now } },
      include: { subscription: { include: { plan: true } } },
    });
    const revenue = new Map<
      string,
      { planCode: string; currency: string; totalMinor: number; invoices: number }
    >();
    for (const inv of paidInvoices) {
      const planCode = inv.subscription?.plan.code ?? 'NONE';
      const k = `${planCode}:${inv.currency}`;
      const r = revenue.get(k) ?? { planCode, currency: inv.currency, totalMinor: 0, invoices: 0 };
      r.totalMinor += inv.totalMinor;
      r.invoices += 1;
      revenue.set(k, r);
    }

    const [cancellations, liveAtStart] = await Promise.all([
      this.prisma.organizerSubscription.count({
        where: {
          source: 'PROVIDER',
          status: { in: ['CANCELLED', 'EXPIRED'] },
          endedAt: { gte: since, lte: now },
        },
      }),
      this.prisma.organizerSubscription.count({
        where: {
          source: 'PROVIDER',
          currentPeriodStart: { lt: since },
          OR: [{ endedAt: null }, { endedAt: { gte: since } }],
        },
      }),
    ]);

    return {
      windowDays: days,
      from: since.toISOString(),
      to: now.toISOString(),
      currentByStatus: byStatus,
      paidSubscriptions: paid.length,
      trials: byStatus.TRIALING ?? 0,
      complimentary: byStatus.COMPLIMENTARY ?? 0,
      mrr: [...mrr.values()].map((m) => ({ ...m, arrMinor: m.mrrMinor * 12 })),
      mrrByPlan: [...byPlan.values()],
      revenueByPlan: [...revenue.values()],
      churn: {
        cancellations,
        paidAtStart: liveAtStart,
        rate: liveAtStart > 0 ? cancellations / liveAtStart : null,
      },
    };
  }
}
