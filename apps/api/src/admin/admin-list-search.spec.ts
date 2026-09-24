import 'reflect-metadata';
import { AdminService } from './admin.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { EventsService } from '../events/events.service';
import { RefundsService } from '../refunds/refunds.service';

/**
 * Every admin queue searches in the DATABASE.
 *
 * ── THE DEFECT THIS LOCKS SHUT, IN FOUR PLACES ─────────────────────────────────────
 * Organizers, events, payments and refunds each had a search box that filtered the page already
 * fetched. Type a name that sits on page two and the console answers "nothing matches" with
 * total confidence, while the pager underneath still counts every row on the platform. On the
 * refunds queue it was worse than useless: the requests that need chasing are the OLD ones, and
 * those are precisely the ones never present in the newest fifteen rows.
 *
 * The "Search" button was decorative on all four - `SearchInput` renders one and calls
 * `onSubmit`, and none of these pages passed an `onSubmit`.
 *
 * These tests assert the clause reaches Prisma. They are about where the filtering happens, so
 * they read the `where` the service builds rather than counting rows.
 */
function prismaMock(extra: Record<string, unknown> = {}) {
  return {
    $transaction: jest.fn().mockResolvedValue([0, []]),
    feedback: { groupBy: jest.fn().mockResolvedValue([]) },
    eventSession: { groupBy: jest.fn().mockResolvedValue([]) },
    organization: { count: jest.fn(), findMany: jest.fn() },
    event: { count: jest.fn(), findMany: jest.fn() },
    payment: { count: jest.fn(), findMany: jest.fn() },
    refund: { count: jest.fn(), findMany: jest.fn() },
    ...extra,
  };
}

/** The `where` a service handed to its count query. */
function whereOf(count: jest.Mock) {
  return count.mock.calls[0][0].where;
}

describe('organizer queue', () => {
  it('searches name, slug and registered legal name in Postgres', async () => {
    const count = jest.fn();
    const prisma = prismaMock({ organization: { count, findMany: jest.fn() } });
    const service = new OrganizationsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.adminList(undefined, 1, 15, 'aurora');

    const where = whereOf(count);
    expect(where.OR).toEqual([
      { name: { contains: 'aurora', mode: 'insensitive' } },
      { slug: { contains: 'aurora', mode: 'insensitive' } },
      { legalName: { contains: 'aurora', mode: 'insensitive' } },
    ]);
  });

  it('counts open complaints for the page in one grouped query, not one per row', async () => {
    const rows = [
      { id: 'org-1', name: 'A' },
      { id: 'org-2', name: 'B' },
    ];
    const groupBy = jest.fn().mockResolvedValue([{ organizationId: 'org-1', _count: { _all: 3 } }]);
    const prisma = prismaMock({
      organization: { count: jest.fn(), findMany: jest.fn() },
      feedback: { groupBy },
      $transaction: jest.fn().mockResolvedValue([2, rows]),
    });
    const service = new OrganizationsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const page = await service.adminList(undefined, 1, 15);

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(page.data.map((o) => [o.id, o.openComplaints])).toEqual([
      ['org-1', 3],
      // Never complained about is zero, not undefined - the cell would render nothing.
      ['org-2', 0],
    ]);
  });
});

describe('event moderation queue', () => {
  function service(prisma: unknown) {
    return new EventsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('searches title, organizer and city in Postgres', async () => {
    const count = jest.fn();
    const prisma = prismaMock({ event: { count, findMany: jest.fn() } });

    await service(prisma).adminList(undefined, 1, 15, 'sunburn');

    const where = whereOf(count);
    expect(where.OR).toEqual([
      { title: { contains: 'sunburn', mode: 'insensitive' } },
      { organization: { name: { contains: 'sunburn', mode: 'insensitive' } } },
      { venue: { city: { contains: 'sunburn', mode: 'insensitive' } } },
    ]);
  });

  it('says when the event happens, not only when the row was edited', async () => {
    const rows = [{ id: 'ev-1', title: 'Run' }];
    const prisma = prismaMock({
      $transaction: jest.fn().mockResolvedValue([1, rows]),
      eventSession: {
        groupBy: jest.fn().mockResolvedValue([
          {
            eventId: 'ev-1',
            _min: { startsAt: new Date('2026-10-01T18:00:00.000Z') },
            _max: { startsAt: new Date('2026-10-05T18:00:00.000Z') },
            _count: { _all: 5 },
          },
        ]),
      },
    });

    const page = await service(prisma).adminList(undefined, 1, 15);

    expect(page.data[0]).toMatchObject({
      firstSessionAt: new Date('2026-10-01T18:00:00.000Z'),
      lastSessionAt: new Date('2026-10-05T18:00:00.000Z'),
      sessionCount: 5,
    });
  });

  it('reports an event with no session at all, because nobody can buy a ticket to it', async () => {
    const prisma = prismaMock({
      $transaction: jest.fn().mockResolvedValue([1, [{ id: 'ev-2', title: 'Empty' }]]),
    });

    const page = await service(prisma).adminList(undefined, 1, 15);

    expect(page.data[0]).toMatchObject({
      sessionCount: 0,
      firstSessionAt: null,
      lastSessionAt: null,
    });
  });
});

describe('payment ledger', () => {
  it('searches provider reference, buyer email and booking reference in Postgres', async () => {
    const count = jest.fn();
    const prisma = prismaMock({ payment: { count, findMany: jest.fn() } });
    const service = new AdminService(prisma as never, {} as never);

    await service.payments({ page: 1, pageSize: 15, q: 'pay_abc' });

    const where = whereOf(count);
    expect(where.OR).toEqual([
      { providerRef: { contains: 'pay_abc', mode: 'insensitive' } },
      { booking: { buyerEmail: { contains: 'pay_abc', mode: 'insensitive' } } },
      { booking: { reference: { contains: 'pay_abc', mode: 'insensitive' } } },
    ]);
  });

  it('names the sale a payment paid for', async () => {
    const rows = [
      {
        id: 'pm-1',
        status: 'SUCCEEDED',
        amountMinor: 21676,
        currency: 'INR',
        provider: 'razorpay',
        providerRef: 'pay_abc',
        createdAt: new Date(),
        bookingId: 'bk-1',
        booking: {
          buyerEmail: 'ada@example.test',
          reference: 'ETG-IND-2026-000027',
          event: { title: 'Concert Payant' },
        },
      },
    ];
    const prisma = prismaMock({ $transaction: jest.fn().mockResolvedValue([1, rows]) });
    const service = new AdminService(prisma as never, {} as never);

    const page = await service.payments({ page: 1, pageSize: 15 });

    expect(page.data[0]).toMatchObject({
      bookingReference: 'ETG-IND-2026-000027',
      eventTitle: 'Concert Payant',
    });
  });
});

describe('refund queue', () => {
  it('searches buyer email and booking reference in Postgres', async () => {
    const count = jest.fn();
    const prisma = prismaMock({ refund: { count, findMany: jest.fn() } });
    const service = new RefundsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.adminList(undefined, 1, 15, 'ada@example.test');

    const where = whereOf(count);
    expect(where.OR).toEqual([
      { booking: { buyerEmail: { contains: 'ada@example.test', mode: 'insensitive' } } },
      { booking: { reference: { contains: 'ada@example.test', mode: 'insensitive' } } },
    ]);
  });
});
