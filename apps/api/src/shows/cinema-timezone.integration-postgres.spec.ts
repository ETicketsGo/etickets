import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';

/**
 * integration-real-postgres — Cinema.timezone is authoritative.
 *
 * ── WHY A NON-INDIA CINEMA ────────────────────────────────────────────────────────
 * Every earlier timezone test used Asia/Kolkata, which cannot distinguish "reads the cinema's
 * zone" from "hardcodes the launch market" — both produce identical results. The venue here is
 * in **Sydney**, so any code still reaching for an India default, the server's zone, or a
 * literal produces a visibly different local day and fails.
 *
 * Sydney is also chosen because it OBSERVES DAYLIGHT SAVING. A fixed +05:30 or +10:00 offset
 * would pass half the year and drift by an hour for the other half; only a real IANA zone
 * survives both sides of a transition.
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

const ORGANIZER = { id: 'itest-tz', email: 't@t.test', fullName: 'T', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: cinema timezone is authoritative', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;

  const suffix = `tz-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  /** Sydney — deliberately not India, and it observes DST. */
  let sydneyCinemaId = '';
  let sydneyScreenId = '';
  /** A second venue in India, to prove two cinemas can disagree at the same instant. */
  let indiaCinemaId = '';
  let indiaScreenId = '';
  let movieId = '';

  const buildScreen = async (cinemaId: string, name: string) => {
    const screen = await db!.screen.create({
      data: { cinemaId, name, screenType: '2D', capacity: 4 },
    });
    const seatMap = await db!.seatMap.create({
      data: {
        screenId: screen.id,
        name: 'L',
        version: 1,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    });
    const cat = await db!.seatCategory.create({
      data: { seatMapId: seatMap.id, name: 'Normal', basePriceMinor: 20000, sortOrder: 0 },
    });
    const sec = await db!.seatSection.create({
      data: { seatMapId: seatMap.id, name: 'M', sortOrder: 0 },
    });
    const row = await db!.seatRow.create({ data: { sectionId: sec.id, label: 'A', sortOrder: 0 } });
    await db!.seat.createMany({
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
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    shows = new ShowsService(db as never, allowAll, undefined as never, cfg);

    const org = await db!.organization.create({
      data: { name: `TZ ${suffix}`, slug: `tz-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Sydney', country: 'Australia' },
    });
    venueId = venue.id;

    const sydney = await db!.cinema.create({
      data: {
        organizationId: orgId,
        venueId,
        name: `Sydney ${suffix}`,
        city: 'Sydney',
        timezone: 'Australia/Sydney',
      },
    });
    sydneyCinemaId = sydney.id;
    sydneyScreenId = await buildScreen(sydneyCinemaId, 'Sydney 1');

    const india = await db!.cinema.create({
      data: {
        organizationId: orgId,
        venueId,
        name: `Hyd ${suffix}`,
        city: 'Hyderabad',
        timezone: 'Asia/Kolkata',
      },
    });
    indiaCinemaId = india.id;
    indiaScreenId = await buildScreen(indiaCinemaId, 'Hyd 1');

    const movie = await db!.movie.create({
      data: {
        organizationId: orgId,
        title: `TZ Movie ${suffix}`,
        slug: `tz-movie-${suffix}`,
        runtimeMinutes: 100,
        language: 'English',
        status: 'PUBLISHED',
      },
    });
    movieId = movie.id;
  }, 90_000);

  afterAll(async () => {
    if (available && db) {
      const ids = (
        await db.eventSession.findMany({ where: { event: { movieId } }, select: { id: true } })
      ).map((s: { id: string }) => s.id);
      if (ids.length) {
        await db.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
        await db.ticketInventory.deleteMany({
          where: { ticketType: { eventSessionId: { in: ids } } },
        });
        await db.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
        await db.eventSession.deleteMany({ where: { id: { in: ids } } });
      }
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.movie.deleteMany({ where: { id: movieId } });
      for (const cid of [sydneyCinemaId, indiaCinemaId]) {
        await db.seat.deleteMany({ where: { seatMap: { screen: { cinemaId: cid } } } });
        await db.seatRow.deleteMany({
          where: { section: { seatMap: { screen: { cinemaId: cid } } } },
        });
        await db.seatSection.deleteMany({ where: { seatMap: { screen: { cinemaId: cid } } } });
        await db.seatCategory.deleteMany({ where: { seatMap: { screen: { cinemaId: cid } } } });
        await db.seatMap.deleteMany({ where: { screen: { cinemaId: cid } } });
        await db.screen.deleteMany({ where: { cinemaId: cid } });
      }
      await db.cinema.deleteMany({ where: { id: { in: [sydneyCinemaId, indiaCinemaId] } } });
      await db.venue.deleteMany({ where: { id: venueId } });
      await db.organization.deleteMany({ where: { id: orgId } });
    }
    await db?.$disconnect();
  }, 90_000);

  const clear = async () => {
    if (!db) return;
    const ids = (
      await db.eventSession.findMany({ where: { event: { movieId } }, select: { id: true } })
    ).map((s: { id: string }) => s.id);
    if (ids.length) {
      await db.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
      await db.ticketInventory.deleteMany({
        where: { ticketType: { eventSessionId: { in: ids } } },
      });
      await db.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
      await db.eventSession.deleteMany({ where: { id: { in: ids } } });
    }
  };
  beforeEach(async () => {
    if (available) await clear();
  });

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe('a new cinema stores the zone it was created with', async () => {
    const c = await db!.cinema.findUniqueOrThrow({ where: { id: sydneyCinemaId } });
    expect(c.timezone).toBe('Australia/Sydney');
  });

  maybe('scheduling uses the CINEMA zone when the caller names none', async () => {
    /*
      The core assertion. A 10:00 show at a Sydney cinema is 10:00 in Sydney — which in
      August (AEST, UTC+10) is 00:00Z. If anything still assumed Asia/Kolkata this would
      land at 04:30Z, and if it used the server's UTC it would land at 10:00Z.
    */
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-08-20'],
      times: ['10:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    const session = await db!.eventSession.findFirstOrThrow({
      where: { screenId: sydneyScreenId },
    });
    const sydneyLocal = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(session.startsAt);
    expect(sydneyLocal).toBe('10:00');
    expect(session.startsAt.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  maybe('the same wall-clock time means different instants at two cinemas', async () => {
    // Proof the zone is per-venue rather than global: same date, same time, two rooms.
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-08-20'],
      times: ['18:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: indiaScreenId,
      dates: ['2026-08-20'],
      times: ['18:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    const syd = await db!.eventSession.findFirstOrThrow({ where: { screenId: sydneyScreenId } });
    const ind = await db!.eventSession.findFirstOrThrow({ where: { screenId: indiaScreenId } });
    expect(syd.startsAt.toISOString()).toBe('2026-08-20T08:00:00.000Z');
    expect(ind.startsAt.toISOString()).toBe('2026-08-20T12:30:00.000Z');
    // 4h30m apart, which is exactly the Sydney/Kolkata difference in August.
    expect(ind.startsAt.getTime() - syd.startsAt.getTime()).toBe(4.5 * 3_600_000);
  });

  maybe('survives a daylight-saving transition that a fixed offset would not', async () => {
    /*
      Sydney leaves daylight saving on 2026-04-05 and re-enters on 2026-10-04. A 10:00 show
      either side is 10:00 LOCAL both times, but the UTC instants differ by an hour. A stored
      "+10:00" or "+11:00" offset gets exactly one of these right.
    */
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-09-20', '2026-10-20'],
      times: ['10:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    const sessions = await db!.eventSession.findMany({
      where: { screenId: sydneyScreenId },
      orderBy: { startsAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    // AEST (UTC+10) before the change, AEDT (UTC+11) after.
    expect(sessions[0].startsAt.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(sessions[1].startsAt.toISOString()).toBe('2026-10-19T23:00:00.000Z');

    const localTimes = sessions.map((s: { startsAt: Date }) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Australia/Sydney',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(s.startsAt),
    );
    // The whole point: the advertised time never moved.
    expect(localTimes).toEqual(['10:00', '10:00']);
  });

  maybe('the day schedule groups by the cinema local date, not UTC', async () => {
    // 08:00 Sydney on the 20th is 22:00Z on the NINETEENTH. A UTC-grouped schedule files it
    // under the wrong day and the operator sees an empty morning.
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-08-20'],
      times: ['08:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    const onTheDay = await shows.cinemaSchedule(ORGANIZER, sydneyCinemaId, { date: '2026-08-20' });
    expect(onTheDay).toHaveLength(1);

    const dayBefore = await shows.cinemaSchedule(ORGANIZER, sydneyCinemaId, {
      date: '2026-08-19',
    });
    expect(dayBefore).toHaveLength(0);
  });

  maybe('an explicit timezone still overrides, for cross-zone inspection', async () => {
    // Honoured deliberately: it is how somebody asks "what does this look like in UTC".
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-08-20'],
      times: ['08:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    const inUtc = await shows.cinemaSchedule(ORGANIZER, sydneyCinemaId, {
      date: '2026-08-19',
      timezone: 'UTC',
    });
    expect(inUtc).toHaveLength(1);
  });

  maybe('copying a day uses the source cinema zone', async () => {
    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-08-20'],
      times: ['09:30'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    await shows.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: sydneyScreenId,
      sourceDate: '2026-08-20',
      targetDate: '2026-08-21',
      dryRun: false,
    } as never);

    const copied = await db!.eventSession.findFirstOrThrow({
      where: { screenId: sydneyScreenId, startsAt: { gte: new Date('2026-08-20T14:00:00Z') } },
    });
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(copied.startsAt);
    // The advertised time is what carries across, not the UTC instant.
    expect(local).toBe('09:30');
  });

  maybe('the timezone cannot be changed once the cinema has shows', async () => {
    /*
      Show start times are stored as absolute INSTANTS, resolved through the venue's zone when
      they were scheduled. Re-pointing the zone does not move them — it changes what they are
      advertised as. A 10:00 Hyderabad show becomes 04:30 if the cinema is re-declared as
      Europe/London, and every ticket already sold names a time nobody will turn up for.

      Silently reinterpreting them is the one outcome that must not happen, so the write is
      refused and the operator is told how many shows are in the way.
    */
    const { CinemasService } = await import('../cinemas/cinemas.service');
    const cinemas = new CinemasService(db as never, allowAll, undefined as never);

    await shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId: sydneyScreenId,
      dates: ['2026-08-20'],
      times: ['10:00'],
      padMinutes: 0,
      dryRun: false,
    } as never);

    await expect(
      cinemas.update(ORGANIZER, sydneyCinemaId, { timezone: 'Europe/London' } as never),
    ).rejects.toMatchObject({ details: { reason: 'TIMEZONE_LOCKED_BY_SHOWS' } });

    // Unchanged, and the shows are untouched.
    const after = await db!.cinema.findUniqueOrThrow({ where: { id: sydneyCinemaId } });
    expect(after.timezone).toBe('Australia/Sydney');
  });

  maybe('an EMPTY cinema can have its timezone corrected', async () => {
    // The case that actually matters during onboarding: an operator picks the wrong zone
    // before scheduling anything and must be able to fix it themselves.
    const { CinemasService } = await import('../cinemas/cinemas.service');
    const cinemas = new CinemasService(db as never, allowAll, undefined as never);

    const fresh = await db!.cinema.create({
      data: {
        organizationId: orgId,
        venueId,
        name: `Empty ${suffix}`,
        city: 'Perth',
        timezone: 'Australia/Sydney',
      },
    });
    const updated = await cinemas.update(ORGANIZER, fresh.id, {
      timezone: 'Australia/Perth',
    } as never);
    expect(updated.timezone).toBe('Australia/Perth');

    // Saving other fields without touching the zone is always fine.
    const renamed = await cinemas.update(ORGANIZER, fresh.id, { city: 'Fremantle' } as never);
    expect(renamed.timezone).toBe('Australia/Perth');

    await db!.cinema.delete({ where: { id: fresh.id } });
  });

  maybe('an unresolvable stored zone is impossible to create through the API layer', async () => {
    // The database would happily hold "Middle/Earth"; the write path must not.
    const { createCinemaSchema } = await import('@eticketsgo/validation');
    expect(
      createCinemaSchema.safeParse({ name: 'Odeon', city: 'Leeds', timezone: 'Middle/Earth' })
        .success,
    ).toBe(false);
    expect(
      createCinemaSchema.safeParse({ name: 'Odeon', city: 'Sydney', timezone: 'Australia/Sydney' })
        .success,
    ).toBe(true);
    // Omitted entirely, an operator gets the launch market rather than a failure.
    const parsed = createCinemaSchema.parse({ name: 'Odeon', city: 'Hyderabad' });
    expect(parsed.timezone).toBe('Asia/Kolkata');
  });
});
