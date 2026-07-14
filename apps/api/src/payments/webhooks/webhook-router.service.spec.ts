import { WebhookRouter } from './webhook-router.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import { PaymentsService } from '../payments.service';
import { MetricsService } from '../../metrics/metrics.service';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/errors';
import type { PaymentProvider } from '../provider/payment-provider.interface';

function makeRouter(adapter?: Partial<PaymentProvider>) {
  const registry = {
    get: jest.fn().mockReturnValue(adapter),
  } as unknown as PaymentProviderRegistry;
  const payments = {
    processVerifiedEvent: jest.fn().mockResolvedValue({ status: 'confirmed', bookingId: 'b1' }),
  } as unknown as PaymentsService;
  const metrics = { recordPaymentWebhook: jest.fn() } as unknown as MetricsService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return {
    router: new WebhookRouter(registry, payments, metrics, audit),
    payments,
    metrics,
    audit,
  };
}

const event = { type: 'payment.succeeded', providerRef: 'pi', bookingId: 'b1', amountMinor: 1000 };

describe('WebhookRouter', () => {
  it('verifies with the named adapter and processes the event', async () => {
    const adapter = {
      name: 'stripe',
      webhookSignatureHeader: 'stripe-signature',
      verifyWebhook: jest.fn().mockResolvedValue(event),
    };
    const { router, payments, metrics } = makeRouter(adapter);
    const res = await router.route('stripe', '{}', { 'stripe-signature': 'sig123' });
    expect(adapter.verifyWebhook).toHaveBeenCalledWith({ rawBody: '{}', signature: 'sig123' });
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(event);
    expect(metrics.recordPaymentWebhook).toHaveBeenCalledWith('stripe', 'verified');
    expect(res).toEqual({ status: 'confirmed', bookingId: 'b1' });
  });

  it('assembles the PayPal transmission header bundle as the signature', async () => {
    const adapter = {
      name: 'paypal',
      webhookSignatureHeader: 'paypal-transmission-sig',
      verifyWebhook: jest.fn().mockResolvedValue(event),
    };
    const { router } = makeRouter(adapter);
    await router.route('paypal', '{}', {
      'paypal-transmission-id': 'tid',
      'paypal-transmission-sig': 'psig',
      'paypal-cert-url': 'https://cert',
    });
    const arg = (adapter.verifyWebhook as jest.Mock).mock.calls[0][0];
    const bundle = JSON.parse(arg.signature);
    expect(bundle.transmissionId).toBe('tid');
    expect(bundle.transmissionSig).toBe('psig');
    expect(bundle.certUrl).toBe('https://cert');
  });

  it('rejects an unknown provider', async () => {
    const { router } = makeRouter(undefined);
    await expect(router.route('nope', '{}', {})).rejects.toBeInstanceOf(AppException);
  });

  it('records a rejected webhook when verification fails', async () => {
    const adapter = {
      name: 'stripe',
      webhookSignatureHeader: 'stripe-signature',
      verifyWebhook: jest.fn().mockRejectedValue(new Error('bad sig')),
    };
    const { router, metrics } = makeRouter(adapter);
    await expect(router.route('stripe', '{}', {})).rejects.toBeTruthy();
    expect(metrics.recordPaymentWebhook).toHaveBeenCalledWith('stripe', 'rejected');
  });
});
