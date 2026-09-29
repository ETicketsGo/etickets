import { PrismaClient } from '@prisma/client';
import { AdminGroupingService, GROUPABLE } from './admin-grouping.service';
import { GROUP_KEY_NONE, groupScopeWhere } from './group-scope';

/**
 * Every grouped summary runs, and the number it reports is the number of rows the list shows.
 *
 * ── WHY THIS HAS TO BE A REAL DATABASE ─────────────────────────────────────────────
 * `AdminGroupingService` builds SQL as strings. TypeScript checks none of it: a column that does
 * not exist, a join to a table that does not, a `GROUP BY` that disagrees with its `SELECT` are
 * all perfectly well-typed and all fail the instant an operator chooses that grouping.
 *
 * The first draft of that file proved the point. Three refund shapes joined `"Payment" p ON
 * p.id = r."paymentId"`, and `Refund` has no `paymentId`. It compiled, the unit tests passed, and
 * every one of those three queries would have thrown at runtime. Only Postgres can say.
 *
 * ── THE SECOND THING THIS PROVES ───────────────────────────────────────────────────
 * A summary and the list under it are two different queries - raw SQL and Prisma - written to
 * select the same rows. If they disagree, the console shows a group of 12 and then a list of 9,
 * and nothing on screen says which is right. So every group's count is checked against a real
 * count through the real `where` builder.
 */
/**
 * Compares two queries that are taken a moment apart against a live database.
 *
 * The suite runs its files in parallel and several of them create bookings, so between reading a
 * summary and counting the list underneath it the data can genuinely change - and it did: a group
 * of 1 against a list of 2, on an event with exactly one confirmed booking by the time anyone
 * looked. A real disagreement between the SQL and the Prisma `where` reproduces every time; a
 * concurrent insert does not. So one retry tells them apart without weakening the assertion.
 */
async function agrees<T>(read: () => Promise<T>, expected: () => Promise<T>): Promise<void> {
  const first = await read();
  const firstExpected = await expected();
  if (JSON.stringify(first) === JSON.stringify(firstExpected)) {
    expect(first).toEqual(firstExpected);
    return;
  }
  expect(await read()).toEqual(await expected());
}

const prisma = new PrismaClient();
const service = new AdminGroupingService(prisma as never);

/** The list query each resource's rows come from, through the same scope the console sends. */
const COUNTS: Record<string, (where: Record<string, unknown>) => Promise<number>> = {
  bookings: (where) => prisma.booking.count({ where }),
  payments: (where) => prisma.payment.count({ where }),
  refunds: (where) => prisma.refund.count({ where }),
  events: (where) => prisma.event.count({ where }),
  organizers: (where) => prisma.organization.count({ where }),
  settlements: (where) => prisma.settlement.count({ where }),
};

afterAll(async () => {
  await prisma.$disconnect();
});

