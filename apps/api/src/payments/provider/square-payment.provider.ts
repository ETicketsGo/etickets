import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';
import { PaymentMethod, type PaymentProviderCapabilities } from '../domain/payment-capabilities';
import { requestJson } from './rest-client';
import type {
  CreatePaymentInput,
  HealthCheckResult,
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookInput,
} from './payment-provider.interface';

/**
 * Square (US/CA/UK/AU/JP) provider via the Square Connect REST API — no SDK
 * dependency, using the platform `fetch`. Buyers pay on a Square-hosted Payment
 * Link; settlement is confirmed only via an HMAC-verified webhook.
 *
 * Square amounts are already integer minor units, matching our amountMinor. Sandbox
 * vs production is the access token + configurable base URL (SQUARE_API_BASE_URL),
 * never hardcoded.
 */
export class SquarePaymentProvider implements PaymentProvider {
  readonly name = 'square';
  readonly webhookSignatureHeader = 'x-square-hmacsha256-signature';
  readonly capabilities: PaymentProviderCapabilities = {
    countries: ['US', 'CA', 'GB', 'AU', 'JP', 'IE'],
    currencies: ['USD', 'CAD', 'GBP', 'AUD', 'JPY', 'EUR'],
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
    supportsConnectedAccounts: false,
    supportsApplePay: true,
    supportsGooglePay: true,
    supportsUPI: false,
    supportsNetBanking: false,
    supportsWallets: true,
  };

  private readonly accessToken: string;
  private readonly locationId: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly webhookSignatureKey: string;
  private readonly webhookUrl: string;
  private readonly testMode: boolean;

  constructor(config: ConfigService) {
    this.accessToken = requireKey(config, 'SQUARE_ACCESS_TOKEN');
    this.locationId = requireKey(config, 'SQUARE_LOCATION_ID');
    this.baseUrl = (
      config.get<string>('SQUARE_API_BASE_URL') ?? 'https://connect.squareupsandbox.com'
    ).replace(/\/$/, '');
    this.apiVersion = config.get<string>('SQUARE_API_VERSION') ?? '2024-01-18';
    this.webhookSignatureKey = config.get<string>('SQUARE_WEBHOOK_SIGNATURE_KEY') ?? '';
    this.webhookUrl = config.get<string>('SQUARE_WEBHOOK_URL') ?? '';
    this.testMode = /sandbox/i.test(this.baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': this.apiVersion,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const mode = this.testMode ? 'test' : 'live';
    try {
      await requestJson(this.name, `${this.baseUrl}/v2/locations`, { headers: this.headers() });
      return { healthy: true, mode };
    } catch (err) {
      return { healthy: false, mode, message: err instanceof Error ? err.message : 'unhealthy' };
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    const { data } = await requestJson<{
      payment_link?: { id: string; url?: string; order_id?: string };
    }>(this.name, `${this.baseUrl}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        // Idempotency: a retry with the same key never creates a second link.
        idempotency_key: input.idempotencyKey,
        order: {
          location_id: this.locationId,
          // reference_id carries the bookingId through to the payment/webhook.
          reference_id: input.bookingId,
          line_items: [
            {
              name: `ETicketsGo booking ${input.bookingId}`,
              quantity: '1',
              base_price_money: {
                amount: input.amountMinor,
                currency: input.currency.toUpperCase(),
              },
            },
          ],
        },
      }),
    });

    const link = data.payment_link;
    if (!link?.url) {
      throw new PaymentProviderError(
        PaymentErrorCode.UNKNOWN,
        'Square did not return a payment link URL.',
        this.name,
      );
    }
    return {
      providerRef: link.order_id ?? link.id,
      clientActionUrl: link.url,
      status: 'REQUIRES_PAYMENT',
    };
  }

  async verifyWebhook(input: WebhookInput): Promise<PaymentEvent> {
    // Square signs base64(HMAC-SHA256(notificationUrl + body, signatureKey)).
    const expected = createHmac('sha256', this.webhookSignatureKey)
      .update(this.webhookUrl + input.rawBody)
      .digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError(
        PaymentErrorCode.WEBHOOK_INVALID,
        'Invalid Square webhook signature.',
        this.name,
      );
    }
    return this.parseWebhook(input.rawBody);
  }

  /** Parse a (verified) Square webhook body into a normalized event. */
  parseWebhook(rawBody: string): PaymentEvent {
    const body = JSON.parse(rawBody) as {
      type?: string;
      data?: {
        object?: {
          payment?: {
            id?: string;
            status?: string;
            reference_id?: string;
            note?: string;
            amount_money?: { amount?: number; currency?: string };
          };
        };
      };
    };
    const payment = body.data?.object?.payment ?? {};
    const bookingId = payment.reference_id ?? payment.note ?? undefined;
    const amountMinor = payment.amount_money?.amount;
    if (!bookingId || typeof amountMinor !== 'number') {
      throw new PaymentProviderError(
        PaymentErrorCode.WEBHOOK_INVALID,
        'Square webhook is missing reference_id or amount.',
        this.name,
      );
    }
    // A payment is settled only when COMPLETED/APPROVED; anything else is a failure.
    const succeeded = payment.status === 'COMPLETED' || payment.status === 'APPROVED';
    return {
      type: succeeded ? 'payment.succeeded' : 'payment.failed',
      providerRef: payment.id ?? bookingId,
      bookingId,
      amountMinor,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.currency) {
      throw new PaymentProviderError(
        PaymentErrorCode.INVALID_REQUEST,
        'Square refunds require the payment currency.',
        this.name,
      );
    }
    const { data } = await requestJson<{ refund?: { id: string; status?: string } }>(
      this.name,
      `${this.baseUrl}/v2/refunds`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          idempotency_key: `rf_${input.providerRef}_${input.amountMinor}`,
          payment_id: input.providerRef,
          amount_money: { amount: input.amountMinor, currency: input.currency.toUpperCase() },
          reason: input.reason,
        }),
      },
    );
    const status = data.refund?.status;
    const failed = status === 'FAILED' || status === 'REJECTED';
    return { providerRef: data.refund?.id ?? '', status: failed ? 'FAILED' : 'COMPLETED' };
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `PAYMENT_PROVIDER_NAME=square requires ${key} to be set. ` +
        `Use Square sandbox credentials for test, production credentials for live.`,
    );
  }
  return value;
}
