import type { ConfigService } from '@nestjs/config';
import type { InventoryLockService } from '../../inventory/locking/inventory-lock.service';
import type { BookingConfirmationBridge } from '../orchestration/booking-confirmation-bridge';
import { MetricsService } from '../../metrics/metrics.service';
import { CompensationService } from './compensation.service';
import { CompensationPlanner } from './compensation-planner';
import { CompensationRepository } from './compensation.repository';
import { CompensationState } from './compensation-state';
import { CompensationType } from './compensation-types';

function make(
  opts: {
    flags?: Record<string, boolean>;
    cancelOutcome?: string;
    voidOutcome?: string;
    refundOutcome?: string;
    compType?: CompensationType;
  } = {},
) {
  const flags = {
    BOOKING_COMPENSATION_ENABLED: true,
    BOOKING_COMPENSATION_PLANNING_ENABLED: true,
    BOOKING_COMPENSATION_EXECUTION_ENABLED: true,
    BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED: true,
    BOOKING_COMPENSATION_AUTO_VOID_ENABLED: true,
    BOOKING_COMPENSATION_AUTO_REFUND_ENABLED: true,
    ...(opts.flags ?? {}),
  };
  const comp = {
    id: 'c1',
    bookingId: 'b1',
    compensationType: opts.compType ?? CompensationType.PROVIDER_RESERVATION_CANCEL,
    state: CompensationState.READY,
    attemptCount: 1,
    maxAttempts: 5,
  };
  const advance = jest.fn().mockResolvedValue(comp);
  const scheduleRetryOrDeadLetter = jest.fn().mockResolvedValue(comp);
  const repo = {
    recoverStaleLeases: jest.fn().mockResolvedValue(0),
    claimReady: jest.fn().mockResolvedValue([comp]),
    advance,
    scheduleRetryOrDeadLetter,
  } as unknown as CompensationRepository;
  const config = {
    get: jest.fn((k: string) => (flags as Record<string, boolean>)[k] ?? false),
  } as unknown as ConfigService;
  const bridge = {
    cancelProviderReservation: jest.fn().mockResolvedValue(opts.cancelOutcome ?? 'CANCELLED'),
  } as unknown as BookingConfirmationBridge;
  const locks = { getRaw: jest.fn(), markInternal: jest.fn() } as unknown as InventoryLockService;
  const voidExecutor = {
    execute: jest.fn().mockResolvedValue(opts.voidOutcome ?? 'VOIDED'),
  } as never;
  const refundExecutor = {
    execute: jest.fn().mockResolvedValue(opts.refundOutcome ?? 'REFUNDED'),
  } as never;
  const svc = new CompensationService(
    new CompensationPlanner(),
    repo,
    locks,
    config,
    new MetricsService(),
    bridge,
    voidExecutor,
    refundExecutor,
  );
  return { svc, bridge, advance, scheduleRetryOrDeadLetter, voidExecutor, refundExecutor };
}

describe('CompensationService — Phase 4 provider reservation cancellation dispatch', () => {
  it('executes a provider reservation cancel and completes on CANCELLED', async () => {
    const { svc, bridge, advance } = make({ cancelOutcome: 'CANCELLED' });
    const res = await svc.processReady('w1');
    expect(bridge.cancelProviderReservation).toHaveBeenCalledWith('b1');
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.COMPLETED,
      expect.anything(),
    );
    expect(res.completed).toBe(1);
  });

  it('schedules a retry when the provider cancellation is RETRYABLE', async () => {
    const { svc, scheduleRetryOrDeadLetter } = make({ cancelOutcome: 'RETRYABLE' });
    await svc.processReady('w1');
    expect(scheduleRetryOrDeadLetter).toHaveBeenCalled();
  });

  it('moves to MANUAL_REVIEW on an uncertain provider outcome', async () => {
    const { svc, advance } = make({ cancelOutcome: 'MANUAL_REVIEW' });
    await svc.processReady('w1');
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.MANUAL_REVIEW,
      expect.anything(),
    );
  });

  it('does NOT execute provider cancellation when its flag is off (→ manual review)', async () => {
    const { svc, bridge, advance } = make({
      flags: { BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED: false },
    });
    await svc.processReady('w1');
    expect(bridge.cancelProviderReservation).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.MANUAL_REVIEW,
      expect.objectContaining({ manualReviewReason: 'AUTO_PROVIDER_CANCEL_DISABLED' }),
    );
  });

  it('is a no-op when execution is disabled', async () => {
    const { svc, bridge } = make({ flags: { BOOKING_COMPENSATION_EXECUTION_ENABLED: false } });
    const res = await svc.processReady('w1');
    expect(res).toEqual({ claimed: 0, completed: 0 });
    expect(bridge.cancelProviderReservation).not.toHaveBeenCalled();
  });
});

