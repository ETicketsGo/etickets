import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  EMAIL_CREDITS_LEDGER_KEY,
  ENTITLEMENT_DEFINITIONS,
  PROVISIONAL_PLAN_ENTITLEMENTS,
  isEntitlementKey,
  isFeatureEnabled,
  monthlyPeriodKey,
  type BillingPlanCode,
  type EntitlementKey,
  type FeatureFlag,
  type OrganizationEntitlements,
  type ResolvedEntitlement,
  type SubscriptionStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { grantsEntitlements } from '../subscription-state-machine';
import { resolveEntitlements, type PlanValue } from './entitlement-resolution';

/** How long a resolved answer is reused. Every change through this API busts it at once. */
export const ENTITLEMENT_CACHE_TTL_MS = 30_000;

/**
 * Spends queue on one organization's lock, so a burst waits its turn rather than failing: the
 * defaults (2 s to get a connection, 5 s to finish) turned a 40-send burst into timeouts in the
 * real-Postgres test, though none of them overspent.
 */
const CONSUME_TX = { maxWait: 15_000, timeout: 20_000 } as const;

/** The ledger period for credits, which never reset. */
export const CREDITS_PERIOD = '-';

export interface UsageSummary {
  key: EntitlementKey;
  periodKey: string;
  /** Included this period by the plan or an override (0 when off). */
  quota: number;
  /** Spent from the quota this period. */
  used: number;
  /** Extra credits left (granted or bought), spent after the quota. */
  credits: number;
  /** quota left + credits. What one more send may use. */
  remaining: number;
}

export interface ConsumeResult extends UsageSummary {
  consumed: number;
  fromQuota: number;
  fromCredits: number;
  /** True when this idempotency key had already been spent; nothing was spent again. */
  replayed: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * What an organization may use, right now or at any moment (`at`).
 *
 *   plan of the current subscription (FREE when none grants)  ->  overrides  ->  kill switch
 *
 * The current subscription is the account's row with `currentKey` set. Whether it still grants
 * is decided by the clock (`grantsEntitlements`), not by whether a sweep has run: a trial that
 * ended a minute ago is Free now, even if its status still says TRIALING.
 *
 * ── CACHE ──────────────────────────────────────────────────────────────────────────
 * Answers for "now" are kept per organization for {@link ENTITLEMENT_CACHE_TTL_MS} in this
 * process. Every write path in the billing module calls `bust(organizationId)` after it commits,
 * so a change made through this API is seen at once here; another replica sees it within the TTL.
 * Quota spending never reads the cache.
 */
@Injectable()
export class EntitlementService {
  private readonly cache = new Map<string, { at: number; value: OrganizationEntitlements }>();
  private readonly featureEnabled: (flag: FeatureFlag) => boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() featureEnabled?: (flag: FeatureFlag) => boolean,
  ) {
    this.featureEnabled = typeof featureEnabled === 'function' ? featureEnabled : isFeatureEnabled;
  }

