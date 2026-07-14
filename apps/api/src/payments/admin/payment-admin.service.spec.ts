import { PaymentAdminService } from './payment-admin.service';
import { PaymentConfigService } from '../configuration/payment-config.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/errors';

const enabledStripe = {
  id: 'c1',
  env: 'PRODUCTION',
  provider: 'stripe',
  enabled: true,
  mode: 'LIVE',
  publicKey: 'pk_live_x',
  secretKeyRef: 'ref/s',
  webhookSecretRef: 'ref/w',
};
const catchAllRoute = {
  id: 'r1',
  env: 'PRODUCTION',
  country: '*',
  currency: '*',
  method: '*',
  provider: 'stripe',
  failoverProvider: null,
  active: true,
};

/** Build a tx/prisma stub over in-memory config + route rows. */
function makeDb(configs: Record<string, unknown>[], routes: Record<string, unknown>[]) {
  const tx = {
    paymentProviderConfig: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(configs.find((c) => c.id === where.id) ?? null),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = configs.find((c) => c.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
      findMany: jest.fn(() => Promise.resolve(configs)),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(data)),
    },
    paymentRoute: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(routes.find((r) => r.id === where.id) ?? null),
      ),
      findMany: jest.fn(() => Promise.resolve(routes)),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'new', ...data };
        routes.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = routes.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        const i = routes.findIndex((r) => r.id === where.id);
        if (i >= 0) routes.splice(i, 1);
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, tx };
}

function makeService(
  prisma: unknown,
  opts: { env?: string; adapter?: { healthCheck?: () => Promise<unknown> } } = {},
) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { environment: opts.env ?? 'PRODUCTION' } as unknown as PaymentConfigService;
  const registry = {
    get: jest.fn().mockReturnValue(opts.adapter),
  } as unknown as PaymentProviderRegistry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: new PaymentAdminService(prisma as any, audit, config, registry), audit };
}

describe('PaymentAdminService', () => {
  it('overview returns providers, routes and validation', async () => {
    const { prisma } = makeDb([{ ...enabledStripe, merchantAccounts: [] }], [{ ...catchAllRoute }]);
    const { svc } = makeService(prisma);
    const res = await svc.overview('PRODUCTION');
    expect(res.validation.ok).toBe(true);
    expect(res.providers).toHaveLength(1);
    expect(res.routes).toHaveLength(1);
  });

  it('updateConfig commits a valid change and audits it', async () => {
    const { prisma } = makeDb([{ ...enabledStripe }], [{ ...catchAllRoute }]);
    const { svc, audit } = makeService(prisma);
    await svc.updateConfig('PRODUCTION', 'c1', { priority: 5 }, { userId: 'u1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_CONFIG_UPDATED' }),
    );
  });

  it('rejects and rolls back a change that would invalidate a fail-closed env', async () => {
    // Disabling the only enabled provider in PRODUCTION → route points at nothing.
    const { prisma } = makeDb([{ ...enabledStripe }], [{ ...catchAllRoute }]);
    const { svc, audit } = makeService(prisma);
    await expect(
      svc.updateConfig('PRODUCTION', 'c1', { enabled: false }, { userId: 'u1' }),
    ).rejects.toBeInstanceOf(AppException);
    // No audit for a rejected change.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows the same change in a non-fail-closed env (LOCAL)', async () => {
    const local = { ...enabledStripe, env: 'LOCAL', mode: 'DUMMY', provider: 'dummy' };
    const { prisma } = makeDb([local], [{ ...catchAllRoute, env: 'LOCAL', provider: 'dummy' }]);
    const { svc } = makeService(prisma, { env: 'LOCAL' });
    await expect(
      svc.updateConfig('LOCAL', 'c1', { enabled: false }, { userId: 'u1' }),
    ).resolves.toBeDefined();
  });

  it('testConnection runs the adapter health check and audits', async () => {
    const { prisma } = makeDb([{ ...enabledStripe }], []);
    const adapter = { healthCheck: jest.fn().mockResolvedValue({ healthy: true, mode: 'live' }) };
    const { svc, audit } = makeService(prisma, { adapter });
    const res = await svc.testConnection('PRODUCTION', 'c1', { userId: 'u1' });
    expect(res).toEqual({ healthy: true, mode: 'live' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_CONFIG_TESTED' }),
    );
  });

  it('testConnection reports honestly when no adapter is constructed', async () => {
    const { prisma } = makeDb([{ ...enabledStripe }], []);
    const { svc } = makeService(prisma, { adapter: undefined });
    const res = await svc.testConnection('PRODUCTION', 'c1', { userId: 'u1' });
    expect(res.healthy).toBe(false);
  });

  it('createRoute rejects a route pointing at a disabled provider in PRODUCTION', async () => {
    const { prisma } = makeDb([{ ...enabledStripe }], [{ ...catchAllRoute }]);
    const { svc } = makeService(prisma);
    await expect(
      svc.createRoute(
        'PRODUCTION',
        { country: 'IN', currency: 'INR', method: '*', provider: 'razorpay' },
        { userId: 'u1' },
      ),
    ).rejects.toBeInstanceOf(AppException);
  });
});
