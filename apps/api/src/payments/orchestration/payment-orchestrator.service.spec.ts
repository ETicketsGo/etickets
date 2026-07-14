import { PaymentOrchestrator } from './payment-orchestrator.service';
import { PaymentConfigService } from '../configuration/payment-config.service';
import { PaymentProviderRegistry } from './provider-registry';
import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';
import type { PaymentProvider } from '../provider/payment-provider.interface';

const OPS = {
  timeoutMs: 0,
  maxRetries: 1,
  retryBackoffMs: 1,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 1000,
};

function provider(name: string, over: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    name,
    webhookSignatureHeader: 'x',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    capabilities: {} as any,
    createPayment: jest.fn().mockResolvedValue({
      providerRef: `${name}_pi`,
      clientActionUrl: 'u',
      status: 'REQUIRES_PAYMENT',
    }),
    verifyWebhook: jest.fn(),
    refund: jest.fn().mockResolvedValue({ providerRef: `${name}_rf`, status: 'COMPLETED' }),
    ...over,
  } as PaymentProvider;
}

function target(name: string) {
  return { provider: name, mode: 'LIVE', ops: OPS };
}

function make(opts: {
  env?: string;
  resolve?: () => unknown;
  registry?: Record<string, PaymentProvider>;
  fallback?: PaymentProvider;
}) {
  const config = {
    environment: opts.env ?? 'LOCAL',
    resolveTarget: jest.fn(opts.resolve ?? (() => Promise.reject(new Error('no route')))),
  } as unknown as PaymentConfigService;
  const map = opts.registry ?? {};
  const registry = {
    get: (n: string) => map[n.toLowerCase()],
    has: (n: string) => Boolean(map[n.toLowerCase()]),
  } as unknown as PaymentProviderRegistry;
  const fallback = opts.fallback ?? provider('mock');
  return { orch: new PaymentOrchestrator(config, registry, fallback), config, fallback };
}

const input = {
  bookingId: 'b1',
  amountMinor: 1000,
  currency: 'INR',
  buyerEmail: 'x@y.z',
  idempotencyKey: 'b1',
};

describe('PaymentOrchestrator.createPayment', () => {
  it('routes to the resolved primary provider', async () => {
    const stripe = provider('stripe');
    const { orch } = make({
      resolve: () => Promise.resolve({ primary: target('stripe') }),
      registry: { stripe },
    });
    const res = await orch.createPayment({ currency: 'USD' }, input);
    expect(res.provider).toBe('stripe');
    expect(stripe.createPayment).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default provider when config is unresolved (non-fail-closed)', async () => {
    const { orch, fallback } = make({ env: 'LOCAL' }); // resolveTarget rejects
    const res = await orch.createPayment({ currency: 'INR' }, input);
    expect(res.provider).toBe('mock');
    expect(fallback.createPayment).toHaveBeenCalledTimes(1);
  });

  it('fails over to the failover provider on a retryable primary error', async () => {
    const razor = provider('razorpay', {
      createPayment: jest
        .fn()
        .mockRejectedValue(
          new PaymentProviderError(PaymentErrorCode.PROVIDER_UNAVAILABLE, 'down', 'razorpay'),
        ),
    });
    const stripe = provider('stripe');
    const { orch } = make({
      resolve: () => Promise.resolve({ primary: target('razorpay'), failover: target('stripe') }),
      registry: { razorpay: razor, stripe },
    });
    const res = await orch.createPayment({ currency: 'INR' }, input);
    expect(res.provider).toBe('stripe');
  });

  it('fails closed (throws) in production when nothing routable is constructed', async () => {
    const { orch } = make({
      env: 'PRODUCTION',
      resolve: () => Promise.resolve({ primary: target('stripe') }), // stripe not in registry
      registry: {},
    });
    await expect(orch.createPayment({ currency: 'USD' }, input)).rejects.toBeTruthy();
  });

  it('rethrows fail-closed resolution errors in production', async () => {
    const { orch } = make({ env: 'PRODUCTION' }); // resolveTarget rejects
    await expect(orch.createPayment({ currency: 'USD' }, input)).rejects.toBeTruthy();
  });
});

describe('PaymentOrchestrator.refund', () => {
  it('refunds on the named owning provider', async () => {
    const stripe = provider('stripe');
    const { orch } = make({ registry: { stripe } });
    const res = await orch.refund({ providerRef: 'pi', amountMinor: 500 }, { provider: 'stripe' });
    expect(res.status).toBe('COMPLETED');
    expect(stripe.refund).toHaveBeenCalledTimes(1);
  });

  it('refunds on the default provider when no owner is given', async () => {
    const { orch, fallback } = make({});
    await orch.refund({ providerRef: 'pi', amountMinor: 500 });
    expect(fallback.refund).toHaveBeenCalledTimes(1);
  });
});
