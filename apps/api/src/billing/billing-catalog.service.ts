import { HttpStatus, Injectable } from '@nestjs/common';
import type { BillingInterval } from '@prisma/client';
import {
  DEFAULT_ANNUAL_FREE_MONTHS,
  ENTITLEMENT_DEFINITIONS,
  PROVISIONAL_MONTHLY_PRICES,
  PROVISIONAL_PLAN_ENTITLEMENTS,
  annualAmountMinor,
  isEntitlementKey,
  type BillingPlanCode,
  type EntitlementValue,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';

const PLAN_NAMES: Record<
  BillingPlanCode,
  { name: string; description: string; sortOrder: number }
> = {
  FREE: { name: 'Free', description: 'Sell tickets and see your audience.', sortOrder: 0 },
  PRO: {
    name: 'Pro',
    description: 'Email campaigns to your audience, scheduled, with results.',
    sortOrder: 1,
  },
  PREMIUM: {
    name: 'Premium',
    description: 'Automated emails, audience segments, sales results and priority support.',
    sortOrder: 2,
  },
};

export function priceActiveKey(planId: string, country: string, interval: BillingInterval) {
  return `${planId}:${country}:${interval}`;
}

function assertValues(values: EntitlementValue[]) {
  for (const v of values) {
    if (!isEntitlementKey(v.key)) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, `Unknown entitlement ${v.key}.`);
    }
    const kind = ENTITLEMENT_DEFINITIONS[v.key].kind;
    const ok =
      kind === 'int'
        ? Number.isInteger(v.intValue) && (v.intValue as number) >= 0 && v.boolValue == null
        : typeof v.boolValue === 'boolean' && v.intValue == null;
    if (!ok) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `${v.key} takes ${kind === 'int' ? 'a whole number' : 'on or off'}.`,
      );
    }
  }
}

/**
 * Plans, prices and what each plan includes.
 *
 * Prices are effectively immutable once anything points at them: a price a subscription uses
 * cannot be edited, only switched off and replaced, so a subscriber's record always shows what
 * they agreed to pay.
 */
