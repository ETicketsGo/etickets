import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type OrganizerBillingAccount, type OrganizerSubscription } from '@prisma/client';
import { EMAIL_CREDITS_LEDGER_KEY } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  TransactionalEventPublisher,
  billingCreditsGrantedEvent,
  billingSubscriptionChangedEvent,
  type DomainEvent,
} from '../common/domain-events';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { CREDITS_PERIOD, EntitlementService } from './entitlements/entitlement.service';
import { SubscriptionService } from './subscription.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { creditPackByCode } from './credit-packs';
import {
  BillingTaxService,
  type BillingTaxLine,
  type BillingTaxQuote,
} from './billing-tax.service';
import type { InvoiceTax } from './billing-invoice.service';
import { dunningLink, sendDunning, type DunningStage } from './billing-dunning';
import {
  isTerminal,
  type PaymentEvidence,
  type SubscriptionEvent,
} from './subscription-state-machine';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import { isTransientBillingError } from './provider/provider-errors';
import {
  TAX_INCLUSIVE_CHARGE_PROVIDERS,
  type BillingProvider,
  type BillingProviderKey,
  type ProviderPaymentRecord,
  type ProviderSubscriptionRecord,
  type VerifiedBillingEvent,
} from './provider/billing-provider';

type Tx = Prisma.TransactionClient;
const DAY = 24 * 60 * 60 * 1000;

export type ProviderIngestOutcome =
  | { outcome: 'DUPLICATE' }
  | { outcome: 'PROCESSED' | 'IGNORED'; note?: string }
  | { outcome: 'FAILED'; reason: string }
  /** A transient failure (provider unreachable): kept RECEIVED, retried by the worker. */
  | { outcome: 'DEFERRED'; reason: string };

interface Applied {
  status: 'PROCESSED' | 'IGNORED';
  note?: string;
  accountId?: string;
}

/** A decision not to apply the event. Recorded as FAILED with this reason; never retried. */
class Refusal extends AppException {
  constructor(reason: string) {
    super(ErrorCodes.CONFLICT, reason, HttpStatus.CONFLICT);
  }
}

/** A delivery that has been RECEIVED for less than this is assumed to still be in flight. */
export const IN_FLIGHT_MS = 60_000;
/** Transient failures are retried this many times by the worker, then recorded as FAILED. */
export const MAX_ATTEMPTS = 8;

const LIVE_PAID = ['ACTIVE', 'PAST_DUE', 'GRACE'];
const ALREADY_APPLIED = 'This payment was already applied.';

/**
 * Applies signature-verified events from the REAL billing providers (Stripe Billing, Razorpay
 * Subscriptions) to organizer subscriptions, invoices and credits.
 *
 * ── AN EVENT IS A TRIGGER, THE PROVIDER'S API IS THE TRUTH ─────────────────────────
 * No event body is believed. Each event names a provider object; that object is fetched back
 * over the provider's authenticated API and only what it says is applied:
 *   - a subscription becomes ACTIVE, renews or changes plan only with a payment the provider
 *     reports PAID, for exactly the BillingPrice's amount and currency, whose price ref maps to
 *     that BillingPrice, whose customer is this account's provider customer, and whose
 *     subscription the provider still reports live. The evidence then passes the state
 *     machine's own verified-payment rule (subscription-state-machine.ts);
 *   - credits are granted only from a verified paid checkout/payment link, once per payment.
 *
 * ── REPLAYS AND ORDER ──────────────────────────────────────────────────────────────
 * - Replay: BillingWebhookEvent is unique per (provider, event id); a redelivery is a DUPLICATE.
 *   Under that, a payment is applied once per (provider, payment ref) - the BillingPayment row
 *   is checked inside the account lock - and credits carry a ledger idempotency key.
 * - Order: status-only events older than the newest provider time already applied are stale
 *   and ignored; every status move is decided from the subscription as the provider reports it
 *   NOW, so a late event can never move it backwards; a payment for a period already covered
 *   records the money and changes nothing; an ended subscription is never re-activated.
 *
 * ── PROCESSING INLINE, RETRIES IN THE WORKER ───────────────────────────────────────
 * Billing events are low volume (a few per organization per month). The event row is written
 * first, then processed in the same request, idempotently. A TRANSIENT failure (provider API
 * unreachable) leaves the row RECEIVED and answers 200, and the worker's billing sweep retries
 * it from the stored payload (`retryPending`); a decision (mismatch, unknown account) is
 * recorded as FAILED with its reason for staff. A queue would add a moving part for no gain.
 */
