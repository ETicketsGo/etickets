import { BookingsService } from './bookings.service';
import { BookingHoldLimitsService } from './booking-hold-limits';

/**
 * Holding seats without paying for them, at scale - and the ordinary customer who must not notice.
 *
 * ── WHAT WAS POSSIBLE ──────────────────────────────────────────────────────────────
 * `POST /bookings/guest` is public, and nothing bounded how many unpaid holds one caller could
 * open, so a script could make a sold-out show look sold out to everybody else; a "pay at the
 * venue" reservation held its seats until showtime, for free. `maxPerOrder` was checked line by
 * line, so the same ticket type sent as five lines bought five times the limit. And an
 * idempotency key was global: another buyer sending the same key got the first buyer's booking.
 *
 * ── HOW THIS FILE TESTS IT ─────────────────────────────────────────────────────────
 * Through `BookingsService.create`, the real code path, over a small in-memory database that
 * keeps the three Postgres behaviours the protections rely on: a transaction's rows are
 * invisible to others until it commits, `pg_advisory_xact_lock` blocks until the holder commits,
 * and a second insert on a unique key waits for the first transaction and then fails. Without
 * those a mock agrees with any answer, so parallel tests would prove nothing. The same rules are
 * proven against a real database in booking-hold-limits.integration-postgres.spec.ts.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

/** The few Postgres semantics `create` depends on, and nothing else. */
class FakeDb {
  bookings: Row[] = [];
  records = new Map<string, Row>();
  private claims = new Map<string, Promise<void>>();
  private locks = new Map<string, Promise<void>>();
  private seq = 0;

  private live(b: Row, now: Date) {
    return b.status === 'PENDING_PAYMENT' && b.holdExpiresAt > now;
  }

  private matches(b: Row, where: Row): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'holdExpiresAt') {
        if (!(b.holdExpiresAt > v.gt)) return false;
      } else if (k === 'buyerEmail') {
        if (String(b.buyerEmail).toLowerCase() !== String(v.equals).toLowerCase()) return false;
      } else if (b[k] !== v) return false;
    }
    return true;
  }

  client() {
    const db = this;
    return {
      eventSession: { findUnique: jest.fn() },
      ticketType: { findMany: jest.fn() },
      coupon: { findUnique: jest.fn().mockResolvedValue(null) },
      booking: {
        // The lazy expiry sweep `create` runs first; the fake ages nothing out on its own.
        findMany: jest.fn().mockResolvedValue([]),
      },
      idempotencyRecord: {
        findUnique: jest.fn(async ({ where }: Row) => {
          const r = db.records.get(`${where.scope_key.scope}|${where.scope_key.key}`);
          return r ? { ...r } : null;
        }),
        update: jest.fn(async ({ where, data }: Row) => {
          const k = `${where.scope_key.scope}|${where.scope_key.key}`;
          const r = db.records.get(k);
          if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
          Object.assign(r, data);
          return r;
        }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => db.transaction(fn),
    };
  }

  async transaction(fn: (tx: unknown) => Promise<unknown>) {
    const done = deferred();
    const newBookings: Row[] = [];
    const newRecords = new Map<string, Row>();
    const myClaims: string[] = [];
    const myLocks: string[] = [];
    const visible = () => [...this.bookings, ...newBookings];
    const db = this;

    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('pg_advisory_xact_lock')) {
          const key = String(values[0]);
          while (db.locks.has(key)) await db.locks.get(key);
          db.locks.set(key, done.promise);
          myLocks.push(key);
          return 1;
        }
        if (sql.includes('DELETE FROM "IdempotencyRecord"')) {
          const [scope, now] = values as [string, Date];
          for (const [k, r] of db.records) {
            const b = visible().find((x) => x.id === r.key);
            if (r.scope === scope && !(b && db.live(b, now))) db.records.delete(k);
          }
          return 0;
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const [scope, now] = values as [string, Date];
        const rows = [...db.records.values(), ...newRecords.values()].filter(
          (r) => r.scope === scope,
        );
        const n = rows.filter((r) => {
          const b = visible().find((x) => x.id === r.key);
          return b && db.live(b, now);
        }).length;
        return [{ n }];
      },
      booking: {
        count: async ({ where }: Row) => visible().filter((b) => db.matches(b, where)).length,
        create: async ({ data }: Row) => {
          await tick();
          const row = {
            ...data,
            id: `bk-${++db.seq}`,
            items: [],
            payment: data.payment ? { id: `pay-${db.seq}`, status: 'REQUIRES_PAYMENT' } : null,
          };
          newBookings.push(row);
          return row;
        },
      },
      idempotencyRecord: {
        create: async ({ data }: Row) => {
          const k = `${data.scope}|${data.key}`;
          // A unique insert waits for the transaction that holds the key, then fails if it won.
          while (db.claims.has(k)) await db.claims.get(k);
          if (db.records.has(k)) throw uniqueViolation();
          db.claims.set(k, done.promise);
          myClaims.push(k);
          newRecords.set(k, { ...data });
          return data;
        },
      },
    };

    try {
      const result = await fn(tx);
      this.bookings.push(...newBookings);
      for (const [k, r] of newRecords) this.records.set(k, r);
      return result;
    } finally {
      for (const k of myClaims) this.claims.delete(k);
      for (const k of myLocks) this.locks.delete(k);
      done.resolve();
    }
  }
}

