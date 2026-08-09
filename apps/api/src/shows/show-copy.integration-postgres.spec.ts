import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService, instantToZonedWallClock, zonedWallClockToInstant } from './shows.service';

/**
 * integration-real-postgres — copying a screen's day to another date or screen.
 *
 * The DST cases are why these need a real database rather than unit tests: the source times
 * have to be recovered from stored instants and re-resolved against the target date. Adding
 * 24 hours to a UTC timestamp — the obvious implementation — shifts every show by an hour
 * across a clock change, and that only shows up end to end.
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

const ORGANIZER = { id: 'itest-copy', email: 'c@t.test', fullName: 'C', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: copy schedule', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let service: ShowsService;

  const suffix = `copy-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';
  let screenA = '';
  let screenB = '';
  let movieId = '';

  const makeScreen = async (name: string) => {
    const client = db as Client;
    const screen = await client.screen.create({
      data: { cinemaId, name, screenType: '2D', capacity: 2 },
    });
    const seatMap = await client.seatMap.create({ data: { screenId: screen.id, name: 'L' } });
    const cat = await client.seatCategory.create({
      data: { seatMapId: seatMap.id, name: 'Normal', basePriceMinor: 20000, sortOrder: 0 },
    });
    const sec = await client.seatSection.create({
      data: { seatMapId: seatMap.id, name: 'M', sortOrder: 0 },
    });
    const row = await client.seatRow.create({
      data: { sectionId: sec.id, label: 'A', sortOrder: 0 },
    });
    await client.seat.createMany({
      data: [1, 2].map((i) => ({
        seatMapId: seatMap.id,
        rowId: row.id,
        seatCategoryId: cat.id,
        label: String(i),
        colIndex: i,
        kind: 'SEAT',
      })),
    });
    return screen.id;
  };

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
    service = new ShowsService(db as never, allowAll, noAudit, cfg);

    const org = await db.organization.create({
      data: { name: `Copy ${suffix}`, slug: `copy-${suffix}` },
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
    screenA = await makeScreen('A');
    screenB = await makeScreen('B');
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Copy Movie ${suffix}`,
        slug: `copy-movie-${suffix}`,
        runtimeMinutes: 100,
        language: 'Telugu',
        status: 'PUBLISHED',
      },
    });
    movieId = movie.id;
  }, 60_000);

  const clear = async () => {
    if (!db) return;
    const ids = (
      await db.eventSession.findMany({ where: { event: { movieId } }, select: { id: true } })
    ).map((s: { id: string }) => s.id);
    if (!ids.length) return;
    await db.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
    await db.ticketInventory.deleteMany({ where: { ticketType: { eventSessionId: { in: ids } } } });
    await db.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
    await db.eventSession.deleteMany({ where: { id: { in: ids } } });
  };

  beforeEach(async () => {
    if (available) await clear();
  });

  afterAll(async () => {
    if (available && db) {
      await clear();
      await db.event.deleteMany({ where: { movieId } });
      await db.movie.deleteMany({ where: { id: movieId } });
      await db.seat.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await db.seatRow.deleteMany({ where: { section: { seatMap: { screen: { cinemaId } } } } });
      await db.seatSection.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await db.seatCategory.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await db.seatMap.deleteMany({ where: { screen: { cinemaId } } });
      await db.screen.deleteMany({ where: { cinemaId } });
      await db.cinema.deleteMany({ where: { id: cinemaId } });
      await db.venue.deleteMany({ where: { id: venueId } });
      await db.organization.deleteMany({ where: { id: orgId } });
    }
    await db?.$disconnect();
  }, 60_000);

  const seedDay = async (screenId: string, date: string, times: string[], tz: string) => {
    const r = await service.bulkScheduleShows(ORGANIZER, movieId, {
      screenId,
      dates: [date],
      times,
      padMinutes: 0,
      timezone: tz,
      dryRun: false,
    } as never);
    expect(r.created).toHaveLength(times.length);
    return r;
  };

  const maybe = (name: string, fn: () => Promise<void>, t = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      t,
    );

  const futureDate = (plusDays: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + plusDays);
    return d.toISOString().slice(0, 10);
  };

  /**
   * Shows on a LOCAL calendar day, as wall-clock times.
   *
   * Selecting on a UTC boundary looks equivalent and is not: a 19:00 EST show on the 13th
   * is 00:00Z on the 14th, so `startsAt >= 2027-03-14T00:00:00Z` sweeps up the source day
   * and the assertion silently tests the wrong rows. The window is resolved through the
   * zone for exactly the reason the feature under test exists.
   */
  const localDay = async (screenId: string, date: string, tz: string) => {
    const start = zonedWallClockToInstant(date, '00:00', tz);
    const next = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const end = zonedWallClockToInstant(next, '00:00', tz);
    const rows = await (db as Client).eventSession.findMany({
      where: { screenId, startsAt: { gte: start, lt: end }, event: { movieId } },
      select: { startsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r: { startsAt: Date }) => instantToZonedWallClock(r.startsAt, tz));
  };

  maybe('dry run reports the plan and creates nothing', async () => {
    const src = futureDate(10);
    const dst = futureDate(11);
    await seedDay(screenA, src, ['09:00', '14:00'], 'Asia/Kolkata');

    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenA,
      sourceDate: src,
      targetDate: dst,
      timezone: 'Asia/Kolkata',
      dryRun: true,
    });

    expect(result.times).toEqual(['09:00', '14:00']);
    expect(result.proposed).toBe(2);
    expect(result.created).toHaveLength(0);
    // Still only the source day.
    expect(await (db as Client).eventSession.count({ where: { event: { movieId } } })).toBe(2);
  });

  maybe('copies an India day to the next date, preserving wall-clock times', async () => {
    const src = futureDate(20);
    const dst = futureDate(21);
    await seedDay(screenA, src, ['09:00', '12:45', '20:15'], 'Asia/Kolkata');

    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenA,
      sourceDate: src,
      targetDate: dst,
      timezone: 'Asia/Kolkata',
      dryRun: false,
    });

    expect(result.created).toHaveLength(3);
    expect(await localDay(screenA, dst, 'Asia/Kolkata')).toEqual(['09:00', '12:45', '20:15']);
  });

  /**
   * The case that catches a 24-hour-arithmetic implementation. New York loses an hour on
   * 2027-03-14, so a show copied from the 13th must still read 10:00 locally even though
   * the two instants are 23 hours apart.
   */
  maybe('survives DST spring-forward: local time preserved, not the UTC offset', async () => {
    const tz = 'America/New_York';
    await seedDay(screenB, '2027-03-13', ['10:00', '19:00'], tz);

    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenB,
      sourceDate: '2027-03-13',
      targetDate: '2027-03-14',
      timezone: tz,
      dryRun: false,
    });
    expect(result.created).toHaveLength(2);
    expect(await localDay(screenB, '2027-03-14', tz)).toEqual(['10:00', '19:00']);

    // Proof the naive version would be wrong: the days really are 23 real hours apart.
    const src10 = zonedWallClockToInstant('2027-03-13', '10:00', tz);
    const dst10 = zonedWallClockToInstant('2027-03-14', '10:00', tz);
    expect((dst10.getTime() - src10.getTime()) / 3_600_000).toBe(23);
  });

  maybe('survives DST fall-back, where the day is 25 hours long', async () => {
    const tz = 'America/New_York';
    await seedDay(screenB, '2027-11-06', ['10:00'], tz);

    await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenB,
      sourceDate: '2027-11-06',
      targetDate: '2027-11-07',
      timezone: tz,
      dryRun: false,
    });

    expect(await localDay(screenB, '2027-11-07', tz)).toEqual(['10:00']);
    const src10 = zonedWallClockToInstant('2027-11-06', '10:00', tz);
    const dst10 = zonedWallClockToInstant('2027-11-07', '10:00', tz);
    expect((dst10.getTime() - src10.getTime()) / 3_600_000).toBe(25);
  });

  maybe('copies to another screen without touching the source', async () => {
    const src = futureDate(30);
    await seedDay(screenA, src, ['08:00', '13:00'], 'Asia/Kolkata');

    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenA,
      sourceDate: src,
      targetScreenId: screenB,
      targetDate: src,
      timezone: 'Asia/Kolkata',
      dryRun: false,
    });

    expect(result.created).toHaveLength(2);
    expect(result.targetScreenId).toBe(screenB);
    // Bookings are never moved: the source day is untouched and these are new sessions.
    expect(await (db as Client).eventSession.count({ where: { screenId: screenA } })).toBe(2);
    expect(await (db as Client).eventSession.count({ where: { screenId: screenB } })).toBe(2);
  });

  maybe('reports a conflict when the target date is already occupied', async () => {
    const src = futureDate(40);
    const dst = futureDate(41);
    await seedDay(screenA, src, ['09:00', '14:00'], 'Asia/Kolkata');
    await seedDay(screenA, dst, ['09:30'], 'Asia/Kolkata');

    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenA,
      sourceDate: src,
      targetDate: dst,
      timezone: 'Asia/Kolkata',
      dryRun: false,
    });

    // 09:00 collides with the existing 09:30; 14:00 is clear.
    expect(result.created).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('OVERLAPS_EXISTING_SHOW');
  });

  maybe('a repeated copy creates nothing the second time', async () => {
    const src = futureDate(50);
    const dst = futureDate(51);
    await seedDay(screenA, src, ['09:00', '14:00'], 'Asia/Kolkata');
    const body = {
      sourceScreenId: screenA,
      sourceDate: src,
      targetDate: dst,
      timezone: 'Asia/Kolkata',
      dryRun: false,
    };

    const first = await service.copySchedule(ORGANIZER, movieId, body);
    const second = await service.copySchedule(ORGANIZER, movieId, body);

    expect(first.created).toHaveLength(2);
    // Not an idempotency key — the overlap rules simply refuse to duplicate a day that is
    // already there, which is what an operator who double-clicks needs.
    expect(second.created).toHaveLength(0);
    expect(second.rejected).toHaveLength(2);
    expect(await (db as Client).eventSession.count({ where: { screenId: screenA } })).toBe(4);
  });

  maybe('copying an empty day is a no-op, not an error', async () => {
    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenA,
      sourceDate: futureDate(60),
      targetDate: futureDate(61),
      timezone: 'Asia/Kolkata',
      dryRun: false,
    });
    expect(result.proposed).toBe(0);
    expect(result.created).toHaveLength(0);
    expect(result.times).toEqual([]);
  });

  maybe('a cancelled source show is not copied forward', async () => {
    const src = futureDate(70);
    const dst = futureDate(71);
    const seeded = await seedDay(screenA, src, ['09:00', '14:00'], 'Asia/Kolkata');
    await service.cancelShow(ORGANIZER, seeded.created[0].sessionId, 'projector fault');

    const result = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenA,
      sourceDate: src,
      targetDate: dst,
      timezone: 'Asia/Kolkata',
      dryRun: false,
    });

    // Copying it forward would resurrect something the operator deliberately stopped.
    expect(result.times).toEqual(['14:00']);
    expect(result.created).toHaveLength(1);
  });
});
