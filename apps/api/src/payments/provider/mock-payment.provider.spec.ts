import { ConfigService } from '@nestjs/config';
import { MockPaymentProvider } from './mock-payment.provider';
import type { PaymentEvent } from './payment-provider.interface';

function makeProvider() {
  const config = { getOrThrow: () => 'test-webhook-secret' } as unknown as ConfigService;
  return new MockPaymentProvider(config);
}

const event: PaymentEvent = {
  type: 'payment.succeeded',
  providerRef: 'mock_pi_abc',
  bookingId: 'bk_123',
  amountMinor: 104_040,
};

describe('MockPaymentProvider', () => {
  it('accepts a correctly signed webhook and returns the event', async () => {
    const provider = makeProvider();
    const signed = provider.signEvent(event);
    const parsed = await provider.verifyWebhook(signed);
    expect(parsed).toEqual(event);
  });

  it('rejects a tampered payload', async () => {
    const provider = makeProvider();
    const signed = provider.signEvent(event);
    const tampered = { ...signed, rawBody: signed.rawBody.replace('104040', '1') };
    await expect(provider.verifyWebhook(tampered)).rejects.toMatchObject({
      code: 'PAYMENT_WEBHOOK_INVALID',
    });
  });

  it('rejects a bad signature', async () => {
    const provider = makeProvider();
    const signed = provider.signEvent(event);
    await expect(
      provider.verifyWebhook({ ...signed, signature: 'deadbeef' }),
    ).rejects.toBeDefined();
  });
});
