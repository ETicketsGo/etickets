import { ConfigService } from '@nestjs/config';
import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';
import { PaymentMethod, type PaymentProviderCapabilities } from '../domain/payment-capabilities';
import { currencyExponent, minorToDecimalString, requestJson } from './rest-client';
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
 * PayPal (global) provider via the Orders v2 REST API — no SDK dependency, using
 * the platform `fetch`. Buyers approve on a PayPal-hosted page (we return its
 * approve link); settlement is confirmed only via a signature-verified webhook.
 *
 * Sandbox vs production is the API base URL + client credentials; the base URL is
 * configurable (PAYPAL_API_BASE_URL), never hardcoded. Webhook verification uses
 * PayPal's server-side verify-webhook-signature call; the header bundle is passed
 * as the JSON-encoded `signature` (populated by the webhook router in M6).
 */
export class PayPalPaymentProvider implements PaymentProvider {
  readonly name = 'paypal';
  readonly webhookSignatureHeader = 'paypal-transmission-sig';
  readonly capabilities: PaymentProviderCapabilities = {
    countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'IT', 'ES', 'NL', 'SG'],
    currencies: ['USD', 'CAD', 'GBP', 'AUD', 'EUR', 'SGD'],
    paymentMethods: [PaymentMethod.PAYPAL, PaymentMethod.CARD],
    supportsPartialRefunds: true,
    supportsMultiplePartialRefunds: true,
    supportsAuthorizeCapture: true,
    supportsVoid: false,
    supportsIdempotentVoid: false,
    supportsPaymentStatusQuery: false,
    supportsConnectedAccounts: false,
    supportsApplePay: false,
    supportsGooglePay: false,
    supportsUPI: false,
    supportsNetBanking: false,
    supportsWallets: true,
  };

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookId: string;
  private readonly baseUrl: string;
  private readonly returnUrl: string;
  private readonly cancelUrl: string;
  private readonly testMode: boolean;

  constructor(config: ConfigService) {
    this.clientId = requireKey(config, 'PAYPAL_CLIENT_ID');
    this.clientSecret = requireKey(config, 'PAYPAL_CLIENT_SECRET');
    this.webhookId = config.get<string>('PAYPAL_WEBHOOK_ID') ?? '';
    // Endpoint is configurable; default to sandbox so a missing value never points
    // at live by accident.
    this.baseUrl = (
      config.get<string>('PAYPAL_API_BASE_URL') ?? 'https://api-m.sandbox.paypal.com'
    ).replace(/\/$/, '');
    this.returnUrl =
      config.get<string>('PAYPAL_RETURN_URL') ?? 'http://localhost:3000/checkout/success';
    this.cancelUrl =
      config.get<string>('PAYPAL_CANCEL_URL') ?? 'http://localhost:3000/checkout/cancel';
    this.testMode = /sandbox/i.test(this.baseUrl);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const mode = this.testMode ? 'test' : 'live';
    try {
      await this.accessToken();
      return { healthy: true, mode };
    } catch (err) {
      return { healthy: false, mode, message: err instanceof Error ? err.message : 'unhealthy' };
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    const token = await this.accessToken();
    const { data } = await requestJson<{
      id: string;
      links?: { rel: string; href: string }[];
    }>(this.name, `${this.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Idempotency: a retry with the same key never creates a second order.
        'PayPal-Request-Id': input.idempotencyKey,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: input.bookingId,
            amount: {
              currency_code: input.currency.toUpperCase(),
              value: minorToDecimalString(input.amountMinor, input.currency),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              return_url: this.returnUrl,
              cancel_url: this.cancelUrl,
            },
          },
        },
      }),
    });

    const approve = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!approve) {
      throw new PaymentProviderError(
        PaymentErrorCode.UNKNOWN,
        'PayPal did not return an approval link.',
        this.name,
      );
    }
    return { providerRef: data.id, clientActionUrl: approve.href, status: 'REQUIRES_PAYMENT' };
  }

  async verifyWebhook(input: WebhookInput): Promise<PaymentEvent> {
    const headers = this.parseHeaderBundle(input.signature);
    const token = await this.accessToken();
    const { data } = await requestJson<{ verification_status?: string }>(
      this.name,
      `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transmission_id: headers.transmissionId,
          transmission_time: headers.transmissionTime,
          cert_url: headers.certUrl,
          auth_algo: headers.authAlgo,
          transmission_sig: headers.transmissionSig,
          webhook_id: this.webhookId,
          webhook_event: JSON.parse(input.rawBody),
        }),
      },
    );
    if (data.verification_status !== 'SUCCESS') {
      throw new PaymentProviderError(
        PaymentErrorCode.WEBHOOK_INVALID,
        'PayPal webhook signature verification failed.',
        this.name,
      );
    }
    return this.parseWebhook(input.rawBody);
  }

  /** Parse a (already verified) PayPal webhook body into a normalized event. */
  parseWebhook(rawBody: string): PaymentEvent {
    const body = JSON.parse(rawBody) as {
      event_type?: string;
      resource?: {
        id?: string;
        custom_id?: string;
        amount?: { value?: string; currency_code?: string };
        supplementary_data?: { related_ids?: { order_id?: string } };
        purchase_units?: { custom_id?: string; amount?: { value?: string } }[];
      };
    };
    const type: PaymentEvent['type'] =
      body.event_type === 'PAYMENT.CAPTURE.COMPLETED' ||
      body.event_type === 'CHECKOUT.ORDER.APPROVED'
        ? 'payment.succeeded'
        : 'payment.failed';
    const resource = body.resource ?? {};
    const bookingId = resource.custom_id ?? resource.purchase_units?.[0]?.custom_id ?? undefined;
    const value = resource.amount?.value ?? resource.purchase_units?.[0]?.amount?.value;
    const currency = resource.amount?.currency_code ?? 'USD';
    if (!bookingId || value === undefined) {
      throw new PaymentProviderError(
        PaymentErrorCode.WEBHOOK_INVALID,
        'PayPal webhook is missing custom_id or amount.',
        this.name,
      );
    }
    return {
      type,
      providerRef: resource.id ?? bookingId,
      bookingId,
      amountMinor: decimalToMinor(value, currency),
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const token = await this.accessToken();
    // A partial refund needs an amount (and currency); without a currency we issue
    // a full refund of the capture.
    const body =
      input.currency !== undefined
        ? JSON.stringify({
            amount: {
              value: minorToDecimalString(input.amountMinor, input.currency),
              currency_code: input.currency.toUpperCase(),
            },
          })
        : undefined;
    const { data } = await requestJson<{ id: string; status?: string }>(
      this.name,
      `${this.baseUrl}/v2/payments/captures/${input.providerRef}/refund`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      },
    );
    return { providerRef: data.id, status: data.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED' };
  }

  /** Fetch an OAuth2 client-credentials access token. */
  private async accessToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const { data } = await requestJson<{ access_token?: string }>(
      this.name,
      `${this.baseUrl}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
    );
    if (!data.access_token) {
      throw new PaymentProviderError(
        PaymentErrorCode.AUTHENTICATION_FAILED,
        'PayPal did not return an access token.',
        this.name,
      );
    }
    return data.access_token;
  }

  private parseHeaderBundle(signature: string): {
    transmissionId?: string;
    transmissionTime?: string;
    certUrl?: string;
    authAlgo?: string;
    transmissionSig?: string;
  } {
    try {
      return JSON.parse(signature || '{}');
    } catch {
      throw new PaymentProviderError(
        PaymentErrorCode.WEBHOOK_INVALID,
        'PayPal webhook headers were not provided.',
        this.name,
      );
    }
  }
}

/** Convert a provider decimal string ("10.50") to integer minor units, exactly. */
function decimalToMinor(value: string, currency: string): number {
  const e = currencyExponent(currency);
  const [whole, frac = ''] = value.split('.');
  const fracPadded = (frac + '0'.repeat(e)).slice(0, e);
  return parseInt(whole, 10) * 10 ** e + (e > 0 ? parseInt(fracPadded || '0', 10) : 0);
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `PAYMENT_PROVIDER_NAME=paypal requires ${key} to be set. ` +
        `Use PayPal sandbox credentials for test, live credentials for production.`,
    );
  }
  return value;
}
