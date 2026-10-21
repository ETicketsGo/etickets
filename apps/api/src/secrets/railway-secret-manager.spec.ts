import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RAILWAY_SECRET_MAP, RailwaySecretManager } from './railway-secret-manager';
import { selectSecretManager } from './secret-manager.factory';
import { PaymentProviderFactory } from '../payments/provider/factory/payment-provider.factory';
import { PaymentProviderRegistry } from '../payments/orchestration/provider-registry';
import { MockPaymentProvider } from '../payments/provider/mock-payment.provider';
import { RazorpayPaymentProvider } from '../payments/provider/razorpay-payment.provider';
import { PaymentLiveReadinessService } from '../payments/readiness/payment-live-readiness.service';
import { PromotionService } from '../payments/promotion/promotion.service';
import { AppException } from '../common/errors';

/**
 * SECRET_MANAGER_PROVIDER=railway: the payment secret store over the Railway variables the
 * money path already uses, through a fixed list of approved names.
 *
 * Production keeps one copy of each payment credential (the Railway variable). Checkout,
 * webhooks, refunds and reconciliation build the Razorpay adapter from those variables through
 * PaymentProviderResolver; the factory, readiness, launch gate and promotion now read the SAME
 * variables instead of an AWS vault that was never populated.
 */

const RAZORPAY_ENV = {
  RAZORPAY_KEY_ID: 'rzp_live_AbCdEfGhIjKlMn',
  RAZORPAY_KEY_SECRET: 'live-secret-value-123456',
  RAZORPAY_WEBHOOK_SECRET: 'webhook-secret-value-7890',
};

const razorpayRow = {
  env: 'PRODUCTION',
  provider: 'razorpay',
  enabled: true,
  mode: 'LIVE',
  publicKey: RAZORPAY_ENV.RAZORPAY_KEY_ID,
  secretKeyRef: 'payments/razorpay/live/secret-key',
  webhookSecretRef: 'payments/razorpay/live/webhook-secret',
  apiBaseUrl: null,
  updatedAt: new Date('2026-10-17T00:00:00Z'),
};

const configFrom = (values: Record<string, unknown>) =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

describe('RailwaySecretManager', () => {
  it('maps exactly the two approved Razorpay names to their existing variables', async () => {
    expect(RAILWAY_SECRET_MAP).toEqual({
      'payments/razorpay/live/secret-key': 'RAZORPAY_KEY_SECRET',
      'payments/razorpay/live/webhook-secret': 'RAZORPAY_WEBHOOK_SECRET',
    });
    const sm = new RailwaySecretManager({ ...RAZORPAY_ENV });
    await expect(sm.getSecret('payments/razorpay/live/secret-key')).resolves.toBe(
      RAZORPAY_ENV.RAZORPAY_KEY_SECRET,
    );
    await expect(sm.getSecret('payments/razorpay/live/webhook-secret')).resolves.toBe(
      RAZORPAY_ENV.RAZORPAY_WEBHOOK_SECRET,
    );
  });

  it.each([
    // What the generic env backend would have turned into JWT_ACCESS_SECRET etc.
    'jwt/access-secret',
    'qr/signing-secret',
    'payments/razorpay/test/secret-key',
    'payments/razorpay/production/secret-key',
    'payments/stripe/live/secret-key',
    'inventory-sync/qube/webhook-secret',
    'razorpay-key-secret',
    'RAZORPAY_KEY_SECRET',
    'toString',
    '__proto__',
    'constructor',
    '',
  ])('refuses %p, reading no variable', async (reference) => {
    const env = { ...RAZORPAY_ENV, JWT_ACCESS_SECRET: 'jwt', QR_SIGNING_SECRET: 'qr' };
    const reads: string[] = [];
    const watched = new Proxy(env, {
      get: (target, key) => {
        reads.push(String(key));
        return target[key as keyof typeof target];
      },
    });
    const sm = new RailwaySecretManager(watched);
    expect(sm.validateReference(reference)).toBe(false);
    await expect(sm.getSecret(reference)).rejects.toThrow(/not an approved secret name/);
    expect(reads).toEqual([]);
  });

  it('fails closed when the variable is unset or blank, naming the variable and not a value', async () => {
    const sm = new RailwaySecretManager({ RAZORPAY_KEY_SECRET: '  ' });
    await expect(sm.getSecret('payments/razorpay/live/secret-key')).rejects.toThrow(
      /RAZORPAY_KEY_SECRET is not set/,
    );
    await expect(sm.getSecret('payments/razorpay/live/webhook-secret')).rejects.toThrow(
      /RAZORPAY_WEBHOOK_SECRET is not set/,
    );
  });

  it('never puts a secret value in an error', async () => {
    const sm = new RailwaySecretManager({ ...RAZORPAY_ENV });
    const err = await sm.getSecret('jwt/access-secret').catch((e: Error) => e);
    for (const value of Object.values(RAZORPAY_ENV)) {
      expect(String((err as Error).message)).not.toContain(value);
    }
  });

  it('is healthy only when every approved variable is set, and names what is missing', async () => {
    await expect(new RailwaySecretManager({ ...RAZORPAY_ENV }).healthCheck()).resolves.toEqual({
      healthy: true,
      provider: 'railway',
      message: 'railway variables',
    });
    const partial = await new RailwaySecretManager({
      RAZORPAY_KEY_SECRET: 'x',
    }).healthCheck();
    expect(partial).toEqual({
      healthy: false,
      provider: 'railway',
      message: 'missing RAZORPAY_WEBHOOK_SECRET',
    });
  });
});

