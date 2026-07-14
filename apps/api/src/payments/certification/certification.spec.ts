import { runCertificationSteps, summarize } from './certification-steps';
import type {
  PaymentEvent,
  PaymentProvider,
  WebhookInput,
} from '../provider/payment-provider.interface';

/** A full-capability fake provider with a working signer (dummy-like). */
function fullProvider(): PaymentProvider & { getPayment: jest.Mock } {
  const provider = {
    name: 'dummy',
    webhookSignatureHeader: 'x',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    capabilities: {} as any,
    healthCheck: jest.fn().mockResolvedValue({ healthy: true, mode: 'dummy' }),
    createPayment: jest
      .fn()
      .mockResolvedValue({ providerRef: 'pi_1', clientActionUrl: 'u', status: 'REQUIRES_PAYMENT' }),
    verifyWebhook: jest.fn((input: WebhookInput) =>
      Promise.resolve(JSON.parse(input.rawBody) as PaymentEvent),
    ),
    refund: jest.fn().mockResolvedValue({ providerRef: 'rf_1', status: 'COMPLETED' }),
    getPayment: jest.fn().mockResolvedValue({
      providerRef: 'pi_1',
      status: 'CAPTURED',
      amountMinor: 100,
      currency: 'USD',
    }),
  };
  return provider as unknown as PaymentProvider & { getPayment: jest.Mock };
}

const signer = (e: PaymentEvent): WebhookInput => ({
  rawBody: JSON.stringify(e),
  signature: 'sig',
});
const ctx = { amountMinor: 100, currency: 'USD', bookingId: 'cert_1', buyerEmail: 'c@e.test' };

describe('runCertificationSteps', () => {
  it('passes every step for a full-capability provider with a signer', async () => {
    const results = await runCertificationSteps(fullProvider(), { ...ctx, signer });
    expect(results).toHaveLength(10);
    const summary = summarize(results);
    expect(summary.result).toBe('PASS');
    expect(summary.failedCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
  });

  it('skips webhook + getPayment steps for a real provider without a signer', async () => {
    const provider = fullProvider();
    // A real provider has no getPayment and no signer available.
    const realish = { ...provider, getPayment: undefined } as unknown as PaymentProvider;
    const results = await runCertificationSteps(realish, ctx); // no signer
    const summary = summarize(results);
    expect(summary.result).toBe('PARTIAL'); // health/payment/refund pass; webhook steps skip
    const webhook = results.find((r) => r.key === 'verify-webhook');
    expect(webhook?.status).toBe('SKIP');
    const recon = results.find((r) => r.key === 'reconcile-payment');
    expect(recon?.status).toBe('SKIP');
  });

  it('fails the run when the provider health check fails', async () => {
    const provider = fullProvider();
    (provider.healthCheck as jest.Mock).mockResolvedValue({ healthy: false, message: 'down' });
    const results = await runCertificationSteps(provider, { ...ctx, signer });
    expect(summarize(results).result).toBe('FAIL');
    expect(results[0].status).toBe('FAIL');
  });

  it('fails when create payment throws (and downstream steps skip)', async () => {
    const provider = fullProvider();
    (provider.createPayment as jest.Mock).mockRejectedValue(new Error('sandbox down'));
    const results = await runCertificationSteps(provider, { ...ctx, signer });
    const summary = summarize(results);
    expect(summary.result).toBe('FAIL');
    expect(results.find((r) => r.key === 'partial-refund')?.status).toBe('SKIP');
  });

  it('records a partial refund at half the amount', async () => {
    const provider = fullProvider();
    const results = await runCertificationSteps(provider, { ...ctx, signer });
    expect(provider.refund).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: 'pi_1', amountMinor: 50, currency: 'USD' }),
    );
    expect(results.find((r) => r.key === 'settlement-projection')?.status).toBe('PASS');
  });
});
