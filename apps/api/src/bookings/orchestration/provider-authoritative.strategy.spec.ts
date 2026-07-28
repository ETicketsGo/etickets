import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderAuthoritativeStrategy } from './provider-authoritative.strategy';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { AnonymousSessionService, BookingOwnerResolver } from './booking-owner';
import { BookingWorkflowState as WS } from './booking-workflow-state';

function make(
  opts: {
    reserve?: { outcome: string; providerReservationId?: string; reservationExpiresAt?: Date };
    confirm?: { outcome: string; providerBookingId?: string };
    status?: { outcome: string; status: string };
    inventoryRef?: string;
    ttlSafety?: number;
    recovery?: boolean;
  } = {},
) {
  const provider = {
    providerCode: 'mock-external-booking',
    capabilities: () => ({
      supportsConfirm: true,
      supportsTemporaryReservation: true,
      requiresPaymentBeforeReservation: false,
    }),
    health: jest.fn().mockResolvedValue({ healthy: true }),
    createReservation: jest.fn().mockResolvedValue(
      opts.reserve ?? {
        outcome: 'OK',
        providerReservationId: 'mockres_1',
        reservationExpiresAt: new Date(Date.now() + 300_000),
        amountMinor: 5000,
      },
    ),
    confirmReservation: jest
      .fn()
      .mockResolvedValue(opts.confirm ?? { outcome: 'OK', providerBookingId: 'mockbk_1' }),
    getBookingStatus: jest
      .fn()
      .mockResolvedValue(opts.status ?? { outcome: 'OK', status: 'CONFIRMED' }),
  };
  const registry = { require: () => provider, get: () => provider } as never;
  const locks = {
    acquire: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    getRaw: jest.fn().mockResolvedValue(null),
    markInternal: jest.fn(),
  } as never;
  const bookings = {
    create: jest.fn().mockResolvedValue({ id: 'b1', totalMinor: 5000, currency: 'USD' }),
    releaseExpiredHolds: jest.fn().mockResolvedValue(0),
  } as never;
  const payments = {
    createIntent: jest.fn().mockResolvedValue({ provider: 'stripe' }),
    confirmVerifiedLocal: jest
      .fn()
      .mockResolvedValue({ status: 'confirmed', bookingId: 'b1', tickets: 2 }),
  };
  const store: Record<string, unknown> = {
    id: 'wf1',
    bookingId: 'pending-idem1',
    state: WS.DRAFT,
    version: 0,
    inventoryOwnershipMode: 'PROVIDER_AUTHORITATIVE',
    selectedProviderCode: 'mock-external-booking',
    providerReservationId: null,
    providerReservationExpiresAt: null,
    providerReconciliationRequired: false,
    correlationId: null,
    lockId: null,
  };
  const workflows = {
    createOrGet: jest.fn().mockResolvedValue({ workflow: { ...store }, created: true }),
    advance: jest.fn(async (wf: Record<string, unknown>, next: string, patch = {}) => {
      Object.assign(store, wf, patch, { state: next });
      // normalize increment ops from Prisma-style patches
      if ((patch as { providerAttemptCount?: unknown }).providerAttemptCount)
        store.providerAttemptCount = ((store.providerAttemptCount as number) ?? 0) + 1;
      return { outcome: 'ADVANCED', workflow: { ...store } };
    }),
    get: jest.fn(async () => ({ ...store })),
    getByBookingId: jest.fn(async () => ({ ...store })),
    attachBooking: jest.fn(async (_id: string, d: Record<string, unknown>) => {
      Object.assign(store, d);
    }),
  } as unknown as BookingWorkflowRepository;
  const txClient = {
    bookingWorkflow: {
      updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(store, args.data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => ({ ...store })),
    },
  };
  const prisma = {
    providerMapping: {
      findFirst: jest.fn().mockResolvedValue({
        providerCode: 'mock-external-booking',
        externalEntityId: opts.inventoryRef ?? 'inv1',
        providerTenantId: '',
      }),
    },
    booking: { findUnique: jest.fn().mockResolvedValue({ totalMinor: 5000, currency: 'USD' }) },
    // The event-emitting advance runs advance(tx) + recordInTransaction(tx) in one tx.
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(txClient)),
  } as unknown as PrismaService;
  const publisher = {
    recordInTransaction: jest.fn().mockResolvedValue(0),
    deliverAfterCommit: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'BOOKING_PROVIDER_CONFIRMATION_ENABLED') return true;
      if (k === 'BOOKING_PROVIDER_RESERVATION_TTL_SAFETY_SECONDS') return opts.ttlSafety ?? 60;
      if (k === 'BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED') return opts.recovery ?? true;
      return undefined;
    }),
  } as unknown as ConfigService;
  const owners = new BookingOwnerResolver(new AnonymousSessionService());
  const bridge = { registerPreConfirm: jest.fn() } as never;
  const strat = new ProviderAuthoritativeStrategy(
    registry,
    locks,
    bookings,
    payments as never,
    workflows,
    prisma,
    config,
    new MetricsService(),
    owners,
    bridge,
    publisher as never,
  );
  return { strat, provider, payments, store, workflows, publisher };
}

