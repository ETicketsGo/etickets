import { PaymentReconciliationService, reconcilePayment } from './payment-reconciliation.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import { MetricsService } from '../../metrics/metrics.service';
import { AuditService } from '../../audit/audit.service';

describe('reconcilePayment', () => {
  const succeeded = { status: 'SUCCEEDED', amountMinor: 1000 };
  it('matches when both settled and amounts agree', () => {
    expect(
      reconcilePayment(succeeded, {
        providerRef: 'x',
        status: 'CAPTURED',
        amountMinor: 1000,
        currency: 'USD',
      }),
    ).toBe('matched');
  });
  it('mismatches when the provider disagrees on settlement', () => {
    expect(
      reconcilePayment(succeeded, {
        providerRef: 'x',
        status: 'FAILED',
        amountMinor: 1000,
        currency: 'USD',
      }),
    ).toBe('mismatched');
  });
  it('mismatches when amounts differ', () => {
    expect(
      reconcilePayment(succeeded, {
        providerRef: 'x',
        status: 'CAPTURED',
        amountMinor: 900,
        currency: 'USD',
      }),
    ).toBe('mismatched');
  });
  it('is unverifiable when the provider cannot be queried', () => {
    expect(reconcilePayment(succeeded, null)).toBe('unverifiable');
  });
});

function makeService(opts: {
  payments?: Record<string, unknown>[];
  refunds?: Record<string, unknown>[];
  adapter?: { getPayment?: (ref: string) => Promise<unknown> };
}) {
  const prisma = {
    payment: {
      findMany: jest.fn().mockResolvedValue(opts.payments ?? []),
    },
    refund: {
      findMany: jest.fn().mockResolvedValue(opts.refunds ?? []),
    },
  };
  const registry = {
    get: jest.fn().mockReturnValue(opts.adapter),
  } as unknown as PaymentProviderRegistry;
  const metrics = { recordReconciliation: jest.fn() } as unknown as MetricsService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    svc: new PaymentReconciliationService(prisma as any, registry, metrics, audit),
    metrics,
  };
}

const WINDOW: [Date, Date] = [new Date('2026-07-01'), new Date('2026-07-14')];

describe('PaymentReconciliationService.reconcile', () => {
  it('classifies matched / mismatched / unverifiable and records metrics', async () => {
    const payments = [
      {
        bookingId: 'b1',
        provider: 'stripe',
        providerRef: 'pi_1',
        status: 'SUCCEEDED',
        amountMinor: 1000,
      },
      {
        bookingId: 'b2',
        provider: 'stripe',
        providerRef: 'pi_2',
        status: 'SUCCEEDED',
        amountMinor: 2000,
      },
    ];
    const adapter = {
      getPayment: jest.fn((ref: string) =>
        Promise.resolve(
          ref === 'pi_1'
            ? { providerRef: ref, status: 'CAPTURED', amountMinor: 1000, currency: 'USD' }
            : { providerRef: ref, status: 'FAILED', amountMinor: 2000, currency: 'USD' },
        ),
      ),
    };
    const { svc, metrics } = makeService({ payments, adapter });
    const report = await svc.reconcile(...WINDOW);
    expect(report.checked).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.mismatched).toBe(1);
    expect(report.mismatches[0].bookingId).toBe('b2');
    expect(metrics.recordReconciliation).toHaveBeenCalledWith(1, 1, 0);
  });

  it('marks payments unverifiable when the adapter has no getPayment', async () => {
    const payments = [
      {
        bookingId: 'b1',
        provider: 'razorpay',
        providerRef: 'r1',
        status: 'SUCCEEDED',
        amountMinor: 500,
      },
    ];
    const { svc } = makeService({ payments, adapter: {} });
    const report = await svc.reconcile(...WINDOW);
    expect(report.unverifiable).toBe(1);
    expect(report.matched).toBe(0);
  });
});

describe('PaymentReconciliationService.settlement', () => {
  it('aggregates gross and refunds per provider + currency into net', async () => {
    const payments = [
      { provider: 'stripe', currency: 'USD', amountMinor: 1000 },
      { provider: 'stripe', currency: 'USD', amountMinor: 500 },
      { provider: 'razorpay', currency: 'INR', amountMinor: 3000 },
    ];
    const refunds = [
      { amountMinor: 200, booking: { payment: { provider: 'stripe', currency: 'USD' } } },
    ];
    const { svc } = makeService({ payments, refunds });
    const lines = await svc.settlement(...WINDOW);
    const stripe = lines.find((l) => l.provider === 'stripe')!;
    expect(stripe.grossMinor).toBe(1500);
    expect(stripe.refundedMinor).toBe(200);
    expect(stripe.netMinor).toBe(1300);
    expect(stripe.count).toBe(2);
    const razor = lines.find((l) => l.provider === 'razorpay')!;
    expect(razor.netMinor).toBe(3000);
  });
});
