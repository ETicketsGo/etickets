import { CancellationRefundsService } from './cancellation-refunds.service';
import { CancellationRefundsHandler } from './cancellation-refunds.handler';
import { checkRefundEligibility } from './refund-eligibility';
import { BookingStatus, SessionStatus } from '@eticketsgo/shared-types';

/**
 * unit - a cancelled show cannot leave a paying customer owed and unrecorded.
 *
 * ── THE BEHAVIOUR THIS REPLACES ────────────────────────────────────────────────────
 * `cancelShow` returned `bookingsRequiringRefund` and nothing consumed it. Whether somebody
 * got their money back depended on a human reading an API response. Nothing recorded the
 * obligation, nothing chased it, and nothing would ever have noticed it being missed.
 *
 * These tests are about that guarantee, not about the arithmetic: the refund AMOUNT is the
 * certified calculation in `createRequest` and is deliberately untouched here.
 */

function makeService(opts: {
  sessionStatus?: string | null;
  owed?: Array<{ id: string }>;
  remaining?: number;
  open?: (id: string) => Promise<unknown>;
}) {
  const calls: string[] = [];
  const session =
    opts.sessionStatus === undefined
      ? { id: 's1', status: SessionStatus.CANCELLED }
      : opts.sessionStatus === null
        ? null
        : { id: 's1', status: opts.sessionStatus };
  const prisma = {
    eventSession: {
      findUnique: jest.fn().mockResolvedValue(session),
      findMany: jest.fn().mockResolvedValue([{ id: 's1' }]),
    },
    booking: {
      findMany: jest.fn().mockResolvedValue(opts.owed ?? [{ id: 'b1' }, { id: 'b2' }]),
      count: jest.fn().mockResolvedValue(opts.remaining ?? 0),
    },
  };
  const refunds = {
    openForCancelledSession: jest.fn(async (id: string) => {
      calls.push(id);
      if (opts.open) return opts.open(id);
      return { id: `r-${id}` };
    }),
  };
  const service = new CancellationRefundsService(prisma as never, refunds as never);
  return { service, prisma, refunds, calls };
}

describe('every paid booking on a cancelled show gets a refund opened', () => {
  it('opens one for each booking that has none', async () => {
    const { service, calls } = makeService({});
    const r = await service.openFor('s1');
    expect(r.opened).toBe(2);
    expect(calls).toEqual(['b1', 'b2']);
  });

  it('asks only for bookings with NO refund row at all', async () => {
    /*
      `none`, not "no OPEN refund". A refund a human rejected must not be re-opened by a
      sweep every two minutes - that is the sweep arguing with the person who decided.
    */
    const { service, prisma } = makeService({});
    await service.openFor('s1');
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.refunds).toEqual({ none: {} });
    expect(where.status.in).toEqual([BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED]);
  });

  it('does nothing for a show that is not cancelled', async () => {
    // A redelivered event after somebody reinstated the show must be harmless, not expensive.
    const { service, calls } = makeService({ sessionStatus: SessionStatus.SCHEDULED });
    const r = await service.openFor('s1');
    expect(r.opened).toBe(0);
    expect(calls).toEqual([]);
  });

  it('does nothing for a session that no longer exists', async () => {
    const { service, calls } = makeService({ sessionStatus: null });
    await service.openFor('s1');
    expect(calls).toEqual([]);
  });
});

