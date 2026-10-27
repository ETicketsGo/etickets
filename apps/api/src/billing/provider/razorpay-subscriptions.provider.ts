import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import Razorpay from 'razorpay';
import { AppException, ErrorCodes } from '../../common/errors';
import type {
  BillingCheckoutRequest,
  BillingCheckoutSession,
  BillingKeyMode,
  BillingProvider,
  CreditPackCheckoutRequest,
  ProviderPaymentRecord,
  ProviderSubscriptionRecord,
  ProviderSubscriptionStatus,
  VerifiedBillingEvent,
} from './billing-provider';
import { capabilityMissing, providerUnavailable } from './provider-errors';

export const RAZORPAY_PURPOSE_SUBSCRIPTION = 'etg_billing_subscription';
export const RAZORPAY_PURPOSE_CREDIT_PACK = 'etg_billing_credit_pack';

type Obj = Record<string, unknown>;

/** The slice of the Razorpay SDK billing uses. Tests pass a fake; nothing here is ticket code. */
export interface RazorpayBillingApi {
  plans: { fetch(id: string): Promise<Obj> };
  subscriptions: {
    create(p: Obj): Promise<Obj>;
    fetch(id: string): Promise<Obj>;
    cancel(id: string, cancelAtCycleEnd?: boolean | number): Promise<Obj>;
  };
  payments: { fetch(id: string): Promise<Obj> };
  invoices: { fetch(id: string): Promise<Obj> };
  paymentLink: { create(p: Obj): Promise<Obj>; fetch(id: string): Promise<Obj> };
}

export interface RazorpaySubscriptionsOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  mode: BillingKeyMode;
  /**
   * The largest recurring amount (paise) this account may charge on a mandate without the
   * customer approving each debit. RBI e-mandate rules: INR 15,000 per debit by default
   * (higher only for notified categories). A price above it is refused before Razorpay is asked.
   */
  mandateMaxMinor: number;
  /** Whether UPI Autopay is enabled on the Razorpay account. Never assumed. */
  upiAutopay: boolean;
  client?: RazorpayBillingApi;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
const fromUnix = (v: unknown): Date | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null;
const entity = (body: Obj, key: string): Obj =>
  ((((body.payload as Obj | undefined)?.[key] as Obj | undefined)?.entity as Obj | undefined) ??
    {}) as Obj;

function razorpayStatus(s: string): ProviderSubscriptionStatus {
  switch (s) {
    case 'authenticated':
      return 'AUTHENTICATED';
    case 'active':
      return 'ACTIVE';
    case 'pending':
      return 'PAST_DUE';
    case 'halted':
    case 'paused':
      return 'HALTED';
    case 'cancelled':
    case 'expired':
      return 'CANCELLED';
    case 'completed':
      return 'COMPLETED';
    default:
      return 'INCOMPLETE';
  }
}

/** A plan "period" + "interval" as our interval, or null when it is something else. */
function planInterval(plan: Obj): 'MONTH' | 'YEAR' | null {
  if (Number(plan.interval) !== 1) return null;
  if (plan.period === 'monthly') return 'MONTH';
  if (plan.period === 'yearly') return 'YEAR';
  return null;
}

/**
 * Razorpay Subscriptions for Indian organizers (INR).
 *
 * The organizer is sent to the subscription's hosted `short_url`, authorises a mandate and
 * pays the first cycle there. Activation happens only from `subscription.charged`, after the
 * payment, its invoice and the subscription are fetched back from Razorpay and agree with the
 * BillingPrice. Credit packs are Razorpay Payment Links (hosted, one-time) on the same account,
 * marked with `notes.etg_purpose` so they are never read as ticket orders: the ticket webhook
 * ignores a payment with no booking, and this provider ignores one without the billing mark.
 *
 * ── RBI E-MANDATE ──────────────────────────────────────────────────────────────────
 * Recurring debits run on an e-mandate (card, UPI Autopay or eNACH, whichever the ACCOUNT has
 * enabled). The authorisation transaction is taken on the hosted page; a debit above the
 * mandate limit needs the customer's approval each time, so a price above `mandateMaxMinor`
 * is refused here with a clear message rather than failing every renewal. UPI Autopay is not
 * assumed: the hosted page offers only what Razorpay has enabled on the account.
 */
