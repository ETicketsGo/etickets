import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/errors';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { SubscriptionService } from './subscription.service';
import { BillingProviderEventService } from './billing-provider-events.service';
import { dunningStageFor, sendDunning } from './billing-dunning';
import { RENEWAL_TOLERANCE_MS } from './subscription-state-machine';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import type { BillingProviderKey } from './provider/billing-provider';

const DAY = 24 * 60 * 60 * 1000;

export interface BillingSweepReport {
  /** Trial, grace, complimentary or cancelling period ran out (SubscriptionService.sweep). */
  expired: number;
  /** Provider-paid plans whose period ended with no renewal: ACTIVE -> PAST_DUE. */
  pastDue: number;
  /** PAST_DUE past BILLING_PAST_DUE_DAYS with no payment: PAST_DUE -> GRACE. */
  grace: number;
  /** Renewals the provider had that we never received, applied from its record. */
  recovered: number;
  /** Dunning reminders asked for (each stage is sent once; the dedupe key makes repeats no-ops). */
  reminders: number;
  /** Webhook events retried after a transient failure. */
  webhooksRetried: number;
}

/**
 * The billing clock, run by the worker (`billing-sweep`, every 15 minutes by default).
 *
 *   1. Ends what has run out: trials, grace, complimentary plans, periods set to cancel
 *      (SubscriptionService.sweep - the state machine's own timed moves).
 *   2. A provider-paid plan whose period ended more than the renewal tolerance ago with no
 *      renewal: the provider is ASKED first - if it holds a paid renewal we never heard about,
 *      that renewal is applied (recovery). Otherwise ACTIVE -> PAST_DUE (features kept).
 *   3. PAST_DUE for longer than BILLING_PAST_DUE_DAYS: PAST_DUE -> GRACE, graceEndsAt
 *      BILLING_GRACE_DAYS ahead. Step 1 of a later run takes GRACE -> EXPIRED.
 *   4. Dunning: the owners of every PAST_DUE and GRACE subscription are told, once per stage.
 *   5. Billing webhook events left RECEIVED by a transient failure are retried.
 *
 * Every step is safe to repeat: a move already made is not due again. With billing off there
 * are no provider subscriptions, so only step 1 (staff grants running out) ever does anything.
 */
@Injectable()
export class BillingSweepService {
  private readonly logger = new Logger('BillingSweep');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly subscriptions: SubscriptionService,
    private readonly providerEvents: BillingProviderEventService,
    private readonly registry: BillingProviderRegistry,
    @Optional() private readonly audience: AdminAudienceService | null = null,
  ) {}

  private days(name: string, fallback: number): number {
    return Number(this.config.get(name) ?? fallback) || fallback;
  }

  async run(now: Date = new Date()): Promise<BillingSweepReport> {
    const report: BillingSweepReport = {
      expired: 0,
      pastDue: 0,
      grace: 0,
      recovered: 0,
      reminders: 0,
      webhooksRetried: 0,
    };
    report.expired = (await this.subscriptions.sweep(now)).applied;

    const lapsed = await this.prisma.organizerSubscription.findMany({
      where: {
        currentKey: { not: null },
        source: 'PROVIDER',
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { lt: new Date(now.getTime() - RENEWAL_TOLERANCE_MS) },
      },
      include: { account: true },
      take: 200,
    });
    for (const s of lapsed) {
      if (await this.recover(s.account.provider, s.providerSubscriptionRef)) {
        report.recovered += 1;
        continue;
      }
      if (await this.move(s.account.organizationId, { type: 'PAYMENT_FAILED' }, now)) {
        report.pastDue += 1;
      }
    }

    const pastDueDays = this.days('BILLING_PAST_DUE_DAYS', 7);
    const graceDays = this.days('BILLING_GRACE_DAYS', 7);
    const overdue = await this.prisma.organizerSubscription.findMany({
      where: {
        currentKey: { not: null },
        source: 'PROVIDER',
        status: 'PAST_DUE',
        currentPeriodEnd: {
          lt: new Date(now.getTime() - RENEWAL_TOLERANCE_MS - pastDueDays * DAY),
        },
      },
      include: { account: true },
      take: 200,
    });
    for (const s of overdue) {
      if (await this.recover(s.account.provider, s.providerSubscriptionRef)) {
        report.recovered += 1;
        continue;
      }
      const graceEndsAt = new Date(now.getTime() + graceDays * DAY);
      if (await this.move(s.account.organizationId, { type: 'ENTER_GRACE', graceEndsAt }, now)) {
        report.grace += 1;
      }
    }

    const dunning = await this.prisma.organizerSubscription.findMany({
      where: {
        currentKey: { not: null },
        source: 'PROVIDER',
        status: { in: ['PAST_DUE', 'GRACE'] },
      },
      include: { account: true, plan: true },
      take: 500,
    });
    for (const s of dunning) {
      const stage = dunningStageFor(s, now);
      if (!stage) continue;
      await sendDunning(this.audience, {
        organizationId: s.account.organizationId,
        subscriptionId: s.id,
        stage,
        planName: s.plan.name,
        currentPeriodEnd: s.currentPeriodEnd,
        graceEndsAt: s.graceEndsAt,
      });
      report.reminders += 1;
    }

    try {
      report.webhooksRetried = (await this.providerEvents.retryPending(now)).retried;
    } catch (err) {
      this.logger.warn(
        `billing webhook retry failed (next sweep retries): ${(err as Error).message}`,
      );
    }
    return report;
  }

  /**
   * Asks the provider whether the subscription is paid up after all. True when a payment we had
   * not applied was found and applied. Any failure to ask is "no": the clock move goes ahead,
   * and PAST_DUE keeps the plan's features, so nothing is lost while the provider is down.
   */
  private async recover(key: BillingProviderKey, subRef: string | null): Promise<boolean> {
    if (!subRef || (key !== 'STRIPE_BILLING' && key !== 'RAZORPAY_BILLING')) return false;
    try {
      const provider = await this.registry.byKey(key);
      if (!provider.fetchSubscription) return false;
      const rec = await provider.fetchSubscription(subRef);
      if (!rec.verified || rec.status !== 'ACTIVE' || !rec.latestPaidPaymentRef) return false;
      const applied = await this.providerEvents.apply(provider, {
        provider: key,
        providerEventId: `sweep:${subRef}`,
        type: 'PAYMENT_CAPTURED',
        organizationId: rec.organizationId ?? '',
        providerSubscriptionRef: subRef,
        paymentRef: rec.latestPaidPaymentRef,
        payload: {},
      });
      return applied.status === 'PROCESSED';
    } catch {
      return false;
    }
  }

  private async move(
    organizationId: string,
    event: Parameters<SubscriptionService['apply']>[1],
    now: Date,
  ): Promise<boolean> {
    try {
      await this.subscriptions.apply(organizationId, event, {
        auditAction:
          event.type === 'PAYMENT_FAILED' ? 'BILLING_RENEWAL_MISSING' : 'BILLING_GRACE_STARTED',
        now,
      });
      return true;
    } catch (e) {
      // Moved by somebody else in the meantime; the next sweep sees the new state.
      if (e instanceof AppException) return false;
      throw e;
    }
  }
}