const IN_THREE_DAYS = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

function ticketType(id: string, sessionId: string, maxPerOrder = 10) {
  return {
    id,
    eventSessionId: sessionId,
    name: `Type ${id}`,
    priceMinor: 50_000,
    currency: 'INR',
    maxPerOrder,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
    seatCategoryId: null,
    seatCategory: null,
    seatZoneId: null,
  };
}

function setup(over: { config?: Record<string, unknown>; cash?: boolean } = {}) {
  const db = new FakeDb();
  const prisma = db.client();
  const startsAt = IN_THREE_DAYS();
  const session = (id: string) => ({
    id,
    eventId: 'ev-1',
    screenId: null,
    startsAt,
    status: 'SCHEDULED',
    event: {
      id: 'ev-1',
      organizationId: 'org-1',
      status: 'PUBLISHED',
      experienceType: 'EVENT',
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
      category: 'Music',
      venue: { country: 'India', region: 'Karnataka', city: 'Bengaluru' },
      organization: {
        registeredCountry: 'India',
        registeredRegion: 'Karnataka',
        cashPaymentsEnabled: over.cash ?? false,
        name: 'Aurora Live',
        status: 'APPROVED',
      },
    },
    screen: null,
  });
  prisma.eventSession.findUnique.mockImplementation(async ({ where }: Row) => session(where.id));
  prisma.ticketType.findMany.mockImplementation(async ({ where }: Row) =>
    (where.id.in as string[]).map((id) => ticketType(id, where.eventSessionId)),
  );

  const pricingStrategies = {
    quote: jest.fn((q: Row) => {
      const lines = (q.lines as Row[]).map((l) => ({
        ticketTypeId: l.ticketTypeId,
        quantity: l.quantity,
        unitPriceMinor: l.basePriceMinor,
        lineTotalMinor: l.basePriceMinor * l.quantity,
      }));
      return { subtotalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0), lines };
    }),
  };
  const pricing = {
    quote: jest.fn(async (subtotal: number, _m: string, discount: number, currency: string) => ({
      currency,
      subtotalMinor: subtotal,
      discountMinor: discount,
      netSubtotalMinor: subtotal - discount,
      bookingFeeMinor: 0,
      paymentFeeMinor: 0,
      customerFeeMinor: 0,
      organizerFeeMinor: 0,
      taxLines: [],
      taxMinor: 0,
      totalMinor: subtotal - discount,
    })),
  };
  const reserve = jest.fn(async () => {
    // Long enough for parallel requests to overlap inside their transactions.
    await tick();
    await tick();
  });
  const configValues: Record<string, unknown> = { BOOKING_HOLD_MINUTES: 10, ...over.config };
  const config = { get: (k: string) => configValues[k] };
  const service = new BookingsService(
    prisma as never,
    pricing as never,
    pricingStrategies as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never, // audit
    { forSeating: () => ({ reserve }) } as never, // inventory
    {} as never, // addOnInventory
    { recordBookingCreated: jest.fn() } as never, // metrics
    { observe: async () => undefined } as never, // lockShadow
    { observe: async () => undefined } as never, // bookingShadow
    config as never,
    undefined, // payments
    undefined, // policyService
    undefined, // recovery
    undefined, // pilot
    new BookingHoldLimitsService(config as never),
  );
  return { service, db, reserve, startsAt };
}

