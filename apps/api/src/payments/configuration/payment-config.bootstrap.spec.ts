import { Logger } from '@nestjs/common';
import { bootstrapPaymentConfig } from './payment-config.bootstrap';

/**
 * The bootstrap writes the rows a fail-closed environment cannot start without - so what it
 * REFUSES to do matters more than what it writes. Each test below is one of those refusals.
 */
function fakePrisma(overrides: { enabled?: number; activeRoutes?: number } = {}) {
  const providerUpserts: Array<Record<string, unknown>> = [];
  const routeUpserts: Array<Record<string, unknown>> = [];
  return {
    providerUpserts,
    routeUpserts,
    prisma: {
      paymentProviderConfig: {
        count: jest.fn().mockResolvedValue(overrides.enabled ?? 0),
        upsert: jest.fn(async (args: Record<string, unknown>) => {
          providerUpserts.push(args);
          return {};
        }),
      },
      paymentRoute: {
        count: jest.fn().mockResolvedValue(overrides.activeRoutes ?? 0),
        upsert: jest.fn(async (args: Record<string, unknown>) => {
          routeUpserts.push(args);
          return {};
        }),
      },
    },
  };
}

const logger = new Logger('test');
beforeEach(() => {
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const envReader = (vars: Record<string, string>) => (key: string) => vars[key];

const LIVE_RAZORPAY = {
  RAZORPAY_KEY_ID: 'rzp_live_AAAAAAAAAAAAAA',
  RAZORPAY_KEY_SECRET: 'a'.repeat(24),
};

describe('bootstrapPaymentConfig', () => {
  it('does nothing when the environment is already configured', async () => {
    const f = fakePrisma({ enabled: 1, activeRoutes: 2 });
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader(LIVE_RAZORPAY),
      logger,
    );
    expect(result.skipped).toBe('already-configured');
    expect(f.providerUpserts).toHaveLength(0);
    expect(f.routeUpserts).toHaveLength(0);
  });

  it('does nothing when the environment holds no credentials', async () => {
    /*
      This is the declared activation-pending state. Inventing a provider here is the one thing
      production must never do - it would assert that money can be taken through a gateway we
      cannot authenticate against.
    */
    const f = fakePrisma();
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader({}),
      logger,
    );
    expect(result.skipped).toBe('no-credentials');
    expect(f.providerUpserts).toHaveLength(0);
  });

  it('refuses a razorpay key id with no secret', async () => {
    // A key id alone authenticates against nothing, and the row would pass validation and then
    // fail at the gateway.
    const f = fakePrisma();
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader({ RAZORPAY_KEY_ID: 'rzp_live_AAAAAAAAAAAAAA' }),
      logger,
    );
    expect(result.skipped).toBe('no-credentials');
    expect(f.providerUpserts).toHaveLength(0);
  });

  it('never enables the simulated gateway, even where it is permitted', async () => {
    // QA permits `dummy`, and enabling it is a seed's decision, never a booting process's.
    const f = fakePrisma();
    await bootstrapPaymentConfig(f.prisma as never, 'QA', envReader({}), logger);
    expect(f.providerUpserts).toHaveLength(0);
    expect(f.routeUpserts).toHaveLength(0);
  });

  it('enables a live razorpay key as LIVE, reading the mode from the key', async () => {
    const f = fakePrisma();
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader(LIVE_RAZORPAY),
      logger,
    );
    expect(result.providers).toEqual(['razorpay:LIVE']);
    const create = f.providerUpserts[0].create as Record<string, unknown>;
    expect(create.enabled).toBe(true);
    expect(create.mode).toBe('LIVE');
    expect(create.publicKey).toBe(LIVE_RAZORPAY.RAZORPAY_KEY_ID);
    // References, never credentials.
    expect(create.secretKeyRef).toBe('payments/razorpay/live/secret-key');
    expect(create.webhookSecretRef).toBe('payments/razorpay/live/webhook-secret');
    expect(JSON.stringify(f.providerUpserts)).not.toContain(LIVE_RAZORPAY.RAZORPAY_KEY_SECRET);
  });

  it('writes an INR route to razorpay and no route for a currency it cannot settle', async () => {
    /*
      Razorpay cannot settle USD or CAD, and the wildcard belongs to Stripe - which this
      environment has no keys for. So INR is the only row, and the absence of the others is the
      point: readiness can report a missing market, where a route to an unusable gateway would
      only fail in front of a customer.
    */
    const f = fakePrisma();
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader(LIVE_RAZORPAY),
      logger,
    );
    expect(result.routes).toEqual(['INR->razorpay']);
    const create = f.routeUpserts[0].create as Record<string, unknown>;
    expect(create).toMatchObject({
      country: '*',
      currency: 'INR',
      method: '*',
      provider: 'razorpay',
      active: true,
    });
    expect(create.failoverProvider).toBeNull();
  });

  it('bootstraps routes when providers exist but every route is inactive', async () => {
    // The half-configured case: a provider row survived and the routes did not. Both counts are
    // checked, because either one alone leaves the environment unable to boot.
    const f = fakePrisma({ enabled: 1, activeRoutes: 0 });
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader(LIVE_RAZORPAY),
      logger,
    );
    expect(result.skipped).toBeUndefined();
    expect(result.routes).toEqual(['INR->razorpay']);
  });

  it('gives stripe the USD and CAD rows plus the wildcard, and razorpay the INR one', async () => {
    const f = fakePrisma();
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      envReader({
        ...LIVE_RAZORPAY,
        STRIPE_SECRET_KEY: 'sk_live_bbbbbbbbbbbb',
        STRIPE_PUBLISHABLE_KEY: 'pk_live_bbbbbbbbbbbb',
      }),
      logger,
    );
    expect(result.providers).toEqual(['razorpay:LIVE', 'stripe:LIVE']);
    expect(result.routes).toEqual(['INR->razorpay', 'USD->stripe', 'CAD->stripe', '*->stripe']);
  });
});