describe('one booking cannot stop the others', () => {
  it('counts a cash booking as skipped, not failed, and carries on', async () => {
    /*
      Cash is refunded across the counter it was paid at. It is permanently not refundable
      online, so counting it as a failure would make a healthy sweep look broken forever.
    */
    const { service, calls } = makeService({
      owed: [{ id: 'cash' }, { id: 'ok' }],
      open: async (id) => {
        if (id === 'cash') throw new Error('This booking was paid in cash at the venue.');
        return { id };
      },
    });
    const r = await service.openFor('s1');
    expect({ opened: r.opened, skipped: r.skipped, failed: r.failed }).toEqual({
      opened: 1,
      skipped: 1,
      failed: 0,
    });
    expect(calls).toEqual(['cash', 'ok']);
  });

  it('counts an unexpected error as FAILED, so it cannot look like success', async () => {
    const { service } = makeService({
      owed: [{ id: 'boom' }, { id: 'ok' }],
      open: async (id) => {
        if (id === 'boom') throw new Error('connection terminated unexpectedly');
        return { id };
      },
    });
    const r = await service.openFor('s1');
    expect({ opened: r.opened, failed: r.failed }).toEqual({ opened: 1, failed: 1 });
  });

  it('reports what is still owed, so the sweep has something to come back for', async () => {
    const { service } = makeService({ remaining: 7 });
    expect((await service.openFor('s1')).remaining).toBe(7);
  });
});

describe('the sweep is the guarantee', () => {
  it('asks the data which cancelled shows still owe somebody', async () => {
    const { service, prisma } = makeService({});
    await service.sweep();
    const args = prisma.eventSession.findMany.mock.calls[0][0];
    expect(args.where.status).toBe(SessionStatus.CANCELLED);
    expect(args.where.bookings.some.refunds).toEqual({ none: {} });
    // Bounded: an unbounded scan over every cancelled show eventually times out.
    expect(args.take).toBeGreaterThan(0);
    expect(args.where.updatedAt.gte).toBeInstanceOf(Date);
  });

  it('still opens refunds when the event handler never ran', async () => {
    // The whole point: correctness does not depend on the handler having worked.
    const { service, calls } = makeService({});
    const r = await service.sweep();
    expect(r.opened).toBe(2);
    expect(calls).toEqual(['b1', 'b2']);
  });
});

describe('the handler is a fast start, not the guarantee', () => {
  it('ignores a vendor feed cancellation, which owes us nothing', async () => {
    const cancellations = { openFor: jest.fn() };
    const handler = new CancellationRefundsHandler(cancellations as never);
    await handler.handle({
      type: 'session.cancelled',
      aggregateType: 'ProviderSession',
      aggregateId: 'p1',
      version: 1,
    } as never);
    expect(cancellations.openFor).not.toHaveBeenCalled();
  });

  it('opens refunds for one of our own shows', async () => {
    const cancellations = {
      openFor: jest.fn().mockResolvedValue({ opened: 3, skipped: 0, failed: 0, remaining: 0 }),
    };
    const handler = new CancellationRefundsHandler(cancellations as never);
    await handler.handle({
      type: 'session.cancelled',
      aggregateType: 'EventSession',
      aggregateId: 's1',
      version: 1,
    } as never);
    expect(cancellations.openFor).toHaveBeenCalledWith('s1');
  });
});

describe('a cancelled show overrides the organizer refund rules', () => {
  const base = {
    bookingStatus: BookingStatus.CONFIRMED,
    sessionStartsAt: new Date('2026-01-01T10:00:00Z'),
    now: new Date('2026-01-01T09:00:00Z'), // one hour out: inside any ordinary cut-off
  };

  it('refunds past the cut-off, because the buyer did not cause this', () => {
    expect(checkRefundEligibility({ ...base, policyHours: 48 }).eligible).toBe(false);
    expect(
      checkRefundEligibility({ ...base, policyHours: 48, sessionCancelled: true }).eligible,
    ).toBe(true);
  });

  it('refunds even when the organizer turned refunds off', () => {
    expect(checkRefundEligibility({ ...base, refundsEnabled: false }).eligible).toBe(false);
    expect(
      checkRefundEligibility({ ...base, refundsEnabled: false, sessionCancelled: true }).eligible,
    ).toBe(true);
  });

  it('still refuses a booking that is not refundable at all', () => {
    // An already-refunded booking is not refunded twice because the show was then cancelled.
    const v = checkRefundEligibility({
      ...base,
      bookingStatus: BookingStatus.REFUNDED,
      sessionCancelled: true,
    });
    expect(v.eligible).toBe(false);
  });
});
