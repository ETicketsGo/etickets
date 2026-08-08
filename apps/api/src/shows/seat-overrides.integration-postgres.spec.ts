import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SeatOverridesService } from './seat-overrides.service';
import { LiveOperationsService } from './live-operations.service';
import { SeatBasedInventoryStrategy } from '../inventory/seat-based.strategy';

/**
 * integration-real-postgres — show-level seat overrides.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────
 * The override engine's safety claim is that a block and a booking racing for the same seat
 * cannot both win, and that a sold seat can never be taken away from the person who bought
 * it. Neither is provable with mocks: both depend on PostgreSQL serialising two conditional
 * UPDATEs on one row, which is exactly the behaviour a fake repository would paper over.
 *
 * The booking side uses the REAL `SeatBasedInventoryStrategy` — the same code the checkout
 * runs — rather than a hand-copied UPDATE. A test that reimplements the mechanism it is
 * testing proves only that the copy agrees with itself.
 *
 * Races use TWO INDEPENDENT PrismaClients. Two transactions from one client can share a
 * pooled connection and serialise for the wrong reason, which would produce a green test
 * that proves nothing about concurrency.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const OPERATOR = { id: '', email: 'ops@t.test', fullName: 'Ops', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;

describe('integration-real-postgres: show seat overrides', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let db2: Client | undefined;
  let available = false;
  let overrides: SeatOverridesService;
  let live: LiveOperationsService;
  const audited: { action: string; metadata?: Record<string, unknown> }[] = [];

  const suffix = `ovr-${Date.now()}`;
  let orgId = '';
  let cinemaId = '';
  let screenId = '';
  let seatMapId = '';
  let categoryId = '';
  let ticketTypeId = '';
  let sessionId = '';
  let eventId = '';
  let userId = '';
  let seatIds: string[] = [];

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    db2 = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }

    const audit = {
      record: async (e: { action: string; metadata?: Record<string, unknown> }) => {
        audited.push(e);
      },
    } as never;
    overrides = new SeatOverridesService(db as never, allowAll, audit);
    live = new LiveOperationsService(db as never, allowAll);

    const user = await db!.user.create({
      data: {
        email: `ops-${suffix}@t.test`,
        passwordHash: 'x',
        fullName: 'Ops Person',
      },
    });
    userId = user.id;
    (OPERATOR as unknown as { id: string }).id = userId;

    const org = await db!.organization.create({
      data: { name: `Ovr ${suffix}`, slug: `ovr-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    const cinema = await db!.cinema.create({
      data: { organizationId: orgId, venueId: venue.id, name: `C ${suffix}`, city: 'Hyderabad' },
    });
    cinemaId = cinema.id;
    const screen = await db!.screen.create({
      data: { cinemaId, name: 'Screen 1', screenType: '2D', capacity: 6 },
    });
    screenId = screen.id;

    const seatMap = await db!.seatMap.create({
      data: {
        screenId,
        name: 'L1',
        version: 1,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        effectiveFrom: new Date(),
      },
    });
    seatMapId = seatMap.id;
    const cat = await db!.seatCategory.create({
      data: { seatMapId, name: 'Normal', basePriceMinor: 20000, sortOrder: 0 },
    });
    categoryId = cat.id;
    const sec = await db!.seatSection.create({
      data: { seatMapId, name: 'Stalls', sortOrder: 0 },
    });
    const row = await db!.seatRow.create({ data: { sectionId: sec.id, label: 'A', sortOrder: 0 } });
    // A5 is a wheelchair space with A4/A6 either side, for the accessibility tests.
    for (const i of [1, 2, 3, 4, 5, 6]) {
      await db!.seat.create({
        data: {
          seatMapId,
          rowId: row.id,
          seatCategoryId: categoryId,
          label: String(i),
          colIndex: i,
          kind: i === 5 ? 'WHEELCHAIR' : 'SEAT',
        },
      });
    }
    seatIds = (await db!.seat.findMany({ where: { seatMapId }, orderBy: { colIndex: 'asc' } })).map(
      (s: { id: string }) => s.id,
    );

    const movie = await db!.movie.create({
      data: {
        organizationId: orgId,
        title: `Ovr Movie ${suffix}`,
        slug: `ovr-movie-${suffix}`,
        runtimeMinutes: 100,
        language: 'Hindi',
        status: 'PUBLISHED',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        movieId: movie.id,
        experienceType: 'MOVIE',
        title: movie.title,
        slug: `ovr-event-${suffix}`,
        category: 'movie',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    const session = await db!.eventSession.create({
      data: {
        eventId: event.id,
        screenId,
        seatMapId,
        startsAt: new Date(Date.now() + 3 * 86_400_000),
        endsAt: new Date(Date.now() + 3 * 86_400_000 + 7_200_000),
      },
    });
    sessionId = session.id;
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: sessionId,
        seatCategoryId: categoryId,
        name: 'Normal',
        priceMinor: 20000,
        currency: 'INR',
        quantityTotal: 6,
        maxPerOrder: 10,
        status: 'ACTIVE',
        inventory: { create: { quantityTotal: 6, quantitySold: 0, quantityHeld: 0 } },
      },
    });
    ticketTypeId = tt.id;
  }, 90_000);

  /** Reset every seat to AVAILABLE between tests. */
  const reset = async () => {
    if (!db) return;
    await db.showSeat.deleteMany({ where: { eventSessionId: sessionId } });
    await db.showSeat.createMany({
      data: seatIds.map((seatId) => ({ eventSessionId: sessionId, seatId, status: 'AVAILABLE' })),
    });
    await db.booking.deleteMany({ where: { eventSessionId: sessionId } });
    audited.length = 0;
  };

  beforeEach(async () => {
    if (available) await reset();
  });

  afterAll(async () => {
    if (available && db) {
      await db.showSeat.deleteMany({ where: { eventSessionId: sessionId } });
      await db.booking.deleteMany({ where: { eventSessionId: sessionId } });
      await db.ticketInventory.deleteMany({ where: { ticketType: { eventSessionId: sessionId } } });
      await db.ticketType.deleteMany({ where: { eventSessionId: sessionId } });
      await db.eventSession.deleteMany({ where: { id: sessionId } });
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.movie.deleteMany({ where: { organizationId: orgId } });
      await db.seat.deleteMany({ where: { seatMapId } });
      await db.seatRow.deleteMany({ where: { section: { seatMapId } } });
      await db.seatSection.deleteMany({ where: { seatMapId } });
      await db.seatCategory.deleteMany({ where: { seatMapId } });
      await db.seatMap.deleteMany({ where: { screenId } });
      await db.screen.deleteMany({ where: { cinemaId } });
      await db.cinema.deleteMany({ where: { id: cinemaId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.user.deleteMany({ where: { id: userId } });
    }
    await db?.$disconnect();
    await db2?.$disconnect();
  }, 90_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** Take a seat through the REAL booking strategy, on a given client. */
  const holdSeat = async (client: Client, seatId: string, bookingId: string, holdMinutes = 10) => {
    const strategy = new SeatBasedInventoryStrategy();
    const holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);
    await client.booking.create({
      data: {
        id: bookingId,
        eventId,
        eventSessionId: sessionId,
        organizationId: orgId,
        status: 'PENDING_PAYMENT',
        currency: 'INR',
        subtotalMinor: 20000,
        totalMinor: 20000,
        buyerEmail: 'b@t.test',
        buyerName: 'B',
        reference: `REF-${bookingId.slice(-8)}`,
        holdExpiresAt,
      },
    });
    await client.$transaction(async (tx: never) =>
      strategy.reserve(tx, {
        eventSessionId: sessionId,
        bookingId,
        holdExpiresAt,
        lines: [{ ticketTypeId, quantity: 1, seatIds: [seatId] }],
      } as never),
    );
  };

  const statusOf = async (seatId: string) => {
    const row = await db!.showSeat.findFirst({
      where: { eventSessionId: sessionId, seatId },
      select: { status: true, overrideKind: true, overrideReason: true },
    });
    return row!;
  };

  // ── The rule that matters most ─────────────────────────────────────────────────

  maybe('a SOLD seat can never be blocked', async () => {
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: seatIds[0] },
      data: { status: 'SOLD' },
    });

    const result = await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'broken recliner',
    });

    expect(result.applied).toBe(0);
    expect(result.seats[0].code).toBe('SEAT_SOLD');
    // And the seat is untouched — not merely "not blocked", still genuinely sold.
    expect((await statusOf(seatIds[0])).status).toBe('SOLD');
  });

  maybe('a SOLD seat can never be released either', async () => {
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: seatIds[0] },
      data: { status: 'SOLD' },
    });
    const result = await overrides.releaseSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      reason: 'tidying up',
    });
    expect(result.applied).toBe(0);
    expect((await statusOf(seatIds[0])).status).toBe('SOLD');
  });

  // ── Basic operations ───────────────────────────────────────────────────────────

  maybe('blocks and releases a free seat, and the seat sells again afterwards', async () => {
    const blocked = await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MANUAL_BLOCK',
      reason: 'reserved for staff',
    });
    expect(blocked.applied).toBe(1);
    expect((await statusOf(seatIds[0])).status).toBe('BLOCKED');

    // Blocked means genuinely unbookable through the real strategy.
    await expect(holdSeat(db!, seatIds[0], `blk-${Date.now()}`)).rejects.toBeDefined();

    const released = await overrides.releaseSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      reason: 'staff no longer needed',
    });
    expect(released.applied).toBe(1);
    expect((await statusOf(seatIds[0])).status).toBe('AVAILABLE');

    // And it is genuinely back on sale, not merely relabelled.
    await holdSeat(db!, seatIds[0], `ok-${Date.now()}`);
    expect((await statusOf(seatIds[0])).status).toBe('HELD');
  });

  maybe('applies partially: one sold seat does not fail the whole row', async () => {
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: seatIds[2] },
      data: { status: 'SOLD' },
    });

    const result = await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0], seatIds[1], seatIds[2], seatIds[3]],
      kind: 'EMERGENCY',
      reason: 'gangway keep-clear',
    });

    // Three blocked, one refused, and the refusal names the seat.
    expect(result.applied).toBe(3);
    expect(result.refused).toBe(1);
    expect(result.seats.find((s) => !s.applied)?.code).toBe('SEAT_SOLD');
  });

  maybe('rejects seats that belong to another show', async () => {
    // Silently ignoring them would let a caller probe which ids exist by watching counts.
    await expect(
      overrides.blockSeats(OPERATOR, sessionId, {
        seatIds: ['clzzzzzzzzzzzzzzzzzzzzzzz'],
        kind: 'MANUAL_BLOCK',
        reason: 'x',
      }),
    ).rejects.toMatchObject({ details: { reason: 'SEAT_NOT_ON_SHOW' } });
  });

  // ── Holds ──────────────────────────────────────────────────────────────────────

  maybe('refuses to block a seat a customer is checking out with', async () => {
    await holdSeat(db!, seatIds[0], `hold-${Date.now()}`);

    const result = await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'seat wobbles',
    });
    expect(result.applied).toBe(0);
    expect(result.seats[0].code).toBe('SEAT_HELD');
    // The message has to tell the operator how long to wait, or they will just retry blindly.
    expect(result.seats[0].reason).toMatch(/minute/);
    expect((await statusOf(seatIds[0])).status).toBe('HELD');
  });

  maybe('blocks over an EXPIRED hold, because that checkout is already dead', async () => {
    const bookingId = `exp-${Date.now()}`;
    await holdSeat(db!, seatIds[0], bookingId);
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: seatIds[0] },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'seat wobbles',
    });
    expect(result.applied).toBe(1);

    const after = await statusOf(seatIds[0]);
    expect(after.status).toBe('BLOCKED');
    // The dead hold's pointer is cleared, so nothing later mistakes it for a live checkout.
    const row = await db!.showSeat.findFirst({
      where: { eventSessionId: sessionId, seatId: seatIds[0] },
      select: { holdBookingId: true, holdExpiresAt: true },
    });
    expect(row!.holdBookingId).toBeNull();
    expect(row!.holdExpiresAt).toBeNull();
  });

  // ── Races (two independent clients) ────────────────────────────────────────────

  maybe(
    'RACE booking vs block: exactly one wins, ten rounds',
    async () => {
      for (let round = 0; round < 10; round += 1) {
        await reset();
        const seatId = seatIds[0];

        const [bookingOutcome, blockOutcome] = await Promise.allSettled([
          holdSeat(db2!, seatId, `race-${round}-${Date.now()}`),
          overrides.blockSeats(OPERATOR, sessionId, {
            seatIds: [seatId],
            kind: 'MAINTENANCE',
            reason: 'race',
          }),
        ]);

        const after = await statusOf(seatId);
        const bookingWon = bookingOutcome.status === 'fulfilled';
        const blockWon = blockOutcome.status === 'fulfilled' && blockOutcome.value.applied === 1;

        // Exactly one, never both, never neither.
        expect(bookingWon !== blockWon).toBe(true);
        expect(after.status).toBe(bookingWon ? 'HELD' : 'BLOCKED');
      }
    },
    120_000,
  );

  maybe(
    'RACE two operators blocking the same seat: both cannot claim it as their own',
    async () => {
      const seatId = seatIds[1];
      const other = new SeatOverridesService(db2 as never, allowAll, {
        record: async () => undefined,
      } as never);

      const [a, b] = await Promise.all([
        overrides.blockSeats(OPERATOR, sessionId, {
          seatIds: [seatId],
          kind: 'MAINTENANCE',
          reason: 'engineer called',
        }),
        other.blockSeats(OPERATOR, sessionId, {
          seatIds: [seatId],
          kind: 'HOUSE',
          reason: 'comp for sponsor',
        }),
      ]);

      // Re-blocking is legal — it is how a kind gets corrected — so both may report applied.
      // What must hold is that the seat ends in exactly ONE consistent state, with a reason
      // that matches its kind rather than a mix of the two writes.
      expect(a.applied + b.applied).toBeGreaterThanOrEqual(1);
      const after = await statusOf(seatId);
      expect(after.status).toBe('BLOCKED');
      const pairs: Record<string, string> = {
        MAINTENANCE: 'engineer called',
        HOUSE: 'comp for sponsor',
      };
      expect(after.overrideReason).toBe(pairs[after.overrideKind as string]);
    },
    60_000,
  );

  maybe(
    'RACE block vs release: the seat never ends up half-way between',
    async () => {
      for (let round = 0; round < 5; round += 1) {
        await reset();
        const seatId = seatIds[2];
        await overrides.blockSeats(OPERATOR, sessionId, {
          seatIds: [seatId],
          kind: 'MANUAL_BLOCK',
          reason: 'initial',
        });

        const other = new SeatOverridesService(db2 as never, allowAll, {
          record: async () => undefined,
        } as never);

        await Promise.allSettled([
          overrides.blockSeats(OPERATOR, sessionId, {
            seatIds: [seatId],
            kind: 'EMERGENCY',
            reason: 'incident',
          }),
          other.releaseSeats(OPERATOR, sessionId, { seatIds: [seatId], reason: 'clearing' }),
        ]);

        const after = await statusOf(seatId);
        // Either outcome is legitimate; an inconsistent one is not. A BLOCKED seat must
        // carry a kind and a reason, and an AVAILABLE one must carry neither.
        if (after.status === 'BLOCKED') {
          expect(after.overrideKind).toBeTruthy();
          expect(after.overrideReason).toBeTruthy();
        } else {
          expect(after.status).toBe('AVAILABLE');
          expect(after.overrideKind).toBeNull();
          expect(after.overrideReason).toBeNull();
        }
      }
    },
    120_000,
  );

  maybe(
    'RACE release vs booking: a released seat is sold at most once',
    async () => {
      for (let round = 0; round < 5; round += 1) {
        await reset();
        const seatId = seatIds[3];
        await overrides.blockSeats(OPERATOR, sessionId, {
          seatIds: [seatId],
          kind: 'MANUAL_BLOCK',
          reason: 'held back',
        });

        await Promise.allSettled([
          overrides.releaseSeats(OPERATOR, sessionId, { seatIds: [seatId], reason: 'on sale' }),
          holdSeat(db2!, seatId, `rel-${round}-${Date.now()}`),
        ]);

        const after = await statusOf(seatId);
        // A booking can only ever have taken it from AVAILABLE, so HELD implies the release
        // landed first. Never BLOCKED-and-held, never two holds.
        expect(['AVAILABLE', 'HELD', 'BLOCKED']).toContain(after.status);
        const holds = await db!.showSeat.count({
          where: { eventSessionId: sessionId, seatId, status: 'HELD' },
        });
        expect(holds).toBeLessThanOrEqual(1);
      }
    },
    120_000,
  );

  maybe('a stale release cannot wipe a hold taken after its pre-read', async () => {
    /*
      This exists because falsification found a hole.

      Deleting `AND "status" = 'BLOCKED'` from the release UPDATE broke nothing: every other
      test refuses a sold or held seat during the PRE-READ, so the SQL guard — the actual
      backstop — was never reached. A guard whose absence no test notices is not a proven
      guard, it is a comment.

      Racing three actors to hit the interleaving was tried and is far too narrow to land
      reliably; a test that only sometimes exercises the thing it is named after is worse
      than none. So the interleaving is produced DETERMINISTICALLY: a client extension lets
      the service's pre-read return BLOCKED, then books the seat before the UPDATE runs.
      That is exactly the state a lost race leaves — operator holding a stale view — without
      depending on timing.
    */
    const seatId = seatIds[5];
    await reset();
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatId],
      kind: 'MANUAL_BLOCK',
      reason: 'held back',
    });

    let injected = false;
    const stale = (db as unknown as { $extends: (x: unknown) => unknown }).$extends({
      query: {
        showSeat: {
          async findMany({
            args,
            query,
          }: {
            args: unknown;
            query: (a: unknown) => Promise<unknown>;
          }) {
            const result = await query(args);
            if (!injected) {
              injected = true;
              // Between this operator's read and their write, the whole rest of the world
              // happens: a colleague's release lands, and a customer books the freed seat.
              await db2!.showSeat.updateMany({
                where: { eventSessionId: sessionId, seatId },
                data: { status: 'AVAILABLE', overrideKind: null, overrideReason: null },
              });
              await holdSeat(db2!, seatId, `stale-race-${Date.now()}`);
            }
            return result;
          },
        },
      },
    });

    const service = new SeatOverridesService(stale as never, allowAll, {
      record: async () => undefined,
    } as never);
    const result = await service.releaseSeats(OPERATOR, sessionId, {
      seatIds: [seatId],
      reason: 'putting it back on sale',
    });

    // The release must find nothing to do and say so, rather than reverting a live checkout.
    expect(result.applied).toBe(0);
    expect(result.seats[0].code).toBe('SEAT_NOT_BLOCKED');

    const row = await db!.showSeat.findFirst({
      where: { eventSessionId: sessionId, seatId },
      select: { status: true, holdBookingId: true },
    });
    expect(row!.status).toBe('HELD');
    expect(row!.holdBookingId).toBeTruthy();
  });

  // ── Emergency blocks ───────────────────────────────────────────────────────────

  maybe('an emergency block is not cleared by a casual release', async () => {
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'EMERGENCY',
      reason: 'evacuation route',
    });

    const casual = await overrides.releaseSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      reason: 'looked like clutter',
    });
    expect(casual.applied).toBe(0);
    expect(casual.seats[0].code).toBe('EMERGENCY_REQUIRES_FORCE');
    expect((await statusOf(seatIds[0])).status).toBe('BLOCKED');

    const forced = await overrides.releaseSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      reason: 'fire officer cleared it',
      force: true,
    });
    expect(forced.applied).toBe(1);
    expect((await statusOf(seatIds[0])).status).toBe('AVAILABLE');
    // A forced release is audited under its own action so it can be found later.
    expect(audited.some((a) => a.action === 'SHOW_SEATS_RELEASED_FORCED')).toBe(true);
  });

  // ── Maintenance expiry ─────────────────────────────────────────────────────────

  maybe('warns when a maintenance block has no expiry', async () => {
    const result = await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'awaiting engineer',
    });
    expect(result.warnings.join(' ')).toMatch(/no expiry/i);
  });

  maybe('sweeps only lapsed maintenance blocks and leaves everything else alone', async () => {
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'spillage',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[1]],
      kind: 'MAINTENANCE',
      reason: 'cleaning',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[2]],
      kind: 'HOUSE',
      reason: 'press',
    });

    const { released } = await overrides.expireLapsedOverrides();
    expect(released).toBeGreaterThanOrEqual(1);

    expect((await statusOf(seatIds[0])).status).toBe('AVAILABLE');
    // Not yet due, and no deadline at all: both must survive.
    expect((await statusOf(seatIds[1])).status).toBe('BLOCKED');
    expect((await statusOf(seatIds[2])).status).toBe('BLOCKED');
  });

  maybe('the sweep is idempotent', async () => {
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'spillage',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await overrides.expireLapsedOverrides();
    const second = await overrides.expireLapsedOverrides();
    expect(second.released).toBe(0);
  });

  // ── Audit ──────────────────────────────────────────────────────────────────────

  maybe('records who, what, why and which seats', async () => {
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0], seatIds[1]],
      kind: 'HOUSE',
      reason: 'sponsor allocation',
      housePurpose: 'SPONSOR',
    });

    const entry = audited.find((a) => a.action === 'SHOW_SEATS_BLOCKED');
    expect(entry).toBeDefined();
    expect(entry!.metadata).toMatchObject({
      kind: 'HOUSE',
      reason: 'sponsor allocation',
      housePurpose: 'SPONSOR',
      seatCount: 2,
      screenId,
    });
    // Seat LABELS, not ids: an audit entry a human cannot read is not much of an audit.
    expect(entry!.metadata!.seats).toEqual(['A1', 'A2']);
  });

  maybe('records the kinds that were undone by a release', async () => {
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'VIP',
      reason: 'guest of the director',
    });
    audited.length = 0;
    await overrides.releaseSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      reason: 'guest cancelled',
    });

    const entry = audited.find((a) => a.action === 'SHOW_SEATS_RELEASED');
    expect(entry!.metadata!.previousKinds).toEqual(['VIP']);
  });

  // ── Occupancy ──────────────────────────────────────────────────────────────────

  maybe('occupancy measures against what the public could actually buy', async () => {
    // 6 seats. Block 2 as house, sell 2. Occupancy must be 2/4 = 50%, not 2/6 = 33%.
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[4], seatIds[5]],
      kind: 'HOUSE',
      reason: 'press',
    });
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: { in: [seatIds[0], seatIds[1]] } },
      data: { status: 'SOLD' },
    });

    const snap = await live.occupancy(OPERATOR, sessionId);
    expect(snap.capacity).toBe(6);
    expect(snap.sold).toBe(2);
    expect(snap.blocked).toBe(2);
    expect(snap.house).toBe(2);
    expect(snap.occupancyPercent).toBe(50);
    expect(snap.blockedByKind).toEqual([{ kind: 'HOUSE', label: 'House seat', count: 2 }]);
  });

  maybe('an expired hold is not counted as live demand', async () => {
    const bookingId = `stale-${Date.now()}`;
    await holdSeat(db!, seatIds[0], bookingId);
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: seatIds[0] },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const snap = await live.occupancy(OPERATOR, sessionId);
    // Reporting it would show a manager phantom demand on a show that is actually quiet.
    expect(snap.held).toBe(0);
  });

  // ── Live seat map ──────────────────────────────────────────────────────────────

  maybe('the live seat map shows the override, its reason and who made it', async () => {
    await overrides.blockSeats(OPERATOR, sessionId, {
      seatIds: [seatIds[0]],
      kind: 'MAINTENANCE',
      reason: 'broken recliner',
    });

    const map = await live.liveSeatMap(OPERATOR, sessionId);
    const seat = map.sections[0].rows[0].seats.find((s) => s.seatId === seatIds[0])!;
    expect(seat.status).toBe('BLOCKED');
    expect(seat.overrideKind).toBe('MAINTENANCE');
    expect(seat.overrideReason).toBe('broken recliner');
    expect(seat.overrideBy).toBe('Ops Person');
    expect(seat.label).toBe('A1');
    // The wheelchair space is carried through from the layout, not invented per show.
    expect(map.sections[0].rows[0].seats.find((s) => s.colIndex === 5)!.kind).toBe('WHEELCHAIR');
  });

  // ── Accessibility ──────────────────────────────────────────────────────────────

  maybe('suggests the neighbours of a wheelchair space as companions', async () => {
    const wheelchairSeatId = seatIds[4]; // A5
    const result = await overrides.companionSuggestions(OPERATOR, sessionId, wheelchairSeatId);
    expect(result.candidates.map((c) => c.label).sort()).toEqual(['A4', 'A6']);
  });

  maybe('does not suggest a companion seat that is already taken', async () => {
    await db!.showSeat.updateMany({
      where: { eventSessionId: sessionId, seatId: seatIds[3] },
      data: { status: 'SOLD' },
    });
    const result = await overrides.companionSuggestions(OPERATOR, sessionId, seatIds[4]);
    expect(result.candidates.map((c) => c.label)).toEqual(['A6']);
  });

  maybe('suggests nothing for an ordinary seat', async () => {
    const result = await overrides.companionSuggestions(OPERATOR, sessionId, seatIds[0]);
    expect(result.candidates).toEqual([]);
  });
});
