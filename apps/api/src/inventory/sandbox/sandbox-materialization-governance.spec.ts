import { loadConfig } from '../../config/configuration';
import { SandboxCatalogueMaterializer } from './sandbox-catalogue.materializer';
import { QUBE_MOCK_PROVIDER_CODE } from '../sourcing/providers/qube/qube-mock.fixture';

/**
 * The governance model, asserted rather than described.
 *
 * The whole Qube exercise turns on one rule: a provider feed may record what it publishes and
 * may never publish it. Sandbox materialization is the single exception, and an exception with
 * one condition is an exception waiting to become the rule — so it has three, each closing a
 * different way of arriving here by accident.
 *
 * These are cheap unit checks on purpose. The end-to-end proof that materialization WORKS is
 * the real-Postgres purchase spec; this is the proof that it does not work anywhere else.
 */

const LOCAL_BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  QR_SIGNING_SECRET: 'c'.repeat(40),
  PAYMENT_WEBHOOK_SECRET: 'd'.repeat(40),
  APP_ENV: 'LOCAL',
  NODE_ENV: 'test',
};

const PROD_BASE: Record<string, string> = {
  ...LOCAL_BASE,
  APP_ENV: 'PRODUCTION',
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.eticketsgo.example',
  PAYMENT_PROVIDER_NAME: 'stripe',
  EMAIL_PROVIDER: 'sendgrid',
  EMAIL_FROM: 'tickets@eticketsgo.example',
};

function withEnv(base: Record<string, string>, extra: Record<string, string> = {}) {
  return () => {
    const saved = process.env;
    process.env = { ...base, ...extra } as NodeJS.ProcessEnv;
    try {
      return loadConfig();
    } finally {
      process.env = saved;
    }
  };
}

/** The materializer with only the two dependencies its guards actually consult. */
function materializer(env: Record<string, string | undefined>): SandboxCatalogueMaterializer {
  const config = { get: (k: string) => env[k] } as never;
  return new SandboxCatalogueMaterializer(
    {} as never,
    config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const REQUEST = {
  providerCode: QUBE_MOCK_PROVIDER_CODE,
  organizationId: 'org1',
  actor: { id: 'u1', email: '', fullName: '', roles: [] } as never,
  pricingByCategory: {},
};

describe('a sandbox catalogue cannot become a production auto-publisher', () => {
  it('refuses a provider that is not the sandbox, even with the flag on', async () => {
    const m = materializer({ INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: true as never });
    await expect(m.materialize({ ...REQUEST, providerCode: 'QUBE' })).rejects.toMatchObject({
      code: 'INVENTORY_SOURCE_UNSUPPORTED',
    });
    // The name matters more than the code: this is the message an operator would read after
    // pointing it at a real feed, and it has to say what the alternative is.
    await expect(m.materialize({ ...REQUEST, providerCode: 'VISTA' })).rejects.toThrow(
      /reviewed and approved by an operator/,
    );
  });

  it('refuses when the flag is off', async () => {
    const m = materializer({});
    await expect(m.materialize(REQUEST)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['PRODUCTION', 'PROD', 'STAGING', 'UAT'])(
    'refuses in %s however the flag is set',
    async (APP_ENV) => {
      const m = materializer({
        INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: true as never,
        APP_ENV,
      });
      expect(m.enabled).toBe(false);
      await expect(m.materialize(REQUEST)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );

  it('is enabled only in a development-like environment', () => {
    for (const APP_ENV of ['LOCAL', 'DEV', 'TEST', 'QA']) {
      expect(
        materializer({ INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: true as never, APP_ENV }).enabled,
      ).toBe(true);
    }
  });
});

describe('the sandbox flags refuse to boot a production deployment', () => {
  it('rejects the Qube sandbox provider in production', () => {
    expect(withEnv(PROD_BASE, { INVENTORY_QUBE_MOCK_ENABLED: 'true' })).toThrow(
      /INVENTORY_QUBE_MOCK_ENABLED must be false in production/,
    );
  });

  it('rejects sandbox materialization in production', () => {
    expect(withEnv(PROD_BASE, { INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: 'true' })).toThrow(
      /INVENTORY_SANDBOX_MATERIALIZATION_ENABLED must be false in production/,
    );
  });

  it('rejects materialization with no sandbox catalogue to materialize', () => {
    // Half-configured is its own failure mode: the flag would sit there looking enabled while
    // the provider it names was never registered.
    expect(withEnv(LOCAL_BASE, { INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: 'true' })).toThrow(
      /requires INVENTORY_QUBE_MOCK_ENABLED/,
    );
  });

  it('allows both together outside production', () => {
    expect(
      withEnv(LOCAL_BASE, {
        INVENTORY_QUBE_MOCK_ENABLED: 'true',
        INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('lets the Qube sandbox satisfy provider confirmation without the other mock', () => {
    // Confirmation needs SOME external booking adapter. Both of today's are sandboxes, and
    // either one is enough — but production still has neither.
    expect(
      withEnv(LOCAL_BASE, {
        INVENTORY_QUBE_MOCK_ENABLED: 'true',
        BOOKING_PROVIDER_CONFIRMATION_ENABLED: 'true',
      }),
    ).not.toThrow();
    expect(withEnv(LOCAL_BASE, { BOOKING_PROVIDER_CONFIRMATION_ENABLED: 'true' })).toThrow(
      /requires an external booking provider/,
    );
  });
});
