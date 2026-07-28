import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { BookingsService } from '../bookings.service';
import { PaymentsService } from '../../payments/payments.service';
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { BookingExecutionRouter } from './booking-execution-router.service';
import { AnonymousSessionService, BookingOwnerResolver } from './booking-owner';
import { BookingWorkflowState as WS } from './booking-workflow-state';

function make(mode: 'disabled' | 'shadow' | 'active') {
  const config = {
    get: jest.fn((k: string, d?: unknown) => {
      if (k === 'BOOKING_ORCHESTRATOR_ENABLED') return mode !== 'disabled';
      if (k === 'BOOKING_ORCHESTRATOR_MODE') return mode === 'active' ? 'active' : 'shadow';
      if (k === 'INVENTORY_SOURCING_ENABLED') return true;
      return d;
    }),
  } as unknown as ConfigService;
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'b1',
        status: 'PENDING_PAYMENT',
        currency: 'USD',
        holdExpiresAt: new Date(),
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        discountMinor: 0,
        customerFeeMinor: 0,
        organizerFeeMinor: 0,
        totalMinor: 5000,
        payment: { id: 'p1', status: 'REQUIRES_PAYMENT' },
      }),
    },
    bookingWorkflow: { count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  const bookings = {
    create: jest.fn().mockResolvedValue({ id: 'legacy-b', status: 'PENDING_PAYMENT' }),
    getForUser: jest.fn().mockResolvedValue({ id: 'b1', status: 'PENDING_PAYMENT' }),
  } as unknown as BookingsService;
  const payments = {
    createIntent: jest.fn().mockResolvedValue({ provider: 'mock', clientActionUrl: 'x' }),
  } as unknown as PaymentsService;
  const orchestrator = {
    initiate: jest.fn().mockResolvedValue({
      bookingId: 'b1',
      workflowState: WS.LOCKED,
      ownershipMode: 'LOCAL_AUTHORITATIVE',
    }),
    beginPayment: jest.fn().mockResolvedValue({
      bookingId: 'b1',
      workflowState: WS.PAYMENT_PENDING,
      payment: { provider: 'mock' },
    }),
    cancel: jest
      .fn()
      .mockResolvedValue({ bookingId: 'b1', workflowState: WS.CANCELLED, refundPending: false }),
  } as unknown as LocalBookingOrchestrator;
  const anon = new AnonymousSessionService();
  const owners = new BookingOwnerResolver(anon);
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const router = new BookingExecutionRouter(
    config,
    prisma,
    new MetricsService(),
    audit,
    bookings,
    payments,
    orchestrator,
    owners,
    anon,
  );
  return { router, bookings, payments, orchestrator, anon };
}

const body = {
  eventSessionId: 's1',
  items: [{ ticketTypeId: 't1', quantity: 2, seatIds: ['A1', 'A2'] }],
} as never;
const user = { id: 'u1', email: '', fullName: '', roles: [] };

describe('BookingExecutionRouter.mode', () => {
  it('reports the single mode from the flags', () => {
    expect(make('disabled').router.mode()).toBe('disabled');
    expect(make('shadow').router.mode()).toBe('shadow');
    expect(make('active').router.mode()).toBe('active');
  });
});

describe('BookingExecutionRouter.initiate', () => {
  it('disabled + shadow use the legacy BookingsService and never the orchestrator', async () => {
    for (const mode of ['disabled', 'shadow'] as const) {
      const { router, bookings, orchestrator } = make(mode);
      await router.initiate({ user, body });
      expect(bookings.create).toHaveBeenCalledTimes(1);
      expect(orchestrator.initiate).not.toHaveBeenCalled();
    }
  });

  it('active routes through the orchestrator and returns the existing response shape', async () => {
    const { router, orchestrator, bookings } = make('active');
    const res = (await router.initiate({ user, body })) as Record<string, unknown>;
    expect(orchestrator.initiate).toHaveBeenCalledTimes(1);
    expect(bookings.create).not.toHaveBeenCalled();
    // Existing public shape preserved (id/status/currency/fees/payment); no workflow state.
    expect(res.id).toBe('b1');
    expect(res.status).toBe('PENDING_PAYMENT');
    expect(res).toHaveProperty('fees');
    expect(res).not.toHaveProperty('workflowState');
  });

  it('active guest checkout mints and returns a one-time anonymous session token', async () => {
    const { router, orchestrator } = make('active');
    const res = (await router.initiate({ user: null, body })) as Record<string, unknown>;
    expect(res.anonymousSessionToken).toBeDefined();
    // The orchestrator received an ANONYMOUS_SESSION owner with a hashed id (not the token).
    const arg = (orchestrator.initiate as jest.Mock).mock.calls[0][0];
    expect(arg.requestOwner.ownerType).toBe('ANONYMOUS_SESSION');
    expect(arg.requestOwner.ownerId).not.toEqual(res.anonymousSessionToken);
  });
});

describe('BookingExecutionRouter.beginPayment / cancel / status', () => {
  it('disabled uses legacy createIntent', async () => {
    const { router, payments } = make('disabled');
    await router.beginPayment({ user, bookingId: 'b1' });
    expect(payments.createIntent).toHaveBeenCalledWith('b1', user);
  });

  it('active beginPayment routes through the orchestrator with a resolved owner', async () => {
    const { router, orchestrator } = make('active');
    await router.beginPayment({ user, bookingId: 'b1' });
    const arg = (orchestrator.beginPayment as jest.Mock).mock.calls[0][0];
    expect(arg.requestOwner).toEqual({ ownerType: 'USER', ownerId: 'u1' });
  });

  it('cancel is rejected in disabled/shadow (no legacy cancel endpoint) and coordinated in active', async () => {
    await expect(make('shadow').router.cancel({ user, bookingId: 'b1' })).rejects.toBeInstanceOf(
      AppException,
    );
    const { router, orchestrator } = make('active');
    const res = (await router.cancel({ user, bookingId: 'b1' })) as Record<string, unknown>;
    expect(orchestrator.cancel).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('CANCELLED');
  });

  it('status requires an authenticated principal and preserves the owner-checked contract', async () => {
    const { router, bookings } = make('active');
    await expect(router.getStatus({ user: null, bookingId: 'b1' })).rejects.toBeInstanceOf(
      AppException,
    );
    await router.getStatus({ user, bookingId: 'b1' });
    expect(bookings.getForUser).toHaveBeenCalledWith(user, 'b1');
  });
});
