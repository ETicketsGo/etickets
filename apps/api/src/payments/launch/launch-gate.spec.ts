import { ConfigService } from '@nestjs/config';
import { LaunchGateService } from './launch-gate.service';
import { PaymentLiveReadinessService } from '../readiness/payment-live-readiness.service';
import type { SecretManager } from '../../secrets/secret-manager.interface';

function make(opts: {
  env?: string;
  readinessOk?: boolean;
  providerReady?: boolean;
  cert?: { result: string; createdAt: Date } | null;
  discrepancies?: number;
  smHealthy?: boolean;
}) {
  const prisma = {
    paymentRoute: {
      findMany: jest.fn().mockResolvedValue([
        {
          country: '*',
          currency: 'USD',
          method: '*',
          provider: 'stripe',
          failoverProvider: null,
          active: true,
        },
      ]),
    },
    paymentProviderConfig: {
      findMany: jest.fn().mockResolvedValue([{ provider: 'stripe', enabled: true }]),
    },
    merchantOnboarding: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { provider: 'stripe', status: 'ACTIVE', webhookEndpointStatus: 'VERIFIED' },
        ]),
    },
    merchantCertification: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          'cert' in opts && opts.cert
            ? [{ provider: 'stripe', result: opts.cert.result, createdAt: opts.cert.createdAt }]
            : [],
        ),
    },
    reconciliationDiscrepancy: { count: jest.fn().mockResolvedValue(opts.discrepancies ?? 0) },
  };
  const readiness = {
    evaluate: jest.fn().mockResolvedValue({
      env: opts.env ?? 'PRODUCTION',
      ok: opts.readinessOk ?? true,
      global: [
        { key: 'live-enabled', passed: opts.readinessOk ?? true },
        { key: 'maintenance-off', passed: true },
      ],
      providers: [
        {
          provider: 'stripe',
          ok: opts.providerReady ?? true,
          checks: [{ key: 'health', passed: opts.providerReady ?? true }],
        },
      ],
    }),
  } as unknown as PaymentLiveReadinessService;
  const secrets = {
    provider: 'aws',
    healthCheck: jest.fn().mockResolvedValue({ healthy: opts.smHealthy ?? true, provider: 'aws' }),
  } as unknown as SecretManager;
  const config = { get: () => opts.env ?? 'PRODUCTION' } as unknown as ConfigService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new LaunchGateService(prisma as any, readiness, secrets, config);
}

describe('LaunchGateService', () => {
  it('GO for a provider that passes readiness with a recent PASS cert', async () => {
    const svc = make({
      readinessOk: true,
      providerReady: true,
      cert: { result: 'PASS', createdAt: new Date() },
    });
    const report = await svc.report();
    expect(report.overall).toBe('GO');
    expect(report.providers[0].goNoGo).toBe('GO');
    expect(report.countryProviderMatrix).toHaveLength(1);
  });

  it('NO-GO when the provider fails a readiness check', async () => {
    const svc = make({
      readinessOk: false,
      providerReady: false,
      cert: { result: 'PASS', createdAt: new Date() },
    });
    const report = await svc.report();
    expect(report.overall).toBe('NO-GO');
    expect(report.providers[0].goNoGo).toBe('NO-GO');
  });

  it('flags missing certification as a remaining risk', async () => {
    const svc = make({ readinessOk: true, providerReady: true, cert: null });
    const report = await svc.report();
    expect(report.remainingRisks.some((r) => /no recent PASS certification/.test(r))).toBe(true);
  });

  it('flags non-production environment and open discrepancies', async () => {
    const svc = make({
      env: 'STAGING',
      discrepancies: 3,
      cert: { result: 'PASS', createdAt: new Date() },
    });
    const report = await svc.report();
    expect(report.remainingRisks.some((r) => /not PRODUCTION/.test(r))).toBe(true);
    expect(report.reconciliation.openDiscrepancies).toBe(3);
    expect(report.reconciliation.ready).toBe(false);
  });
});
