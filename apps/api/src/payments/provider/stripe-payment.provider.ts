import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppException, ErrorCodes } from '../../common/errors';
import type {
  CreatePaymentInput,
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookInput,
} from './payment-provider.interface';

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

  private readonly client: Stripe;
  private readonly webhookSecret: string;
  private readonly successUrl: string;
  private readonly cancelUrl: string;

  constructor(config: ConfigService) {
    const secretKey = requireKey(config, 'STRIPE_SECRET_KEY');
    this.webhookSecret = requireKey(config, 'STRIPE_WEBHOOK_SECRET');
    // These have config-schema defaults, so getOrThrow-style access is safe.
    this.successUrl = config.getOrThrow<string>('STRIPE_SUCCESS_URL');
    this.cancelUrl = config.getOrThrow<string>('STRIPE_CANCEL_URL');
    this.client = new Stripe(secretKey, { typescript: true });
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    const session = await this.client.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: input.buyerEmail,
        client_reference_id: input.bookingId,
        metadata: { bookingId: input.bookingId },
        // Propagate bookingId onto the PaymentIntent so payment_intent.* webhooks
        // can resolve the booking too (session metadata is not copied automatically).
        payment_intent_data: { metadata: { bookingId: input.bookingId } },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency,
              unit_amount: input.amountMinor,
              product_data: { name: `ETicketsGo booking ${input.bookingId}` },
            },
          },
        ],
        success_url: this.successUrl,
        cancel_url: this.cancelUrl,
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
