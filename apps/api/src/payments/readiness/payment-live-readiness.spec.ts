import { ConfigService } from '@nestjs/config';
import { PaymentLiveReadinessService } from './payment-live-readiness.service';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import { PaymentOrchestrator } from '../orchestration/payment-orchestrator.service';
import { MaintenanceService } from '../../ops/maintenance.service';
import type { SecretManager } from '../../secrets/secret-manager.interface';

function make(opts: {
  appEnv?: string;
  liveEnabled?: string;
  maintenance?: boolean;
  smHealthy?: boolean;
  configs?: Record<string, unknown>[];
  activeMerchant?: unknown;
  verifiedWebhook?: unknown;
  cert?: { createdAt: Date } | null;
  routeCount?: number;
  circuitOpen?: boolean;
  buildThrows?: boolean;
  healthy?: boolean;
}) {
  const prisma = {
    paymentProviderConfig: { findMany: jest.fn().mockResolvedValue(opts.configs ?? []) },
    merchantOnboarding: {
      findFirst: jest.fn((args: { where: { webhookEndpointStatus?: string } }) =>
        Promise.resolve(
          args.where.webhookEndpointStatus
            ? (opts.verifiedWebhook ?? null)
            : (opts.activeMerchant ?? null),
        ),
      ),
    },
    merchantCertification: {
      findFirst: jest.fn().mockResolvedValue('cert' in opts ? opts.cert : null),
    },
    paymentRoute: { count: jest.fn().mockResolvedValue(opts.routeCount ?? 1) },
  };
  const config = {
    get: (k: string) =>
      ({
        APP_ENV: opts.appEnv ?? 'PRODUCTION',
        PAYMENT_LIVE_ENABLED: opts.liveEnabled ?? 'true',
        CERTIFICATION_MAX_AGE_DAYS: 30,
      })[k],
  } as unknown as ConfigService;
  const secrets = {
    healthCheck: jest.fn().mockResolvedValue({ healthy: opts.smHealthy ?? true, provider: 'x' }),
  } as unknown as SecretManager;
  const factory = {
    getProvider: jest.fn(() =>
      opts.buildThrows
        ? Promise.reject(new Error('bad creds'))
        : Promise.resolve({
            healthCheck: jest.fn().mockResolvedValue({ healthy: opts.healthy ?? true }),
          }),
    ),
  } as unknown as PaymentProviderFactory;
  const orchestrator = {
    isCircuitOpen: jest.fn().mockReturnValue(opts.circuitOpen ?? false),
  } as unknown as PaymentOrchestrator;
  const maintenance = {
    getState: jest.fn().mockResolvedValue({ enabled: opts.maintenance ?? false }),
  } as unknown as MaintenanceService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PaymentLiveReadinessService(
    prisma as any,
    config,
    secrets,
    factory,
    orchestrator,
    maintenance,
  );
}

const liveStripe = { provider: 'stripe', mode: 'LIVE' };

describe('PaymentLiveReadinessService', () => {
  it('is ready when every control passes', async () => {
    const svc = make({
      configs: [liveStripe],
      activeMerchant: { id: 'm1' },
      verifiedWebhook: { id: 'm1' },
      cert: { createdAt: new Date() },
      routeCount: 1,
    });
    const report = await svc.evaluate();
    expect(report.ok).toBe(true);
    expect(report.providers[0].ok).toBe(true);
  });

  it('is not ready when PAYMENT_LIVE_ENABLED is false', async () => {
    const svc = make({
      liveEnabled: 'false',
      configs: [liveStripe],
      activeMerchant: {},
      verifiedWebhook: {},
      cert: { createdAt: new Date() },
    });
    const report = await svc.evaluate();
    expect(report.ok).toBe(false);
    expect(report.global.find((c) => c.key === 'live-enabled')?.passed).toBe(false);
  });

  it('is not ready during maintenance', async () => {
    const svc = make({
      maintenance: true,
      configs: [liveStripe],
      activeMerchant: {},
      verifiedWebhook: {},
      cert: { createdAt: new Date() },
    });
    expect((await svc.evaluate()).ok).toBe(false);
  });

  it('fails the provider when credentials cannot be built', async () => {
    const svc = make({
      configs: [liveStripe],
      buildThrows: true,
      activeMerchant: {},
      verifiedWebhook: {},
      cert: { createdAt: new Date() },
    });
    const report = await svc.evaluate();
    expect(report.providers[0].checks.find((c) => c.key === 'credentials')?.passed).toBe(false);
    expect(report.providers[0].ok).toBe(false);
  });

  it('fails the provider on a stale certification', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000);
    const svc = make({
      configs: [liveStripe],
      activeMerchant: {},
      verifiedWebhook: {},
      cert: { createdAt: old },
    });
    const report = await svc.evaluate();
    expect(report.providers[0].checks.find((c) => c.key === 'certification')?.passed).toBe(false);
  });

  it('fails when the circuit breaker is open', async () => {
    const svc = make({
      configs: [liveStripe],
      activeMerchant: {},
      verifiedWebhook: {},
      cert: { createdAt: new Date() },
      circuitOpen: true,
    });
    const report = await svc.evaluate();
    expect(report.providers[0].checks.find((c) => c.key === 'circuit')?.passed).toBe(false);
  });

  it('rejects the dummy provider outright', async () => {
    const svc = make({ configs: [{ provider: 'dummy', mode: 'DUMMY' }] });
    const report = await svc.evaluate();
    expect(report.providers[0].ok).toBe(false);
  });

  it('is not ready outside production', async () => {
    const svc = make({
      appEnv: 'STAGING',
      configs: [liveStripe],
      activeMerchant: {},
      verifiedWebhook: {},
      cert: { createdAt: new Date() },
    });
    const report = await svc.evaluate();
    expect(report.global.find((c) => c.key === 'env-production')?.passed).toBe(false);
    expect(report.ok).toBe(false);
  });
});
