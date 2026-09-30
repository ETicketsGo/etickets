import { Logger } from '@nestjs/common';
import { bootstrapPaymentConfig } from './payment-config.bootstrap';

/**
 * The bootstrap writes the rows a fail-closed environment cannot start without - so what it
 * REFUSES to do matters more than what it writes. Each test below is one of those refusals.
 */
function fakePrisma(
  overrides: {
    enabled?: number;
    activeRoutes?: number;
    /*
      The stored rows. "Already configured" now means a row that EXISTS, is enabled, and whose
      mode matches the key - counting rows was not enough, because a row can be present, enabled
      and routed and still say TEST while the environment holds a live key, which is what took
      production down.
    */
    rows?: Array<{ provider: string; enabled: boolean; mode: string }>;
  } = {},
) {
  const providerUpserts: Array<Record<string, unknown>> = [];
  const routeUpserts: Array<Record<string, unknown>> = [];
  return {
    providerUpserts,
    routeUpserts,
    prisma: {
      paymentProviderConfig: {
        count: jest.fn().mockResolvedValue(overrides.enabled ?? 0),
        // The guard reads the stored rows to compare their mode against the key, so an empty
        // list is "no provider configured yet" - the bootstrap case these tests describe.
        findMany: jest.fn().mockResolvedValue(overrides.rows ?? []),
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
    const f = fakePrisma({
      enabled: 1,
      activeRoutes: 2,
      rows: [{ provider: 'razorpay', enabled: true, mode: 'LIVE' }],
    });
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

describe('bootstrapPaymentConfig and a mode that drifted', () => {
  /*
    The case that took production down hours after a working activation, on unchanged code and
    unchanged credentials: the row was present, enabled and routed, and said TEST while the
    environment held a live key. A guard that skipped on row COUNTS could not see it, so the API
    refused to start and the reason was dropped by the log rate limit.
  */
  function prismaWithRow(row: { enabled: boolean; mode: string }, activeRoutes = 4) {
    const providerUpserts: Array<Record<string, unknown>> = [];
    const routeUpserts: Array<Record<string, unknown>> = [];
    return {
      providerUpserts,
      routeUpserts,
      prisma: {
        paymentProviderConfig: {
          count: jest.fn().mockResolvedValue(row.enabled ? 1 : 0),
          findMany: jest.fn().mockResolvedValue([{ provider: 'razorpay', ...row }]),
          upsert: jest.fn(async (args: Record<string, unknown>) => {
            providerUpserts.push(args);
            return {};
          }),
        },
        paymentRoute: {
          count: jest.fn().mockResolvedValue(activeRoutes),
          upsert: jest.fn(async (args: Record<string, unknown>) => {
            routeUpserts.push(args);
            return {};
          }),
        },
      },
    };
  }

  const live = {
    RAZORPAY_KEY_ID: 'rzp_live_AAAAAAAAAAAAAA',
    RAZORPAY_KEY_SECRET: 'a'.repeat(24),
  };
  const reader = (vars: Record<string, string>) => (key: string) => vars[key];

  it('corrects a TEST row when the environment holds a live key', async () => {
    const f = prismaWithRow({ enabled: true, mode: 'TEST' });
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      reader(live),
      logger,
    );
    expect(result.skipped).toBeUndefined();
    expect(result.providers).toEqual(['razorpay:LIVE']);
    expect((f.providerUpserts[0].update as Record<string, unknown>).mode).toBe('LIVE');
  });

  it('leaves a row alone when the stored mode already matches the key', async () => {
    const f = prismaWithRow({ enabled: true, mode: 'LIVE' });
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      reader(live),
      logger,
    );
    expect(result.skipped).toBe('already-configured');
    expect(f.providerUpserts).toHaveLength(0);
    expect(f.routeUpserts).toHaveLength(0);
  });

  it('re-enables a row somebody disabled while the key is still there', async () => {
    // A disabled provider in a fail-closed environment is the same boot refusal by another name.
    const f = prismaWithRow({ enabled: false, mode: 'LIVE' });
    await bootstrapPaymentConfig(f.prisma as never, 'PRODUCTION', reader(live), logger);
    expect((f.providerUpserts[0].update as Record<string, unknown>).enabled).toBe(true);
  });

  it('does not promote a TEST key to LIVE', async () => {
    /*
      The direction that must never happen. Mode comes from the credential, so a sandbox key stays
      TEST - production then refuses it, which is correct and is checked elsewhere at config level.
    */
    const f = prismaWithRow({ enabled: true, mode: 'LIVE' });
    const result = await bootstrapPaymentConfig(
      f.prisma as never,
      'PRODUCTION',
      reader({ RAZORPAY_KEY_ID: 'rzp_test_AAAAAAAAAAAAAA', RAZORPAY_KEY_SECRET: 'b'.repeat(24) }),
      logger,
    );
    expect(result.providers).toEqual(['razorpay:TEST']);
    expect((f.providerUpserts[0].update as Record<string, unknown>).mode).toBe('TEST');
  });
});
