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
import { GuestSessionVerifier } from '../guest-session';
import { BookingWorkflowState as WS } from './booking-workflow-state';

function make(mode: 'disabled' | 'shadow' | 'active', sessionHash: string | null = null) {
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
        subtotalMinor: 5000,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        discountMinor: 500,
        customerFeeMinor: 300,
        organizerFeeMinor: 0,
        taxMinor: 54,
        taxLines: [
          {
            label: 'Sales tax on fees',
            rateBasisPoints: 1800,
            baseMinor: 300,
            amountMinor: 54,
            basis: 'FEES',
            inclusive: false,
          },
        ],
        maintenanceMinor: 0,
        maintenanceTreatment: 'NOT_APPLICABLE',
        totalMinor: 4854,
        payment: { id: 'p1', status: 'REQUIRES_PAYMENT' },
        // Read by the guest payment route's session check as well as the response shaper.
        guestSessionHash: sessionHash,
      }),
      // The guest session binding: a conditional update on the booking, made in every mode.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingWorkflow: { count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  // Stands in for the hold transaction, so a binding written inside it is observable.
  const holdTx = { booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const bookings = {
    create: jest.fn(
      async (
        _user: unknown,
        _body: unknown,
        _key: unknown,
        hooks?: { inHoldTx?: (tx: unknown, id: string) => Promise<void> },
      ) => {
        if (hooks?.inHoldTx) await hooks.inHoldTx(holdTx, 'legacy-b');
        return { id: 'legacy-b', status: 'PENDING_PAYMENT' };
      },
    ),
    getForUser: jest.fn().mockResolvedValue({ id: 'b1', status: 'PENDING_PAYMENT' }),
    cancelUnpaid: jest
      .fn()
      .mockResolvedValue({ id: 'b1', status: 'CANCELLED', refundPending: false }),
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
  const workflows = { getByBookingId: jest.fn().mockResolvedValue(null) };
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
    // The real verifier over these stubs: the point of the guest-payment tests below is the rule
    // itself, which a mocked verifier would not exercise.
    new GuestSessionVerifier(prisma, config, workflows as never, anon),
  );
  return { router, bookings, payments, orchestrator, anon, prisma, holdTx };
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

  it('active returns the full fee breakdown the legacy path returns', async () => {
    /*
      The rebuilt response carried six fee fields and not `currency`, `subtotalMinor` or
      `netSubtotalMinor`, which the clients' price breakdown requires — so turning
      orchestration on would have broken the checkout summary without changing a price.
    */
    const { router } = make('active');
    const res = (await router.initiate({ user, body })) as { fees: Record<string, unknown> };
    expect(res.fees).toMatchObject({
      currency: 'USD',
      subtotalMinor: 5000,
      discountMinor: 500,
      netSubtotalMinor: 4500,
      customerFeeMinor: 300,
      // The tax on the fees, added to them, exactly as the legacy quote reports it.
      customerFeeInclusiveMinor: 354,
      feeTaxMinor: 54,
      taxMinor: 54,
      totalMinor: 4854,
    });
    expect(res.fees.taxLines).toHaveLength(1);
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

/**
 * The guest checkout session, made durable in every mode.
 *
 * ── WHY THESE TESTS EXIST ──────────────────────────────────────────────────────────
 * Guest ownership used to be recorded only on `BookingWorkflow.ownerId`, which this router writes
 * only in ACTIVE mode — and local, QA, UAT and production all run SHADOW. Proved end to end: a
 * guest created a booking with a session token and then could not claim it with that same token,
 * because there was nothing to compare it against. "Save this booking to my account" could not
 * succeed in any real environment, and `GET /bookings/guest/:id` accepted any well-formed token.
 *
 * So each mode is asserted separately here, and shadow is the one that matters most.
 */
describe('the guest checkout session is bound to the booking in every mode', () => {
  const anon = new AnonymousSessionService();

  it.each(['disabled', 'shadow'] as const)(
    'writes the hash of the client’s own token inside the creating transaction (%s)',
    async (mode) => {
      const token = anon.issueToken();
      const { router, holdTx } = make(mode);
      const res = (await router.initiate({ user: null, body, anonymousToken: token })) as Record<
        string,
        unknown
      >;

      expect(holdTx.booking.updateMany).toHaveBeenCalledWith({
        // Conditional, so it can never overwrite an existing binding or touch an account booking.
        where: { id: 'legacy-b', userId: null, guestSessionHash: null },
        data: { guestSessionHash: anon.hash(token) },
      });
      // The client already has its token, so nothing is handed back and the shape is unchanged.
      expect(res).toEqual({ id: 'legacy-b', status: 'PENDING_PAYMENT' });
    },
  );

  it('issues a token and returns it once when the client sent none, in shadow mode', async () => {
    /*
      Before this, a token was minted only in active mode, so a first-time guest in shadow got
      nothing back — and a client that waited for one stored nothing, leaving the buyer with a paid
      booking their own browser could not open.
    */
    const { router, holdTx } = make('shadow');
    const res = (await router.initiate({ user: null, body })) as Record<string, string>;
    expect(typeof res.anonymousSessionToken).toBe('string');
    // What was stored is the HASH of exactly what was returned, and never the token itself.
    const written = holdTx.booking.updateMany.mock.calls[0][0] as {
      data: { guestSessionHash: string };
    };
    expect(written.data.guestSessionHash).toBe(anon.hash(res.anonymousSessionToken));
    expect(JSON.stringify(written)).not.toContain(res.anonymousSessionToken);
  });

  it('ignores a token that is not well-formed and issues a real one instead', async () => {
    // A client-supplied value is only adopted if it is the right shape; otherwise the server
    // decides, rather than binding the booking to something nobody can reproduce.
    const { router, holdTx } = make('shadow');
    const res = (await router.initiate({
      user: null,
      body,
      anonymousToken: 'nonsense',
    })) as Record<string, string>;
    expect(res.anonymousSessionToken).toMatch(/^anon_/);
    expect(holdTx.booking.updateMany.mock.calls[0][0].data.guestSessionHash).toBe(
      anon.hash(res.anonymousSessionToken),
    );
  });

  it('binds it in active mode too, alongside the workflow owner', async () => {
    // Belt and braces there — active mode also records the owner on the workflow — so that ONE
    // rule holds everywhere: every guest booking carries the hash of the session that made it.
    const token = anon.issueToken();
    const { router, prisma } = make('active');
    await router.initiate({ user: null, body, anonymousToken: token });
    expect(prisma.booking.updateMany as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'b1', userId: null, guestSessionHash: null },
      data: { guestSessionHash: anon.hash(token) },
    });
  });

  it('the guest payment route accepts the session that created the booking', async () => {
    /*
      The real path, and the one that must not break: the storefront pays with the very token it
      created the booking with, so a bound booking and its own session go through untouched.
    */
    const token = anon.issueToken();
    const { router, payments } = make('shadow', anon.hash(token));
    await router.beginPayment({
      user: null,
      bookingId: 'b1',
      anonymousToken: token,
      requireAnonymousToken: true,
    });
    expect(payments.createIntent).toHaveBeenCalledWith('b1', undefined);
  });

  it('the guest payment route refuses a different well-formed session on a bound booking', async () => {
    /*
      Well-formedness used to be the whole check here, in every mode, so 256 bits the caller
      generated themselves plus a booking id opened a payment on somebody else's booking. Less
      harmful than reading it — the server decides provider, amount and currency — but the same
      missing check, and no payment intent is created now.
    */
    const { router, payments } = make('shadow', anon.hash(anon.issueToken()));
    await expect(
      router.beginPayment({
        user: null,
        bookingId: 'b1',
        anonymousToken: anon.issueToken(),
        requireAnonymousToken: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(payments.createIntent).not.toHaveBeenCalled();
  });

  it('the guest payment route still pays for an unbound booking, which is the status quo', async () => {
    // A booking that predates the column records no session. Refusing it would strand a guest
    // mid-checkout on a booking they legitimately hold — the opposite of the claim route, where the
    // consequence of leniency is somebody losing their tickets rather than not paying for them.
    const { router, payments } = make('shadow', null);
    await router.beginPayment({
      user: null,
      bookingId: 'b1',
      anonymousToken: anon.issueToken(),
      requireAnonymousToken: true,
    });
    expect(payments.createIntent).toHaveBeenCalledTimes(1);
  });

  it('never binds a signed-in buyer’s booking, in any mode', async () => {
    // An account booking is owned by its `userId`. Writing a session hash onto one would create a
    // second credential for a booking that already has an owner.
    for (const mode of ['disabled', 'shadow'] as const) {
      const { router, holdTx } = make(mode);
      await router.initiate({ user, body, anonymousToken: anon.issueToken() });
      expect(holdTx.booking.updateMany).not.toHaveBeenCalled();
    }
    const active = make('active');
    await active.router.initiate({ user, body, anonymousToken: anon.issueToken() });
    expect(active.prisma.booking.updateMany as jest.Mock).not.toHaveBeenCalled();
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

  it('cancel in disabled/shadow cancels the signed-in owner’s unpaid booking on the legacy path', async () => {
    for (const mode of ['disabled', 'shadow'] as const) {
      const { router, bookings, orchestrator } = make(mode);
      const res = (await router.cancel({ user, bookingId: 'b1' })) as Record<string, unknown>;
      expect(bookings.cancelUnpaid).toHaveBeenCalledWith(user, 'b1');
      expect(orchestrator.cancel).not.toHaveBeenCalled();
      expect(res.status).toBe('CANCELLED');
    }
  });

  it('cancel refuses a guest in disabled/shadow, where nothing proves the booking is theirs', async () => {
    for (const mode of ['disabled', 'shadow'] as const) {
      const { router, bookings, anon } = make(mode);
      await expect(
        router.cancel({ user: null, bookingId: 'b1', anonymousToken: anon.issueToken() }),
      ).rejects.toBeInstanceOf(AppException);
      expect(bookings.cancelUnpaid).not.toHaveBeenCalled();
    }
  });

  it('cancel is coordinated by the orchestrator in active mode', async () => {
    const { router, orchestrator, bookings } = make('active');
    const res = (await router.cancel({ user, bookingId: 'b1' })) as Record<string, unknown>;
    expect(orchestrator.cancel).toHaveBeenCalledTimes(1);
    expect(bookings.cancelUnpaid).not.toHaveBeenCalled();
    expect(res.status).toBe('CANCELLED');
  });

  it('guest pay requires a well-formed anonymous token in every mode', async () => {
    for (const mode of ['disabled', 'shadow', 'active'] as const) {
      const { router, payments } = make(mode);
      await expect(
        router.beginPayment({ user: null, bookingId: 'b1', requireAnonymousToken: true }),
      ).rejects.toBeInstanceOf(AppException);
      await expect(
        router.beginPayment({
          user: null,
          bookingId: 'b1',
          anonymousToken: 'garbage',
          requireAnonymousToken: true,
        }),
      ).rejects.toBeInstanceOf(AppException);
      expect(payments.createIntent).not.toHaveBeenCalled();
    }
  });

  it('guest pay rejects an authenticated caller using the guest route', async () => {
    const { router, anon } = make('active');
    await expect(
      router.beginPayment({
        user,
        bookingId: 'b1',
        anonymousToken: anon.issueToken(),
        requireAnonymousToken: true,
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('guest pay with a valid token routes through the legacy path in disabled mode', async () => {
    const { router, payments, anon } = make('disabled');
    await router.beginPayment({
      user: null,
      bookingId: 'b1',
      anonymousToken: anon.issueToken(),
      requireAnonymousToken: true,
    });
    expect(payments.createIntent).toHaveBeenCalledWith('b1', undefined);
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