const USER = { id: 'u-1', email: 'u1@t.test', fullName: 'U', roles: [] } as never;
const OTHER = { id: 'u-2', email: 'u2@t.test', fullName: 'O', roles: [] } as never;

function cart(
  over: {
    items?: { ticketTypeId: string; quantity: number }[];
    email?: string;
    session?: string;
    cash?: boolean;
  } = {},
) {
  return {
    eventSessionId: over.session ?? 'sess-1',
    buyerName: 'Buyer',
    buyerEmail: over.email ?? 'buyer@t.test',
    items: over.items ?? [{ ticketTypeId: 'tt-1', quantity: 2 }],
    ...(over.cash ? { paymentMethod: 'CASH' } : {}),
  } as never;
}

type Created = { id: string; status: string; holdExpiresAt: Date };
const create = (
  service: BookingsService,
  user: unknown,
  body: unknown,
  key?: string,
  opts?: { counterSale?: boolean; clientIp?: string | null },
) => service.create(user as never, body as never, key, undefined, opts) as Promise<Created>;

const settled = async (ps: Promise<unknown>[]) => {
  const all = await Promise.allSettled(ps);
  return {
    ok: all.filter((r) => r.status === 'fulfilled').length,
    refused: all
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason?.message ?? r.reason)),
  };
};

