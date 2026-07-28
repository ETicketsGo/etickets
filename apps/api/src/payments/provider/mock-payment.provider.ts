import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCodes } from '../../common/errors';
import type {
  CancelInput,
  CreatePaymentInput,
  HealthCheckResult,
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  PaymentStatusResult,
  RefundInput,
  RefundResult,
  WebhookInput,
} from './payment-provider.interface';
import { PaymentMethod, type PaymentProviderCapabilities } from '../domain/payment-capabilities';

/**
 * Local mock provider. Simulates a real gateway: payments complete out-of-band
 * via a signed webhook (never trusted from a browser redirect). The signing
 * secret stands in for the provider's webhook secret.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly webhookSignatureHeader = 'x-payment-signature';
  /** The dummy provider simulates everything, everywhere (local/dev/QA only). */
  readonly capabilities: PaymentProviderCapabilities = {
    countries: ['*'],
    currencies: ['*'],
    paymentMethods: [
      PaymentMethod.CARD,
      PaymentMethod.UPI,
      PaymentMethod.NETBANKING,
      PaymentMethod.WALLET,
      PaymentMethod.APPLE_PAY,
      PaymentMethod.GOOGLE_PAY,
    ],
    supportsPartialRefunds: true,
    supportsMultiplePartialRefunds: true,
    supportsAuthorizeCapture: true,
    supportsVoid: true,
    supportsIdempotentVoid: true,
    supportsPaymentStatusQuery: true,
    supportsConnectedAccounts: false,
    supportsApplePay: true,
    supportsGooglePay: true,
    supportsUPI: true,
    supportsNetBanking: true,
    supportsWallets: true,
  };
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, mode: 'dummy', message: 'dummy provider — no external calls' };
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    const providerRef = `mock_pi_${randomBytes(10).toString('hex')}`;
    return {
      providerRef,
      clientActionUrl: `/api/payments/${input.bookingId}/mock-pay`,
      status: 'REQUIRES_PAYMENT',
    };
  }

  /** Produces a signed webhook payload, as a real provider's server would. */
  signEvent(event: PaymentEvent): WebhookInput {
    const rawBody = JSON.stringify(event);
    const signature = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  async verifyWebhook(input: WebhookInput): Promise<PaymentEvent> {
    const expected = createHmac('sha256', this.secret).update(input.rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid webhook signature.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return JSON.parse(input.rawBody) as PaymentEvent;
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    return { providerRef: `mock_rf_${randomBytes(8).toString('hex')}`, status: 'COMPLETED' };
  }

  /**
   * Void (cancel) an authorization — DEV/TEST ONLY (ADR-043 P5.3B Phase 5). Deterministic
   * scenarios encoded in the providerRef via a `#scenario` suffix so tests never rely on
   * randomness: `#captured` → CAPTURED (not voidable), `#ambiguous`/`#voidfail` → throws (the
   * executor recovers via getPayment), otherwise CANCELLED (voided). Idempotent: cancelling an
   * already-cancelled authorization returns CANCELLED again.
   */
  async cancel(input: CancelInput): Promise<PaymentStatusResult> {
    const scenario = this.scenario(input.providerRef);
    if (scenario === 'captured') {
      return {
        providerRef: input.providerRef,
        status: 'CAPTURED',
        amountMinor: 0,
        currency: 'USD',
      };
    }
    if (scenario === 'ambiguous' || scenario === 'voidfail') {
      throw new AppException(
        ErrorCodes.INTERNAL,
        'mock void ambiguous',
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    return { providerRef: input.providerRef, status: 'CANCELLED', amountMinor: 0, currency: 'USD' };
  }

  /** Payment status query (dev/test). Recovers ambiguous voids as CANCELLED; `#retry` stays AUTHORIZED. */
  async getPayment(providerRef: string): Promise<PaymentStatusResult> {
    const scenario = this.scenario(providerRef);
    const status =
      scenario === 'captured' ? 'CAPTURED' : scenario === 'retry' ? 'AUTHORIZED' : 'CANCELLED'; // default + ambiguous → recovered as voided
    return { providerRef, status, amountMinor: 0, currency: 'USD' };
  }

  private scenario(ref: string): string {
    const i = ref.indexOf('#');
    return i >= 0 ? ref.slice(i + 1) : '';
  }
}