describe('CompensationService — Phase 5 payment void dispatch', () => {
  it('executes a void and completes on VOIDED', async () => {
    const { svc, voidExecutor, advance } = make({
      compType: CompensationType.PAYMENT_VOID,
      voidOutcome: 'VOIDED',
    });
    const res = await svc.processReady('w1');
    expect((voidExecutor as never as { execute: jest.Mock }).execute).toHaveBeenCalled();
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.COMPLETED,
      expect.anything(),
    );
    expect(res.completed).toBe(1);
  });

  it('supersedes the void (→ CANCELLED) when the payment is captured', async () => {
    const { svc, advance } = make({
      compType: CompensationType.PAYMENT_VOID,
      voidOutcome: 'SUPERSEDED_BY_REFUND',
    });
    await svc.processReady('w1');
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.CANCELLED,
      expect.objectContaining({ manualReviewReason: 'SUPERSEDED_BY_REFUND' }),
    );
  });

  it('retries on RETRYABLE and manual-reviews on an uncertain outcome', async () => {
    const retry = make({ compType: CompensationType.PAYMENT_VOID, voidOutcome: 'RETRYABLE' });
    await retry.svc.processReady('w1');
    expect(retry.scheduleRetryOrDeadLetter).toHaveBeenCalled();
    const review = make({ compType: CompensationType.PAYMENT_VOID, voidOutcome: 'MANUAL_REVIEW' });
    await review.svc.processReady('w1');
    expect(review.advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.MANUAL_REVIEW,
      expect.anything(),
    );
  });

  it('does NOT execute void when auto-void is off (→ manual review, executor untouched)', async () => {
    const { svc, voidExecutor, advance } = make({
      compType: CompensationType.PAYMENT_VOID,
      flags: { BOOKING_COMPENSATION_AUTO_VOID_ENABLED: false },
    });
    await svc.processReady('w1');
    expect((voidExecutor as never as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.MANUAL_REVIEW,
      expect.objectContaining({ manualReviewReason: 'AUTO_VOID_DISABLED' }),
    );
  });
});

describe('CompensationService — Phase 6 payment refund dispatch', () => {
  it('executes a refund and completes on REFUNDED', async () => {
    const { svc, refundExecutor, advance } = make({
      compType: CompensationType.PAYMENT_REFUND,
      refundOutcome: 'REFUNDED',
    });
    const res = await svc.processReady('w1');
    expect((refundExecutor as never as { execute: jest.Mock }).execute).toHaveBeenCalled();
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.COMPLETED,
      expect.anything(),
    );
    expect(res.completed).toBe(1);
  });

  it('schedules a retry when the refund is PENDING or RETRYABLE', async () => {
    for (const outcome of ['PENDING', 'RETRYABLE']) {
      const { svc, scheduleRetryOrDeadLetter } = make({
        compType: CompensationType.PAYMENT_REFUND,
        refundOutcome: outcome,
      });
      await svc.processReady('w1');
      expect(scheduleRetryOrDeadLetter).toHaveBeenCalled();
    }
  });

  it('moves to MANUAL_REVIEW on an uncertain refund outcome', async () => {
    const { svc, advance } = make({
      compType: CompensationType.PAYMENT_REFUND,
      refundOutcome: 'MANUAL_REVIEW',
    });
    await svc.processReady('w1');
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.MANUAL_REVIEW,
      expect.anything(),
    );
  });

  it('does NOT execute a refund when auto-refund is off (→ manual review, executor untouched)', async () => {
    const { svc, refundExecutor, advance } = make({
      compType: CompensationType.PAYMENT_REFUND,
      flags: { BOOKING_COMPENSATION_AUTO_REFUND_ENABLED: false },
    });
    await svc.processReady('w1');
    expect((refundExecutor as never as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      CompensationState.MANUAL_REVIEW,
      expect.objectContaining({ manualReviewReason: 'AUTO_REFUND_DISABLED' }),
    );
  });
});
