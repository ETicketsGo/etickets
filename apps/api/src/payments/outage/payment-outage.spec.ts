import { CircuitBreaker } from '../orchestration/circuit-breaker';
import { PaymentOutageService } from './payment-outage.service';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { MaintenanceService } from '../../ops/maintenance.service';
import { PaymentOrchestrator } from '../orchestration/payment-orchestrator.service';

describe('CircuitBreaker operator controls', () => {
  it('forceOpen short-circuits and reset restores', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 10_000, now: () => t });
    expect(cb.canAttempt()).toBe(true);
    cb.forceOpen();
    expect(cb.canAttempt()).toBe(false);
    cb.reset();
    expect(cb.canAttempt()).toBe(true);
  });
});

function makeOutage(
  routes: Record<string, unknown>[] = [],
  configs: Record<string, unknown>[] = [],
) {
  const prisma = {
    paymentRoute: {
      findMany: jest.fn().mockResolvedValue(routes),
      update: jest.fn((a: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'r1', ...a.data }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    paymentProviderConfig: {
      findMany: jest.fn().mockResolvedValue(configs),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const orchestrator = {
    circuitStates: jest.fn().mockReturnValue({ stripe: 'CLOSED' }),
    activateFailover: jest.fn().mockResolvedValue(undefined),
    rollbackFailover: jest.fn().mockResolvedValue(undefined),
  } as unknown as PaymentOrchestrator;
  const maintenance = {
    getState: jest.fn().mockResolvedValue({ enabled: false }),
    setState: jest.fn((s: unknown) => Promise.resolve(s)),
  } as unknown as MaintenanceService;
  const config = { get: () => 'PRODUCTION' } as unknown as ConfigService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    svc: new PaymentOutageService(prisma as any, audit, orchestrator, maintenance, config),
    prisma,
    audit,
    orchestrator,
    maintenance,
  };
}

describe('PaymentOutageService', () => {
  it('status aggregates circuits, suspensions and providers', async () => {
    const { svc } = makeOutage(
      [{ active: true }, { active: false }],
      [
        { provider: 'stripe', enabled: true },
        { provider: 'razorpay', enabled: false },
      ],
    );
    const s = await svc.status();
    expect(s.activeRoutes).toBe(1);
    expect(s.suspendedRoutes).toBe(1);
    expect(s.disabledProviders).toEqual(['razorpay']);
    expect(s.circuits).toEqual({ stripe: 'CLOSED' });
  });

  it('suspends a country (bulk) and audits', async () => {
    const { svc, prisma, audit } = makeOutage();
    const res = await svc.setCountrySuspended('in', true, { userId: 'u1' });
    expect(prisma.paymentRoute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
    expect(res.affected).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_COUNTRY_SUSPENDED' }),
    );
  });

  it('suspends a provider by disabling its config', async () => {
    const { svc, prisma } = makeOutage();
    await svc.setProviderSuspended('stripe', true, { userId: 'u1' });
    expect(prisma.paymentProviderConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enabled: false } }),
    );
  });

  it('delegates failover activate/rollback to the orchestrator', async () => {
    const { svc, orchestrator } = makeOutage();
    await svc.activateFailover('stripe', { userId: 'u1' });
    await svc.rollbackFailover('stripe', { userId: 'u1' });
    expect(orchestrator.activateFailover).toHaveBeenCalledWith('stripe', { userId: 'u1' });
    expect(orchestrator.rollbackFailover).toHaveBeenCalledWith('stripe', { userId: 'u1' });
  });

  it('toggles maintenance mode', async () => {
    const { svc, maintenance } = makeOutage();
    await svc.setMaintenance(true, 'payments paused', { userId: 'u1' });
    expect(maintenance.setState).toHaveBeenCalledWith({
      enabled: true,
      message: 'payments paused',
    });
  });
});
