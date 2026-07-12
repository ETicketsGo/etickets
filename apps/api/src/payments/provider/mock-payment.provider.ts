import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
 * Local mock provider. Simulates a real gateway: payments complete out-of-band
 * via a signed webhook (never trusted from a browser redirect). The signing
 * secret stands in for the provider's webhook secret.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET');
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
}
