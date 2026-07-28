import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PaymentProvider } from '../../payments/provider/payment-provider.interface';
import type { TransactionalEventPublisher } from '../../common/domain-events';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentRefundExecutor } from './payment-refund.executor';
import type { DefaultBookingRefundPolicy } from './booking-refund-policy';
import { CompensationType } from './compensation-types';

function make(
  opts: {
    manualReview?: boolean;
    statusRecovery?: boolean;
    paymentStatus?: string;
    bookingStatus?: string;
    eventStatus?: string;
    amountMinor?: number;
    providerRef?: string;
    supportsFullRefund?: boolean;
    supportsIdempotentRefund?: boolean;
    supportsRefundStatusQuery?: boolean;
    refundMayBeAsynchronous?: boolean;
    refund?: { status: string; providerRef?: string } | Error;
    getRefund?: { status: string; providerRef?: string } | null;
  } = {},
) {
  const cfg: Record<string, unknown> = {
    BOOKING_REFUND_POLICY_MODE: 'FULL_GROSS',
    BOOKING_REFUND_STATUS_RECOVERY_ENABLED: opts.statusRecovery ?? true,
  };
  const config = {
    get: jest.fn((k: string, d?: unknown) => cfg[k] ?? d),
  } as unknown as ConfigService;

  const txClient = {
    refund: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'rf1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'b1',
        organizationId: 'o1',
        status: opts.bookingStatus ?? 'CANCELLED',
        currency: 'USD',
        payment: {
          status: opts.paymentStatus ?? 'SUCCEEDED',
          provider: 'mock',
          amountMinor: opts.amountMinor ?? 5000,
          providerRef: opts.providerRef === undefined ? 'pi_mock_1' : opts.providerRef,
        },
        tickets: [{ status: 'ISSUED' }],
        eventSession: { startsAt: new Date('2099-01-01'), status: 'SCHEDULED' },
        event: { status: opts.eventStatus ?? 'CANCELLED' },
      }),
    },
    bookingWorkflow: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(txClient)),
  } as unknown as PrismaService;

  const provider = {
    name: 'mock',
    capabilities: {
      supportsFullRefund: opts.supportsFullRefund ?? true,
      supportsIdempotentRefund: opts.supportsIdempotentRefund ?? true,
      supportsRefundStatusQuery: opts.supportsRefundStatusQuery ?? true,
      refundMayBeAsynchronous: opts.refundMayBeAsynchronous ?? false,
    },
    refund: jest.fn(async () => {
      if (opts.refund instanceof Error) throw opts.refund;
      return {
        providerRef: opts.refund?.providerRef ?? 'mock_rf_1',
        status: opts.refund?.status ?? 'COMPLETED',
        amountMinor: opts.amountMinor ?? 5000,
        currency: 'USD',
      };
    }),
    getRefund: jest.fn(async () =>
      opts.getRefund === undefined
        ? { providerRef: 'mock_rf_1', status: 'COMPLETED', amountMinor: 5000, currency: 'USD' }
        : opts.getRefund,
    ),
  } as unknown as PaymentProvider;

  const publisher = {
    recordInTransaction: jest.fn().mockResolvedValue(0),
    deliverAfterCommit: jest.fn().mockResolvedValue(undefined),
  } as unknown as TransactionalEventPublisher;

  // Policy is unit-tested independently (booking-refund-policy.spec). Here we stub it so the
  // executor's OWN revalidation / intent / finalize-once / recovery logic is what's exercised.
  const amount = opts.amountMinor ?? 5000;
  const policy = {
    mode: 'FULL_GROSS',
    version: 'v1',
    evaluate: jest.fn(() =>
      opts.manualReview
        ? {
            eligible: false,
            refundType: 'MANUAL_REVIEW',
            requiresManualReview: true,
            reasonCode: 'POLICY_MANUAL_ONLY',
            policyVersion: 'FULL_GROSS:v1',
          }
        : {
            eligible: true,
            refundType: 'FULL',
            requiresManualReview: false,
            refundableAmountMinor: amount,
            refundableCurrency: 'USD',
            inventoryResellable: false,
            reasonCode: 'ELIGIBLE_FULL',
            policyVersion: 'FULL_GROSS:v1',
          },
    ),
  } as unknown as DefaultBookingRefundPolicy;
  const exec = new PaymentRefundExecutor(
    prisma,
    provider,
    publisher,
    policy,
    config,
    new MetricsService(),
  );
  const comp = {
    id: 'c1',
    bookingId: 'b1',
    workflowId: 'w1',
    compensationType: CompensationType.PAYMENT_REFUND,
    paymentProvider: 'mock',
    idempotencyKey: 'idem-1',
    reasonCode: 'CANCELLED',
    attemptCount: 1,
  } as never;
  return { exec, comp, provider, publisher, txClient, prisma };
}