describe('ordinary buyers are not affected', () => {
  it('a single booking holds for the configured window, as before', async () => {
    const { service, db } = setup();
    const before = Date.now();
    const res = await create(service, USER, cart(), undefined, { clientIp: '203.0.113.7' });
    expect(res.status).toBe('PENDING_PAYMENT');
    const held = new Date(res.holdExpiresAt).getTime();
    expect(held).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000);
    expect(held).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);
    expect(db.bookings).toHaveLength(1);
  });

  it('an order of several ticket types within their limits goes through', async () => {
    const { service } = setup();
    await expect(
      create(
        service,
        USER,
        cart({
          items: [
            { ticketTypeId: 'tt-adult', quantity: 4 },
            { ticketTypeId: 'tt-child', quantity: 4 },
            { ticketTypeId: 'tt-senior', quantity: 2 },
          ],
        }),
      ),
    ).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('a guest checkout goes through, and so does a second one from the same address', async () => {
    const { service } = setup();
    await create(service, null, cart(), undefined, { clientIp: '203.0.113.7' });
    await expect(
      create(service, null, cart(), undefined, { clientIp: '203.0.113.7' }),
    ).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('a pay-at-venue reservation is still held until the show starts', async () => {
    const { service, startsAt } = setup({ cash: true });
    const res = await create(service, null, cart({ cash: true }));
    expect(new Date(res.holdExpiresAt)).toEqual(startsAt);
  });
});

describe('maxPerOrder is per order, not per line', () => {
  it('refuses the same ticket type split across lines to get past the limit', async () => {
    const { service, db } = setup();
    await expect(
      create(
        service,
        USER,
        cart({
          items: [
            { ticketTypeId: 'tt-1', quantity: 6 },
            { ticketTypeId: 'tt-1', quantity: 6 },
          ],
        }),
      ),
    ).rejects.toThrow(/at most 10 of Type tt-1 per order/);
    expect(db.bookings).toHaveLength(0);
  });

  it('accepts repeated lines that stay within the limit together', async () => {
    // A seat map can send one type as two blocks of seats; that is not refused, only summed.
    const { service } = setup();
    await expect(
      create(
        service,
        USER,
        cart({
          items: [
            { ticketTypeId: 'tt-1', quantity: 5 },
            { ticketTypeId: 'tt-1', quantity: 5 },
          ],
        }),
      ),
    ).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('refuses an order over the whole-order ticket ceiling, and an operator can raise it', async () => {
    const big = cart({
      items: [
        { ticketTypeId: 'tt-a', quantity: 8 },
        { ticketTypeId: 'tt-b', quantity: 8 },
        { ticketTypeId: 'tt-c', quantity: 8 },
      ],
    });
    await expect(create(setup().service, USER, big)).rejects.toThrow(
      /at most 20 tickets in one order/,
    );
    const raised = setup({ config: { BOOKING_MAX_SEATS_PER_ORDER: 30 } });
    await expect(create(raised.service, USER, big)).resolves.toMatchObject({
      status: 'PENDING_PAYMENT',
    });
  });
});

describe('active-hold limits', () => {
  it('refuses a fourth open checkout for one account, and frees the slot when one ends', async () => {
    const { service, db } = setup();
    for (let i = 0; i < 3; i++) await create(service, USER, cart());
    await expect(create(service, USER, cart())).rejects.toThrow(
      /already have 3 bookings waiting for payment/,
    );
    // Another account is unaffected.
    await expect(create(service, OTHER, cart())).resolves.toBeTruthy();

    // A paid hold stops counting, and so does an expired one.
    db.bookings[0].status = 'CONFIRMED';
    await expect(create(service, USER, cart())).resolves.toBeTruthy();
    db.bookings[1].holdExpiresAt = new Date(Date.now() - 1000);
    await expect(create(service, USER, cart())).resolves.toBeTruthy();
  });

  it('caps twenty parallel guest holds from one address at three', async () => {
    const { service, db } = setup();
    const { ok, refused } = await settled(
      Array.from({ length: 20 }, (_, i) =>
        // Case varied on purpose (the schema already trims): one address however it is typed.
        create(service, null, cart({ email: i % 2 ? 'Flood@T.test' : 'flood@t.test' }), undefined, {
          clientIp: `198.51.100.${i}`,
        }),
      ),
    );
    expect(ok).toBe(3);
    expect(refused).toHaveLength(17);
    expect(refused.every((m) => /waiting for payment/.test(m))).toBe(true);
    expect(db.bookings.filter((b) => b.status === 'PENDING_PAYMENT')).toHaveLength(3);
  });

  it('caps one client address across changing emails, without touching other addresses', async () => {
    const { service } = setup({ config: { BOOKING_MAX_ACTIVE_HOLDS_PER_IP: 5 } });
    const { ok, refused } = await settled(
      Array.from({ length: 8 }, (_, i) =>
        create(service, null, cart({ email: `bot${i}@t.test` }), undefined, {
          clientIp: '192.0.2.1',
        }),
      ),
    );
    expect(ok).toBe(5);
    expect(refused.every((m) => /from your network/.test(m))).toBe(true);
    await expect(
      create(service, null, cart({ email: 'neighbour@t.test' }), undefined, {
        clientIp: '192.0.2.2',
      }),
    ).resolves.toBeTruthy();
  });

  it('defaults the address limit high enough for a shared network', async () => {
    // Twenty different people behind one cinema-lobby address, each with their own checkout.
    const { service } = setup();
    const { ok } = await settled(
      Array.from({ length: 20 }, (_, i) =>
        create(service, null, cart({ email: `person${i}@t.test` }), undefined, {
          clientIp: '100.64.0.1',
        }),
      ),
    );
    expect(ok).toBe(20);
  });
});

describe('pay-at-venue reservations', () => {
  it('allows one per show and two overall per buyer, and never blocks paying online', async () => {
    const { service } = setup({ cash: true });
    await create(service, null, cart({ cash: true, session: 'sess-1' }));
    await expect(create(service, null, cart({ cash: true, session: 'sess-1' }))).rejects.toThrow(
      /already have a pay-at-venue reservation for this show/,
    );
    await create(service, null, cart({ cash: true, session: 'sess-2' }));
    await expect(create(service, null, cart({ cash: true, session: 'sess-3' }))).rejects.toThrow(
      /already have 2 pay-at-venue reservations/,
    );
    // The same buyer can still pay online: cash reservations have their own allowance.
    await expect(create(service, null, cart({ session: 'sess-3' }))).resolves.toMatchObject({
      status: 'PENDING_PAYMENT',
    });
  });

  it('caps a parallel flood of cash reservations for one show at one', async () => {
    const { service, db } = setup({ cash: true });
    const { ok } = await settled(
      Array.from({ length: 10 }, () => create(service, null, cart({ cash: true }))),
    );
    expect(ok).toBe(1);
    expect(db.bookings).toHaveLength(1);
  });

  it('caps the tickets in one cash reservation', async () => {
    const { service } = setup({ cash: true });
    await expect(
      create(service, null, cart({ cash: true, items: [{ ticketTypeId: 'tt-1', quantity: 7 }] })),
    ).rejects.toThrow(/reserve at most 6 tickets to pay at the venue/);
  });
});

describe('counter sales are unchanged', () => {
  it('sell large orders, repeatedly, to one address, held only for the ordinary window', async () => {
    // cashPaymentsEnabled is off, as it is for an organizer who only sells at the door.
    const { service, db } = setup({ cash: false });
    for (let i = 0; i < 5; i++) {
      const res = await create(
        service,
        null,
        cart({
          cash: true,
          items: [
            { ticketTypeId: 'tt-a', quantity: 10 },
            { ticketTypeId: 'tt-b', quantity: 10 },
            { ticketTypeId: 'tt-c', quantity: 5 },
          ],
        }),
        `counter:org-1:sale-${i}`,
        { counterSale: true, clientIp: '10.0.0.1' },
      );
      expect(new Date(res.holdExpiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    }
    expect(db.bookings).toHaveLength(5);
  });
});

describe('idempotency keys', () => {
  it('a retry with the same key returns the same booking and holds nothing new', async () => {
    const { service, db, reserve } = setup();
    const first = await create(service, USER, cart(), 'key-1');
    const again = await create(service, USER, cart(), 'key-1');
    expect(again.id).toBe(first.id);
    expect(db.bookings).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("another buyer's identical key does not return the first buyer's booking", async () => {
    const { service, db } = setup();
    const mine = await create(service, USER, cart(), 'shared-key');
    const theirs = await create(service, OTHER, cart(), 'shared-key');
    expect(theirs.id).not.toBe(mine.id);
    expect(db.bookings).toHaveLength(2);
    // Guests are scoped by their address in the same way.
    const guestA = await create(service, null, cart({ email: 'a@t.test' }), 'shared-key');
    const guestB = await create(service, null, cart({ email: 'b@t.test' }), 'shared-key');
    expect(new Set([mine.id, theirs.id, guestA.id, guestB.id]).size).toBe(4);
  });

  it('refuses a key reused for a different cart', async () => {
    const { service } = setup();
    await create(service, USER, cart(), 'key-2');
    await expect(
      create(service, USER, cart({ items: [{ ticketTypeId: 'tt-1', quantity: 3 }] }), 'key-2'),
    ).rejects.toThrow(/already used for a different booking/);
  });

  it('parallel requests with one key make one booking and all get it', async () => {
    const { service, db } = setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(service, null, cart(), 'double-tap')),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(db.bookings).toHaveLength(1);
  });

  it('a key whose first attempt failed can be retried', async () => {
    const { service, reserve, db } = setup();
    reserve.mockRejectedValueOnce(new Error('Sold out'));
    await expect(create(service, USER, cart(), 'key-3')).rejects.toThrow(/Sold out/);
    await expect(create(service, USER, cart(), 'key-3')).resolves.toMatchObject({
      status: 'PENDING_PAYMENT',
    });
    expect(db.bookings).toHaveLength(1);
  });
});
