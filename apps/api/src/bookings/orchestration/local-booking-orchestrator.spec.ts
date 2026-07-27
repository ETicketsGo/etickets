import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { BookingWorkflowState as WS } from './booking-workflow-state';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { InventoryResolver } from '../../inventory/sourcing/inventory.resolver';
import { InventoryLockService } from '../../inventory/locking/inventory-lock.service';
import { BookingsService } from '../bookings.service';
import { PaymentsService } from '../../payments/payments.service';

function make(
  opts: {
    authority?: 'LOCAL' | 'REMOTE';
    created?: boolean;
    existingBookingId?: string;
    activeLocks?: boolean;
  } = {},
) {
  const provider = {
    name: 'direct',
    sourceKind: 'DIRECT',
    capabilities: { authority: opts.authority ?? 'LOCAL' },
  };
  const resolver = {
    resolve: jest.fn().mockResolvedValue(provider),
  } as unknown as InventoryResolver;
  const locks = {
    acquire: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    getRaw: jest.fn().mockResolvedValue(null),
    markInternal: jest.fn(),
  } as unknown as InventoryLockService;
  const bookings = {
    create: jest.fn().mockResolvedValue({ id: 'b1' }),
    releaseExpiredHolds: jest.fn(),
  } as unknown as BookingsService;
  const payments = {
    createIntent: jest.fn().mockResolvedValue({ provider: 'stripe', clientActionUrl: 'x' }),
    processVerifiedEvent: jest
      .fn()
      .mockResolvedValue({ status: 'confirmed', bookingId: 'b1', tickets: 2 }),
  } as unknown as PaymentsService;
  const baseWf = {
    id: 'wf1',
    bookingId: opts.existingBookingId ?? 'pending-idem1',
    state: WS.DRAFT,
    version: 0,
    inventoryOwnershipMode: 'LOCAL_AUTHORITATIVE',
    selectedProviderCode: 'direct',
    lockId: null,
  };
  const store: Record<string, unknown> = { ...baseWf };
  const workflows = {
    createOrGet: jest
      .fn()
      .mockResolvedValue({ workflow: { ...baseWf }, created: opts.created ?? true }),
    advance: jest.fn(async (wf: Record<string, unknown>, next: string) => {
      Object.assign(store, wf, { state: next });
      return { outcome: 'ADVANCED', workflow: { ...store, state: next } };
    }),
    get: jest.fn(async () => ({ ...store })),
    getByBookingId: jest.fn(async () => ({ ...store })),
    attachBooking: jest.fn().mockResolvedValue(undefined),
  } as unknown as BookingWorkflowRepository;
  const prisma = {
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({ id: 's1', event: { experienceType: 'MOVIE' } }),
    },
    bookingWorkflow: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findUnique: jest.fn() },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((k: string) =>
      k === 'INVENTORY_LOCKS_ENABLED'
        ? !!opts.activeLocks
        : k === 'INVENTORY_LOCKS_MODE'
          ? opts.activeLocks
            ? 'active'
            : 'shadow'
          : undefined,
    ),
  } as unknown as ConfigService;
  const orch = new LocalBookingOrchestrator(
    resolver,
    locks,
    bookings,
    payments,
    workflows,
    prisma,
    config,
    new MetricsService(),
  );
  return { orch, resolver, locks, bookings, payments, workflows, store };
}

const initReq = {
  eventSessionId: 's1',
  items: [{ ticketTypeId: 't1', quantity: 2, seatIds: ['A1', 'A2'] }],
  owner: { ownerId: 'u1' },
  idempotencyKey: 'idem1',
};

describe('LocalBookingOrchestrator.initiate', () => {
  it('resolves a LOCAL provider, creates the hold, reaches LOCKED', async () => {
    const { orch, bookings } = make();
    const res = await orch.initiate(initReq);
    expect(res.bookingId).toBe('b1');
    expect(res.workflowState).toBe(WS.LOCKED);
    expect(res.ownershipMode).toBe('LOCAL_AUTHORITATIVE');
    expect(bookings.create).toHaveBeenCalledTimes(1);
  });

  it('rejects provider-authoritative inventory (not supported in P5.1)', async () => {
    const { orch, bookings } = make({ authority: 'REMOTE' });
    await expect(orch.initiate(initReq)).rejects.toBeInstanceOf(AppException);
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it('is idempotent: a replayed key already bound to a booking returns it without re-creating', async () => {
    const { orch, bookings } = make({ created: false, existingBookingId: 'b1' });
    const res = await orch.initiate(initReq);
    expect(res.bookingId).toBe('b1');
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it('releases the Redis lock when the PostgreSQL hold fails (active mode compensation)', async () => {
    const { orch, locks, bookings } = make({ activeLocks: true });
    (locks.acquire as jest.Mock).mockResolvedValue({ lock: { lockId: 'L1', fencingToken: 3 } });
    (bookings.create as jest.Mock).mockRejectedValue(new Error('hold conflict'));
    await expect(orch.initiate(initReq)).rejects.toThrow('hold conflict');
    expect(locks.release).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: 'L1', fencingToken: 3 }),
    );
  });
});

describe('LocalBookingOrchestrator.beginPayment / confirmPayment', () => {
  it('beginPayment reuses createIntent and advances to PAYMENT_PENDING', async () => {
    const { orch, payments, store } = make();
    store.state = WS.LOCKED;
    const res = await orch.beginPayment({
      bookingId: 'b1',
      owner: { ownerId: 'u1' },
      idempotencyKey: 'p1',
    });
    expect(payments.createIntent).toHaveBeenCalledWith('b1', expect.anything());
    expect(res.workflowState).toBe(WS.PAYMENT_PENDING);
  });

  it('confirmPayment reuses processVerifiedEvent (atomic confirm+outbox) and reaches CONFIRMED', async () => {
    const { orch, payments, store } = make();
    store.state = WS.PAYMENT_PENDING;
    const res = await orch.confirmPayment({
      bookingId: 'b1',
      providerRef: 'pi_1',
      amountMinor: 5000,
    });
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.succeeded', bookingId: 'b1' }),
    );
    expect(res.confirmed).toBe(true);
    expect(res.workflowState).toBe(WS.CONFIRMED);
  });
});