export class RazorpaySubscriptionsProvider implements BillingProvider {
  readonly key = 'RAZORPAY_BILLING' as const;
  readonly enabled = true;
  readonly mode: BillingKeyMode;
  readonly upiAutopay: boolean;
  private readonly client: RazorpayBillingApi;
  private readonly webhookSecret: string;
  private readonly mandateMaxMinor: number;

  constructor(opts: RazorpaySubscriptionsOptions) {
    this.mode = opts.mode;
    this.webhookSecret = opts.webhookSecret;
    this.mandateMaxMinor = opts.mandateMaxMinor;
    this.upiAutopay = opts.upiAutopay;
    this.client =
      opts.client ??
      (new Razorpay({
        key_id: opts.keyId,
        key_secret: opts.keySecret,
      }) as unknown as RazorpayBillingApi);
  }

  /*
    No ensureCustomer: Razorpay creates the customer itself when the mandate is authorised, and
    a subscription is bound to our billing account by the notes our server writes on it (read
    back over the API, never from a webhook body). Sending a customer we made would add a
    second, unused customer record per organization.
  */

  async createCheckout(req: BillingCheckoutRequest): Promise<BillingCheckoutSession> {
    if (!req.providerPriceRef) {
      throw capabilityMissing(
        'This price is not set up with the payment provider yet. Contact ETicketsGo support.',
      );
    }
    if (req.amountMinor > this.mandateMaxMinor) {
      throw capabilityMissing(
        'This plan costs more than a recurring payment mandate allows without approving each ' +
          'payment. Contact ETicketsGo support to pay for it another way.',
      );
    }
    // The plan on Razorpay must charge exactly what our price says, or every charge is refused.
    const plan = await this.call(() => this.client.plans.fetch(req.providerPriceRef!));
    const item = (plan.item ?? {}) as Obj;
    if (
      Number(item.amount) !== req.amountMinor ||
      String(item.currency ?? '').toUpperCase() !== req.currency ||
      planInterval(plan) !== req.interval
    ) {
      throw capabilityMissing(
        'The payment provider plan does not match this price. Contact ETicketsGo support.',
      );
    }
    const notes = {
      organizationId: req.organizationId,
      billingAccountId: req.accountId,
      priceId: req.priceId,
      etg_purpose: RAZORPAY_PURPOSE_SUBSCRIPTION,
    };
    const sub = await this.call(() =>
      this.client.subscriptions.create({
        plan_id: req.providerPriceRef,
        // Razorpay needs a cycle count. Ten years; cancellation ends it sooner.
        total_count: req.interval === 'YEAR' ? 10 : 120,
        customer_notify: 1,
        notes,
      }),
    );
    const url = str(sub.short_url);
    if (!url) throw providerUnavailable('Razorpay did not return a payment page.');
    return { provider: this.key, sessionRef: str(sub.id)!, url };
  }

  async createCreditPackCheckout(req: CreditPackCheckoutRequest): Promise<BillingCheckoutSession> {
    const link = await this.call(() =>
      this.client.paymentLink.create({
        amount: req.amountMinor,
        currency: req.currency,
        description: req.description.slice(0, 2048),
        // Unique per purchase on Razorpay's side: a retried request cannot make a second link.
        reference_id: req.purchaseRef.slice(0, 40),
        callback_url: req.successUrl,
        callback_method: 'get',
        notes: {
          organizationId: req.organizationId,
          billingAccountId: req.accountId,
          packCode: req.packCode,
          purchaseRef: req.purchaseRef,
          etg_purpose: RAZORPAY_PURPOSE_CREDIT_PACK,
        },
      }),
    );
    const url = str(link.short_url);
    if (!url) throw providerUnavailable('Razorpay did not return a payment page.');
    return { provider: this.key, sessionRef: str(link.id)!, url };
  }

