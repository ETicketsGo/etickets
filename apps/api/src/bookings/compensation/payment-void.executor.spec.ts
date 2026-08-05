import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PaymentProvider } from '../../payments/provider/payment-provider.interface';
import type { TransactionalEventPublisher } from '../../common/domain-events';
import type { CompensationRepository } from './compensation.repository';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentVoidExecutor } from './payment-void.executor';
import { CompensationType } from './compensation-types';

function make(
  opts: {
    paymentStatus?: string;
    bookingStatus?: string;
    ticketed?: boolean;
    supportsVoid?: boolean;
    cancel?: { status: string } | Error;
    getPayment?: { status: string };
    amountMinor?: number;
    compAmount?: number | null;
  } = {},
) {
  const txClient = { payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'b1',
        status: opts.bookingStatus ?? 'PENDING_PAYMENT',
        currency: 'USD',
        payment: {
          status: opts.paymentStatus ?? 'AUTHORIZED',
          amountMinor: opts.amountMinor ?? 5000,
          providerRef: 'pi_mock_1',
        },
        tickets: opts.ticketed ? [{ id: 't1' }] : [],
      }),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(txClient)),
  } as unknown as PrismaService;
  const provider = {
    name: 'mock',
    capabilities: {
      supportsAuthorizeCapture: true,
      supportsVoid: opts.supportsVoid ?? true,
      supportsIdempotentVoid: opts.supportsVoid ?? true,
      supportsPaymentStatusQuery: true,
    },
    cancel: jest.fn(async () => {
      if (opts.cancel instanceof Error) throw opts.cancel;
      return {
        providerRef: 'pi_mock_1',
        status: opts.cancel?.status ?? 'CANCELLED',
        amountMinor: 5000,
        currency: 'USD',
      };
    }),
    getPayment: jest.fn().mockResolvedValue({
      providerRef: 'pi_mock_1',
      status: opts.getPayment?.status ?? 'CANCELLED',
      amountMinor: 5000,
      currency: 'USD',
    }),
  } as unknown as PaymentProvider;
  const publisher = {
    recordInTransaction: jest.fn().mockResolvedValue(0),
    deliverAfterCommit: jest.fn().mockResolvedValue(undefined),
  } as unknown as TransactionalEventPublisher;
  const createOrGet = jest.fn().mockResolvedValue({ compensation: { id: 'r1' }, created: true });
  const repo = { createOrGet } as unknown as CompensationRepository;
  const config = { get: jest.fn(() => true) } as unknown as ConfigService;
  const exec = new PaymentVoidExecutor(
    prisma,
    provider,
    publisher,
    repo,
    config,
    new MetricsService(),
  );
  const comp = {
    id: 'c1',
    bookingId: 'b1',
    compensationType: CompensationType.PAYMENT_VOID,
    paymentReference: 'pi_mock_1',
    paymentProvider: 'mock',
    amountMinor: opts.compAmount === undefined ? null : opts.compAmount,
    currency: null,
    attemptCount: 1,
    reasonCode: 'X',
  } as never;
  return { exec, comp, provider, publisher, txClient, createOrGet };
}

const emittedTypes = (publisher: { recordInTransaction: jest.Mock }) =>
  publisher.recordInTransaction.mock.calls.flatMap((c) =>
    (c[1] as Array<{ eventType: string }>).map((e) => e.eventType),
  );

describe('PaymentVoidExecutor — eligibility gate', () => {
  it('voids an AUTHORIZED-not-captured payment and finalizes exactly once', async () => {
    const { exec, comp, provider, publisher, txClient } = make({ paymentStatus: 'AUTHORIZED' });
    const outcome = await exec.execute(comp);
    expect(outcome).toBe('VOIDED');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(txClient.payment.updateMany).toHaveBeenCalledTimes(1); // guarded finalize once
    const types = emittedTypes(publisher as never);
    expect(types).toContain('booking.payment_void_requested'); // intent before call
    expect(types).toContain('booking.payment_voided');
  });

  it('NEVER voids a captured payment — hands off to one refund plan', async () => {
    const { exec, comp, provider, createOrGet } = make({ paymentStatus: 'SUCCEEDED' });
    const outcome = await exec.execute(comp);
    expect(outcome).toBe('SUPERSEDED_BY_REFUND');
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(createOrGet).toHaveBeenCalledTimes(1);
    expect(createOrGet.mock.calls[0][0].compensationType).toBe(CompensationType.PAYMENT_REFUND);
  });

  it('never auto-voids a confirmed booking', async () => {
    const { exec, comp, provider } = make({ bookingStatus: 'CONFIRMED' });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it('never auto-voids a ticket-issued booking', async () => {
    const { exec, comp, provider } = make({ ticketed: true });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it('refuses a provider that is not void-capable', async () => {
    const { exec, comp, provider } = make({ supportsVoid: false });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it('refuses on an amount mismatch', async () => {
    const { exec, comp, provider } = make({ amountMinor: 5000, compAmount: 9999 });
    expect(await exec.execute(comp)).toBe('MANUAL_REVIEW');
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it('treats an already-VOIDED payment as idempotent success without calling the provider', async () => {
    const { exec, comp, provider } = make({ paymentStatus: 'VOIDED' });
    expect(await exec.execute(comp)).toBe('VOIDED');
    expect(provider.cancel).not.toHaveBeenCalled();
  });
});

describe('PaymentVoidExecutor — ambiguous recovery', () => {
  it('void-response-lost recovers via status query to VOIDED (no double financial action)', async () => {
    const { exec, comp, provider } = make({
      cancel: new Error('timeout'),
      getPayment: { status: 'CANCELLED' },
    });
    const outcome = await exec.execute(comp);
    expect(outcome).toBe('VOIDED');
    expect(provider.getPayment).toHaveBeenCalledTimes(1);
  });

  it('ambiguous + still AUTHORIZED → RETRYABLE (safe to retry the idempotent void)', async () => {
    const { exec, comp } = make({
      cancel: new Error('timeout'),
      getPayment: { status: 'AUTHORIZED' },
    });
    expect(await exec.execute(comp)).toBe('RETRYABLE');
  });

  it('ambiguous + status CAPTURED → refund handoff, never a void completion', async () => {
    const { exec, comp } = make({
      cancel: new Error('timeout'),
      getPayment: { status: 'CAPTURED' },
    });
    expect(await exec.execute(comp)).toBe('SUPERSEDED_BY_REFUND');
  });
});