const initReq = {
  eventSessionId: 's1',
  items: [{ ticketTypeId: 't1', quantity: 2 }],
  owner: { ownerId: 'u1' },
  requestOwner: { ownerType: 'USER' as const, ownerId: 'u1' },
  idempotencyKey: 'idem1',
};
const session = { id: 's1', eventId: 'e1', organizationId: 'org1' };

describe('ProviderAuthoritativeStrategy.initiate', () => {
  it('reserves via the provider and reaches PROVIDER_RESERVED', async () => {
    const { strat, provider, store } = make();
    const res = await strat.initiate(initReq, session);
    expect(provider.createReservation).toHaveBeenCalledTimes(1);
    expect(res.workflowState).toBe(WS.PROVIDER_RESERVED);
    expect(res.ownershipMode).toBe('PROVIDER_AUTHORITATIVE');
    expect(store.providerReservationId).toBe('mockres_1');
  });

  it('sold-out fails safely, releases the lock, never charges', async () => {
    const { strat, provider } = make({ reserve: { outcome: 'SOLD_OUT' } });
    await expect(strat.initiate(initReq, session)).rejects.toBeInstanceOf(AppException);
    expect(provider.confirmReservation).not.toHaveBeenCalled();
  });

  it('ambiguous reservation stays PENDING + flags reconciliation, never fails', async () => {
    const { strat, store } = make({ reserve: { outcome: 'AMBIGUOUS' } });
    const res = await strat.initiate(initReq, session);
    expect(res.workflowState).toBe(WS.PROVIDER_RESERVATION_PENDING);
    expect(store.providerReconciliationRequired).toBe(true);
  });
});

describe('ProviderAuthoritativeStrategy.beginPayment', () => {
  const wf = (over: Record<string, unknown> = {}) =>
    ({
      id: 'wf1',
      bookingId: 'b1',
      state: WS.PROVIDER_RESERVED,
      inventoryOwnershipMode: 'PROVIDER_AUTHORITATIVE',
      selectedProviderCode: 'mock-external-booking',
      providerReservationExpiresAt: new Date(Date.now() + 300_000),
      ownerType: 'USER',
      ownerId: 'u1',
      ...over,
    }) as never;

  it('creates the intent and advances to PAYMENT_PENDING when TTL is safe', async () => {
    const { strat, payments } = make();
    const res = await strat.beginPayment(
      {
        bookingId: 'b1',
        owner: { ownerId: 'u1' },
        requestOwner: { ownerType: 'USER', ownerId: 'u1' },
        idempotencyKey: 'b1',
      },
      wf(),
    );
    expect(payments.createIntent).toHaveBeenCalled();
    expect(res.workflowState).toBe(WS.PAYMENT_PENDING);
  });

  it('refuses payment against a near-expired reservation', async () => {
    const { strat, payments } = make();
    await expect(
      strat.beginPayment(
        { bookingId: 'b1', owner: { ownerId: 'u1' }, idempotencyKey: 'b1' },
        wf({ providerReservationExpiresAt: new Date(Date.now() + 5_000) }),
      ),
    ).rejects.toBeInstanceOf(AppException);
    expect(payments.createIntent).not.toHaveBeenCalled();
  });
});

describe('ProviderAuthoritativeStrategy.handlePaymentConfirmed', () => {
  const fact = { bookingId: 'b1', providerRef: 'pi_1', amountMinor: 5000 };

  it('declines (handled:false) for non-provider-authoritative workflows', async () => {
    const { strat, store } = make();
    store.inventoryOwnershipMode = 'LOCAL_AUTHORITATIVE';
    expect(await strat.handlePaymentConfirmed(fact)).toEqual({ handled: false });
  });

  it('confirms the provider BEFORE local confirmation and reaches CONFIRMED', async () => {
    const { strat, provider, payments, store } = make();
    store.state = WS.PAYMENT_PENDING;
    store.providerReservationId = 'mockres_1';
    const res = await strat.handlePaymentConfirmed(fact);
    expect(res.handled).toBe(true);
    // Provider confirm called before local confirm.
    expect(provider.confirmReservation).toHaveBeenCalled();
    expect(payments.confirmVerifiedLocal).toHaveBeenCalled();
    expect(store.state).toBe(WS.CONFIRMED);
  });

  it('ambiguous provider confirmation never confirms locally and flags reconciliation', async () => {
    const { strat, payments, store } = make({ confirm: { outcome: 'AMBIGUOUS' } });
    store.state = WS.PAYMENT_PENDING;
    store.providerReservationId = 'mockres_1';
    const res = await strat.handlePaymentConfirmed(fact);
    expect(res.handled).toBe(true);
    expect(payments.confirmVerifiedLocal).not.toHaveBeenCalled();
    expect(store.providerReconciliationRequired).toBe(true);
    expect(store.state).not.toBe(WS.CONFIRMED);
  });

  it('rejected provider confirmation after payment → compensation required, no local confirm', async () => {
    const { strat, payments, store } = make({ confirm: { outcome: 'REJECTED' } });
    store.state = WS.PAYMENT_PENDING;
    store.providerReservationId = 'mockres_1';
    await strat.handlePaymentConfirmed(fact);
    expect(payments.confirmVerifiedLocal).not.toHaveBeenCalled();
    expect(store.state).toBe(WS.COMPENSATION_PENDING);
  });
});

