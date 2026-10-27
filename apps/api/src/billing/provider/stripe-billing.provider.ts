import { HttpStatus } from '@nestjs/common';
import Stripe from 'stripe';
import { AppException, ErrorCodes } from '../../common/errors';
import type {
  BillingCheckoutRequest,
  BillingCheckoutSession,
  BillingCustomerInput,
  BillingKeyMode,
  BillingProvider,
  CreditPackCheckoutRequest,
  ProviderDisputeRecord,
  ProviderPaymentRecord,
  ProviderSubscriptionRecord,
  ProviderSubscriptionStatus,
  VerifiedBillingEvent,
} from './billing-provider';
import { providerUnavailable } from './provider-errors';

/** Marks every object billing creates on Stripe, so it is never mistaken for a ticket payment. */
export const STRIPE_PURPOSE_SUBSCRIPTION = 'etg_billing_subscription';
export const STRIPE_PURPOSE_CREDIT_PACK = 'etg_billing_credit_pack';

export interface StripeBillingOptions {
  secretKey: string;
  webhookSecret: string;
  mode: BillingKeyMode;
  /** STRIPE_API_VERSION, as the ticket adapter pins it; unset = the installed SDK's pinned one. */
  apiVersion?: string;
  /** Tests inject a fake; production builds the SDK client from the key. */
  client?: Stripe;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : v && typeof v === 'object' ? str((v as Obj).id) : null;
const fromUnix = (v: unknown): Date | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null;

function stripeStatus(s: string): ProviderSubscriptionStatus {
  switch (s) {
    case 'active':
      return 'ACTIVE';
    case 'trialing':
      return 'TRIALING';
    case 'past_due':
      return 'PAST_DUE';
    case 'unpaid':
    case 'paused':
      return 'HALTED';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELLED';
    default:
      return 'INCOMPLETE';
  }
}

/**
 * Stripe Billing for US organizers (USD): hosted Checkout in subscription mode, the Billing
 * Portal for payment methods and cancellation, one-time Checkout for credit packs.
 *
 * Runs on the PLATFORM's own Stripe account. Nothing here touches Connect, transfers, ticket
 * Checkout Sessions or the ticket webhook: billing has its own endpoint
 * (`POST billing/webhooks/stripe`) and its own signing secret (STRIPE_BILLING_WEBHOOK_SECRET).
 *
 * No provider-side trials and no promotion codes: a trial is a staff grant on our side, and the
 * activation rule compares the paid amount with the BillingPrice exactly, so a discounted or
 * $0 trial invoice would (correctly) be refused as a mismatch.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly key = 'STRIPE_BILLING' as const;
  readonly enabled = true;
  readonly mode: BillingKeyMode;
  private readonly client: Stripe;
  private readonly webhookSecret: string;

  constructor(opts: StripeBillingOptions) {
    this.mode = opts.mode;
    this.webhookSecret = opts.webhookSecret;
    this.client =
      opts.client ??
      new Stripe(opts.secretKey, {
        typescript: true,
        maxNetworkRetries: 2,
        ...(opts.apiVersion
          ? { apiVersion: opts.apiVersion as Stripe.StripeConfig['apiVersion'] }
          : {}),
      });
  }

  async ensureCustomer(input: BillingCustomerInput): Promise<string> {
    const customer = await this.call(() =>
      this.client.customers.create(
        {
          name: input.name,
          ...(input.email ? { email: input.email } : {}),
          metadata: {
            organizationId: input.organizationId,
            billingAccountId: input.accountId,
            etg_purpose: STRIPE_PURPOSE_SUBSCRIPTION,
          },
        },
        // One customer per billing account, even when two first checkouts race.
        { idempotencyKey: `etg-bil-customer-${input.accountId}` },
      ),
    );
    return customer.id;
  }

  async createCheckout(req: BillingCheckoutRequest): Promise<BillingCheckoutSession> {
    if (!req.providerPriceRef) throw priceNotSetUp();
    if (!req.customerRef || !req.successUrl || !req.cancelUrl) {
      throw new Error('Stripe billing checkout needs a customer and return URLs.');
    }
    const metadata = {
      organizationId: req.organizationId,
      billingAccountId: req.accountId,
      priceId: req.priceId,
      etg_purpose: STRIPE_PURPOSE_SUBSCRIPTION,
    };
    const session = await this.call(() =>
      this.client.checkout.sessions.create({
        mode: 'subscription',
        customer: req.customerRef!,
        client_reference_id: req.organizationId,
        line_items: [{ price: req.providerPriceRef!, quantity: 1 }],
        metadata,
        subscription_data: { metadata },
        allow_promotion_codes: false,
        success_url: req.successUrl!,
        cancel_url: req.cancelUrl!,
      }),
    );
    if (!session.url) throw providerUnavailable('Stripe did not return a checkout page.');
    return { provider: this.key, sessionRef: session.id, url: session.url };
  }

  async createCreditPackCheckout(req: CreditPackCheckoutRequest): Promise<BillingCheckoutSession> {
    const metadata = {
      organizationId: req.organizationId,
      billingAccountId: req.accountId,
      packCode: req.packCode,
      purchaseRef: req.purchaseRef,
      etg_purpose: STRIPE_PURPOSE_CREDIT_PACK,
    };
    const session = await this.call(() =>
      this.client.checkout.sessions.create(
        {
          mode: 'payment',
          ...(req.customerRef ? { customer: req.customerRef } : {}),
          client_reference_id: req.organizationId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: req.currency.toLowerCase(),
                unit_amount: req.amountMinor,
                product_data: { name: req.description },
              },
            },
          ],
          metadata,
          payment_intent_data: { metadata },
          success_url: req.successUrl,
          cancel_url: req.cancelUrl,
        },
        { idempotencyKey: `etg-bil-pack-${req.purchaseRef}` },
      ),
    );
    if (!session.url) throw providerUnavailable('Stripe did not return a checkout page.');
    return { provider: this.key, sessionRef: session.id, url: session.url };
  }

  async createPortal(customerRef: string, returnUrl: string): Promise<{ url: string }> {
    const portal = await this.call(() =>
      this.client.billingPortal.sessions.create({ customer: customerRef, return_url: returnUrl }),
    );
    return { url: portal.url };
  }

  async cancelAtPeriodEnd(subscriptionRef: string): Promise<ProviderSubscriptionRecord> {
    const sub = await this.call(() =>
      this.client.subscriptions.update(subscriptionRef, { cancel_at_period_end: true }),
    );
    return this.subscriptionRecord(sub as unknown as Obj);
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<VerifiedBillingEvent> {
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(
        rawBody,
        headers['stripe-signature'] ?? '',
        this.webhookSecret,
      );
    } catch {
      throw new AppException(
        ErrorCodes.BILLING_WEBHOOK_INVALID,
        'The billing event signature does not match.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.parseEvent(event as unknown as Obj);
  }

  parseEvent(body: Obj): VerifiedBillingEvent {
    const providerType = str(body.type) ?? '';
    const obj = ((body.data as Obj | undefined)?.object ?? {}) as Obj;
    const meta = (obj.metadata ?? {}) as Obj;
    const base = {
      provider: this.key,
      providerEventId: str(body.id) ?? '',
      providerType,
      occurredAt: fromUnix(body.created)?.toISOString(),
      organizationId: str(meta.organizationId) ?? '',
      payload: body,
    };
    const invoiceSub = (obj.parent as Obj | undefined)?.subscription_details as Obj | undefined;
    switch (providerType) {
      case 'checkout.session.completed': {
        if (obj.mode === 'payment' && meta.etg_purpose === STRIPE_PURPOSE_CREDIT_PACK) {
          return { ...base, type: 'CREDIT_PACK_PAID', paymentRef: str(obj.id) ?? undefined };
        }
        if (obj.mode === 'subscription' && meta.etg_purpose === STRIPE_PURPOSE_SUBSCRIPTION) {
          return {
            ...base,
            type: 'CHECKOUT_COMPLETED',
            objectRef: str(obj.id) ?? undefined,
            providerSubscriptionRef: idOf(obj.subscription) ?? undefined,
          };
        }
        return { ...base, type: 'IGNORED' };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return { ...base, type: 'SUBSCRIPTION_UPDATED', providerSubscriptionRef: str(obj.id)! };
      case 'customer.subscription.deleted':
        return { ...base, type: 'SUBSCRIPTION_CANCELLED', providerSubscriptionRef: str(obj.id)! };
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.finalized': {
        const subRef = idOf(invoiceSub?.subscription);
        if (!subRef) return { ...base, type: 'IGNORED' };
        const subMeta = (invoiceSub?.metadata ?? {}) as Obj;
        return {
          ...base,
          organizationId: str(subMeta.organizationId) ?? '',
          type:
            providerType === 'invoice.paid'
              ? 'PAYMENT_CAPTURED'
              : providerType === 'invoice.payment_failed'
                ? 'PAYMENT_FAILED'
                : 'INVOICE_FINALIZED',
          paymentRef: str(obj.id) ?? undefined,
          providerSubscriptionRef: subRef,
        };
      }
      case 'charge.dispute.created':
        return { ...base, type: 'DISPUTE_OPENED', objectRef: str(obj.id) ?? undefined };
      default:
        return { ...base, type: 'IGNORED' };
    }
  }

  // ── The provider's own records ─────────────────────────────────────────────────

  async fetchSubscription(subscriptionRef: string): Promise<ProviderSubscriptionRecord> {
    const sub = await this.call(() =>
      this.client.subscriptions.retrieve(subscriptionRef, { expand: ['latest_invoice'] }),
    );
    return this.subscriptionRecord(sub as unknown as Obj);
  }

  private subscriptionRecord(sub: Obj): ProviderSubscriptionRecord {
    const item = (((sub.items as Obj | undefined)?.data as Obj[] | undefined) ?? [])[0] ?? {};
    const latest = sub.latest_invoice as Obj | string | null | undefined;
    const latestPaid =
      latest && typeof latest === 'object' && latest.status === 'paid' ? str(latest.id) : null;
    return {
      verified: true,
      provider: this.key,
      subscriptionRef: str(sub.id) ?? '',
      customerRef: idOf(sub.customer),
      status: stripeStatus(str(sub.status) ?? ''),
      providerPriceRef: idOf((item as Obj).price),
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      periodStart: fromUnix((item as Obj).current_period_start),
      periodEnd: fromUnix((item as Obj).current_period_end),
      organizationId: str(((sub.metadata ?? {}) as Obj).organizationId),
      latestPaidPaymentRef: latestPaid,
    };
  }

  async fetchPayment(paymentRef: string) {
    return this.fetchPaymentRecord(paymentRef);
  }

  /** An invoice id (`in_...`, a subscription payment) or a checkout session (`cs_...`, a pack). */
  async fetchPaymentRecord(paymentRef: string): Promise<ProviderPaymentRecord> {
    if (paymentRef.startsWith('cs_')) return this.creditPackRecord(paymentRef);
    const invoice = (await this.call(() =>
      this.client.invoices.retrieve(paymentRef),
    )) as unknown as Obj;
    const subDetails = (invoice.parent as Obj | undefined)?.subscription_details as Obj | undefined;
    const lines = (((invoice.lines as Obj | undefined)?.data as Obj[] | undefined) ?? []).filter(
      (l) => ((l.pricing as Obj | undefined)?.price_details as Obj | undefined)?.price,
    );
    const line = lines[0] ?? {};
    const period = ((line as Obj).period ?? {}) as Obj;
    const taxes = (invoice.total_taxes as { amount?: number }[] | null | undefined) ?? [];
    const taxMinor = taxes.reduce((s, t) => s + (typeof t.amount === 'number' ? t.amount : 0), 0);
    const excl =
      typeof invoice.total_excluding_tax === 'number'
        ? invoice.total_excluding_tax
        : Number(invoice.subtotal ?? 0);
    const paid = invoice.status === 'paid';
    return {
      // Paid, and for exactly one priced subscription line: a proration or a second line is a
      // plan change billing does not take through the provider, and is refused on amount.
      verified: paid && lines.length === 1,
      provider: this.key,
      paymentRef: str(invoice.id) ?? paymentRef,
      amountMinor: excl,
      taxMinor,
      currency: (str(invoice.currency) ?? '').toUpperCase(),
      purpose: 'SUBSCRIPTION',
      customerRef: idOf(invoice.customer),
      subscriptionRef: idOf(subDetails?.subscription),
      providerPriceRef: idOf(
        (((line as Obj).pricing as Obj | undefined)?.price_details as Obj | undefined)?.price,
      ),
      periodStart: fromUnix(period.start),
      periodEnd: fromUnix(period.end),
      organizationId: str(((subDetails?.metadata ?? {}) as Obj).organizationId),
      invoiceRef: str(invoice.id),
      creditPackCode: null,
      paidAt: fromUnix((invoice.status_transitions as Obj | undefined)?.paid_at),
    };
  }

