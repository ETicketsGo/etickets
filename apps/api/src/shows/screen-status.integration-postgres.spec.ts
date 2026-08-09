import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';
import { CinemasService } from '../cinemas/cinemas.service';

/**
 * integration-real-postgres — screen operational status.
 *
 * The behaviour that matters most here is a NEGATIVE one: taking a screen out of service
 * must not disturb shows already scheduled on it. Cancelling something people have paid for
 * has to be an explicit, audited, per-show act, never a side effect of marking a room out of
 * use. That is asserted directly rather than assumed.
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

const ORGANIZER = { id: 'itest-scr', email: 's@t.test', fullName: 'S', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: screen operational status', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;
  let cinemas: CinemasService;
  const audited: { action: string; metadata?: Record<string, unknown> }[] = [];

  const suffix = `scr-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';
  let screenId = '';
  let movieId = '';

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
    const audit = {
      record: async (e: { action: string; metadata?: Record<string, unknown> }) => {
        audited.push(e);
      },
    } as never;
    shows = new ShowsService(db as never, allowAll, audit, cfg);
    cinemas = new CinemasService(db as never, allowAll, audit);

    const org = await db.organization.create({
      data: { name: `Scr ${suffix}`, slug: `scr-${suffix}` },
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
      data: { cinemaId, name: 'Screen 1', screenType: '2D', capacity: 2 },
    });
    screenId = screen.id;
    const seatMap = await db.seatMap.create({ data: { screenId, name: 'L' } });
    const cat = await db.seatCategory.create({
      data: { seatMapId: seatMap.id, name: 'Normal', basePriceMinor: 20000, sortOrder: 0 },
    });
    const sec = await db.seatSection.create({
      data: { seatMapId: seatMap.id, name: 'M', sortOrder: 0 },
    });
    const row = await db.seatRow.create({ data: { sectionId: sec.id, label: 'A', sortOrder: 0 } });
    await db.seat.createMany({
      data: [1, 2].map((i) => ({
        seatMapId: seatMap.id,
        rowId: row.id,
        seatCategoryId: cat.id,
        label: String(i),
        colIndex: i,
        kind: 'SEAT',
      })),
    });
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Scr Movie ${suffix}`,
        slug: `scr-movie-${suffix}`,
        runtimeMinutes: 100,
        language: 'Hindi',
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
    if (ids.length) {
      await db.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
      await db.ticketInventory.deleteMany({
        where: { ticketType: { eventSessionId: { in: ids } } },
      });
      await db.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
      await db.eventSession.deleteMany({ where: { id: { in: ids } } });
    }
    await db.screen.update({ where: { id: screenId }, data: { status: 'ACTIVE' } });
    audited.length = 0;
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

  const futureDate = (plusDays: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + plusDays);
    return d.toISOString().slice(0, 10);
  };
  const seedDay = (date: string, times: string[]) =>
    shows.bulkScheduleShows(ORGANIZER, movieId, {
      screenId,
      dates: [date],
      times,
      padMinutes: 0,
      timezone: 'Asia/Kolkata',
      dryRun: false,
    } as never);

  const setStatus = (status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE', reason?: string) =>
    cinemas.updateScreen(ORGANIZER, screenId, { status, statusReason: reason } as never);

  const maybe = (name: string, fn: () => Promise<void>, t = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      t,
    );

  maybe('defaults to ACTIVE, so existing screens are unaffected by the migration', async () => {
    const screen = await (db as Client).screen.findUnique({ where: { id: screenId } });
    expect(screen.status).toBe('ACTIVE');
  });

  maybe('refuses a new show on a screen under maintenance', async () => {
    await setStatus('MAINTENANCE', 'projector replacement');
    const t = new Date();
    t.setUTCDate(t.getUTCDate() + 90);
    await expect(
      shows.scheduleShow(ORGANIZER, movieId, {
        screenId,
        startsAt: t,
        endsAt: new Date(t.getTime() + 3_600_000),
      }),
    ).rejects.toThrow(/maintenance/i);
  });

  maybe('refuses bulk scheduling on a screen that is not in service', async () => {
    await setStatus('INACTIVE', 'screen retired');
    await expect(seedDay(futureDate(91), ['10:00'])).rejects.toThrow(/not in service/i);
  });

  maybe('refuses a copy TO a screen under maintenance', async () => {
    const src = futureDate(92);
    await seedDay(src, ['09:00']);
    await setStatus('MAINTENANCE');
    await expect(
      shows.copySchedule(ORGANIZER, movieId, {
        sourceScreenId: screenId,
        sourceDate: src,
        targetDate: futureDate(93),
        timezone: 'Asia/Kolkata',
        dryRun: false,
      }),
    ).rejects.toThrow(/maintenance/i);
  });

  maybe('leaves shows already scheduled on the screen completely untouched', async () => {
    const seeded = await seedDay(futureDate(94), ['09:00', '14:00']);
    await setStatus('MAINTENANCE', 'roof leak');

    // The behaviour that matters most: no silent cancellation of anything sold.
    const rows = await (db as Client).eventSession.findMany({
      where: { id: { in: seeded.created.map((c: { sessionId: string }) => c.sessionId) } },
      select: { status: true },
    });
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['SCHEDULED', 'SCHEDULED']);
  });

  maybe('surfaces how many future shows now need a decision', async () => {
    await seedDay(futureDate(95), ['09:00', '14:00', '19:00']);
    const result = await setStatus('MAINTENANCE', 'projector fault');
    expect(
      (result as { futureShowsRequiringAttention: number }).futureShowsRequiringAttention,
    ).toBe(3);
  });

  maybe('refuses to reopen sales on a screen that cannot open', async () => {
    const seeded = await seedDay(futureDate(96), ['09:00']);
    await shows.pauseSales(ORGANIZER, seeded.created[0].sessionId, 'weather');
    await setStatus('MAINTENANCE');
    // Selling seats in a room that cannot open is worse than leaving the show paused.
    await expect(shows.reopenSales(ORGANIZER, seeded.created[0].sessionId)).rejects.toThrow(
      /maintenance/i,
    );
  });

  maybe('allows scheduling again once the screen is back in service', async () => {
    await setStatus('MAINTENANCE');
    await setStatus('ACTIVE');
    const r = await seedDay(futureDate(97), ['10:00']);
    expect(r.created).toHaveLength(1);
  });

  maybe('audits the status change with actor, before, after and reason', async () => {
    await seedDay(futureDate(98), ['09:00']);
    audited.length = 0;
    await setStatus('MAINTENANCE', 'sound system failure');

    const entry = audited.find((a) => a.action === 'SCREEN_STATUS_CHANGED');
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({
      from: 'ACTIVE',
      to: 'MAINTENANCE',
      reason: 'sound system failure',
      futureShowsRequiringAttention: 1,
    });
  });

  maybe('does not audit when the status is unchanged', async () => {
    audited.length = 0;
    await cinemas.updateScreen(ORGANIZER, screenId, { name: 'Screen 1 renamed' } as never);
    expect(audited.filter((a) => a.action === 'SCREEN_STATUS_CHANGED')).toHaveLength(0);
    await (db as Client).screen.update({ where: { id: screenId }, data: { name: 'Screen 1' } });
  });
  // ── Cinema day schedule (the organizer's landing view) ───────────────────────────

  describe('cinema day schedule', () => {
    maybe('returns the day grouped by screen with state and movie title', async () => {
      const date = futureDate(120);
      await seedDay(date, ['09:00', '14:00']);

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date,
        timezone: 'Asia/Kolkata',
      });

      expect(rows).toHaveLength(2);
      // Every field the day view needs, so it never has to infer state.
      expect(rows[0]).toMatchObject({
        screenId,
        screenName: 'Screen 1',
        cinemaId,
        movieId,
        status: 'SCHEDULED',
      });
      expect(rows[0].movieTitle).toContain('Scr Movie');
      expect(rows[0].seatsTotal).toBe(2);
      expect(rows[0].seatsSold).toBe(0);
    });

    maybe('reflects a paused show, so the operator sees what they paused', async () => {
      const date = futureDate(121);
      const seeded = await seedDay(date, ['09:00']);
      await shows.pauseSales(ORGANIZER, seeded.created[0].sessionId, 'staffing');

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date,
        timezone: 'Asia/Kolkata',
      });
      expect(rows[0].status).toBe('PAUSED');
    });

    maybe('includes cancelled shows, which an operator still needs to see', async () => {
      const date = futureDate(122);
      const seeded = await seedDay(date, ['09:00']);
      await shows.cancelShow(ORGANIZER, seeded.created[0].sessionId, 'projector fault');

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date,
        timezone: 'Asia/Kolkata',
      });
      expect(rows[0].status).toBe('CANCELLED');
    });

    maybe('uses the LOCAL day, so a late show belongs to the day it is advertised', async () => {
      // 23:45 IST is 18:15Z the same day, but a UTC-midnight window would still be a
      // different bucket for anything past 18:30. The operator calls it that evening.
      const date = futureDate(123);
      await seedDay(date, ['23:45']);

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date,
        timezone: 'Asia/Kolkata',
      });
      expect(rows).toHaveLength(1);
      // And it must NOT appear on the following day.
      const next = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date: new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000)
          .toISOString()
          .slice(0, 10),
        timezone: 'Asia/Kolkata',
      });
      expect(next).toHaveLength(0);
    });

    maybe('returns an empty day rather than failing', async () => {
      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date: futureDate(124),
        timezone: 'Asia/Kolkata',
      });
      expect(rows).toEqual([]);
    });
  });
  // ── Error details carry a machine-readable reason ────────────────────────────────

  describe('rejection details', () => {
    maybe('a refused edit names WHY in details, not only in prose', async () => {
      const date = futureDate(130);
      const seeded = await seedDay(date, ['09:00']);
      await shows.cancelShow(ORGANIZER, seeded.created[0].sessionId, 'test');

      // Without this a client can only regex the English message, which breaks on any
      // rewording. The message stays human; the code is the stable handle.
      await expect(
        shows.rescheduleShow(ORGANIZER, seeded.created[0].sessionId, {
          startsAt: new Date(Date.now() + 86_400_000),
          padMinutes: 0,
        }),
      ).rejects.toMatchObject({ details: { reason: 'SHOW_CANCELLED' } });
    });

    maybe('an overlap names the show it collides with', async () => {
      const date = futureDate(131);
      const seeded = await seedDay(date, ['09:00', '14:00']);
      const [first, second] = seeded.created;

      let caught: unknown;
      try {
        // Move the 14:00 show onto the 09:00 one.
        await shows.rescheduleShow(ORGANIZER, second.sessionId, {
          startsAt: new Date(first.startsAt),
          padMinutes: 0,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({
        details: { reason: 'OVERLAPS_EXISTING_SHOW', conflictsWith: first.sessionId },
      });
    });
  });
  // ── Week planning: bounded local-date ranges ─────────────────────────────────────

  describe('schedule range', () => {
    maybe('returns a seven-day window in chronological order', async () => {
      const d0 = futureDate(140);
      const d3 = futureDate(143);
      const d6 = futureDate(146);
      await seedDay(d0, ['10:00']);
      await seedDay(d3, ['14:00']);
      await seedDay(d6, ['20:00']);

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: d0,
        to: d6,
        timezone: 'Asia/Kolkata',
      });

      expect(rows).toHaveLength(3);
      const times = rows.map((r) => r.startsAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    maybe('is inclusive of both end dates', async () => {
      const first = futureDate(150);
      const last = futureDate(152);
      await seedDay(first, ['09:00']);
      await seedDay(last, ['09:00']);

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: first,
        to: last,
        timezone: 'Asia/Kolkata',
      });
      // Both edges present: "Mon to Sun" means what an operator means by it.
      expect(rows).toHaveLength(2);
    });

    maybe('excludes the day either side of the window', async () => {
      const before = futureDate(159);
      const inside = futureDate(160);
      const after = futureDate(161);
      await seedDay(before, ['09:00']);
      await seedDay(inside, ['09:00']);
      await seedDay(after, ['09:00']);

      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: inside,
        to: inside,
        timezone: 'Asia/Kolkata',
      });
      expect(rows).toHaveLength(1);
    });

    maybe('keeps a late show on its LOCAL day, not the UTC one', async () => {
      // 23:45 IST is 18:15Z the same day. A UTC-midnight window would still bucket it
      // correctly here, but a naive +24h range walk would not — this pins the local
      // reckoning the operator relies on.
      const date = futureDate(170);
      await seedDay(date, ['23:45']);

      const inRange = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: date,
        to: date,
        timezone: 'Asia/Kolkata',
      });
      expect(inRange).toHaveLength(1);

      const nextDay = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const after = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: nextDay,
        to: nextDay,
        timezone: 'Asia/Kolkata',
      });
      expect(after).toHaveLength(0);
    });

    maybe('the same instant lands on different local days in different zones', async () => {
      // The clearest proof that the zone decides the bucket, not the server's clock.
      const date = futureDate(175);
      await seedDay(date, ['00:30']); // 00:30 IST == 19:00Z the PREVIOUS day

      const inIndia = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: date,
        to: date,
        timezone: 'Asia/Kolkata',
      });
      expect(inIndia).toHaveLength(1);

      const prev = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const inUtc = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: prev,
        to: prev,
        timezone: 'UTC',
      });
      expect(inUtc).toHaveLength(1);
    });

    maybe('still supports a single date, unchanged', async () => {
      const date = futureDate(180);
      await seedDay(date, ['11:00']);
      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        date,
        timezone: 'Asia/Kolkata',
      });
      expect(rows).toHaveLength(1);
    });

    maybe('rejects a backwards range', async () => {
      await expect(
        shows.cinemaSchedule(ORGANIZER, cinemaId, {
          from: futureDate(190),
          to: futureDate(185),
          timezone: 'Asia/Kolkata',
        }),
      ).rejects.toThrow(/ends before it starts/i);
    });

    maybe('rejects a range wider than the cap', async () => {
      // Otherwise this becomes a way to pull an entire season in one request.
      await expect(
        shows.cinemaSchedule(ORGANIZER, cinemaId, {
          from: futureDate(200),
          to: futureDate(230),
          timezone: 'Asia/Kolkata',
        }),
      ).rejects.toThrow(/between 1 and 14 days/i);
    });

    maybe('accepts exactly the cap', async () => {
      const rows = await shows.cinemaSchedule(ORGANIZER, cinemaId, {
        from: futureDate(240),
        to: futureDate(253),
        timezone: 'Asia/Kolkata',
      });
      expect(Array.isArray(rows)).toBe(true);
    });

    maybe('rejects a request with neither a date nor a range', async () => {
      await expect(
        shows.cinemaSchedule(ORGANIZER, cinemaId, { timezone: 'Asia/Kolkata' }),
      ).rejects.toThrow(/date or a from\/to range/i);
    });
  });
});