const emittedTypes = (publisher: { recordInTransaction: jest.Mock }) =>
  publisher.recordInTransaction.mock.calls.flatMap((c) =>
    (c[1] as Array<{ eventType: string }>).map((e) => e.eventType),
  );

describe('PaymentRefundExecutor — happy path', () => {
  it('refunds a captured payment and finalizes exactly once, intent before the call', async () => {
    const { exec, comp, provider, publisher, txClient } = make();
    expect(await exec.execute(comp)).toBe('REFUNDED');
    expect(provider.refund).toHaveBeenCalledTimes(1);
    expect(txClient.payment.updateMany).toHaveBeenCalledTimes(1); // guarded finalize once
    const types = emittedTypes(publisher as never);
    expect(types).toContain('booking.payment_refund_requested'); // intent before call
    expect(types).toContain('booking.payment_refunded');
  });

  it('refund amount never exceeds captured and currency is unchanged', async () => {
    const { exec, comp, provider } = make({ amountMinor: 5000 });
    await exec.execute(comp);
    const call = (provider.refund as jest.Mock).mock.calls[0][0];
    expect(call.amountMinor).toBe(5000);
    expect(call.currency).toBe('USD');
  });
});

describe('PaymentRefundExecutor — eligibility gates', () => {
  it('a manual-review policy decision never calls the provider', async () => {
    const { exec, comp, provider } = make({ manualReview: true });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('treats an already-REFUNDED payment as idempotent success without calling the provider', async () => {
    const { exec, comp, provider } = make({ paymentStatus: 'REFUNDED' });
    expect(await exec.execute(comp)).toBe('REFUNDED');
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('refuses when the payment is not captured', async () => {
    const { exec, comp, provider } = make({ paymentStatus: 'AUTHORIZED' });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('refuses a provider that is not idempotent-refund-capable', async () => {
    const { exec, comp, provider } = make({ supportsIdempotentRefund: false });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('refuses when the payment reference is missing', async () => {
    const { exec, comp, provider } = make({ providerRef: '' });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.refund).not.toHaveBeenCalled();
  });
});

describe('PaymentRefundExecutor — outcome handling', () => {
  it('rejects (manual review) when the provider reports FAILED', async () => {
    const { exec, comp, publisher } = make({ refund: { status: 'FAILED' } });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(emittedTypes(publisher as never)).toContain('booking.payment_refund_rejected');
  });

  it('async provider ack is only PENDING until confirmed → recovers to REFUNDED', async () => {
    const { exec, comp, provider, publisher } = make({
      refundMayBeAsynchronous: true,
      getRefund: { status: 'COMPLETED', providerRef: 'mock_rf_async' },
    });
    expect(await exec.execute(comp)).toBe('REFUNDED');
    expect(provider.getRefund).toHaveBeenCalledTimes(1);
    expect(emittedTypes(publisher as never)).toContain('booking.payment_refund_pending');
  });

  it('ambiguous (provider throws) recovers via status query — never assumes success', async () => {
    const { exec, comp, provider, publisher } = make({
      refund: new Error('timeout'),
      getRefund: { status: 'COMPLETED' },
    });
    expect(await exec.execute(comp)).toBe('REFUNDED');
    expect(provider.getRefund).toHaveBeenCalledTimes(1);
    expect(emittedTypes(publisher as never)).toContain('booking.payment_refund_ambiguous');
  });

  it('ambiguous + status recovery disabled → manual review (never assumes success)', async () => {
    const { exec, comp } = make({ refund: new Error('timeout'), statusRecovery: false });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
  });

  it('ambiguous + status still unknown → manual review', async () => {
    const { exec, comp } = make({ refund: new Error('timeout'), getRefund: null });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
  });
});