  private async creditPackRecord(sessionRef: string): Promise<ProviderPaymentRecord> {
    const s = (await this.call(() =>
      this.client.checkout.sessions.retrieve(sessionRef),
    )) as unknown as Obj;
    const meta = (s.metadata ?? {}) as Obj;
    const verified =
      s.mode === 'payment' &&
      s.status === 'complete' &&
      s.payment_status === 'paid' &&
      meta.etg_purpose === STRIPE_PURPOSE_CREDIT_PACK;
    return {
      verified,
      provider: this.key,
      paymentRef: str(s.id) ?? sessionRef,
      amountMinor: Number(s.amount_subtotal ?? 0),
      taxMinor: Number((s.total_details as Obj | undefined)?.amount_tax ?? 0),
      currency: (str(s.currency) ?? '').toUpperCase(),
      purpose: 'CREDIT_PACK',
      customerRef: idOf(s.customer),
      subscriptionRef: null,
      providerPriceRef: null,
      periodStart: null,
      periodEnd: null,
      organizationId: str(meta.organizationId),
      invoiceRef: null,
      creditPackCode: str(meta.packCode),
      paidAt: fromUnix(s.created),
    };
  }

  async fetchDispute(disputeRef: string): Promise<ProviderDisputeRecord> {
    const d = (await this.call(() =>
      this.client.disputes.retrieve(disputeRef, { expand: ['charge'] }),
    )) as unknown as Obj;
    const charge = d.charge as Obj | string | undefined;
    return {
      verified: true,
      disputeRef: str(d.id) ?? disputeRef,
      paymentRef: idOf(charge),
      customerRef: charge && typeof charge === 'object' ? idOf(charge.customer) : null,
      amountMinor: Number(d.amount ?? 0),
      currency: (str(d.currency) ?? '').toUpperCase(),
      reason: str(d.reason),
    };
  }

  /** Provider failures become a plain 502; Stripe's own message is not echoed to the organizer. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppException) throw err;
      const type = (err as { type?: string })?.type ?? 'unknown';
      throw providerUnavailable(`Stripe could not complete the billing request (${type}).`);
    }
  }
}

function priceNotSetUp(): AppException {
  return new AppException(
    ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
    'This price is not set up with the payment provider yet. Contact ETicketsGo support.',
    HttpStatus.CONFLICT,
  );
}
