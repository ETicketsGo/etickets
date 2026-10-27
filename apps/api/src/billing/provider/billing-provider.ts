import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
import type { PaymentEvidence } from '../subscription-state-machine';
import type { BillingTaxQuote } from '../billing-tax.service';

/**
 * Who takes an organizer's plan payment. Stripe Billing (US, stripe-billing.provider.ts) and
 * Razorpay Subscriptions (IN, razorpay-subscriptions.provider.ts) implement it; the disabled
 * provider refuses everything and the mock is a test double.
 *
 * ── THE CONTRACT ───────────────────────────────────────────────────────────────────
 * - `verifyWebhook` checks the provider's signature over the RAW body and throws when it does
 *   not match. Nothing downstream ever sees an unverified event.
 * - `fetchPayment` asks the PROVIDER for its own record of a payment. A webhook saying "paid" is
 *   a claim; a subscription is activated only from what this returns (`verified: true`), and the
 *   amount and currency it reports are what is recorded.
 * - Billing never uses ticket provider names, routes or webhook tables: `STRIPE_BILLING` and
 *   `RAZORPAY_BILLING` are names of their own, with their own endpoints when they arrive.
 */
export type BillingProviderKey = 'NONE' | 'MOCK' | 'STRIPE_BILLING' | 'RAZORPAY_BILLING';

export interface BillingCheckoutRequest {
  organizationId: string;
  accountId: string;
  priceId: string;
  country: string;
  currency: string;
  amountMinor: number;
  interval: 'MONTH' | 'YEAR';
  /** The provider's own id for this price/plan (BillingPrice.providerPriceRef{Test,Live}). */
  providerPriceRef?: string | null;
  /** The provider customer created for this billing account. */
  customerRef?: string | null;
  /** Where the provider sends the organizer back. The page polls our state; never trusts this. */
  successUrl?: string;
  cancelUrl?: string;
  /**
   * The tax on `amountMinor`, from BillingTaxService. The checkout service always passes it and
   * refuses to start a checkout it could not compute (fail closed). How each provider charges it:
   *   Stripe   MANUAL: our rates as Stripe Tax Rates on the line (tax-exclusive prices).
   *            PROVIDER_AUTOMATIC: `automatic_tax`, Stripe Tax decides.
   *   Razorpay the plan's amount IS the total including tax (Razorpay computes no tax), so it
   *            must equal `tax.totalMinor`; the invoice splits it back into net + tax.
   */
  tax?: BillingTaxQuote;
}

export interface BillingCheckoutSession {
  provider: BillingProviderKey;
  sessionRef: string;
  /** Where to send the organizer to pay. */
  url: string;
}

/** Test or live keys. Billing runs on TEST keys only in this change. */
export type BillingKeyMode = 'test' | 'live';

export interface BillingCustomerInput {
  organizationId: string;
  accountId: string;
  name: string;
  email: string | null;
  country: string;
}

/** A one-time purchase of credits, on the BILLING account. Never a ticket order. */
export interface CreditPackCheckoutRequest {
  organizationId: string;
  accountId: string;
  customerRef: string | null;
  packCode: string;
  description: string;
  amountMinor: number;
  currency: string;
  /** Our own id for this purchase attempt: provider idempotency and the receipt reference. */
  purchaseRef: string;
  successUrl: string;
  cancelUrl: string;
  /** As for a plan checkout. `amountMinor` is the price BEFORE tax. */
  tax?: BillingTaxQuote;
}

export type VerifiedBillingEventType =
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_FAILED'
  | 'SUBSCRIPTION_CANCELLED'
  /** Status, cancel-at-period-end or mandate changed: reconcile from the provider's record. */
  | 'SUBSCRIPTION_UPDATED'
  /** Retries are over (Razorpay `halted`, Stripe `unpaid`): enter grace. */
  | 'SUBSCRIPTION_HALTED'
  /** A hosted subscription checkout finished. Reconcile; activation still needs a payment. */
  | 'CHECKOUT_COMPLETED'
  /** A one-time credit pack was paid. Credits are granted only from the provider's record. */
  | 'CREDIT_PACK_PAID'
  | 'INVOICE_FINALIZED'
  | 'DISPUTE_OPENED'
  /** Signed, but nothing billing acts on (an event type we do not use, or a ticket payment). */
  | 'IGNORED';

