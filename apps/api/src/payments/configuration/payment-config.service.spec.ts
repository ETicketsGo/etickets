import { ConfigService } from '@nestjs/config';
import { PaymentConfigService } from './payment-config.service';
import { AppException } from '../../common/errors';

/** Minimal in-memory Prisma stub for the tables the service reads. */
function makePrisma(data: {
  configs: Record<string, unknown>[];
  routes: Record<string, unknown>[];
}) {
  return {
    paymentProviderConfig: {
      findMany: jest.fn().mockResolvedValue(data.configs),
      findUnique: jest.fn(({ where }: { where: { env_provider: { provider: string } } }) => {
        const found = data.configs.find((c) => c.provider === where.env_provider.provider) ?? null;
        return Promise.resolve(found);
      }),
    },
    paymentRoute: {
      findMany: jest.fn().mockResolvedValue(data.routes),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>, appEnv = 'PRODUCTION') {
  const config = { get: jest.fn().mockReturnValue(appEnv) } as unknown as ConfigService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PaymentConfigService(prisma as any, config);
}

const stripeConfig = {
  provider: 'stripe',
  enabled: true,
  mode: 'LIVE',
  publicKey: 'pk_live_x',
  secretKeyRef: 'ref/secret',
  webhookSecretRef: 'ref/webhook',
  apiBaseUrl: null,
  timeoutMs: 15000,
  maxRetries: 2,
  retryBackoffMs: 500,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 30000,
  merchantAccounts: [
    { label: 'US', country: 'US', currency: 'USD', merchantIdRef: 'm1', active: true },
  ],
};

describe('PaymentConfigService.resolveTarget', () => {
  it('resolves the routed provider, mode, refs and merchant', async () => {
    const prisma = makePrisma({
      configs: [stripeConfig],
      routes: [
        {
          country: '*',
          currency: '*',
          method: '*',
          provider: 'stripe',
          failoverProvider: null,
          priority: 100,
          active: true,
        },
      ],
    });
    const svc = makeService(prisma);
    const target = await svc.resolveTarget({ country: 'US', currency: 'USD' });

    expect(target.primary.provider).toBe('stripe');
    expect(target.primary.mode).toBe('LIVE');
    expect(target.primary.secretKeyRef).toBe('ref/secret');
    expect(target.primary.merchant?.label).toBe('US');
    expect(target.primary.ops.timeoutMs).toBe(15000);
    expect(target.failover).toBeUndefined();
  });

  it('resolves a failover provider when the route names one', async () => {
    const razor = { ...stripeConfig, provider: 'razorpay', merchantAccounts: [] };
    const prisma = makePrisma({
      configs: [{ ...razor }, { ...stripeConfig }],
      routes: [
        {
          country: 'IN',
          currency: 'INR',
          method: '*',
          provider: 'razorpay',
          failoverProvider: 'stripe',
          priority: 10,
          active: true,
        },
      ],
    });
    const svc = makeService(prisma);
    const target = await svc.resolveTarget({ country: 'IN', currency: 'INR' });
    expect(target.primary.provider).toBe('razorpay');
    expect(target.failover?.provider).toBe('stripe');
  });

  it('fails closed when no route matches', async () => {
    const prisma = makePrisma({ configs: [stripeConfig], routes: [] });
    const svc = makeService(prisma);
    await expect(svc.resolveTarget({ country: 'US', currency: 'USD' })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('fails closed when the routed provider is disabled', async () => {
    const prisma = makePrisma({
      configs: [{ ...stripeConfig, enabled: false }],
      routes: [
        {
          country: '*',
          currency: '*',
          method: '*',
          provider: 'stripe',
          failoverProvider: null,
          priority: 100,
          active: true,
        },
      ],
    });
    const svc = makeService(prisma);
    await expect(svc.resolveTarget({ currency: 'USD' })).rejects.toBeInstanceOf(AppException);
  });
});