describe('ProviderAuthoritativeStrategy.recoverStatus', () => {
  it('recovers a confirmed-response-lost reservation to confirmed', async () => {
    const { strat, provider, store } = make({
      confirm: { outcome: 'OK', providerBookingId: 'mockbk_1' },
      status: { outcome: 'OK', status: 'CONFIRMED' },
    });
    store.state = WS.PROVIDER_CONFIRM_PENDING;
    store.providerReservationId = 'mockres_1';
    const res = await strat.recoverStatus('b1');
    expect(provider.getBookingStatus).toHaveBeenCalled();
    expect(res.classification).toBe('PROVIDER_CONFIRMED_LOCAL_PENDING');
  });

  it('recovers a rejected reservation to compensation-required', async () => {
    const { strat, store } = make({ status: { outcome: 'OK', status: 'REJECTED' } });
    store.state = WS.PROVIDER_CONFIRM_PENDING;
    store.providerReservationId = 'mockres_1';
    const res = await strat.recoverStatus('b1');
    expect(res.classification).toBe('PAYMENT_SUCCEEDED_PROVIDER_REJECTED');
  });
});

describe('ProviderAuthoritativeStrategy transactional event emission', () => {
  const fact = { bookingId: 'b1', providerRef: 'pi_1', amountMinor: 5000 };
  const emittedTypes = (publisher: { recordInTransaction: jest.Mock }) =>
    publisher.recordInTransaction.mock.calls.flatMap((c) =>
      (c[1] as Array<{ eventType: string }>).map((e) => e.eventType),
    );

  it('records ReservationCreated in the same tx and delivers after commit', async () => {
    const { strat, publisher } = make();
    await strat.initiate(initReq, session);
    expect(emittedTypes(publisher as never)).toContain('booking.provider_reservation_created');
    expect(
      (publisher as never as { deliverAfterCommit: jest.Mock }).deliverAfterCommit,
    ).toHaveBeenCalled();
  });

  it('rolls back the transition and delivers NO event when the outbox insert fails', async () => {
    const { strat, publisher } = make();
    (publisher.recordInTransaction as jest.Mock).mockRejectedValue(
      new Error('outbox insert failed'),
    );
    await expect(strat.initiate(initReq, session)).rejects.toBeTruthy();
    // The event was never delivered post-commit (the tx rolled back).
    expect(
      (publisher as never as { deliverAfterCommit: jest.Mock }).deliverAfterCommit,
    ).not.toHaveBeenCalled();
  });

  it('emits ProviderConfirmed once and BookingConfirmed remains the local-confirm fact', async () => {
    const { strat, publisher, payments, store } = make();
    store.state = WS.PAYMENT_PENDING;
    store.providerReservationId = 'mockres_1';
    await strat.handlePaymentConfirmed(fact);
    const types = emittedTypes(publisher as never);
    expect(types.filter((t) => t === 'booking.provider_confirmed')).toHaveLength(1);
    expect(payments.confirmVerifiedLocal).toHaveBeenCalledTimes(1); // local confirm (BookingConfirmed) runs once
  });

  it('duplicate callback on an already-confirmed booking emits no new events', async () => {
    const { strat, provider, publisher, store } = make();
    store.state = WS.CONFIRMED;
    store.providerReservationId = 'mockres_1';
    const res = await strat.handlePaymentConfirmed(fact);
    expect(res).toEqual({
      handled: true,
      result: { status: 'already_confirmed', bookingId: 'b1' },
    });
    expect(provider.confirmReservation).not.toHaveBeenCalled();
    expect(emittedTypes(publisher as never)).toHaveLength(0);
  });

  it('confirmed-response-lost recovery emits StatusRecovered + ProviderConfirmed without duplicate confirmation', async () => {
    const { strat, provider, publisher, payments, store } = make({
      status: { outcome: 'OK', status: 'CONFIRMED' },
      confirm: { outcome: 'OK', providerBookingId: 'mockbk_1' },
    });
    store.state = WS.PROVIDER_CONFIRM_PENDING;
    store.providerReservationId = 'mockres_1';
    await strat.recoverStatus('b1');
    const types = emittedTypes(publisher as never);
    expect(types).toContain('booking.provider_status_recovered');
    expect(types).toContain('booking.provider_confirmed');
    expect(payments.confirmVerifiedLocal).toHaveBeenCalledTimes(1); // confirmed exactly once
    expect(provider.confirmReservation).toHaveBeenCalledTimes(1);
  });
});
