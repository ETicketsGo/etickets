import { EventStatus, PayoutStatus, RefundStatus, Role } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const user = { id: 'u1', roles: [] } as never;

const paidRow = (currency: string, subtotal: number, organizerFee = 0) => ({
  currency,
  _sum: {
    subtotalMinor: subtotal,
    bookingFeeMinor: 100,
    paymentFeeMinor: 50,
    organizerFeeMinor: organizerFee,
  },
});

/** A standing payout as the cursor query selects it. */
const openPayout = (id: string, currency: string) => ({
  id,
  currency,
  status: PayoutStatus.PENDING,
  periodEnd: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
});

/** `$transaction` runs its callback against the same mock, behind a recorded advisory lock. */
function withTransaction<T extends object>(prisma: T) {
  return Object.assign(prisma, {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(async (fn: (tx: T) => unknown) => fn(prisma)),
  });
}

function makeService(
  overrides: Record<string, unknown> = {},
  paid: object[] = [paidRow('INR', 10_000)],
  refunds: { currency: string; amountMinor: number }[] = [],
) {
  let created = 0;
  const prisma = withTransaction({
    // Read by `generate` to leave out events a provider transfer has already claimed, and by
    // the "why is nothing due" path. Empty is the ordinary case: no transfers, nothing held.
    settlement: { findMany: jest.fn().mockResolvedValue([]) },
    event: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { groupBy: jest.fn().mockResolvedValue(paid) },
    refund: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          refunds.map((r) => ({ amountMinor: r.amountMinor, booking: { currency: r.currency } })),
        ),
    },
    payout: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `p${++created}`,
        ...data,
      })),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'p1', status: PayoutStatus.PENDING, organizationId: 'o1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      ...(overrides.payout as object),
    },
  });
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    service: new PayoutsService(prisma as never, access as never, audit as never, holdDays(0)),
  };
}

/**
 * PAYOUT_HOLD_DAYS for a test.
 *
 * Zero in the specs that are about the money arithmetic: they fix bookings and refunds and
 * assert sums, and a hold would silently empty every window. The hold has its own tests.
 */
const holdDays = (days: number) => ({ get: () => days }) as never;

describe('PayoutsService (double-payout guards)', () => {
  it('generate refuses when an open payout already exists for the scope', async () => {
    const { service } = makeService({
      payout: { findMany: jest.fn().mockResolvedValue([openPayout('open1', 'INR')]) },
    });
    await expect(service.generate(user, 'o1')).rejects.toBeInstanceOf(AppException);
  });

  it('generate creates a payout when no open payout exists', async () => {
    const { service, prisma } = makeService();
    await service.generate(user, 'o1');
    expect(prisma.payout.create).toHaveBeenCalled();
  });

  it("takes the organization's generate lock before reading anything", async () => {
    // Two generates that both read "no open payout" before either wrote one paid twice.
    const { service, prisma } = makeService();
    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(async (...args: unknown[]) => {
      order.push(`lock:${args.slice(1).join()}`);
      return 1;
    });
    prisma.payout.findMany.mockImplementation(async () => {
      order.push('read');
      return [];
    });
    await service.generate(user, 'o1');
    expect(order.slice(0, 2)).toEqual(['lock:payout-generate:o1', 'read']);
    expect(prisma.payout.create).toHaveBeenCalled();
  });
});