describe('every grouped summary the console can ask for', () => {
  const pairs = Object.entries(GROUPABLE).flatMap(([resource, groupings]) =>
    groupings.map((groupBy) => [resource, groupBy] as const),
  );

  it('covers all six queues', () => {
    // Guard on the guard: a shrunken GROUPABLE would silently reduce this file to nothing.
    expect(new Set(pairs.map(([r]) => r)).size).toBe(6);
    expect(pairs.length).toBeGreaterThan(10);
  });

  for (const [resource, groupBy] of pairs) {
    it(`runs: ${resource} by ${groupBy}`, async () => {
      const summary = await service.grouped(resource, groupBy);
      expect(summary.resource).toBe(resource);
      expect(summary.groupBy).toBe(groupBy);

      for (const group of summary.groups) {
        // A count is a count: never negative, never fractional, and never a bigint that leaked
        // out of the driver as one (`Number()` in the service is what stops that).
        expect(Number.isInteger(group.count)).toBe(true);
        expect(group.count).toBeGreaterThan(0);
        expect(typeof group.label).toBe('string');
        // Money is per currency, and two entries for one currency would mean the stitching
        // dropped a row rather than merging it.
        const currencies = group.totals.map((t) => t.currency);
        expect(new Set(currencies).size).toBe(currencies.length);
      }
    });

    it(`agrees with the list: ${resource} by ${groupBy}`, async () => {
      const summary = await service.grouped(resource, groupBy);
      if (summary.groups.length === 0) return;

      /*
        The largest group, because it is the one an operator clicks and the one most likely to
        expose a join that multiplies rows. `groupKey` is what the console sends: the group's key,
        or the sentinel when the key is null.
      */
      const group = summary.groups[0];
      const listed = await COUNTS[resource](
        groupScopeWhere(resource as never, {
          groupBy,
          groupKey: group.key ?? GROUP_KEY_NONE,
        }),
      );
      /*
        Compared as a described pair rather than two bare numbers: jest's `expect` takes no
        message, and "expected 9 to be 12" does not say which group, on which queue, disagreed.
      */
      expect({ group: group.label, listed }).toEqual({ group: group.label, listed: group.count });
    });
  }

  /*
    ── THE SUMMARY AND THE LIST UNDER THE SAME FILTER ─────────────────────────────────
    The queues do not open unfiltered. Refunds opens on REQUESTED and events on UNDER_REVIEW, and
    before the summary took the filter too it counted every row of the resource: the refund screen
    read "India - 1 row" above an empty table, because the one refund in the database was already
    COMPLETED. Both numbers were right and the pair was useless.

    So the check is done again with a status that actually occurs in the data, per queue.
  */
  const STATUS_COLUMN: Record<string, () => Promise<string | undefined>> = {
    bookings: async () => (await prisma.booking.findFirst({ select: { status: true } }))?.status,
    payments: async () => (await prisma.payment.findFirst({ select: { status: true } }))?.status,
    refunds: async () => (await prisma.refund.findFirst({ select: { status: true } }))?.status,
    events: async () => (await prisma.event.findFirst({ select: { status: true } }))?.status,
    organizers: async () =>
      (await prisma.organization.findFirst({ select: { status: true } }))?.status,
    settlements: async () =>
      (await prisma.settlement.findFirst({ select: { status: true } }))?.status,
  };

  for (const [resource, groupBy] of pairs) {
    it(`agrees with the list under a status filter: ${resource} by ${groupBy}`, async () => {
      const status = await STATUS_COLUMN[resource]();
      if (!status) return;

      const summary = await service.grouped(resource, groupBy, { status });

      /*
        TOTALS, not the largest group. An earlier version asserted on `groups[0]` and returned
        early when there were none - so pointing the refund filter at the BOOKING's status column
        instead of the refund's made the summary return nothing and the test passed vacuously.
        Every row of the filtered list belongs to exactly one group, so the counts must sum to it,
        and a summary that finds nothing now fails against a list that finds something.
      */
      const counted = summary.groups.reduce((n, g) => n + g.count, 0);
      const listed = await COUNTS[resource]({ status: status as never });
      expect({ status, counted }).toEqual({ status, counted: listed });
    });

    it(`scopes the list to a group under a status filter: ${resource} by ${groupBy}`, async () => {
      const status = await STATUS_COLUMN[resource]();
      if (!status) return;
      const summary = await service.grouped(resource, groupBy, { status });
      if (summary.groups.length === 0) return;

      const group = summary.groups[0];
      const scoped = () =>
        COUNTS[resource]({
          status: status as never,
          ...groupScopeWhere(resource as never, {
            groupBy,
            groupKey: group.key ?? GROUP_KEY_NONE,
          }),
        });
      await agrees(
        async () => ({ status, group: group.label, listed: await scoped() }),
        async () => ({
          status,
          group: group.label,
          listed: (await service.grouped(resource, groupBy, { status })).groups.find(
            (g) => g.key === group.key,
          )?.count,
        }),
      );
    });
  }

  it('counts fewer rows under a filter than without one, or the filter is not applied', async () => {
    /*
      The guard that makes the two tests above mean something. If `status` were silently dropped,
      every assertion would still pass - the filtered list and the unfiltered summary would just
      both be wrong in the same direction on a database where one status happens to hold every row.
      This picks a resource whose rows span more than one status and proves the total shrinks.
    */
    const statuses = await prisma.booking.groupBy({ by: ['status'], _count: true });
    if (statuses.length < 2) return;

    const all = await service.grouped('bookings', 'country');
    const one = await service.grouped('bookings', 'country', { status: statuses[0].status });
    const total = (s: typeof all) => s.groups.reduce((n, g) => n + g.count, 0);
    expect(total(one)).toBeLessThan(total(all));
  });

  it('ignores case in a search, the way the lists do', async () => {
    const booking = await prisma.booking.findFirst({ select: { buyerEmail: true } });
    if (!booking?.buyerEmail) return;
    const lower = await service.grouped('bookings', 'country', { q: booking.buyerEmail });
    const upper = await service.grouped('bookings', 'country', {
      q: booking.buyerEmail.toUpperCase(),
    });
    const total = (s: typeof lower) => s.groups.reduce((n, g) => n + g.count, 0);
    expect(total(upper)).toBe(total(lower));
    expect(total(lower)).toBeGreaterThan(0);
  });

  it('labels a settlement currency the way a person writes one, and still filters by it', async () => {
    /*
      `Settlement.currency` is stored lower-case because it is half of the `eventId_currency`
      unique key. That is right for the data and wrong for a chip: "usd" beside "India" reads as
      unfinished. So the label is upper-cased and the KEY is not - upper-casing the key would make
      every chip filter to nothing, because the list compares it against the stored value.

      The row is CREATED here rather than assumed. The first version of this test returned early
      when there were no settlements, which is the state of most databases - so upper-casing the
      key as well, the exact bug it is meant to catch, left it green.
    */
    const event = await prisma.event.findFirst({ select: { id: true, organizationId: true } });
    if (!event) return;

    const currency = 'usd';
    const settlement = await prisma.settlement.upsert({
      where: { eventId_currency: { eventId: event.id, currency } },
      create: { eventId: event.id, organizationId: event.organizationId, currency },
      update: {},
      select: { id: true },
    });
    const mine = (await prisma.settlement.findUnique({ where: { id: settlement.id } }))!;

    try {
      const summary = await service.grouped('settlements', 'currency');
      const group = summary.groups.find((g) => g.key === currency);
      // jest's expect takes no message, so the context goes in the value being compared.
      expect({ found: Boolean(group), currency }).toEqual({ found: true, currency });
      expect(group!.label).toBe('USD');
      expect(group!.key).toBe('usd');

      // The key is what the console sends back, so it has to still select the same rows.
      const listed = await prisma.settlement.count({
        where: groupScopeWhere('settlements', { groupBy: 'currency', groupKey: group!.key ?? '' }),
      });
      expect({ label: group!.label, listed }).toEqual({
        label: group!.label,
        listed: group!.count,
      });
    } finally {
      // Only if this test created it; an upsert that found an existing row must not delete it.
      if (mine.createdAt.getTime() > Date.now() - 60_000) {
        await prisma.settlement.delete({ where: { id: settlement.id } }).catch(() => {});
      }
    }
  });

  it('refuses a resource it does not group', async () => {
    await expect(service.grouped('users', 'country')).rejects.toThrow(/Cannot group "users"/);
  });

  it('refuses a grouping the resource does not offer', async () => {
    await expect(service.grouped('organizers', 'event')).rejects.toThrow(
      /cannot be grouped by event/,
    );
  });
});