describe('selectSecretManager and railway', () => {
  it.each(['PRODUCTION', 'STAGING', 'QA'])('accepts railway in %s', (APP_ENV) => {
    const sm = selectSecretManager(configFrom({ APP_ENV, SECRET_MANAGER_PROVIDER: 'railway' }));
    expect(sm.provider).toBe('railway');
  });

  it('still refuses the generic env backend in PRODUCTION', () => {
    expect(() =>
      selectSecretManager(configFrom({ APP_ENV: 'PRODUCTION', SECRET_MANAGER_PROVIDER: 'env' })),
    ).toThrow(/SECRET_MANAGER_PROVIDER=env is not permitted/);
  });
});

/** The factory exactly as Nest builds it, over the railway backend and a real registry. */
function railwayFactory(env: Record<string, string | undefined> = RAZORPAY_ENV) {
  const prisma = {
    paymentProviderConfig: {
      findUnique: jest.fn().mockResolvedValue(razorpayRow),
      findMany: jest.fn().mockResolvedValue([razorpayRow]),
    },
  };
  const config = configFrom({
    APP_ENV: 'PRODUCTION',
    PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'false',
    PAYMENT_FACTORY_WARMUP: 'false',
    // On, so an adapter that dropped the flag would disagree with the live one.
    RAZORPAY_ROUTE_ENABLED: true,
  });
  const secrets = new RailwaySecretManager({ ...env });
  // The live adapter the resolver built at boot from the Railway variables.
  const live = new RazorpayPaymentProvider(
    configFrom({ ...RAZORPAY_ENV, RAZORPAY_ROUTE_ENABLED: true }),
  );
  const mock = { name: 'mock' } as unknown as MockPaymentProvider;
  const registry = new PaymentProviderRegistry(live, mock);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = new PaymentProviderFactory(prisma as any, config, secrets, registry, mock);
  return { factory, registry, live, secrets, prisma };
}

describe('the factory over railway, and the money path', () => {
  it('builds razorpay from the approved variables', async () => {
    const { factory } = railwayFactory();
    const built = await factory.getProvider('razorpay');
    expect(built.name).toBe('razorpay');
  });

  it("never replaces the resolver's live adapter in the registry", async () => {
    // Checkout, webhooks, refunds and reconciliation read the registry. A factory instance
    // replacing the live adapter could only ever pair a stale stored key id with the secret.
    const { factory, registry, live } = railwayFactory();
    const built = await factory.getProvider('razorpay');
    expect(built).not.toBe(live);
    expect(registry.get('razorpay')).toBe(live);
  });

  it('builds the same credentials as the live adapter: webhooks verify identically', async () => {
    const { factory, live } = railwayFactory();
    const built = await factory.getProvider('razorpay');
    const rawBody = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_1', amount: 51918, notes: { bookingId: 'bk_1' } },
        },
      },
    });
    const signature = createHmac('sha256', RAZORPAY_ENV.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    const fromLive = await live.verifyWebhook({ rawBody, signature } as never);
    const fromFactory = await built.verifyWebhook({ rawBody, signature } as never);
    expect(fromFactory).toEqual(fromLive);

    const forged = createHmac('sha256', 'not-the-secret').update(rawBody).digest('hex');
    await expect(live.verifyWebhook({ rawBody, signature: forged } as never)).rejects.toThrow(
      AppException,
    );
    await expect(built.verifyWebhook({ rawBody, signature: forged } as never)).rejects.toThrow(
      AppException,
    );
  });

  it('passes RAZORPAY_ROUTE_ENABLED through, so a factory adapter agrees on Route', async () => {
    const { factory, live } = railwayFactory();
    const built = await factory.getProvider('razorpay');
    const routeOf = (p: unknown) => (p as { routeEnabled: boolean }).routeEnabled;
    expect(routeOf(live)).toBe(true);
    expect(routeOf(built)).toBe(true);
  });

  it('fails closed, naming the variable, when a Railway variable is missing', async () => {
    const { factory } = railwayFactory({ ...RAZORPAY_ENV, RAZORPAY_WEBHOOK_SECRET: undefined });
    await expect(factory.getProvider('razorpay')).rejects.toThrow(
      /RAZORPAY_WEBHOOK_SECRET is not set/,
    );
  });
});