/** A provider event whose signature has been checked. Still a claim until the provider is asked. */
export interface VerifiedBillingEvent {
  provider: BillingProviderKey;
  providerEventId: string;
  type: VerifiedBillingEventType;
  /** Our organization id as the PROVIDER holds it (metadata/notes). A hint, cross-checked. */
  organizationId: string;
  providerSubscriptionRef?: string;
  paymentRef?: string;
  priceId?: string;
  periodStart?: string;
  periodEnd?: string;
  /** The provider's own event name, e.g. `invoice.paid`, `subscription.charged`. */
  providerType?: string;
  /** When the provider says this happened (ISO). Used to drop stale status-only events. */
  occurredAt?: string;
  /** The provider object the event is about (checkout session, dispute, payment link). */
  objectRef?: string;
  payload: Record<string, unknown>;
}

/** Normalised subscription status, as the PROVIDER reports it now. */
export type ProviderSubscriptionStatus =
  | 'INCOMPLETE'
  | 'AUTHENTICATED'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'HALTED'
  | 'CANCELLED'
  | 'COMPLETED';

/** The provider's own record of a subscription, fetched over its authenticated API. */
export interface ProviderSubscriptionRecord {
  verified: boolean;
  provider: BillingProviderKey;
  subscriptionRef: string;
  customerRef: string | null;
  status: ProviderSubscriptionStatus;
  providerPriceRef: string | null;
  /** Null when the provider does not report a scheduled cancellation (Razorpay). */
  cancelAtPeriodEnd: boolean | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Our organization id from the provider's metadata/notes, when set. */
  organizationId: string | null;
  /** The latest PAID payment on it (invoice id / payment id), when the provider has one. */
  latestPaidPaymentRef: string | null;
}

/**
 * The provider's own record of a payment. For Stripe `amountMinor` EXCLUDES tax, so it compares
 * with the BillingPrice (the plan price), and `taxMinor` is what Stripe added on top. Razorpay
 * computes no tax: its `amountMinor` is everything charged (net + our tax) and `taxMinor` is 0;
 * the event processor splits it back using the tax rules (`TAX_INCLUSIVE_CHARGE_PROVIDERS`).
 */
export interface ProviderPaymentRecord extends PaymentEvidence {
  purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
  taxMinor: number;
  customerRef: string | null;
  subscriptionRef: string | null;
  providerPriceRef: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  organizationId: string | null;
  /** The provider's invoice for it, when there is one. Our invoice is keyed on it. */
  invoiceRef: string | null;
  creditPackCode: string | null;
  /** Our CreditPackPurchase reference from the provider's metadata/notes (packs only). */
  purchaseRef?: string | null;
  paidAt: Date | null;
}

export interface ProviderDisputeRecord {
  verified: boolean;
  disputeRef: string;
  paymentRef: string | null;
  customerRef: string | null;
  amountMinor: number;
  currency: string;
  reason: string | null;
}

export interface BillingProvider {
  readonly key: BillingProviderKey;
  /** False for the disabled provider: nothing can be bought. */
  readonly enabled: boolean;
  /** Test or live keys. Undefined for the disabled provider and the test double. */
  readonly mode?: BillingKeyMode;
  createCheckout(req: BillingCheckoutRequest): Promise<BillingCheckoutSession>;
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<VerifiedBillingEvent>;
  fetchPayment(paymentRef: string): Promise<PaymentEvidence>;

