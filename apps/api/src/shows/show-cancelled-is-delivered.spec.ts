import { ShowsService } from './shows.service';

/**
 * Cancelling a show must DELIVER `session.cancelled`, not merely record it.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────────────
 * `TransactionalEventPublisher` is a two-step contract, and every other caller in the
 * codebase does both steps: `recordInTransaction` inside the transaction, then
 * `deliverAfterCommit` once it has committed.
 *
 * `cancelShow` did only the first. In the default delivery mode - `in_process` -
 * `recordInTransaction` writes no durable rows and returns 0, so the event was never
 * published at all: neither the notification handler nor the refund handler ran, and the
 * outbox stayed empty. Observed on a real cancellation against a real database.
 *
 * Nothing was lost, because the worker sweep is the guarantee and it found the booking. But
 * the sweep runs on an interval, so without delivery a customer waits for the next pass to
 * learn their show is cancelled instead of hearing within seconds. The invariant is: the
 * fast path is for latency, the sweep is for convergence. This holds the fast path to it.
 *
 * ── WHY IT ASSERTS ORDER ───────────────────────────────────────────────────────────
 * Delivering before the commit would publish a cancellation that can still roll back, and
 * handlers would act on a show that is still on. The order is the correctness property, so
 * the order is what is asserted - not merely that both were called.
 */
describe('cancelShow delivers the cancellation event', () => {
  function makeService() {
    const calls: string[] = [];
    const session = {
      id: 'sess1',
      eventId: 'ev1',
      startsAt: new Date('2026-12-01T10:00:00Z'),
      status: 'SCHEDULED',
      event: { organizationId: 'org1' },
    };

    const tx = {
      eventSession: { update: jest.fn().mockResolvedValue({}) },
      showSeat: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      // No unpaid bookings on this show: expiring those is its own path with its own tests,
      // and dragging the inventory services in here would test something else.
      booking: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', reference: 'ETG-1' }]) },
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        const out = await fn(tx);
        calls.push('commit');
        return out;
      }),
    };

    const events = {
      recordInTransaction: jest.fn(async () => {
        calls.push('recordInTransaction');
        return 0;
      }),
      deliverAfterCommit: jest.fn(async () => {
        calls.push('deliverAfterCommit');
      }),
    };

    const service = new ShowsService(
      prisma as never,
      { assertMember: jest.fn() } as never,
      { record: jest.fn() } as never,
      undefined as never,
      undefined as never,
      events as never,
    );
    // The authorization + load step is its own concern and has its own tests; this one is
    // about what happens to the event once a cancellation is allowed to proceed.
    (service as unknown as Record<string, unknown>).authorizeOperation = jest
      .fn()
      .mockResolvedValue({
        session,
        commitments: { confirmed: 1, activeHolds: 0 },
        idempotent: false,
      });
    (service as unknown as Record<string, unknown>).recordShowAudit = jest.fn();

    return { service, events, calls };
  }

  it('records inside the transaction and delivers after the commit', async () => {
    const { service, events, calls } = makeService();

    await service.cancelShow({ id: 'u1' } as never, 'sess1', 'Projector failure');

    expect(events.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(events.deliverAfterCommit).toHaveBeenCalledTimes(1);

    /*
      The order IS the property. Recording inside the transaction means a rolled-back
      cancellation tells nobody; delivering only after the commit means nobody is told about
      a show that is still on.
    */
    expect(calls).toEqual(['recordInTransaction', 'commit', 'deliverAfterCommit']);
  });

  it('delivers the same event it recorded', async () => {
    const { service, events } = makeService();

    await service.cancelShow({ id: 'u1' } as never, 'sess1', 'Projector failure');

    const recorded = (events.recordInTransaction as jest.Mock).mock.calls[0][1][0];
    const delivered = (events.deliverAfterCommit as jest.Mock).mock.calls[0][0][0];

    /*
      The same object, so the same `eventId`. A handler that has already seen the recorded
      event can recognise the delivered one and do nothing - which is what makes delivering
      it twice safe. Two separately built events would carry two ids and be handled twice.
    */
    expect(delivered).toBe(recorded);
    expect(delivered.eventType).toBe('session.cancelled');
  });
});