@Injectable()
export class BillingProviderEventService {
  private readonly logger = new Logger('BillingProviderEvents');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionService,
    private readonly entitlements: EntitlementService,
    private readonly events: TransactionalEventPublisher,
    private readonly invoices: BillingInvoiceService,
    private readonly registry: BillingProviderRegistry,
    private readonly config: ConfigService,
    @Optional()
    @Inject(AdminAudienceService)
    private readonly audience: AdminAudienceService | null = null,
    @Optional() @Inject(BillingTaxService) private readonly tax: BillingTaxService | null = null,
  ) {}

  /**
   * What a verified payment was, split into net and tax, with the invoice's tax lines.
   *
   *   Stripe    `amountMinor` excludes tax and must equal the net price; `taxMinor` is what Stripe
   *             charged on top (our Tax Rates or Stripe Tax). The lines are our quote's when it
   *             adds up to what Stripe charged, otherwise one line with Stripe's amount.
   *   Razorpay  the charge is the TOTAL (Razorpay computes no tax), so it must equal net + tax as
   *             the rules give it NOW (plan renewals) or as quoted (credit packs), and is split
   *             back into those two amounts.
   * A mismatch is a Refusal: recorded for staff, nothing granted.
   */
  private async chargedSplit(
    provider: BillingProvider,
    rec: ProviderPaymentRecord,
    expected: { netMinor: number; quote: BillingTaxQuote | null },
  ): Promise<{ netMinor: number; taxMinor: number; tax: InvoiceTax }> {
    const quote = expected.quote;
    if (TAX_INCLUSIVE_CHARGE_PROVIDERS.includes(provider.key)) {
      if (!quote) throw new Refusal('No tax could be worked out for this payment.');
      if (rec.amountMinor !== quote.totalMinor) {
        throw new Refusal(
          `The payment (${rec.amountMinor} ${rec.currency}) does not match the price plus tax ` +
            `(${quote.totalMinor} ${quote.currency}).`,
        );
      }
      return {
        netMinor: quote.netMinor,
        taxMinor: quote.taxMinor,
        tax: { lines: quote.lines, mode: quote.mode, jurisdiction: quote.jurisdiction },
      };
    }
    if (rec.amountMinor !== expected.netMinor) {
      throw new Refusal(
        `The payment (${rec.amountMinor} ${rec.currency}) does not match the price ` +
          `(${expected.netMinor}).`,
      );
    }
    const taxMinor = Math.max(0, Math.trunc(rec.taxMinor));
    let lines: BillingTaxLine[] = [];
    if (quote && quote.mode === 'MANUAL' && quote.taxMinor === taxMinor) {
      lines = quote.lines;
    } else if (taxMinor > 0 || quote) {
      lines = [
        {
          label: quote?.mode === 'PROVIDER_AUTOMATIC' ? 'Sales tax (Stripe Tax)' : 'Tax',
          rateBasisPoints: 0,
          baseMinor: rec.amountMinor,
          amountMinor: taxMinor,
        },
      ];
    }
    return {
      netMinor: rec.amountMinor,
      taxMinor,
      tax: {
        lines,
        mode: quote?.mode ?? 'NONE',
        jurisdiction: quote?.jurisdiction ?? null,
      },
    };
  }

  /** The tax the rules give for a plan price now, or a Refusal when none applies. */
  private async quoteOrRefuse(
    account: OrganizerBillingAccount,
    amountMinor: number,
    currency: string,
    at: Date,
  ): Promise<BillingTaxQuote | null> {
    if (!this.tax) return null;
    try {
      return await this.tax.quote({
        organizationId: account.organizationId,
        country: account.country,
        currency,
        amountMinor,
        at,
      });
    } catch (err) {
      if (err instanceof AppException) throw new Refusal(err.message);
      throw err;
    }
  }

  private graceDays(): number {
    return Number(this.config.get('BILLING_GRACE_DAYS') ?? 7) || 7;
  }

  // ── Entry points ───────────────────────────────────────────────────────────────

  /** A webhook delivery whose signature the provider already verified. */
  async receive(
    provider: BillingProvider,
    ev: VerifiedBillingEvent,
  ): Promise<ProviderIngestOutcome> {
    if (!ev.providerEventId) {
      throw new AppException(ErrorCodes.BILLING_WEBHOOK_INVALID, 'The event has no id.');
    }
    let rowId: string;
    try {
      const row = await this.prisma.billingWebhookEvent.create({
        data: {
          provider: provider.key,
          providerEventId: ev.providerEventId,
          eventType: ev.providerType ?? ev.type,
          signatureVerified: true,
          occurredAt: ev.occurredAt ? new Date(ev.occurredAt) : null,
          payload: ev.payload as Prisma.InputJsonValue,
        },
      });
      rowId = row.id;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const existing = await this.prisma.billingWebhookEvent.findUnique({
        where: {
          provider_providerEventId: { provider: provider.key, providerEventId: ev.providerEventId },
        },
      });
      // Finished, or (received moments ago) still being processed by the first delivery.
      if (
        !existing ||
        existing.status !== 'RECEIVED' ||
        Date.now() - existing.receivedAt.getTime() < IN_FLIGHT_MS
      ) {
        return { outcome: 'DUPLICATE' };
      }
      rowId = existing.id;
    }
    return this.process(provider, rowId, ev);
  }

  /** Worker: retries events left RECEIVED by a transient failure. */
  async retryPending(now: Date = new Date(), limit = 25): Promise<{ retried: number }> {
    const rows = await this.prisma.billingWebhookEvent.findMany({
      where: {
        status: 'RECEIVED',
        provider: { in: ['STRIPE_BILLING', 'RAZORPAY_BILLING'] },
        receivedAt: { lt: new Date(now.getTime() - IN_FLIGHT_MS) },
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
    let retried = 0;
    for (const row of rows) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await this.prisma.billingWebhookEvent.update({
          where: { id: row.id },
          data: {
            status: 'FAILED',
            error: `Gave up after ${row.attempts} attempts. Last error: ${row.error ?? 'none'}`,
            processedAt: now,
          },
        });
        continue;
      }
      let provider: BillingProvider;
      try {
        provider = await this.registry.byKey(row.provider as BillingProviderKey);
      } catch {
        continue; // Not configured right now; the next sweep tries again.
      }
      if (!provider.parseEvent) continue;
      const ev = provider.parseEvent(row.payload as Record<string, unknown>, row.providerEventId);
      await this.process(provider, row.id, ev);
      retried += 1;
    }
    return { retried };
  }

  private async process(
    provider: BillingProvider,
    rowId: string,
    ev: VerifiedBillingEvent,
  ): Promise<ProviderIngestOutcome> {
    await this.prisma.billingWebhookEvent.update({
      where: { id: rowId },
      data: { attempts: { increment: 1 } },
    });
    try {
      const r = await this.apply(provider, ev);
      await this.prisma.billingWebhookEvent.update({
        where: { id: rowId },
        data: {
          status: r.status,
          error: r.note ?? null,
          accountId: r.accountId ?? null,
          processedAt: new Date(),
        },
      });
      return { outcome: r.status, ...(r.note ? { note: r.note } : {}) };
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 500) : 'unknown';
      if (isTransientBillingError(e)) {
        await this.prisma.billingWebhookEvent.update({
          where: { id: rowId },
          data: { error: `transient: ${reason}` },
        });
        this.logger.warn(`billing event ${ev.providerEventId} deferred: ${reason}`);
        return { outcome: 'DEFERRED', reason };
      }
      await this.prisma.billingWebhookEvent.update({
        where: { id: rowId },
        data: { status: 'FAILED', error: reason, processedAt: new Date() },
      });
      this.logger.warn(`billing event ${ev.providerEventId} not applied: ${reason}`);
      return { outcome: 'FAILED', reason };
    }
  }

  /** What an event means, decided from the provider's own records. */
  async apply(provider: BillingProvider, ev: VerifiedBillingEvent): Promise<Applied> {
    switch (ev.type) {
      case 'IGNORED':
        return {
          status: 'IGNORED',
          note: `Not a billing event (${ev.providerType ?? 'unknown'}).`,
        };
      case 'INVOICE_FINALIZED':
        return {
          status: 'IGNORED',
          note: 'Recorded. The platform invoice is issued when the provider reports it paid.',
        };
      case 'PAYMENT_CAPTURED':
        return this.payment(provider, ev.paymentRef);
      case 'CREDIT_PACK_PAID':
        return this.creditPack(provider, ev.paymentRef);
      case 'DISPUTE_OPENED':
        return this.dispute(provider, ev.objectRef);
      case 'PAYMENT_FAILED': {
        let subRef = ev.providerSubscriptionRef;
        if (!subRef && ev.paymentRef && provider.fetchPaymentRecord) {
          subRef = (await provider.fetchPaymentRecord(ev.paymentRef)).subscriptionRef ?? undefined;
        }
        return this.reconcile(provider, subRef, ev);
      }
      case 'CHECKOUT_COMPLETED':
      case 'SUBSCRIPTION_UPDATED':
      case 'SUBSCRIPTION_HALTED':
      case 'SUBSCRIPTION_CANCELLED':
        return this.reconcile(provider, ev.providerSubscriptionRef, ev);
    }
  }

  // ── Lookups that cross-check the tenant ────────────────────────────────────────

  /**
   * The billing account a provider object belongs to.
   *
   * Stripe: by the provider CUSTOMER, which we created for that account, cross-checked against
   * the organization id in the provider's metadata. Razorpay creates its own customer at mandate
   * authentication, so there: by the organization id in the NOTES our server wrote on the
   * subscription (read back over the API, never from the webhook body), and the account must be
   * bound to Razorpay by a checkout.
   */
  private async accountFor(
    key: BillingProviderKey,
    customerRef: string | null,
    organizationHint: string | null,
  ): Promise<OrganizerBillingAccount> {
    if (key === 'RAZORPAY_BILLING') {
      if (!organizationHint) throw new Refusal('The provider record names no organization.');
      const account = await this.prisma.organizerBillingAccount.findUnique({
        where: { organizationId: organizationHint },
      });
      if (!account || account.provider !== key) {
        throw new Refusal('The provider record belongs to no billing account here.');
      }
      if (
        account.providerCustomerRef &&
        customerRef &&
        account.providerCustomerRef !== customerRef
      ) {
        throw new Refusal('The provider record belongs to another customer.');
      }
      return account;
    }
    if (!customerRef) throw new Refusal('The provider record names no customer.');
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { provider_providerCustomerRef: { provider: key, providerCustomerRef: customerRef } },
    });
    if (!account) throw new Refusal('The provider customer belongs to no billing account here.');
    if (organizationHint && organizationHint !== account.organizationId) {
      throw new Refusal('The provider record names a different organization than its customer.');
    }
    return account;
  }

  private async priceFor(provider: BillingProvider, ref: string | null) {
    if (!ref) return null;
    return this.prisma.billingPrice.findFirst({
      where:
        provider.mode === 'live' ? { providerPriceRefLive: ref } : { providerPriceRefTest: ref },
      include: { plan: true },
    });
  }

  // ── A subscription payment ─────────────────────────────────────────────────────

  private async payment(
    provider: BillingProvider,
    paymentRef: string | undefined,
  ): Promise<Applied> {
    if (!paymentRef) throw new Refusal('The event names no payment.');
    if (!provider.fetchPaymentRecord || !provider.fetchSubscription) {
      throw new Refusal('This provider cannot be asked for its record of a payment.');
    }
    const rec = await provider.fetchPaymentRecord(paymentRef);
    if (!rec.verified)
      throw new Refusal('The provider has no verified paid record of this payment.');
    if (rec.purpose !== 'SUBSCRIPTION') throw new Refusal('This payment is not for a plan.');
    const account = await this.accountFor(provider.key, rec.customerRef, rec.organizationId);
    const price = await this.priceFor(provider, rec.providerPriceRef);
    if (!price) throw new Refusal('The payment is for a price this platform does not know.');
    if (price.country !== account.country) {
      throw new Refusal('The payment is for a price of another country.');
    }
    if (rec.currency !== price.currency) {
      throw new Refusal(
        `The payment (${rec.amountMinor} ${rec.currency}) does not match the price ` +
          `(${price.amountMinor} ${price.currency}).`,
      );
    }
    const paidAt = rec.paidAt ?? new Date();
    // Razorpay's charge cannot be split without the rules. Stripe charged its own tax already:
    // a rule switched off since must not refuse a renewal it paid, so there it is best effort.
    const quoting = this.quoteOrRefuse(account, price.amountMinor, price.currency, paidAt);
    const split = await this.chargedSplit(provider, rec, {
      netMinor: price.amountMinor,
      quote: TAX_INCLUSIVE_CHARGE_PROVIDERS.includes(provider.key)
        ? await quoting
        : await quoting.catch(() => null),
    });
    const subscriptionRef = rec.subscriptionRef;
    if (!subscriptionRef) throw new Refusal('The payment belongs to no subscription.');
    const subRec = await provider.fetchSubscription(subscriptionRef);
    if (!subRec.verified) throw new Refusal('The provider subscription is not a billing one.');
    if (
      subRec.customerRef &&
      account.providerCustomerRef &&
      subRec.customerRef !== account.providerCustomerRef
    ) {
      throw new Refusal('The provider subscription belongs to another customer.');
    }
    if (subRec.organizationId && subRec.organizationId !== account.organizationId) {
      throw new Refusal('The provider subscription names a different organization.');
    }
    const periodStart = rec.periodStart ?? subRec.periodStart ?? new Date();
    const periodEnd =
      rec.periodEnd ??
      subRec.periodEnd ??
      new Date(periodStart.getTime() + (price.interval === 'YEAR' ? 365 : 30) * DAY);
    // The NET amount: the state machine compares it with the price, which is before tax.
    const evidence: PaymentEvidence = {
      verified: true,
      provider: provider.key,
      paymentRef: rec.paymentRef,
      amountMinor: split.netMinor,
      currency: rec.currency,
    };
    const providerLive = ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subRec.status);

    const entries: AuditEntry[] = [];
    let note: string | undefined;
    await this.events.runWithEvents(async (tx, collector) => {
      await this.lock(tx, account.id);
      const applied = await tx.billingPayment.findUnique({
        where: {
          provider_providerPaymentRef: {
            provider: provider.key,
            providerPaymentRef: rec.paymentRef,
          },
        },
      });
      if (applied) {
        note = ALREADY_APPLIED;
        return;
      }
      const payment = await tx.billingPayment.create({
        data: {
          accountId: account.id,
          provider: provider.key,
          providerPaymentRef: rec.paymentRef,
          amountMinor: split.netMinor,
          taxMinor: split.taxMinor,
          currency: rec.currency,
          purpose: 'SUBSCRIPTION',
          status: 'SUCCEEDED',
          verifiedAt: new Date(),
        },
      });
      const current = await tx.organizerSubscription.findUnique({
        where: { currentKey: account.id },
      });
      const move = async (event: SubscriptionEvent, auditAction: string) => {
        const r = await this.subscriptions.applyInTx(tx, account.organizationId, event, {
          auditAction,
          priceId: price.id,
          providerSubscriptionRef: subscriptionRef,
        });
        entries.push(r.entry);
        collector.collect(
          this.changed(account.organizationId, r.row, r.from, event.type, price.plan.code),
        );
        return r.row;
      };

      let subscriptionId: string | null = null;
      if (
        current &&
        current.providerSubscriptionRef === subscriptionRef &&
        LIVE_PAID.includes(current.status)
      ) {
        subscriptionId = current.id;
        if (price.planId !== current.planId && current.status === 'ACTIVE') {
          await move(
            { type: 'CHANGE_PLAN_NOW', planId: price.planId, evidence },
            'BILLING_PLAN_CHANGED_BY_PROVIDER',
          );
        }
        if (!current.currentPeriodEnd || periodEnd.getTime() > current.currentPeriodEnd.getTime()) {
          await move({ type: 'RENEW', periodEnd, evidence }, 'BILLING_SUBSCRIPTION_RENEWED');
        } else {
          note = 'A payment for a period already applied: recorded, subscription unchanged.';
        }
      } else if (!providerLive) {
        note = 'Payment recorded. The provider subscription is no longer live; nothing activated.';
      } else if (
        !current ||
        isTerminal(current.status) ||
        current.status === 'TRIALING' ||
        current.status === 'COMPLIMENTARY'
      ) {
        const ended = await tx.organizerSubscription.findUnique({
          where: { providerSubscriptionRef: subscriptionRef },
        });
        if (ended) {
          note =
            'Payment recorded. That provider subscription already ended here; not reactivated.';
        } else {
          const row = await move(
            { type: 'ACTIVATE', planId: price.planId, periodStart, periodEnd, evidence },
            'BILLING_SUBSCRIPTION_ACTIVATED',
          );
          subscriptionId = row.id;
        }
      } else {
        // A second live paid subscription for one organization: money taken, nothing granted.
        note = 'Payment recorded. This organization already has another paid subscription.';
        const entry: AuditEntry = {
          actorUserId: null,
          organizationId: account.organizationId,
          action: 'BILLING_DUPLICATE_SUBSCRIPTION_PAYMENT',
          entityType: 'BillingPayment',
          entityId: payment.id,
          metadata: { providerSubscriptionRef: subscriptionRef, paymentRef: rec.paymentRef },
        };
        await this.audit.recordInTransaction(tx, entry);
        entries.push(entry);
      }

      const { invoice } = await this.invoices.recordPaidInTx(tx, {
        accountId: account.id,
        provider: provider.key as 'STRIPE_BILLING' | 'RAZORPAY_BILLING',
        providerInvoiceRef: rec.invoiceRef ?? rec.paymentRef,
        currency: rec.currency,
        lines: [
          {
            description: `${price.plan.name} plan, ${price.interval === 'YEAR' ? 'yearly' : 'monthly'}`,
            quantity: 1,
            unitAmountMinor: split.netMinor,
          },
        ],
        taxMinor: split.taxMinor,
        tax: split.tax,
        subscriptionId,
        periodStart,
        periodEnd,
        paidAt,
      });
      await tx.billingPayment.update({
        where: { id: payment.id },
        data: { invoiceId: invoice.id },
      });
    });
    this.entitlements.bust(account.organizationId);
    for (const e of entries) this.audit.afterCommit(e);
    return {
      status: note === ALREADY_APPLIED ? 'IGNORED' : 'PROCESSED',
      note,
      accountId: account.id,
    };
  }

  // ── Status changes: reconcile with the provider's record ───────────────────────

  private async reconcile(
    provider: BillingProvider,
    subRef: string | undefined,
    ev: VerifiedBillingEvent,
  ): Promise<Applied> {
    if (!subRef) return { status: 'IGNORED', note: 'The event names no subscription.' };
    if (!provider.fetchSubscription) throw new Refusal('This provider cannot be asked.');
    const local = await this.prisma.organizerSubscription.findUnique({
      where: { providerSubscriptionRef: subRef },
      include: { account: true, plan: true },
    });
    const occurredAt = ev.occurredAt ? new Date(ev.occurredAt) : null;

    if (!local) {
      // Activation needs a payment. If the provider already holds a paid one, that is it.
      const subRec = await provider.fetchSubscription(subRef);
      if (subRec.verified && subRec.status === 'ACTIVE' && subRec.latestPaidPaymentRef) {
        return this.payment(provider, subRec.latestPaidPaymentRef);
      }
      return {
        status: 'IGNORED',
        note: 'No subscription here for it yet: one starts only with its first verified payment.',
      };
    }
    if (isTerminal(local.status)) {
      return {
        status: 'IGNORED',
        note: 'The subscription already ended.',
        accountId: local.accountId,
      };
    }
    if (occurredAt && local.providerStateAt && occurredAt < local.providerStateAt) {
      return {
        status: 'IGNORED',
        note: 'Stale: older than the newest provider event already applied.',
        accountId: local.accountId,
      };
    }

    const subRec = await provider.fetchSubscription(subRef);
    if (!subRec.verified) throw new Refusal('The provider subscription is not a billing one.');
    if (
      subRec.customerRef &&
      local.account.providerCustomerRef &&
      subRec.customerRef !== local.account.providerCustomerRef
    ) {
      throw new Refusal('The provider subscription belongs to another customer.');
    }
    // Recovery: the provider has a paid invoice we never applied (a missed or late event).
    if (
      subRec.status === 'ACTIVE' &&
      subRec.latestPaidPaymentRef &&
      ['PAST_DUE', 'GRACE'].includes(local.status)
    ) {
      return this.payment(provider, subRec.latestPaidPaymentRef);
    }

    const moves = this.movesFor(local, subRec, ev);
    if (moves.length === 0) {
      // Reconciled to the provider's state as of now, which subsumes anything older.
      await this.stamp(this.prisma as unknown as Tx, local.id, occurredAt);
      return {
        status: 'IGNORED',
        note: `Nothing to change: the provider reports ${subRec.status}.`,
        accountId: local.accountId,
      };
    }
    const orgId = local.account.organizationId;
    const entries: AuditEntry[] = [];
    let after: OrganizerSubscription = local;
    await this.events.runWithEvents(async (tx, collector) => {
      for (const [event, auditAction] of moves) {
        const r = await this.subscriptions.applyInTx(tx, orgId, event, { auditAction });
        entries.push(r.entry);
        collector.collect(this.changed(orgId, r.row, r.from, event.type, local.plan.code));
        after = r.row;
      }
      await this.stamp(tx, local.id, occurredAt);
    });
    this.entitlements.bust(orgId);
    for (const e of entries) this.audit.afterCommit(e);
    const stage: DunningStage | null =
      after.status === 'PAST_DUE' ? 'PAST_DUE' : after.status === 'GRACE' ? 'GRACE' : null;
    if (stage) {
      await sendDunning(this.audience, {
        organizationId: orgId,
        subscriptionId: after.id,
        stage,
        planName: local.plan.name,
        currentPeriodEnd: after.currentPeriodEnd,
        graceEndsAt: after.graceEndsAt,
        link: dunningLink(this.config),
      });
    }
    return {
      status: 'PROCESSED',
      note: `Now ${after.status}${after.cancelAtPeriodEnd ? ', ending at the period end' : ''}.`,
      accountId: local.accountId,
    };
  }

  /**
   * The moves that bring our subscription to what the provider reports now. Only moves that
   * the provider's CURRENT state justifies: an event that says "failed" about a subscription the
   * provider now reports paid changes nothing.
   */
  private movesFor(
    local: OrganizerSubscription,
    rec: ProviderSubscriptionRecord,
    ev: VerifiedBillingEvent,
  ): Array<[SubscriptionEvent, string]> {
    const graceEndsAt = new Date(Date.now() + this.graceDays() * DAY);
    switch (rec.status) {
      case 'CANCELLED':
      case 'COMPLETED':
        return [[{ type: 'CANCEL_NOW' }, 'BILLING_CANCELLED_BY_PROVIDER']];
      case 'HALTED':
        if (local.status === 'ACTIVE') {
          return [
            [{ type: 'PAYMENT_FAILED' }, 'BILLING_PAYMENT_FAILED'],
            [{ type: 'ENTER_GRACE', graceEndsAt }, 'BILLING_GRACE_STARTED'],
          ];
        }
        return local.status === 'PAST_DUE'
          ? [[{ type: 'ENTER_GRACE', graceEndsAt }, 'BILLING_GRACE_STARTED']]
          : [];
      case 'PAST_DUE':
        return local.status === 'ACTIVE'
          ? [[{ type: 'PAYMENT_FAILED' }, 'BILLING_PAYMENT_FAILED']]
          : [];
      case 'ACTIVE':
      case 'TRIALING': {
        if (ev.type === 'SUBSCRIPTION_CANCELLED' || ev.type === 'PAYMENT_FAILED') return [];
        if (
          rec.cancelAtPeriodEnd === true &&
          (local.status === 'ACTIVE' || local.status === 'PAST_DUE') &&
          !local.cancelAtPeriodEnd
        ) {
          return [[{ type: 'CANCEL_AT_PERIOD_END' }, 'BILLING_CANCEL_SCHEDULED_BY_PROVIDER']];
        }
        if (
          rec.cancelAtPeriodEnd === false &&
          local.status === 'ACTIVE' &&
          local.cancelAtPeriodEnd
        ) {
          return [[{ type: 'RESUME' }, 'BILLING_RESUMED_BY_PROVIDER']];
        }
        return [];
      }
      default:
        return [];
    }
  }

  // ── A credit pack ──────────────────────────────────────────────────────────────

  private async creditPack(
    provider: BillingProvider,
    paymentRef: string | undefined,
  ): Promise<Applied> {
    if (!paymentRef) throw new Refusal('The event names no payment.');
    if (!provider.fetchPaymentRecord) throw new Refusal('This provider cannot be asked.');
    const rec: ProviderPaymentRecord = await provider.fetchPaymentRecord(paymentRef);
    if (!rec.verified || rec.purpose !== 'CREDIT_PACK') {
      throw new Refusal('The provider has no verified paid record of this credit pack.');
    }
    const pack = creditPackByCode(rec.creditPackCode);
    if (!pack) throw new Refusal('The payment names a credit pack this platform does not sell.');
    if (!rec.organizationId) throw new Refusal('The payment names no organization.');
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId: rec.organizationId },
    });
    if (!account) throw new Refusal('The payment names an organization with no billing account.');
    if (account.provider !== provider.key) {
      throw new Refusal('The payment was taken by a provider this account does not use.');
    }
    if (
      rec.customerRef &&
      account.providerCustomerRef &&
      rec.customerRef !== account.providerCustomerRef
    ) {
      throw new Refusal('The payment belongs to another customer.');
    }
    // Checked against what THIS checkout quoted (CreditPackPurchase), never a price staff may
    // have changed since.
    const purchase = rec.purchaseRef
      ? await this.prisma.creditPackPurchase.findUnique({ where: { purchaseRef: rec.purchaseRef } })
      : null;
    if (
      !purchase ||
      purchase.organizationId !== account.organizationId ||
      purchase.packCode !== pack.code ||
      purchase.currency !== rec.currency
    ) {
      throw new Refusal('The payment names no credit pack checkout of this organization.');
    }
    const quoted: BillingTaxQuote = {
      mode: purchase.taxMode as BillingTaxQuote['mode'],
      currency: purchase.currency,
      netMinor: purchase.netMinor,
      taxMinor: purchase.taxMinor,
      totalMinor: purchase.totalMinor,
      lines: purchase.taxLines as unknown as BillingTaxLine[],
      jurisdiction: {
        country: purchase.country,
        region: null,
        sellerRegion: null,
        interState: null,
      },
    };
    const split = await this.chargedSplit(provider, rec, {
      netMinor: purchase.netMinor,
      quote: quoted,
    });

    const entries: AuditEntry[] = [];
    let already = false;
    await this.events.runWithEvents(async (tx, collector) => {
      await this.lock(tx, account.id);
      const applied = await tx.billingPayment.findUnique({
        where: {
          provider_providerPaymentRef: {
            provider: provider.key,
            providerPaymentRef: rec.paymentRef,
          },
        },
      });
      if (applied) {
        already = true;
        return;
      }
      const payment = await tx.billingPayment.create({
        data: {
          accountId: account.id,
          provider: provider.key,
          providerPaymentRef: rec.paymentRef,
          amountMinor: split.netMinor,
          taxMinor: split.taxMinor,
          currency: rec.currency,
          purpose: 'CREDIT_PACK',
          status: 'SUCCEEDED',
          verifiedAt: new Date(),
        },
      });
      const ledger = await tx.usageLedger.create({
        data: {
          organizationId: account.organizationId,
          key: EMAIL_CREDITS_LEDGER_KEY,
          delta: pack.credits,
          reason: 'CREDIT_GRANT',
          refType: 'BillingPayment',
          refId: payment.id,
          periodKey: CREDITS_PERIOD,
          // One grant per provider payment, whatever retries or replays happen.
          idempotencyKey: `billing-pack:${provider.key}:${rec.paymentRef}`,
          note: `Bought: ${pack.name}`,
        },
      });
      const { invoice } = await this.invoices.recordPaidInTx(tx, {
        accountId: account.id,
        provider: provider.key as 'STRIPE_BILLING' | 'RAZORPAY_BILLING',
        providerInvoiceRef: rec.invoiceRef ?? rec.paymentRef,
        currency: rec.currency,
        lines: [{ description: pack.name, quantity: 1, unitAmountMinor: split.netMinor }],
        taxMinor: split.taxMinor,
        tax: split.tax,
        paidAt: rec.paidAt ?? new Date(),
      });
      await tx.creditPackPurchase.update({
        where: { id: purchase.id },
        data: { status: 'PAID', paidAt: rec.paidAt ?? new Date() },
      });
      await tx.billingPayment.update({
        where: { id: payment.id },
        data: { invoiceId: invoice.id },
      });
      const entry: AuditEntry = {
        actorUserId: null,
        organizationId: account.organizationId,
        action: 'BILLING_CREDIT_PACK_PURCHASED',
        entityType: 'UsageLedger',
        entityId: ledger.id,
        metadata: { pack: pack.code, credits: pack.credits, paymentRef: rec.paymentRef },
      };
      await this.audit.recordInTransaction(tx, entry);
      entries.push(entry);
      collector.collect(
        billingCreditsGrantedEvent({
          organizationId: account.organizationId,
          ledgerEntryId: ledger.id,
          key: EMAIL_CREDITS_LEDGER_KEY,
          amount: pack.credits,
          grantedAt: ledger.createdAt.toISOString(),
        }),
      );
    });
    this.entitlements.bust(account.organizationId);
    for (const e of entries) this.audit.afterCommit(e);
    return already
      ? { status: 'IGNORED', note: ALREADY_APPLIED, accountId: account.id }
      : { status: 'PROCESSED', note: `Granted ${pack.credits} credits.`, accountId: account.id };
  }

  // ── A dispute ──────────────────────────────────────────────────────────────────

  private async dispute(
    provider: BillingProvider,
    disputeRef: string | undefined,
  ): Promise<Applied> {
    if (!disputeRef || !provider.fetchDispute) {
      return { status: 'IGNORED', note: 'The event names no dispute this provider can look up.' };
    }
    const rec = await provider.fetchDispute(disputeRef);
    if (!rec.verified || !rec.customerRef) {
      return { status: 'IGNORED', note: 'Not a dispute on a billing customer.' };
    }
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: {
        provider_providerCustomerRef: {
          provider: provider.key,
          providerCustomerRef: rec.customerRef,
        },
      },
    });
    // A ticket payment's dispute: the payments module handles those, on its own webhook.
    if (!account) return { status: 'IGNORED', note: 'Not a dispute on a billing customer.' };
    const entry: AuditEntry = {
      actorUserId: null,
      organizationId: account.organizationId,
      action: 'BILLING_DISPUTE_OPENED',
      entityType: 'OrganizerBillingAccount',
      entityId: account.id,
      metadata: {
        disputeRef: rec.disputeRef,
        paymentRef: rec.paymentRef,
        amountMinor: rec.amountMinor,
        currency: rec.currency,
        reason: rec.reason,
      },
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.organizerBillingAccount.update({
        where: { id: account.id },
        data: { disputedAt: new Date(), disputeRef: rec.disputeRef },
      });
      await this.audit.recordInTransaction(tx, entry);
    });
    this.audit.afterCommit(entry);
    return {
      status: 'PROCESSED',
      note: 'Account flagged for staff review.',
      accountId: account.id,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────

  private async lock(tx: Tx, accountId: string) {
    await tx.$queryRaw`SELECT "id" FROM "OrganizerBillingAccount" WHERE "id" = ${accountId} FOR UPDATE`;
  }

  /**
   * Keeps the newest provider time of a STATUS event reconciled; never moves it backwards.
   *
   * Why an older status event can be dropped: when the newer one was processed, the subscription
   * was fetched from the provider at that moment - after both events happened - so everything the
   * older event could say was already applied. Payments do not stamp: they do not reconcile the
   * status (a cancel scheduled before a renewal must still be picked up from its own event).
   */
  private async stamp(tx: Tx, subscriptionId: string, at: Date | null) {
    if (!at) return;
    await tx.organizerSubscription.updateMany({
      where: {
        id: subscriptionId,
        OR: [{ providerStateAt: null }, { providerStateAt: { lt: at } }],
      },
      data: { providerStateAt: at },
    });
  }

  private changed(
    organizationId: string,
    row: OrganizerSubscription,
    from: string | null,
    transition: string,
    planCode: string,
  ): DomainEvent {
    return billingSubscriptionChangedEvent({
      organizationId,
      subscriptionId: row.id,
      transition,
      fromStatus: from,
      toStatus: row.status,
      planCode,
      changedAt: new Date().toISOString(),
    } as Parameters<typeof billingSubscriptionChangedEvent>[0]);
  }
}
