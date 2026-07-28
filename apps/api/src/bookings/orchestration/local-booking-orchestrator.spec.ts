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
import { AnonymousSessionService, BookingOwnerResolver } from './booking-owner';

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
  const owners = new BookingOwnerResolver(new AnonymousSessionService());
  const bridge = { register: () => undefined, onConfirmed: async () => undefined } as never;
  const orch = new LocalBookingOrchestrator(
    resolver,
    locks,
    bookings,
    payments,
    workflows,
    prisma,
    config,
    new MetricsService(),
    owners,
    bridge,
  );
  return { orch, resolver, locks, bookings, payments, workflows, prisma, store };
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

describe('LocalBookingOrchestrator durable ownership', () => {
  it('beginPayment rejects a different owner even with a valid bookingId', async () => {
    const { orch, store, payments } = make();
    store.state = WS.LOCKED;
    store.ownerType = 'USER';
    store.ownerId = 'ownerA';
    await expect(
      orch.beginPayment({
        bookingId: 'b1',
        owner: { ownerId: 'ownerB' },
        requestOwner: { ownerType: 'USER', ownerId: 'ownerB' },
        idempotencyKey: 'b1',
      }),
    ).rejects.toBeInstanceOf(AppException);
    expect(payments.createIntent).not.toHaveBeenCalled();
  });

  it('cancel rejects a foreign anonymous session (before use)', async () => {
    const { orch, store } = make();
    store.state = WS.LOCKED;
    store.ownerType = 'ANONYMOUS_SESSION';
    store.ownerId = 'sessionHashA';
    await expect(
      orch.cancel({
        bookingId: 'b1',
        owner: { anonymousSessionId: 'sessionHashB' },
        requestOwner: { ownerType: 'ANONYMOUS_SESSION', ownerId: 'sessionHashB' },
      }),
    ).rejects.toBeInstanceOf(AppException);
  });
});

describe('LocalBookingOrchestrator.sweepExpiredWorkflows (worker expiration, P5.2B)', () => {
  it('advances only workflows whose booking PostgreSQL status is already EXPIRED', async () => {
    const { orch, prisma } = make();
    (prisma.bookingWorkflow.findMany as jest.Mock).mockResolvedValue([{ bookingId: 'b1' }]);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ status: 'EXPIRED' });
    const spy = jest
      .spyOn(orch, 'expire')
      .mockResolvedValue({ bookingId: 'b1', workflowState: WS.EXPIRED });
    const res = await orch.sweepExpiredWorkflows();
    expect(res).toEqual({ scanned: 1, expired: 1 });
    expect(spy).toHaveBeenCalledWith({ bookingId: 'b1' });
  });

  it('never expires a booking the authoritative sweep did not expire (e.g. still confirmed/pending)', async () => {
    const { orch, prisma } = make();
    (prisma.bookingWorkflow.findMany as jest.Mock).mockResolvedValue([{ bookingId: 'b1' }]);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ status: 'CONFIRMED' });
    const spy = jest.spyOn(orch, 'expire');
    const res = await orch.sweepExpiredWorkflows();
    expect(res).toEqual({ scanned: 1, expired: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no active-mode workflows', async () => {
    const { orch, prisma } = make();
    (prisma.bookingWorkflow.findMany as jest.Mock).mockResolvedValue([]);
    const res = await orch.sweepExpiredWorkflows();
    expect(res).toEqual({ scanned: 0, expired: 0 });
  });

  it('a per-workflow transition failure is swallowed and left reconcilable', async () => {
    const { orch, prisma } = make();
    (prisma.bookingWorkflow.findMany as jest.Mock).mockResolvedValue([{ bookingId: 'b1' }]);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ status: 'EXPIRED' });
    jest.spyOn(orch, 'expire').mockRejectedValue(new Error('workflow conflict'));
    const res = await orch.sweepExpiredWorkflows();
    expect(res).toEqual({ scanned: 1, expired: 0 });
  });
});