@Injectable()
export class BillingCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.billingPlan.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        prices: { orderBy: [{ country: 'asc' }, { interval: 'asc' }, { createdAt: 'desc' }] },
        entitlements: { orderBy: { key: 'asc' } },
      },
    });
  }

  /**
   * Loads the PROVISIONAL catalogue (shared-types `PROVISIONAL_*`), idempotently: plans are
   * created when missing, a plan's entitlements are written only when it has none, and a price is
   * created only where no active one exists for that plan, country and interval. Nothing staff
   * already changed is overwritten. Never run at boot, by a migration or by a seed: an explicit
   * admin action (BILLING_MANAGE, recent second factor), audited.
   */
  async loadProvisional(
    actorUserId: string,
    opts: { annualFreeMonths?: number } = {},
  ): Promise<{ plansCreated: number; entitlementsWritten: number; pricesCreated: number }> {
    const freeMonths = opts.annualFreeMonths ?? DEFAULT_ANNUAL_FREE_MONTHS;
    annualAmountMinor(0, freeMonths); // validates the range
    const counts = { plansCreated: 0, entitlementsWritten: 0, pricesCreated: 0 };

    await this.prisma.$transaction(async (tx) => {
      for (const code of ['FREE', 'PRO', 'PREMIUM'] as const) {
        let plan = await tx.billingPlan.findUnique({ where: { code } });
        if (!plan) {
          plan = await tx.billingPlan.create({ data: { code, ...PLAN_NAMES[code] } });
          counts.plansCreated += 1;
        }
        const existing = await tx.planEntitlement.count({ where: { planId: plan.id } });
        if (existing === 0) {
          for (const v of PROVISIONAL_PLAN_ENTITLEMENTS[code]) {
            await tx.planEntitlement.create({
              data: {
                planId: plan.id,
                key: v.key,
                boolValue: v.boolValue ?? null,
                intValue: v.intValue ?? null,
              },
            });
            counts.entitlementsWritten += 1;
          }
        }
        for (const p of PROVISIONAL_MONTHLY_PRICES.filter((x) => x.plan === code)) {
          for (const interval of ['MONTH', 'YEAR'] as const) {
            const activeKey = priceActiveKey(plan.id, p.country, interval);
            const live = await tx.billingPrice.findUnique({ where: { activeKey } });
            if (live) continue;
            await tx.billingPrice.create({
              data: {
                planId: plan.id,
                country: p.country,
                currency: p.currency,
                interval,
                amountMinor:
                  interval === 'MONTH'
                    ? p.amountMinor
                    : annualAmountMinor(p.amountMinor, freeMonths),
                activeKey,
              },
            });
            counts.pricesCreated += 1;
          }
        }
      }
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_CATALOG_LOADED',
        entityType: 'BillingPlan',
        entityId: null,
        metadata: { ...counts, annualFreeMonths: freeMonths, provisional: true },
      });
    });
    return counts;
  }

  async updatePlan(
    id: string,
    patch: { name?: string; description?: string | null; active?: boolean; sortOrder?: number },
    actorUserId: string,
  ) {
    const plan = await this.prisma.billingPlan.findUnique({ where: { id } });
    if (!plan)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Plan not found.', HttpStatus.NOT_FOUND);
    if (plan.code === 'FREE' && patch.active === false) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'The Free plan cannot be switched off.',
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.billingPlan.update({ where: { id }, data: patch });
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_PLAN_UPDATED',
        entityType: 'BillingPlan',
        entityId: id,
        metadata: { fields: Object.keys(patch) },
      });
      return updated;
    });
  }

  /** Replaces what a plan includes. Applies to every subscriber of the plan at once. */
  async setPlanEntitlements(id: string, values: EntitlementValue[], actorUserId: string) {
    assertValues(values);
    const plan = await this.prisma.billingPlan.findUnique({ where: { id } });
    if (!plan)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Plan not found.', HttpStatus.NOT_FOUND);
    return this.prisma.$transaction(async (tx) => {
      await tx.planEntitlement.deleteMany({ where: { planId: id } });
      for (const v of values) {
        await tx.planEntitlement.create({
          data: {
            planId: id,
            key: v.key,
            boolValue: v.boolValue ?? null,
            intValue: v.intValue ?? null,
          },
        });
      }
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_PLAN_ENTITLEMENTS_SET',
        entityType: 'BillingPlan',
        entityId: id,
        metadata: { keys: values.map((v) => v.key) },
      });
      return tx.planEntitlement.findMany({ where: { planId: id }, orderBy: { key: 'asc' } });
    });
  }

  async createPrice(
    input: {
      planId: string;
      country: string;
      currency: string;
      interval: BillingInterval;
      amountMinor: number;
      trialDays?: number | null;
      providerPriceRefTest?: string | null;
      providerPriceRefLive?: string | null;
    },
    actorUserId: string,
  ) {
    const plan = await this.prisma.billingPlan.findUnique({ where: { id: input.planId } });
    if (!plan)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Plan not found.', HttpStatus.NOT_FOUND);
    if (plan.code === 'FREE' && input.amountMinor !== 0) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'The Free plan costs nothing.');
    }
    const activeKey = priceActiveKey(plan.id, input.country, input.interval);
    if (await this.prisma.billingPrice.findUnique({ where: { activeKey } })) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This plan already has an active price for that country and interval. Switch it off first.',
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const price = await tx.billingPrice.create({ data: { ...input, activeKey } });
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_PRICE_CREATED',
        entityType: 'BillingPrice',
        entityId: price.id,
        metadata: {
          planCode: plan.code,
          country: price.country,
          currency: price.currency,
          interval: price.interval,
          amountMinor: price.amountMinor,
        },
      });
      return price;
    });
  }

  async updatePrice(
    id: string,
    patch: {
      amountMinor?: number;
      trialDays?: number | null;
      providerPriceRefTest?: string | null;
      providerPriceRefLive?: string | null;
    },
    actorUserId: string,
  ) {
    const price = await this.prisma.billingPrice.findUnique({
      where: { id },
      include: { plan: true },
    });
    if (!price)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Price not found.', HttpStatus.NOT_FOUND);
    const used = await this.prisma.organizerSubscription.count({ where: { priceId: id } });
    if (used > 0 && patch.amountMinor !== undefined && patch.amountMinor !== price.amountMinor) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Subscribers pay this price, so its amount cannot change. Switch it off and add a new price.',
        HttpStatus.CONFLICT,
      );
    }
    if (price.plan.code === 'FREE' && patch.amountMinor !== undefined && patch.amountMinor !== 0) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'The Free plan costs nothing.');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.billingPrice.update({ where: { id }, data: patch });
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_PRICE_UPDATED',
        entityType: 'BillingPrice',
        entityId: id,
        metadata: { fields: Object.keys(patch), from: price.amountMinor, to: updated.amountMinor },
      });
      return updated;
    });
  }

  async deactivatePrice(id: string, actorUserId: string) {
    const price = await this.prisma.billingPrice.findUnique({ where: { id } });
    if (!price)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Price not found.', HttpStatus.NOT_FOUND);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.billingPrice.update({
        where: { id },
        data: { active: false, activeKey: null },
      });
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_PRICE_DEACTIVATED',
        entityType: 'BillingPrice',
        entityId: id,
        metadata: { country: price.country, interval: price.interval },
      });
      return updated;
    });
  }
}
