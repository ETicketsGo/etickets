import {
  PaymentReconciliationService,
  reconcilePayment,
  reconcilePaymentDetailed,
} from './payment-reconciliation.service';
import type { PaymentStatusResult } from '../provider/payment-provider.interface';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import { MetricsService } from '../../metrics/metrics.service';
import { AuditService } from '../../audit/audit.service';

describe('reconcilePayment', () => {
  const succeeded = { status: 'SUCCEEDED', amountMinor: 1000, refundedMinor: 0, refunds: [] };
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

/*
  Refund cases. Razorpay keeps a payment `captured` until ALL of it has been refunded, and reports
  the original amount throughout - so a partial refund is CAPTURED at the full amount there and
  PARTIALLY_REFUNDED here. The QA rows that raised this were exactly that shape: a buyer refund
  of the tickets with the fees kept (for example 199800 of 206922 refunded).
*/
describe('reconcilePaymentDetailed - refunds', () => {
  const CAPTURED = 206922;
  type RefundRow = { status: string; amountMinor: number; providerRef: string | null };
  const provider = (
    status: PaymentStatusResult['status'],
    amountMinor = CAPTURED,
  ): PaymentStatusResult => ({ providerRef: 'pay_1', status, amountMinor, currency: 'INR' });
  const done = (amountMinor: number, providerRef: string | null = `rfnd_${amountMinor}`) => ({
    status: 'COMPLETED',
    amountMinor,
    providerRef,
  });
  const our = (status: string, refundedMinor: number, refunds: RefundRow[]) => ({
    status,
    amountMinor: CAPTURED,
    refundedMinor,
    refunds,
  });
  const mismatched = (reason: string) => ({ verdict: 'mismatched', reason });
  const matched = { verdict: 'matched' };

  it('zero refunds: a captured payment matches', () => {
    expect(reconcilePaymentDetailed(our('SUCCEEDED', 0, []), provider('CAPTURED'))).toEqual(
      matched,
    );
  });

  it('one partial refund (tickets back, fees kept) matches', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 199800, [done(199800)]),
        provider('CAPTURED'),
      ),
    ).toEqual(matched);
  });

  it('multiple partial refunds that add up to refundedMinor match', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 150000, [done(50000), done(100000)]),
        provider('CAPTURED'),
      ),
    ).toEqual(matched);
  });

  it('two genuine partial refunds of the same amount are not duplicates', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 100000, [done(50000, 'rfnd_a'), done(50000, 'rfnd_b')]),
        provider('CAPTURED'),
      ),
    ).toEqual(matched);
  });

  it('a full refund matches only when the provider also says REFUNDED', () => {
    const full = our('REFUNDED', CAPTURED, [done(CAPTURED)]);
    expect(reconcilePaymentDetailed(full, provider('REFUNDED'))).toEqual(matched);
    expect(reconcilePaymentDetailed(full, provider('CAPTURED'))).toEqual(
      mismatched('PROVIDER_STATUS_DIFFERS'),
    );
  });

  it('a partial refund the provider calls fully refunded is a mismatch', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 199800, [done(199800)]),
        provider('REFUNDED'),
      ),
    ).toEqual(mismatched('PROVIDER_STATUS_DIFFERS'));
  });

  it('the same provider refund recorded twice is a duplicate', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 100000, [done(50000, 'rfnd_x'), done(50000, 'rfnd_x')]),
        provider('CAPTURED'),
      ),
    ).toEqual(mismatched('DUPLICATE_REFUND'));
  });

  it('a duplicate the ledger counted once still shows as rows disagreeing', () => {
    // No provider reference to compare, but the second row has no money behind it.
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 50000, [done(50000, null), done(50000, null)]),
        provider('CAPTURED'),
      ),
    ).toEqual(mismatched('REFUND_ROWS_DISAGREE'));
  });

  it('a failed refund is not money back, and is a mismatch if it was counted', () => {
    const failed = { status: 'FAILED', amountMinor: 50000, providerRef: 'rfnd_f' };
    // Not counted: healthy.
    expect(reconcilePaymentDetailed(our('SUCCEEDED', 0, [failed]), provider('CAPTURED'))).toEqual(
      matched,
    );
    // Counted in refundedMinor as if it had been paid: reported.
    expect(
      reconcilePaymentDetailed(our('PARTIALLY_REFUNDED', 50000, [failed]), provider('CAPTURED')),
    ).toEqual(mismatched('REFUND_ROWS_DISAGREE'));
  });

  it('a refund still processing is not counted as done', () => {
    const processing = { status: 'PROCESSING', amountMinor: 50000, providerRef: 'rfnd_p' };
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 50000, [processing]),
        provider('CAPTURED'),
      ),
    ).toEqual(mismatched('REFUND_ROWS_DISAGREE'));
  });

  it('refund rows that do not add up to refundedMinor are a mismatch', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 100000, [done(60000)]),
        provider('CAPTURED'),
      ),
    ).toEqual(mismatched('REFUND_ROWS_DISAGREE'));
  });

  it('refunding more than was captured is an over-refund', () => {
    expect(
      reconcilePaymentDetailed(
        our('REFUNDED', CAPTURED + 1, [done(CAPTURED + 1)]),
        provider('REFUNDED'),
      ),
    ).toEqual(mismatched('OVER_REFUND'));
    // Refund rows over the capture even though the ledger capped refundedMinor at it.
    expect(
      reconcilePaymentDetailed(
        our('REFUNDED', CAPTURED, [done(CAPTURED), done(1000)]),
        provider('REFUNDED'),
      ),
    ).toEqual(mismatched('OVER_REFUND'));
  });

  it('a negative refundedMinor is reported', () => {
    expect(reconcilePaymentDetailed(our('SUCCEEDED', -1, []), provider('CAPTURED'))).toEqual(
      mismatched('NEGATIVE_REFUND'),
    );
  });

  it('the provider holding a different amount is still a mismatch on a partial refund', () => {
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', 199800, [done(199800)]),
        provider('CAPTURED', CAPTURED - 100),
      ),
    ).toEqual(mismatched('AMOUNT_DIFFERS'));
  });

  it('a status that does not describe the amount refunded is reported', () => {
    // Payment says REFUNDED but part of the capture (the fees) is still held.
    expect(
      reconcilePaymentDetailed(our('REFUNDED', 199800, [done(199800)]), provider('CAPTURED')),
    ).toEqual(mismatched('STATUS_DISAGREES_WITH_REFUNDS'));
    // Payment says partly refunded but nothing went back.
    expect(
      reconcilePaymentDetailed(our('PARTIALLY_REFUNDED', 0, []), provider('CAPTURED')),
    ).toEqual(mismatched('STATUS_DISAGREES_WITH_REFUNDS'));
    // Everything refunded but the payment still says partly.
    expect(
      reconcilePaymentDetailed(
        our('PARTIALLY_REFUNDED', CAPTURED, [done(CAPTURED)]),
        provider('REFUNDED'),
      ),
    ).toEqual(mismatched('STATUS_DISAGREES_WITH_REFUNDS'));
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
    prisma,
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
        refundedMinor: 0,
        booking: { refunds: [] },
      },
      {
        bookingId: 'b2',
        provider: 'stripe',
        providerRef: 'pi_2',
        status: 'SUCCEEDED',
        amountMinor: 2000,
        refundedMinor: 0,
        booking: { refunds: [] },
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
    expect(report.mismatches[0].reason).toBe('PROVIDER_STATUS_DIFFERS');
    expect(metrics.recordReconciliation).toHaveBeenCalledWith(1, 1, 0);
  });

  it('does not report healthy partial refunds, and gives a reason for real mismatches', async () => {
    // The QA shape: buyer refunds that returned the tickets and kept the fees.
    const partial = (bookingId: string, amountMinor: number, refundedMinor: number) => ({
      bookingId,
      provider: 'razorpay',
      providerRef: `pay_${bookingId}`,
      status: 'PARTIALLY_REFUNDED',
      amountMinor,
      refundedMinor,
      booking: {
        refunds: [
          { status: 'COMPLETED', amountMinor: refundedMinor, providerRef: `rfnd_${bookingId}` },
        ],
      },
    });
    const payments = [
      partial('p1', 206922, 199800),
      partial('p2', 155845, 149900),
      partial('p3', 52281, 49900),
      // A real problem: a failed refund counted as money back.
      {
        bookingId: 'bad',
        provider: 'razorpay',
        providerRef: 'pay_bad',
        status: 'PARTIALLY_REFUNDED',
        amountMinor: 52281,
        refundedMinor: 49900,
        booking: { refunds: [{ status: 'FAILED', amountMinor: 49900, providerRef: 'rfnd_bad' }] },
      },
    ];
    const amounts: Record<string, number> = {
      pay_p1: 206922,
      pay_p2: 155845,
      pay_p3: 52281,
      pay_bad: 52281,
    };
    const adapter = {
      getPayment: jest.fn((ref: string) =>
        Promise.resolve({
          providerRef: ref,
          status: 'CAPTURED',
          amountMinor: amounts[ref],
          currency: 'INR',
        }),
      ),
    };
    const { svc, metrics, prisma } = makeService({ payments, adapter });
    const report = await svc.reconcile(...WINDOW);
    expect(report.matched).toBe(3);
    expect(report.mismatched).toBe(1);
    expect(report.mismatches).toEqual([
      {
        bookingId: 'bad',
        provider: 'razorpay',
        providerRef: 'pay_bad',
        ourStatus: 'PARTIALLY_REFUNDED',
        providerStatus: 'CAPTURED',
        ourAmountMinor: 52281,
        providerAmountMinor: 52281,
        ourRefundedMinor: 49900,
        reason: 'REFUND_ROWS_DISAGREE',
      },
    ]);
    expect(metrics.recordReconciliation).toHaveBeenCalledWith(3, 1, 0);
    // The report reads; it never writes a payment or refund row.
    expect(Object.keys(prisma.payment)).toEqual(['findMany']);
  });

  it('marks payments unverifiable when the adapter has no getPayment', async () => {
    const payments = [
      {
        bookingId: 'b1',
        provider: 'razorpay',
        providerRef: 'r1',
        status: 'SUCCEEDED',
        amountMinor: 500,
        refundedMinor: 0,
        booking: { refunds: [] },
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