  bust(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  async resolve(organizationId: string, at?: Date): Promise<OrganizationEntitlements> {
    if (!at) {
      const hit = this.cache.get(organizationId);
      if (hit && Date.now() - hit.at < ENTITLEMENT_CACHE_TTL_MS) return hit.value;
    }
    const when = at ?? new Date();
    const value = await this.compute(this.prisma, organizationId, when);
    if (!at) this.cache.set(organizationId, { at: Date.now(), value });
    return value;
  }

  async get(organizationId: string, key: EntitlementKey, at?: Date): Promise<ResolvedEntitlement> {
    const all = await this.resolve(organizationId, at);
    return all.entitlements.find((e) => e.key === key)!;
  }

  async has(organizationId: string, key: EntitlementKey, at?: Date): Promise<boolean> {
    return (await this.get(organizationId, key, at)).enabled;
  }

  /** Throws ENTITLEMENT_REQUIRED (403) unless the organization has the key. */
  async assert(organizationId: string, key: EntitlementKey): Promise<void> {
    const e = await this.get(organizationId, key);
    if (e.enabled) return;
    const label = ENTITLEMENT_DEFINITIONS[key].label;
    throw new AppException(
      ErrorCodes.ENTITLEMENT_REQUIRED,
      e.switchedOffInDeployment
        ? `${label} is included in your plan but is not switched on yet.`
        : `${label} is not included in your plan.`,
      HttpStatus.FORBIDDEN,
      { key, switchedOffInDeployment: e.switchedOffInDeployment },
    );
  }

  /** The plan whose entitlements apply now, and the current subscription's status. */
  async currentPlan(
    db: Tx | PrismaService,
    organizationId: string,
    at: Date,
  ): Promise<{ planCode: BillingPlanCode; status: SubscriptionStatus | null; plan: PlanValue[] }> {
    const account = await db.organizerBillingAccount.findUnique({
      where: { organizationId },
      select: { id: true },
    });
    const sub = account
      ? await db.organizerSubscription.findUnique({
          where: { currentKey: account.id },
          include: { plan: { include: { entitlements: true } } },
        })
      : null;
    if (sub && grantsEntitlements(sub, at)) {
      return {
        planCode: sub.plan.code as BillingPlanCode,
        status: sub.status as SubscriptionStatus,
        plan: sub.plan.entitlements,
      };
    }
    // FREE: the catalogue's row when it has been loaded, the built-in definition otherwise.
    const free = await db.billingPlan.findUnique({
      where: { code: 'FREE' },
      include: { entitlements: true },
    });
    return {
      planCode: 'FREE',
      status: (sub?.status as SubscriptionStatus | undefined) ?? null,
      plan: free ? free.entitlements : PROVISIONAL_PLAN_ENTITLEMENTS.FREE,
    };
  }

  private async compute(
    db: Tx | PrismaService,
    organizationId: string,
    at: Date,
  ): Promise<OrganizationEntitlements> {
    const current = await this.currentPlan(db, organizationId, at);
    const overrides = await db.entitlementOverride.findMany({ where: { organizationId } });
    return {
      organizationId,
      planCode: current.planCode,
      subscriptionStatus: current.status,
      resolvedAt: at.toISOString(),
      entitlements: resolveEntitlements({
        plan: current.plan,
        overrides,
        at,
        featureEnabled: this.featureEnabled,
      }),
    };
  }

  // ── Quotas and credits ───────────────────────────────────────────────────────

  private assertQuotaKey(key: string): asserts key is EntitlementKey {
    if (!isEntitlementKey(key) || ENTITLEMENT_DEFINITIONS[key].kind !== 'int') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `${key} is not a quota.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async usage(
    db: Tx | PrismaService,
    organizationId: string,
    key: EntitlementKey,
    periodKey: string,
    at: Date,
  ): Promise<UsageSummary> {
    const resolved = await this.compute(db, organizationId, at);
    const quota = resolved.entitlements.find((e) => e.key === key)?.limit ?? 0;
    const [spent, credits] = await Promise.all([
      db.usageLedger.aggregate({
        where: { organizationId, key, periodKey },
        _sum: { delta: true },
      }),
      db.usageLedger.aggregate({
        where: { organizationId, key: EMAIL_CREDITS_LEDGER_KEY, periodKey: CREDITS_PERIOD },
        _sum: { delta: true },
      }),
    ]);
    const used = Math.max(0, -(spent._sum.delta ?? 0));
    const creditBalance = Math.max(0, credits._sum.delta ?? 0);
    return {
      key,
      periodKey,
      quota,
      used,
      credits: creditBalance,
      remaining: Math.max(0, quota - used) + creditBalance,
    };
  }

  /** What is left this period: the quota not yet used, plus extra credits. */
  async remaining(
    organizationId: string,
    key: EntitlementKey = 'campaigns.monthly_email_quota',
    periodKey?: string,
  ): Promise<UsageSummary> {
    this.assertQuotaKey(key);
    const at = new Date();
    return this.usage(this.prisma, organizationId, key, periodKey ?? monthlyPeriodKey(at), at);
  }

  /**
   * Spend `n` of a quota: from this period's quota first, then from extra credits. All or
   * nothing - when `n` does not fit, nothing is spent and QUOTA_EXCEEDED (409) is thrown.
   *
   * Atomic under concurrency: the transaction takes a per-organization advisory lock before it
   * reads the balance, so two sends racing for the last 10 emails cannot both see 10 left. The
   * idempotency key makes a retry of the same send spend nothing a second time (`replayed`);
   * the unique index on it is the backstop if the lock were ever bypassed.
   */
  async consume(
    organizationId: string,
    key: EntitlementKey,
    n: number,
    idempotencyKey: string,
    ref: { refType?: string; refId?: string; actorUserId?: string } = {},
  ): Promise<ConsumeResult> {
    this.assertQuotaKey(key);
    if (!Number.isInteger(n) || n <= 0) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Spend a whole number above zero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!idempotencyKey?.trim()) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An idempotency key is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const quotaIdem = `${idempotencyKey}:quota`;
    const creditIdem = `${idempotencyKey}:credits`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${organizationId}`}, 0))::text AS locked`;
      const at = new Date();
      const periodKey = monthlyPeriodKey(at);

      const prior = await tx.usageLedger.findMany({
        where: { idempotencyKey: { in: [quotaIdem, creditIdem] } },
      });
      if (prior.length > 0) {
        if (prior.some((p) => p.organizationId !== organizationId || p.reason !== 'CONSUMPTION')) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            'That idempotency key was used for something else.',
            HttpStatus.CONFLICT,
          );
        }
        const fromQuota = -(prior.find((p) => p.idempotencyKey === quotaIdem)?.delta ?? 0);
        const fromCredits = -(prior.find((p) => p.idempotencyKey === creditIdem)?.delta ?? 0);
        const summary = await this.usage(tx, organizationId, key, prior[0].periodKey, at);
        return {
          ...summary,
          consumed: fromQuota + fromCredits,
          fromQuota,
          fromCredits,
          replayed: true,
        };
      }

      const before = await this.usage(tx, organizationId, key, periodKey, at);
      if (n > before.remaining) {
        throw new AppException(
          ErrorCodes.QUOTA_EXCEEDED,
          `That needs ${n}, and ${before.remaining} ${before.remaining === 1 ? 'is' : 'are'} left this month.`,
          HttpStatus.CONFLICT,
          { needed: n, remaining: before.remaining, quota: before.quota, credits: before.credits },
        );
      }
      const fromQuota = Math.min(n, Math.max(0, before.quota - before.used));
      const fromCredits = n - fromQuota;
      if (fromQuota > 0) {
        await tx.usageLedger.create({
          data: {
            organizationId,
            key,
            delta: -fromQuota,
            reason: 'CONSUMPTION',
            periodKey,
            idempotencyKey: quotaIdem,
            refType: ref.refType ?? null,
            refId: ref.refId ?? null,
            actorUserId: ref.actorUserId ?? null,
          },
        });
      }
      if (fromCredits > 0) {
        await tx.usageLedger.create({
          data: {
            organizationId,
            key: EMAIL_CREDITS_LEDGER_KEY,
            delta: -fromCredits,
            reason: 'CONSUMPTION',
            periodKey: CREDITS_PERIOD,
            idempotencyKey: creditIdem,
            refType: ref.refType ?? null,
            refId: ref.refId ?? null,
            actorUserId: ref.actorUserId ?? null,
          },
        });
      }
      return {
        ...before,
        used: before.used + fromQuota,
        credits: before.credits - fromCredits,
        remaining: before.remaining - n,
        consumed: n,
        fromQuota,
        fromCredits,
        replayed: false,
      };
    }, CONSUME_TX);
  }
}
