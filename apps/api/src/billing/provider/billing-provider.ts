import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
import type { PaymentEvidence } from '../subscription-state-machine';

/**
 * Who takes an organizer's plan payment. Stripe Billing (US) and Razorpay Subscriptions (IN)
 * implement this in a later change; this change ships only the seam, the disabled provider that
 * refuses everything, and a test double.
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
}

export interface BillingCheckoutSession {
  provider: BillingProviderKey;
  sessionRef: string;
  /** Where to send the organizer to pay. */
  url: string;
}

export type VerifiedBillingEventType =
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_FAILED'
  | 'SUBSCRIPTION_CANCELLED';

/** A provider event whose signature has been checked. Still a claim until `fetchPayment`. */
export interface VerifiedBillingEvent {
  provider: BillingProviderKey;
  providerEventId: string;
  type: VerifiedBillingEventType;
  organizationId: string;
  providerSubscriptionRef?: string;
  paymentRef?: string;
  priceId?: string;
  periodStart?: string;
  periodEnd?: string;
  payload: Record<string, unknown>;
}

export interface BillingProvider {
  readonly key: BillingProviderKey;
  /** False for the disabled provider: nothing can be bought. */
  readonly enabled: boolean;
  createCheckout(req: BillingCheckoutRequest): Promise<BillingCheckoutSession>;
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<VerifiedBillingEvent>;
  fetchPayment(paymentRef: string): Promise<PaymentEvidence>;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

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
    return { provider: 'MOCK', sessionRef, url: `https://billing.mock.invalid/${sessionRef}?p=${req.priceId}` };
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