  // ── Real providers only (Stripe Billing, Razorpay Subscriptions) ────────────────
  /** Normalises a payload whose signature was verified when it arrived (retry from storage). */
  parseEvent?(body: Record<string, unknown>, eventIdHint?: string): VerifiedBillingEvent;
  ensureCustomer?(input: BillingCustomerInput): Promise<string>;
  fetchPaymentRecord?(paymentRef: string): Promise<ProviderPaymentRecord>;
  fetchSubscription?(subscriptionRef: string): Promise<ProviderSubscriptionRecord>;
  fetchDispute?(disputeRef: string): Promise<ProviderDisputeRecord>;
  createCreditPackCheckout?(req: CreditPackCheckoutRequest): Promise<BillingCheckoutSession>;
  /** A provider-hosted page to change the payment method or cancel (Stripe only). */
  createPortal?(customerRef: string, returnUrl: string): Promise<{ url: string }>;
  /** Cancel at the end of the current period. Returns the provider's record afterwards. */
  cancelAtPeriodEnd?(subscriptionRef: string): Promise<ProviderSubscriptionRecord>;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/**
 * Providers whose charge is the TOTAL including our tax (they compute none themselves). Their
 * payment record's `amountMinor` is compared with net + tax, never with the net price.
 */
export const TAX_INCLUSIVE_CHARGE_PROVIDERS: readonly BillingProviderKey[] = ['RAZORPAY_BILLING'];

export const BILLING_NOT_ENABLED_MESSAGE =
  'Paid plans are not open yet. Contact ETicketsGo support if you would like to talk about a plan.';

function notEnabled(): never {
  throw new AppException(
    ErrorCodes.BILLING_NOT_ENABLED,
    BILLING_NOT_ENABLED_MESSAGE,
    HttpStatus.CONFLICT,
  );
}

/** The provider while BILLING_ENABLED is off (the default everywhere). Refuses everything. */
export class DisabledBillingProvider implements BillingProvider {
  readonly key = 'NONE' as const;
  readonly enabled = false;
  async createCheckout(): Promise<BillingCheckoutSession> {
    return notEnabled();
  }
  async verifyWebhook(): Promise<VerifiedBillingEvent> {
    return notEnabled();
  }
  async fetchPayment(): Promise<PaymentEvidence> {
    return notEnabled();
  }
}

/**
 * A test double. Refused by the boot check outside LOCAL, DEV and QA
 * (`billingConfigurationErrors`). Events are signed with HMAC-SHA256 over the raw body, header
 * `x-mock-billing-signature`; payments exist only once `capture` records them, so a webhook that
 * names a payment the double never captured verifies as a claim and fails `fetchPayment`.
 */
export class MockBillingProvider implements BillingProvider {
  readonly key = 'MOCK' as const;
  readonly enabled = true;
  private readonly payments = new Map<string, PaymentEvidence>();

  constructor(private readonly secret: string = 'mock-billing-secret') {}

  async createCheckout(req: BillingCheckoutRequest): Promise<BillingCheckoutSession> {
    const sessionRef = `mock_cs_${randomUUID()}`;
    return {
      provider: 'MOCK',
      sessionRef,
      url: `https://billing.mock.invalid/${sessionRef}?p=${req.priceId}`,
    };
  }

  /** Test helper: the provider records a captured payment. */
  capture(paymentRef: string, amountMinor: number, currency: string): void {
    this.payments.set(paymentRef, {
      verified: true,
      provider: 'MOCK',
      paymentRef,
      amountMinor,
      currency,
    });
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<VerifiedBillingEvent> {
    const given = Buffer.from(headers['x-mock-billing-signature'] ?? '', 'utf8');
    const expected = Buffer.from(this.sign(rawBody), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppException(
        ErrorCodes.UNAUTHORIZED,
        'The billing event signature does not match.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const body = JSON.parse(rawBody) as Omit<VerifiedBillingEvent, 'provider' | 'payload'>;
    return { ...body, provider: 'MOCK', payload: JSON.parse(rawBody) };
  }

  async fetchPayment(paymentRef: string): Promise<PaymentEvidence> {
    return (
      this.payments.get(paymentRef) ?? {
        verified: false,
        provider: 'MOCK',
        paymentRef,
        amountMinor: 0,
        currency: '',
      }
    );
  }
}
