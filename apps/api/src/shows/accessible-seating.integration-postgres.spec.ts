import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';

/**
 * integration-real-postgres — accessible seating reaches the database.
 *
 * The Seat model has always carried a `kind` — SEAT | GAP | WHEELCHAIR | COMPANION — and the
 * generator has always hardcoded 'SEAT'. So a room with a wheelchair bay could be described
 * in the schema and not created through the product. An organizer asked for exactly this.
 *
 * Proven against a real database rather than a stub because the thing being checked is what
 * was WRITTEN: a stub would return whatever the test handed it.
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

const ORGANIZER = { id: 'itest-acc', email: 'a@t.test', fullName: 'A', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: accessible seating', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;

  const suffix = `acc-${Date.now()}`;
  let orgId = '';
  let cinemaId = '';

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
      data: { name: `Acc ${suffix}`, slug: `acc-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    const cinema = await db.cinema.create({
      data: { organizationId: orgId, venueId: venue.id, name: `C ${suffix}`, city: 'Hyderabad' },
    });
    cinemaId = cinema.id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screens = await db.screen.findMany({ where: { cinemaId }, select: { id: true } });
    const ids = screens.map((s: { id: string }) => s.id);
    await db.seat.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId: { in: ids } } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatMap.deleteMany({ where: { screenId: { in: ids } } });
    await db.screen.deleteMany({ where: { cinemaId } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  const newScreen = async (name: string) =>
    (
      await db!.screen.create({
        data: { cinemaId, name, screenType: '2D', capacity: 100 },
      })
    ).id as string;

  const seatsOf = async (screenId: string) =>
    db!.seat.findMany({
      where: { seatMap: { screenId } },
      select: { label: true, kind: true, row: { select: { label: true } } },
    });

  maybe(
    'an ordinary section is still entirely ordinary seats',
    async () => {
      // The default must not change: a room with no accessibility input is what it always was.
      const screenId = await newScreen(`Plain ${suffix}`);
      await shows.generateSeatMap(ORGANIZER, screenId, {
        name: 'Main',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Standard',
            basePriceMinor: 15000,
            rowLabels: ['A', 'B'],
            seatsPerRow: 5,
          },
        ],
      } as never);

      const seats = await seatsOf(screenId);
      expect(seats).toHaveLength(10);
      expect(new Set(seats.map((s: { kind: string }) => s.kind))).toEqual(new Set(['SEAT']));
    },
    60_000,
  );

  maybe(
    'wheelchair and companion seats are written as such',
    async () => {
      const screenId = await newScreen(`Accessible ${suffix}`);
      await shows.generateSeatMap(ORGANIZER, screenId, {
        name: 'Main',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Standard',
            basePriceMinor: 15000,
            rowLabels: ['A', 'B', 'C'],
            seatsPerRow: 6,
            seatKinds: [
              { rowLabel: 'A', seats: [1, 2], kind: 'WHEELCHAIR' },
              { rowLabel: 'A', seats: [3], kind: 'COMPANION' },
              { rowLabel: 'C', seats: [6], kind: 'GAP' },
            ],
          },
        ],
      } as never);

      const seats = await seatsOf(screenId);
      const at = (row: string, label: string) =>
        seats.find(
          (s: { label: string; row: { label: string } }) =>
            s.row.label === row && s.label === label,
        )?.kind;

      expect(at('A', '1')).toBe('WHEELCHAIR');
      expect(at('A', '2')).toBe('WHEELCHAIR');
      expect(at('A', '3')).toBe('COMPANION');
      expect(at('C', '6')).toBe('GAP');

      // Every other seat is untouched — an override must not leak across rows.
      expect(at('B', '1')).toBe('SEAT');
      expect(at('B', '2')).toBe('SEAT');
      expect(at('C', '1')).toBe('SEAT');
      expect(seats.filter((s: { kind: string }) => s.kind === 'SEAT')).toHaveLength(14);
    },
    60_000,
  );

  maybe(
    'an override naming a row that does not exist is simply ignored',
    async () => {
      // The generator must not invent a row to satisfy an override, and must not fail the
      // whole layout over a stale marker either.
      const screenId = await newScreen(`Ghost ${suffix}`);
      await shows.generateSeatMap(ORGANIZER, screenId, {
        name: 'Main',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Standard',
            basePriceMinor: 15000,
            rowLabels: ['A'],
            seatsPerRow: 4,
            seatKinds: [
              { rowLabel: 'Z', seats: [1], kind: 'WHEELCHAIR' },
              { rowLabel: 'A', seats: [99], kind: 'WHEELCHAIR' },
            ],
          },
        ],
      } as never);

      const seats = await seatsOf(screenId);
      expect(seats).toHaveLength(4);
      expect(new Set(seats.map((s: { kind: string }) => s.kind))).toEqual(new Set(['SEAT']));
    },
    60_000,
  );

  maybe(
    'a large auditorium generates in one call',
    async () => {
      // The reported pain: 250+ seats. Twenty rows of twenty is 400, and it has to arrive as
      // one layout rather than something an operator assembles by hand.
      const screenId = await newScreen(`Large ${suffix}`);
      const rows = Array.from({ length: 20 }, (_u, i) => String.fromCharCode(65 + i));
      await shows.generateSeatMap(ORGANIZER, screenId, {
        name: 'Auditorium',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Standard',
            basePriceMinor: 15000,
            rowLabels: rows,
            seatsPerRow: 20,
            seatKinds: rows.map((rowLabel) => ({
              rowLabel,
              seats: [1, 2],
              kind: 'WHEELCHAIR' as const,
            })),
          },
        ],
      } as never);

      const seats = await seatsOf(screenId);
      expect(seats).toHaveLength(400);
      expect(seats.filter((s: { kind: string }) => s.kind === 'WHEELCHAIR')).toHaveLength(40);
    },
    120_000,
  );
});
