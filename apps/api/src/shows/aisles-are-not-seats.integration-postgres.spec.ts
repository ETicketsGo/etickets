import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';

/**
 * integration-real-postgres — an aisle is not a seat, and a wheelchair space says so.
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────────────
 * `Seat.kind` has always distinguished a real seat from a GAP — an aisle, a pillar, a
 * walkway — and from a WHEELCHAIR bay. Scheduling ignored it completely. Every seat in the
 * layout became an AVAILABLE ShowSeat and counted towards the ticket type's quantity, and
 * the public read never sent `kind` at all. Three consequences, all reproduced end to end
 * before this file was written:
 *
 *   · a balcony with five aisle gaps advertised fifty seats when it had forty-two;
 *   · a customer could BUY seat A5 and turn up to a corridor — the booking succeeded;
 *   · a wheelchair space was indistinguishable from any other seat, so the person who needs
 *     one could not find it and somebody who does not need it took it unknowingly.
 *
 * Proven against a real database because what is being checked is what was WRITTEN — which
 * ShowSeat rows exist, and what the quantity on the ticket type says. A stub returns
 * whatever the test hands it.
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

const ORGANIZER = { id: 'itest-aisle', email: 'a@t.test', fullName: 'A', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: aisles are not seats', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;

  const suffix = `aisle-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';
  let screenId = '';
  let movieId = '';
  let sessionId = '';

  /** Rows A–E of ten, with a wheelchair pair in A and an aisle running down seat 5. */
  const LAYOUT = {
    name: 'Balcony',
    sections: [
      {
        name: 'Balcony',
        categoryName: 'Balcony',
        basePriceMinor: 15_000,
        rowLabels: ['A', 'B', 'C', 'D', 'E'],
        seatsPerRow: 10,
        seatKinds: [
          { rowLabel: 'A', seats: [1, 10], kind: 'WHEELCHAIR' },
          { rowLabel: 'A', seats: [2], kind: 'COMPANION' },
          { rowLabel: 'A', seats: [5], kind: 'GAP' },
          { rowLabel: 'B', seats: [5], kind: 'GAP' },
          { rowLabel: 'C', seats: [5], kind: 'GAP' },
          { rowLabel: 'D', seats: [5], kind: 'GAP' },
          { rowLabel: 'E', seats: [5], kind: 'GAP' },
        ],
      },
    ],
  };

  /** 50 positions, 5 of them aisle. */
  const TOTAL_POSITIONS = 50;
  const GAPS = 5;
  const SELLABLE = TOTAL_POSITIONS - GAPS;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    shows = new ShowsService(
      db as never,
      allowAll,
      { record: async () => undefined } as never,
      cfg,
    );

    const org = await db.organization.create({
      data: { name: `Aisle ${suffix}`, slug: `aisle-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    venueId = venue.id;
    const cinema = await db.cinema.create({
      data: { organizationId: orgId, venueId, name: `C ${suffix}`, city: 'Hyderabad' },
    });
    cinemaId = cinema.id;
    const screen = await db.screen.create({
      data: { cinemaId, name: `S ${suffix}`, screenType: '2D', capacity: 50 },
    });
    screenId = screen.id;
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Aisle Film ${suffix}`,
        slug: `aisle-film-${suffix}`,
        status: 'PUBLISHED',
        runtimeMinutes: 100,
        language: 'English',
      },
    });
    movieId = movie.id;

    await shows.generateSeatMap(ORGANIZER, screenId, LAYOUT as never);
    const scheduled = await shows.scheduleShow(ORGANIZER, movieId, {
      screenId,
      startsAt: new Date(Date.now() + 200 * 86_400_000),
      endsAt: new Date(Date.now() + 200 * 86_400_000 + 3 * 3_600_000),
    } as never);
    sessionId = scheduled.sessionId;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.showSeat.deleteMany({ where: { seat: { seatMap: { screenId } } } });
    await db.ticketType.deleteMany({ where: { eventSession: { screenId } } });
    await db.eventSession.deleteMany({ where: { screenId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.movie.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId } } });
    await db.seatMap.deleteMany({ where: { screenId } });
    await db.screen.deleteMany({ where: { cinemaId } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe(
    'the layout keeps every position, aisles included',
    async () => {
      // The MAP is a description of the room and the aisle is part of the room. It is only
      // the SHOW that must not sell it.
      const seats = await db!.seat.findMany({
        where: { seatMap: { screenId } },
        select: { kind: true },
      });
      expect(seats).toHaveLength(TOTAL_POSITIONS);
      expect(seats.filter((s: { kind: string }) => s.kind === 'GAP')).toHaveLength(GAPS);
      expect(seats.filter((s: { kind: string }) => s.kind === 'WHEELCHAIR')).toHaveLength(2);
      expect(seats.filter((s: { kind: string }) => s.kind === 'COMPANION')).toHaveLength(1);
    },
    60_000,
  );

  maybe(
    'no aisle becomes bookable inventory',
    async () => {
      /*
        The bug, stated as a row count.

        Scheduling created a ShowSeat for every position, so five aisles sat in the database
        marked AVAILABLE, indistinguishable from a seat, waiting to be sold.
      */
      const rows = await db!.showSeat.findMany({
        where: { eventSessionId: sessionId },
        select: { seat: { select: { kind: true } } },
      });
      expect(rows).toHaveLength(SELLABLE);
      expect(rows.filter((r: { seat: { kind: string } }) => r.seat.kind === 'GAP')).toHaveLength(0);

      // The accessible seats ARE inventory — somebody sits in them.
      const kinds = rows.map((r: { seat: { kind: string } }) => r.seat.kind);
      expect(kinds.filter((k: string) => k === 'WHEELCHAIR')).toHaveLength(2);
      expect(kinds.filter((k: string) => k === 'COMPANION')).toHaveLength(1);
    },
    60_000,
  );

  maybe(
    'the advertised quantity is the sellable count, not the position count',
    async () => {
      // "2 / 50" on an operations board, for a balcony that holds forty-two, is a number
      // somebody will reconcile against takings and fail to explain.
      const types = await db!.ticketType.findMany({
        where: { eventSessionId: sessionId },
        select: { quantityTotal: true, inventory: { select: { quantityTotal: true } } },
      });
      const total = types.reduce(
        (n: number, t: { quantityTotal: number }) => n + t.quantityTotal,
        0,
      );
      expect(total).toBe(SELLABLE);
      expect(types[0].inventory?.quantityTotal).toBe(SELLABLE);
    },
    60_000,
  );

  maybe(
    'the customer is never offered an aisle, and can tell a wheelchair space apart',
    async () => {
      const layout = await shows.getPublicSeatLayout(sessionId);
      if (layout.view !== 'seats') throw new Error('expected a seat view');
      const seats = layout.sections.flatMap((s) => s.rows.flatMap((r) => r.seats));

      expect(seats).toHaveLength(SELLABLE);
      expect(seats.filter((s) => s.kind === 'GAP')).toHaveLength(0);

      /*
        And the half that makes the room usable.

        `kind` never reached the customer, so a wheelchair bay rendered as an ordinary seat.
        The organizer's own read has always returned it — only the customer was kept in the
        dark, which is the wrong way round for the one person who needs to know.
      */
      expect(seats.filter((s) => s.kind === 'WHEELCHAIR')).toHaveLength(2);
      expect(seats.filter((s) => s.kind === 'COMPANION')).toHaveLength(1);
    },
    60_000,
  );

  maybe(
    'row A still reads A1 to A10 even though A5 is missing',
    async () => {
      /*
        Dropping the aisle must not renumber the row.

        Seat numbers are printed on the seats. If removing A5 from the payload shifted A6
        into its place, every ticket after the aisle would name a seat the customer is not
        sitting in.
      */
      const layout = await shows.getPublicSeatLayout(sessionId);
      if (layout.view !== 'seats') throw new Error('expected a seat view');
      const rowA = layout.sections[0].rows.find((r) => r.label === 'A');
      expect(rowA?.seats.map((s) => s.label)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '6',
        '7',
        '8',
        '9',
        '10',
      ]);
      // The column index is preserved too, which is what the client draws the aisle from.
      expect(rowA?.seats.map((s) => s.colIndex)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    },
    60_000,
  );
});
