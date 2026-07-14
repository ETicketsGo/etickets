import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
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

/** Shape of the Razorpay webhook JSON we consume (only the fields we read). */
interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        notes?: Record<string, string | number> | null;
      };
    };
    order?: {
      entity?: { id?: string; receipt?: string; notes?: Record<string, string | number> | null };
    };
  };
}

/**
 * Razorpay (India) provider. Charges happen client-side via Razorpay Checkout
 * using the Order we create here; settlement is confirmed only via the signed
 * `payment.captured` webhook (never trusted from the browser).
 *
 * Sandbox vs production is purely a matter of test vs live API keys — same code.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly webhookSignatureHeader = 'x-razorpay-signature';

  private readonly client: Razorpay;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    const keyId = requireKey(config, 'RAZORPAY_KEY_ID');
    const keySecret = requireKey(config, 'RAZORPAY_KEY_SECRET');
    this.webhookSecret = requireKey(config, 'RAZORPAY_WEBHOOK_SECRET');
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    // Razorpay amounts are in the currency subunit, same as our amountMinor.
    // `receipt` (bookingId) is our idempotent business key; `notes.bookingId`
    // travels through Checkout onto the payment entity so the webhook can
    // resolve the booking without an extra API round-trip.
    const order = await this.client.orders.create({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.bookingId,
      notes: { bookingId: input.bookingId, buyerEmail: input.buyerEmail },
    });

    return {
      // Frontend Razorpay Checkout opens with { key: RAZORPAY_KEY_ID, order_id }.
      providerRef: order.id,
      clientActionUrl: order.id,
      status: 'REQUIRES_PAYMENT',
    };
  }

  async verifyWebhook(input: WebhookInput): Promise<PaymentEvent> {
    // HMAC-SHA256 of the raw body with the webhook secret, timing-safe compared
    // to the x-razorpay-signature header value.
    const expected = createHmac('sha256', this.webhookSecret).update(input.rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid webhook signature.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const body = JSON.parse(input.rawBody) as RazorpayWebhookBody;
    const type = this.mapEventType(body.event);
    const entity = body.payload?.payment?.entity;
    const bookingId = this.resolveBookingId(body);
    const amountMinor = entity?.amount;

    if (!bookingId || typeof amountMinor !== 'number') {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Webhook payload is missing bookingId or amount.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      type,
      // The payment id is what refund() needs later, so surface it as providerRef.
      providerRef: entity?.id ?? body.payload?.order?.entity?.id ?? bookingId,
      bookingId,
      amountMinor,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await this.client.payments.refund(input.providerRef, {
      amount: input.amountMinor,
      notes: input.reason ? { reason: input.reason } : {},
    });
    return {
      providerRef: refund.id,
      status: refund.status === 'failed' ? 'FAILED' : 'COMPLETED',
    };
  }

  /**
   * Map Razorpay event names to our two settlement outcomes. Any other event
   * (e.g. `order.paid`, `refund.processed`) is intentionally rejected with a 4xx
   * so handleWebhook — which only understands succeeded/failed — never mis-routes.
   */
  private mapEventType(event: string | undefined): PaymentEvent['type'] {
    if (event === 'payment.captured') return 'payment.succeeded';
    if (event === 'payment.failed') return 'payment.failed';
    throw new AppException(
      ErrorCodes.PAYMENT_WEBHOOK_INVALID,
      `Unhandled Razorpay event: ${event ?? 'unknown'}.`,
      HttpStatus.BAD_REQUEST,
    );
  }

  private resolveBookingId(body: RazorpayWebhookBody): string | undefined {
    const fromPaymentNotes = body.payload?.payment?.entity?.notes?.bookingId;
    if (fromPaymentNotes != null) return String(fromPaymentNotes);
    const fromOrderNotes = body.payload?.order?.entity?.notes?.bookingId;
    if (fromOrderNotes != null) return String(fromOrderNotes);
    // Order receipt is set to the bookingId at creation time.
    const receipt = body.payload?.order?.entity?.receipt;
    return receipt != null ? String(receipt) : undefined;
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `PAYMENT_PROVIDER_NAME=razorpay requires ${key} to be set. ` +
        `Use Razorpay test keys for sandbox, live keys for production.`,
    );
  }
  return value;
}
