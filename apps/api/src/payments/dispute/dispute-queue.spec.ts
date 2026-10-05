import { DisputeService } from './dispute.service';

/**
 * The chargeback queue an operator reads.
 *
 * Until `listOpen` existed this service could only write: it mirrored every chargeback, stamped
 * the provider's deadline on it, blocked the organizer's proceeds and notified the admins - and
 * no screen in the platform could list one. These tests cover the three things that make the
 * queue readable rather than merely present: what it asks the database for, how it orders what
 * comes back, and how it adds money up.
 */
function makeService(rows: Array<Record<string, unknown>>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { dispute: { findMany } };
  const service = new DisputeService(
    prisma as never,
    { record: jest.fn() } as never,
    { send: jest.fn() } as never,
    { applyDispute: jest.fn() } as never,
  );
  return { service, findMany };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    provider: 'stripe',
    providerDisputeId: 'dp_1',
    status: 'NEEDS_RESPONSE',
    amountMinor: 5000,
    currency: 'usd',
    reason: 'fraudulent',
    evidenceDueBy: new Date('2026-10-09T00:00:00Z'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    bookingId: 'b1',
    organization: { id: 'org1', name: 'Odeon' },
    ...over,
  };
}

describe('DisputeService.listOpen', () => {
  it('asks only for the ones still waiting on us', async () => {
    const { service, findMany } = makeService([]);
    await service.listOpen();

    /*
      A queue of chargebacks already won, lost or closed is a history, and a history is not
      work. Only NEEDS_RESPONSE and UNDER_REVIEW are still ours to answer.
    */
    const where = findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['NEEDS_RESPONSE', 'UNDER_REVIEW']);
  });

  it('sorts a dispute with no deadline LAST, not first', async () => {
    const { service, findMany } = makeService([]);
    await service.listOpen();

    /*
      ── THE DEFAULT THAT WOULD HAVE HIDDEN THE URGENT ONES ─────────────────────────────
      Postgres sorts NULLs FIRST on an ascending sort. `evidenceDueBy` is nullable - the
      provider does not always set one - so the plain `{ evidenceDueBy: 'asc' }` that reads
      correctly would have filled the top of the queue with the disputes that have no deadline
      to miss, and pushed the one due today below them.

      On a page whose entire purpose is "what is due soonest", that is the defect that matters,
      and it is invisible until a real row arrives with a null in it.
    */
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual({ evidenceDueBy: { sort: 'asc', nulls: 'last' } });
    // A tie on the deadline falls back to age, oldest first, so the order is total.
    expect(orderBy[1]).toEqual({ createdAt: 'asc' });
  });

  it('upper-cases the currency the provider sent in lower case', async () => {
    const { service } = makeService([row({ currency: 'usd' }), row({ id: 'd2', currency: 'INR' })]);
    const out = await service.listOpen();

    // Providers report "usd"; our own rows carry "INR". Left alone, a page grouping by
    // currency shows the same market twice under two spellings.
    expect(out.disputes.map((d) => d.currency)).toEqual(['USD', 'INR']);
  });

  it('totals the money at risk per currency and never across them', async () => {
    const { service } = makeService([
      row({ id: 'd1', currency: 'inr', amountMinor: 150_00 }),
      row({ id: 'd2', currency: 'INR', amountMinor: 250_00 }),
      row({ id: 'd3', currency: 'usd', amountMinor: 40_00 }),
    ]);
    const out = await service.listOpen();

    /*
      Rupees added to dollars is not an amount of anything - the same rule the platform
      overview had to be repaired for. The two spellings of INR are one market and must add
      up, which is the other half of why the case is normalised.
    */
    expect(out.atRisk).toEqual([
      { currency: 'INR', totalMinor: 400_00 },
      { currency: 'USD', totalMinor: 40_00 },
    ]);
  });

  it('serialises dates as strings and keeps a missing deadline missing', async () => {
    const { service } = makeService([
      row({ evidenceDueBy: null, organization: null, reason: null, bookingId: null }),
    ]);
    const [d] = (await service.listOpen()).disputes;

    expect(d.createdAt).toBe('2026-10-01T00:00:00.000Z');
    /*
      Null, not a date and not the epoch. A screen has to be able to say "no deadline set",
      and a defaulted date would read as a real deadline in 1970 - which sorts to the top and
      renders as "deadline passed" on a dispute that has none.
    */
    expect(d.evidenceDueBy).toBeNull();
    expect(d.organization).toBeNull();
    expect(d.reason).toBeNull();
    expect(d.bookingId).toBeNull();
  });

  it('reports no money at risk when nothing is open', async () => {
    const { service } = makeService([]);
    const out = await service.listOpen();
    // An empty list, not a zero in some assumed currency: the platform sells in several and
    // guessing one would put a false market on the screen.
    expect(out).toEqual({ disputes: [], atRisk: [] });
  });
});
