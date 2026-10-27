import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException } from '../common/errors';
import {
  TransactionalEventPublisher,
  billingSubscriptionChangedEvent,
} from '../common/domain-events';
import { EntitlementService } from './entitlements/entitlement.service';
import { SubscriptionService } from './subscription.service';
import { ensureBillingAccount } from './billing-account';
import { BILLING_PROVIDER, type BillingProvider, type VerifiedBillingEvent } from './provider/billing-provider';

export type IngestOutcome =
  | { outcome: 'DUPLICATE' }
  | { outcome: 'PROCESSED'; subscriptionId: string; status: string }
  | { outcome: 'FAILED'; reason: string };

const DAY = 24 * 60 * 60 * 1000;

/**
 * Applies a signature-verified provider event to a subscription.
 *
 * ── A WEBHOOK IS A CLAIM ───────────────────────────────────────────────────────────
 * "Payment captured" in a webhook is not believed. The provider is asked for its own record of
 * the payment (`fetchPayment`), and only a record that is verified, for exactly the price's
 * amount and currency, becomes a BillingPayment and the evidence that activates or renews the
 * subscription. Anything less is recorded as FAILED with the reason, and nothing is granted.
 *
 * Idempotent per (provider, providerEventId): the event row is unique, so a redelivered event is
 * a DUPLICATE and changes nothing. Billing events live in BillingWebhookEvent, never in the
 * ticket payments' WebhookEvent table.
 *
 * Not reachable over HTTP in this change: the webhook endpoints arrive with the real providers.
 */
@Injectable()
export class BillingEventService {
  private readonly logger = new Logger('BillingEvents');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionService,
    private readonly entitlements: EntitlementService,
    private readonly events: TransactionalEventPublisher,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  async ingest(ev: VerifiedBillingEvent, provider: BillingProvider = this.provider): Promise<IngestOutcome> {
    let row;
    try {
      row = await this.prisma.billingWebhookEvent.create({
        data: {
          provider: provider.key,
          providerEventId: ev.providerEventId,
          eventType: ev.type,
          signatureVerified: true,
          payload: ev.payload as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { outcome: 'DUPLICATE' };
      }
      throw e;
    }

    const fail = async (reason: string): Promise<IngestOutcome> => {
      await this.prisma.billingWebhookEvent.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: reason, processedAt: new Date() },
      });
      this.logger.warn(`billing event ${ev.providerEventId} not applied: ${reason}`);
      return { outcome: 'FAILED', reason };
    };

    try {
      if (ev.type === 'PAYMENT_CAPTURED') return await this.captured(ev, provider, row.id, fail);
      const event =
        ev.type === 'PAYMENT_FAILED' ? ({ type: 'PAYMENT_FAILED' } as const) : ({ type: 'CANCEL_NOW' } as const);
      const sub = await this.subscriptions.apply(ev.organizationId, event, {
        auditAction: ev.type === 'PAYMENT_FAILED' ? 'BILLING_PAYMENT_FAILED' : 'BILLING_CANCELLED_BY_PROVIDER',
      });
      await this.markProcessed(row.id, sub.accountId);
      return { outcome: 'PROCESSED', subscriptionId: sub.id, status: sub.status };
    } catch (e) {
      if (e instanceof AppException) return fail(e.message);
      throw e;
    }
  }

  private async captured(
    ev: VerifiedBillingEvent,
    provider: BillingProvider,
    eventRowId: string,
    fail: (reason: string) => Promise<IngestOutcome>,
  ): Promise<IngestOutcome> {
    if (!ev.paymentRef || !ev.priceId) return fail('The event names no payment or no price.');
    const evidence = await provider.fetchPayment(ev.paymentRef);
    if (!evidence.verified) return fail('The provider has no verified record of this payment.');

    const price = await this.prisma.billingPrice.findUnique({ where: { id: ev.priceId } });
    if (!price) return fail('The event names a price that does not exist.');
    if (evidence.amountMinor !== price.amountMinor || evidence.currency !== price.currency) {
      return fail(
        `The payment (${evidence.amountMinor} ${evidence.currency}) does not match the price (${price.amountMinor} ${price.currency}).`,
      );
    }

    const periodStart = ev.periodStart ? new Date(ev.periodStart) : new Date();
    const periodEnd = ev.periodEnd
      ? new Date(ev.periodEnd)
      : new Date(periodStart.getTime() + (price.interval === 'YEAR' ? 365 : 30) * DAY);

    let entry: AuditEntry | null = null;
    const sub = await this.events.runWithEvents(async (tx, collector) => {
      const account = await ensureBillingAccount(tx, ev.organizationId);
      await tx.billingPayment.upsert({
        where: {
          provider_providerPaymentRef: { provider: provider.key, providerPaymentRef: evidence.paymentRef },
        },
        create: {
          accountId: account.id,
          provider: provider.key,
          providerPaymentRef: evidence.paymentRef,
          amountMinor: evidence.amountMinor,
          currency: evidence.currency,
          status: 'SUCCEEDED',
          verifiedAt: new Date(),
        },
        update: {},
      });
      const current = await tx.organizerSubscription.findUnique({ where: { currentKey: account.id } });
      const renewing =
        current &&
        ['ACTIVE', 'PAST_DUE', 'GRACE'].includes(current.status) &&
        current.providerSubscriptionRef === (ev.providerSubscriptionRef ?? null);
      const result = await this.subscriptions.applyInTx(
        tx,
        ev.organizationId,
        renewing
          ? { type: 'RENEW', periodEnd, evidence }
          : { type: 'ACTIVATE', planId: price.planId, periodStart, periodEnd, evidence },
        {
          auditAction: renewing ? 'BILLING_SUBSCRIPTION_RENEWED' : 'BILLING_SUBSCRIPTION_ACTIVATED',
          priceId: price.id,
          providerSubscriptionRef: ev.providerSubscriptionRef ?? null,
        },
      );
      entry = result.entry;
      const plan = await tx.billingPlan.findUnique({ where: { id: result.row.planId } });
      collector.collect(
        billingSubscriptionChangedEvent({
          organizationId: ev.organizationId,
          subscriptionId: result.row.id,
          transition: renewing ? 'RENEW' : 'ACTIVATE',
          fromStatus: result.from,
          toStatus: result.row.status,
          planCode: plan?.code ?? 'UNKNOWN',
          changedAt: new Date().toISOString(),
        }),
      );
      await tx.billingWebhookEvent.update({
        where: { id: eventRowId },
        data: { status: 'PROCESSED', accountId: account.id, processedAt: new Date() },
      });
      return result.row;
    });
    this.entitlements.bust(ev.organizationId);
    if (entry) this.audit.afterCommit(entry);
    return { outcome: 'PROCESSED', subscriptionId: sub.id, status: sub.status };
  }

  private async markProcessed(id: string, accountId: string) {
    await this.prisma.billingWebhookEvent.update({
      where: { id },
      data: { status: 'PROCESSED', accountId, processedAt: new Date() },
    });
  }
}
