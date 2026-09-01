import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppException, ErrorCodes } from '../../common/errors';
import { redirectUrl } from '../../common/console-urls';
import type {
  ConnectedAccountSnapshot,
  CreateConnectedAccountInput,
  CreateConnectedAccountResult,
  CreatePaymentInput,
  DashboardLinkResult,
  HealthCheckResult,
  OnboardingLinkInput,
  OnboardingLinkResult,
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  RefundInput,
  RefundResult,
  TransferInput,
  TransferResult,
  TransferReversalInput,
  TransferReversalResult,
  WebhookEnvelope,
  WebhookInput,
} from './payment-provider.interface';
import { PaymentMethod, type PaymentProviderCapabilities } from '../domain/payment-capabilities';

/**
 * Stripe (global) provider. Buyers pay via a hosted Stripe Checkout Session
 * (we return its URL as clientActionUrl); settlement is confirmed only via the
 * signature-verified webhook, never from the browser redirect.
 *
 * Sandbox vs production is purely a matter of test vs live API keys — same code.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly webhookSignatureHeader = 'stripe-signature';
  readonly capabilities: PaymentProviderCapabilities = {
    countries: ['US', 'CA', 'GB', 'AU', 'AE', 'SG', 'IE', 'NZ', 'DE', 'FR'],
    currencies: ['USD', 'CAD', 'GBP', 'AUD', 'AED', 'SGD', 'EUR', 'NZD'],
    paymentMethods: [PaymentMethod.CARD, PaymentMethod.APPLE_PAY, PaymentMethod.GOOGLE_PAY],
    supportsPartialRefunds: true,
    supportsMultiplePartialRefunds: true,
    supportsAuthorizeCapture: true,
    supportsVoid: false,
    supportsIdempotentVoid: false,
    supportsPaymentStatusQuery: false,
    supportsFullRefund: true,
    supportsIdempotentRefund: false,
    supportsRefundStatusQuery: false,
    refundMayBeAsynchronous: false,
    supportsConnectedAccounts: true,
    supportsApplePay: true,
    supportsGooglePay: true,
    supportsUPI: false,
    supportsNetBanking: false,
    supportsWallets: true,
  };

  private readonly client: Stripe;
  private readonly webhookSecret: string;
  private readonly successUrl: string;
  private readonly cancelUrl: string;
  private readonly testMode: boolean;
  /** Connected-account type for organizer onboarding (express | standard | custom). */
  private readonly connectAccountType: string;

  constructor(config: ConfigService) {
    const secretKey = requireKey(config, 'STRIPE_SECRET_KEY');
    this.webhookSecret = requireKey(config, 'STRIPE_WEBHOOK_SECRET');
    /*
      Derived from where the storefront actually is, not from a localhost default.

      Resolved in the CONSTRUCTOR rather than per payment, so a misconfigured environment
      fails when the adapter is first built — at the first attempt to pay, with a message
      naming the missing variable — instead of quietly handing Stripe a localhost redirect
      and losing the customer after the charge.
    */
    this.successUrl = redirectUrl(config, {
      overrideVariable: 'STRIPE_SUCCESS_URL',
      site: 'customer',
      path: '/checkout/success',
      // Stripe substitutes this placeholder itself; it must survive verbatim.
      query: 'session_id={CHECKOUT_SESSION_ID}',
      purpose: 'Stripe Checkout success',
    });
    this.cancelUrl = redirectUrl(config, {
      overrideVariable: 'STRIPE_CANCEL_URL',
      site: 'customer',
      path: '/checkout/cancel',
      purpose: 'Stripe Checkout cancel',
    });
    this.connectAccountType = config.get<string>('STRIPE_CONNECT_ACCOUNT_TYPE') ?? 'express';
    this.testMode = secretKey.startsWith('sk_test_');
    // Pin the API version when configured so dashboard/SDK upgrades are deliberate;
    // otherwise use the installed SDK's pinned default.
    const apiVersion = config.get<string>('STRIPE_API_VERSION');
    this.client = new Stripe(secretKey, {
      typescript: true,
      ...(apiVersion ? { apiVersion: apiVersion as Stripe.StripeConfig['apiVersion'] } : {}),
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const mode = this.testMode ? 'test' : 'live';
    try {
      await this.client.balance.retrieve();
      return { healthy: true, mode };
    } catch (err) {
      return { healthy: false, mode, message: err instanceof Error ? err.message : 'unhealthy' };
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    // Non-sensitive metadata only (bookingId + eventId/organizerId/customerId/env).
    const metadata: Record<string, string> = {
      bookingId: input.bookingId,
      ...(input.metadata ?? {}),
    };
    // Separate Charges & Transfers: the charge lands on the PLATFORM (no transfer_data
    // / application_fee / on_behalf_of here). We tag it with transfer_group so a later
    // authorised transfer can move the organizer's proceeds after the event.
    const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData = {
      metadata,
      ...(input.transferGroup ? { transfer_group: input.transferGroup } : {}),
    };
    const session = await this.client.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: input.buyerEmail,
        client_reference_id: input.bookingId,
        metadata,
        // Propagate metadata onto the PaymentIntent so payment_intent.* webhooks
        // can resolve the booking too (session metadata is not copied automatically).
        payment_intent_data: paymentIntentData,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency,
              unit_amount: input.amountMinor,
              product_data: { name: input.description ?? `ETicketsGo booking ${input.bookingId}` },
            },
          },
        ],
        // Carry the booking id back so the success page can poll our status (the
        // redirect itself is NEVER treated as proof of payment — the webhook is).
        success_url: appendParam(this.successUrl, 'booking', input.bookingId),
        cancel_url: appendParam(this.cancelUrl, 'booking', input.bookingId),
      },
      // Idempotency: retries with the same bookingId never create a second Session.
      { idempotencyKey: input.idempotencyKey },
    );

    if (!session.url) {
      throw new AppException(
        ErrorCodes.INTERNAL,
        'Stripe did not return a Checkout URL.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      providerRef: typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
      clientActionUrl: session.url,
      status: 'REQUIRES_PAYMENT',
    };
  }

  async verifyWebhook(input: WebhookInput): Promise<PaymentEvent> {
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(
        input.rawBody,
        input.signature,
        this.webhookSecret,
      );
    } catch {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid webhook signature.',
        HttpStatus.BAD_REQUEST,
      );
    }

    switch (event.type) {
      case 'checkout.session.completed':
        return this.fromSession(event.data.object, 'payment.succeeded');
      case 'checkout.session.async_payment_failed':
        return this.fromSession(event.data.object, 'payment.failed');
      case 'payment_intent.succeeded':
        return this.fromPaymentIntent(event.data.object, 'payment.succeeded');
      case 'payment_intent.payment_failed':
        return this.fromPaymentIntent(event.data.object, 'payment.failed');
      default:
        // handleWebhook only understands succeeded/failed; reject anything else
        // with a 4xx rather than mis-routing it.
        throw new AppException(
          ErrorCodes.PAYMENT_WEBHOOK_INVALID,
          `Unhandled Stripe event: ${event.type}.`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  /**
   * Verify a Stripe webhook signature and normalize it for the durable webhook
   * pipeline. Unlike verifyWebhook (which only understands succeeded/failed), this
   * returns the full event so refunds, disputes, transfers, payouts and
   * account.updated can be dispatched.
   */
  verifySignedEnvelope(input: WebhookInput): WebhookEnvelope {
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(
        input.rawBody,
        input.signature,
        this.webhookSecret,
      );
    } catch {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid webhook signature.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      id: event.id,
      type: event.type,
      createdAt: event.created,
      account: event.account ?? null,
      object: event.data.object,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await this.client.refunds.create({
      payment_intent: input.providerRef,
      amount: input.amountMinor,
      reason: input.reason === 'requested_by_customer' ? 'requested_by_customer' : undefined,
    });
    return {
      providerRef: refund.id,
      status: refund.status === 'failed' || refund.status === 'canceled' ? 'FAILED' : 'COMPLETED',
    };
  }

  // ─── Connect (marketplace) ───

  async createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<CreateConnectedAccountResult> {
    const account = await this.client.accounts.create({
      type: this.connectAccountType as Stripe.AccountCreateParams.Type,
      country: input.country,
      ...(input.email ? { email: input.email } : {}),
      // Request only the capabilities a ticketing marketplace needs.
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      // Link back to the organization; never store PII in metadata.
      metadata: { organizationId: input.organizationId },
    });
    return { accountId: account.id };
  }

  async getConnectedAccount(accountId: string): Promise<ConnectedAccountSnapshot> {
    const a = await this.client.accounts.retrieve(accountId);
    return {
      accountId: a.id,
      detailsSubmitted: a.details_submitted ?? false,
      chargesEnabled: a.charges_enabled ?? false,
      payoutsEnabled: a.payouts_enabled ?? false,
      requirementsCurrentlyDue: a.requirements?.currently_due ?? [],
      disabledReason: a.requirements?.disabled_reason ?? null,
      defaultCurrency: a.default_currency ?? null,
      country: a.country ?? null,
    };
  }

  async createOnboardingLink(input: OnboardingLinkInput): Promise<OnboardingLinkResult> {
    const link = await this.client.accountLinks.create({
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url, expiresAt: link.expires_at };
  }

  async createDashboardLink(accountId: string): Promise<DashboardLinkResult> {
    // Login links exist only for accounts where Stripe hosts the dashboard (Express/
    // Custom). Standard accounts use their own full Stripe dashboard — no login link.
    if (this.connectAccountType === 'standard') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Dashboard login links are not available for Standard connected accounts.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const link = await this.client.accounts.createLoginLink(accountId);
    return { url: link.url };
  }

  async createTransfer(input: TransferInput): Promise<TransferResult> {
    try {
      const transfer = await this.client.transfers.create(
        {
          amount: input.amountMinor,
          currency: input.currency,
          destination: input.destinationAccountId,
          ...(input.transferGroup ? { transfer_group: input.transferGroup } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        // Idempotency: a re-run of the same settlement never double-transfers.
        { idempotencyKey: input.idempotencyKey },
      );
      return { transferId: transfer.id, status: 'COMPLETED' };
    } catch (err) {
      // Surface a typed failure to the settlement service (which records FAILED) rather
      // than throwing raw Stripe errors up the stack.
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        err instanceof Error ? err.message : 'Stripe transfer failed.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async reverseTransfer(input: TransferReversalInput): Promise<TransferReversalResult> {
    const reversal = await this.client.transfers.createReversal(
      input.transferId,
      { ...(input.amountMinor != null ? { amount: input.amountMinor } : {}) },
      { idempotencyKey: input.idempotencyKey },
    );
    return { reversalId: reversal.id, status: 'COMPLETED' };
  }

  private fromSession(session: Stripe.Checkout.Session, type: PaymentEvent['type']): PaymentEvent {
    const bookingId = session.metadata?.bookingId ?? session.client_reference_id ?? undefined;
    const amountMinor = session.amount_total;
    if (!bookingId || typeof amountMinor !== 'number') {
      throw this.missingFields();
    }
    const providerRef =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? session.id);
    return { type, providerRef, bookingId, amountMinor };
  }

  private fromPaymentIntent(pi: Stripe.PaymentIntent, type: PaymentEvent['type']): PaymentEvent {
    const bookingId = pi.metadata?.bookingId;
    const amountMinor = pi.amount_received || pi.amount;
    if (!bookingId || typeof amountMinor !== 'number') {
      throw this.missingFields();
    }
    return { type, providerRef: pi.id, bookingId, amountMinor };
  }

  private missingFields(): AppException {
    return new AppException(
      ErrorCodes.PAYMENT_WEBHOOK_INVALID,
      'Webhook payload is missing bookingId or amount.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** Append a query param to a URL string, preserving any existing query (incl. Stripe's
 * {CHECKOUT_SESSION_ID} placeholder). */
function appendParam(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `PAYMENT_PROVIDER_NAME=stripe requires ${key} to be set. ` +
        `Use Stripe test keys for sandbox, live keys for production.`,
    );
  }
  return value;
}