  async cancelAtPeriodEnd(subscriptionRef: string): Promise<ProviderSubscriptionRecord> {
    const sub = await this.call(() => this.client.subscriptions.cancel(subscriptionRef, true));
    return { ...this.subscriptionRecord(sub), cancelAtPeriodEnd: true };
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<VerifiedBillingEvent> {
    const expected = Buffer.from(
      createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex'),
    );
    const given = Buffer.from(headers['x-razorpay-signature'] ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AppException(
        ErrorCodes.BILLING_WEBHOOK_INVALID,
        'The billing event signature does not match.',
        HttpStatus.BAD_REQUEST,
      );
    }
    let body: Obj;
    try {
      body = JSON.parse(rawBody) as Obj;
    } catch {
      throw new AppException(ErrorCodes.BILLING_WEBHOOK_INVALID, 'The event is not JSON.');
    }
    // Razorpay's event id is in a header, not the body; fall back to the payload's hash.
    const eventId =
      headers['x-razorpay-event-id']?.trim() || createHash('sha256').update(rawBody).digest('hex');
    return this.parseEvent(body, eventId);
  }

  parseEvent(body: Obj, eventIdHint?: string): VerifiedBillingEvent {
    const providerType = str(body.event) ?? '';
    const sub = entity(body, 'subscription');
    const payment = entity(body, 'payment');
    const link = entity(body, 'payment_link');
    const subNotes = (sub.notes ?? {}) as Obj;
    const base = {
      provider: this.key,
      providerEventId: eventIdHint ?? str(body.id) ?? '',
      providerType,
      occurredAt: fromUnix(body.created_at)?.toISOString(),
      organizationId: str(subNotes.organizationId) ?? '',
      payload: body,
    };
    const subRef = str(sub.id) ?? undefined;
    const ownSub = subNotes.etg_purpose === RAZORPAY_PURPOSE_SUBSCRIPTION;
    switch (providerType) {
      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.updated':
      case 'subscription.paused':
      case 'subscription.resumed':
        return ownSub
          ? { ...base, type: 'SUBSCRIPTION_UPDATED', providerSubscriptionRef: subRef }
          : { ...base, type: 'IGNORED' };
      case 'subscription.charged':
        return ownSub
          ? {
              ...base,
              type: 'PAYMENT_CAPTURED',
              providerSubscriptionRef: subRef,
              paymentRef: str(payment.id) ?? undefined,
            }
          : { ...base, type: 'IGNORED' };
      case 'subscription.pending':
        return ownSub
          ? { ...base, type: 'PAYMENT_FAILED', providerSubscriptionRef: subRef }
          : { ...base, type: 'IGNORED' };
      case 'subscription.halted':
        return ownSub
          ? { ...base, type: 'SUBSCRIPTION_HALTED', providerSubscriptionRef: subRef }
          : { ...base, type: 'IGNORED' };
      case 'subscription.cancelled':
      case 'subscription.completed':
        return ownSub
          ? { ...base, type: 'SUBSCRIPTION_CANCELLED', providerSubscriptionRef: subRef }
          : { ...base, type: 'IGNORED' };
      case 'payment.failed': {
        // A failed subscription debit (it carries an invoice). A ticket payment, or a failed
        // credit-pack attempt, changes nothing here: nothing was granted for either.
        const invoiceId = str(payment.invoice_id);
        return invoiceId
          ? { ...base, type: 'PAYMENT_FAILED', paymentRef: str(payment.id) ?? undefined }
          : { ...base, type: 'IGNORED' };
      }
      case 'payment_link.paid': {
        const notes = (link.notes ?? {}) as Obj;
        return notes.etg_purpose === RAZORPAY_PURPOSE_CREDIT_PACK
          ? {
              ...base,
              organizationId: str(notes.organizationId) ?? '',
              type: 'CREDIT_PACK_PAID',
              paymentRef: str(link.id) ?? undefined,
            }
          : { ...base, type: 'IGNORED' };
      }
      default:
        return { ...base, type: 'IGNORED' };
    }
  }

  // ── The provider's own records ─────────────────────────────────────────────────

  async fetchSubscription(subscriptionRef: string): Promise<ProviderSubscriptionRecord> {
    return this.subscriptionRecord(
      await this.call(() => this.client.subscriptions.fetch(subscriptionRef)),
    );
  }

  private subscriptionRecord(sub: Obj): ProviderSubscriptionRecord {
    const notes = (sub.notes ?? {}) as Obj;
    return {
      verified: notes.etg_purpose === RAZORPAY_PURPOSE_SUBSCRIPTION,
      provider: this.key,
      subscriptionRef: str(sub.id) ?? '',
      customerRef: str(sub.customer_id),
      status: razorpayStatus(str(sub.status) ?? ''),
      providerPriceRef: str(sub.plan_id),
      // Razorpay does not report a scheduled cancellation on the subscription; ours is recorded
      // when we ask for it (cancelAtPeriodEnd), so reconciliation never "resumes" it.
      cancelAtPeriodEnd: null,
      periodStart: fromUnix(sub.current_start),
      periodEnd: fromUnix(sub.current_end),
      organizationId: str(notes.organizationId),
      latestPaidPaymentRef: null,
    };
  }

  async fetchPayment(paymentRef: string) {
    return this.fetchPaymentRecord(paymentRef);
  }

  /** A payment id (`pay_...`, a subscription debit) or a payment link (`plink_...`, a pack). */
  async fetchPaymentRecord(paymentRef: string): Promise<ProviderPaymentRecord> {
    if (paymentRef.startsWith('plink_')) return this.creditPackRecord(paymentRef);
    const payment = await this.call(() => this.client.payments.fetch(paymentRef));
    const invoiceId = str(payment.invoice_id);
    const invoice = invoiceId ? await this.call(() => this.client.invoices.fetch(invoiceId)) : {};
    const subRef = str((invoice as Obj).subscription_id);
    const sub = subRef ? await this.call(() => this.client.subscriptions.fetch(subRef)) : {};
    const subNotes = ((sub as Obj).notes ?? {}) as Obj;
    const captured = payment.status === 'captured';
    return {
      verified: captured && !!subRef && subNotes.etg_purpose === RAZORPAY_PURPOSE_SUBSCRIPTION,
      provider: this.key,
      paymentRef: str(payment.id) ?? paymentRef,
      amountMinor: Number(payment.amount ?? 0),
      // Razorpay charges the plan amount as is; it computes no tax on subscriptions.
      taxMinor: 0,
      currency: (str(payment.currency) ?? '').toUpperCase(),
      purpose: 'SUBSCRIPTION',
      customerRef: str((sub as Obj).customer_id) ?? str(payment.customer_id),
      subscriptionRef: subRef,
      providerPriceRef: str((sub as Obj).plan_id),
      periodStart: fromUnix((invoice as Obj).billing_start) ?? fromUnix((sub as Obj).current_start),
      periodEnd: fromUnix((invoice as Obj).billing_end) ?? fromUnix((sub as Obj).current_end),
      organizationId: str(subNotes.organizationId),
      invoiceRef: invoiceId,
      creditPackCode: null,
      paidAt: fromUnix(payment.created_at),
    };
  }

  private async creditPackRecord(linkRef: string): Promise<ProviderPaymentRecord> {
    const link = await this.call(() => this.client.paymentLink.fetch(linkRef));
    const notes = (link.notes ?? {}) as Obj;
    const verified =
      link.status === 'paid' &&
      Number(link.amount_paid) === Number(link.amount) &&
      notes.etg_purpose === RAZORPAY_PURPOSE_CREDIT_PACK;
    return {
      verified,
      provider: this.key,
      paymentRef: str(link.id) ?? linkRef,
      amountMinor: Number(link.amount_paid ?? 0),
      taxMinor: 0,
      currency: (str(link.currency) ?? '').toUpperCase(),
      purpose: 'CREDIT_PACK',
      customerRef: str(((link.customer ?? {}) as Obj).id),
      subscriptionRef: null,
      providerPriceRef: null,
      periodStart: null,
      periodEnd: null,
      organizationId: str(notes.organizationId),
      invoiceRef: null,
      creditPackCode: str(notes.packCode),
      paidAt: fromUnix(link.updated_at),
    };
  }

  /** Maps a missing Subscriptions feature to a clear refusal; other failures to a plain 502. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppException) throw err;
      const e = err as { statusCode?: number; error?: { description?: string } };
      const description = String(e?.error?.description ?? '').toLowerCase();
      if (description.includes('not enabled') || description.includes('feature')) {
        throw capabilityMissing(
          'Paying for a plan through Razorpay is not switched on for this account yet ' +
            '(Razorpay Subscriptions). Contact ETicketsGo support.',
        );
      }
      if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
        throw capabilityMissing(
          'Razorpay refused the billing request. Contact ETicketsGo support.',
        );
      }
      throw providerUnavailable('Razorpay could not complete the billing request.');
    }
  }
}
