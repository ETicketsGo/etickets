import { ConfigService } from '@nestjs/config';
import { validateCredentials } from './credential-validator';
import { providerBinding } from './provider-binding';
import { PaymentProviderFactory } from './payment-provider.factory';
import { PaymentProviderRegistry } from '../../orchestration/provider-registry';
import { MockPaymentProvider } from '../mock-payment.provider';
import type { SecretManager } from '../../../secrets/secret-manager.interface';
import { AppException } from '../../../common/errors';

describe('validateCredentials', () => {
  const base = {
    env: 'PRODUCTION' as const,
    mode: 'LIVE' as const,
    classified: 'live' as const,
    publicKey: 'pk_live_ok',
    secret: 'sk_live_ok',
    webhookSecret: 'whsec_ok',
    requiresSecret: true,
    requiresWebhookSecret: true,
  };

  it('passes for well-formed live credentials in production', () => {
    expect(validateCredentials(base)).toEqual([]);
  });
  it('rejects a missing required secret (fail closed)', () => {
    expect(validateCredentials({ ...base, secret: '' })).toContain('required secret is missing');
  });
  it('rejects placeholder credentials', () => {
    expect(validateCredentials({ ...base, secret: 'sk_live_replace_me' }).join()).toMatch(
      /placeholder/,
    );
  });
  it('rejects test credentials in production', () => {
    const r = validateCredentials({ ...base, classified: 'test', mode: 'TEST' });
    expect(r.join()).toMatch(/test credentials are not allowed in PRODUCTION/);
  });
  it('rejects live credentials in a lower env unless allowed', () => {
    const r = validateCredentials({ ...base, env: 'UAT' });
    expect(r.join()).toMatch(/live credentials are not allowed in UAT/);
    expect(validateCredentials({ ...base, env: 'UAT', allowLiveKeysInLowerEnv: true })).toEqual([]);
  });
  it('rejects a mode/credential mismatch', () => {
    expect(
      validateCredentials({ ...base, mode: 'LIVE', classified: 'test', env: 'STAGING' }).join(),
    ).toMatch(/mode is LIVE but the credentials are test/);
  });
});

describe('provider bindings', () => {
  it('classify stripe by secret prefix', () => {
    const b = providerBinding('stripe')!;
    expect(b.classifyMode({ secret: 'sk_live_x' })).toBe('live');
    expect(b.classifyMode({ secret: 'sk_test_x' })).toBe('test');
  });
  it('classify razorpay by key id prefix', () => {
    expect(providerBinding('razorpay')!.classifyMode({ publicKey: 'rzp_test_x' })).toBe('test');
  });
  it('classify paypal/square by base url', () => {
    expect(
      providerBinding('paypal')!.classifyMode({ apiBaseUrl: 'https://api-m.paypal.com' }),
    ).toBe('live');
    expect(
      providerBinding('square')!.classifyMode({
        apiBaseUrl: 'https://connect.squareupsandbox.com',
      }),
    ).toBe('test');
  });
});

// ── Factory ─────────────────────────────────────────────────────────────────
const stripeConfigRow = {
  env: 'PRODUCTION',
  provider: 'stripe',
  enabled: true,
  mode: 'LIVE',
  publicKey: 'pk_live_x',
  secretKeyRef: 'payments/stripe/production/secret-key',
  webhookSecretRef: 'payments/stripe/production/webhook-secret',
  apiBaseUrl: null,
  updatedAt: new Date('2026-07-14T00:00:00Z'),
};