/*
  Reported from QA: the dashboards added rupees, dollars and Canadian dollars into one figure.
  Payouts did the same at the source — every booking summed, whatever it was sold in, and the
  payout stored in the default currency. An organizer would have been paid rupees plus dollars
  as a number of rupees.
*/
describe('PayoutsService.generate — one payout per currency', () => {
  it('settles each currency on its own, in its own currency', async () => {
    const { service, prisma } = makeService(
      {},
      [paidRow('INR', 49_900, 1_000), paidRow('USD', 3_000, 100)],
      [{ currency: 'USD', amountMinor: 500 }],
    );
    const payouts = await service.generate(user, 'o1');
    expect(payouts).toHaveLength(2);
    const byCurrency = Object.fromEntries(
      prisma.payout.create.mock.calls.map(([{ data }]) => [data.currency, data]),
    );
    expect(byCurrency.INR).toMatchObject({ grossMinor: 49_900, refundMinor: 0, netMinor: 48_900 });
    expect(byCurrency.USD).toMatchObject({ grossMinor: 3_000, refundMinor: 500, netMinor: 2_400 });
  });

  it('still settles the dollars when the rupees already have an open payout', async () => {
    const { service, prisma } = makeService(
      { payout: { findMany: jest.fn().mockResolvedValue([openPayout('open', 'INR')]) } },
      [paidRow('INR', 10_000), paidRow('USD', 2_000)],
    );
    const payouts = await service.generate(user, 'o1');
    expect(payouts.map((p) => p.currency)).toEqual(['USD']);
    expect(prisma.payout.create).toHaveBeenCalledTimes(1);
  });

  it('creates nothing when there is no paid revenue, rather than a zero payout', async () => {
    const { service, prisma } = makeService({}, [], []);
    await expect(service.generate(user, 'o1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });
});

/*
  A cash booking's money is already in the organizer's till, so paying it out pays them twice.
  And `subtotalMinor` is the price before any coupon: a half-price booking was settled at full.
*/
describe('PayoutsService.generate — only money the platform actually took', () => {
  const bookings = [
    {
      currency: 'INR',
      paymentMethod: 'ONLINE',
      subtotalMinor: 100_000,
      discountMinor: 50_000,
      bookingFeeMinor: 2_000,
      paymentFeeMinor: 0,
      organizerFeeMinor: 1_000,
    },
    {
      currency: 'INR',
      paymentMethod: 'CASH',
      subtotalMinor: 40_000,
      discountMinor: 0,
      bookingFeeMinor: 0,
      paymentFeeMinor: 0,
      organizerFeeMinor: 0,
    },
  ];
  /** A groupBy over the rows above that honours the filter it is given. */
  const groupBy = jest.fn(
    async ({ where, _sum }: { where: { paymentMethod?: string }; _sum: Record<string, true> }) => {
      const rows = bookings.filter(
        (b) => !where.paymentMethod || b.paymentMethod === where.paymentMethod,
      );
      const byCurrency = new Map<string, Record<string, number>>();
      for (const row of rows) {
        const sums = byCurrency.get(row.currency) ?? {};
        for (const key of Object.keys(_sum)) {
          sums[key] = (sums[key] ?? 0) + (row as unknown as Record<string, number>)[key];
        }
        byCurrency.set(row.currency, sums);
      }
      return [...byCurrency].map(([currency, sums]) => ({ currency, _sum: sums }));
    },
  );

  it('settles online bookings at what the customer paid for the tickets', async () => {
    const { service, prisma } = makeService();
    prisma.booking.groupBy = groupBy;
    await service.generate(user, 'o1');
    expect(prisma.payout.create.mock.calls[0][0].data).toMatchObject({
      currency: 'INR',
      grossMinor: 100_000,
      // 100 000 − 50 000 coupon − 1 000 organizer fee; the 40 000 in cash is not the platform's.
      netMinor: 49_000,
    });
  });

  it('refuses a check-in staff member, who may not read or raise payouts', async () => {
    groupBy.mockClear();
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.CHECKIN_STAFF,
    });
    Object.assign(prisma, {
      booking: { groupBy },
      refund: { findMany: jest.fn().mockResolvedValue([]) },
      settlement: { findMany: jest.fn().mockResolvedValue([]) },
      event: { findMany: jest.fn().mockResolvedValue([]) },
    });
    await expect(service.generate(asUser(), 'org-1')).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
    expect(groupBy).not.toHaveBeenCalled();
  });
});

/*
  ── THE SETTLED CURSOR ────────────────────────────────────────────────────────────────
  `generate` summed every confirmed booking ever. The open-payout guard stopped two payouts
  being open at once, but the moment one was marked PAID the next generate paid the same
  revenue again. These run the service against an in-memory ledger whose queries honour the
  `where` they are given, so what is being tested is which rows each payout actually covers.
*/
describe('PayoutsService.generate — never pays the same revenue twice', () => {
  type Row = Record<string, unknown>;
  const OPERATORS = new Set(['in', 'notIn', 'gt', 'lte', 'not']);
  const LIST_PREDICATES = new Set(['some', 'none', 'every']);
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : v);

  /** Whether `row` satisfies the parts of a Prisma `where` the payout queries use. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === 'OR') return (condition as Row[]).some((branch) => matches(row, branch));
      // Prisma takes NOT as one filter or a list of them; the payout queries use both.
      if (key === 'NOT') {
        const branches = Array.isArray(condition) ? (condition as Row[]) : [condition as Row];
        return branches.every((branch) => !matches(row, branch));
      }
      const value = row[key];
      if (condition === null || typeof condition !== 'object' || condition instanceof Date) {
        return time(value) === time(condition);
      }
      const ops = condition as Row;
      const keys = Object.keys(ops);
      // A predicate on a list of related rows, e.g. `sessions: { none: { endsAt: { gt } } }`.
      if (keys.length > 0 && keys.every((k) => LIST_PREDICATES.has(k))) {
        const list = Array.isArray(value) ? (value as Row[]) : [];
        return keys.every((k) => {
          const predicate = ops[k] as Row;
          if (k === 'some') return list.some((item) => matches(item, predicate));
          if (k === 'none') return !list.some((item) => matches(item, predicate));
          return list.every((item) => matches(item, predicate));
        });
      }
      // Not an operator object: a filter on a related row, e.g. `booking: { currency }`.
      if (!keys.every((k) => OPERATORS.has(k))) return matches((value ?? {}) as Row, ops);
      return keys.every((op) => {
        const expected = ops[op];
        switch (op) {
          case 'in':
            return (expected as unknown[]).includes(value);
          case 'notIn':
            return !(expected as unknown[]).includes(value);
          case 'gt':
            return value != null && (time(value) as number) > (time(expected) as number);
          case 'lte':
            return value != null && (time(value) as number) <= (time(expected) as number);
          default:
            return time(value) !== time(expected);
        }
      });
    });
  }

  function ledger(holdDaysForTest = 0) {
    const bookings: Row[] = [];
    const refunds: Row[] = [];
    const payouts: Row[] = [];
    const settlements: Row[] = [];
    const prisma = withTransaction({
      settlement: {
        findMany: jest.fn(async ({ where }: { where: Row }) =>
          settlements.filter((row) => matches(row, where)),
        ),
      },
      event: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          [...events.values()].filter((row) => where.id.in.includes(row.id as string)),
        ),
      },
      booking: {
        /*
          Grouped by whatever `by` asks for, because `generate` sums per currency and the
          "what is held" query sums per event AND currency.
        */
        groupBy: jest.fn(
          async ({ where, by, _sum }: { where: Row; by: string[]; _sum: Record<string, true> }) => {
            const keys = by ?? ['currency'];
            const sums = new Map<string, Record<string, number>>();
            const grouped = new Map<string, Row>();
            for (const b of bookings.filter((row) => matches(row, where))) {
              const id = keys.map((k) => String(b[k])).join('|');
              const s = sums.get(id) ?? {};
              for (const key of Object.keys(_sum)) s[key] = (s[key] ?? 0) + (b[key] as number);
              sums.set(id, s);
              grouped.set(id, Object.fromEntries(keys.map((k) => [k, b[k]])));
            }
            return [...sums].map(([id, s]) => ({ ...grouped.get(id), _sum: s }) as Row);
          },
        ),
      },
      refund: {
        findMany: jest.fn(async ({ where }: { where: Row }) =>
          refunds
            .filter((row) => matches(row, where))
            .map((row) => ({
              amountMinor: row.amountMinor,
              booking: { currency: (row.booking as Row).currency },
            })),
        ),
      },
      payout: {
        findMany: jest.fn(async ({ where }: { where: Row }) =>
          payouts.filter((row) => matches(row, where)),
        ),
        create: jest.fn(async ({ data }: { data: Row }) => {
          const payout = {
            id: `p${payouts.length + 1}`,
            createdAt: new Date(),
            ...data,
            eventId: data.eventId ?? null,
          };
          payouts.push(payout);
          return payout;
        }),
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) =>
            payouts.find((p) => p.id === where.id) ?? null,
        ),
        updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
          const hit = payouts.filter((row) => matches(row, where));
          for (const row of hit) Object.assign(row, data);
          return { count: hit.length };
        }),
      },
    });
    const service = new PayoutsService(
      prisma as never,
      { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      holdDays(holdDaysForTest),
    );

    /*
      Events, because a booking's money is only payable once its event is over. Each one is
      COMPLETED and ended in 2000 unless a test says otherwise, so the arithmetic tests below
      are about the arithmetic and the hold tests are about the hold.
    */
    const events = new Map<string, Row>();
    const event = (id: string, over: { status?: string; lastEndsAt?: string } = {}) => {
      const row = {
        id,
        title: `Event ${id}`,
        status: over.status ?? EventStatus.COMPLETED,
        sessions: [{ endsAt: new Date(over.lastEndsAt ?? '2000-01-01T00:00:00Z') }],
      };
      events.set(id, row);
      return row;
    };

    const book = (currency: string, subtotalMinor: number, confirmedAt: string, eventId = 'e1') => {
      const booking = {
        organizationId: 'o1',
        eventId,
        event: events.get(eventId) ?? event(eventId),
        currency,
        paymentMethod: 'ONLINE',
        confirmedAt: new Date(confirmedAt),
        subtotalMinor,
        discountMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        organizerFeeMinor: 0,
      };
      bookings.push(booking);
      return booking;
    };
    const refund = (booking: Row, amountMinor: number, completedAt: string) =>
      refunds.push({
        organizationId: 'o1',
        status: RefundStatus.COMPLETED,
        amountMinor,
        updatedAt: new Date(completedAt),
        booking,
      });
    /** Org-wide by default; pass an event to raise that event's own payout. */
    const generateAt = async (iso: string, eventId?: string) => {
      jest.setSystemTime(new Date(iso));
      return service.generate(user, 'o1', eventId);
    };
    const payAt = async (id: string, iso: string) => {
      jest.setSystemTime(new Date(iso));
      return service.markPaid(user, id);
    };
    return { prisma, payouts, settlements, event, book, refund, generateAt, payAt };
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('pays only bookings confirmed since the last PAID payout', async () => {
    const { book, generateAt, payAt } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z');
    const [first] = await generateAt('2026-09-01T10:00:00Z');
    expect(first).toMatchObject({
      grossMinor: 10_000,
      periodStart: null,
      periodEnd: new Date('2026-09-01T10:00:00Z'),
    });
    await payAt(first.id, '2026-09-01T11:00:00Z');

    book('INR', 4_000, '2026-09-02T09:00:00Z');
    const [second] = await generateAt('2026-09-02T10:00:00Z');
    // Without the cursor this was 14 000: the 10 000 already paid out, paid out again.
    expect(second).toMatchObject({
      grossMinor: 4_000,
      netMinor: 4_000,
      periodStart: new Date('2026-09-01T10:00:00Z'),
      periodEnd: new Date('2026-09-02T10:00:00Z'),
    });
  });

  it('creates nothing when no new revenue has arrived since the last payout', async () => {
    const { book, generateAt, payAt, prisma } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z');
    const [first] = await generateAt('2026-09-01T10:00:00Z');
    await payAt(first.id, '2026-09-01T11:00:00Z');

    await expect(generateAt('2026-09-02T10:00:00Z')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
    expect(prisma.payout.create).toHaveBeenCalledTimes(1);
  });

  it('does not advance past a FAILED payout, whose revenue is still owed', async () => {
    const { book, generateAt, payouts } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z');
    const [first] = await generateAt('2026-09-01T10:00:00Z');
    // The transfer bounced: nothing reached the organizer.
    Object.assign(
      payouts.find((p) => p.id === first.id)!,
      { status: PayoutStatus.FAILED },
    );

    const [retry] = await generateAt('2026-09-02T10:00:00Z');
    expect(retry).toMatchObject({ grossMinor: 10_000, periodStart: null });
  });

  it('deducts a refund in the period it completed in, including from revenue already paid', async () => {
    const { book, refund, generateAt, payAt } = ledger();
    const paidOut = book('INR', 10_000, '2026-09-01T09:00:00Z');
    refund(paidOut, 1_000, '2026-09-01T09:30:00Z');
    const [first] = await generateAt('2026-09-01T10:00:00Z');
    expect(first).toMatchObject({ grossMinor: 10_000, refundMinor: 1_000, netMinor: 9_000 });
    await payAt(first.id, '2026-09-01T11:00:00Z');

    book('INR', 8_000, '2026-09-02T09:00:00Z');
    refund(paidOut, 5_000, '2026-09-02T09:30:00Z');
    const [second] = await generateAt('2026-09-02T10:00:00Z');
    // The 1 000 was deducted last time and is not deducted again; the 5 000 is new.
    expect(second).toMatchObject({ grossMinor: 8_000, refundMinor: 5_000, netMinor: 3_000 });
  });

  it('records a period whose refunds exceed its revenue, with a negative net', async () => {
    // A clawback an admin has to see — dropping it would forgive the deduction silently.
    const { book, refund, generateAt, payAt } = ledger();
    const paidOut = book('INR', 10_000, '2026-09-01T09:00:00Z');
    const [first] = await generateAt('2026-09-01T10:00:00Z');
    await payAt(first.id, '2026-09-01T11:00:00Z');

    refund(paidOut, 6_000, '2026-09-02T09:00:00Z');
    const [second] = await generateAt('2026-09-02T10:00:00Z');
    expect(second).toMatchObject({
      grossMinor: 0,
      refundMinor: 6_000,
      netMinor: -6_000,
      status: PayoutStatus.PENDING,
    });
  });

  it('treats a payout from before periods were recorded as settling everything until it was made', async () => {
    const { book, generateAt, payouts } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z');
    payouts.push({
      id: 'legacy',
      organizationId: 'o1',
      eventId: null,
      currency: 'INR',
      status: PayoutStatus.PAID,
      periodStart: null,
      periodEnd: null,
      createdAt: new Date('2026-09-01T10:00:00Z'),
    });
    book('INR', 4_000, '2026-09-02T09:00:00Z');

    const [next] = await generateAt('2026-09-03T10:00:00Z');
    expect(next).toMatchObject({
      grossMinor: 4_000,
      periodStart: new Date('2026-09-01T10:00:00Z'),
    });
  });

  /*
    An org-wide payout covers every event, so it and an event's own payout overlap. Each scope
    used to keep its own cursor, and settling one never moved the other.
  */
  it("does not pay an event's revenue again after an org-wide payout covered it", async () => {
    const { book, generateAt, payAt } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z');
    const [orgWide] = await generateAt('2026-09-01T10:00:00Z');
    await payAt(orgWide.id, '2026-09-01T11:00:00Z');

    // Without the shared cursor the event's own payout was the same 10 000 again.
    await expect(generateAt('2026-09-02T10:00:00Z', 'e1')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });

    book('INR', 4_000, '2026-09-02T12:00:00Z');
    const [eventPayout] = await generateAt('2026-09-02T13:00:00Z', 'e1');
    expect(eventPayout).toMatchObject({
      eventId: 'e1',
      grossMinor: 4_000,
      periodStart: new Date('2026-09-01T10:00:00Z'),
    });
  });

  it('leaves out of an org-wide payout the event revenue an event payout already settled', async () => {
    const { book, refund, generateAt, payAt } = ledger();
    const sold = book('INR', 10_000, '2026-09-01T09:00:00Z', 'e1');
    book('INR', 3_000, '2026-09-01T09:00:00Z', 'e2');
    refund(sold, 1_000, '2026-09-01T09:30:00Z');
    const [eventPayout] = await generateAt('2026-09-01T10:00:00Z', 'e1');
    expect(eventPayout).toMatchObject({ grossMinor: 10_000, refundMinor: 1_000 });
    await payAt(eventPayout.id, '2026-09-01T10:30:00Z');

    const [orgWide] = await generateAt('2026-09-01T11:00:00Z');
    // Only e2: e1's sale and its refund were both settled by e1's own payout.
    expect(orgWide).toMatchObject({ grossMinor: 3_000, refundMinor: 0, netMinor: 3_000 });
    await payAt(orgWide.id, '2026-09-01T11:30:00Z');

    // After the org-wide payout, e1's new revenue is org-wide revenue like any other.
    book('INR', 2_000, '2026-09-01T12:00:00Z', 'e1');
    const [later] = await generateAt('2026-09-01T13:00:00Z');
    expect(later).toMatchObject({
      grossMinor: 2_000,
      periodStart: new Date('2026-09-01T11:00:00Z'),
    });
  });

  it('will not raise an org-wide payout while an event payout is still open', async () => {
    const { book, generateAt, payouts } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z', 'e1');
    book('INR', 3_000, '2026-09-01T09:00:00Z', 'e2');
    await generateAt('2026-09-01T10:00:00Z', 'e1');
    await expect(generateAt('2026-09-01T11:00:00Z')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });

    // The event payout bounced, so its revenue is still owed — and the org-wide payout takes it.
    Object.assign(
      payouts.find((p) => p.eventId === 'e1')!,
      { status: PayoutStatus.FAILED },
    );
    const [orgWide] = await generateAt('2026-09-01T12:00:00Z');
    expect(orgWide).toMatchObject({ grossMinor: 13_000, periodStart: null });
  });

  it('will not raise an event payout while an org-wide payout is still open', async () => {
    const { book, generateAt } = ledger();
    book('INR', 10_000, '2026-09-01T09:00:00Z', 'e1');
    await generateAt('2026-09-01T10:00:00Z');
    book('INR', 2_000, '2026-09-01T10:30:00Z', 'e1');
    await expect(generateAt('2026-09-01T11:00:00Z', 'e1')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  /*
    ── MONEY WAITS FOR THE SHOW ───────────────────────────────────────────────────────
    The ledger had no time rule at all: revenue was settleable the moment a booking was
    confirmed, for an event months away. An organizer could take the gate money for a
    festival and then not put it on, and a customer refunded after a payout is money the
    platform has to chase back from somebody who has already spent it.
  */
  it('will not settle an event that has not happened yet', async () => {
    const { book, event, generateAt } = ledger(7);
    event('future', { status: EventStatus.PUBLISHED, lastEndsAt: '2026-12-01T20:00:00Z' });
    book('INR', 100_000, '2026-09-01T10:00:00Z', 'future');

    await expect(generateAt('2026-09-02T10:00:00Z')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('still will not, the day after the show, while the hold runs', async () => {
    const { book, event, generateAt } = ledger(7);
    event('done', { lastEndsAt: '2026-09-10T20:00:00Z' });
    book('INR', 100_000, '2026-09-01T10:00:00Z', 'done');

    await expect(generateAt('2026-09-11T10:00:00Z')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('settles it once the hold has run', async () => {
    const { book, event, generateAt } = ledger(7);
    event('done', { lastEndsAt: '2026-09-10T20:00:00Z' });
    book('INR', 100_000, '2026-09-01T10:00:00Z', 'done');

    const [payout] = await generateAt('2026-09-17T21:00:00Z');
    expect(payout.netMinor).toBe(100_000);
  });

  it('says what is held and when it becomes payable, rather than "no revenue"', async () => {
    // An organizer who can see the sales on their dashboard reads a flat refusal as a bug.
    const { book, event, generateAt } = ledger(7);
    event('gig', { lastEndsAt: '2026-09-10T20:00:00Z' });
    book('INR', 250_000, '2026-09-01T10:00:00Z', 'gig');

    const failure = await generateAt('2026-09-11T10:00:00Z').catch((e) => e);
    expect(failure).toBeInstanceOf(AppException);
    expect(failure.details.held).toEqual([
      expect.objectContaining({ eventTitle: 'Event gig', grossMinor: 250_000 }),
    ]);
    expect(failure.message).toContain('2026-09-17');
  });

  it('holds the whole run when a date is added to it', async () => {
    // A run is over when its LAST show is over, so an added date extends the hold by itself.
    const { book, event, generateAt } = ledger(0);
    const run = event('run', { lastEndsAt: '2026-09-10T20:00:00Z' });
    book('INR', 100_000, '2026-09-01T10:00:00Z', 'run');
    (run.sessions as { endsAt: Date }[]).push({ endsAt: new Date('2026-10-05T20:00:00Z') });

    await expect(generateAt('2026-09-12T10:00:00Z')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('never settles a cancelled event, whose money is owed back to customers', async () => {
    const { book, event, generateAt } = ledger(0);
    event('off', { status: EventStatus.CANCELLED, lastEndsAt: '2026-09-10T20:00:00Z' });
    book('INR', 100_000, '2026-09-01T10:00:00Z', 'off');

    const failure = await generateAt('2026-09-20T10:00:00Z').catch((e) => e);
    expect(failure).toBeInstanceOf(AppException);
    // Not even listed as held: that would promise money which is never coming.
    expect(failure.details?.held ?? []).toHaveLength(0);
  });

  it('settles the events that are ready and leaves the rest', async () => {
    const { book, event, generateAt } = ledger(0);
    event('over', { lastEndsAt: '2026-09-01T20:00:00Z' });
    event('soon', { status: EventStatus.PUBLISHED, lastEndsAt: '2026-12-01T20:00:00Z' });
    book('INR', 60_000, '2026-08-20T10:00:00Z', 'over');
    book('INR', 90_000, '2026-08-21T10:00:00Z', 'soon');

    const [payout] = await generateAt('2026-09-05T10:00:00Z');
    expect(payout.netMinor).toBe(60_000);
  });

  it('leaves a held event refund out too, rather than clawing back money never paid', async () => {
    /*
      Deducting a refund for revenue this payout did not include would leave the organizer
      short by the refund, and the ledger with no way to explain the difference.
    */
    const { book, event, refund, generateAt } = ledger(0);
    event('over', { lastEndsAt: '2026-09-01T20:00:00Z' });
    event('soon', { status: EventStatus.PUBLISHED, lastEndsAt: '2026-12-01T20:00:00Z' });
    book('INR', 60_000, '2026-08-20T10:00:00Z', 'over');
    const held = book('INR', 90_000, '2026-08-21T10:00:00Z', 'soon');
    refund(held, 90_000, '2026-09-04T10:00:00Z');

    const [payout] = await generateAt('2026-09-05T10:00:00Z');
    expect(payout.refundMinor).toBe(0);
    expect(payout.netMinor).toBe(60_000);
  });

  /*
    ── AND NEVER TWICE THROUGH TWO SYSTEMS ────────────────────────────────────────────
    A provider transfer (Stripe / Razorpay Route) pays the organizer directly; this ledger
    records what is owed and is settled by a bank transfer somebody makes by hand. Nothing
    connected the two, so one event's revenue could go out both ways and the second payment
    would look exactly like the first.
  */
  it('leaves out an event whose money a transfer has already moved', async () => {
    const { book, event, settlements, generateAt } = ledger(0);
    event('paid', { lastEndsAt: '2026-09-01T20:00:00Z' });
    event('unpaid', { lastEndsAt: '2026-09-01T20:00:00Z' });
    book('INR', 70_000, '2026-08-20T10:00:00Z', 'paid');
    book('INR', 40_000, '2026-08-20T10:00:00Z', 'unpaid');
    settlements.push({ organizationId: 'o1', eventId: 'paid', status: 'TRANSFERRED' });

    const [payout] = await generateAt('2026-09-05T10:00:00Z');
    expect(payout.netMinor).toBe(40_000);
  });

  it('leaves it out while the transfer is still in flight', async () => {
    // TRANSFER_PROCESSING is money already handed to the provider. Waiting for the webhook
    // before excluding it is a window in which both systems would pay.
    const { book, event, settlements, generateAt } = ledger(0);
    event('paid', { lastEndsAt: '2026-09-01T20:00:00Z' });
    book('INR', 70_000, '2026-08-20T10:00:00Z', 'paid');
    settlements.push({ organizationId: 'o1', eventId: 'paid', status: 'TRANSFER_PROCESSING' });

    await expect(generateAt('2026-09-05T10:00:00Z')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('still settles an event whose transfer was only approved, not sent', async () => {
    // APPROVED has moved no money. Excluding it would strand the revenue in neither system.
    const { book, event, settlements, generateAt } = ledger(0);
    event('ready', { lastEndsAt: '2026-09-01T20:00:00Z' });
    book('INR', 70_000, '2026-08-20T10:00:00Z', 'ready');
    settlements.push({ organizationId: 'o1', eventId: 'ready', status: 'APPROVED' });

    const [payout] = await generateAt('2026-09-05T10:00:00Z');
    expect(payout.netMinor).toBe(70_000);
  });
});

describe('PayoutsService (markPaid)', () => {
  it('markPaid is idempotent: a second finalize is rejected (claim count 0)', async () => {
    const { service } = makeService({
      payout: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'p1', status: PayoutStatus.PAID, organizationId: 'o1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });
    await expect(service.markPaid(user, 'p1')).rejects.toBeInstanceOf(AppException);
  });

  it('markPaid finalizes an open payout exactly once', async () => {
    const { service, prisma } = makeService();
    await service.markPaid(user, 'p1');
    expect(prisma.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PayoutStatus.PAID }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// listForOrg financial-read RBAC (D8) — real OrgAccessService, mocked Prisma.
// ---------------------------------------------------------------------------

const asUser = (globalRoles: string[] = []): RequestUser => ({
  id: 'u1',
  email: 'u1@example.test',
  fullName: 'User One',
  roles: globalRoles as never,
});

function makeServiceWithAccess(membership: { status: string; role: string } | null) {
  const prisma = {
    organizationMember: { findUnique: jest.fn().mockResolvedValue(membership) },
    payout: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const access = new OrgAccessService(prisma as never);
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    service: new PayoutsService(prisma as never, access, audit as never, holdDays(0)),
  };
}

describe('PayoutsService.listForOrg financial-read gating', () => {
  it('FORBIDS an active CHECKIN_STAFF member', async () => {
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.CHECKIN_STAFF,
    });
    await expect(service.listForOrg(asUser(), 'org-1')).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
  });

  it('allows ORGANIZER_OWNER', async () => {
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.ORGANIZER_OWNER,
    });
    await expect(service.listForOrg(asUser(), 'org-1')).resolves.toEqual([]);
    expect(prisma.payout.findMany).toHaveBeenCalled();
  });

  it('allows ORGANIZER_MANAGER', async () => {
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.ORGANIZER_MANAGER,
    });
    await expect(service.listForOrg(asUser(), 'org-1')).resolves.toEqual([]);
    expect(prisma.payout.findMany).toHaveBeenCalled();
  });

  it('allows a platform admin (no membership needed)', async () => {
    const { service, prisma } = makeServiceWithAccess(null);
    await expect(service.listForOrg(asUser([Role.ADMIN]), 'org-1')).resolves.toEqual([]);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.payout.findMany).toHaveBeenCalled();
  });
});