describe('payment-live readiness over railway', () => {
  function readiness(env: Record<string, string | undefined> = RAZORPAY_ENV) {
    const { factory, secrets } = railwayFactory(env);
    // The provider health call goes to Razorpay; stubbed so the test stays offline.
    jest
      .spyOn(RazorpayPaymentProvider.prototype, 'healthCheck')
      .mockResolvedValue({ healthy: true, mode: 'live' });
    const prisma = {
      paymentProviderConfig: { findMany: jest.fn().mockResolvedValue([razorpayRow]) },
      merchantOnboarding: { findFirst: jest.fn().mockResolvedValue(null) },
      merchantCertification: { findFirst: jest.fn().mockResolvedValue(null) },
      paymentRoute: { count: jest.fn().mockResolvedValue(1) },
      webhookEvent: { findFirst: jest.fn().mockResolvedValue({ id: 'w1' }) },
    };
    return new PaymentLiveReadinessService(
      prisma as never,
      configFrom({ APP_ENV: 'PRODUCTION', PAYMENT_LIVE_ENABLED: 'true' }),
      secrets,
      factory,
      { isCircuitOpen: () => false } as never,
      { getState: async () => ({ enabled: false }) } as never,
    );
  }
  afterEach(() => jest.restoreAllMocks());

  const check = (checks: { key: string; passed: boolean }[], key: string) =>
    checks.find((c) => c.key === key);

  it('reports the secret store healthy and the credentials valid', async () => {
    const report = await readiness().evaluate('razorpay');
    expect(check(report.global, 'secret-manager')?.passed).toBe(true);
    expect(check(report.providers[0].checks, 'credentials')?.passed).toBe(true);
    expect(check(report.providers[0].checks, 'health')?.passed).toBe(true);
  });

  it('reports which variable is missing, never a value', async () => {
    const report = await readiness({ ...RAZORPAY_ENV, RAZORPAY_KEY_SECRET: '' }).evaluate(
      'razorpay',
    );
    expect(check(report.global, 'secret-manager')?.passed).toBe(false);
    const creds = report.providers[0].checks.find((c) => c.key === 'credentials');
    expect(creds?.passed).toBe(false);
    expect(creds?.detail).toMatch(/RAZORPAY_KEY_SECRET is not set/);
    expect(JSON.stringify(report)).not.toContain(RAZORPAY_ENV.RAZORPAY_WEBHOOK_SECRET);
  });
});

describe('provider promotion into PRODUCTION over railway', () => {
  it('remaps a sandbox row to the approved live names and resolves them', async () => {
    const { factory, secrets } = railwayFactory();
    const getSecret = jest.spyOn(secrets, 'getSecret');
    jest
      .spyOn(RazorpayPaymentProvider.prototype, 'healthCheck')
      .mockResolvedValue({ healthy: true, mode: 'live' });
    const prisma = {
      paymentProviderConfig: {
        findUnique: jest.fn().mockResolvedValue({
          ...razorpayRow,
          env: 'STAGING',
          secretKeyRef: 'payments/razorpay/staging/secret-key',
          webhookSecretRef: 'payments/razorpay/staging/webhook-secret',
        }),
      },
      paymentRoute: { count: jest.fn().mockResolvedValue(1) },
      merchantOnboarding: { count: jest.fn().mockResolvedValue(1) },
    };
    const svc = new PromotionService(
      prisma as never,
      { record: jest.fn() } as never,
      configFrom({ PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'false' }),
      secrets,
      factory,
    );
    const report = await svc.buildReport('STAGING', 'PRODUCTION', 'razorpay');
    expect(getSecret).toHaveBeenCalledWith('payments/razorpay/live/secret-key');
    expect(getSecret).toHaveBeenCalledWith('payments/razorpay/live/webhook-secret');
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.key);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
    jest.restoreAllMocks();
  });
});