function makeFactory(opts: {
  appEnv?: string;
  row?: Record<string, unknown> | null;
  secrets?: Record<string, string>;
  secretThrows?: boolean;
}) {
  const prisma = {
    paymentProviderConfig: {
      findUnique: jest.fn().mockResolvedValue(opts.row === undefined ? stripeConfigRow : opts.row),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const config = {
    get: (k: string) =>
      ({
        APP_ENV: opts.appEnv ?? 'PRODUCTION',
        PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'false',
        PAYMENT_FACTORY_WARMUP: 'false',
        STRIPE_SUCCESS_URL: 'https://x/success',
        STRIPE_CANCEL_URL: 'https://x/cancel',
      })[k],
  } as unknown as ConfigService;
  const secrets: SecretManager = {
    provider: 'fake',
    getSecret: jest.fn((ref: string) => {
      if (opts.secretThrows) return Promise.reject(new Error('secret missing'));
      return Promise.resolve((opts.secrets ?? {})[ref] ?? 'sk_live_resolved');
    }),
    getSecrets: jest.fn(),
    validateReference: () => true,
    healthCheck: jest.fn(),
    invalidateCache: jest.fn(),
  };
  const registry = {
    add: jest.fn(),
    get: jest.fn(),
    has: jest.fn(),
    list: jest.fn(),
  } as unknown as PaymentProviderRegistry;
  const mock = { name: 'mock' } as unknown as MockPaymentProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = new PaymentProviderFactory(prisma as any, config, secrets, registry, mock);
  return { factory, prisma, secrets, registry, mock };
}

describe('PaymentProviderFactory', () => {
  it('builds a provider from config + resolved secrets and registers it', async () => {
    const { factory, registry, secrets } = makeFactory({
      secrets: {
        'payments/stripe/production/secret-key': 'sk_live_realkey',
        'payments/stripe/production/webhook-secret': 'whsec_real',
      },
    });
    const provider = await factory.getProvider('stripe');
    expect(provider.name).toBe('stripe');
    expect(secrets.getSecret).toHaveBeenCalledWith('payments/stripe/production/secret-key');
    expect(registry.add).toHaveBeenCalledWith(provider);
  });

  it('caches by fingerprint (second call does not re-resolve secrets)', async () => {
    const { factory, secrets } = makeFactory({
      secrets: {
        'payments/stripe/production/secret-key': 'sk_live_realkey',
        'payments/stripe/production/webhook-secret': 'whsec_real',
      },
    });
    await factory.getProvider('stripe');
    await factory.getProvider('stripe');
    expect((secrets.getSecret as jest.Mock).mock.calls.length).toBe(2); // 2 refs, once total
  });

  it('refuses a disabled provider', async () => {
    const { factory } = makeFactory({ row: { ...stripeConfigRow, enabled: false } });
    await expect(factory.getProvider('stripe')).rejects.toBeInstanceOf(AppException);
  });

  it('refuses an unconfigured provider', async () => {
    const { factory } = makeFactory({ row: null });
    await expect(factory.getProvider('stripe')).rejects.toBeInstanceOf(AppException);
  });

  it('fails closed when a secret cannot be resolved', async () => {
    const { factory } = makeFactory({ secretThrows: true });
    await expect(factory.getProvider('stripe')).rejects.toBeTruthy();
  });

  it('rejects test credentials in production (via classification)', async () => {
    const { factory } = makeFactory({
      secrets: {
        'payments/stripe/production/secret-key': 'sk_test_notallowed',
        'payments/stripe/production/webhook-secret': 'whsec_real',
      },
    });
    const err = (await factory.getProvider('stripe').catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(AppException);
    expect(err.message).toMatch(/test credentials|mode is LIVE but the credentials are test/);
    expect(err.message).not.toContain('sk_test_notallowed');
  });

  it('blocks the dummy provider in PRODUCTION', async () => {
    const { factory } = makeFactory({ appEnv: 'PRODUCTION' });
    await expect(factory.getProvider('dummy')).rejects.toBeInstanceOf(AppException);
  });

  it('returns the mock for dummy in LOCAL', async () => {
    const { factory, registry, mock } = makeFactory({ appEnv: 'LOCAL' });
    const p = await factory.getProvider('dummy');
    expect(p).toBe(mock);
    expect(registry.add).toHaveBeenCalledWith(mock);
  });

  it('refresh invalidates the secret cache and rebuilds', async () => {
    const { factory, secrets } = makeFactory({
      secrets: {
        'payments/stripe/production/secret-key': 'sk_live_realkey',
        'payments/stripe/production/webhook-secret': 'whsec_real',
      },
    });
    await factory.getProvider('stripe');
    await factory.refresh('stripe');
    expect(secrets.invalidateCache).toHaveBeenCalledWith('payments/stripe/production/secret-key');
    expect(secrets.invalidateCache).toHaveBeenCalledWith(
      'payments/stripe/production/webhook-secret',
    );
  });
});
